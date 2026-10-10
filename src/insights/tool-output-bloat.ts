import type { Finding } from '../core/api-types';
import { all, buildWhere } from '../core/query-filters';
import { toolGroup } from '../core/query-models';
import {
  contextOf, fmtBytes, fmtPct, fmtTokens, median, MIN_SAMPLE, MIN_SHARE, robustSigma, sum, type InsightRule, type Step,
} from './kit';

/** Tool results are text; roughly this many bytes make one token. */
const BYTES_PER_TOKEN = 4;
/** A tool needs this many measured calls before it is judged. */
const MIN_CALLS = 3;
/** Robust standard deviations above the typical call size that make a tool's average "unusually large". */
const HEAVY_SIGMAS = 3;

interface CallRow {
  name: string;
  result_bytes: number;
  agent: string;
  session_id: string;
  ts: number;
}

interface ToolAgg {
  name: string;
  calls: number;
  bytes: number;
  maxBytes: number;
  carriedTokens: number;
}

/** Number of steps strictly after `ts` in a sorted timestamp list. */
function stepsAfter(sorted: readonly number[], ts: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) <= ts) lo = mid + 1;
    else hi = mid;
  }
  return sorted.length - lo;
}

const rule: InsightRule = {
  id: 'tool-output-bloat',
  run(ctx): Finding[] {
    const histBytes = all<{ b: number }>(
      ctx.db,
      'SELECT result_bytes AS b FROM tool_calls WHERE result_bytes IS NOT NULL',
    ).map((r) => r.b);
    if (histBytes.length < MIN_SAMPLE) return [];
    const typical = median(histBytes);
    const heavy = typical + HEAVY_SIGMAS * robustSigma(histBytes);

    const w = buildWhere(ctx.filters);
    const calls = all<CallRow>(
      ctx.db,
      `SELECT t.name AS name, t.result_bytes AS result_bytes, e.agent AS agent, e.session_id AS session_id, e.ts AS ts
       FROM tool_calls t JOIN events e ON e.id = t.event_id
       WHERE ${w.sql} AND t.result_bytes IS NOT NULL AND t.name <> ''`,
      w.params,
    );
    if (calls.length === 0) return [];

    const steps = ctx.steps();
    const tsBySession = new Map<string, number[]>();
    for (const s of steps) {
      const k = `${s.agent}\u001f${s.sessionId}`;
      const list = tsBySession.get(k);
      if (list) list.push(s.ts);
      else tsBySession.set(k, [s.ts]);
    }
    for (const list of tsBySession.values()) list.sort((a, b) => a - b);

    const byTool = new Map<string, ToolAgg>();
    for (const c of calls) {
      const tokens = c.result_bytes / BYTES_PER_TOKEN;
      const carried = tokens * (1 + stepsAfter(tsBySession.get(`${c.agent}\u001f${c.session_id}`) ?? [], c.ts));
      const a = byTool.get(c.name) ?? { name: c.name, calls: 0, bytes: 0, maxBytes: 0, carriedTokens: 0 };
      byTool.set(c.name, {
        ...a, calls: a.calls + 1, bytes: a.bytes + c.result_bytes,
        maxBytes: Math.max(a.maxBytes, c.result_bytes), carriedTokens: a.carriedTokens + carried,
      });
    }

    const totalPrompt = sum(steps.map((s: Step) => contextOf(s)));
    const bloaty = [...byTool.values()]
      .filter((t) => t.calls >= MIN_CALLS && t.bytes / t.calls > heavy && totalPrompt > 0 && t.carriedTokens / totalPrompt >= MIN_SHARE)
      .sort((a, b) => b.carriedTokens - a.carriedTokens);
    if (bloaty.length === 0) return [];

    const carried = sum(bloaty.map((t) => t.carriedTokens));
    const share = totalPrompt > 0 ? carried / totalPrompt : 0;
    const top = bloaty[0] as ToolAgg;
    return [{
      id: 'tool-output-bloat',
      severity: share >= 0.2 ? 'high' : share >= 0.05 ? 'warn' : 'info',
      title: `${bloaty.length} tool${bloaty.length === 1 ? '' : 's'} return unusually large results`,
      detail:
        `A tool result stays in the conversation, so it is re-sent on every later step. ` +
        `${top.name} averaged ${fmtBytes(top.bytes / top.calls)} per call (a typical tool call in your history returns ${fmtBytes(typical)}). ` +
        `Counting every re-send, the flagged tools account for about ${fmtTokens(carried)} prompt tokens (${fmtPct(share)} of all prompt tokens in this range). ` +
        `Narrower queries, output limits, or an output-trimming layer such as RTK keep them out of the context.`,
      evidence: bloaty.slice(0, 10).map((t) => ({
        label: `${t.name} (${toolGroup(t.name)}): ${t.calls} calls, avg ${fmtBytes(t.bytes / t.calls)}, max ${fmtBytes(t.maxBytes)}, ~${fmtTokens(t.carriedTokens)} tokens carried`,
        value: fmtBytes(t.bytes / t.calls),
      })),
      concept: 'tools',
    }];
  },
};

export default rule;
