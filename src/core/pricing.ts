import type { Database } from 'bun:sqlite';
import { defaultExec, isProfileArn, resolveArn, type ExecFn } from './arn';
import { buildModelIndex, fallbackCanonical, isFreeModel, tierOf, type ModelIndex } from './models';
import { parseBedrockOffer, parsePriceList, type ParsedPriceList, type PriceKind, type PriceRow } from './pricing-parse';
import { DEFAULT_REGION } from './rates';
import type { PriceInput, PriceTier, PricingService, ResolvedModel } from './types';

const OFFERS = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/';

export interface PriceSource {
  id: string;
  url: string;
  parse(json: unknown): ParsedPriceList;
}

/** Highest priority first: when two sources price the same key, the earlier one wins. */
export const PRICE_SOURCES: readonly PriceSource[] = [
  { id: 'foundation-models', url: `${OFFERS}AmazonBedrockFoundationModels/current/index.json`, parse: parsePriceList },
  { id: 'bedrock', url: `${OFFERS}AmazonBedrock/current/index.json`, parse: parseBedrockOffer },
];
export const PRICE_LIST_URL = (PRICE_SOURCES[0] as PriceSource).url;

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FETCH_TIMEOUT_MS = 120_000;
const FALLBACK_REGIONS = ['us-east-1', 'us-west-2', 'us-east-2'];
const LAST_ERROR_KEY = 'pricing.lastError';

export interface PricingOptions {
  fetch?: typeof fetch;
  exec?: ExecFn;
  now?: () => number;
  defaultRegion?: string;
  /** Where to look for ~/.aws (tests). Default: the real home directory. */
  home?: string;
  env?: Record<string, string | undefined>;
}

type RateMap = Partial<Record<PriceKind, number>>;

interface Snapshot {
  id: number;
  fetchedAt: number;
}

export function pricingLastError(db: Database): string | undefined {
  const row = db.query('SELECT value FROM kv WHERE key = ?').get(LAST_ERROR_KEY) as { value: string } | null;
  return row?.value || undefined;
}

function setLastError(db: Database, error: string | null): void {
  if (error === null) db.query('DELETE FROM kv WHERE key = ?').run(LAST_ERROR_KEY);
  else
    db.query(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(LAST_ERROR_KEY, error);
}

type SourcedRow = PriceRow & { source: string };

const rowKey = (r: PriceRow): string => `${r.model}|${r.region}|${r.tier}|${r.kind}|${r.longCtx ? 1 : 0}`;

function hashRows(rows: readonly SourcedRow[]): string {
  const h = new Bun.CryptoHasher('sha256');
  for (const r of rows) h.update(`${rowKey(r)}|${r.usdPerMtok}|${r.source}\n`);
  return h.digest('hex');
}

/** Merges rows by key; earlier entries win, so list higher-priority sources first. */
function mergeRows(groups: ReadonlyArray<readonly SourcedRow[]>): SourcedRow[] {
  const seen = new Map<string, SourcedRow>();
  for (const group of groups) for (const r of group) if (!seen.has(rowKey(r))) seen.set(rowKey(r), r);
  return [...seen.values()].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createPricingService(db: Database, opts: PricingOptions = {}): PricingService {
  const doFetch = opts.fetch ?? fetch;
  const exec = opts.exec ?? defaultExec;
  const now = opts.now ?? Date.now;
  const defaultRegion = opts.defaultRegion ?? DEFAULT_REGION;

  let snapshots: Snapshot[] | null = null;
  let modelIndex: ModelIndex | null = null;
  const rateCache = new Map<string, RateMap | null>();
  const resolveMemo = new Map<string, ResolvedModel>();
  /** Resolved objects that cost nothing (free ids, local runtimes); priceEvent recognises them by identity. */
  const freeMemo = new Map<string, ResolvedModel>();
  const freeModels = new WeakSet<ResolvedModel>();
  let inflight: Promise<{ refreshed: boolean; snapshotId?: number; error?: string }> | null = null;

  const loadSnapshots = (): Snapshot[] => {
    snapshots ??= (db.query('SELECT id, fetched_at AS fetchedAt FROM price_snapshots ORDER BY fetched_at, id').all() as Snapshot[]);
    return snapshots;
  };
  const invalidate = (): void => {
    snapshots = null;
    modelIndex = null;
    resolveMemo.clear();
  };
  const getIndex = (): ModelIndex => {
    modelIndex ??= buildModelIndex(
      (db.query('SELECT DISTINCT model FROM prices').all() as Array<{ model: string }>).map((r) => r.model),
    );
    return modelIndex;
  };

  const ratesIn = (snapshotId: number, model: string, region: string, tier: PriceTier): RateMap | null => {
    const key = `${snapshotId}|${model}|${region}|${tier}`;
    const hit = rateCache.get(key);
    if (hit !== undefined) return hit;
    const rows = db
      .query(
        `SELECT kind, usd_per_mtok AS usd FROM prices
         WHERE snapshot_id = ? AND model = ? AND region = ? AND tier = ? AND long_ctx = 0`,
      )
      .all(snapshotId, model, region, tier) as Array<{ kind: PriceKind; usd: number }>;
    const out: RateMap | null = rows.length === 0 ? null : Object.fromEntries(rows.map((r) => [r.kind, r.usd]));
    rateCache.set(key, out);
    return out;
  };

  /** Rates for a model in one snapshot: requested tier/region first, then the other tier, then other regions. */
  const lookupRates = (
    snapshotId: number,
    model: string,
    tier: PriceTier,
  ): { rates: RateMap; exact: boolean } | null => {
    const regions = [defaultRegion, ...FALLBACK_REGIONS.filter((r) => r !== defaultRegion)];
    const tiers: PriceTier[] = tier === 'global' ? ['global', 'regional'] : ['regional', 'global'];
    for (const t of tiers) {
      for (const region of regions) {
        const rates = ratesIn(snapshotId, model, region, t);
        if (rates?.input !== undefined && rates.output !== undefined) {
          return { rates, exact: t === tier && region === defaultRegion };
        }
      }
    }
    return null;
  };

  const fetchSource = async (src: PriceSource): Promise<ParsedPriceList> => {
    const res = await doFetch(src.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`price list fetch failed: HTTP ${res.status}`);
    const parsed = src.parse(JSON.parse(await res.text()));
    if (parsed.rows.length === 0) throw new Error('price list contained no token prices');
    return parsed;
  };

  const refresh = async (
    maxAgeMs: number,
    force: boolean,
  ): Promise<{ refreshed: boolean; snapshotId?: number; error?: string }> => {
    const t = now();
    const latest = db
      .query('SELECT id, last_checked_at AS checked, content_hash AS hash FROM price_snapshots ORDER BY fetched_at DESC, id DESC LIMIT 1')
      .get() as { id: number; checked: number; hash: string } | null;
    // A previous problem shortens the wait, so a failed source is retried within the hour.
    const wait = pricingLastError(db) ? Math.min(maxAgeMs, HOUR_MS) : maxAgeMs;
    if (!force && latest && t - latest.checked < wait) return { refreshed: false, snapshotId: latest.id };

    const settled = await Promise.allSettled(PRICE_SOURCES.map(fetchSource));
    const errors: string[] = [];
    const groups: SourcedRow[][] = [];
    let publicationDate: string | undefined;
    settled.forEach((result, i) => {
      const src = PRICE_SOURCES[i] as PriceSource;
      if (result.status === 'fulfilled') {
        publicationDate ??= result.value.publicationDate;
        groups.push(result.value.rows.map((r) => ({ ...r, source: src.id })));
        return;
      }
      errors.push(`${src.id}: ${errorMessage(result.reason)}`);
      // Keep what we already know from a source that failed this time.
      const carried = latest
        ? (db
            .query(
              `SELECT model, region, tier, kind, long_ctx AS longCtx, usd_per_mtok AS usdPerMtok
               FROM prices WHERE snapshot_id = ? AND source = ?`,
            )
            .all(latest.id, src.id) as Array<Omit<SourcedRow, 'source' | 'longCtx'> & { longCtx: number }>)
        : [];
      groups.push(carried.map((r) => ({ ...r, longCtx: r.longCtx === 1, source: src.id })));
    });

    const error = errors.length > 0 ? errors.join('; ') : undefined;
    if (errors.length === PRICE_SOURCES.length) {
      setLastError(db, error ?? null);
      return { refreshed: false, error };
    }

    try {
      const rows = mergeRows(groups);
      const hash = hashRows(rows);
      setLastError(db, error ?? null);

      if (latest && latest.hash === hash) {
        db.query('UPDATE price_snapshots SET last_checked_at = ? WHERE id = ?').run(t, latest.id);
        return { refreshed: false, snapshotId: latest.id, ...(error ? { error } : {}) };
      }

      const insertSnap = db.query(
        `INSERT INTO price_snapshots (fetched_at, last_checked_at, content_hash, source_url, publication_date, row_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const insertPrice = db.prepare(
        `INSERT INTO prices (snapshot_id, model, region, tier, kind, long_ctx, usd_per_mtok, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const snapshotId = db.transaction(() => {
        const info = insertSnap.run(t, t, hash, PRICE_SOURCES.map((s) => s.url).join(','), publicationDate ?? null, rows.length);
        const id = Number(info.lastInsertRowid);
        for (const r of rows) insertPrice.run(id, r.model, r.region, r.tier, r.kind, r.longCtx ? 1 : 0, r.usdPerMtok, r.source);
        return id;
      })();
      invalidate();
      return { refreshed: true, snapshotId, ...(error ? { error } : {}) };
    } catch (e: unknown) {
      const message = errorMessage(e);
      setLastError(db, message);
      return { refreshed: false, error: message };
    }
  };

  const resolveUncached = async (raw: string, awsProfile: string | undefined): Promise<ResolvedModel | null> => {
    const tier = tierOf(raw);
    let target = raw;
    if (isProfileArn(raw)) {
      const modelId = await resolveArn(db, raw, { exec, now: now(), awsProfile, home: opts.home, env: opts.env });
      if (!modelId) return null;
      target = modelId;
    }
    const hit = getIndex().match(target);
    return hit
      ? { canonical: hit, priced: true, tier: isProfileArn(raw) ? 'regional' : tier }
      : { canonical: fallbackCanonical(target), priced: false, tier: isProfileArn(raw) ? 'regional' : tier };
  };

  return {
    async refreshIfStale(o = {}) {
      inflight ??= refresh(o.maxAgeMs ?? DAY_MS, o.force ?? false).finally(() => {
        inflight = null;
      });
      return inflight;
    },

    async resolveModel(raw, hint) {
      if (isFreeModel(raw, hint?.provider)) {
        const key = `${raw}\u0000${tierOf(raw)}`;
        let free = freeMemo.get(key);
        if (!free) {
          free = { canonical: fallbackCanonical(raw), priced: true, tier: tierOf(raw) };
          freeMemo.set(key, free);
          freeModels.add(free);
        }
        return free;
      }
      const memoKey = `${raw}\u0000${hint?.awsProfile ?? ''}`;
      const memo = resolveMemo.get(memoKey);
      if (memo) return memo;

      const tier = tierOf(raw);
      const newest = loadSnapshots().at(-1)?.fetchedAt ?? 0;
      if (!isProfileArn(raw)) {
        const row = db
          .query('SELECT canonical, priced, resolved_at AS at FROM model_cache WHERE raw = ? AND tier = ?')
          .get(raw, tier) as { canonical: string; priced: number; at: number } | null;
        if (row && (row.priced === 1 || row.at >= newest)) {
          const cached: ResolvedModel = { canonical: row.canonical, priced: row.priced === 1, tier };
          resolveMemo.set(memoKey, cached);
          return cached;
        }
      }

      const resolved = await resolveUncached(raw, hint?.awsProfile);
      if (!resolved) {
        // Unresolvable ARN: report it as an unpriced, clearly-labelled profile; retried via arn_cache after 1h.
        const id = raw.split('/').at(-1) ?? raw;
        return { canonical: `bedrock-profile/${id}`, priced: false, tier: 'regional' };
      }
      if (!isProfileArn(raw)) {
        db.query(
          `INSERT INTO model_cache (raw, tier, canonical, priced, resolved_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(raw, tier) DO UPDATE SET canonical = excluded.canonical, priced = excluded.priced, resolved_at = excluded.resolved_at`,
        ).run(raw, tier, resolved.canonical, resolved.priced ? 1 : 0, now());
      }
      resolveMemo.set(memoKey, resolved);
      return resolved;
    },

    priceEvent(model: ResolvedModel, input: PriceInput) {
      if (freeModels.has(model)) return { costUsd: 0, approx: false };
      const snaps = loadSnapshots();
      if (!model.priced || snaps.length === 0) return { costUsd: null, approx: false };

      let idx = -1;
      for (let i = 0; i < snaps.length; i++) if ((snaps[i] as Snapshot).fetchedAt <= input.ts) idx = i;
      let approx = idx === -1;
      if (idx === -1) idx = 0;

      // Preferred snapshot first, then the others by distance in time.
      const order = snaps
        .map((_, i) => i)
        .sort((a, b) => Math.abs(a - idx) - Math.abs(b - idx) || a - b);
      let found: { rates: RateMap; exact: boolean } | null = null;
      for (const i of order) {
        found = lookupRates(
          (snaps[i] as Snapshot).id,
          model.canonical,
          model.tier,
        );
        if (found) {
          if (i !== idx) approx = true;
          break;
        }
      }
      if (!found) return { costUsd: null, approx: false };
      if (!found.exact) approx = true;

      const r = found.rates;
      const inputRate = r.input as number;
      const readRate = r.cache_read ?? inputRate;
      const w5 = r.cache_write_5m ?? inputRate;
      const w1h = r.cache_write_1h ?? w5;
      if (
        (r.cache_read === undefined && input.cacheReadTokens > 0) ||
        (r.cache_write_5m === undefined && input.cacheWrite5mTokens > 0) ||
        (r.cache_write_1h === undefined && r.cache_write_5m === undefined && input.cacheWrite1hTokens > 0)
      ) {
        approx = true;
      }
      const usd =
        (input.inputTokens * inputRate +
          (input.outputTokens + input.reasoningTokens) * (r.output as number) +
          input.cacheReadTokens * readRate +
          input.cacheWrite5mTokens * w5 +
          input.cacheWrite1hTokens * w1h) /
        1e6;
      return { costUsd: usd, approx };
    },
  };
}
