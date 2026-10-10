import type { Database } from 'bun:sqlite';
import type { Filters, SessionDetail, SessionRow, StepCacheMiss, StepRow } from './api-types';
import type { PriceTier } from './types';
import { classifyConversations, type CacheStep } from './cache-miss';
import { classifyOpts } from './query-cache';
import { all, buildWhere, one, type SqlParam } from './query-filters';
import { rowToTotals, TOTALS_COLS, type TotalsRow } from './query-totals';

export interface SessionsOpts {
  sort?: 'cost' | 'ts' | 'context' | 'cacheHit' | 'steps';
  dir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

const CONTEXT_EXPR = 'e.input_tokens + e.cache_read_tokens + e.cache_write_5m_tokens + e.cache_write_1h_tokens';

/** Whitelisted ORDER BY expressions; user input only ever selects a key, never reaches SQL text. */
const SORTS: Record<NonNullable<SessionsOpts['sort']>, string> = {
  cost: 'cost_usd',
  ts: 'last_ts',
  context: 'COALESCE(peak_context, 0)',
  cacheHit: 'COALESCE(CAST(cache_read_tokens AS REAL) / NULLIF(input_tokens + cache_read_tokens + cache_write_tokens, 0), -1)',
  steps: 'steps',
};

interface SessionAggRow extends TotalsRow {
  agent: string;
  session_id: string;
  title: string | null;
  project: string | null;
  first_ts: number;
  last_ts: number;
  steps: number;
  peak_context: number | null;
  has_sub: number;
}

function querySessionRows(
  db: Database,
  whereSql: string,
  params: readonly SqlParam[],
  orderSql: string,
  limit: number,
  offset: number,
): SessionRow[] {
  const rows = all<SessionAggRow>(
    db,
    `SELECT e.agent AS agent, e.session_id AS session_id,
            MAX(s.title) AS title, COALESCE(MAX(s.project), MIN(e.project)) AS project,
            MIN(e.ts) AS first_ts, MAX(e.ts) AS last_ts,
            SUM(CASE WHEN e.kind = 'step' THEN 1 ELSE 0 END) AS steps,
            MAX(CASE WHEN e.kind = 'step' THEN ${CONTEXT_EXPR} END) AS peak_context,
            MAX(e.is_subagent) AS has_sub,
            ${TOTALS_COLS}
     FROM events e
     LEFT JOIN sessions s ON s.agent = e.agent AND s.session_id = e.session_id
     WHERE ${whereSql}
     GROUP BY e.agent, e.session_id
     ORDER BY ${orderSql}, e.agent, e.session_id
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  return rows.map((r) => {
    const models = all<{ model: string }>(
      db,
      `SELECT DISTINCT e.model AS model FROM events e WHERE e.agent = ? AND e.session_id = ? AND ${whereSql} ORDER BY e.model`,
      [r.agent, r.session_id, ...params],
    ).map((m) => m.model);
    return {
      agent: r.agent,
      sessionId: r.session_id,
      title: r.title,
      project: r.project,
      firstTs: r.first_ts,
      lastTs: r.last_ts,
      steps: r.steps,
      models,
      totalOnly: r.steps === 0,
      totals: rowToTotals(r),
      peakContext: r.peak_context ?? 0,
      hasSubagents: r.has_sub === 1,
    };
  });
}

export function sessions(
  db: Database,
  f: Filters,
  opts: SessionsOpts = {},
): { rows: SessionRow[]; total: number } {
  const w = buildWhere(f);
  const sortKey = opts.sort && opts.sort in SORTS ? opts.sort : 'cost';
  const dir = opts.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 100_000);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const total = one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM events e WHERE ${w.sql} GROUP BY e.agent, e.session_id)`,
    w.params,
  );
  const rows = querySessionRows(db, w.sql, w.params, `${SORTS[sortKey]} ${dir}`, limit, offset);
  return { rows, total: total?.n ?? 0 };
}

interface StepDbRow {
  id: string;
  ts: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  tier: PriceTier;
  cost_usd: number | null;
  is_subagent: number;
}

export function sessionDetail(db: Database, agent: string, sessionId: string): SessionDetail | null {
  const where = 'e.agent = ? AND e.session_id = ?';
  const [row] = querySessionRows(db, where, [agent, sessionId], 'e.agent', 1, 0);
  if (!row) return null;

  const steps = all<StepDbRow>(
    db,
    `SELECT e.id, e.ts, e.model, e.input_tokens, e.output_tokens, e.reasoning_tokens,
            e.cache_read_tokens, e.cache_write_5m_tokens + e.cache_write_1h_tokens AS cache_write_tokens,
            e.cache_write_5m_tokens, e.cache_write_1h_tokens, e.tier,
            e.cost_usd, e.is_subagent
     FROM events e WHERE ${where} AND e.kind = 'step' ORDER BY e.ts, e.id`,
    [agent, sessionId],
  );
  const toolRows = all<{ event_id: string; name: string; result_bytes: number | null }>(
    db,
    `SELECT t.event_id, t.name, t.result_bytes FROM tool_calls t
     WHERE t.event_id IN (SELECT e.id FROM events e WHERE ${where}) ORDER BY t.rowid`,
    [agent, sessionId],
  );
  const toolsByEvent = new Map<string, Array<{ name: string; resultBytes: number | null }>>();
  for (const t of toolRows) {
    const list = toolsByEvent.get(t.event_id) ?? [];
    list.push({ name: t.name, resultBytes: t.result_bytes });
    toolsByEvent.set(t.event_id, list);
  }

  const cacheSteps: CacheStep[] = steps.map((s) => ({
    id: s.id, agent, sessionId, ts: s.ts, model: s.model, tier: s.tier, input: s.input_tokens,
    cacheRead: s.cache_read_tokens, cacheWrite5m: s.cache_write_5m_tokens, cacheWrite1h: s.cache_write_1h_tokens,
    isSubagent: s.is_subagent === 1,
  }));
  const missById = new Map<string, StepCacheMiss>();
  for (const c of classifyConversations(cacheSteps, classifyOpts(db, cacheSteps))) {
    if (c.isMiss && c.reason) {
      missById.set(c.step.id, { reason: c.reason, avoidable: c.avoidable, missTokens: c.missTokens, extraCostUsd: c.extraCostUsd });
    }
  }

  const stepRows: StepRow[] = steps.map((s) => ({
    ts: s.ts,
    model: s.model,
    inputTokens: s.input_tokens,
    outputTokens: s.output_tokens,
    reasoningTokens: s.reasoning_tokens,
    cacheReadTokens: s.cache_read_tokens,
    cacheWriteTokens: s.cache_write_tokens,
    context: s.input_tokens + s.cache_read_tokens + s.cache_write_tokens,
    costUsd: s.cost_usd,
    isSubagent: s.is_subagent === 1,
    tools: toolsByEvent.get(s.id) ?? [],
    ...(missById.has(s.id) ? { cacheMiss: missById.get(s.id) } : {}),
  }));
  return { row, steps: stepRows };
}
