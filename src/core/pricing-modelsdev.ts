import type { Database } from 'bun:sqlite';
import { slugify } from './models';

// Fourth pricing layer: https://models.dev/api.json, a community catalogue of per-provider list prices
// (USD per 1M tokens). It prices everything AWS does not: Google, OpenAI, Mistral, OpenRouter, opencode...
// Only the latest price is kept (no history); rows are upserted and never deleted.

export const MODELS_DEV_URL = 'https://models.dev/api.json';

export interface ExternalPrice {
  provider: string;
  modelId: string;
  name: string | null;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** 1-hour cache writes, when the publisher lists them separately from the short write. */
  cacheWrite1h?: number | null;
  /** official = the provider's own page; models.dev = the community catalogue. */
  origin?: 'official' | 'models.dev';
}

const asPrice = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * Extracts `cost.input/output/cache_read/cache_write` for every model of every provider.
 * Tiered, audio, reasoning and over-200k fields are ignored. Throws if the document is not an object.
 */
export function parseModelsDev(json: unknown): ExternalPrice[] {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw new Error('not a models.dev document');
  const out: ExternalPrice[] = [];
  for (const [provider, entry] of Object.entries(json)) {
    const models = (entry as { models?: unknown } | null)?.models;
    if (typeof models !== 'object' || models === null) continue;
    for (const [modelId, model] of Object.entries(models)) {
      const m = model as { name?: unknown; cost?: Record<string, unknown> } | null;
      const input = asPrice(m?.cost?.input);
      const output = asPrice(m?.cost?.output);
      if (input === null || output === null) continue;
      out.push({
        provider,
        modelId,
        name: typeof m?.name === 'string' ? m.name : null,
        input,
        output,
        cacheRead: asPrice(m?.cost?.cache_read),
        cacheWrite: asPrice(m?.cost?.cache_write),
      });
    }
  }
  return out;
}

const KV_FETCHED_AT = 'modelsdev.fetchedAt';

export function modelsDevFetchedAt(db: Database): number | null {
  const row = db.query('SELECT value FROM kv WHERE key = ?').get(KV_FETCHED_AT) as { value: string } | null;
  const n = Number(row?.value);
  return row && Number.isFinite(n) ? n : null;
}

export function modelsDevStatus(db: Database): { entries: number; fetchedAt: number | null } {
  const row = db.query('SELECT COUNT(*) AS n FROM external_prices').get() as { n: number };
  return { entries: row.n, fetchedAt: modelsDevFetchedAt(db) };
}

export function loadExternalPrices(db: Database): ExternalPrice[] {
  return db
    .query(
      `SELECT provider, model_id AS modelId, name, input, output, cache_read AS cacheRead,
              cache_write AS cacheWrite, cache_write_1h AS cacheWrite1h, origin
       FROM external_prices`,
    )
    .all() as ExternalPrice[];
}

/** Upserts the latest prices; nothing is ever deleted. Returns how many rows are new or changed. */
export function storeExternalPrices(db: Database, entries: readonly ExternalPrice[], now: number): number {
  const existing = new Map(loadExternalPrices(db).map((e) => [`${e.provider}\u0000${e.modelId}`, e]));
  const upsert = db.prepare(
    `INSERT INTO external_prices (provider, model_id, name, input, output, cache_read, cache_write, cache_write_1h, origin, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, model_id) DO UPDATE SET
       name = excluded.name, input = excluded.input, output = excluded.output,
       cache_read = excluded.cache_read, cache_write = excluded.cache_write,
       cache_write_1h = excluded.cache_write_1h, origin = excluded.origin, last_seen_at = excluded.last_seen_at`,
  );
  let changed = 0;
  let sawModelsDev = false;
  db.transaction(() => {
    for (const e of entries) {
      const origin = e.origin ?? 'models.dev';
      const key = `${e.provider}\u0000${e.modelId}`;
      const prev = existing.get(key);
      // A community row must not replace a price taken from the provider's own page.
      if (origin !== 'official' && prev?.origin === 'official') continue;
      const write1h = e.cacheWrite1h ?? null;
      if (!prev || prev.input !== e.input || prev.output !== e.output || prev.cacheRead !== e.cacheRead || prev.cacheWrite !== e.cacheWrite || (prev.cacheWrite1h ?? null) !== write1h || prev.origin !== origin) changed++;
      upsert.run(e.provider, e.modelId, e.name, e.input, e.output, e.cacheRead, e.cacheWrite, write1h, origin, now);
      existing.set(key, { ...e, cacheWrite1h: write1h, origin });
      if (origin === 'models.dev') sawModelsDev = true;
    }
    if (sawModelsDev) {
      db.query('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(KV_FETCHED_AT, String(now));
    }
  })();
  return changed;
}

// ---- resolution ----------------------------------------------------------------------------------

/**
 * Providers that publish their own models, tried (in this order) before looking across every provider.
 * Gateways and aggregators (openrouter, nvidia, opencode...) are deliberately absent: they are only
 * ever matched through their own (provider, id) entry.
 */
const MAKER_PROVIDERS: readonly string[] = [
  'anthropic', 'openai', 'google', 'mistral', 'deepseek', 'zai', 'zhipuai', 'moonshotai', 'minimax',
  'xai', 'meta', 'llama', 'alibaba', 'cohere', 'xiaomi', 'stepfun', 'ai21', 'inception', 'perplexity',
];
const MAKER_RANK = new Map(MAKER_PROVIDERS.map((p, i) => [p, i]));

/** Normalised model name: path prefix (vendor/aggregator/gateway) and date stamp dropped, punctuation unified. */
export function externalNameKey(id: string): string {
  let s = id.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  s = s.slice(s.lastIndexOf('/') + 1);
  s = s.replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-\d{8}$/, '');
  return slugify(s);
}

export interface ExternalIndex {
  readonly size: number;
  lookup(raw: string, provider?: string): ExternalPrice | null;
}

const same = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const rank = (e: ExternalPrice): number => MAKER_RANK.get(e.provider) ?? MAKER_PROVIDERS.length;

/** The single price all candidates agree on (input and output), or null when there is none or they conflict. */
function agreed(candidates: readonly ExternalPrice[]): ExternalPrice | null {
  const first = candidates[0];
  if (!first) return null;
  if (!candidates.every((c) => same(c.input, first.input) && same(c.output, first.output))) return null;
  return [...candidates].sort((a, b) => rank(a) - rank(b) || a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId))[0] ?? null;
}

/**
 * Lookup order (first hit wins, a conflict is "no answer", never a guess):
 *  1. the provider's own entry for the exact id;
 *  2. the same entry with the vendor/gateway path prefix stripped ("z-ai/glm-5" -> "glm-5");
 *  3. the provider's entries whose normalised name matches, when they agree;
 *  4. the maker-native providers' entries with that normalised name, when they agree;
 *  5. every provider's entries with that normalised name, only if all of them agree.
 */
export function buildExternalIndex(entries: readonly ExternalPrice[]): ExternalIndex {
  const exact = new Map<string, ExternalPrice>();
  const byProvider = new Map<string, Map<string, ExternalPrice[]>>();
  const byName = new Map<string, ExternalPrice[]>();
  const byLastId = new Map<string, ExternalPrice[]>();
  const push = (map: Map<string, ExternalPrice[]>, key: string, e: ExternalPrice): void => {
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  };
  const lastSegment = (id: string): string => id.slice(id.lastIndexOf('/') + 1);

  for (const e of entries) {
    const p = e.provider.toLowerCase();
    exact.set(`${p}\u0000${e.modelId.toLowerCase()}`, e);
    push(byLastId, lastSegment(e.modelId.toLowerCase()), e);
    const key = externalNameKey(e.modelId);
    if (!key) continue;
    let perProvider = byProvider.get(p);
    if (!perProvider) byProvider.set(p, (perProvider = new Map()));
    push(perProvider, key, e);
    push(byName, key, e);
  }

  const isMaker = (e: ExternalPrice): boolean => MAKER_RANK.has(e.provider);

  return {
    size: entries.length,
    lookup(raw, provider) {
      const id = raw.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
      const key = externalNameKey(raw);
      if (!id || !key) return null;
      const p = provider?.trim().toLowerCase();
      if (p && byProvider.has(p)) {
        const direct = exact.get(`${p}\u0000${id}`);
        if (direct) return direct;
        if (id.includes('/')) {
          const stripped = exact.get(`${p}\u0000${lastSegment(id)}`);
          if (stripped) return stripped;
        }
        const own = agreed(byProvider.get(p)?.get(key) ?? []);
        if (own) return own;
      }
      // Exact ids beat normalised names ("gpt-4o" must not be confused with the dated "gpt-4o-2024-05-13"),
      // and the first non-empty group decides: agreement answers, disagreement means "unknown".
      const sameId = byLastId.get(lastSegment(id)) ?? [];
      const sameName = byName.get(key) ?? [];
      for (const group of [sameId.filter(isMaker), sameName.filter(isMaker), sameId, sameName]) {
        if (group.length > 0) return agreed(group);
      }
      return null;
    },
  };
}
