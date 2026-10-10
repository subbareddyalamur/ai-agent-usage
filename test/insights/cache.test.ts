import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { Filters } from '../../src/core/api-types';
import cacheExpiry from '../../src/insights/cache-expiry';
import cacheOff from '../../src/insights/cache-off';
import { createContext, type InsightRule } from '../../src/insights/kit';
import type { UsageEvent } from '../../src/core/types';
import { chain, DEFAULT_RATES, MIN, seedDb } from './seed';

const run = (rule: InsightRule, db: Database, f: Filters = {}) => rule.run(createContext(db, f));

/** 25 healthy cached sessions (4 steps each) so the user's own history can calibrate thresholds. */
function healthy(): UsageEvent[] {
  return Array.from({ length: 25 }, (_, i) =>
    chain({ sessionId: `ok${i}`, contexts: [6000, 6500, 7000, 7500], cached: true, start: 1_700_000_000_000 + i * 3_600_000 }),
  ).flat();
}

describe('cache-off', () => {
  test('fires for a large uncached session and estimates savings from live rates', async () => {
    const db = await seedDb([...healthy(), ...chain({ sessionId: 'bad', contexts: [20000, 20500, 21000, 21500] })]);
    const [f] = run(cacheOff, db);
    expect(f).toBeDefined();
    expect(f?.id).toBe('cache-off');
    expect(f?.concept).toBe('cache');
    expect(f?.evidence[0]?.sessionId).toBe('bad');
    expect(f?.estSavingsUsd).toBeGreaterThan(0.1);
    expect(f?.detail).toContain('10%'); // cache read = 0.3 / 3 of input price, from the price rows
    expect(['warn', 'high']).toContain(f?.severity as string);
  });

  test('is silent when everything is cached', async () => {
    expect(run(cacheOff, await seedDb(healthy()))).toEqual([]);
  });

  test('is silent for small uncached prompts, single steps and models without cache pricing', async () => {
    const small = await seedDb([...healthy(), ...chain({ sessionId: 's', contexts: [300, 320, 340] })]);
    expect(run(cacheOff, small)).toEqual([]);
    const single = await seedDb([...healthy(), ...chain({ sessionId: 's', contexts: [30000] })]);
    expect(run(cacheOff, single)).toEqual([]);
    const noCache = await seedDb(
      [...healthy(), ...chain({ sessionId: 'n', model: 'plain-model', contexts: [20000, 21000, 22000] })],
      { rates: { 'claude-sonnet-5': DEFAULT_RATES, 'plain-model': { input: 3, output: 15, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } } },
    );
    expect(run(cacheOff, noCache)).toEqual([]);
  });

  test('respects the filter window and an empty database', async () => {
    const db = await seedDb([...healthy(), ...chain({ agent: 'other', sessionId: 'bad', contexts: [20000, 20500, 21000] })]);
    expect(run(cacheOff, db, { agents: ['test'] })).toEqual([]);
    expect(run(cacheOff, db, { agents: ['other'] }).length).toBe(1);
    expect(run(cacheOff, await seedDb([]))).toEqual([]);
  });

  test('still fires when the loss is a tiny share of lifetime spend but worth more than a typical session', async () => {
    const whale = chain({ sessionId: 'whale', contexts: Array(300).fill(1_000_000), cached: true, start: 1_600_000_000_000 });
    const db = await seedDb([...healthy(), ...whale, ...chain({ sessionId: 'bad', contexts: [20000, 20500, 21000, 21500] })]);
    const f = run(cacheOff, db);
    expect(f[0]?.evidence[0]?.sessionId).toBe('bad');
    expect((f[0]?.estSavingsUsd ?? 0) / (db.query('SELECT SUM(cost_usd) c FROM events').get() as { c: number }).c).toBeLessThan(0.01);
  });

  test('with no cache history at all, only above-median prompts are judged', async () => {
    const events = [
      ...Array.from({ length: 25 }, (_, i) => chain({ sessionId: `u${i}`, contexts: [1000, 1100, 1200] })).flat(),
      ...chain({ sessionId: 'big', contexts: [50000, 51000, 52000] }),
    ];
    const f = run(cacheOff, await seedDb(events));
    expect(f[0]?.evidence.map((e) => e.sessionId)).toContain('big');
  });
});

describe('cache-expiry', () => {
  /** Normal cached chain, then a pause of `pauseMin` before step 3 which has to re-write the whole prompt. */
  function expired(pauseMin: number, kind: '5m' | '1h' = '5m', rewrite = true): UsageEvent[] {
    const c = chain({ sessionId: 'gap', contexts: [8000, 8500, 9000, 9500, 10000], cached: true, writeKind: kind });
    return c.map((e, i) => {
      if (i < 3) return e;
      const shifted = { ...e, ts: e.ts + pauseMin * MIN };
      if (i !== 3 || !rewrite) return shifted;
      const total = 9500;
      return {
        ...shifted, cacheReadTokens: 0,
        cacheWrite5mTokens: kind === '5m' ? total : 0, cacheWrite1hTokens: kind === '1h' ? total : 0,
      };
    });
  }

  test('fires when a pause longer than the 5 minute TTL forces a full re-write', async () => {
    const [f] = run(cacheExpiry, await seedDb([...healthy(), ...expired(10)]));
    expect(f?.id).toBe('cache-expiry');
    expect(f?.concept).toBe('ttl');
    expect(f?.evidence[0]?.sessionId).toBe('gap');
    expect(f?.estSavingsUsd).toBeGreaterThan(0);
    expect(f?.detail).toContain('5 minutes');
  });

  test('is silent when the pause is shorter than the TTL, or the cache was still read', async () => {
    expect(run(cacheExpiry, await seedDb([...healthy(), ...expired(3)]))).toEqual([]);
    expect(run(cacheExpiry, await seedDb([...healthy(), ...expired(10, '5m', false)]))).toEqual([]);
  });

  test('uses the 1 hour TTL when the session wrote 1 hour cache entries', async () => {
    expect(run(cacheExpiry, await seedDb([...healthy(), ...expired(20, '1h')]))).toEqual([]);
    expect(run(cacheExpiry, await seedDb([...healthy(), ...expired(70, '1h')])).length).toBe(1);
  });

  test('is silent without enough cache-write history', async () => {
    expect(run(cacheExpiry, await seedDb(expired(10)))).toEqual([]);
  });
});
