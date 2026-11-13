import type { Database } from 'bun:sqlite';
import { defaultExec, isProfileArn, resolveArn, type ExecFn } from './arn';
import { buildModelIndex, fallbackCanonical, isFreeModel, tierOf, type ModelIndex } from './models';
import {
  buildExternalIndex, loadExternalPrices, modelsDevFetchedAt, MODELS_DEV_URL, parseModelsDev, storeExternalPrices,
  type ExternalIndex, type ExternalPrice,
} from './pricing-modelsdev';
import { OFFICIAL_FEEDS, parseOfficial } from './pricing-official';
import type { ParsedPriceList, PriceKind, PriceRow } from './pricing-parse';
import { PRICE_SOURCES, type PriceFeed } from './pricing-sources';
import { DEFAULT_REGION } from './rates';
import type { PriceInput, PriceSource, PriceTier, PricingService, ResolvedModel } from './types';

export { PRICE_SOURCES, type PriceFeed } from './pricing-sources';
export { MODELS_DEV_URL, modelsDevStatus } from './pricing-modelsdev';
export const PRICE_LIST_URL = (PRICE_SOURCES[0] as PriceFeed).url;

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const FETCH_TIMEOUT_MS = 120_000;
const FALLBACK_REGIONS = ['us-east-1', 'us-west-2', 'us-east-2'];
const LAST_ERROR_KEY = 'pricing.lastError';
const FAILED_SOURCES_KEY = 'pricing.failedSources';
const LAST_ATTEMPT_KEY = 'pricing.lastAttemptAt';
/** Per-feed marker of the last successful fetch; a feed without one (e.g. just added) is fetched at once. */
const feedFetchedKey = (feed: PriceFeed): string => `pricing.fetchedAt.${feed.id}`;
const officialFetchedKey = (id: string): string => `pricing.fetchedAt.official.${id}`;
/** Id used in the failed-source list and in error strings for the models.dev layer. */
const MODELS_DEV_ID = 'models.dev';

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

interface RateSet {
  rates: RateMap;
  /** `prices.source` of the rows these rates came from. */
  feed: string;
}

type SourcedRow = PriceRow & { source: string };

const rowKey = (r: PriceRow): string => `${r.model}|${r.region}|${r.tier}|${r.kind}|${r.longCtx ? 1 : 0}`;

function kvGet(db: Database, key: string): string | undefined {
  return (db.query('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | null)?.value;
}

function kvSet(db: Database, key: string, value: string): void {
  db.query('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export function pricingLastError(db: Database): string | undefined {
  return kvGet(db, LAST_ERROR_KEY) || undefined;
}

function setLastError(db: Database, error: string | undefined): void {
  if (error === undefined) db.query('DELETE FROM kv WHERE key = ?').run(LAST_ERROR_KEY);
  else kvSet(db, LAST_ERROR_KEY, error);
}

function failedSources(db: Database): string[] {
  try {
    const parsed: unknown = JSON.parse(kvGet(db, FAILED_SOURCES_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function hashRows(rows: readonly SourcedRow[]): string {
  const h = new Bun.CryptoHasher('sha256');
  for (const r of rows) h.update(`${rowKey(r)}|${r.usdPerMtok}|${r.source}\n`);
  return h.digest('hex');
}

interface FeedRows {
  fillOnly: boolean;
  rows: readonly SourcedRow[];
}

/**
 * Merges rows by key; earlier groups win, so list higher-priority feeds first. A fill-only group
 * contributes just the models that no earlier group prices at all (matched by normalised name).
 */
function mergeRows(groups: readonly FeedRows[]): SourcedRow[] {
  const seen = new Map<string, SourcedRow>();
  for (const g of groups) {
    const known = g.fillOnly ? buildModelIndex([...new Set([...seen.values()].map((r) => r.model))]) : null;
    for (const r of g.rows) {
      if (known?.match(r.model)) continue;
      if (!seen.has(rowKey(r))) seen.set(rowKey(r), r);
    }
  }
  return [...seen.values()].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const awsSource = (feed: string): PriceSource => (feed === 'pricing-page' ? 'aws-pricing-page' : 'aws-price-list');

/**
 * Antigravity records internal ids. The generation blob also names the public model
 * ("Orchestrator (Argon)", "Gemini Flash", "Gemini 3.8 Flash"), which is what the list prices.
 * Anything not in this table stays unpriced.
 */
const BILLED_MODEL: Readonly<Record<string, string>> = {
  'gemini-pro-orchestrator-g1-pro': 'gemini-4-argon',
  'gemini-flash-worker-agy': 'gemini-flash-latest',
  'gemini-3.8-flash-low': 'gemini-3.8-flash',
  'gemini-3.8-flash-n': 'gemini-3.8-flash',
  'gemini-3.8-flash-medium': 'gemini-3.8-flash',
  'gemini-3.8-flash-high': 'gemini-3.8-flash',
  'gemini-3.8-flash-tiered': 'gemini-3.8-flash',
  'gemini-3.7-flash-tiered': 'gemini-3.7-flash',
  'gemini-3.6-flash-tiered': 'gemini-3.6-flash',
  'gemini-3.6-flash-high': 'gemini-3.6-flash',
};

function billedModel(raw: string): string | undefined {
  return BILLED_MODEL[raw.trim().toLowerCase()];
}

interface AwsOutcome {
  refreshed: boolean;
  snapshotId?: number;
  errors: string[];
  failed: string[];
}

export function createPricingService(db: Database, opts: PricingOptions = {}): PricingService {
  const doFetch = opts.fetch ?? fetch;
  const exec = opts.exec ?? defaultExec;
  const now = opts.now ?? Date.now;
  const defaultRegion = opts.defaultRegion ?? DEFAULT_REGION;

  let snapshots: Snapshot[] | null = null;
  let modelIndex: ModelIndex | null = null;
  let externalIndex: ExternalIndex | null = null;
  const rateCache = new Map<string, RateSet | null>();
  const sourceMemo = new Map<string, PriceSource>();
  const resolveMemo = new Map<string, ResolvedModel>();
  /** Resolved objects that cost nothing (free ids, local runtimes); priceEvent recognises them by identity. */
  const freeMemo = new Map<string, ResolvedModel>();
  const freeModels = new WeakSet<ResolvedModel>();
  /** Resolved objects priced from models.dev, with the entry they were matched to. */
  const externalOf = new WeakMap<ResolvedModel, ExternalPrice>();
  let inflight: Promise<{ refreshed: boolean; snapshotId?: number; error?: string }> | null = null;

  const loadSnapshots = (): Snapshot[] => {
    snapshots ??= (db.query('SELECT id, fetched_at AS fetchedAt FROM price_snapshots ORDER BY fetched_at, id').all() as Snapshot[]);
    return snapshots;
  };
  const invalidate = (): void => {
    snapshots = null;
    modelIndex = null;
    externalIndex = null;
    sourceMemo.clear();
    resolveMemo.clear();
  };
  const getIndex = (): ModelIndex => {
    modelIndex ??= buildModelIndex(
      (db.query('SELECT DISTINCT model FROM prices').all() as Array<{ model: string }>).map((r) => r.model),
    );
    return modelIndex;
  };
  const getExternal = (): ExternalIndex => {
    externalIndex ??= buildExternalIndex(loadExternalPrices(db));
    return externalIndex;
  };

  /** 'aws-price-list' unless every row we have for the model comes from the pricing page. */
  const sourceOfModel = (canonical: string): PriceSource => {
    let source = sourceMemo.get(canonical);
    if (!source) {
      const bulk = db.query("SELECT 1 FROM prices WHERE model = ? AND source <> 'pricing-page' LIMIT 1").get(canonical);
      source = bulk ? 'aws-price-list' : 'aws-pricing-page';
      sourceMemo.set(canonical, source);
    }
    return source;
  };

  // ---- AWS rates -------------------------------------------------------------------------------

  const ratesIn = (snapshotId: number, model: string, region: string, tier: PriceTier): RateSet | null => {
    const key = `${snapshotId}|${model}|${region}|${tier}`;
    const hit = rateCache.get(key);
    if (hit !== undefined) return hit;
    const rows = db
      .query(
        `SELECT kind, usd_per_mtok AS usd, source FROM prices
         WHERE snapshot_id = ? AND model = ? AND region = ? AND tier = ? AND long_ctx = 0`,
      )
      .all(snapshotId, model, region, tier) as Array<{ kind: PriceKind; usd: number; source: string }>;
    const out: RateSet | null =
      rows.length === 0 ? null : { rates: Object.fromEntries(rows.map((r) => [r.kind, r.usd])), feed: rows[0]?.source ?? '' };
    rateCache.set(key, out);
    return out;
  };

  /** Rates for a model in one snapshot: requested tier/region first, then the other tier, then other regions. */
  const lookupRates = (snapshotId: number, model: string, tier: PriceTier): (RateSet & { exact: boolean }) | null => {
    const regions = [defaultRegion, ...FALLBACK_REGIONS.filter((r) => r !== defaultRegion)];
    const tiers: PriceTier[] = tier === 'global' ? ['global', 'regional'] : ['regional', 'global'];
    for (const t of tiers) {
      for (const region of regions) {
        const set = ratesIn(snapshotId, model, region, t);
        if (set?.rates.input !== undefined && set.rates.output !== undefined) {
          return { ...set, exact: t === tier && region === defaultRegion };
        }
      }
    }
    return null;
  };

  // ---- refresh -----------------------------------------------------------------------------------

  const loadFeed = async (feed: PriceFeed): Promise<ParsedPriceList> => {
    const parsed = await feed.load(doFetch);
    if (parsed.rows.length === 0) throw new Error('price list contained no token prices');
    return parsed;
  };

  const loadModelsDev = async (): Promise<ExternalPrice[]> => {
    const res = await doFetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`price list fetch failed: HTTP ${res.status}`);
    const entries = parseModelsDev(JSON.parse(await res.text()));
    if (entries.length === 0) throw new Error('price list contained no token prices');
    return entries;
  };

  const refreshAws = async (
    latest: { id: number; checked: number; hash: string } | null,
    fullyDue: boolean,
    failedBefore: readonly string[],
    t: number,
  ): Promise<AwsOutcome> => {
    const due = (feed: PriceFeed): boolean => fullyDue || failedBefore.includes(feed.id) || kvGet(db, feedFetchedKey(feed)) === undefined;
    const settled = await Promise.allSettled(PRICE_SOURCES.map((feed) => (due(feed) ? loadFeed(feed) : Promise.resolve(null))));
    const errors: string[] = [];
    const failed: string[] = [];
    const groups: FeedRows[] = [];
    let publicationDate: string | undefined;
    const carry = (feed: PriceFeed): void => {
      const carried = latest
        ? (db
            .query(
              `SELECT model, region, tier, kind, long_ctx AS longCtx, usd_per_mtok AS usdPerMtok
               FROM prices WHERE snapshot_id = ? AND source = ?`,
            )
            .all(latest.id, feed.id) as Array<Omit<SourcedRow, 'source' | 'longCtx'> & { longCtx: number }>)
        : [];
      groups.push({ fillOnly: feed.fillOnly ?? false, rows: carried.map((r) => ({ ...r, longCtx: r.longCtx === 1, source: feed.id })) });
    };
    settled.forEach((result, i) => {
      const feed = PRICE_SOURCES[i] as PriceFeed;
      if (result.status === 'fulfilled' && result.value) {
        kvSet(db, feedFetchedKey(feed), String(t));
        publicationDate ??= result.value.publicationDate;
        groups.push({ fillOnly: feed.fillOnly ?? false, rows: result.value.rows.map((r) => ({ ...r, source: feed.id })) });
        return;
      }
      if (result.status === 'rejected') {
        errors.push(`${feed.id}: ${errorMessage(result.reason)}`);
        failed.push(feed.id);
      }
      carry(feed); // failed this time, or not due yet: keep what we already know
    });
    if (errors.length === PRICE_SOURCES.length) return { refreshed: false, snapshotId: latest?.id, errors, failed };

    try {
      const rows = mergeRows(groups);
      const hash = hashRows(rows);
      if (latest && latest.hash === hash) {
        if (fullyDue) db.query('UPDATE price_snapshots SET last_checked_at = ? WHERE id = ?').run(t, latest.id);
        return { refreshed: false, snapshotId: latest.id, errors, failed };
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
        const info = insertSnap.run(t, t, hash, PRICE_SOURCES.map((f) => f.url).join(','), publicationDate ?? null, rows.length);
        const id = Number(info.lastInsertRowid);
        for (const r of rows) insertPrice.run(id, r.model, r.region, r.tier, r.kind, r.longCtx ? 1 : 0, r.usdPerMtok, r.source);
        return id;
      })();
      invalidate();
      return { refreshed: true, snapshotId, errors, failed };
    } catch (e: unknown) {
      return { refreshed: false, errors: [...errors, errorMessage(e)], failed };
    }
  };

  const refresh = async (
    maxAgeMs: number,
    force: boolean,
  ): Promise<{ refreshed: boolean; snapshotId?: number; error?: string }> => {
    const t = now();
    const latest = db
      .query('SELECT id, last_checked_at AS checked, content_hash AS hash FROM price_snapshots ORDER BY fetched_at DESC, id DESC LIMIT 1')
      .get() as { id: number; checked: number; hash: string } | null;
    const failedBefore = failedSources(db);
    const lastAttempt = Number(kvGet(db, LAST_ATTEMPT_KEY) ?? 0);
    // After a failure nothing is retried for an hour, whatever else is due.
    if (!force && failedBefore.length > 0 && t - lastAttempt < HOUR_MS) return { refreshed: false, snapshotId: latest?.id };
    const modelsDevAt = modelsDevFetchedAt(db);
    const awsDue = force || !latest || t - latest.checked >= maxAgeMs;
    const feedMissing = PRICE_SOURCES.some((f) => kvGet(db, feedFetchedKey(f)) === undefined);
    const modelsDevDue = force || modelsDevAt === null || t - modelsDevAt >= maxAgeMs || failedBefore.includes(MODELS_DEV_ID);
    const officialDue = (id: string): boolean => {
      const at = Number(kvGet(db, officialFetchedKey(id)) ?? '');
      return force || !Number.isFinite(at) || at === 0 || t - at >= maxAgeMs || failedBefore.includes(id);
    };
    const anyOfficialDue = OFFICIAL_FEEDS.some((f) => officialDue(f.id));
    if (!awsDue && !feedMissing && !modelsDevDue && !anyOfficialDue && failedBefore.length === 0) return { refreshed: false, snapshotId: latest?.id };
    kvSet(db, LAST_ATTEMPT_KEY, String(t));

    const fetchModelsDev = modelsDevDue;
    const loadOfficial = async (feed: (typeof OFFICIAL_FEEDS)[number]): Promise<ExternalPrice[]> => {
      const res = await doFetch(feed.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`price list fetch failed: HTTP ${res.status}`);
      return parseOfficial(feed.provider, await res.text(), t);
    };
    const [aws, external, officialSettled] = await Promise.all([
      refreshAws(latest, awsDue, failedBefore, t),
      fetchModelsDev ? loadModelsDev().then((entries) => ({ entries }), (reason: unknown) => ({ reason })) : Promise.resolve(null),
      Promise.all(OFFICIAL_FEEDS.map((feed) => (
        officialDue(feed.id) ? loadOfficial(feed).then((entries) => ({ feed, entries }), (reason: unknown) => ({ feed, reason })) : Promise.resolve(null)
      ))),
    ]);

    const errors = [...aws.errors];
    const failed = [...aws.failed];
    let externalChanged = 0;
    if (external && 'entries' in external) {
      try {
        externalChanged = storeExternalPrices(db, external.entries, t);
        externalIndex = null;
        resolveMemo.clear();
      } catch (e: unknown) {
        errors.push(`${MODELS_DEV_ID}: ${errorMessage(e)}`);
        failed.push(MODELS_DEV_ID);
      }
    } else if (external) {
      errors.push(`${MODELS_DEV_ID}: ${errorMessage(external.reason)}`);
      failed.push(MODELS_DEV_ID);
    }

    const officialRows: ExternalPrice[] = [];
    for (const result of officialSettled) {
      if (!result) continue;
      if ('entries' in result) {
        kvSet(db, officialFetchedKey(result.feed.id), String(t));
        officialRows.push(...result.entries);
        continue;
      }
      errors.push(`${result.feed.id}: ${errorMessage(result.reason)}`);
      failed.push(result.feed.id);
    }
    if (officialRows.length > 0) {
      try {
        externalChanged += storeExternalPrices(db, officialRows, t);
        externalIndex = null;
        resolveMemo.clear();
      } catch (e: unknown) {
        errors.push(`official: ${errorMessage(e)}`);
      }
    }

    const error = errors.length > 0 ? errors.join('; ') : undefined;
    setLastError(db, error);
    kvSet(db, FAILED_SOURCES_KEY, JSON.stringify(failed));
    return {
      refreshed: aws.refreshed || externalChanged > 0,
      ...(aws.snapshotId !== undefined ? { snapshotId: aws.snapshotId } : {}),
      ...(error ? { error } : {}),
    };
  };

  // ---- resolution ----------------------------------------------------------------------------------

  const resolveAws = async (raw: string, awsProfile: string | undefined): Promise<{ target: string; hit: string | null } | null> => {
    let target = raw;
    if (isProfileArn(raw)) {
      const modelId = await resolveArn(db, raw, { exec, now: now(), awsProfile, home: opts.home, env: opts.env });
      if (!modelId) return null;
      target = modelId;
    }
    return { target, hit: getIndex().match(target) };
  };

  const freeModel = (raw: string): ResolvedModel => {
    const key = `${raw}\u0000${tierOf(raw)}`;
    let free = freeMemo.get(key);
    if (!free) {
      free = { canonical: fallbackCanonical(raw), priced: true, tier: tierOf(raw), source: 'free-model' };
      freeMemo.set(key, free);
      freeModels.add(free);
    }
    return free;
  };

  const priceExternal = (
    e: ExternalPrice,
    input: PriceInput,
  ): { costUsd: number; approx: boolean; source: PriceSource } => {
    const readRate = e.cacheRead ?? e.input;
    const writeRate = e.cacheWrite ?? e.input;
    const write1h = e.cacheWrite1h ?? writeRate;
    const fetchedAt = e.origin === 'official'
      ? Number(kvGet(db, officialFetchedKey(e.provider)) ?? '') || null
      : modelsDevFetchedAt(db);
    // Latest-only prices: events older than the fetch (minus a day) are priced with less certainty.
    const approx =
      fetchedAt === null ||
      input.ts < fetchedAt - DAY_MS ||
      (e.cacheRead === null && input.cacheReadTokens > 0) ||
      (e.cacheWrite === null && input.cacheWrite5mTokens + input.cacheWrite1hTokens > 0);
    const usd =
      (input.inputTokens * e.input +
        (input.outputTokens + input.reasoningTokens) * e.output +
        input.cacheReadTokens * readRate +
        input.cacheWrite5mTokens * writeRate +
        input.cacheWrite1hTokens * write1h) /
      1e6;
    return { costUsd: usd, approx, source: e.origin === 'official' ? 'official' : 'models.dev' };
  };

  return {
    async refreshIfStale(o = {}) {
      inflight ??= refresh(o.maxAgeMs ?? DAY_MS, o.force ?? false).finally(() => {
        inflight = null;
      });
      return inflight;
    },

    async resolveModel(raw, hint) {
      const billed = billedModel(raw);
      if (billed) return this.resolveModel(billed, hint);
      if (isFreeModel(raw, hint?.provider)) return freeModel(raw);
      const memoKey = `${raw}\u0000${hint?.awsProfile ?? ''}\u0000${hint?.provider ?? ''}`;
      const memo = resolveMemo.get(memoKey);
      if (memo) return memo;

      const tier = tierOf(raw);
      const arn = isProfileArn(raw);
      const remember = (r: ResolvedModel): ResolvedModel => {
        resolveMemo.set(memoKey, r);
        return r;
      };

      // 1. AWS price list, then the AWS pricing page (both live in the snapshots).
      if (!arn) {
        const row = db
          .query('SELECT canonical FROM model_cache WHERE raw = ? AND tier = ? AND priced = 1')
          .get(raw, tier) as { canonical: string } | null;
        if (row) return remember({ canonical: row.canonical, priced: true, tier, source: sourceOfModel(row.canonical) });
      }
      const aws = await resolveAws(raw, hint?.awsProfile);
      if (!aws) {
        // Unresolvable ARN: report it as an unpriced, clearly-labelled profile; retried via arn_cache after 1h.
        const id = raw.split('/').at(-1) ?? raw;
        return { canonical: `bedrock-profile/${id}`, priced: false, tier: 'regional' };
      }
      const awsTier: PriceTier = arn ? 'regional' : tier;
      if (aws.hit) {
        if (!arn) {
          db.query(
            `INSERT INTO model_cache (raw, tier, canonical, priced, resolved_at) VALUES (?, ?, ?, 1, ?)
             ON CONFLICT(raw, tier) DO UPDATE SET canonical = excluded.canonical, priced = 1, resolved_at = excluded.resolved_at`,
          ).run(raw, tier, aws.hit, now());
        }
        return remember({ canonical: aws.hit, priced: true, tier: awsTier, source: sourceOfModel(aws.hit) });
      }

      // 2. Official provider pages, then models.dev for anything those pages do not list.
      const ext = getExternal().lookup(aws.target, hint?.provider);
      if (ext) {
        const resolved: ResolvedModel = {
          canonical: fallbackCanonical(aws.target), priced: true, tier: awsTier,
          source: ext.origin === 'official' ? 'official' : 'models.dev',
        };
        externalOf.set(resolved, ext);
        return remember(resolved);
      }
      return remember({ canonical: fallbackCanonical(aws.target), priced: false, tier: awsTier });
    },

    priceEvent(model: ResolvedModel, input: PriceInput) {
      if (freeModels.has(model)) return { costUsd: 0, approx: false, source: 'free-model' };
      const ext = externalOf.get(model);
      if (ext) return priceExternal(ext, input);

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
      let found: (RateSet & { exact: boolean }) | null = null;
      for (const i of order) {
        found = lookupRates((snaps[i] as Snapshot).id, model.canonical, model.tier);
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
      return { costUsd: usd, approx, source: awsSource(found.feed) };
    },
  };
}
