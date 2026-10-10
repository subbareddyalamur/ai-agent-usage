import type { Database } from 'bun:sqlite';
import type {
  CacheDayPoint, CacheMissStep, CacheModelRow, CacheReasonRow, CacheReport, CacheSessionRow,
  Filters, MissReason,
} from './api-types';
import {
  classifyConversations, deriveTtl, UNAVOIDABLE, type CacheStep, type ClassifiedStep, type ClassifyOpts,
} from './cache-miss';
import { all, buildWhere } from './query-filters';
import { BUCKET_MS, localDate, resolveTz } from './query-time';
import { latestRates, type Rates } from './rates';
import type { PriceTier } from './types';

const RECENT_LIMIT = 100;
const SESSION_LIMIT = 25;
const ALL_REASONS: readonly MissReason[] = [
  'cold-start', 'context-reset', 'caching-off', 'expired', 'model-switch', 'prefix-change',
];

/** Memoised live rates; one DB lookup per (model, tier). */
export function rateMemo(db: Database): (model: string, tier: PriceTier) => Rates | null {
  const memo = new Map<string, Rates | null>();
  return (model, tier) => {
    const k = `${model}\u0000${tier}`;
    if (!memo.has(k)) memo.set(k, latestRates(db, model, tier));
    return memo.get(k) ?? null;
  };
}

/**
 * A model is judged only when a cache hit actually saves money: it has a cache-read price. A model that is
 * priced without one (free, local, or APIs with implicit caching and no discount) is never judged. For
 * unpriced models the only evidence is whether any cache read/write was ever seen.
 */
export function cacheSupport(
  steps: readonly CacheStep[],
  rate: (model: string, tier: PriceTier) => Rates | null,
): (model: string, tier: PriceTier) => boolean {
  const seen = new Set<string>();
  for (const s of steps) if (s.cacheRead + s.cacheWrite5m + s.cacheWrite1h > 0) seen.add(s.model);
  return (model, tier) => {
    const r = rate(model, tier);
    return r ? r.cacheRead > 0 : seen.has(model);
  };
}

/** `ttlSteps` (default: all steps) decide the fallback cache lifetime; `steps` decide which models can cache. */
export function classifyOpts(db: Database, steps: readonly CacheStep[], ttlSteps: readonly CacheStep[] = steps): ClassifyOpts {
  const rate = rateMemo(db);
  return { ttlMs: deriveTtl(ttlSteps).ttlMs, rate, supportsCache: cacheSupport(steps, rate) };
}

interface DbStep extends CacheStep {
  project: string | null;
}

interface StepDbRow {
  id: string; agent: string; session_id: string; project: string | null; ts: number; model: string;
  tier: PriceTier; input_tokens: number; cache_read_tokens: number; cache_write_5m_tokens: number;
  cache_write_1h_tokens: number; is_subagent: number;
}

const STEP_COLS = `e.id, e.agent, e.session_id, e.project, e.ts, e.model, e.tier, e.input_tokens,
  e.cache_read_tokens, e.cache_write_5m_tokens, e.cache_write_1h_tokens, e.is_subagent`;

function toStep(r: StepDbRow): DbStep {
  return {
    id: r.id, agent: r.agent, sessionId: r.session_id, project: r.project, ts: r.ts, model: r.model, tier: r.tier,
    input: r.input_tokens, cacheRead: r.cache_read_tokens, cacheWrite5m: r.cache_write_5m_tokens,
    cacheWrite1h: r.cache_write_1h_tokens, isSubagent: r.is_subagent === 1,
  };
}

/**
 * Loads every step of every conversation that has at least one step inside the filter, so the first
 * step of a time window still sees its true predecessor (and is not mistaken for a cold start).
 */
function loadConversations(db: Database, f: Filters): DbStep[] {
  const w = buildWhere(f, 'e2');
  const scope =
    w.sql === '1=1'
      ? ''
      : `AND (e.agent || char(31) || e.session_id || char(31) || e.is_subagent) IN (
           SELECT e2.agent || char(31) || e2.session_id || char(31) || e2.is_subagent
           FROM events e2 WHERE e2.kind = 'step' AND ${w.sql})`;
  return all<StepDbRow>(
    db,
    `SELECT ${STEP_COLS} FROM events e WHERE e.kind = 'step' ${scope}`,
    w.params,
  ).map(toStep);
}

/** Same semantics as buildWhere, evaluated in JS on an already loaded step. */
function inFilter(f: Filters, s: DbStep): boolean {
  if (f.from !== undefined && s.ts < f.from) return false;
  if (f.to !== undefined && s.ts > f.to) return false;
  if (f.agents && f.agents.length > 0 && !f.agents.includes(s.agent)) return false;
  if (f.models && f.models.length > 0 && !f.models.includes(s.model)) return false;
  if (f.projects && f.projects.length > 0 && !(s.project !== null && f.projects.includes(s.project))) return false;
  if (f.includeSubagents === false && s.isSubagent) return false;
  return true;
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
const ttlLabel = (ms: number): string => (ms >= 3_600_000 ? '1 hour' : `${Math.round(ms / 60_000)} minutes`);

function explanations(
  ttlMs: number,
  ttlSource: '5m' | '1h' | 'mixed',
  readShare: string,
): Record<MissReason, string> {
  const cheap = readShare ? ` ${readShare}` : '';
  return {
    'cold-start':
      'The first call of a conversation has nothing cached yet, so the whole prompt is written once. Nothing to fix; shorter or shared system prompts and tool lists make every cold start smaller.',
    'context-reset':
      'The prompt shrank sharply, which means the conversation was compacted or restarted. The new, shorter prompt has to be cached from scratch. Expected after a compaction.',
    'caching-off':
      `These calls neither read from nor wrote to the cache although the model supports it, so they paid the full input price for the whole prompt.${cheap} Usually the agent did not send cache markers for that call, for example because the model id (such as an inference profile ARN) does not look like a Claude model to the agent.`,
    expired:
      `You paused longer than the cache lives (${ttlLabel(ttlMs)}${ttlSource === 'mixed' ? ', mostly 5 minutes' : ''}), so the next call had to write the whole conversation again instead of reading it.${cheap} Shorter pauses, or the 1-hour cache option where your agent has one, avoid this; after a very long break a fresh session is cheaper.`,
    'model-switch':
      `The model changed between calls. Caches belong to one model, so the new model re-read the conversation at full price.${cheap} Route light work to a subagent or a separate session instead of switching mid-conversation.`,
    'prefix-change':
      `No long pause and the same model, yet earlier parts of the prompt were re-sent at full price.${cheap} Something near the start of the prompt changed (system prompt, tool or MCP list, edited history), which invalidates everything after it; parallel calls started before the cache was written can look the same.`,
  };
}

function round(n: number): number {
  return Math.round(n * 1e9) / 1e9;
}

function missStep(c: ClassifiedStep, title: string | null): CacheMissStep {
  return {
    ts: c.step.ts, agent: c.step.agent, sessionId: c.step.sessionId, title, model: c.step.model,
    reason: c.reason as MissReason, avoidable: c.avoidable, promptTokens: c.promptTokens,
    cacheReadTokens: c.step.cacheRead, freshTokens: c.freshTokens, missTokens: c.missTokens,
    gapMs: c.gapMs, extraCostUsd: c.extraCostUsd,
  };
}

interface Acc {
  steps: number; promptTokens: number; cacheRead: number; missTokens: number; extra: number;
}
const emptyAcc = (): Acc => ({ steps: 0, promptTokens: 0, cacheRead: 0, missTokens: 0, extra: 0 });
const ratio = (read: number, prompt: number): number | null => (prompt > 0 ? read / prompt : null);

export function cacheReport(db: Database, f: Filters): CacheReport {
  const loaded = loadConversations(db, f);
  const windowSteps = loaded.filter((s) => inFilter(f, s));
  const windowIds = new Set(windowSteps.map((s) => s.id));
  const { ttlMs, source: ttlSource } = deriveTtl(windowSteps);
  const opts = classifyOpts(db, loaded, windowSteps);
  const inWindow = classifyConversations(loaded, opts).filter((c) => windowIds.has(c.step.id));
  const capableSteps = inWindow.filter((c) => opts.supportsCache(c.step.model, c.step.tier));
  const misses = capableSteps.filter((c) => c.isMiss);
  const avoidable = misses.filter((c) => c.avoidable);

  const titles = new Map<string, string | null>();
  for (const r of all<{ agent: string; session_id: string; title: string | null }>(
    db, 'SELECT agent, session_id, title FROM sessions')) titles.set(`${r.agent}\u001f${r.session_id}`, r.title);
  const titleOf = (agent: string, sessionId: string): string | null => titles.get(`${agent}\u001f${sessionId}`) ?? null;

  // ---- totals
  const totals = capableSteps.reduce(
    (a, c) => ({ prompt: a.prompt + c.promptTokens, read: a.read + c.step.cacheRead }),
    { prompt: 0, read: 0 },
  );
  const sum = (list: readonly ClassifiedStep[], pick: (c: ClassifiedStep) => number): number =>
    list.reduce((a, c) => a + pick(c), 0);
  const extraOf = (c: ClassifiedStep): number => c.extraCostUsd ?? 0;

  // ---- reasons
  let dominantRates: Rates | null = null;
  {
    const byModel = new Map<string, { tokens: number; tier: PriceTier }>();
    for (const c of capableSteps) {
      const cur = byModel.get(c.step.model) ?? { tokens: 0, tier: c.step.tier };
      byModel.set(c.step.model, { tokens: cur.tokens + c.promptTokens, tier: cur.tier });
    }
    const top = [...byModel.entries()].filter(([m, v]) => (opts.rate(m, v.tier)?.input ?? 0) > 0)
      .sort((a, b) => b[1].tokens - a[1].tokens)[0];
    if (top) dominantRates = opts.rate(top[0], top[1].tier);
  }
  const readShare = dominantRates && dominantRates.input > 0
    ? `A cache read costs ${pct(dominantRates.cacheRead / dominantRates.input)} of a fresh input token and a 5-minute cache write ${pct(dominantRates.cacheWrite5m / dominantRates.input)}.`
    : '';
  const text = explanations(ttlMs, ttlSource, readShare);
  const reasons: CacheReasonRow[] = ALL_REASONS.map((reason) => {
    const rows = misses.filter((c) => c.reason === reason);
    return {
      reason, avoidable: !UNAVOIDABLE.has(reason), steps: rows.length,
      missTokens: sum(rows, (c) => c.missTokens), extraCostUsd: round(sum(rows, extraOf)),
      explanation: text[reason],
    };
  });

  // ---- models (all models in the window; non-caching ones show zeros)
  const modelAcc = new Map<string, Acc & { seen: boolean; tier: PriceTier }>();
  for (const c of inWindow) {
    const acc = modelAcc.get(c.step.model) ?? { ...emptyAcc(), seen: false, tier: c.step.tier };
    acc.steps++;
    acc.promptTokens += c.promptTokens;
    acc.cacheRead += c.step.cacheRead;
    acc.seen ||= c.step.cacheRead + c.step.cacheWrite5m + c.step.cacheWrite1h > 0;
    if (c.isMiss && c.avoidable) {
      acc.missTokens += c.missTokens;
      acc.extra += extraOf(c);
    }
    modelAcc.set(c.step.model, acc);
  }
  const models: CacheModelRow[] = [...modelAcc.entries()]
    .map(([model, a]) => {
      const capable = opts.supportsCache(model, a.tier);
      return {
        model, steps: a.steps, promptTokens: a.promptTokens, cacheReadTokens: a.cacheRead,
        hitRatio: capable ? ratio(a.cacheRead, a.promptTokens) : null,
        missTokens: a.missTokens, extraCostUsd: round(a.extra), cacheSeen: a.seen,
      };
    })
    .sort((a, b) => b.extraCostUsd - a.extraCostUsd || b.promptTokens - a.promptTokens || a.model.localeCompare(b.model));

  // ---- sessions
  const sessAcc = new Map<string, { agent: string; sessionId: string; acc: Acc; missSteps: number; usd: Map<MissReason, number>; tok: Map<MissReason, number> }>();
  for (const c of capableSteps) {
    const k = `${c.step.agent}\u001f${c.step.sessionId}`;
    const s = sessAcc.get(k) ?? { agent: c.step.agent, sessionId: c.step.sessionId, acc: emptyAcc(), missSteps: 0, usd: new Map(), tok: new Map() };
    s.acc.steps++;
    s.acc.promptTokens += c.promptTokens;
    s.acc.cacheRead += c.step.cacheRead;
    if (c.isMiss && c.avoidable) {
      s.missSteps++;
      s.acc.extra += extraOf(c);
      const r = c.reason as MissReason;
      s.usd.set(r, (s.usd.get(r) ?? 0) + extraOf(c));
      s.tok.set(r, (s.tok.get(r) ?? 0) + c.missTokens);
    }
    sessAcc.set(k, s);
  }
  const sessions: CacheSessionRow[] = [...sessAcc.values()]
    .filter((s) => s.missSteps > 0)
    .sort((a, b) => b.acc.extra - a.acc.extra || b.missSteps - a.missSteps || a.sessionId.localeCompare(b.sessionId))
    .slice(0, SESSION_LIMIT)
    .map((s) => ({
      agent: s.agent, sessionId: s.sessionId, title: titleOf(s.agent, s.sessionId), steps: s.acc.steps,
      missSteps: s.missSteps, hitRatio: ratio(s.acc.cacheRead, s.acc.promptTokens), extraCostUsd: round(s.acc.extra),
      dominantReason: [...s.usd.keys()].sort((a, b) =>
        (s.usd.get(b) ?? 0) - (s.usd.get(a) ?? 0) || (s.tok.get(b) ?? 0) - (s.tok.get(a) ?? 0))[0] ?? null,
    }));

  // ---- days
  const tz = resolveTz(f.tz);
  const dayOfBucket = new Map<number, string>();
  const dayAcc = new Map<string, Acc>();
  for (const c of capableSteps) {
    const b = Math.floor(c.step.ts / BUCKET_MS);
    let day = dayOfBucket.get(b);
    if (day === undefined) {
      day = localDate(b * BUCKET_MS, tz);
      dayOfBucket.set(b, day);
    }
    const a = dayAcc.get(day) ?? emptyAcc();
    a.promptTokens += c.promptTokens;
    a.cacheRead += c.step.cacheRead;
    if (c.isMiss && c.avoidable) a.extra += extraOf(c);
    dayAcc.set(day, a);
  }
  const days: CacheDayPoint[] = [...dayAcc.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucket, a]) => ({
      bucket, hitRatio: ratio(a.cacheRead, a.promptTokens), promptTokens: a.promptTokens,
      cacheReadTokens: a.cacheRead, extraCostUsd: round(a.extra),
    }));

  // ---- recent
  const recent: CacheMissStep[] = [...avoidable]
    .sort((a, b) => b.step.ts - a.step.ts || a.step.id.localeCompare(b.step.id))
    .slice(0, RECENT_LIMIT)
    .map((c) => missStep(c, titleOf(c.step.agent, c.step.sessionId)));

  return {
    totals: {
      steps: capableSteps.length,
      promptTokens: totals.prompt,
      cacheReadTokens: totals.read,
      hitRatio: ratio(totals.read, totals.prompt),
      unavoidableTokens: sum(misses.filter((c) => !c.avoidable), (c) => c.missTokens),
      avoidableMissTokens: sum(avoidable, (c) => c.missTokens),
      extraCostUsd: round(sum(avoidable, extraOf)),
      ttlMs,
      ttlSource,
    },
    reasons,
    models,
    sessions,
    days,
    recent,
  };
}
