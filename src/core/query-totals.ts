import type { Database } from 'bun:sqlite';
import type { Filters, SeriesPoint, SummaryResult, Totals } from './api-types';
import { all, buildWhere, one } from './query-filters';
import { BUCKET_MS, bucketLabel, localDate, resolveTz, type Granularity } from './query-time';

/** Aggregates every Totals field over the events alias `e`. */
export const TOTALS_COLS = `
  COUNT(*) AS events,
  COUNT(DISTINCT e.agent || char(31) || e.session_id) AS sessions,
  COALESCE(SUM(e.input_tokens), 0) AS input_tokens,
  COALESCE(SUM(e.output_tokens), 0) AS output_tokens,
  COALESCE(SUM(e.reasoning_tokens), 0) AS reasoning_tokens,
  COALESCE(SUM(e.cache_read_tokens), 0) AS cache_read_tokens,
  COALESCE(SUM(e.cache_write_5m_tokens + e.cache_write_1h_tokens), 0) AS cache_write_tokens,
  COALESCE(SUM(e.cost_usd), 0) AS cost_usd,
  COALESCE(SUM(CASE WHEN e.cost_usd IS NULL THEN 1 ELSE 0 END), 0) AS unpriced_events,
  COALESCE(SUM(CASE WHEN e.cost_usd IS NULL THEN
    e.input_tokens + e.output_tokens + e.reasoning_tokens + e.cache_read_tokens
    + e.cache_write_5m_tokens + e.cache_write_1h_tokens ELSE 0 END), 0) AS unpriced_tokens
`;

export interface TotalsRow {
  events: number;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  unpriced_events: number;
  unpriced_tokens: number;
}

export function cacheHitRatio(input: number, cacheRead: number, cacheWrite: number): number | null {
  const denom = input + cacheRead + cacheWrite;
  return denom > 0 ? cacheRead / denom : null;
}

export function rowToTotals(r: TotalsRow): Totals {
  return {
    events: r.events,
    sessions: r.sessions,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    reasoningTokens: r.reasoning_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWriteTokens: r.cache_write_tokens,
    costUsd: r.cost_usd,
    unpricedEvents: r.unpriced_events,
    unpricedTokens: r.unpriced_tokens,
    cacheHitRatio: cacheHitRatio(r.input_tokens, r.cache_read_tokens, r.cache_write_tokens),
  };
}

export function summary(db: Database, f: Filters): SummaryResult {
  const w = buildWhere(f);
  const total = one<TotalsRow>(db, `SELECT ${TOTALS_COLS} FROM events e WHERE ${w.sql}`, w.params);
  const byAgent = all<TotalsRow & { agent: string }>(
    db,
    `SELECT e.agent AS agent, ${TOTALS_COLS} FROM events e WHERE ${w.sql}
     GROUP BY e.agent ORDER BY cost_usd DESC, input_tokens DESC, e.agent`,
    w.params,
  );
  const byModel = all<TotalsRow & { model: string; priced: number }>(
    db,
    `SELECT e.model AS model, MAX(e.priced) AS priced, ${TOTALS_COLS} FROM events e WHERE ${w.sql}
     GROUP BY e.model ORDER BY cost_usd DESC, input_tokens DESC, e.model`,
    w.params,
  );
  return {
    totals: rowToTotals(total as TotalsRow),
    byAgent: byAgent.map((r) => ({ agent: r.agent, ...rowToTotals(r) })),
    byModel: byModel.map((r) => ({ model: r.model, priced: r.priced === 1, ...rowToTotals(r) })),
  };
}

interface SeriesRow {
  b: number;
  k: string;
  cost: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

/**
 * Time series of cost and tokens split by model or agent. Events are aggregated into 15 minute
 * UTC buckets in SQL and folded into local-timezone day/week/month buckets here, so DST and
 * half-hour offsets are exact. Weeks start on Monday and are labelled by that Monday; months by YYYY-MM.
 */
export function series(
  db: Database,
  f: Filters,
  bucket: Granularity,
  split: 'model' | 'agent',
): SeriesPoint[] {
  const tz = resolveTz(f.tz);
  const w = buildWhere(f);
  const keyCol = split === 'agent' ? 'e.agent' : 'e.model';
  const rows = all<SeriesRow>(
    db,
    `SELECT (e.ts / ${BUCKET_MS}) AS b, ${keyCol} AS k,
            COALESCE(SUM(e.cost_usd), 0) AS cost,
            COALESCE(SUM(e.input_tokens), 0) AS input,
            COALESCE(SUM(e.output_tokens + e.reasoning_tokens), 0) AS output,
            COALESCE(SUM(e.cache_read_tokens), 0) AS cache_read,
            COALESCE(SUM(e.cache_write_5m_tokens + e.cache_write_1h_tokens), 0) AS cache_write
     FROM events e WHERE ${w.sql} GROUP BY b, k`,
    w.params,
  );

  const folded = new Map<string, SeriesPoint>();
  for (const r of rows) {
    const label = bucketLabel(localDate(r.b * BUCKET_MS, tz), bucket);
    const id = `${label}\u0000${r.k}`;
    const prev = folded.get(id);
    folded.set(id, {
      bucket: label,
      key: r.k,
      costUsd: (prev?.costUsd ?? 0) + r.cost,
      inputTokens: (prev?.inputTokens ?? 0) + r.input,
      outputTokens: (prev?.outputTokens ?? 0) + r.output,
      cacheReadTokens: (prev?.cacheReadTokens ?? 0) + r.cache_read,
      cacheWriteTokens: (prev?.cacheWriteTokens ?? 0) + r.cache_write,
    });
  }
  return [...folded.values()].sort((a, b) => (a.bucket === b.bucket ? a.key.localeCompare(b.key) : a.bucket.localeCompare(b.bucket)));
}
