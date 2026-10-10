import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/core/db';
import { PRICE_LIST_URL, createPricingService, pricingLastError } from '../../src/core/pricing';
import { latestRates, pricingStatus } from '../../src/core/rates';
import type { PriceInput } from '../../src/core/types';
import fixture from '../fixtures/price-list-mini.json';
import { DAY, T0, harness, priceDoc } from './pricing-helpers';

const SONNET = { model: 'Claude Sonnet 5.5', rates: { input: 2.2, output: 11, cacheRead: 0.11, cw5m: 2.75, cw1h: 4.4 } };
const zero: PriceInput = {
  ts: T0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
};
const M = 1_000_000;
const count = (db: ReturnType<typeof openDb>, table: string): number =>
  (db.query(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;

describe('refreshIfStale', () => {
  test('first call fetches and stores a snapshot with its rows', async () => {
    const h = harness(openDb(':memory:'), priceDoc([SONNET]));
    const r = await h.svc.refreshIfStale();
    expect(r.refreshed).toBe(true);
    expect(h.fetchCalls).toEqual([PRICE_LIST_URL]);
    expect(count(h.db, 'price_snapshots')).toBe(1);
    expect(count(h.db, 'prices')).toBe(5 + 2); // Sonnet 5.5 + default DeepSeek rows
    expect(h.db.query('SELECT fetched_at f, last_checked_at c, publication_date p FROM price_snapshots').get()).toEqual({ f: T0, c: T0, p: '2026-10-01T00:00:00Z' });
  });

  test('is a no-op while the newest check is fresh, and force bypasses that', async () => {
    const h = harness(openDb(':memory:'), priceDoc([SONNET]));
    await h.svc.refreshIfStale();
    h.clock.t = T0 + DAY - 1;
    expect((await h.svc.refreshIfStale()).refreshed).toBe(false);
    expect(h.fetchCalls).toHaveLength(1);
    await h.svc.refreshIfStale({ force: true });
    expect(h.fetchCalls).toHaveLength(2);
    await h.svc.refreshIfStale({ maxAgeMs: 0 });
    expect(h.fetchCalls).toHaveLength(3);
  });

  test('identical content only bumps last_checked_at (no duplicate snapshot)', async () => {
    const h = harness(openDb(':memory:'), priceDoc([SONNET]));
    await h.svc.refreshIfStale();
    h.clock.t = T0 + 2 * DAY;
    const r = await h.svc.refreshIfStale();
    expect(r.refreshed).toBe(false);
    expect(r.snapshotId).toBe(1);
    expect(count(h.db, 'price_snapshots')).toBe(1);
    expect(h.db.query('SELECT fetched_at f, last_checked_at c FROM price_snapshots').get()).toEqual({ f: T0, c: T0 + 2 * DAY });
  });

  test('changed prices create a new snapshot and keep the old one', async () => {
    const h = harness(openDb(':memory:'), priceDoc([SONNET]));
    await h.svc.refreshIfStale();
    h.setDoc(priceDoc([{ ...SONNET, rates: { ...SONNET.rates, input: 3.3 } }]));
    h.clock.t = T0 + 2 * DAY;
    const r = await h.svc.refreshIfStale();
    expect(r).toEqual({ refreshed: true, snapshotId: 2 });
    expect(count(h.db, 'price_snapshots')).toBe(2);
    expect(count(h.db, 'prices')).toBe(14);
  });

  test('failures never throw, keep the last snapshot and record the error', async () => {
    const h = harness(openDb(':memory:'), priceDoc([SONNET]));
    await h.svc.refreshIfStale();
    h.clock.t = T0 + 2 * DAY;

    h.setStatus(503);
    const failed = await h.svc.refreshIfStale();
    expect(failed.refreshed).toBe(false);
    expect(failed.error).toContain('price list fetch failed: HTTP 503');
    expect(pricingLastError(h.db)).toContain('503');

    h.setStatus(200);
    h.setBody('{not json');
    h.setStatus(503, 'bedrock');
    expect((await h.svc.refreshIfStale()).error).toContain('foundation-models');
    h.setBody(JSON.stringify({ products: {}, terms: { OnDemand: {} } }));
    expect((await h.svc.refreshIfStale()).error).toContain('no token prices');
    h.setBody(JSON.stringify([1]));
    expect((await h.svc.refreshIfStale()).error).toBeDefined();
    h.setStatus(200);

    expect(count(h.db, 'price_snapshots')).toBe(1);
    h.setDoc(priceDoc([SONNET]));
    await h.svc.refreshIfStale();
    expect(pricingLastError(h.db)).toBeUndefined();
  });

  test('network exceptions are caught', async () => {
    const db = openDb(':memory:');
    const svc = createPricingService(db, { fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
    expect(await svc.refreshIfStale()).toEqual({ refreshed: false, error: 'foundation-models: offline; bedrock: offline' });
  });

  test('concurrent calls share one fetch', async () => {
    const h = harness(openDb(':memory:'), priceDoc([SONNET]));
    const [a, b] = await Promise.all([h.svc.refreshIfStale(), h.svc.refreshIfStale()]);
    expect(a).toEqual(b);
    expect(h.fetchCalls).toHaveLength(1);
  });

  test('works with the real-shaped fixture and feeds rates.ts', async () => {
    const h = harness(openDb(':memory:'), fixture);
    await h.svc.refreshIfStale();
    expect(latestRates(h.db, 'Claude Sonnet 5.5', 'regional')).toEqual({ input: 2.2, output: 11, cacheRead: 0.11, cacheWrite5m: 2.75, cacheWrite1h: 4.4 });
    expect(latestRates(h.db, 'Claude Sonnet 5.5', 'global')?.input).toBe(2);
    const status = pricingStatus(h.db, T0 + 1000);
    expect(status).toMatchObject({ snapshots: 1, stale: false, latestSnapshotAt: T0 });
    expect(status.modelsPriced).toBe(6);
  });
});

describe('priceEvent', () => {
  async function twoSnapshots() {
    const h = harness(openDb(':memory:'), priceDoc([SONNET]));
    await h.svc.refreshIfStale();
    h.setDoc(priceDoc([{ ...SONNET, rates: { input: 3.3, output: 16.5, cacheRead: 0.33, cw5m: 4.125, cw1h: 6.6 } }]));
    h.clock.t = T0 + 10 * DAY;
    await h.svc.refreshIfStale();
    const model = await h.svc.resolveModel('claude-sonnet-5-5');
    return { h, model };
  }

  test('bills every token class at its own rate (reasoning at the output rate)', async () => {
    const h = harness(openDb(':memory:'), priceDoc([SONNET]));
    await h.svc.refreshIfStale();
    const model = await h.svc.resolveModel('claude-sonnet-5-5');
    const r = h.svc.priceEvent(model, {
      ts: T0 + 1, inputTokens: M, outputTokens: M, reasoningTokens: M, cacheReadTokens: M, cacheWrite5mTokens: M, cacheWrite1hTokens: M,
    });
    expect(r.costUsd).toBeCloseTo(2.2 + 11 + 11 + 0.11 + 2.75 + 4.4, 9);
    expect(r.approx).toBe(false);
  });

  test('uses the snapshot in effect at the event time', async () => {
    const { h, model } = await twoSnapshots();
    const at = (ts: number) => h.svc.priceEvent(model, { ...zero, ts, inputTokens: M });
    expect(at(T0 + 5 * DAY)).toEqual({ costUsd: 2.2, approx: false });
    expect(at(T0 + 10 * DAY)).toEqual({ costUsd: 3.3, approx: false });
    expect(at(T0 + 30 * DAY)).toEqual({ costUsd: 3.3, approx: false });
  });

  test('events before the first snapshot use the earliest one and are flagged approximate', async () => {
    const { h, model } = await twoSnapshots();
    expect(h.svc.priceEvent(model, { ...zero, ts: T0 - 90 * DAY, inputTokens: M })).toEqual({ costUsd: 2.2, approx: true });
  });

  test('global tier uses global rates, falling back (approx) to regional when absent', async () => {
    const h = harness(
      openDb(':memory:'),
      priceDoc([
        { model: 'Claude Sonnet 5.5', rates: { input: 2, output: 10 }, tier: 'global' },
        { model: 'Claude Sonnet 5.5', rates: { input: 2.2, output: 11 } },
        { model: 'Old Model', rates: { input: 3, output: 15 } },
      ]),
    );
    await h.svc.refreshIfStale();
    const g = await h.svc.resolveModel('global.anthropic.claude-sonnet-5-5');
    expect(g.tier).toBe('global');
    expect(h.svc.priceEvent(g, { ...zero, inputTokens: M })).toEqual({ costUsd: 2, approx: false });
    expect(h.svc.priceEvent({ canonical: 'Old Model', priced: true, tier: 'global' }, { ...zero, inputTokens: M })).toEqual({ costUsd: 3, approx: true });
  });

  test('falls back to another region when the default region has no price', async () => {
    const h = harness(openDb(':memory:'), priceDoc([{ model: 'Only West', rates: { input: 1, output: 2 }, region: 'us-west-2' }]));
    await h.svc.refreshIfStale();
    const r = h.svc.priceEvent({ canonical: 'Only West', priced: true, tier: 'regional' }, { ...zero, inputTokens: M });
    expect(r).toEqual({ costUsd: 1, approx: true });
  });

  test('a model missing from the in-effect snapshot is priced from the nearest snapshot that has it', async () => {
    const h = harness(openDb(':memory:'), priceDoc([SONNET]));
    await h.svc.refreshIfStale();
    h.setDoc(priceDoc([SONNET, { model: 'Late Model', rates: { input: 7, output: 9 } }]));
    h.clock.t = T0 + 10 * DAY;
    await h.svc.refreshIfStale();
    const model = { canonical: 'Late Model', priced: true, tier: 'regional' as const };
    expect(h.svc.priceEvent(model, { ...zero, ts: T0 + 1 * DAY, inputTokens: M })).toEqual({ costUsd: 7, approx: true });
  });

  test('deprecated models stay priceable from the last snapshot that listed them', async () => {
    const h = harness(openDb(':memory:'), priceDoc([SONNET, { model: 'Claude 3 Haiku', rates: { input: 0.25, output: 1.25 } }]));
    await h.svc.refreshIfStale();
    h.setDoc(priceDoc([SONNET]));
    h.clock.t = T0 + 10 * DAY;
    await h.svc.refreshIfStale();
    const model = await h.svc.resolveModel('anthropic.claude-3-haiku-20240307-v1:0');
    expect(model).toEqual({ canonical: 'Claude 3 Haiku', priced: true, tier: 'regional' });
    expect(h.svc.priceEvent(model, { ...zero, ts: T0 + 20 * DAY, inputTokens: M })).toEqual({ costUsd: 0.25, approx: true });
  });

  test('1h cache writes fall back to the 5m rate only when no 1h rate exists', async () => {
    const h = harness(
      openDb(':memory:'),
      priceDoc([
        { model: 'With1h', rates: { input: 1, output: 2, cw5m: 1.25, cw1h: 2 } },
        { model: 'No1h', rates: { input: 1, output: 2, cw5m: 1.25 } },
      ]),
    );
    await h.svc.refreshIfStale();
    const cw1h = { ...zero, cacheWrite1hTokens: M };
    expect(h.svc.priceEvent({ canonical: 'With1h', priced: true, tier: 'regional' }, cw1h)).toEqual({ costUsd: 2, approx: false });
    expect(h.svc.priceEvent({ canonical: 'No1h', priced: true, tier: 'regional' }, cw1h)).toEqual({ costUsd: 1.25, approx: false });
  });

  test('missing cache rates fall back to the input rate and mark the estimate approximate', async () => {
    const h = harness(openDb(':memory:'), priceDoc([{ model: 'NoCache', rates: { input: 1, output: 2 } }]));
    await h.svc.refreshIfStale();
    const m = { canonical: 'NoCache', priced: true, tier: 'regional' as const };
    expect(h.svc.priceEvent(m, { ...zero, cacheReadTokens: M })).toEqual({ costUsd: 1, approx: true });
    expect(h.svc.priceEvent(m, { ...zero, cacheWrite1hTokens: M })).toEqual({ costUsd: 1, approx: true });
    expect(h.svc.priceEvent(m, { ...zero, inputTokens: M })).toEqual({ costUsd: 1, approx: false });
  });

  test('unpriced or unknown models, and an empty price book, give null', async () => {
    const h = harness(openDb(':memory:'), priceDoc([SONNET]));
    expect(h.svc.priceEvent({ canonical: 'x', priced: true, tier: 'regional' }, zero)).toEqual({ costUsd: null, approx: false });
    await h.svc.refreshIfStale();
    expect(h.svc.priceEvent({ canonical: 'x', priced: false, tier: 'regional' }, zero)).toEqual({ costUsd: null, approx: false });
    expect(h.svc.priceEvent({ canonical: 'Not In Book', priced: true, tier: 'regional' }, zero)).toEqual({ costUsd: null, approx: false });
  });

  test('rows without both input and output rates are not usable', async () => {
    const h = harness(openDb(':memory:'), priceDoc([{ model: 'Half', rates: { input: 1, output: undefined as unknown as number } }]));
    await h.svc.refreshIfStale();
    expect(h.svc.priceEvent({ canonical: 'Half', priced: true, tier: 'regional' }, zero).costUsd).toBeNull();
  });
});
