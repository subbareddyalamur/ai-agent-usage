import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/core/db';
import { repriceUnpriced } from '../../src/core/ingest';
import { loadExternalPrices } from '../../src/core/pricing-modelsdev';
import { parseOfficial, priceInEffect } from '../../src/core/pricing-official';
import type { PriceInput } from '../../src/core/types';
import { DAY, T0, harness, modelsDevDoc, priceDoc } from './pricing-helpers';

const M = 1_000_000;
const JAN_2027 = Date.UTC(2027, 0, 1);
const zero: PriceInput = {
  ts: T0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
  cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
};

const GOOGLE = `## Gemini 4 Argon
*[\`gemini-4-argon\`](/docs/x)*
{% tab title="Standard" %}
* Input price
* Free of charge
* $0.75 through December 31, 2026.
  $1.50 starting January 1, 2027.
---
* Output price
* Free of charge
* $3.00
---
* Context caching price
* Free of charge
* $0.075
{% /tab %}
## Storage
*[\`gemini-4-argon\`](/docs/x)*
{% tab title="Standard" %}
* Storage price
* Free of charge
* $4.50 per hour
{% /tab %}
`;

const ANTHROPIC = `| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Opus 4.6 | $4 / MTok | $5 / MTok | $8 / MTok | $0.40 / MTok | $20 / MTok |
| Claude Opus 4.6 (over 100,000 input tokens) | $8 / MTok | $10 / MTok | $16 / MTok | $0.80 / MTok | $40 / MTok |
`;

const OPENAI = `| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-5.5 (<272K context length) | $1.25 | $10.00 | $0.125 |
Batch
| Model | Input | Output |
| --- | --- | --- |
| gpt-5.5 | $0.01 | $0.02 |
| gpt-batch-only | $0.01 | $0.02 |
`;

const XAI = `### Text API Pricing
| Model | Context | Input / 1M tokens | Cached input / 1M tokens | Output / 1M tokens |
| --- | --- | --- | --- | --- |
| grok-4.7 (< 200k prompt tokens) | 200k | $2.00 | $0.50 | $6.00 |
| grok-4.7 (≥ 200k prompt tokens) | 1M | $9.00 | $4.00 | $18.00 |
### Image
| Model | Input / 1M tokens | Output / 1M tokens |
| --- | --- | --- |
| grok-image | $99 | $99 |
`;

describe('official pricing pages', () => {
  test('a dated Google cell uses the rate in effect, and ignores a later one', () => {
    const cell = '$0.75 through December 31, 2026, then $1.50 starting January 1, 2027';
    expect(priceInEffect(cell, T0)).toBe(0.75);
    expect(priceInEffect(cell, JAN_2027)).toBe(1.5);
  });

  test('each page keeps the standard short-context rate', () => {
    const google = parseOfficial('google', GOOGLE, T0);
    expect(google).toEqual([
      expect.objectContaining({ provider: 'google', modelId: 'gemini-4-argon', input: 0.75, output: 3, cacheRead: 0.075, origin: 'official' }),
    ]);
    expect(parseOfficial('google', GOOGLE, JAN_2027)[0]?.input).toBe(1.5);

    const anthropic = parseOfficial('anthropic', ANTHROPIC, T0);
    expect(anthropic).toHaveLength(1);
    expect(anthropic[0]).toMatchObject({ modelId: 'claude-opus-4-6', input: 4, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.4, output: 20 });

    const openai = parseOfficial('openai', OPENAI, T0);
    expect(openai.map((e) => e.modelId)).toEqual(['gpt-5.5']);
    expect(openai[0]).toMatchObject({ input: 1.25, output: 10, cacheRead: 0.125 });

    const xai = parseOfficial('xai', XAI, T0);
    expect(xai).toHaveLength(1);
    expect(xai[0]).toMatchObject({ modelId: 'grok-4.7', input: 2, cacheRead: 0.5, output: 6 });
  });

  test('an official rate wins over models.dev, and models.dev still prices what the page omits', async () => {
    const h = harness(openDb(':memory:'), priceDoc([{ model: 'Claude Sonnet 5.5', rates: { input: 2.2, output: 11 } }]));
    h.setOfficial('google', GOOGLE);
    h.setModelsDev(modelsDevDoc({
      google: {
        'gemini-4-argon': { input: 9, output: 9 },
        'gemini-flash-latest': { input: 0.3, output: 2.5 },
      },
    }));
    await h.svc.refreshIfStale();

    const argon = await h.svc.resolveModel('gemini-4-argon');
    expect(argon.source).toBe('official');
    expect(h.svc.priceEvent(argon, { ...zero, inputTokens: M }).costUsd).toBeCloseTo(0.75, 9);

    const flash = await h.svc.resolveModel('gemini-flash-latest');
    expect(flash.source).toBe('models.dev');
    expect(h.svc.priceEvent(flash, { ...zero, inputTokens: M }).costUsd).toBeCloseTo(0.3, 9);
  });

  test('a 1-hour cache write uses the 1-hour rate', async () => {
    const h = harness(openDb(':memory:'), priceDoc([]));
    h.setOfficial('anthropic', ANTHROPIC);
    await h.svc.refreshIfStale();
    const m = await h.svc.resolveModel('claude-opus-4-6');
    const priced = h.svc.priceEvent(m, { ...zero, cacheWrite5mTokens: M, cacheWrite1hTokens: M });
    expect(priced).toMatchObject({ source: 'official', costUsd: 5 + 8 });
  });

  test('a failed official fetch keeps the previous rate and leaves AWS prices alone', async () => {
    const h = harness(openDb(':memory:'), priceDoc([{ model: 'Claude Sonnet 5.5', rates: { input: 2.2, output: 11 } }]));
    h.setOfficial('google', GOOGLE);
    h.setModelsDev(modelsDevDoc({ google: { 'gemini-4-argon': { input: 9, output: 9 } } }));
    await h.svc.refreshIfStale();

    h.setOfficial('google', 'this page has no prices');
    h.setModelsDev(modelsDevDoc({ google: { 'gemini-4-argon': { input: 8, output: 8 } } }));
    h.clock.t = T0 + 2 * DAY;
    const r = await h.svc.refreshIfStale();
    expect(r.error).toContain('google:');

    const argon = await h.svc.resolveModel('gemini-4-argon');
    expect(h.svc.priceEvent(argon, { ...zero, ts: h.clock.t, inputTokens: M }).costUsd).toBeCloseTo(0.75, 9);
    expect(loadExternalPrices(h.db).find((e) => e.modelId === 'gemini-4-argon')?.origin).toBe('official');

    const sonnet = await h.svc.resolveModel('claude-sonnet-5-5');
    expect(h.svc.priceEvent(sonnet, { ...zero, ts: h.clock.t, inputTokens: M })).toMatchObject({ costUsd: 2.2, source: 'aws-price-list' });
  });

  test('a later official rate does not rewrite a call that already has a price', async () => {
    const h = harness(openDb(':memory:'), priceDoc([]));
    h.setOfficial('google', GOOGLE);
    await h.svc.refreshIfStale();
    h.db.run(
      `INSERT INTO events (id, agent, session_id, ts, model_raw, model, provider, input_tokens, cost_usd, cost_source, priced, ingested_at)
       VALUES ('kept', 'a', 's', ?, 'gemini-4-argon', 'gemini-4-argon', 'google', ?, 9, 'models.dev', 1, ?)`,
      [T0, M, T0],
    );
    h.db.run(
      `INSERT INTO events (id, agent, session_id, ts, model_raw, model, provider, input_tokens, priced, ingested_at)
       VALUES ('new', 'a', 's', ?, 'gemini-4-argon', 'gemini-4-argon', 'google', ?, 0, ?)`,
      [T0, M, T0],
    );
    h.clock.t = JAN_2027;
    h.setOfficial('google', GOOGLE);
    await h.svc.refreshIfStale();
    expect(await repriceUnpriced(h.db, h.svc)).toBe(1);
    const rows = h.db.query('SELECT id, cost_usd AS cost, cost_source AS source FROM events ORDER BY id').all() as Array<{ id: string; cost: number; source: string }>;
    expect(rows.find((r) => r.id === 'kept')).toEqual({ id: 'kept', cost: 9, source: 'models.dev' });
    expect(rows.find((r) => r.id === 'new')?.source).toBe('official');
    expect(rows.find((r) => r.id === 'new')?.cost).toBeCloseTo(1.5, 9);
  });
});
