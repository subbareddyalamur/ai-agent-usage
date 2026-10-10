import { describe, expect, test } from 'bun:test';
import type { MissReason } from '../../src/core/api-types';
import { formatDuration, REASON_HINT, REASON_LABEL, REASON_ORDER, sortReasons, ttlSourceLabel } from '../../ui/lib/cache';
import { liveState } from '../../ui/components/LiveIndicator';

describe('cache labels', () => {
  const all: MissReason[] = ['cold-start', 'context-reset', 'caching-off', 'expired', 'model-switch', 'prefix-change'];

  test('every reason has a label, a hint and a place in the display order', () => {
    for (const r of all) {
      expect(REASON_LABEL[r].length).toBeGreaterThan(0);
      expect(REASON_HINT[r].length).toBeGreaterThan(0);
      expect(REASON_ORDER).toContain(r);
    }
    expect(new Set(REASON_ORDER).size).toBe(all.length);
  });

  test('sortReasons puts avoidable reasons first and does not mutate its input', () => {
    const input = all.map((reason) => ({ reason }));
    const sorted = sortReasons(input);
    expect(sorted.map((x) => x.reason)).toEqual([...REASON_ORDER]);
    expect(input.map((x) => x.reason)).toEqual(all);
  });

  test('formatDuration', () => {
    expect(formatDuration(null)).toBe('–');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(300_000)).toBe('5 min');
    expect(formatDuration(3_600_000)).toBe('1 h');
    expect(formatDuration(5_400_000)).toBe('1.5 h');
    expect(formatDuration(3 * 86_400_000)).toBe('3 d');
  });

  test('ttlSourceLabel covers every source', () => {
    expect(ttlSourceLabel('5m')).toContain('5-minute');
    expect(ttlSourceLabel('1h')).toContain('1-hour');
    expect(ttlSourceLabel('mixed')).toContain('both');
  });
});

describe('liveState', () => {
  test('paused wins over failures; failures mean reconnecting', () => {
    expect(liveState({ paused: false, failures: 0 })).toBe('live');
    expect(liveState({ paused: false, failures: 2 })).toBe('retrying');
    expect(liveState({ paused: true, failures: 2 })).toBe('paused');
  });
});
