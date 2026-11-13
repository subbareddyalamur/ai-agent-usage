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
    expect(h.allCalls).toHaveLength(8); // foundation models, bedrock, pricing page, models.dev, four official pages
    expect(snapshots(h)).toBe(1);
    expect(sources(h)).toEqual([{ source: 'bedrock', n: 4 }, { source: 'foundation-models', n: 2 }, { source: 'pricing-page', n: 4 }]);

    const deepseek = await h.svc.resolveModel('deepseek-v3-2');
    expect(deepseek).toMatchObject({ canonical: 'DeepSeek v3.2', priced: true, tier: 'regional' });
    const cost = h.svc.priceEvent(deepseek, { ...zero, inputTokens: M, outputTokens: M });
    expect(cost.costUsd).toBeCloseTo(0.62 + 1.85, 9);
  });

  test('when both sources price a key, the Foundation Models source wins', async () => {
    const h = setup(priceDoc([SONNET]), bedrockDoc([{ model: 'Claude Sonnet 5.5', inputPerMtok: 99, outputPerMtok: 99 }]));
    await h.svc.refreshIfStale();
    const m = await h.svc.resolveModel('claude-sonnet-5-5');
    expect(h.svc.priceEvent(m, { ...zero, inputTokens: M }).costUsd).toBe(2.2);
    expect(sources(h)).toEqual([{ source: 'foundation-models', n: 2 }, { source: 'pricing-page', n: 4 }]);
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
    expect(sources(h)).toEqual([{ source: 'foundation-models', n: 2 }, { source: 'pricing-page', n: 4 }]);
    expect(pricingLastError(h.db)).toContain('bedrock');

    h.setStatus(200);
    h.clock.t = T0 + 30 * 60 * 1000;
    await h.svc.refreshIfStale();
    expect(h.allCalls).toHaveLength(8); // still inside the retry window

    h.clock.t = T0 + 61 * 60 * 1000;
    const again = await h.svc.refreshIfStale();
    expect(again.refreshed).toBe(true);
    expect(again.error).toBeUndefined();
    expect(snapshots(h)).toBe(2);
    expect(sources(h).map((s) => s.source)).toEqual(['bedrock', 'foundation-models', 'pricing-page']);
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
    expect(sources(h)).toEqual([{ source: 'bedrock', n: 2 }, { source: 'foundation-models', n: 2 }, { source: 'pricing-page', n: 4 }]);
    const claude = await h.svc.resolveModel('claude-sonnet-5-5');
    expect(h.svc.priceEvent(claude, { ...zero, ts: T0 + 3 * DAY, inputTokens: M }).costUsd).toBe(2.2);
  });

  test('an invalid or empty second source counts as a failure and never poisons the snapshot', async () => {
    const h = setup(priceDoc([SONNET]), { not: 'a price list' });
    const r = await h.svc.refreshIfStale();
    expect(r.refreshed).toBe(true);
    expect(r.error).toContain('bedrock:');
    expect(sources(h)).toEqual([{ source: 'foundation-models', n: 2 }, { source: 'pricing-page', n: 4 }]);

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
    expect(await h.svc.resolveModel(raw)).toMatchObject({ canonical, priced: true, tier: 'regional' });
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

describe('pricing page (third, fill-only source)', () => {
  const pageFixture = Bun.file(new URL('../fixtures/pricing-page-mini.html', import.meta.url)).text();
  const feedFixture = Bun.file(new URL('../fixtures/pricing-feed-mini.json', import.meta.url)).json();

  async function ready(opts: { bulk?: unknown } = {}) {
    const h = setup(opts.bulk ?? fmFixture, bedrockFixture);
    h.setPage(await pageFixture);
    h.setFeed(await feedFixture);
    const r = await h.svc.refreshIfStale();
    return { h, r };
  }
  const pageModels = (h: ReturnType<typeof setup>): string[] =>
    (h.db.query("SELECT DISTINCT model FROM prices WHERE source = 'pricing-page' AND snapshot_id = (SELECT MAX(id) FROM price_snapshots) ORDER BY model").all() as Array<{ model: string }>).map((r) => r.model);

  test('GLM 5.3 becomes priceable for every spelling of its id, without touching GLM 5', async () => {
    const { h, r } = await ready();
    expect(r.error).toBeUndefined();
    for (const raw of ['us.zai.glm-5.3', 'zai.glm-5.3', 'glm-5.3']) {
      const m = await h.svc.resolveModel(raw);
      expect(m).toMatchObject({ canonical: 'GLM 5.3', priced: true, tier: 'regional' });
      expect(h.svc.priceEvent(m, { ...zero, inputTokens: M, outputTokens: M }).costUsd).toBeCloseTo(1.848 + 5.808, 9);
    }
    const global = await h.svc.resolveModel('global.zai.glm-5.3');
    expect(global).toMatchObject({ canonical: 'GLM 5.3', priced: true, tier: 'global' });
    expect(h.svc.priceEvent(global, { ...zero, inputTokens: M, outputTokens: M, cacheReadTokens: M, cacheWrite5mTokens: M }).costUsd).toBeCloseTo(1.68 + 5.28 + 0.312 + 2.1, 9);
    expect(await h.svc.resolveModel('glm-5')).toMatchObject({ canonical: 'GLM 5', priced: true, tier: 'regional' });
    expect(await h.svc.resolveModel('us.zai.glm-5')).toMatchObject({ canonical: 'GLM 5', priced: true, tier: 'regional' });
  });

  test('only models that no bulk offer prices are taken from the page', async () => {
    const { h } = await ready();
    // GLM 5 and DeepSeek v3.2 exist in the bulk fixtures; the page's rows for them are ignored.
    expect(pageModels(h)).toEqual(['Devstral 2 123B', 'GLM 5.3', 'Jurassic-2 Mid', 'Jurassic-2 Ultra', 'Magistral Small 1.2']);
    const glm5 = await h.svc.resolveModel('glm-5');
    expect(h.svc.priceEvent(glm5, { ...zero, inputTokens: M }).costUsd).toBeCloseTo(1, 9); // bulk, not the page's 1.00 row
  });

  test('the page never overrides a bulk row, not even to add a missing tier for a bulk model', async () => {
    const h = setup(priceDoc([SONNET]), bedrockDoc([{ model: 'Dup Model', inputPerMtok: 1, outputPerMtok: 2 }]));
    h.setPage(
      '<ul role="tablist"><li role="tab" aria-controls="a-panel-1">Model Pricing</li></ul><div id="a-panel-1"><ul role="tablist"><li role="tab" aria-controls="a-panel-2">Z AI</li></ul><div id="a-panel-2"><ul role="tablist"><li role="tab" aria-controls="a-panel-3">Dup Model</li></ul><div id="a-panel-3"><table><tr><td>Inference option</td><td>Input</td><td>Output</td></tr><tr><td>Global CRIS</td><td>$50</td><td>$60</td></tr><tr><td>US CRIS</td><td>$70</td><td>$80</td></tr></table></div></div></div>',
    );
    // The default page rows are replaced by this one, which only has Dup Model (a bulk model) -> nothing to add.
    const r = await h.svc.refreshIfStale();
    expect(r.error).toBeUndefined();
    expect(sources(h).map((s) => s.source)).toEqual(['bedrock', 'foundation-models']);
    const dup = await h.svc.resolveModel('dup-model');
    expect(h.svc.priceEvent(dup, { ...zero, inputTokens: M }).costUsd).toBe(1);
  });

  test('when a bulk offer starts listing the model, the page rows are dropped in the next snapshot', async () => {
    const { h } = await ready();
    expect(pageModels(h)).toContain('GLM 5.3');
    h.setDoc(priceDoc([{ model: 'GLM 5.3', rates: { input: 1.7, output: 5.3 } }, SONNET]));
    h.clock.t = T0 + 2 * DAY;
    expect((await h.svc.refreshIfStale()).refreshed).toBe(true);
    expect(pageModels(h)).not.toContain('GLM 5.3');
    const m = await h.svc.resolveModel('us.zai.glm-5.3');
    expect(h.svc.priceEvent(m, { ...zero, ts: T0 + 3 * DAY, inputTokens: M }).costUsd).toBeCloseTo(1.7, 9);
    expect(h.svc.priceEvent(m, { ...zero, ts: T0 + 1 * DAY, inputTokens: M }).costUsd).toBeCloseTo(1.848, 9); // history keeps the old price
  });

  test('fetches the page and its feed once per refresh, with a browser user agent', async () => {
    const { h } = await ready();
    const pageCalls = h.requests.filter((q) => q.url.includes('aws.amazon.com/bedrock/pricing'));
    const feedCalls = h.requests.filter((q) => q.url.includes('b0.p.awsstatic.com'));
    expect(pageCalls).toHaveLength(1);
    expect(feedCalls).toHaveLength(1);
    for (const call of [...pageCalls, ...feedCalls]) expect(call.headers['User-Agent']).toContain('Mozilla/5.0');
  });

  test('a failing page keeps the bulk rows and the last known page rows, reports an error, and never throws', async () => {
    const { h } = await ready();
    const before = pageModels(h);
    h.setStatus(403, 'page');
    h.clock.t = T0 + 2 * DAY;
    const r = await h.svc.refreshIfStale();
    expect(r.error).toBe('pricing-page: price list fetch failed: HTTP 403');
    expect(pageModels(h)).toEqual(before);
    expect((await h.svc.resolveModel('us.zai.glm-5.3')).priced).toBe(true);
    expect(pricingLastError(h.db)).toContain('pricing-page');
  });

  test('a failing feed fails the page source as a whole', async () => {
    const h = setup(fmFixture, bedrockFixture);
    h.setPage(await pageFixture);
    h.setFeed(await feedFixture);
    h.setStatus(503, 'feed');
    const r = await h.svc.refreshIfStale();
    expect(r.error).toBe('pricing-page: price list fetch failed: HTTP 503');
    expect(r.refreshed).toBe(true); // bulk rows were still stored
    expect(pageModels(h)).toEqual([]);
  });

  test('a changed page layout (nothing parses) is an error that keeps the previous page rows', async () => {
    const { h } = await ready();
    h.setPage('<html><body><h1>Redesigned</h1><div class="card">GLM 5.3 — contact sales</div></body></html>');
    h.clock.t = T0 + 2 * DAY;
    const r = await h.svc.refreshIfStale();
    expect(r.error).toBe('pricing-page: price list contained no token prices');
    expect(pageModels(h)).toContain('GLM 5.3');
  });

  test('a malformed feed body or a feed without regions fails only the page source', async () => {
    const h = setup(fmFixture, bedrockFixture);
    h.setPage(await pageFixture);
    h.setFeed({ no: 'regions' });
    expect((await h.svc.refreshIfStale()).error).toBe('pricing-page: price feed bedrockfoundationmodels has no regions');
  });

  test('retries of a failed page do not refetch the healthy bulk sources, and the daily refresh still happens', async () => {
    const { h } = await ready();
    h.setStatus(403, 'page');
    h.clock.t = T0 + 2 * DAY;
    await h.svc.refreshIfStale(); // full refresh, page fails
    const callsAfterFull = h.allCalls.length;

    h.clock.t += 61 * 60 * 1000;
    await h.svc.refreshIfStale(); // hourly retry: only the page is due
    const retry = h.allCalls.slice(callsAfterFull);
    expect(retry).toEqual([expect.stringContaining('aws.amazon.com/bedrock/pricing')]);

    h.clock.t += 61 * 60 * 1000;
    h.setStatus(200, 'page');
    await h.svc.refreshIfStale(); // page recovers
    expect(pricingLastError(h.db)).toBeUndefined();
    expect(pageModels(h)).toContain('GLM 5.3');

    const callsBeforeDaily = h.allCalls.length;
    h.clock.t += 25 * 3600 * 1000;
    await h.svc.refreshIfStale();
    expect(h.allCalls.length - callsBeforeDaily).toBeGreaterThanOrEqual(3); // all sources again
  });

  test('a persistently failing page does not postpone the daily bulk refresh', async () => {
    const { h } = await ready();
    h.setStatus(403, 'page');
    for (let i = 0; i < 3; i++) {
      h.clock.t += 61 * 60 * 1000;
      await h.svc.refreshIfStale();
    }
    const before = h.allCalls.filter((u) => u.includes('AmazonBedrock')).length;
    h.clock.t = T0 + 26 * 3600 * 1000;
    await h.svc.refreshIfStale();
    expect(h.allCalls.filter((u) => u.includes('AmazonBedrock')).length).toBeGreaterThan(before);
  });

  test('unchanged content in all three sources creates no snapshot; a page-only change creates one', async () => {
    const { h } = await ready();
    h.clock.t = T0 + 2 * DAY;
    expect((await h.svc.refreshIfStale()).refreshed).toBe(false);
    expect(snapshots(h)).toBe(1);
    h.setPage((await pageFixture).replace('$ 1.68', '$ 1.70'));
    h.clock.t = T0 + 4 * DAY;
    expect((await h.svc.refreshIfStale()).refreshed).toBe(true);
    expect(snapshots(h)).toBe(2);
  });
});

describe('a feed added after the first refresh', () => {
  test('is fetched at once, without refetching the feeds that are already fresh', async () => {
    const h = setup(priceDoc([SONNET]), bedrockDoc([DEEPSEEK]));
    await h.svc.refreshIfStale();
    h.db.query("DELETE FROM kv WHERE key = 'pricing.fetchedAt.pricing-page'").run(); // as on a database from before the page source existed
    const calls = h.allCalls.length;
    h.clock.t = T0 + 60 * 1000;
    await h.svc.refreshIfStale();
    const newCalls = h.allCalls.slice(calls);
    expect(newCalls).toEqual([expect.stringContaining('aws.amazon.com/bedrock/pricing')]);
    expect(h.db.query("SELECT value FROM kv WHERE key = 'pricing.fetchedAt.pricing-page'").get()).toEqual({ value: String(T0 + 60 * 1000) });
    await h.svc.refreshIfStale();
    expect(h.allCalls.length).toBe(calls + 1); // and is not fetched again while fresh
  });
});
