import { describe, expect, test } from 'bun:test';
import { parseFilters, parseSeriesParams, parseSessionQuery } from '../../src/server/params';

const sp = (q: string): URLSearchParams => new URLSearchParams(q);

describe('parseFilters', () => {
  test('empty query yields empty filters', () => {
    expect(parseFilters(sp(''))).toEqual({ ok: true, value: {} });
  });

  test('parses range, lists, subagents and tz', () => {
    const r = parseFilters(sp('from=100&to=200&agents=a,b&models=Claude%20Sonnet%205.5&subagents=0&tz=Europe/London'));
    expect(r).toEqual({
      ok: true,
      value: { from: 100, to: 200, agents: ['a', 'b'], models: ['Claude Sonnet 5.5'], includeSubagents: false, tz: 'Europe/London' },
    });
  });

  test('accepts repeated params and de-duplicates', () => {
    const r = parseFilters(sp('agents=a&agents=b,a'));
    expect(r).toEqual({ ok: true, value: { agents: ['a', 'b'] } });
  });

  test.each([
    ['from=abc', 'from'],
    ['from=-1', 'from'],
    ['from=1e3', 'from'],
    ['to=99999999999999999999', 'to'],
    ['from=5&to=1', 'from'],
    ['subagents=yes', 'subagents'],
    ['tz=Not/AZone', 'tz'],
  ])('rejects %s naming only the field', (query, field) => {
    const r = parseFilters(sp(query));
    expect(r).toEqual({ ok: false, error: `invalid "${field}"` });
  });

  test('error text never echoes the offending value', () => {
    const r = parseFilters(sp('from=<script>alert(1)</script>'));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('script');
  });

  test('rejects oversized lists and items', () => {
    expect(parseFilters(sp(`agents=${'x'.repeat(201)}`)).ok).toBe(false);
    expect(parseFilters(sp(`agents=${Array.from({ length: 101 }, (_, i) => `a${i}`).join(',')}`)).ok).toBe(false);
  });
});

describe('parseSeriesParams / parseSessionQuery', () => {
  test('defaults', () => {
    expect(parseSeriesParams(sp(''))).toEqual({ ok: true, value: { bucket: 'day', split: 'model' } });
    expect(parseSessionQuery(sp(''))).toEqual({ ok: true, value: { sort: 'ts', dir: 'desc', limit: 50, offset: 0 } });
  });

  test('validates enums and ranges', () => {
    expect(parseSeriesParams(sp('bucket=year')).ok).toBe(false);
    expect(parseSeriesParams(sp('split=tool')).ok).toBe(false);
    expect(parseSessionQuery(sp('sort=drop')).ok).toBe(false);
    expect(parseSessionQuery(sp('limit=0')).ok).toBe(false);
    expect(parseSessionQuery(sp('limit=1001')).ok).toBe(false);
    expect(parseSessionQuery(sp('offset=-1')).ok).toBe(false);
    expect(parseSessionQuery(sp('sort=cacheHit&dir=asc&limit=10&offset=20'))).toEqual({
      ok: true,
      value: { sort: 'cacheHit', dir: 'asc', limit: 10, offset: 20 },
    });
  });
});
