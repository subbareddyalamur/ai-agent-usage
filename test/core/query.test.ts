import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { filterOptions, models, series, sessionDetail, sessions, status, summary, tools, toolGroup } from '../../src/core/query';
import { bucketLabel, localDate, zonedMidnight } from '../../src/core/query-time';
import { makeEvent } from '../helpers';
import { chain, DEFAULT_RATES, HOUR, seedDb, T0 } from '../insights/seed';

async function fixture(): Promise<Database> {
  const events = [
    ...chain({
      agent: 'alpha', sessionId: 's1', model: 'claude-sonnet-5', contexts: [1000, 1500, 2200], cached: true,
      tools: [
        { step: 0, name: 'bash', resultBytes: 400 },
        { step: 1, name: 'mcp__github__search', resultBytes: 9000 },
        { step: 2, name: 'bash', resultBytes: 100 },
      ],
    }),
    ...chain({ agent: 'alpha', sessionId: 's1', model: 'claude-haiku-4', contexts: [500, 600], isSubagent: true, start: T0 + 9 * HOUR + 5000 }),
    ...chain({ agent: 'alpha', sessionId: 's2', model: 'claude-sonnet-5', contexts: [4000, 4100, 4200, 4300], start: T0 + 2 * 24 * HOUR }),
    ...chain({ agent: 'beta', sessionId: 'x1', model: 'Mystery-Model', contexts: [100, 100], start: T0 + 24 * HOUR, project: undefined } as never),
    makeEvent({
      id: 'legacy1', agent: 'gamma', sessionId: 'old', modelRaw: 'claude-sonnet-5', kind: 'session_total',
      ts: T0 - 5 * 24 * HOUR, inputTokens: 1_000_000, outputTokens: 10_000,
    }),
  ];
  return seedDb(events, {
    rates: { 'claude-sonnet-5': DEFAULT_RATES, 'claude-haiku-4': { ...DEFAULT_RATES, input: 1, output: 5 } },
    titles: { 'alpha/s1': 'Fix the thing' },
    unpriced: ['Mystery-Model'],
  });
}

describe('summary', () => {
  test('totals, unpriced accounting and cache hit ratio', async () => {
    const db = await fixture();
    const s = summary(db, {});
    expect(s.totals.events).toBe(3 + 2 + 4 + 2 + 1);
    expect(s.totals.sessions).toBe(4);
    expect(s.totals.unpricedEvents).toBe(2);
    expect(s.totals.unpricedTokens).toBe(2 * (100 + 100));
    expect(s.totals.costUsd).toBeGreaterThan(0);
    const alpha = s.byAgent.find((a) => a.agent === 'alpha');
    expect(alpha?.cacheReadTokens).toBe(1000 + 1500);
    expect(alpha?.cacheHitRatio).toBeCloseTo(
      alpha!.cacheReadTokens / (alpha!.inputTokens + alpha!.cacheReadTokens + alpha!.cacheWriteTokens), 10);
    expect(s.byModel.find((m) => m.model === 'mystery-model')?.priced).toBe(false);
    expect(s.byModel[0]?.costUsd).toBeGreaterThanOrEqual(s.byModel[1]?.costUsd ?? 0);
  });

  test('empty database yields zero totals and a null hit ratio', async () => {
    const db = await seedDb([]);
    const s = summary(db, {});
    expect(s.totals.events).toBe(0);
    expect(s.totals.cacheHitRatio).toBeNull();
    expect(s.byAgent).toEqual([]);
  });

  test('filters: agent, model, subagents, time range, project', async () => {
    const db = await fixture();
    expect(summary(db, { agents: ['beta'] }).totals.events).toBe(2);
    expect(summary(db, { models: ['claude-haiku-4'] }).totals.events).toBe(2);
    expect(summary(db, { agents: ['alpha'], includeSubagents: false }).totals.events).toBe(7);
    expect(summary(db, { from: T0, to: T0 + 12 * HOUR }).totals.events).toBe(5);
    expect(summary(db, { from: T0 + 10 * 24 * HOUR }).totals.events).toBe(0);
    expect(summary(db, { agents: [] }).totals.events).toBe(12);
    expect(summary(db, { projects: ['nope'] }).totals.events).toBe(0);
  });

  test('values are bound, not interpolated (quote injection is harmless)', async () => {
    const db = await fixture();
    expect(summary(db, { agents: ["x' OR '1'='1"] }).totals.events).toBe(0);
  });
});

describe('series', () => {
  test('day buckets split by model and by agent', async () => {
    const db = await fixture();
    const byModel = series(db, { tz: 'UTC' }, 'day', 'model');
    const day1 = byModel.filter((p) => p.bucket === '2026-03-02');
    expect(day1.map((p) => p.key).sort()).toEqual(['claude-haiku-4', 'claude-sonnet-5']);
    const byAgent = series(db, { tz: 'UTC' }, 'day', 'agent');
    expect(byAgent.map((p) => p.bucket)).toEqual([...byAgent.map((p) => p.bucket)].sort());
    expect(byAgent.some((p) => p.key === 'gamma' && p.bucket === '2026-02-25')).toBe(true);
  });

  test('week buckets start on Monday and months are YYYY-MM', async () => {
    const db = await fixture();
    const weeks = series(db, { tz: 'UTC' }, 'week', 'agent');
    expect(weeks.find((p) => p.key === 'alpha')?.bucket).toBe('2026-03-02');
    expect(weeks.find((p) => p.key === 'gamma')?.bucket).toBe('2026-02-23');
    const months = series(db, { tz: 'UTC' }, 'month', 'agent');
    expect(months.find((p) => p.key === 'gamma')?.bucket).toBe('2026-02');
    expect(months.find((p) => p.key === 'alpha')?.bucket).toBe('2026-03');
  });

  test('timezone shifts day boundaries, including DST and half-hour offsets', async () => {
    const mk = (id: string, iso: string) => makeEvent({ id, agent: 'tz', sessionId: id, ts: Date.parse(iso) });
    const db = await seedDb([
      mk('a', '2026-03-08T04:59:00Z'), // 23:59 EST on Mar 7
      mk('b', '2026-03-08T05:00:00Z'), // 00:00 EST on Mar 8
      mk('c', '2026-03-09T03:59:00Z'), // 23:59 EDT on Mar 8 (after DST start)
      mk('d', '2026-03-09T04:00:00Z'), // 00:00 EDT on Mar 9
      mk('e', '2026-03-02T18:29:00Z'), // 23:59 IST
      mk('f', '2026-03-02T18:30:00Z'), // 00:00 IST next day
    ]);
    const ny = series(db, { tz: 'America/New_York', agents: ['tz'], to: Date.parse('2026-03-09T23:00:00Z'), from: Date.parse('2026-03-08T00:00:00Z') }, 'day', 'agent');
    expect(Object.fromEntries(ny.map((p) => [p.bucket, p.inputTokens]))).toEqual({ '2026-03-07': 100, '2026-03-08': 200, '2026-03-09': 100 });
    const kolkata = series(db, { tz: 'Asia/Kolkata', from: Date.parse('2026-03-02T00:00:00Z'), to: Date.parse('2026-03-02T23:00:00Z') }, 'day', 'agent');
    expect(Object.fromEntries(kolkata.map((p) => [p.bucket, p.inputTokens]))).toEqual({ '2026-03-02': 100, '2026-03-03': 100 });
  });

  test('invalid tz falls back to the server zone instead of throwing', async () => {
    const db = await fixture();
    expect(series(db, { tz: 'Not/AZone' }, 'day', 'model').length).toBeGreaterThan(0);
  });
});

describe('time helpers', () => {
  test('localDate, zonedMidnight and bucketLabel agree', () => {
    expect(localDate(Date.parse('2026-03-08T05:00:00Z'), 'America/New_York')).toBe('2026-03-08');
    expect(zonedMidnight('2026-03-08', 'America/New_York')).toBe(Date.parse('2026-03-08T05:00:00Z'));
    expect(zonedMidnight('2026-03-09', 'America/New_York')).toBe(Date.parse('2026-03-09T04:00:00Z'));
    expect(bucketLabel('2026-03-08', 'week')).toBe('2026-03-02'); // Sunday belongs to the week of the previous Monday
    expect(bucketLabel('2026-03-08', 'month')).toBe('2026-03');
  });
});

describe('sessions', () => {
  test('lists with titles, models, subagent flag, peak context and totalOnly', async () => {
    const db = await fixture();
    const { rows, total } = sessions(db, {});
    expect(total).toBe(4);
    const s1 = rows.find((r) => r.sessionId === 's1')!;
    expect(s1.title).toBe('Fix the thing');
    expect(s1.models).toEqual(['claude-haiku-4', 'claude-sonnet-5']);
    expect(s1.hasSubagents).toBe(true);
    expect(s1.steps).toBe(5);
    expect(s1.peakContext).toBe(2220);
    expect(s1.totalOnly).toBe(false);
    expect(rows.find((r) => r.sessionId === 'old')?.totalOnly).toBe(true);
    expect(rows.find((r) => r.sessionId === 'old')?.peakContext).toBe(0);
  });

  test('sorting, direction and pagination', async () => {
    const db = await fixture();
    const byCost = sessions(db, {}, { sort: 'cost' }).rows.map((r) => r.totals.costUsd);
    expect(byCost).toEqual([...byCost].sort((a, b) => b - a));
    const byCtx = sessions(db, {}, { sort: 'context', dir: 'asc' }).rows.map((r) => r.peakContext);
    expect(byCtx).toEqual([...byCtx].sort((a, b) => a - b));
    const bySteps = sessions(db, {}, { sort: 'steps' }).rows.map((r) => r.steps);
    expect(bySteps[0]).toBe(5);
    const byTs = sessions(db, {}, { sort: 'ts' }).rows.map((r) => r.lastTs);
    expect(byTs).toEqual([...byTs].sort((a, b) => b - a));
    const hit = sessions(db, {}, { sort: 'cacheHit' }).rows;
    expect(hit[0]?.sessionId).toBe('s1');
    const page1 = sessions(db, {}, { sort: 'ts', limit: 2, offset: 0 });
    const page2 = sessions(db, {}, { sort: 'ts', limit: 2, offset: 2 });
    expect(page1.total).toBe(4);
    expect(page1.rows.length).toBe(2);
    expect(page2.rows[0]?.sessionId).not.toBe(page1.rows[0]?.sessionId);
    expect(sessions(db, {}, { sort: 'bogus' as never, limit: -5 }).rows.length).toBe(1);
  });

  test('sessionDetail returns ordered steps with tools, or null', async () => {
    const db = await fixture();
    const d = sessionDetail(db, 'alpha', 's1')!;
    expect(d.row.sessionId).toBe('s1');
    expect(d.steps.length).toBe(5);
    expect(d.steps.map((s) => s.ts)).toEqual([...d.steps.map((s) => s.ts)].sort((a, b) => a - b));
    const withTools = d.steps.filter((s) => s.tools.length > 0);
    expect(withTools.length).toBe(3);
    expect(withTools.flatMap((s) => s.tools).map((t) => t.resultBytes)).toEqual([400, 9000, 100]);
    expect(d.steps.every((s) => s.context === s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens)).toBe(true);
    expect(sessionDetail(db, 'alpha', 'missing')).toBeNull();
    expect(sessionDetail(db, 'gamma', 'old')!.steps).toEqual([]);
  });
});

describe('models', () => {
  test('rows carry priced flag, tier, agents, average context and live rates', async () => {
    const db = await fixture();
    const rows = models(db, {});
    const sonnet = rows.find((r) => r.model === 'claude-sonnet-5')!;
    expect(sonnet.priced).toBe(true);
    expect(sonnet.tier).toBe('regional');
    expect(sonnet.agents).toEqual(['alpha', 'gamma']);
    expect(sonnet.rates).toEqual(DEFAULT_RATES);
    expect(sonnet.avgContext).toBeGreaterThan(0);
    const mystery = rows.find((r) => r.model === 'mystery-model')!;
    expect(mystery.priced).toBe(false);
    expect(mystery.rates).toBeNull();
    expect(mystery.costUsd).toBe(0);
  });
});

describe('tools', () => {
  test('groups MCP tools by server and aggregates sizes', async () => {
    const db = await fixture();
    const rows = tools(db, {});
    const bash = rows.find((r) => r.name === 'bash')!;
    expect(bash).toMatchObject({ group: 'builtin', calls: 2, totalResultBytes: 500, maxResultBytes: 400, agents: ['alpha'] });
    expect(bash.avgResultBytes).toBe(250);
    expect(rows.find((r) => r.name === 'mcp__github__search')?.group).toBe('github');
    expect(rows[0]?.name).toBe('mcp__github__search');
    expect(tools(db, { agents: ['beta'] })).toEqual([]);
  });

  test('toolGroup parses server names', () => {
    expect(toolGroup('mcp__my__server__do_it')).toBe('my');
    expect(toolGroup('read')).toBe('builtin');
  });
});

describe('status and filterOptions', () => {
  test('adapter stats, unmapped models and retained history', async () => {
    const db = await fixture();
    db.query('DELETE FROM adapter_runs WHERE adapter = ?').run('gamma');
    const s = status(db, ':memory:');
    const alpha = s.adapters.find((a) => a.id === 'alpha')!;
    expect(alpha).toMatchObject({ installed: true, events: 9, detail: 'alpha data' });
    expect(alpha.firstTs).toBeLessThanOrEqual(alpha.lastTs as number);
    const gamma = s.adapters.find((a) => a.id === 'gamma')!;
    expect(gamma.installed).toBe(false);
    expect(gamma.events).toBe(1);
    expect(s.unmappedModels).toEqual([{ raw: 'Mystery-Model', events: 2, tokens: 400 }]);
    expect(s.pricing.snapshots).toBe(1);
    expect(s.pricing.modelsPriced).toBe(2);
    expect(s.db).toEqual({ path: ':memory:', sizeBytes: 0 });
  });

  test('filterOptions lists distinct values and the time range', async () => {
    const db = await fixture();
    const o = filterOptions(db);
    expect(o.agents).toEqual(['alpha', 'beta', 'gamma']);
    expect(o.models).toContain('claude-haiku-4');
    expect(o.minTs).toBe(T0 - 5 * 24 * HOUR);
    expect(o.maxTs).toBeGreaterThan(o.minTs as number);
    expect(filterOptions(await seedDb([]))).toMatchObject({ agents: [], minTs: null, maxTs: null });
  });
});
