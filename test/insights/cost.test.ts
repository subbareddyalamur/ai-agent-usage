import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { Filters } from '../../src/core/api-types';
import costly from '../../src/insights/costly-sessions';
import { createContext, type InsightRule } from '../../src/insights/kit';
import modelMix from '../../src/insights/model-mix';
import toolBloat from '../../src/insights/tool-output-bloat';
import type { UsageEvent } from '../../src/core/types';
import { chain, DEFAULT_RATES, HOUR, seedDb, T0 } from './seed';

const run = (rule: InsightRule, db: Database, f: Filters = {}) => rule.run(createContext(db, { tz: 'UTC', ...f }));
const DAY = 24 * HOUR;

/** One small session per day for `days` days: steady usage. */
function steady(days: number): UsageEvent[] {
  return Array.from({ length: days }, (_, d) =>
    chain({ sessionId: `d${d}`, contexts: [4000, 4200], start: T0 + d * DAY + 9 * HOUR }),
  ).flat();
}

describe('costly-sessions', () => {
  test('flags sessions in the top 5% of the user own history', async () => {
    const db = await seedDb([...steady(25), ...chain({ sessionId: 'big', contexts: Array(30).fill(150_000), start: T0 + 26 * DAY })]);
    const findings = run(costly, db);
    const f = findings.find((x) => x.id === 'costly-sessions');
    expect(f?.evidence[0]?.sessionId).toBe('big');
    expect(f?.title).toContain('95%');
  });

  test('is silent for uniform usage and for thin history', async () => {
    expect(run(costly, await seedDb(steady(25))).filter((f) => f.id === 'costly-sessions')).toEqual([]);
    expect(run(costly, await seedDb(steady(5)))).toEqual([]);
  });

  test('detects a spend spike against the rolling median and respects the window', async () => {
    const events = [...steady(25), ...chain({ sessionId: 'spike', contexts: Array(40).fill(120_000), start: T0 + 25 * DAY + 9 * HOUR })];
    const db = await seedDb(events);
    const spike = run(costly, db).find((x) => x.id === 'cost-spikes');
    expect(spike?.evidence[0]?.label).toContain('2026-03-27');
    expect(spike?.concept).toBe('tiers');
    const before = run(costly, db, { to: T0 + 20 * DAY }).find((x) => x.id === 'cost-spikes');
    expect(before).toBeUndefined();
    const after = run(costly, db, { from: T0 + 25 * DAY }).find((x) => x.id === 'cost-spikes');
    expect(after).toBeDefined();
  });

  test('idle days do not count as a zero baseline: sporadic but even usage is not a spike', async () => {
    const sporadic = Array.from({ length: 16 }, (_, i) =>
      chain({ sessionId: `p${i}`, contexts: [4000, 4200], start: T0 + i * 5 * DAY + 9 * HOUR }),
    ).flat();
    expect(run(costly, await seedDb(sporadic)).find((x) => x.id === 'cost-spikes')).toBeUndefined();
    const withSpike = [...sporadic, ...chain({ sessionId: 'boom', contexts: Array(40).fill(120_000), start: T0 + 80 * DAY + 9 * HOUR })];
    const hit = run(costly, await seedDb(withSpike)).find((x) => x.id === 'cost-spikes');
    expect(hit?.evidence[0]?.label).toContain('2026-05-21');
    expect(hit?.detail).toContain('active days');
  });

  test('steady spend produces no spike, and early days lack a baseline', async () => {
    expect(run(costly, await seedDb(steady(25))).find((x) => x.id === 'cost-spikes')).toBeUndefined();
    const early = await seedDb([...steady(3), ...chain({ sessionId: 'x', contexts: Array(40).fill(120_000), start: T0 + 3 * DAY })]);
    expect(run(costly, early).find((x) => x.id === 'cost-spikes')).toBeUndefined();
  });
});

describe('tool-output-bloat', () => {
  /** 5 steps per session; every step calls `bash` (small) and, in `heavy`, also mcp__big__dump with huge results. */
  function sessions(heavyBytes: number): UsageEvent[] {
    return Array.from({ length: 8 }, (_, i) =>
      chain({
        sessionId: `t${i}`, contexts: [5000, 6000, 7000, 8000, 9000],
        tools: [0, 1, 2, 3, 4].flatMap((step) => [
          { step, name: 'bash', resultBytes: 300 },
          ...(step < 2 ? [{ step, name: 'mcp__big__dump', resultBytes: heavyBytes }] : []),
        ]),
      }),
    ).flat();
  }

  test('flags tools whose average result is above the user p90 and reports carried tokens', async () => {
    const [f] = run(toolBloat, await seedDb(sessions(60_000)));
    expect(f?.id).toBe('tool-output-bloat');
    expect(f?.concept).toBe('tools');
    expect(f?.evidence[0]?.label).toContain('mcp__big__dump (big)');
    expect(f?.detail).toContain('prompt tokens');
  });

  test('is silent when all results are similar in size, or history is thin', async () => {
    expect(run(toolBloat, await seedDb(sessions(300)))).toEqual([]);
    const few = chain({ sessionId: 'f', contexts: [5000, 6000], tools: [{ step: 0, name: 'mcp__big__dump', resultBytes: 90_000 }] });
    expect(run(toolBloat, await seedDb(few))).toEqual([]);
  });

  test('ignores a large-result tool that carries a negligible share of prompt tokens', async () => {
    const tiny = chain({ sessionId: 'z', contexts: [30000, 30100, 30200], tools: [0, 1, 2].map((step) => ({ step, name: 'mcp__small__fetch', resultBytes: 2000 })) });
    expect(run(toolBloat, await seedDb([...sessions(300), ...tiny]))).toEqual([]);
  });

  test('ignores tools with too few measured calls', async () => {
    const rare = chain({ sessionId: 'r', contexts: [5000, 6000], tools: [{ step: 0, name: 'rare', resultBytes: 500_000 }, { step: 1, name: 'rare', resultBytes: 500_000 }] });
    expect(run(toolBloat, await seedDb([...sessions(300), ...rare]))).toEqual([]);
  });
});

describe('model-mix', () => {
  const OPUS = { input: 15, output: 75, cacheRead: 1.5, cacheWrite5m: 18.75, cacheWrite1h: 30 };
  const HAIKU = { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 };
  const rates = { 'claude-opus-5': OPUS, 'claude-haiku-4': HAIKU };

  /** 30 opus steps with outputs and prompts that rise together, so the bottom quarter is genuinely "light". */
  function opusSteps(): UsageEvent[] {
    return Array.from({ length: 30 }, (_, i) =>
      chain({ sessionId: `o${i}`, model: 'claude-opus-5', contexts: [1000 + i * 1500], output: 50 + i * 100, start: T0 + i * HOUR }),
    ).flat();
  }
  const haiku = (): UsageEvent[] => chain({ sessionId: 'h', model: 'claude-haiku-4', contexts: [2000, 2500], start: T0 });

  test('finds light steps on an expensive model when a cheaper same-vendor model is already in use', async () => {
    const [f] = run(modelMix, await seedDb([...opusSteps(), ...haiku()], { rates }));
    expect(f?.id).toBe('model-mix');
    expect(f?.concept).toBe('model-mix');
    expect(f?.estSavingsUsd).toBeGreaterThan(0);
    expect(f?.detail).toContain('claude-opus-5 to claude-haiku-4');
    expect(f?.detail).toContain('estimate');
  });

  test('is silent without a cheaper alternative, other vendors, or enough history', async () => {
    expect(run(modelMix, await seedDb(opusSteps(), { rates }))).toEqual([]);
    const other = chain({ sessionId: 'x', model: 'other-cheap', contexts: [2000], start: T0 });
    expect(run(modelMix, await seedDb([...opusSteps(), ...other], { rates: { ...rates, 'other-cheap': HAIKU } }))).toEqual([]);
    expect(run(modelMix, await seedDb([...opusSteps().slice(0, 5), ...haiku()], { rates }))).toEqual([]);
  });

  test('a newer, cheaper model of the same tier is not offered as a downgrade', async () => {
    const sonnet4 = Array.from({ length: 30 }, (_, i) =>
      chain({ sessionId: `s${i}`, model: 'claude-sonnet-4', contexts: [1000 + i * 1500], output: 50 + i * 100, start: T0 + i * HOUR }),
    ).flat();
    const sonnet5 = chain({ sessionId: 'new', model: 'claude-sonnet-5', contexts: [2000], start: T0 });
    const r = { 'claude-sonnet-4': OPUS, 'claude-sonnet-5': HAIKU };
    expect(run(modelMix, await seedDb([...sonnet4, ...sonnet5], { rates: r }))).toEqual([]);
    const withHaiku = await seedDb([...sonnet4, ...sonnet5, ...haiku()], { rates: { ...r, 'claude-haiku-4': HAIKU } });
    expect(run(modelMix, withHaiku)[0]?.detail).toContain('claude-sonnet-4 to claude-haiku-4');
  });

  test('a cheaper model without cache pricing is priced at its input rate for cached tokens', async () => {
    const noCache = { ...HAIKU, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
    const f = run(modelMix, await seedDb([...opusSteps(), ...haiku()], { rates: { ...rates, 'claude-haiku-4': noCache } }));
    expect(f[0]?.estSavingsUsd).toBeGreaterThan(0);
  });

  test('uses DEFAULT_RATES fixture sanity', () => {
    expect(DEFAULT_RATES.cacheRead).toBeLessThan(DEFAULT_RATES.input);
  });
});
