import type { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRICE_LIST_URL, PRICE_SOURCES, createPricingService, type PricingOptions } from '../../src/core/pricing';
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

export const DEFAULT_BEDROCK = bedrockDoc([{ model: 'DeepSeek v3.2', inputPerMtok: 0.62, outputPerMtok: 1.85 }]);
const BEDROCK_URL = (PRICE_SOURCES[1] as { url: string }).url;

export interface Harness {
  db: Database;
  svc: PricingService;
  clock: { t: number };
  fetchCalls: string[];
  /** All requests, across sources. `fetchCalls` only counts the Foundation Models offer. */
  allCalls: string[];
  setDoc(doc: unknown): void;
  setBedrockDoc(doc: unknown): void;
  /** Status applies to both sources unless `only` names one ('fm' | 'bedrock'). */
  setStatus(status: number, only?: 'fm' | 'bedrock'): void;
  setBody(body: string): void;
}

export function harness(db: Database, doc: unknown, extra: Partial<PricingOptions> = {}): Harness {
  const state = {
    doc, bedrock: DEFAULT_BEDROCK as unknown, body: undefined as string | undefined,
    status: { fm: 200, bedrock: 200 },
  };
  const allCalls: string[] = [];
  const fetchCalls: string[] = [];
  const clock = { t: T0 };
  const fakeFetch = (async (url: string | URL | Request) => {
    const u = String(url);
    allCalls.push(u);
    if (u === BEDROCK_URL) {
      if (state.status.bedrock !== 200) return new Response('nope', { status: state.status.bedrock });
      return new Response(JSON.stringify(state.bedrock), { status: 200 });
    }
    fetchCalls.push(u);
    if (state.status.fm !== 200) return new Response('nope', { status: state.status.fm });
    return new Response(state.body ?? JSON.stringify(state.doc), { status: 200 });
  }) as unknown as typeof fetch;
  const noExec: ExecFn = async () => ({ stdout: '', code: 1 });
  // Never read the developer's real ~/.aws or environment in tests.
  const emptyHome = mkdtempSync(join(tmpdir(), 'pricing-home-'));
  const svc = createPricingService(db, { fetch: fakeFetch, exec: noExec, now: () => clock.t, home: emptyHome, env: {}, ...extra });
  return {
    db, svc, clock, fetchCalls, allCalls,
    setDoc: (d) => { state.doc = d; state.body = undefined; },
    setBedrockDoc: (d) => { state.bedrock = d; },
    setStatus: (status, only) => {
      if (only !== 'bedrock') state.status.fm = status;
      if (only !== 'fm') state.status.bedrock = status;
    },
    setBody: (b) => { state.body = b; },
  };
}
