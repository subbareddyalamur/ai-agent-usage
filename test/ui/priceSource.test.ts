import { describe, expect, test } from 'bun:test';
import { dominantSource, shareOfEvents, SOURCE_INFO, sourceKey, sourceLabel, sourceTooltip } from '../../ui/lib/priceSource';
import type { CostSourceShare } from '../../src/core/api-types';

const shares: CostSourceShare[] = [
  { source: 'models.dev', events: 3, costUsd: 0.2 },
  { source: 'aws-price-list', events: 10, costUsd: 4 },
  { source: null, events: 1, costUsd: 0 },
];

describe('price source labels', () => {
  test('plain labels for every source, null = Unpriced', () => {
    expect(sourceLabel('aws-price-list')).toBe('AWS price list');
    expect(sourceLabel('aws-pricing-page')).toBe('AWS pricing page');
    expect(sourceLabel('official')).toBe('Official price list');
    expect(sourceLabel('models.dev')).toBe('models.dev (third-party)');
    expect(sourceLabel('free-model')).toBe('Free');
    expect(sourceLabel('agent-reported')).toBe('Agent-reported (approx.)');
    expect(sourceLabel(null)).toBe('Unpriced');
    expect(sourceKey(null)).toBe('unpriced');
  });

  test('every source has a distinct glyph, so colour is never the only cue', () => {
    const glyphs = Object.values(SOURCE_INFO).map((i) => i.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });
});

describe('dominantSource / tooltip', () => {
  test('picks the source with the most events and keeps the rest', () => {
    const { main, others } = dominantSource(shares);
    expect(main?.source).toBe('aws-price-list');
    expect(others.map((o) => o.source)).toEqual(['models.dev', null]);
  });

  test('empty input has no dominant source', () => {
    expect(dominantSource([])).toEqual({ main: null, others: [] });
  });

  test('tooltip lists each source with calls and percentage', () => {
    expect(sourceTooltip(shares)).toBe(
      ['models.dev (third-party): 3 calls (21%)', 'AWS price list: 10 calls (71%)', 'Unpriced: 1 call (7%)'].join('\n'),
    );
  });

  test('share of events handles an empty total', () => {
    expect(shareOfEvents(5, shares)).toBeCloseTo(5 / 14);
    expect(shareOfEvents(0, [])).toBe(0);
  });
});
