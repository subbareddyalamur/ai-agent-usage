import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { Filters } from '../../src/core/api-types';
import compaction from '../../src/insights/compaction-cost';
import growth from '../../src/insights/context-growth';
import { createContext, type InsightRule } from '../../src/insights/kit';
import type { UsageEvent } from '../../src/core/types';
import { chain, HOUR, seedDb } from './seed';

const run = (rule: InsightRule, db: Database, f: Filters = {}) => rule.run(createContext(db, f));

/** 25 sessions of 4 gently growing steps: the user's normal. */
function normal(): UsageEvent[] {
  return Array.from({ length: 25 }, (_, i) =>
    chain({ sessionId: `n${i}`, contexts: [8000, 8400, 8800, 9200], start: 1_700_000_000_000 + i * HOUR }),
  ).flat();
}

const ramp = (from: number, to: number, n: number): number[] =>
  Array.from({ length: n }, (_, i) => Math.round(from + ((to - from) * i) / (n - 1)));

describe('context-growth', () => {
  test('flags a session that ends far above the user p90 and was still growing', async () => {
    const db = await seedDb([...normal(), ...chain({ sessionId: 'huge', contexts: ramp(10000, 90000, 12) })]);
    const [f] = run(growth, db);
    expect(f?.id).toBe('context-growth');
    expect(f?.concept).toBe('context');
    expect(f?.evidence[0]?.sessionId).toBe('huge');
    expect(f?.estSavingsUsd).toBeGreaterThan(0);
    expect(f?.detail).toContain('90th percentile');
  });

  test('is silent for normal sessions, big-but-shrinking sessions, short ones and thin history', async () => {
    expect(run(growth, await seedDb(normal()))).toEqual([]);
    expect(run(growth, await seedDb([...normal(), ...chain({ sessionId: 's', contexts: ramp(90000, 20000, 12) })]))).toEqual([]);
    expect(run(growth, await seedDb([...normal(), ...chain({ sessionId: 's', contexts: [90000, 95000, 99000] })]))).toEqual([]);
    expect(run(growth, await seedDb(chain({ sessionId: 's', contexts: ramp(10000, 90000, 12) })))).toEqual([]);
  });

  test('ignores subagent chains', async () => {
    const db = await seedDb([...normal(), ...chain({ sessionId: 'sub', isSubagent: true, contexts: ramp(10000, 90000, 12) })]);
    expect(run(growth, db)).toEqual([]);
  });
});

describe('compaction-cost', () => {
  const withReset = (extra: Partial<Parameters<typeof chain>[0]> = {}): UsageEvent[] =>
    chain({ sessionId: 'reset', contexts: [30000, 31000, 32000, 5000, 6000], cached: true, ...extra });

  test('finds a sharp context drop and sums the cost of the step after it', async () => {
    const db = await seedDb([...normal(), ...withReset()]);
    const [f] = run(compaction, db);
    expect(f?.id).toBe('compaction-cost');
    expect(f?.concept).toBe('compaction');
    expect(f?.title).toContain('1 context reset');
    expect(f?.evidence[0]?.sessionId).toBe('reset');
    expect(f?.detail).toContain('at least 50%');
  });

  test('is silent without a drop, for a gentle decrease, and for subagent chains', async () => {
    expect(run(compaction, await seedDb(normal()))).toEqual([]);
    const gentle = await seedDb([...normal(), ...chain({ sessionId: 'g', contexts: [30000, 29000, 28000, 27000], cached: true })]);
    expect(run(compaction, gentle)).toEqual([]);
    const sub = await seedDb([...normal(), ...withReset({ isSubagent: true })]);
    expect(run(compaction, sub)).toEqual([]);
  });

  test('ignores drops from tiny prompts and thin history', async () => {
    const tiny = await seedDb([...normal(), ...chain({ sessionId: 't', contexts: [900, 950, 100, 120] })]);
    expect(run(compaction, tiny)).toEqual([]);
    expect(run(compaction, await seedDb(withReset()))).toEqual([]);
  });

  test('is limited to the filter window', async () => {
    const db = await seedDb([...normal(), ...withReset({ agent: 'other' })]);
    expect(run(compaction, db, { agents: ['test'] })).toEqual([]);
    expect(run(compaction, db, { agents: ['other'] }).length).toBe(1);
  });
});
