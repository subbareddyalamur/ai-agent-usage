import type { Database } from 'bun:sqlite';
import type { CostSourceShare, Filters } from './api-types';
import { all, buildWhere } from './query-filters';
import type { PriceSource } from './types';

/**
 * Where an event's cost came from. NULL cost = unpriced (source null). A priced event without a recorded
 * source predates cost_source and could only have come from the AWS price list.
 */
export const COST_SOURCE_EXPR = `CASE WHEN e.cost_usd IS NULL THEN NULL ELSE COALESCE(e.cost_source, 'aws-price-list') END`;

interface SourceRow {
  model: string;
  src: PriceSource | null;
  events: number;
  cost: number;
}

function bySize(a: CostSourceShare, b: CostSourceShare): number {
  if (b.events !== a.events) return b.events - a.events;
  if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
  // Stable tie-break by name (code point order), unpriced last.
  const ka = a.source ?? '\uffff';
  const kb = b.source ?? '\uffff';
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Per canonical model, in the filtered range. */
export function costSourcesByModel(db: Database, f: Filters): Map<string, CostSourceShare[]> {
  const w = buildWhere(f);
  const rows = all<SourceRow>(
    db,
    `SELECT e.model AS model, ${COST_SOURCE_EXPR} AS src, COUNT(*) AS events, COALESCE(SUM(e.cost_usd), 0) AS cost
     FROM events e WHERE ${w.sql} GROUP BY e.model, src`,
    w.params,
  );
  const out = new Map<string, CostSourceShare[]>();
  for (const r of rows) {
    const list = out.get(r.model) ?? [];
    list.push({ source: r.src, events: r.events, costUsd: r.cost });
    out.set(r.model, list);
  }
  for (const list of out.values()) list.sort(bySize);
  return out;
}

/** Over all events, regardless of any filter. */
export function costSourcesOverall(db: Database): CostSourceShare[] {
  const rows = all<Omit<SourceRow, 'model'>>(
    db,
    `SELECT ${COST_SOURCE_EXPR} AS src, COUNT(*) AS events, COALESCE(SUM(e.cost_usd), 0) AS cost FROM events e GROUP BY src`,
  );
  return rows.map((r) => ({ source: r.src, events: r.events, costUsd: r.cost })).sort(bySize);
}
