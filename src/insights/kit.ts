import type { Database } from 'bun:sqlite';
import type { Filters, Finding, Severity } from '../core/api-types';
import { all, buildWhere, one } from '../core/query-filters';
import { BUCKET_MS, localDate, resolveTz } from '../core/query-time';
import { latestRates, type Rates } from '../core/rates';
import type { PriceTier } from '../core/types';

/** Fewest observations before a percentile of the user's own history is trusted. */
export const MIN_SAMPLE = 20;
/** Findings that would move less than this share of window spend are noise and stay silent. */
export const MIN_SHARE = 0.01;
/** Cache TTLs are fixed by the two cache-write price kinds (cache_write_5m / cache_write_1h). */
export const TTL_5M_MS = 5 * 60_000;
export const TTL_1H_MS = 60 * 60_000;

export interface Step {
  id: string;
  agent: string;
  sessionId: string;
  ts: number;
  model: string;
  tier: PriceTier;
  priced: boolean;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  costUsd: number | null;
  isSubagent: boolean;
}

export interface InsightContext {
  db: Database;
  filters: Filters;
  now: number;
  rates(model: string, tier: PriceTier): Rates | null;
  /** Per-step events inside the filter window. */
  steps(): readonly Step[];
  /** Every per-step event ever ingested (the user's own baseline). */
  historySteps(): readonly Step[];
  /** Priced spend inside the filter window, all event kinds. */
  windowCostUsd(): number;
  /** A finding is worth showing if it is at least MIN_SHARE of window spend or at least as much as a typical session costs. */
  isMaterial(amountUsd: number): boolean;
  tz(): string;
}

export interface InsightRule {
  id: string;
  run(ctx: InsightContext): Finding[];
}

interface StepDbRow {
  id: string; agent: string; session_id: string; ts: number; model: string; tier: PriceTier; priced: number;
  input_tokens: number; output_tokens: number; reasoning_tokens: number; cache_read_tokens: number;
  cache_write_5m_tokens: number; cache_write_1h_tokens: number; cost_usd: number | null; is_subagent: number;
}

function loadSteps(db: Database, whereSql: string, params: ReadonlyArray<string | number>): Step[] {
  return all<StepDbRow>(
    db,
    `SELECT e.id, e.agent, e.session_id, e.ts, e.model, e.tier, e.priced, e.input_tokens, e.output_tokens,
            e.reasoning_tokens, e.cache_read_tokens, e.cache_write_5m_tokens, e.cache_write_1h_tokens,
            e.cost_usd, e.is_subagent
     FROM events e WHERE e.kind = 'step' AND ${whereSql} ORDER BY e.agent, e.session_id, e.ts, e.id`,
    params,
  ).map((r) => ({
    id: r.id, agent: r.agent, sessionId: r.session_id, ts: r.ts, model: r.model, tier: r.tier,
    priced: r.priced === 1, input: r.input_tokens, output: r.output_tokens, reasoning: r.reasoning_tokens,
    cacheRead: r.cache_read_tokens, cacheWrite5m: r.cache_write_5m_tokens, cacheWrite1h: r.cache_write_1h_tokens,
    costUsd: r.cost_usd, isSubagent: r.is_subagent === 1,
  }));
}

export function createContext(db: Database, filters: Filters, now: number = Date.now()): InsightContext {
  const rateMemo = new Map<string, Rates | null>();
  let windowSteps: Step[] | undefined;
  let history: Step[] | undefined;
  let windowCost: number | undefined;
  let typicalSession: number | undefined;
  const windowCostUsd = (): number => {
    if (windowCost === undefined) {
      const w = buildWhere(filters);
      windowCost = one<{ c: number }>(db, `SELECT COALESCE(SUM(e.cost_usd), 0) AS c FROM events e WHERE ${w.sql}`, w.params)?.c ?? 0;
    }
    return windowCost;
  };
  return {
    db, filters, now,
    rates(model, tier) {
      const k = `${model}\u0000${tier}`;
      if (!rateMemo.has(k)) rateMemo.set(k, latestRates(db, model, tier));
      return rateMemo.get(k) ?? null;
    },
    steps() {
      if (!windowSteps) {
        const w = buildWhere(filters);
        windowSteps = loadSteps(db, w.sql, w.params);
      }
      return windowSteps;
    },
    historySteps() {
      history ??= loadSteps(db, '1=1', []);
      return history;
    },
    windowCostUsd,
    isMaterial(amountUsd) {
      if (typicalSession === undefined) {
        const costs = all<{ c: number }>(db, 'SELECT COALESCE(SUM(e.cost_usd), 0) AS c FROM events e GROUP BY e.agent, e.session_id').map((r) => r.c);
        typicalSession = costs.length >= MIN_SAMPLE ? median(costs) : 0;
      }
      return amountUsd > 0 && (isSignificant(amountUsd, windowCostUsd()) || (typicalSession > 0 && amountUsd >= typicalSession));
    },
    tz: () => resolveTz(filters.tz),
  };
}

// ---- statistics --------------------------------------------------------------------------

/** Linear-interpolated percentile, p in [0, 1]. Returns NaN for an empty list. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(Math.max(p, 0), 1) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (idx - lo);
}

export const median = (values: readonly number[]): number => percentile(values, 0.5);

/** Median absolute deviation scaled to be comparable to a standard deviation. */
export function robustSigma(values: readonly number[]): number {
  const m = median(values);
  return 1.4826 * median(values.map((v) => Math.abs(v - m)));
}

export const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
export const mean = (values: readonly number[]): number => (values.length ? sum(values) / values.length : 0);

// ---- step helpers ------------------------------------------------------------------------

export const contextOf = (s: Step): number => s.input + s.cacheRead + s.cacheWrite5m + s.cacheWrite1h;
export const cacheWriteOf = (s: Step): number => s.cacheWrite5m + s.cacheWrite1h;

export function stepCostWith(s: Step, r: Rates): number {
  return (
    s.input * r.input + (s.output + s.reasoning) * r.output + s.cacheRead * r.cacheRead +
    s.cacheWrite5m * r.cacheWrite5m + s.cacheWrite1h * r.cacheWrite1h
  ) / 1e6;
}

export type Chain = readonly Step[];

/** Groups steps into ordered chains, one per (agent, session, isSubagent). Subagent chains are kept apart because their context is independent of the main thread. */
export function toChains(steps: readonly Step[], opts: { mainOnly?: boolean } = {}): Chain[] {
  const map = new Map<string, Step[]>();
  for (const s of steps) {
    if (opts.mainOnly && s.isSubagent) continue;
    const k = `${s.agent}\u001f${s.sessionId}\u001f${s.isSubagent ? 1 : 0}`;
    const list = map.get(k);
    if (list) list.push(s);
    else map.set(k, [s]);
  }
  return [...map.values()].map((c) => c.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id)));
}

/** Most frequent model in a chain (by step count). */
export function dominantModel(chain: Chain): string {
  const counts = new Map<string, number>();
  for (const s of chain) counts.set(s.model, (counts.get(s.model) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

/** Daily priced spend across all history, keyed by local YYYY-MM-DD. */
export function dailyCosts(db: Database, tz: string): Map<string, number> {
  const rows = all<{ b: number; c: number }>(
    db,
    `SELECT (e.ts / ${BUCKET_MS}) AS b, COALESCE(SUM(e.cost_usd), 0) AS c FROM events e GROUP BY b`,
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    const d = localDate(r.b * BUCKET_MS, tz);
    out.set(d, (out.get(d) ?? 0) + r.c);
  }
  return out;
}

// ---- presentation ------------------------------------------------------------------------

export function fmtTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e5 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function fmtUsd(n: number): string {
  if (n >= 100) return `$${Math.round(n)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(n >= 0.1 ? 2 : 3)}`;
}

export const fmtPct = (ratio: number): string => `${Math.round(ratio * 100)}%`;

export function fmtBytes(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kB`;
  return `${Math.round(n)} B`;
}

/** Severity from the share of window spend that a finding represents. */
export function severityForShare(amountUsd: number, windowCostUsd: number): Severity {
  if (windowCostUsd <= 0) return 'info';
  const share = amountUsd / windowCostUsd;
  if (share >= 0.2) return 'high';
  if (share >= 0.05) return 'warn';
  return 'info';
}

export function isSignificant(amountUsd: number, windowCostUsd: number): boolean {
  return windowCostUsd > 0 && amountUsd / windowCostUsd >= MIN_SHARE;
}
