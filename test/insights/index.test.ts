import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules, runInsights, runInsightsDetailed } from '../../src/insights';
import {
  fmtBytes, fmtPct, fmtTokens, fmtUsd, isSignificant, mean, median, percentile, robustSigma, severityForShare, sum,
} from '../../src/insights/kit';
import { chain, seedDb } from './seed';

describe('rule discovery and orchestration', () => {
  test('all seven built-in rules are discovered', () => {
    expect(loadRules().map((r) => r.id).sort()).toEqual([
      'cache-expiry', 'cache-off', 'compaction-cost', 'context-growth', 'costly-sessions', 'model-mix', 'tool-output-bloat',
    ]);
  });

  test('findings are ordered by severity then savings, and a throwing rule is isolated', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-'));
    const finding = (id: string, severity: string, extra = '') =>
      `export default { id: '${id}', run: () => [{ id: '${id}', severity: '${severity}', title: 't', detail: 'd', evidence: []${extra} }] };`;
    writeFileSync(join(dir, 'a.ts'), finding('a-info', 'info', ', estSavingsUsd: 99'));
    writeFileSync(join(dir, 'b.ts'), finding('b-high-small', 'high', ', estSavingsUsd: 1'));
    writeFileSync(join(dir, 'c.ts'), finding('c-high-big', 'high', ', estSavingsUsd: 5'));
    writeFileSync(join(dir, 'd.ts'), `export default { id: 'boom', run: () => { throw new Error('kaput'); } };`);
    writeFileSync(join(dir, 'e.ts'), `export default { notARule: true };`);
    writeFileSync(join(dir, 'f.ts'), `throw new Error('load failure');`);
    const db = await seedDb([]);
    const out = runInsightsDetailed(db, {}, dir);
    expect(out.findings.map((f) => f.id)).toEqual(['c-high-big', 'b-high-small', 'a-info']);
    expect(out.problems).toEqual(['boom: kaput']);
  });

  test('runInsights on real rules returns nothing for an empty database and a healthy one', async () => {
    expect(runInsights(await seedDb([]), {})).toEqual([]);
    const events = Array.from({ length: 25 }, (_, i) => chain({ sessionId: `ok${i}`, contexts: [6000, 6500, 7000], cached: true, start: 1_700_000_000_000 + i * 3_600_000 })).flat();
    expect(runInsights(await seedDb(events), {})).toEqual([]);
  });
});

describe('kit statistics and formatting', () => {
  test('percentile interpolates and handles edges', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([10, 0], 0)).toBe(0);
    expect(percentile([10, 0], 1)).toBe(10);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
    expect(median([3, 1, 2])).toBe(2);
  });

  test('robustSigma ignores outliers, sum and mean', () => {
    expect(robustSigma([10, 10, 10, 10, 1000])).toBe(0);
    expect(robustSigma([1, 2, 3, 4, 5])).toBeCloseTo(1.4826 * 1, 4);
    expect(sum([1, 2, 3])).toBe(6);
    expect(mean([])).toBe(0);
    expect(mean([2, 4])).toBe(3);
  });

  test('formatters', () => {
    expect(fmtTokens(950)).toBe('950');
    expect(fmtTokens(12_345)).toBe('12.3k');
    expect(fmtTokens(182_000)).toBe('182k');
    expect(fmtTokens(9_118_467)).toBe('9.1M');
    expect(fmtTokens(2.5e9)).toBe('2.5B');
    expect(fmtUsd(0.0123)).toBe('$0.012');
    expect(fmtUsd(0.456)).toBe('$0.46');
    expect(fmtUsd(12.345)).toBe('$12.35');
    expect(fmtUsd(1234.5)).toBe('$1235');
    expect(fmtPct(0.1)).toBe('10%');
    expect(fmtBytes(512)).toBe('512 B');
    expect(fmtBytes(2048)).toBe('2.0 kB');
    expect(fmtBytes(3_500_000)).toBe('3.5 MB');
  });

  test('severity and significance scale with the share of window spend', () => {
    expect(severityForShare(25, 100)).toBe('high');
    expect(severityForShare(6, 100)).toBe('warn');
    expect(severityForShare(1, 100)).toBe('info');
    expect(severityForShare(5, 0)).toBe('info');
    expect(isSignificant(2, 100)).toBe(true);
    expect(isSignificant(0.5, 100)).toBe(false);
    expect(isSignificant(1, 0)).toBe(false);
  });
});
