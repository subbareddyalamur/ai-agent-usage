import { describe, expect, test } from 'bun:test';
import type { SeriesPoint } from '../../src/core/api-types';
import { filterUpdates, rangeBounds, readFilters, toApiQuery } from '../../ui/lib/filters';
import { baseName, formatBytes, formatPct, formatRate, formatTokens, formatUsd } from '../../ui/lib/format';
import { buildHash, parseHash } from '../../ui/lib/router';
import { pivot } from '../../ui/lib/series';

describe('format', () => {
  test('tokens', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_300)).toBe('12.3k');
    expect(formatTokens(9_118_467)).toBe('9.12M');
    expect(formatTokens(2_500_000_000)).toBe('2.5B');
  });
  test('usd keeps tiny and zero amounts honest', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.004)).toBe('<$0.01');
    expect(formatUsd(14.3249)).toBe('$14.32');
    expect(formatUsd(null)).toBe('–');
  });
  test('rates, pct, bytes, basename', () => {
    expect(formatRate(0.11)).toBe('$0.110');
    expect(formatRate(2.2)).toBe('$2.20');
    expect(formatPct(0.853)).toBe('85.3%');
    expect(formatPct(null)).toBe('–');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(baseName('/a/b/web-dashboard')).toBe('web-dashboard');
    expect(baseName(null)).toBe('–');
  });
});

describe('filters', () => {
  const now = new Date(2026, 9, 9, 15, 30); // local time, 9 Oct 2026

  test('defaults and round trip through the URL', () => {
    const f = readFilters(new URLSearchParams('range=7d&agents=a,b&sub=0'));
    expect(f).toMatchObject({ range: '7d', agents: ['a', 'b'], subagents: false });
    expect(readFilters(new URLSearchParams('range=bogus')).range).toBe('30d');
    expect(filterUpdates({ range: '30d', agents: [], subagents: true })).toEqual({ range: null, agents: null, sub: null });
  });

  test('presets are whole local days, custom end date is inclusive', () => {
    const f = readFilters(new URLSearchParams());
    expect(rangeBounds({ ...f, range: 'today' }, now).from).toBe(new Date(2026, 9, 9).getTime());
    expect(rangeBounds({ ...f, range: '7d' }, now).from).toBe(new Date(2026, 9, 3).getTime());
    expect(rangeBounds({ ...f, range: 'all' }, now)).toEqual({});
    const c = rangeBounds({ ...f, range: 'custom', from: '2026-10-01', to: '2026-10-02' }, now);
    expect(c.from).toBe(new Date(2026, 9, 1).getTime());
    expect(c.to).toBe(new Date(2026, 9, 3).getTime() - 1);
  });

  test('api query carries filters and the viewer timezone', () => {
    const q = new URLSearchParams(toApiQuery({ ...readFilters(new URLSearchParams()), range: 'all', agents: ['x'], subagents: false }, now));
    expect(q.get('agents')).toBe('x');
    expect(q.get('subagents')).toBe('0');
    expect(q.get('tz')).toBeTruthy();
    expect(q.has('from')).toBe(false);
  });
});

describe('router', () => {
  test('parse and build are inverse, tolerating bad escapes', () => {
    const r = parseHash('#/sessions/opencode/a%2Fb?range=7d');
    expect(r.segments).toEqual(['sessions', 'opencode', 'a/b']);
    expect(r.params.get('range')).toBe('7d');
    expect(buildHash(r.segments, r.params)).toBe('#/sessions/opencode/a%2Fb?range=7d');
    expect(parseHash('#/%E0%A4%A').segments).toEqual(['%E0%A4%A']);
    expect(parseHash('').segments).toEqual([]);
  });
});

describe('series pivot', () => {
  const p = (bucket: string, key: string, costUsd: number): SeriesPoint => ({ bucket, key, costUsd, inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 });

  test('orders buckets, fills gaps with zero and ranks keys by total', () => {
    const out = pivot([p('2026-10-02', 'a', 1), p('2026-10-01', 'b', 5), p('2026-10-01', 'a', 1)], 'cost');
    expect(out.keys).toEqual(['b', 'a']);
    expect(out.rows).toEqual([
      { bucket: '2026-10-01', b: 5, a: 1 },
      { bucket: '2026-10-02', b: 0, a: 1 },
    ]);
  });

  test('collapses the long tail into Other and supports the tokens metric', () => {
    const pts = ['a', 'b', 'c', 'd'].map((k, i) => p('2026-10-01', k, 10 - i));
    const out = pivot(pts, 'cost', 2);
    expect(out.keys).toEqual(['a', 'b', 'Other']);
    expect(out.rows[0]).toEqual({ bucket: '2026-10-01', a: 10, b: 9, Other: 8 + 7 });
    expect(pivot(pts, 'tokens').rows[0]?.a).toBe(4);
  });
});
