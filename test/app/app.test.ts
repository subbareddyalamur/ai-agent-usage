import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/app';
import { summary } from '../../src/core/query';
import type { PricingService } from '../../src/core/types';
import { fakePricing } from '../helpers';

function adapterDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'app-adapters-'));
  writeFileSync(join(dir, 'fake.ts'), `
    export default {
      id: 'fake', label: 'Fake',
      detect: async () => ({ installed: true, detail: 'fixture' }),
      ingest: async function* () {
        yield { type: 'event', event: { id: 'e1', agent: 'fake', sessionId: 's', ts: 1700000000000, modelRaw: 'm', inputTokens: 10, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, isSubagent: false, kind: 'step', tools: [] } };
      },
    };`);
  writeFileSync(join(dir, 'broken.ts'), `export default { nope: true };`);
  return dir;
}

describe('createApp', () => {
  test('wires discovery, pricing refresh, ingest and repricing', async () => {
    let refreshes = 0;
    const base = fakePricing();
    const pricing: PricingService = { ...base, async refreshIfStale() { refreshes++; return { refreshed: true, snapshotId: 1 }; } };
    const app = await createApp({ dbPath: ':memory:', home: '/h', adapterDir: adapterDir(), pricing });
    expect(app.adapters.map((a) => a.id)).toEqual(['fake']);
    expect(app.problems.length).toBe(1);
    const res = await app.ingestAll();
    expect(refreshes).toBe(1);
    expect(res.priceRefresh).toEqual({ refreshed: true, snapshotId: 1 });
    expect(res.reports).toEqual([{ id: 'fake', installed: true, events: 1 }]);
    expect(res.repriced).toBe(0);
    expect(summary(app.db, {}).totals.events).toBe(1);
    app.close();
  });

  test('concurrent ingestAll calls share one run, later calls start a new one', async () => {
    let refreshes = 0;
    const pricing: PricingService = { ...fakePricing(), async refreshIfStale() { refreshes++; return { refreshed: false }; } };
    const app = await createApp({ dbPath: ':memory:', home: '/h', adapterDir: adapterDir(), pricing });
    const [a, b] = await Promise.all([app.ingestAll(), app.ingestAll()]);
    expect(a).toBe(b);
    await app.ingestAll();
    expect(refreshes).toBe(2);
    app.close();
  });

  test('events unpriced at first ingest are priced once the model becomes priceable', async () => {
    let priced = false;
    const pricing: PricingService = {
      ...fakePricing(),
      async resolveModel(raw) { return { canonical: raw, priced, tier: 'regional' }; },
      priceEvent: (m) => (m.priced ? { costUsd: 0.5, approx: false } : { costUsd: null, approx: false }),
    };
    const app = await createApp({ dbPath: ':memory:', home: '/h', adapterDir: adapterDir(), pricing });
    await app.ingestAll();
    expect(summary(app.db, {}).totals.unpricedEvents).toBe(1);
    priced = true;
    const res = await app.ingestAll();
    expect(res.repriced).toBe(0); // the re-ingest itself already priced it
    expect(summary(app.db, {}).totals.costUsd).toBe(0.5);
    app.close();
  });

  test('defaults: real pricing service and the built-in adapters on an empty home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'empty-home-'));
    const app = await createApp({ dbPath: ':memory:', home });
    expect(app.adapters.length).toBeGreaterThanOrEqual(1);
    expect(typeof app.pricing.priceEvent).toBe('function');
    app.close();
  });
});
