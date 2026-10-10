import type { Database } from 'bun:sqlite';
import type { Filters, ModelRow, ToolRow } from './api-types';
import { all, buildWhere } from './query-filters';
import { latestRates } from './rates';
import { rowToTotals, TOTALS_COLS, type TotalsRow } from './query-totals';
import type { PriceTier } from './types';

interface ModelAggRow extends TotalsRow {
  model: string;
  priced: number;
  tier: PriceTier;
  avg_context: number | null;
}

export function models(db: Database, f: Filters): ModelRow[] {
  const w = buildWhere(f);
  const rows = all<ModelAggRow>(
    db,
    `SELECT e.model AS model, MAX(e.priced) AS priced,
            (SELECT e2.tier FROM events e2 WHERE e2.model = e.model ORDER BY e2.ts DESC LIMIT 1) AS tier,
            AVG(CASE WHEN e.kind = 'step' THEN
              e.input_tokens + e.cache_read_tokens + e.cache_write_5m_tokens + e.cache_write_1h_tokens END) AS avg_context,
            ${TOTALS_COLS}
     FROM events e WHERE ${w.sql} GROUP BY e.model ORDER BY cost_usd DESC, input_tokens DESC, e.model`,
    w.params,
  );
  const agentRows = all<{ model: string; agent: string }>(
    db,
    `SELECT e.model AS model, e.agent AS agent FROM events e WHERE ${w.sql} GROUP BY e.model, e.agent ORDER BY e.agent`,
    w.params,
  );
  const agentsByModel = new Map<string, string[]>();
  for (const a of agentRows) {
    const list = agentsByModel.get(a.model) ?? [];
    list.push(a.agent);
    agentsByModel.set(a.model, list);
  }

  return rows.map((r) => ({
    ...rowToTotals(r),
    model: r.model,
    priced: r.priced === 1,
    tier: r.tier,
    agents: agentsByModel.get(r.model) ?? [],
    avgContext: r.avg_context ?? 0,
    rates: latestRates(db, r.model, r.tier),
  }));
}

/** "mcp__<server>__<tool>" -> server; everything else is a built-in tool. */
export function toolGroup(name: string): string {
  const m = /^mcp__(.+?)__.+$/.exec(name);
  return m?.[1] ?? 'builtin';
}

interface ToolAggRow {
  name: string;
  calls: number;
  with_result: number;
  total_bytes: number;
  max_bytes: number;
}

export function tools(db: Database, f: Filters): ToolRow[] {
  const w = buildWhere(f);
  const rows = all<ToolAggRow>(
    db,
    `SELECT t.name AS name, COUNT(*) AS calls,
            SUM(CASE WHEN t.result_bytes IS NULL THEN 0 ELSE 1 END) AS with_result,
            COALESCE(SUM(t.result_bytes), 0) AS total_bytes,
            COALESCE(MAX(t.result_bytes), 0) AS max_bytes
     FROM tool_calls t JOIN events e ON e.id = t.event_id
     WHERE ${w.sql} AND t.name <> ''
     GROUP BY t.name ORDER BY total_bytes DESC, calls DESC, t.name`,
    w.params,
  );
  const agentRows = all<{ name: string; agent: string }>(
    db,
    `SELECT t.name AS name, e.agent AS agent FROM tool_calls t JOIN events e ON e.id = t.event_id
     WHERE ${w.sql} AND t.name <> '' GROUP BY t.name, e.agent ORDER BY e.agent`,
    w.params,
  );
  const agentsByTool = new Map<string, string[]>();
  for (const a of agentRows) {
    const list = agentsByTool.get(a.name) ?? [];
    list.push(a.agent);
    agentsByTool.set(a.name, list);
  }
  return rows.map((r) => ({
    name: r.name,
    group: toolGroup(r.name),
    calls: r.calls,
    totalResultBytes: r.total_bytes,
    avgResultBytes: r.with_result > 0 ? r.total_bytes / r.with_result : 0,
    maxResultBytes: r.max_bytes,
    agents: agentsByTool.get(r.name) ?? [],
  }));
}
