import type { Database } from 'bun:sqlite';
import type { PriceTier } from './types';
import type { StatusInfo } from './api-types';

export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export const DEFAULT_REGION = 'us-east-1';
const STALE_AFTER_MS = 48 * 3600 * 1000;

const KIND_TO_FIELD: Record<string, keyof Rates> = {
  input: 'input',
  output: 'output',
  cache_read: 'cacheRead',
  cache_write_5m: 'cacheWrite5m',
  cache_write_1h: 'cacheWrite1h',
};

/** USD per 1M tokens from the newest snapshot that prices `model`. Base (non long-context) rates. */
export function latestRates(
  db: Database,
  model: string,
  tier: PriceTier,
  region: string = DEFAULT_REGION,
): Rates | null {
  const rows = db
    .query(
      `SELECT p.kind AS kind, p.usd_per_mtok AS usd
       FROM prices p
       WHERE p.snapshot_id = (
         SELECT MAX(p2.snapshot_id) FROM prices p2
         WHERE p2.model = ?1 AND p2.region = ?2 AND p2.tier = ?3 AND p2.long_ctx = 0)
       AND p.model = ?1 AND p.region = ?2 AND p.tier = ?3 AND p.long_ctx = 0`,
    )
    .all(model, region, tier) as Array<{ kind: string; usd: number }>;
  if (rows.length === 0) return null;
  const out: Rates = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  for (const r of rows) {
    const field = KIND_TO_FIELD[r.kind];
    if (field) out[field] = r.usd;
  }
  return out;
}

export function pricingStatus(db: Database, now: number = Date.now()): StatusInfo['pricing'] {
  const snap = db
    .query('SELECT MAX(last_checked_at) AS checked, MAX(fetched_at) AS at, COUNT(*) AS n FROM price_snapshots')
    .get() as { checked: number | null; at: number | null; n: number };
  const priced = db
    .query(
      `SELECT COUNT(DISTINCT model) AS n FROM prices
       WHERE snapshot_id = (SELECT MAX(id) FROM price_snapshots)`,
    )
    .get() as { n: number };
  return {
    latestSnapshotAt: snap.at,
    snapshots: snap.n,
    modelsPriced: priced.n,
    stale: snap.checked === null || now - snap.checked > STALE_AFTER_MS,
  };
}
