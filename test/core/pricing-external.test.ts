import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/core/db';
import { pricingLastError } from '../../src/core/pricing';
import { loadExternalPrices, modelsDevFetchedAt } from '../../src/core/pricing-modelsdev';
import type { PriceInput, ResolvedModel } from '../../src/core/types';
import bedrockFixture from '../fixtures/price-list-bedrock-mini.json';
import fmFixture from '../fixtures/price-list-mini.json';
import modelsDevFixture from '../fixtures/models-dev-mini.json';
import { DAY, T0, harness, modelsDevDoc, priceDoc, type Harness } from './pricing-helpers';

const M = 1_000_000;
const zero: PriceInput = { ts: T0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
const SONNET = { model: 'Claude Sonnet 5.5', rates: { input: 2.2, output: 11 } };

async function ready(doc: unknown = modelsDevFixture, aws: unknown = priceDoc([SONNET])): Promise<Harness> {
  const h = harness(openDb(':memory:'), aws);
  h.setModelsDev(doc);
  await h.svc.refreshIfStale();
  return h;
}
const cost = (h: Harness, m: ResolvedModel, over: Partial<PriceInput> = {}) => h.svc.priceEvent(m, { ...zero, ...over });

describe('resolution order and sources', () => {
  test('AWS price list comes first and reports its own source', async () => {
    const h = await ready(modelsDevDoc({ anthropic: { 'claude-sonnet-5-5': { input: 3, output: 15 } } }));
    const m = await h.svc.resolveModel('claude-sonnet-5-5', { provider: 'anthropic' });
    expect(m).toMatchObject({ canonical: 'Claude Sonnet 5.5', source: 'aws-price-list' });
    expect(cost(h, m, { inputTokens: M })).toMatchObject({ costUsd: 2.2, source: 'aws-price-list' });
  });

  test('page-only AWS models report aws-pricing-page', async () => {
    const page = harness(openDb(':memory:'), fmFixture);
    page.setBedrockDoc(bedrockFixture);
    page.setPage(await Bun.file(new URL('../fixtures/pricing-page-mini.html', import.meta.url)).text());
    page.setFeed(await Bun.file(new URL('../fixtures/pricing-feed-mini.json', import.meta.url)).json());
    await page.svc.refreshIfStale();
    const glm = await page.svc.resolveModel('us.zai.glm-5.3');
    expect(glm.source).toBe('aws-pricing-page');
    expect(cost(page, glm, { inputTokens: M }).source).toBe('aws-pricing-page');
    const glm5 = await page.svc.resolveModel('glm-5');
    expect(glm5.source).toBe('aws-price-list');
  });

  test('when AWS knows nothing, models.dev prices the model and says so', async () => {
    const h = await ready();
    const m = await h.svc.resolveModel('gpt-5-nano', { provider: 'opencode' });
    expect(m).toMatchObject({ canonical: 'gpt-5-nano', priced: true, source: 'models.dev' });
    const c = cost(h, m, { inputTokens: M, outputTokens: M, cacheReadTokens: M, ts: Date.now() });
    expect(c.source).toBe('models.dev');
    expect(c.costUsd).toBeCloseTo(0.05 + 0.4 + 0.005, 9);
  });

  test.each([
    ['gemini-3-flash-preview', 'google', [0.5, 3, 0.05]],
    ['gemini-3.6-flash', 'google', [0.75, 3.75, 0.075]],
    ['deepseek/deepseek-v4-flash', 'openrouter', [0.0085, 1.28, 0.0085]],
    ['mistral-large-latest', 'mistral', [0.5, 1.5, 0.05]],
    ['open-mistral-7b', 'mistral', [0.25, 0.25, 0.25]], // no cache_read -> input rate
    ['gpt-5-nano', 'opencode', [0.05, 0.4, 0.005]],
  ])('%s via %s is priced from models.dev', async (raw, provider, [input, output, cacheRead]) => {
    const h = await ready();
    const m = await h.svc.resolveModel(raw, { provider });
    expect(m).toMatchObject({ priced: true, source: 'models.dev' });
    expect(cost(h, m, { inputTokens: M, ts: Date.now() }).costUsd).toBeCloseTo(input as number, 9);
    expect(cost(h, m, { outputTokens: M, ts: Date.now() }).costUsd).toBeCloseTo(output as number, 9);
    expect(cost(h, m, { cacheReadTokens: M, ts: Date.now() }).costUsd).toBeCloseTo(cacheRead as number, 9);
  });

  test('zero-cost models.dev entries are free but keep the models.dev source', async () => {
    const h = await ready();
    for (const [raw, provider] of [['big-pickle', 'opencode'], ['minimaxai/minimax-m2.7', 'nvidia']] as const) {
      const m = await h.svc.resolveModel(raw, { provider });
      expect(m).toMatchObject({ priced: true, source: 'models.dev' });
      expect(cost(h, m, { inputTokens: 5 * M, outputTokens: M })).toMatchObject({ costUsd: 0, source: 'models.dev' });
    }
  });

  test('the free-model rule keeps working and reports free-model', async () => {
    const h = await ready();
    const free = await h.svc.resolveModel('minimax-m2.5-free', { provider: 'opencode' });
    expect(free).toMatchObject({ priced: true, source: 'free-model' });
    expect(cost(h, free, { inputTokens: M })).toEqual({ costUsd: 0, approx: false, source: 'free-model' });
    const local = await h.svc.resolveModel('gemma3:1b', { provider: 'ollama' });
    expect(cost(h, local, { inputTokens: M }).source).toBe('free-model');
  });

  test('missing cache rates map to the input rate, and say the estimate is approximate', async () => {
    const h = await ready(modelsDevDoc({ p: { m: { input: 2, output: 4 }, w: { input: 2, output: 4, cache_read: 0.2, cache_write: 2.5 } } }));
    const m = await h.svc.resolveModel('m', { provider: 'p' });
    const now = Date.now();
    expect(cost(h, m, { cacheReadTokens: M, ts: now })).toMatchObject({ costUsd: 2, approx: true });
    expect(cost(h, m, { cacheWrite5mTokens: M, cacheWrite1hTokens: M, ts: now })).toMatchObject({ costUsd: 4, approx: true });
    expect(cost(h, m, { inputTokens: M, ts: now }).approx).toBe(false);
    const w = await h.svc.resolveModel('w', { provider: 'p' });
    expect(cost(h, w, { cacheReadTokens: M, cacheWrite5mTokens: M, ts: now })).toMatchObject({ costUsd: 0.2 + 2.5, approx: false });
  });

  test('reasoning tokens are billed at the output rate', async () => {
    const h = await ready(modelsDevDoc({ p: { m: { input: 1, output: 10 } } }));
    const m = await h.svc.resolveModel('m', { provider: 'p' });
    expect(cost(h, m, { reasoningTokens: M, ts: Date.now() }).costUsd).toBe(10);
  });

  test('approx: events older than the fetch minus a day are less certain', async () => {
    const h = await ready();
    const m = await h.svc.resolveModel('gpt-5-nano', { provider: 'opencode' });
    const fetchedAt = modelsDevFetchedAt(h.db) as number;
    expect(cost(h, m, { inputTokens: M, ts: fetchedAt - DAY + 1 }).approx).toBe(false);
    expect(cost(h, m, { inputTokens: M, ts: fetchedAt - DAY - 1 }).approx).toBe(true);
    expect(cost(h, m, { inputTokens: M, ts: fetchedAt + DAY }).approx).toBe(false);
  });
});

describe('conservative: unresolved beats wrong', () => {
  test.each([
    ['gpt-5-mini', undefined], ['gemini-pro-latest', 'google'], ['z-ai/glm5', 'openrouter'], ['tencent/hy3', undefined],
    ['gpt-4o-2024-99-99', 'openai'], ['totally-unknown-model', 'opencode'],
  ])('%s (%p) stays unpriced, without a source', async (raw, provider) => {
    const h = await ready();
    const m = await h.svc.resolveModel(raw, { provider });
    expect(m.priced).toBe(false);
    expect(m.source).toBeUndefined();
    expect(cost(h, m, { inputTokens: M })).toEqual({ costUsd: null, approx: false });
  });

  test('antigravity internal ids use the public model named beside them', async () => {
    const h = await ready(modelsDevDoc({
      google: {
        'gemini-4-argon': { input: 2, output: 10, cache_read: 0.1 },
        'gemini-flash-latest': { input: 0.75, output: 3.75, cache_read: 0.075 },
        'gemini-3.8-flash': { input: 0.75, output: 3.75, cache_read: 0.075 },
      },
    }));
    const argon = await h.svc.resolveModel('gemini-pro-orchestrator-g1-pro', { provider: 'google' });
    expect(argon.priced).toBe(true);
    expect(cost(h, argon, { inputTokens: M, cacheReadTokens: M, ts: Date.now() }).costUsd).toBeCloseTo(2.1, 9);
    const flash = await h.svc.resolveModel('gemini-flash-worker-agy', { provider: 'google' });
    expect(cost(h, flash, { inputTokens: M, ts: Date.now() }).costUsd).toBeCloseTo(0.75, 9);
    const low = await h.svc.resolveModel('gemini-3.8-flash-low', { provider: 'google' });
    expect(cost(h, low, { inputTokens: M, outputTokens: M, ts: Date.now() }).costUsd).toBeCloseTo(4.5, 9);
    expect((await h.svc.resolveModel('o1-j92p-Q_MvK_BDAJ', { provider: 'google' })).priced).toBe(false);
    expect((await h.svc.resolveModel('gemini-flash-latest-extra', { provider: 'google' })).priced).toBe(false);
  });

  test('gpt-5-nano is not gpt-5, and gemini-flash-latest only matches its own entry', async () => {
    const h = await ready();
    const nano = await h.svc.resolveModel('gpt-5-nano');
    const full = await h.svc.resolveModel('gpt-5');
    expect(cost(h, nano, { inputTokens: M, ts: Date.now() }).costUsd).toBeCloseTo(0.05, 9);
    expect(cost(h, full, { inputTokens: M, ts: Date.now() }).costUsd).toBeCloseTo(1.25, 9);
    expect((await h.svc.resolveModel('gemini-flash-latest', { provider: 'google' })).priced).toBe(true);
    expect((await h.svc.resolveModel('gemini-flash-latest-extra', { provider: 'google' })).priced).toBe(false);
  });

  test('the provider hint selects the gateway own price over the maker price', async () => {
    const h = await ready();
    const viaGateway = await h.svc.resolveModel('gpt-5', { provider: 'opencode' });
    const maker = await h.svc.resolveModel('gpt-5', { provider: 'openai' });
    expect(cost(h, viaGateway, { inputTokens: M, ts: Date.now() }).costUsd).toBeCloseTo(1.07, 9);
    expect(cost(h, maker, { inputTokens: M, ts: Date.now() }).costUsd).toBeCloseTo(1.25, 9);
  });

  test('providers are separate memo keys: the same id can resolve differently per provider', async () => {
    const h = await ready();
    const a = await h.svc.resolveModel('gpt-5', { provider: 'opencode' });
    const b = await h.svc.resolveModel('gpt-5', { provider: 'openai' });
    expect(a).not.toBe(b);
    expect(await h.svc.resolveModel('gpt-5', { provider: 'opencode' })).toBe(a);
  });
});

describe('refresh of the models.dev layer', () => {
  test('stores the catalogue, the fetch time, and counts as a refresh when prices changed', async () => {
    const h = harness(openDb(':memory:'), priceDoc([SONNET]));
    h.setModelsDev(modelsDevFixture);
    const first = await h.svc.refreshIfStale();
    expect(first.refreshed).toBe(true);
    expect(loadExternalPrices(h.db).filter((e) => e.origin !== 'official')).toHaveLength(30);
    expect(modelsDevFetchedAt(h.db)).toBe(T0);

    h.clock.t = T0 + 2 * DAY;
    const same = await h.svc.refreshIfStale();
    expect(same.refreshed).toBe(false); // AWS unchanged and no models.dev price changed
    expect(modelsDevFetchedAt(h.db)).toBe(T0 + 2 * DAY);

    h.setModelsDev(modelsDevDoc({ opencode: { 'gpt-5-nano': { input: 0.06, output: 0.4 } } }));
    h.clock.t = T0 + 4 * DAY;
    expect((await h.svc.refreshIfStale()).refreshed).toBe(true);
    const m = await h.svc.resolveModel('gpt-5-nano', { provider: 'opencode' });
    expect(cost(h, m, { inputTokens: M, ts: Date.now() }).costUsd).toBeCloseTo(0.06, 9);
  });

  test('not refetched while fresh', async () => {
    const h = await ready();
    const calls = h.allCalls.length;
    h.clock.t = T0 + DAY - 1;
    await h.svc.refreshIfStale();
    expect(h.allCalls.length).toBe(calls);
  });

  test('deprecated models stay priceable after they vanish from the catalogue', async () => {
    const h = await ready(modelsDevDoc({ opencode: { 'old-model': { input: 1, output: 2 }, 'kept-model': { input: 3, output: 4 } } }));
    h.setModelsDev(modelsDevDoc({ opencode: { 'kept-model': { input: 3, output: 4 } } }));
    h.clock.t = T0 + 2 * DAY;
    await h.svc.refreshIfStale();
    const old = await h.svc.resolveModel('old-model', { provider: 'opencode' });
    expect(old).toMatchObject({ priced: true, source: 'models.dev' });
    expect(cost(h, old, { inputTokens: M, ts: Date.now() }).costUsd).toBeCloseTo(1, 9);
  });

  test('a failed fetch keeps the old rows, reports the error, and is retried within the hour', async () => {
    const h = await ready();
    const before = loadExternalPrices(h.db);
    h.setStatus(503, 'modelsDev');
    h.clock.t = T0 + 2 * DAY;
    const r = await h.svc.refreshIfStale();
    expect(r.error).toBe('models.dev: price list fetch failed: HTTP 503');
    expect(loadExternalPrices(h.db)).toEqual(before);
    expect(modelsDevFetchedAt(h.db)).toBe(T0);
    expect(pricingLastError(h.db)).toContain('models.dev');

    const calls = h.allCalls.length;
    h.clock.t += 30 * 60 * 1000;
    await h.svc.refreshIfStale();
    expect(h.allCalls.length).toBe(calls); // inside the retry window

    h.setStatus(200);
    h.clock.t += 31 * 60 * 1000;
    const again = await h.svc.refreshIfStale();
    expect(again.error).toBeUndefined();
    expect(h.allCalls.slice(calls)).toEqual(['https://models.dev/api.json']); // only the failed layer is refetched
    expect(pricingLastError(h.db)).toBeUndefined();
  });

  test.each([
    ['not an object', '[1,2]', 'not a models.dev document'],
    ['no prices at all', JSON.stringify({ a: { models: { m: { name: 'x' } } } }), 'price list contained no token prices'],
    ['invalid json', '{oops', undefined],
  ])('a bad document (%s) never replaces existing rows', async (_name, body, message) => {
    const h = await ready();
    const before = loadExternalPrices(h.db);
    h.setModelsDev(body);
    h.clock.t = T0 + 2 * DAY;
    const r = await h.svc.refreshIfStale();
    expect(r.error).toContain('models.dev:');
    if (message) expect(r.error).toContain(message);
    expect(loadExternalPrices(h.db)).toEqual(before);
  });

  test('a failing models.dev does not affect the AWS layers, and vice versa', async () => {
    const h = harness(openDb(':memory:'), priceDoc([SONNET]));
    h.setStatus(503, 'modelsDev');
    const r = await h.svc.refreshIfStale();
    expect(r.refreshed).toBe(true); // AWS snapshot was written
    expect(r.error).toBe('models.dev: price list fetch failed: HTTP 503');
    expect((await h.svc.resolveModel('claude-sonnet-5-5')).source).toBe('aws-price-list');
    expect((await h.svc.resolveModel('gpt-5-nano', { provider: 'opencode' })).priced).toBe(false);

    const h2 = harness(openDb(':memory:'), priceDoc([SONNET]));
    h2.setStatus(503);
    h2.setModelsDev(modelsDevFixture);
    h2.setStatus(200, 'modelsDev');
    const r2 = await h2.svc.refreshIfStale();
    expect(r2.error).toContain('foundation-models');
    expect(r2.refreshed).toBe(true); // models.dev prices arrived
    expect((await h2.svc.resolveModel('gpt-5-nano', { provider: 'opencode' })).source).toBe('models.dev');
  });

  test('a model that was unpriced becomes priced after the catalogue gains it, without waiting for an AWS snapshot', async () => {
    const h = await ready(modelsDevDoc({ p: { known: { input: 1, output: 2 } } }));
    expect((await h.svc.resolveModel('newcomer', { provider: 'p' })).priced).toBe(false);
    h.setModelsDev(modelsDevDoc({ p: { known: { input: 1, output: 2 }, newcomer: { input: 5, output: 6 } } }));
    h.clock.t = T0 + 2 * DAY;
    await h.svc.refreshIfStale();
    expect(await h.svc.resolveModel('newcomer', { provider: 'p' })).toMatchObject({ priced: true, source: 'models.dev' });
  });

  test('unpriced results are never persisted, so nothing stale survives a restart', async () => {
    const h = await ready();
    await h.svc.resolveModel('totally-unknown-model');
    expect(h.db.query('SELECT COUNT(*) c FROM model_cache').get()).toEqual({ c: 0 });
    await h.svc.resolveModel('gpt-5-nano', { provider: 'opencode' });
    expect(h.db.query('SELECT COUNT(*) c FROM model_cache').get()).toEqual({ c: 0 }); // models.dev results are not cached either
  });
});
