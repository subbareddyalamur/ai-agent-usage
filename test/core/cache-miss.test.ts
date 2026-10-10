import { describe, expect, test } from 'bun:test';
import {
  classifyConversations, classifySteps, deriveTtl, extraCost, promptOf, TTL_1H_MS, TTL_5M_MS,
  type CacheStep, type ClassifyOpts,
} from '../../src/core/cache-miss';
import { DEFAULT_RATES } from '../insights/seed';

const T = Date.UTC(2026, 2, 2, 9);
const SEC = 1000;
const MIN = 60 * SEC;

function step(i: number, over: Partial<CacheStep> = {}): CacheStep {
  return {
    id: `s${i}`, agent: 'a', sessionId: 'x', ts: T + i * 30 * SEC, model: 'm', tier: 'regional',
    input: 20, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, isSubagent: false, ...over,
  };
}

/** A healthy cached conversation: each step reads the previous prompt and writes only the growth. */
function healthy(contexts: readonly number[], over: Partial<CacheStep> = {}): CacheStep[] {
  return contexts.map((ctx, i) => {
    const prev = i === 0 ? 0 : (contexts[i - 1] as number);
    return step(i, { input: 20, cacheRead: Math.min(prev, ctx), cacheWrite5m: Math.max(0, ctx - prev), ...over });
  });
}

const opts = (over: Partial<ClassifyOpts> = {}): ClassifyOpts => ({
  ttlMs: TTL_5M_MS, rate: () => DEFAULT_RATES, supportsCache: () => true, ...over,
});

const reasons = (steps: readonly CacheStep[], o = opts()): Array<string | null> =>
  classifySteps(steps, o).map((c) => c.reason);

describe('classifySteps: healthy conversations', () => {
  test('ordinary growth with cache reads is never a miss', () => {
    const out = classifySteps(healthy([30_000, 32_000, 35_000, 36_000, 50_000]), opts());
    expect(out.slice(1).every((c) => !c.isMiss && c.reason === null && c.missTokens === 0)).toBe(true);
  });

  test('a tiny first prompt is not a miss at all', () => {
    expect(reasons([step(0, { input: 500 })])).toEqual([null]);
  });

  test('misses under the share threshold stay silent (8% of the prompt)', () => {
    const steps = [
      step(0, { input: 20, cacheRead: 0, cacheWrite5m: 100_000 }),
      // P=100k, read 92k; growth 2k => miss = 8k - 2k = 6k < 10%
      step(1, { input: 20, cacheRead: 92_000, cacheWrite5m: 7_980 }),
    ];
    expect(classifySteps(steps, opts())[1]?.isMiss).toBe(false);
  });
});

describe('classifySteps: reasons', () => {
  test('cold-start: first call writes the whole prompt, unavoidable', () => {
    const [c] = classifySteps([step(0, { input: 20, cacheWrite5m: 10_000 })], opts());
    expect(c?.reason).toBe('cold-start');
    expect(c?.avoidable).toBe(false);
    expect(c?.missTokens).toBe(10_020);
    expect(c?.gapMs).toBeNull();
  });

  test('cold-start only counts what was not already readable (shared system prompt cache)', () => {
    const [c] = classifySteps([step(0, { input: 20, cacheRead: 8_000, cacheWrite5m: 3_000 })], opts());
    expect(c?.reason).toBe('cold-start');
    expect(c?.missTokens).toBe(3_020);
  });

  test('expired: pause longer than 5 minutes then a full rewrite', () => {
    const steps = healthy([30_000, 31_000]);
    steps[1] = step(1, { ts: T + 10 * MIN, input: 20, cacheRead: 0, cacheWrite5m: 31_000 });
    const c = classifySteps(steps, opts())[1];
    expect(c?.reason).toBe('expired');
    expect(c?.avoidable).toBe(true);
    expect(c?.gapMs).toBe(10 * MIN);
    // prev prompt 30_020, this one 31_020 all fresh: miss = 31_020 - growth(1_000) = 30_020 re-written instead of read
    expect(c?.missTokens).toBe(30_020);
    const blended = (20 * 3 + 31_000 * 3.75) / 31_020;
    expect(c?.extraCostUsd).toBeCloseTo((30_020 * (blended - 0.3)) / 1e6, 10);
  });

  test('1h cache: a 30 minute pause is fine, a 90 minute pause expires', () => {
    const base = [step(0, { input: 20, cacheWrite1h: 30_000 })];
    const at = (gap: number): CacheStep => step(1, { ts: T + gap, input: 20, cacheRead: 0, cacheWrite1h: 30_500 });
    expect(reasons([...base, at(30 * MIN)])[1]).toBe('prefix-change');
    expect(reasons([...base, at(90 * MIN)])[1]).toBe('expired');
  });

  test('a previous 5m write overrides a 1h global lifetime', () => {
    const steps = [
      step(0, { input: 20, cacheWrite5m: 30_000 }),
      step(1, { ts: T + 10 * MIN, input: 20, cacheRead: 0, cacheWrite5m: 30_500 }),
    ];
    expect(reasons(steps, opts({ ttlMs: TTL_1H_MS }))[1]).toBe('expired');
  });

  test('without a previous write the global lifetime decides', () => {
    const steps = [
      step(0, { input: 30_000 }), // no cache activity on step 0
      step(1, { ts: T + 10 * MIN, input: 20, cacheRead: 0, cacheWrite5m: 30_500 }),
    ];
    expect(reasons(steps, opts({ ttlMs: TTL_1H_MS }))[1]).toBe('prefix-change');
    expect(reasons(steps, opts({ ttlMs: TTL_5M_MS }))[1]).toBe('expired');
  });

  test('model-switch: a different model re-reads at full price without a pause', () => {
    const steps = [
      ...healthy([30_000]),
      step(1, { model: 'other', input: 20, cacheRead: 0, cacheWrite5m: 31_000 }),
    ];
    expect(reasons(steps)[1]).toBe('model-switch');
  });

  test('context-reset: prompt shrinks to 40% (compaction), unavoidable', () => {
    const steps = [
      ...healthy([100_000]),
      step(1, { input: 20, cacheRead: 0, cacheWrite5m: 40_000 }),
    ];
    const c = classifySteps(steps, opts())[1];
    expect(c?.reason).toBe('context-reset');
    expect(c?.avoidable).toBe(false);
  });

  test('a mild shrink (to 80%) is not a reset', () => {
    const steps = [
      ...healthy([100_000]),
      step(1, { input: 20, cacheRead: 20_000, cacheWrite5m: 60_000 }),
    ];
    expect(reasons(steps)[1]).toBe('prefix-change');
  });

  test('prefix-change: same model, no pause, most of the prompt re-written', () => {
    const steps = [
      ...healthy([100_000]),
      step(1, { input: 20, cacheRead: 25_000, cacheWrite5m: 76_000 }),
    ];
    const c = classifySteps(steps, opts())[1];
    expect(c?.reason).toBe('prefix-change');
    expect(c?.avoidable).toBe(true);
    expect(c?.missTokens).toBe(75_020);
  });

  test('caching-off: a conversation that never touched the cache (68 steps, 30k to 180k)', () => {
    const contexts = Array.from({ length: 68 }, (_, i) => 30_000 + Math.round((150_000 * i) / 67));
    const steps = contexts.map((ctx, i) => step(i, { input: ctx }));
    const out = classifySteps(steps, opts());
    expect(out[0]?.reason).toBe('cold-start');
    expect(out.slice(1).every((c) => c.reason === 'caching-off' && c.avoidable)).toBe(true);
    const total = out.reduce((a, c) => a + (c.avoidable ? (c.extraCostUsd ?? 0) : 0), 0);
    // every step but the first could have read the previous prompt at 0.3 instead of 3 $/M
    const expected = contexts.slice(0, -1).reduce((a, p) => a + (p * (3 - 0.3)) / 1e6, 0);
    expect(total).toBeCloseTo(expected, 6);
    expect(total).toBeGreaterThan(15);
  });

  test('caching-off beats expired when a single call sent no cache request', () => {
    const steps = [
      ...healthy([30_000, 31_000]),
      // 10 minute pause, but this call neither read nor wrote the cache although writes are reported elsewhere
      step(2, { ts: T + 10 * MIN, input: 32_000 }),
    ];
    expect(reasons(steps)[2]).toBe('caching-off');
  });

  test('automatic caching (reads reported, never writes) is judged by gap, not caching-off', () => {
    const steps = [
      step(0, { input: 30_000 }),
      step(1, { input: 1_000, cacheRead: 30_000 }),
      step(2, { ts: T + 10 * MIN, input: 32_000 }),
    ];
    expect(reasons(steps)[2]).toBe('expired');
  });
});

describe('classifySteps: edge cases', () => {
  test('models that cannot cache are never misses', () => {
    const steps = [step(0, { input: 50_000 }), step(1, { input: 80_000 })];
    const out = classifySteps(steps, opts({ supportsCache: () => false }));
    expect(out.every((c) => !c.isMiss && c.reason === null)).toBe(true);
    expect(out[1]?.freshTokens).toBe(80_000);
  });

  test('unpriced model: still a miss, cost unknown', () => {
    const steps = [step(0, { input: 50_000 }), step(1, { input: 80_000 })];
    const out = classifySteps(steps, opts({ rate: () => null }));
    expect(out[1]?.reason).toBe('caching-off');
    expect(out[1]?.extraCostUsd).toBeNull();
  });

  test('empty input and zero-token steps', () => {
    expect(classifySteps([], opts())).toEqual([]);
    expect(classifySteps([step(0, { input: 0 })], opts())[0]?.isMiss).toBe(false);
  });
});

describe('classifyConversations', () => {
  test('main thread and subagent chains are separate conversations, ordered by time', () => {
    const main = healthy([40_000, 41_000, 42_000]);
    const sub = healthy([6_000, 7_000], { isSubagent: true, sessionId: 'x' }).map((s, i) => ({ ...s, id: `sub${i}`, ts: T + 15 * SEC + i * 30 * SEC }));
    const shuffled = [main[2] as CacheStep, sub[1] as CacheStep, main[0] as CacheStep, sub[0] as CacheStep, main[1] as CacheStep];
    const out = classifyConversations(shuffled, opts());
    const bySub = (v: boolean) => out.filter((c) => c.step.isSubagent === v);
    // the main thread is healthy, the subagent only has its own cold start
    expect(bySub(false).filter((c) => c.reason !== null && c.reason !== 'cold-start')).toEqual([]);
    expect(bySub(true).map((c) => c.reason)).toEqual(['cold-start', null]);
    expect(bySub(false).map((c) => c.step.id)).toEqual(['s0', 's1', 's2']);
  });

  test('different sessions never see each other as predecessors', () => {
    const a = healthy([30_000, 31_000]);
    const b = healthy([30_000, 31_000], { sessionId: 'y' }).map((s, i) => ({ ...s, id: `y${i}` }));
    const out = classifyConversations([...a, ...b], opts());
    expect(out.filter((c) => c.reason === 'cold-start')).toHaveLength(2);
  });
});

describe('deriveTtl and extraCost', () => {
  test('ttl follows what is actually written', () => {
    expect(deriveTtl([])).toEqual({ ttlMs: TTL_5M_MS, source: '5m' });
    expect(deriveTtl([{ cacheWrite5m: 10, cacheWrite1h: 0 }])).toEqual({ ttlMs: TTL_5M_MS, source: '5m' });
    expect(deriveTtl([{ cacheWrite5m: 10, cacheWrite1h: 100 }])).toEqual({ ttlMs: TTL_1H_MS, source: '1h' });
    expect(deriveTtl([{ cacheWrite5m: 100, cacheWrite1h: 10 }])).toEqual({ ttlMs: TTL_5M_MS, source: 'mixed' });
  });

  test('extraCost handles no fresh tokens, no misses and missing rates', () => {
    const s = step(0, { input: 0, cacheRead: 1_000 });
    expect(extraCost(s, 500, DEFAULT_RATES)).toBe(0);
    expect(extraCost(step(0), 0, DEFAULT_RATES)).toBe(0);
    expect(extraCost(step(0), 10, null)).toBeNull();
    expect(promptOf(step(0, { input: 1, cacheRead: 2, cacheWrite5m: 3, cacheWrite1h: 4 }))).toBe(10);
  });
});
