import type { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRICE_LIST_URL, PRICE_SOURCES, createPricingService, type PricingOptions } from '../../src/core/pricing';
import { MODELS_DEV_URL } from '../../src/core/pricing-modelsdev';
import { OFFICIAL_FEEDS } from '../../src/core/pricing-official';
import { PAGE_URL, feedUrl } from '../../src/core/pricing-page';
import type { ExecFn } from '../../src/core/arn';
import type { PricingService } from '../../src/core/types';

export { PRICE_LIST_URL };
export const DAY = 24 * 3600 * 1000;
export const T0 = Date.UTC(2026, 9, 1);

export interface Rates {
  input: number;
  output: number;
  cacheRead?: number;
  cw5m?: number;
  cw1h?: number;
}

type Item = { model: string; region: string; usagetype: string; type: string; usd: number; unit: string };

/** Builds a minimal AWS-price-list-shaped document for the given models. */
export function priceDoc(
  models: ReadonlyArray<{ model: string; rates: Rates; region?: string; tier?: 'regional' | 'global' }>,
  extra: ReadonlyArray<Partial<Item> & { model: string }> = [],
): unknown {
  const items: Item[] = [];
  for (const m of models) {
    const region = m.region ?? 'us-east-1';
    const g = m.tier === 'global' ? '_global' : '';
    const base = (usagetype: string, type: string, usd: number | undefined): void => {
      if (usd !== undefined) items.push({ model: m.model, region, usagetype: `USE1-MP:USE1_${usagetype}-Units`, type, usd, unit: '1M tokens' });
    };
    base(`input_tokens${g}_standard`, 'Input tokens', m.rates.input);
    base(`output_tokens${g}_standard`, 'Output tokens', m.rates.output);
    base(`cache_read_tokens${g}_standard`, 'Prompt cache read input tokens', m.rates.cacheRead);
    base(`cache_write_tokens${g}_standard`, 'Prompt cache write input tokens', m.rates.cw5m);
    base(`cache_write_tokens_1h${g}_standard`, 'Prompt cache write input tokens', m.rates.cw1h);
  }
  for (const e of extra) {
    items.push({ region: 'us-east-1', usagetype: 'USE1-MP:USE1_input_tokens_standard-Units', type: 'Input tokens', usd: 1, unit: '1M tokens', ...e });
  }
  const products: Record<string, unknown> = {};
  const onDemand: Record<string, unknown> = {};
  items.forEach((it, i) => {
    const sku = `SKU${i}`;
    products[sku] = { attributes: { model: it.model, regionCode: it.region, inferenceType: it.type, usagetype: it.usagetype } };
    onDemand[sku] = { t: { priceDimensions: { d: { unit: it.unit, pricePerUnit: { USD: String(it.usd) } } } } };
  });
  return { publicationDate: '2026-10-01T00:00:00Z', products, terms: { OnDemand: onDemand } };
}

/** Minimal AmazonBedrock-offer-shaped document: per-1K-token units, inferenceType + service_tier attributes. */
export function bedrockDoc(
  models: ReadonlyArray<{ model: string; inputPerMtok: number; outputPerMtok: number; region?: string }>,
  extra: ReadonlyArray<{ model: string; region?: string; usagetype: string; inferenceType: string | null; tier?: string | null; usdPer1k: number; unit?: string }> = [],
): unknown {
  const items = [
    ...extra.map((e) => ({ unit: '1K tokens', tier: null as string | null, region: 'us-east-1', ...e })),
    ...models.flatMap((m) => [
      { model: m.model, region: m.region ?? 'us-east-1', usagetype: 'USE1-x-input-tokens', inferenceType: 'Input tokens' as string | null, tier: null as string | null, usdPer1k: m.inputPerMtok / 1000, unit: '1K tokens' },
      { model: m.model, region: m.region ?? 'us-east-1', usagetype: 'USE1-x-output-tokens', inferenceType: 'Output tokens' as string | null, tier: null as string | null, usdPer1k: m.outputPerMtok / 1000, unit: '1K tokens' },
    ]),
  ];
  const products: Record<string, unknown> = {};
  const onDemand: Record<string, unknown> = {};
  items.forEach((it, i) => {
    const sku = `B${i}`;
    products[sku] = { attributes: { model: it.model, regionCode: it.region, inferenceType: it.inferenceType, usagetype: it.usagetype, service_tier: it.tier } };
    onDemand[sku] = { t: { priceDimensions: { d: { unit: it.unit, pricePerUnit: { USD: String(it.usdPer1k) } } } } };
  });
  return { publicationDate: '2026-10-02T00:00:00Z', products, terms: { OnDemand: onDemand } };
}

/** Smallest valid pricing page: one inference-option table (Z AI > Zed 1) with global and US CRIS rows. */
export function pageHtml(model = 'Zed 1', input = 1, output = 2): string {
  const row = (label: string, i: number, o: number): string => `<tr><td>${label}</td><td>$ ${i}</td><td>$ ${o}</td></tr>`;
  const tab = (n: number, panel: string, label: string): string => `<li role="tab" aria-controls="${panel}" id="t${n}">${label}</li>`;
  return `<html><body><ul role="tablist">${tab(1, 'x-panel-1', 'Model Pricing')}</ul>
  <div id="x-panel-1"><ul role="tablist">${tab(2, 'x-panel-2', 'Z AI')}</ul>
  <div id="x-panel-2"><ul role="tablist">${tab(3, 'x-panel-3', model)}</ul>
  <div id="x-panel-3"><table><tbody><tr><td>Inference option</td><td>Price per 1M input tokens</td><td>Price per 1M output tokens</td></tr>
  ${row('Global CRIS', input, output)}${row('US CRIS', input * 1.1, output * 1.1)}</tbody></table></div></div></div></body></html>`;
}

/** Smallest valid models.dev document. */
export function modelsDevDoc(
  providers: Record<string, Record<string, { input: number; output: number; cache_read?: number; cache_write?: number } | null>> = {
    testprov: { 'default-md-model': { input: 1, output: 2 } },
  },
): unknown {
  return Object.fromEntries(
    Object.entries(providers).map(([id, models]) => [
      id,
      { id, name: id, models: Object.fromEntries(Object.entries(models).map(([m, cost]) => [m, { id: m, name: m, ...(cost ? { cost } : {}) }])) },
    ]),
  );
}

export const DEFAULT_BEDROCK = bedrockDoc([{ model: 'DeepSeek v3.2', inputPerMtok: 0.62, outputPerMtok: 1.85 }]);

/** One unused model per official page, so existing tests keep parsing a real price list. */
const OFFICIAL_DEFAULT: Record<string, string> = {
  google: `## Placeholder
*[\`gemini-placeholder-official\`](/docs/x)*
{% tab title="Standard" %}
* Input price
* Free of charge
* $1.00
---
* Output price
* Free of charge
* $2.00
{% /tab %}
`,
  anthropic: `| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Placeholder Official | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.10 / MTok | $2 / MTok |
`,
  openai: `| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-placeholder-official | $1.00 | $2.00 | $0.10 |
`,
  xai: `### Text API Pricing
| Model | Context | Input / 1M tokens | Cached input / 1M tokens | Output / 1M tokens |
| --- | --- | --- | --- | --- |
| grok-placeholder-official (< 200k prompt tokens) | 1k | $1.00 | $0.10 | $2.00 |
| grok-placeholder-official (≥ 200k prompt tokens) | 1k | $9.00 | $9.00 | $9.00 |
`,
};
const BEDROCK_URL = (PRICE_SOURCES[1] as { url: string }).url;

export interface Harness {
  db: Database;
  svc: PricingService;
  clock: { t: number };
  fetchCalls: string[];
  /** All requests, across sources. `fetchCalls` only counts the Foundation Models offer. */
  allCalls: string[];
  requests: Array<{ url: string; headers: Record<string, string> }>;
  setPage(html: string): void;
  setModelsDev(doc: unknown): void;
  /** Replaces the default page for one official feed (`google`, `anthropic`, `openai`, `xai`). */
  setOfficial(id: string, text: string): void;
  setFeed(feed: unknown): void;
  setDoc(doc: unknown): void;
  setBedrockDoc(doc: unknown): void;
  /** Status applies to every source unless `only` names one. */
  setStatus(status: number, only?: 'fm' | 'bedrock' | 'page' | 'feed' | 'modelsDev'): void;
  setBody(body: string): void;
}

export function harness(db: Database, doc: unknown, extra: Partial<PricingOptions> = {}): Harness {
  const state = {
    doc, bedrock: DEFAULT_BEDROCK as unknown, body: undefined as string | undefined,
    page: pageHtml() as string, feed: { regions: {} } as unknown, modelsDev: modelsDevDoc() as unknown,
    status: { fm: 200, bedrock: 200, page: 200, feed: 200, modelsDev: 200 },
    official: { ...OFFICIAL_DEFAULT },
  };
  const allCalls: string[] = [];
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchCalls: string[] = [];
  const clock = { t: T0 };
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    allCalls.push(u);
    requests.push({ url: u, headers: ((init as RequestInit | undefined)?.headers ?? {}) as Record<string, string> });
    if (u === MODELS_DEV_URL) {
      if (state.status.modelsDev !== 200) return new Response('nope', { status: state.status.modelsDev });
      return new Response(typeof state.modelsDev === 'string' ? state.modelsDev : JSON.stringify(state.modelsDev), { status: 200 });
    }
    if (u === PAGE_URL) {
      if (state.status.page !== 200) return new Response('nope', { status: state.status.page });
      return new Response(state.page, { status: 200 });
    }
    if (u === feedUrl('bedrockfoundationmodels')) {
      if (state.status.feed !== 200) return new Response('nope', { status: state.status.feed });
      return new Response(JSON.stringify(state.feed), { status: 200 });
    }
    if (u === BEDROCK_URL) {
      if (state.status.bedrock !== 200) return new Response('nope', { status: state.status.bedrock });
      return new Response(JSON.stringify(state.bedrock), { status: 200 });
    }
    const official = OFFICIAL_FEEDS.find((f) => f.url === u);
    if (official) return new Response(state.official[official.id] ?? '', { status: 200 });
    fetchCalls.push(u);
    if (state.status.fm !== 200) return new Response('nope', { status: state.status.fm });
    return new Response(state.body ?? JSON.stringify(state.doc), { status: 200 });
  }) as unknown as typeof fetch;
  const noExec: ExecFn = async () => ({ stdout: '', code: 1 });
  // Never read the developer's real ~/.aws or environment in tests.
  const emptyHome = mkdtempSync(join(tmpdir(), 'pricing-home-'));
  const svc = createPricingService(db, { fetch: fakeFetch, exec: noExec, now: () => clock.t, home: emptyHome, env: {}, ...extra });
  return {
    db, svc, clock, fetchCalls, allCalls, requests,
    setPage: (html) => { state.page = html; },
    setModelsDev: (doc) => { state.modelsDev = doc; },
    setOfficial: (id, text) => { state.official[id] = text; },
    setFeed: (feed) => { state.feed = feed; },
    setDoc: (d) => { state.doc = d; state.body = undefined; },
    setBedrockDoc: (d) => { state.bedrock = d; },
    setStatus: (status, only) => {
      for (const key of Object.keys(state.status) as Array<keyof typeof state.status>) {
        if (only === undefined || only === key) state.status[key] = status;
      }
    },
    setBody: (b) => { state.body = b; },
  };
}
