import { describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { App } from '../../src/app';
import { CliError, filtersFromArgs, parseCli, parseSince, parseUntil } from '../../src/cli/args';
import { WATCH_ERROR_REPEAT_MS, WATCH_INTERVAL_MS, watchTick, type Deps, type Output } from '../../src/cli/commands';
import { fmtCost, fmtDate, fmtHit, renderTable, truncate } from '../../src/cli/format';
import { HELP, main } from '../../src/cli/index';
import { chain, HOUR, ratesPricing, DEFAULT_RATES, seedDb, T0 } from '../insights/seed';

class Capture implements Output {
  out = '';
  err = '';
  write(t: string): void { this.out += t; }
  error(t: string): void { this.err += t; }
}

async function makeApp(over: Partial<App> = {}): Promise<{ app: App; closed: () => boolean }> {
  const events = [
    ...Array.from({ length: 25 }, (_, i) => chain({ sessionId: `ok${i}`, contexts: [6000, 6500, 7000, 7500], cached: true, start: T0 + i * HOUR })).flat(),
    ...chain({ agent: 'other', sessionId: 'bad', model: 'claude-opus-5', contexts: [20000, 20500, 21000, 21500], start: T0 + 30 * HOUR }),
    ...chain({ agent: 'other', sessionId: 'mystery', model: 'weird-model', contexts: [100, 100], start: T0 + 31 * HOUR }),
  ];
  const rates = { 'claude-sonnet-5': DEFAULT_RATES, 'claude-opus-5': DEFAULT_RATES };
  const db: Database = await seedDb(events, { rates, titles: { 'other/bad': 'The expensive one' }, unpriced: ['weird-model'] });
  let closed = false;
  const app: App = {
    db, dbPath: ':memory:', pricing: ratesPricing(rates), adapters: [], problems: [],
    ingestAll: async () => ({ reports: [{ id: 'test', installed: true, events: 3 }, { id: 'gone', installed: false, events: 0 }], repriced: 2, priceRefresh: { refreshed: true } }),
    close: () => { closed = true; },
    ...over,
  };
  return { app, closed: () => closed };
}

async function run(argv: string[], over: Partial<App> = {}, deps: Partial<Deps> = {}) {
  const io = new Capture();
  const { app, closed } = await makeApp(over);
  const code = await main(argv, { out: io, deps: { now: () => T0 + 40 * HOUR, ...deps }, makeApp: async () => app });
  return { code, out: io.out, err: io.err, closed: closed() };
}

describe('parseCli', () => {
  test('defaults and flags', () => {
    expect(parseCli(['report'])).toMatchObject({ command: 'report', by: 'day', agents: [], port: 4317, json: false, limit: 20 });
    const a = parseCli(['report', '--since', '7d', '--until', '2026-03-05', '--agent', 'a, b', '--model', 'm', '--by', 'model', '--no-subagents', '--json', '--tz', 'UTC', '--limit', '5']);
    expect(a).toMatchObject({ since: '7d', until: '2026-03-05', agents: ['a', 'b'], models: ['m'], by: 'model', noSubagents: true, json: true, tz: 'UTC', limit: 5 });
    expect(parseCli(['serve', '--port', '8080', '--no-ingest', '--watch'])).toMatchObject({ command: 'serve', port: 8080, noIngest: true, watch: true });
    expect(parseCli(['serve']).watch).toBe(true); // watching is the default
    expect(parseCli(['serve', '--no-watch']).watch).toBe(false);
    expect(parseCli(['serve', '--watch', '--no-watch']).watch).toBe(false);
    expect(parseCli(['prices', '--force']).force).toBe(true);
  });

  test('help forms', () => {
    expect(parseCli([]).command).toBe('help');
    expect(parseCli(['report', '--help']).command).toBe('help');
    expect(parseCli(['-h']).command).toBe('help');
  });

  test('rejects bad input with CliError', () => {
    for (const argv of [['nope'], ['report', '--by', 'year'], ['serve', '--port', 'abc'], ['serve', '--port', '70000'], ['report', '--limit', '0'], ['report', '--bogus'], ['report', 'extra']]) {
      expect(() => parseCli(argv)).toThrow(CliError);
    }
  });
});

describe('time arguments', () => {
  const now = Date.UTC(2026, 2, 10, 12);
  test('relative and absolute since/until', () => {
    expect(parseSince('36h', now, 'UTC')).toBe(now - 36 * HOUR);
    expect(parseSince('2w', now, 'UTC')).toBe(now - 14 * 24 * HOUR);
    expect(parseSince('2026-03-08', now, 'America/New_York')).toBe(Date.parse('2026-03-08T05:00:00Z'));
    expect(parseUntil('2026-03-08', now, 'America/New_York')).toBe(Date.parse('2026-03-09T04:00:00Z') - 1); // DST day is 23h
    expect(parseUntil('now', now, 'UTC')).toBe(now);
    expect(parseUntil('1d', now, 'UTC')).toBe(now - 24 * HOUR);
    expect(() => parseSince('yesterday', now, 'UTC')).toThrow(CliError);
    expect(() => parseUntil('soon', now, 'UTC')).toThrow(CliError);
  });

  test('filtersFromArgs builds filters and rejects inverted ranges', () => {
    const f = filtersFromArgs(parseCli(['report', '--since', '2026-03-01', '--until', '2026-03-02', '--agent', 'x', '--no-subagents', '--tz', 'UTC']), now);
    expect(f).toEqual({ from: Date.parse('2026-03-01T00:00:00Z'), to: Date.parse('2026-03-03T00:00:00Z') - 1, agents: ['x'], includeSubagents: false, tz: 'UTC' });
    expect(() => filtersFromArgs(parseCli(['report', '--since', '2026-03-05', '--until', '2026-03-01']), now)).toThrow(CliError);
    expect(filtersFromArgs(parseCli(['report']), now).from).toBeUndefined();
  });
});

describe('format helpers', () => {
  test('table alignment, truncation and small formatters', () => {
    expect(renderTable(['name', 'n'], [['a', '1'], ['longer', '22']], ['l', 'r'])).toBe('name     n\n------  --\na        1\nlonger  22');
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 4)).toBe('abc');
    expect(fmtCost(1.234)).toBe('~$1.23');
    expect(fmtHit(null)).toBe('-');
    expect(fmtHit(0.5)).toBe('50%');
    expect(fmtDate(null)).toBe('-');
    expect(fmtDate(Date.UTC(2026, 0, 2))).toBe('2026-01-02');
  });
});

describe('main', () => {
  test('help and argument errors', async () => {
    const h = await run(['--help']);
    expect(h.code).toBe(0);
    expect(h.out).toBe(HELP);
    const bad = await run(['report', '--by', 'year']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--by must be one of');
    const badSince = await run(['report', '--since', 'yesterday']);
    expect(badSince.code).toBe(2);
    expect(badSince.closed).toBe(true);
  });

  test('report by day, week, model, agent and session', async () => {
    const day = await run(['report', '--tz', 'UTC']);
    expect(day.code).toBe(0);
    expect(day.out).toContain('2026-03-02');
    expect(day.out).toContain('cache hit');
    expect(day.out).toMatch(/costs are estimates from AWS public list prices/);
    expect(day.out).toContain('unpriced: 2 events');
    expect((await run(['report', '--by', 'week', '--tz', 'UTC'])).out).toContain('2026-03-02');
    const model = await run(['report', '--by', 'model']);
    expect(model.out).toContain('claude-sonnet-5');
    expect(model.out).toContain('weird-model *');
    expect((await run(['report', '--by', 'agent'])).out).toContain('other');
    const session = await run(['report', '--by', 'session', '--limit', '2', '--tz', 'UTC']);
    expect(session.out).toContain('The expensive one');
    expect(session.out.split('\n').filter((l) => /^(test|other) /.test(l)).length).toBe(2);
    expect(day.closed).toBe(true);
  });

  test('report --json is valid JSON, filters apply, empty selection says so', async () => {
    const j = await run(['report', '--by', 'agent', '--json', '--agent', 'other']);
    const parsed = JSON.parse(j.out) as { by: string; rows: Array<{ agent: string }>; totals: { events: number } };
    expect(parsed.by).toBe('agent');
    expect(parsed.rows.map((r) => r.agent)).toEqual(['other']);
    expect(parsed.totals.events).toBe(6);
    const empty = await run(['report', '--agent', 'nobody']);
    expect(empty.out).toContain('No usage found');
    expect(JSON.parse((await run(['report', '--agent', 'nobody', '--json'])).out).rows).toEqual([]);
  });

  test('status text and json', async () => {
    const s = await run(['status']);
    expect(s.out).toContain('installed');
    expect(s.out).toContain('prices: snapshot');
    expect(s.out).toContain('unpriced models: weird-model');
    expect(JSON.parse((await run(['status', '--json'])).out).adapters.length).toBeGreaterThan(0);
    const withProblems = await run(['status'], { problems: ['x.ts: broken'] });
    expect(withProblems.out).toContain('adapter problems: x.ts: broken');
    const bare = await run(['status'], {});
    expect(bare.code).toBe(0);
  });

  test('insights prints findings with savings, or says there are none', async () => {
    const i = await run(['insights']);
    expect(i.out).toContain('[');
    expect(i.out).toMatch(/Prompt caching looks switched off/);
    expect(i.out).toContain('avoidable');
    const none = await run(['insights', '--agent', 'nobody']);
    expect(none.out).toContain('No findings');
    expect(JSON.parse((await run(['insights', '--json'])).out).findings.length).toBeGreaterThan(0);
  });

  test('ingest reports per agent, price state and repriced events; non-zero on adapter error', async () => {
    const ok = await run(['ingest']);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('test: 3 events');
    expect(ok.out).toContain('gone: not installed, skipped');
    expect(ok.out).toContain('prices: refreshed');
    expect(ok.out).toContain('2 previously unpriced');
    const failing = await run(['ingest'], {
      ingestAll: async () => ({ reports: [{ id: 'x', installed: true, events: 0, error: 'boom' }], repriced: 0, priceRefresh: { refreshed: false, error: 'offline' } }),
    });
    expect(failing.code).toBe(1);
    expect(failing.out).toContain('error: boom');
    expect(failing.out).toContain('refresh failed (offline)');
    expect(JSON.parse((await run(['ingest', '--json'])).out).repriced).toBe(2);
  });

  test('prices: up to date, refreshed, failed and --force', async () => {
    const calls: Array<{ force?: boolean } | undefined> = [];
    const pricing = (r: { refreshed: boolean; error?: string }) => ({ ...ratesPricing({}), async refreshIfStale(o?: { force?: boolean }) { calls.push(o); return r; } });
    expect((await run(['prices'], { pricing: pricing({ refreshed: false }) })).out).toContain('up to date');
    expect((await run(['prices', '--force'], { pricing: pricing({ refreshed: true }) })).out).toContain('prices refreshed');
    const failed = await run(['prices'], { pricing: pricing({ refreshed: false, error: 'dns' }) });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain('last snapshot kept');
    expect(calls.map((c) => c?.force)).toEqual([false, true, false]);
    expect(JSON.parse((await run(['prices', '--json'], { pricing: pricing({ refreshed: false }) })).out).refreshed).toBe(false);
  });

  test('serve: ingests, starts the server on the port, waits, then stops it', async () => {
    const started: number[] = [];
    let stopped = false;
    let ingests = 0;
    const r = await run(['serve', '--port', '9999'], { ingestAll: async () => { ingests++; return { reports: [{ id: 'a', installed: true, events: 7 }], repriced: 0, priceRefresh: { refreshed: false } }; } }, {
      loadServer: async () => ({ startServer: (_app, o) => { started.push(o.port); return { url: `http://127.0.0.1:${o.port}`, stop: () => { stopped = true; } }; } }),
      waitForExit: async () => {},
    });
    expect(r.code).toBe(0);
    expect(started).toEqual([9999]);
    expect(stopped).toBe(true);
    expect(ingests).toBe(1);
    expect(r.out).toContain('ingested 7 events from 1 agent(s)');
    expect(r.out).toContain('http://127.0.0.1:9999');
    expect(r.closed).toBe(true);
  });

  test('serve --no-ingest skips ingest; watch is on by default, re-ingests every 2s and cancels on exit', async () => {
    let ingests = 0;
    let tick: (() => void) | undefined;
    let cancelled = false;
    let intervalMs = 0;
    const r = await run(['serve', '--no-ingest'], { ingestAll: async () => { ingests++; return { reports: [], repriced: 0, priceRefresh: { refreshed: false } }; } }, {
      loadServer: async () => ({ startServer: () => ({ url: 'http://x', stop: () => {} }) }),
      setInterval: (fn, ms) => { tick = fn; intervalMs = ms; return () => { cancelled = true; }; },
      waitForExit: async () => { tick?.(); await Promise.resolve(); },
    });
    expect(r.code).toBe(0);
    expect(intervalMs).toBe(WATCH_INTERVAL_MS);
    expect(WATCH_INTERVAL_MS).toBe(2000);
    expect(ingests).toBe(1); // only the timer tick; startup ingest was skipped
    expect(cancelled).toBe(true);
  });

  test('serve --no-watch never installs a timer', async () => {
    let timers = 0;
    const r = await run(['serve', '--no-ingest', '--no-watch'], {}, {
      loadServer: async () => ({ startServer: () => ({ url: 'http://x', stop: () => {} }) }),
      setInterval: () => { timers++; return () => {}; },
      waitForExit: async () => {},
    });
    expect(r.code).toBe(0);
    expect(timers).toBe(0);
  });

  test('a failing watch ingest is reported on stderr, not thrown', async () => {
    let tick: (() => void) | undefined;
    const r = await run(['serve', '--no-ingest'], { ingestAll: async () => { throw new Error('disk full'); } }, {
      loadServer: async () => ({ startServer: () => ({ url: 'http://x', stop: () => {} }) }),
      setInterval: (fn) => { tick = fn; return () => {}; },
      waitForExit: async () => { tick?.(); await new Promise((res) => setTimeout(res, 5)); },
    });
    expect(r.code).toBe(0);
    expect(r.err).toContain('ingest failed: disk full');
  });
});

describe('watchTick error logging', () => {
  const flush = () => new Promise((res) => setTimeout(res, 0));
  function harness(ingest: () => Promise<unknown>) {
    const cap = new Capture();
    let t = 1_000_000;
    const tick = watchTick({ ingestAll: ingest } as unknown as App, cap, () => t);
    return { cap, tick, advance: (ms: number) => { t += ms; } };
  }

  test('the same failure is logged once, then suppressed until the repeat window passes', async () => {
    const h = harness(async () => { throw new Error('locked'); });
    for (let i = 0; i < 5; i++) { h.tick(); await flush(); h.advance(WATCH_INTERVAL_MS); }
    expect(h.cap.err.match(/ingest failed: locked/g)?.length).toBe(1);
    h.advance(WATCH_ERROR_REPEAT_MS);
    h.tick(); await flush();
    expect(h.cap.err.match(/ingest failed: locked/g)?.length).toBe(2);
    expect(h.cap.err).toContain('4 repeats suppressed');
  });

  test('a different error is logged immediately and a recovery is announced once', async () => {
    let mode: 'a' | 'b' | 'ok' = 'a';
    const h = harness(async () => { if (mode === 'ok') return {}; throw new Error(mode === 'a' ? 'one' : 'two'); });
    h.tick(); await flush();
    mode = 'b'; h.tick(); await flush();
    mode = 'ok'; h.tick(); await flush(); h.tick(); await flush();
    expect(h.cap.err).toContain('ingest failed: one');
    expect(h.cap.err).toContain('ingest failed: two');
    expect(h.cap.err.match(/ingest recovered/g)?.length).toBe(1);
  });
});
