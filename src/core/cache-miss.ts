import type { MissReason } from './api-types';
import type { Rates } from './rates';
import type { PriceTier } from './types';

/** A step is only reported as a miss when this many prompt tokens were re-sent without need... */
export const MIN_MISS_TOKENS = 2000;
/** ...and they are at least this share of the step's prompt (ordinary growth stays silent). */
export const MIN_MISS_SHARE = 0.1;
/** A prompt that shrinks below this share of the previous one means compaction or a new conversation. */
export const RESET_RATIO = 0.7;

export const TTL_5M_MS = 5 * 60_000;
export const TTL_1H_MS = 60 * 60_000;

export const UNAVOIDABLE: ReadonlySet<MissReason> = new Set<MissReason>(['cold-start', 'context-reset']);

export interface CacheStep {
  id: string;
  agent: string;
  sessionId: string;
  ts: number;
  model: string;
  tier: PriceTier;
  input: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  isSubagent: boolean;
}

export interface ClassifiedStep {
  step: CacheStep;
  /** input + cacheRead + cacheWrite5m + cacheWrite1h. */
  promptTokens: number;
  /** Prompt tokens not served from cache (input + cache writes). */
  freshTokens: number;
  /** Fresh tokens beyond genuinely new content; 0 for hits. */
  missTokens: number;
  isMiss: boolean;
  reason: MissReason | null;
  avoidable: boolean;
  gapMs: number | null;
  extraCostUsd: number | null;
}

export interface ClassifyOpts {
  /** Cache lifetime to assume when the previous step does not say which one it wrote. */
  ttlMs: number;
  rate(model: string, tier: PriceTier): Rates | null;
  /** False for models where a cache hit saves nothing or is unknowable (no cache-read price): their steps are never misses. */
  supportsCache(model: string, tier: PriceTier): boolean;
}

export const promptOf = (s: CacheStep): number => s.input + s.cacheRead + s.cacheWrite5m + s.cacheWrite1h;

/** Cache lifetime implied by what was actually written: 1h cache writes outweigh 5m ones => 1h. */
export function deriveTtl(steps: ReadonlyArray<Pick<CacheStep, 'cacheWrite5m' | 'cacheWrite1h'>>): {
  ttlMs: number;
  source: '5m' | '1h' | 'mixed';
} {
  let w5 = 0;
  let w1 = 0;
  for (const s of steps) {
    w5 += s.cacheWrite5m;
    w1 += s.cacheWrite1h;
  }
  if (w1 > w5) return { ttlMs: TTL_1H_MS, source: '1h' };
  if (w1 === 0) return { ttlMs: TTL_5M_MS, source: '5m' };
  return { ttlMs: TTL_5M_MS, source: 'mixed' };
}

/** What the previous step's own cache write implies about how long its cache lives. */
function ttlAfter(prev: CacheStep, fallbackMs: number): number {
  if (prev.cacheWrite1h > 0) return TTL_1H_MS;
  if (prev.cacheWrite5m > 0) return TTL_5M_MS;
  return fallbackMs;
}

/** Extra USD paid because `missTokens` were billed at the blended fresh rate instead of the cache-read rate. */
export function extraCost(s: CacheStep, missTokens: number, r: Rates | null): number | null {
  if (!r) return null;
  const fresh = s.input + s.cacheWrite5m + s.cacheWrite1h;
  if (fresh <= 0 || missTokens <= 0) return 0;
  const blended = (s.input * r.input + s.cacheWrite5m * r.cacheWrite5m + s.cacheWrite1h * r.cacheWrite1h) / fresh;
  return (missTokens * Math.max(0, blended - r.cacheRead)) / 1e6;
}

function notAMiss(step: CacheStep, gapMs: number | null): ClassifiedStep {
  const promptTokens = promptOf(step);
  return {
    step, promptTokens, freshTokens: promptTokens - step.cacheRead, missTokens: 0,
    isMiss: false, reason: null, avoidable: false, gapMs, extraCostUsd: null,
  };
}

/**
 * Classifies the steps of ONE conversation (already ordered by time). The output is aligned with the input.
 *
 * Reason priority, most to least specific:
 *  cold-start   first call: nothing exists to read yet
 *  context-reset prompt shrank below RESET_RATIO of the previous one: compaction / new conversation
 *  caching-off  no cache request at all: the conversation never used the cache for this model, or this call
 *               neither read nor wrote it although the model reports cache writes elsewhere (a real
 *               invalidation or expiry still writes the new prefix, so zero writes means no cache markers)
 *  expired      the pause since the previous step outlived the cache lifetime
 *  model-switch the model changed (caches are per model)
 *  prefix-change none of the above: something early in the prompt changed
 */
export function classifySteps(steps: readonly CacheStep[], opts: ClassifyOpts): ClassifiedStep[] {
  const active = new Set<string>();
  const reportsWrites = new Set<string>();
  for (const s of steps) {
    if (s.cacheRead + s.cacheWrite5m + s.cacheWrite1h > 0) active.add(s.model);
    if (s.cacheWrite5m + s.cacheWrite1h > 0) reportsWrites.add(s.model);
  }

  return steps.map((s, i) => {
    const prev = i > 0 ? steps[i - 1] : undefined;
    const gapMs = prev ? s.ts - prev.ts : null;
    if (!opts.supportsCache(s.model, s.tier)) return notAMiss(s, gapMs);

    const promptTokens = promptOf(s);
    const freshTokens = Math.max(0, promptTokens - s.cacheRead);
    const prevPrompt = prev ? promptOf(prev) : 0;
    const newContent = prev ? Math.max(0, promptTokens - prevPrompt) : promptTokens;
    const missTokens = prev ? Math.max(0, freshTokens - newContent) : freshTokens;
    const isMiss = promptTokens > 0 && missTokens >= MIN_MISS_TOKENS && missTokens >= MIN_MISS_SHARE * promptTokens;
    if (!isMiss) return notAMiss(s, gapMs);

    let reason: MissReason;
    if (!prev) reason = 'cold-start';
    else if (promptTokens < RESET_RATIO * prevPrompt) reason = 'context-reset';
    else if (!active.has(s.model) || (s.cacheRead + s.cacheWrite5m + s.cacheWrite1h === 0 && reportsWrites.has(s.model))) reason = 'caching-off';
    else if ((gapMs ?? 0) > ttlAfter(prev, opts.ttlMs)) reason = 'expired';
    else if (s.model !== prev.model) reason = 'model-switch';
    else reason = 'prefix-change';

    return {
      step: s, promptTokens, freshTokens, missTokens, isMiss, reason,
      avoidable: !UNAVOIDABLE.has(reason), gapMs,
      extraCostUsd: extraCost(s, missTokens, opts.rate(s.model, s.tier)),
    };
  });
}

/** Groups by conversation (agent, session, isSubagent), orders each by time, classifies, and returns one flat list. */
export function classifyConversations(steps: readonly CacheStep[], opts: ClassifyOpts): ClassifiedStep[] {
  const groups = new Map<string, CacheStep[]>();
  for (const s of steps) {
    const k = `${s.agent}\u001f${s.sessionId}\u001f${s.isSubagent ? 1 : 0}`;
    const list = groups.get(k);
    if (list) list.push(s);
    else groups.set(k, [s]);
  }
  const out: ClassifiedStep[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
    out.push(...classifySteps(list, opts));
  }
  return out;
}
