import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { CacheReport, MissReason } from '../../src/core/api-types';
import type { CacheStep } from '../../src/core/cache-miss';
import { cacheSupport, rateMemo } from '../../src/core/query-cache';
import { cacheReport, sessionDetail } from '../../src/core/query';
import type { Rates } from '../../src/core/rates';
import type { UsageEvent } from '../../src/core/types';
import { makeEvent } from '../helpers';
import { chain, DEFAULT_RATES, HOUR, MIN, seedDb, T0 } from '../insights/seed';

const HAIKU: Rates = { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 };
const FREE: Rates = { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
const RATES = { 'claude-sonnet-5': DEFAULT_RATES, 'claude-haiku-4': HAIKU, 'free-model': FREE };

const reason = (r: CacheReport, k: MissReason) => r.reasons.find((x) => x.reason === k)!;
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

function ev(id: string, over: Partial<UsageEvent>): UsageEvent {
  return makeEvent({ id, inputTokens: 20, outputTokens: 100, agent: 'test', ...over });
}

const OFF_CTX = Array.from({ length: 68 }, (_, i) => 30_000 + i * 2_000);

async function fixture(): Promise<Database> {
  const day1 = T0 + 9 * HOUR;
  const day2 = T0 + 33 * HOUR;
  const events: UsageEvent[] = [
    // healthy cached session with a healthy subagent
    ...chain({ sessionId: 'ok', contexts: [30_000, 31_000, 32_000, 33_000, 34_000], cached: true, start: day1 }),
    ...chain({ sessionId: 'ok', contexts: [10_000, 11_000, 12_000], cached: true, isSubagent: true, model: 'claude-haiku-4', start: day1 + 5_000 }),
    // the motivating case: 68 steps, no cache at all
    ...chain({ sessionId: 'off', contexts: OFF_CTX, cached: false, start: day2 }),
    // 10 minute pause then a full rewrite
    ...chain({ sessionId: 'exp', contexts: [30_000, 31_000, 32_000], cached: true, start: day1 + 2 * HOUR }),
    ev('test:exp:3', { sessionId: 'exp', ts: day1 + 2 * HOUR + 60_000 + 10 * MIN, cacheWrite5mTokens: 33_000 }),
    // model switch without a pause
    ...chain({ sessionId: 'sw', contexts: [30_000, 31_000], cached: true, start: day1 + 4 * HOUR }),
    ev('test:sw:2', { sessionId: 'sw', ts: day1 + 4 * HOUR + 60_000, modelRaw: 'claude-haiku-4', cacheWrite5mTokens: 32_000 }),
    // a free model that never caches: must not be judged
    ...chain({ sessionId: 'free', contexts: [20_000, 30_000, 40_000], model: 'free-model', start: day1 + 6 * HOUR }),
    // unpriced model with cache activity: a miss with unknown cost
    ev('beta:mys:0', { agent: 'beta', sessionId: 'mys', modelRaw: 'Mystery-Model', ts: day1 + 7 * HOUR, cacheWrite5mTokens: 30_000 }),
    ev('beta:mys:1', { agent: 'beta', sessionId: 'mys', modelRaw: 'Mystery-Model', ts: day1 + 7 * HOUR + 30_000, cacheReadTokens: 30_000, cacheWrite5mTokens: 1_000 }),
    ev('beta:mys:2', { agent: 'beta', sessionId: 'mys', modelRaw: 'Mystery-Model', ts: day1 + 7 * HOUR + 30_000 + 10 * MIN, cacheWrite5mTokens: 32_000 }),
    // a session_total stand-in must be ignored by the classifier
    makeEvent({ id: 'legacy', agent: 'gamma', sessionId: 'old', modelRaw: 'claude-sonnet-5', kind: 'session_total', ts: T0, inputTokens: 5_000_000 }),
  ];
  return seedDb(events, { rates: RATES, unpriced: ['Mystery-Model'], titles: { 'test/off': 'Refactor billing', 'test/exp': 'Pause' } });
}

describe('cacheReport', () => {
  test('all six reasons are always present and every miss is classified', async () => {
    const r = cacheReport(await fixture(), { tz: 'UTC' });
    expect(r.reasons.map((x) => x.reason)).toEqual(['cold-start', 'context-reset', 'caching-off', 'expired', 'model-switch', 'prefix-change']);
    expect(reason(r, 'caching-off').steps).toBe(67);
    expect(reason(r, 'expired').steps).toBe(2); // exp + mystery
    expect(reason(r, 'model-switch').steps).toBe(1);
    expect(reason(r, 'prefix-change').steps).toBe(0);
    expect(reason(r, 'cold-start').avoidable).toBe(false);
    expect(reason(r, 'expired').avoidable).toBe(true);
  });

  test('the 68-step uncached session costs what reading the previous prompt would have saved', async () => {
    const r = cacheReport(await fixture(), { tz: 'UTC' });
    const expected = OFF_CTX.slice(0, -1).reduce((a, p) => a + (p * (3 - 0.3)) / 1e6, 0);
    near(reason(r, 'caching-off').extraCostUsd, expected);
    expect(r.sessions[0]).toMatchObject({ agent: 'test', sessionId: 'off', title: 'Refactor billing', dominantReason: 'caching-off', missSteps: 67, steps: 68 });
    expect(r.sessions[0]?.hitRatio).toBe(0);
  });

  test('expired and model-switch costs use the right rates', async () => {
    const r = cacheReport(await fixture(), { tz: 'UTC' });
    // exp: prev prompt 32_020, new 33_020 all written => miss 32_020 at blended write rate vs read
    const blended = (20 * 3 + 33_000 * 3.75) / 33_020;
    const exp = r.recent.find((m) => m.sessionId === 'exp')!;
    expect(exp.reason).toBe('expired');
    near(exp.extraCostUsd!, (32_020 * (blended - 0.3)) / 1e6);
    expect(exp.gapMs).toBe(10 * MIN);
    expect(exp.title).toBe('Pause');
    const sw = r.recent.find((m) => m.sessionId === 'sw')!;
    expect(sw.reason).toBe('model-switch');
    const b2 = (20 * 1 + 32_000 * 1.25) / 32_020;
    near(sw.extraCostUsd!, (31_020 * (b2 - 0.1)) / 1e6);
  });

  test('free and local models are not judged; unpriced ones are misses without a cost', async () => {
    const r = cacheReport(await fixture(), { tz: 'UTC' });
    const free = r.models.find((m) => m.model === 'free-model')!;
    expect(free).toMatchObject({ steps: 3, missTokens: 0, extraCostUsd: 0, cacheSeen: false, hitRatio: null });
    const mys = r.recent.find((m) => m.sessionId === 'mys')!;
    expect(mys.reason).toBe('expired');
    expect(mys.extraCostUsd).toBeNull();
    // the unpriced miss is counted in the reason but adds nothing to the dollars
    near(reason(r, 'expired').extraCostUsd, r.recent.find((m) => m.sessionId === 'exp')!.extraCostUsd!);
  });

  test('totals, models, sessions and days agree with each other', async () => {
    const r = cacheReport(await fixture(), { tz: 'UTC' });
    const avoidable = r.reasons.filter((x) => x.avoidable);
    near(r.totals.extraCostUsd, avoidable.reduce((a, x) => a + x.extraCostUsd, 0));
    expect(r.totals.avoidableMissTokens).toBe(avoidable.reduce((a, x) => a + x.missTokens, 0));
    near(r.models.reduce((a, m) => a + m.extraCostUsd, 0), r.totals.extraCostUsd);
    near(r.days.reduce((a, d) => a + d.extraCostUsd, 0), r.totals.extraCostUsd);
    near(r.sessions.reduce((a, s) => a + s.extraCostUsd, 0), r.totals.extraCostUsd);
    expect(r.days.reduce((a, d) => a + d.promptTokens, 0)).toBe(r.totals.promptTokens);
    expect(r.recent).toHaveLength(avoidable.reduce((a, x) => a + x.steps, 0));
    const unavoidable = r.reasons.filter((x) => !x.avoidable).reduce((a, x) => a + x.missTokens, 0);
    expect(r.totals.unavoidableTokens).toBe(unavoidable);
    expect(r.totals.hitRatio).toBeCloseTo(r.totals.cacheReadTokens / r.totals.promptTokens, 10);
    // free-model has no cache price, so it is outside the totals
    expect(r.totals.steps).toBe(r.models.filter((m) => m.model !== 'free-model').reduce((a, m) => a + m.steps, 0));
  });

  test('recent is newest first and avoidable only; sessions are ordered by extra cost', async () => {
    const r = cacheReport(await fixture(), { tz: 'UTC' });
    expect(r.recent.every((m) => m.avoidable)).toBe(true);
    expect(r.recent.map((m) => m.ts)).toEqual([...r.recent.map((m) => m.ts)].sort((a, b) => b - a));
    expect(r.sessions.map((s) => s.extraCostUsd)).toEqual([...r.sessions.map((s) => s.extraCostUsd)].sort((a, b) => b - a));
  });

  test('explanations carry live numbers', async () => {
    const r = cacheReport(await fixture(), { tz: 'UTC' });
    expect(reason(r, 'expired').explanation).toContain('5 minutes');
    expect(reason(r, 'expired').explanation).toContain('10%'); // 0.3 / 3
    expect(reason(r, 'caching-off').explanation).not.toContain('undefined');
    expect(r.totals.ttlSource).toBe('5m');
    expect(r.totals.ttlMs).toBe(5 * MIN);
  });

  test('1h cache writes switch the lifetime and the wording', async () => {
    const db = await seedDb(chain({ sessionId: 'h', contexts: [30_000, 31_000], cached: true, writeKind: '1h' }), { rates: RATES });
    const r = cacheReport(db, {});
    expect(r.totals.ttlSource).toBe('1h');
    expect(r.totals.ttlMs).toBe(60 * MIN);
    expect(reason(r, 'expired').explanation).toContain('1 hour');
  });
});

describe('cacheReport filters', () => {
  test('a time window keeps true predecessors: no fake cold start at the window edge', async () => {
    const db = await seedDb(chain({ sessionId: 'off', contexts: OFF_CTX, cached: false }), { rates: RATES });
    const from = T0 + 9 * HOUR + 10 * 30_000;
    const r = cacheReport(db, { from });
    expect(r.totals.steps).toBe(58);
    expect(reason(r, 'cold-start').steps).toBe(0);
    expect(reason(r, 'caching-off').steps).toBe(58);
  });

  test('model filter still sees the other model as predecessor', async () => {
    const r = cacheReport(await fixture(), { models: ['claude-haiku-4'], tz: 'UTC' });
    expect(reason(r, 'model-switch').steps).toBe(1);
    expect(r.models.map((m) => m.model)).toEqual(['claude-haiku-4']);
  });

  test('agent, project and subagent filters', async () => {
    const db = await fixture();
    expect(cacheReport(db, { agents: ['beta'] }).totals.steps).toBe(3);
    const all = cacheReport(db, {});
    const noSub = cacheReport(db, { includeSubagents: false });
    expect(all.totals.steps - noSub.totals.steps).toBe(3);
    expect(cacheReport(db, { projects: ['nope'] }).totals.steps).toBe(0);
  });

  test('day buckets follow the requested timezone', async () => {
    const start = Date.UTC(2026, 2, 2, 23, 50);
    const db = await seedDb(chain({ sessionId: 'd', contexts: [30_000, 31_000], cached: true, start, gapMs: 20 * MIN }), { rates: RATES });
    expect(cacheReport(db, { tz: 'UTC' }).days.map((d) => d.bucket)).toEqual(['2026-03-02', '2026-03-03']);
    expect(cacheReport(db, { tz: 'Asia/Tokyo' }).days.map((d) => d.bucket)).toEqual(['2026-03-03']);
  });
});

describe('cacheReport limits and edge cases', () => {
  test('empty database', async () => {
    const r = cacheReport(await seedDb([]), {});
    expect(r.totals).toMatchObject({ steps: 0, promptTokens: 0, hitRatio: null, extraCostUsd: 0, avoidableMissTokens: 0 });
    expect(r.reasons).toHaveLength(6);
    expect(r.models).toEqual([]);
    expect(r.sessions).toEqual([]);
    expect(r.days).toEqual([]);
    expect(r.recent).toEqual([]);
  });

  test('sessions are capped at 25 and recent at 100', async () => {
    const events = Array.from({ length: 6 }, (_, i) =>
      chain({ sessionId: `s${i}`, contexts: Array.from({ length: 30 }, (_, k) => 30_000 + k * 1_000), cached: false }),
    ).flat();
    const db = await seedDb(events, { rates: RATES });
    const r = cacheReport(db, {});
    expect(reason(r, 'caching-off').steps).toBe(6 * 29);
    expect(r.recent).toHaveLength(100);
    const many = Array.from({ length: 30 }, (_, i) =>
      chain({ sessionId: `m${i}`, contexts: [30_000, 31_000, 32_000], cached: false }),
    ).flat();
    expect(cacheReport(await seedDb(many, { rates: RATES }), {}).sessions).toHaveLength(25);
  });

  test('session_total rows are ignored', async () => {
    const db = await seedDb([makeEvent({ id: 't', kind: 'session_total', inputTokens: 9_000_000 })], { rates: RATES });
    expect(cacheReport(db, {}).totals.steps).toBe(0);
  });
});

describe('sessionDetail cache markers', () => {
  test('flags only the steps that missed, with their reason', async () => {
    const db = await fixture();
    const off = sessionDetail(db, 'test', 'off')!;
    expect(off.steps[0]?.cacheMiss?.reason).toBe('cold-start');
    expect(off.steps[1]?.cacheMiss).toMatchObject({ reason: 'caching-off', avoidable: true });
    expect(off.steps.filter((s) => s.cacheMiss).length).toBe(68);

    const ok = sessionDetail(db, 'test', 'ok')!;
    expect(ok.steps.filter((s) => s.cacheMiss && s.cacheMiss.avoidable)).toHaveLength(0);

    const exp = sessionDetail(db, 'test', 'exp')!;
    expect(exp.steps[3]?.cacheMiss?.reason).toBe('expired');
    expect(exp.steps[2]?.cacheMiss).toBeUndefined();
  });
});

describe('cacheSupport and rateMemo', () => {
  const step = (model: string, over: Partial<CacheStep> = {}): CacheStep => ({
    id: 'i', agent: 'a', sessionId: 's', ts: 0, model, tier: 'regional', input: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, isSubagent: false, ...over,
  });

  test('a cache-read price decides; without a price, observed caching decides', () => {
    const rate = (m: string): Rates | null => (m === 'priced' ? DEFAULT_RATES : m === 'nodisc' ? { ...DEFAULT_RATES, cacheRead: 0 } : null);
    const sup = cacheSupport([step('nodisc', { cacheRead: 5 }), step('mys', { cacheRead: 5 }), step('quiet')], rate);
    expect(sup('priced', 'regional')).toBe(true);
    expect(sup('nodisc', 'regional')).toBe(false); // priced, but a cache hit saves nothing
    expect(sup('mys', 'regional')).toBe(true); // unpriced, caching observed
    expect(sup('quiet', 'regional')).toBe(false);
  });

  test('rates are looked up once per model', async () => {
    const db = await seedDb(chain({ sessionId: 's', contexts: [1000] }), { rates: RATES });
    const rate = rateMemo(db);
    expect(rate('claude-sonnet-5', 'regional')).toEqual(DEFAULT_RATES);
    db.exec('DELETE FROM prices');
    expect(rate('claude-sonnet-5', 'regional')).toEqual(DEFAULT_RATES); // memoised
    expect(rate('nope', 'regional')).toBeNull();
  });
});
