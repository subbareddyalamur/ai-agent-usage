import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/core/db';
import { pricingLastError } from '../../src/core/pricing';
import bedrockFixture from '../fixtures/price-list-bedrock-mini.json';
import fmFixture from '../fixtures/price-list-mini.json';
import { DAY, T0, bedrockDoc, harness, priceDoc } from './pricing-helpers';

const SONNET = { model: 'Claude Sonnet 5.5', rates: { input: 2.2, output: 11 } };
const DEEPSEEK = { model: 'DeepSeek v3.2', inputPerMtok: 0.62, outputPerMtok: 1.85 };
const GLM = { model: 'GLM 5', inputPerMtok: 1, outputPerMtok: 3.2 };
const M = 1_000_000;
const zero = { ts: T0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };

const setup = (fm: unknown, bedrock: unknown) => {
  const h = harness(openDb(':memory:'), fm);
  h.setBedrockDoc(bedrock);
  return h;
};
const sources = (h: ReturnType<typeof setup>): Array<{ source: string; n: number }> =>
  h.db.query('SELECT source, COUNT(*) n FROM prices WHERE snapshot_id = (SELECT MAX(id) FROM price_snapshots) GROUP BY source ORDER BY source').all() as Array<{ source: string; n: number }>;
const snapshots = (h: ReturnType<typeof setup>): number => (h.db.query('SELECT COUNT(*) c FROM price_snapshots').get() as { c: number }).c;

describe('two price sources', () => {
  test('both are fetched, merged into one snapshot, and tagged by source', async () => {
    const h = setup(priceDoc([SONNET]), bedrockDoc([DEEPSEEK, GLM]));
    const r = await h.svc.refreshIfStale();
    expect(r.refreshed).toBe(true);
    expect(r.error).toBeUndefined();
    expect(h.allCalls).toHaveLength(2);
    expect(snapshots(h)).toBe(1);
    expect(sources(h)).toEqual([{ source: 'bedrock', n: 4 }, { source: 'foundation-models', n: 2 }]);

    const deepseek = await h.svc.resolveModel('deepseek-v3-2');
    expect(deepseek).toEqual({ canonical: 'DeepSeek v3.2', priced: true, tier: 'regional' });
    const cost = h.svc.priceEvent(deepseek, { ...zero, inputTokens: M, outputTokens: M });
    expect(cost.costUsd).toBeCloseTo(0.62 + 1.85, 9);
  });

  test('when both sources price a key, the Foundation Models source wins', async () => {
    const h = setup(priceDoc([SONNET]), bedrockDoc([{ model: 'Claude Sonnet 5.5', inputPerMtok: 99, outputPerMtok: 99 }]));
    await h.svc.refreshIfStale();
    const m = await h.svc.resolveModel('claude-sonnet-5-5');
    expect(h.svc.priceEvent(m, { ...zero, inputTokens: M }).costUsd).toBe(2.2);
    expect(sources(h)).toEqual([{ source: 'foundation-models', n: 2 }]);
  });

  test('unchanged content in both sources creates no new snapshot', async () => {
    const h = setup(priceDoc([SONNET]), bedrockDoc([DEEPSEEK]));
    await h.svc.refreshIfStale();
    h.clock.t = T0 + 2 * DAY;
    expect((await h.svc.refreshIfStale()).refreshed).toBe(false);
    expect(snapshots(h)).toBe(1);
  });

  test('a change in only the second source creates a new snapshot', async () => {
    const h = setup(priceDoc([SONNET]), bedrockDoc([DEEPSEEK]));
    await h.svc.refreshIfStale();
    h.setBedrockDoc(bedrockDoc([{ ...DEEPSEEK, inputPerMtok: 0.7 }]));
    h.clock.t = T0 + 2 * DAY;
    expect((await h.svc.refreshIfStale()).refreshed).toBe(true);
    expect(snapshots(h)).toBe(2);
    const m = await h.svc.resolveModel('deepseek-v3-2');
    expect(h.svc.priceEvent(m, { ...zero, ts: T0 + 3 * DAY, inputTokens: M }).costUsd).toBeCloseTo(0.7, 9);
    expect(h.svc.priceEvent(m, { ...zero, ts: T0 + 1 * DAY, inputTokens: M }).costUsd).toBeCloseTo(0.62, 9);
  });
});

describe('one source failing', () => {
  test('first refresh keeps the working source, reports the failure, and retries within the hour', async () => {
    const h = setup(priceDoc([SONNET]), bedrockDoc([DEEPSEEK]));
    h.setStatus(503, 'bedrock');
    const r = await h.svc.refreshIfStale();
    expect(r.refreshed).toBe(true);
    expect(r.error).toBe('bedrock: price list fetch failed: HTTP 503');
    expect(sources(h)).toEqual([{ source: 'foundation-models', n: 2 }]);
    expect(pricingLastError(h.db)).toContain('bedrock');

    h.setStatus(200);
    h.clock.t = T0 + 30 * 60 * 1000;
    await h.svc.refreshIfStale();
    expect(h.allCalls).toHaveLength(2); // still inside the retry window

    h.clock.t = T0 + 61 * 60 * 1000;
    const again = await h.svc.refreshIfStale();
    expect(again.refreshed).toBe(true);
    expect(again.error).toBeUndefined();
    expect(snapshots(h)).toBe(2);
    expect(sources(h).map((s) => s.source)).toEqual(['bedrock', 'foundation-models']);
    expect(pricingLastError(h.db)).toBeUndefined();
  });

  test('rows of the failed source are carried forward, so nothing churns', async () => {
    const h = setup(priceDoc([SONNET]), bedrockDoc([DEEPSEEK]));
    await h.svc.refreshIfStale();
    h.setStatus(503, 'bedrock');
    h.clock.t = T0 + 2 * DAY;
    const r = await h.svc.refreshIfStale();
    expect(r.refreshed).toBe(false);
    expect(r.error).toContain('bedrock');
    expect(snapshots(h)).toBe(1);
    expect(sources(h).find((s) => s.source === 'bedrock')?.n).toBe(2);
  });

  test('a change in the healthy source is stored together with the carried rows', async () => {
    const h = setup(priceDoc([SONNET]), bedrockDoc([DEEPSEEK]));
    await h.svc.refreshIfStale();
    h.setStatus(503, 'fm');
    h.setBedrockDoc(bedrockDoc([{ ...DEEPSEEK, outputPerMtok: 2 }]));
    h.clock.t = T0 + 2 * DAY;
    const r = await h.svc.refreshIfStale();
    expect(r.refreshed).toBe(true);
    expect(r.error).toContain('foundation-models');
    expect(sources(h)).toEqual([{ source: 'bedrock', n: 2 }, { source: 'foundation-models', n: 2 }]);
    const claude = await h.svc.resolveModel('claude-sonnet-5-5');
    expect(h.svc.priceEvent(claude, { ...zero, ts: T0 + 3 * DAY, inputTokens: M }).costUsd).toBe(2.2);
  });

  test('an invalid or empty second source counts as a failure and never poisons the snapshot', async () => {
    const h = setup(priceDoc([SONNET]), { not: 'a price list' });
    const r = await h.svc.refreshIfStale();
    expect(r.refreshed).toBe(true);
    expect(r.error).toContain('bedrock:');
    expect(sources(h)).toEqual([{ source: 'foundation-models', n: 2 }]);

    const h2 = setup(priceDoc([SONNET]), bedrockDoc([]));
    expect((await h2.svc.refreshIfStale()).error).toBe('bedrock: price list contained no token prices');
  });

  test('both failing writes nothing and keeps the previous snapshot', async () => {
    const h = setup(priceDoc([SONNET]), bedrockDoc([DEEPSEEK]));
    await h.svc.refreshIfStale();
    h.setStatus(500);
    h.clock.t = T0 + 2 * DAY;
    const r = await h.svc.refreshIfStale();
    expect(r.refreshed).toBe(false);
    expect(r.error).toContain('foundation-models');
    expect(r.error).toContain('bedrock');
    expect(snapshots(h)).toBe(1);
  });
});

describe('real-shaped fixtures: which of the user\'s ids resolve', () => {
  async function ready() {
    const h = setup(fmFixture, bedrockFixture);
    await h.svc.refreshIfStale();
    return h;
  }

  test.each([
    ['deepseek-v3-2', 'DeepSeek v3.2'],
    ['glm-5', 'GLM 5'],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ])('%s is priced as %s', async (raw, canonical) => {
    const h = await ready();
    expect(await h.svc.resolveModel(raw)).toEqual({ canonical, priced: true, tier: 'regional' });
  });

  test('GPT-style models: no guessing across versions', async () => {
    const h = await ready();
    // Only "OpenAI GPT-6 Astra" (another model) is priced for commercial regions.
    for (const raw of ['openai-gpt-5-6-luna', 'openai-gpt-6-1-sol', 'openai.gpt-5.6-luna', 'openai-gpt-6']) {
      expect((await h.svc.resolveModel(raw)).priced).toBe(false);
    }
    expect((await h.svc.resolveModel('openai-gpt-6-astra')).canonical).toBe('OpenAI GPT-6 Astra');
  });

  test('costs for the newly priced models', async () => {
    const h = await ready();
    const glm = await h.svc.resolveModel('glm-5');
    expect(h.svc.priceEvent(glm, { ...zero, inputTokens: M, outputTokens: M }).costUsd).toBeCloseTo(1 + 3.2, 9);
  });
});
