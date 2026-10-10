import { describe, expect, test } from 'bun:test';
import { classifyUsageType, parsePriceList } from '../../src/core/pricing-parse';
import fixture from '../fixtures/price-list-mini.json';

describe('classifyUsageType', () => {
  const cases: Array<[string, ReturnType<typeof classifyUsageType>]> = [
    ['USE1-MP:USE1_input_tokens_global_standard-Units', { kind: 'input', tier: 'global', longCtx: false }],
    ['USE1-MP:USE1_input_tokens_standard-Units', { kind: 'input', tier: 'regional', longCtx: false }],
    ['USE1-MP:USE1_output_tokens_long_ctx_global_standard-Units', { kind: 'output', tier: 'global', longCtx: true }],
    ['USE1-MP:USE1_cache_read_tokens_standard-Units', { kind: 'cache_read', tier: 'regional', longCtx: false }],
    ['USE1-MP:USE1_cache_write_tokens_standard-Units', { kind: 'cache_write_5m', tier: 'regional', longCtx: false }],
    ['USE1-MP:USE1_cache_write_tokens_1h_global_standard-Units', { kind: 'cache_write_1h', tier: 'global', longCtx: false }],
    ['USE1-MP:USE1_cache_write_tokens_1h_long_ctx_standard-Units', { kind: 'cache_write_1h', tier: 'regional', longCtx: true }],
    ['USE1-MP:USE1_InputTokenCount-Units', { kind: 'input', tier: 'regional', longCtx: false }],
    ['USE1-MP:USE1_InputTokenCount_Global-Units', { kind: 'input', tier: 'global', longCtx: false }],
    ['USE1-MP:USE1_OutputTokenCount-Units', { kind: 'output', tier: 'regional', longCtx: false }],
    ['USE1-MP:USE1_CacheReadInputTokenCount_Global-Units', { kind: 'cache_read', tier: 'global', longCtx: false }],
    ['USE1-MP:USE1_CacheWriteInputTokenCount-Units', { kind: 'cache_write_5m', tier: 'regional', longCtx: false }],
    ['USE1-MP:USE1_CacheWrite1hInputTokenCount_Global-Units', { kind: 'cache_write_1h', tier: 'global', longCtx: false }],
    // not plain on-demand standard pricing
    ['USE1-MP:USE1_InputTokenCount_Batch-Units', null],
    ['USE1-MP:USE1_InputTokenCount_Global_Batch-Units', null],
    ['USE1-MP:USE1_MillionBatchInputTokens-Units', null],
    ['USE1-MP:USE1_OutputTokenCount_LatencyOptimized-Units', null],
    ['USE1-MP:USE1_Reserved_1Month_InputTPM_Geo-Units', null],
    ['USE1-MP:USE1_cache_write_tokens_30m_standard-Units', null],
    ['USE1-MP:USE1_input_tokens_priority-Units', null],
    ['USE1-MP:USE1_output_tokens_flex-Units', null],
    ['USE1-ProvisionedThroughput_NoCommit_ModelUnits_Usage', null],
    ['USE1-MP:USE1_search_units-Units', null],
  ];
  test.each(cases)('%s', (usagetype, expected) => {
    expect(classifyUsageType(usagetype)).toEqual(expected);
  });
});

describe('parsePriceList (fixture)', () => {
  const { rows, publicationDate } = parsePriceList(fixture);
  const find = (model: string, region: string, tier: string, kind: string, longCtx = false) =>
    rows.find((r) => r.model === model && r.region === region && r.tier === tier && r.kind === kind && r.longCtx === longCtx);

  test('keeps publication date', () => {
    expect(publicationDate).toBe(fixture.publicationDate);
  });

  test('Sonnet 5.5 us-east-1: regional is 10% above global, per real file', () => {
    expect(find('Claude Sonnet 5.5', 'us-east-1', 'global', 'input')?.usdPerMtok).toBe(2);
    expect(find('Claude Sonnet 5.5', 'us-east-1', 'regional', 'input')?.usdPerMtok).toBe(2.2);
    expect(find('Claude Sonnet 5.5', 'us-east-1', 'regional', 'output')?.usdPerMtok).toBe(11);
    expect(find('Claude Sonnet 5.5', 'us-east-1', 'regional', 'cache_read')?.usdPerMtok).toBe(0.11);
    expect(find('Claude Sonnet 5.5', 'us-east-1', 'regional', 'cache_write_5m')?.usdPerMtok).toBe(2.75);
    expect(find('Claude Sonnet 5.5', 'us-east-1', 'regional', 'cache_write_1h')?.usdPerMtok).toBe(4.4);
    expect(find('Claude Sonnet 5.5', 'us-east-1', 'global', 'cache_write_1h')?.usdPerMtok).toBe(4);
  });

  test('legacy naming family (Claude 3.5 Sonnet) is parsed', () => {
    expect(find('Claude 3.5 Sonnet', 'us-east-1', 'regional', 'input')?.usdPerMtok).toBe(3);
    expect(find('Claude 3.5 Sonnet', 'us-east-1', 'regional', 'output')?.usdPerMtok).toBe(15);
  });

  test('long-context rows are flagged, base rows unaffected', () => {
    expect(find('OpenAI GPT-6 Astra', 'us-east-1', 'regional', 'input', true)?.usdPerMtok).toBe(22);
    expect(find('OpenAI GPT-6 Astra', 'us-east-1', 'regional', 'input', false)?.usdPerMtok).toBe(11);
  });

  test('excludes model-unit / batch / non-token rows', () => {
    expect(rows.every((r) => Number.isFinite(r.usdPerMtok))).toBe(true);
    const keys = rows.map((r) => `${r.model}|${r.region}|${r.tier}|${r.kind}|${r.longCtx}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('output is deterministic (sorted)', () => {
    expect(parsePriceList(fixture).rows).toEqual(rows);
  });
});

describe('parsePriceList (edge cases)', () => {
  const product = (usagetype: string, model = 'M') => ({
    attributes: { model, regionCode: 'us-east-1', inferenceType: 'Input tokens', usagetype },
  });
  const term = (usd: string, unit = '1M tokens') => ({
    t: { priceDimensions: { d: { unit, pricePerUnit: { USD: usd } } } },
  });

  test('rejects documents that are not price lists', () => {
    expect(() => parsePriceList({})).toThrow();
    expect(() => parsePriceList(null)).toThrow();
    expect(() => parsePriceList('x')).toThrow();
  });

  test('duplicate keys keep the highest price', () => {
    const doc = {
      products: { a: product('USE1-MP:USE1_InputTokenCount-Units'), b: product('USE1-MP:USE1_InputTokenCount-Units') },
      terms: { OnDemand: { a: term('1'), b: term('3') } },
    };
    expect(parsePriceList(doc).rows.map((r) => r.usdPerMtok)).toEqual([3]);
  });

  test('skips rows with other units, missing terms or bad prices', () => {
    const doc = {
      products: {
        a: product('USE1-MP:USE1_InputTokenCount-Units', 'A'),
        b: product('USE1-MP:USE1_InputTokenCount-Units', 'B'),
        c: product('USE1-MP:USE1_InputTokenCount-Units', 'C'),
        d: { attributes: { regionCode: 'us-east-1' } },
      },
      terms: { OnDemand: { a: term('1', '1K tokens'), c: term('abc') } },
    };
    expect(parsePriceList(doc).rows).toEqual([]);
  });
});

import { parseBedrockOffer } from '../../src/core/pricing-parse';
import bedrockFixture from '../fixtures/price-list-bedrock-mini.json';
import { bedrockDoc } from './pricing-helpers';

describe('parseBedrockOffer (fixture from the real AmazonBedrock offer)', () => {
  const { rows } = parseBedrockOffer(bedrockFixture);
  const find = (model: string, tier: string, kind: string, region = 'us-east-1') =>
    rows.find((r) => r.model === model && r.region === region && r.tier === tier && r.kind === kind && !r.longCtx);

  test('converts per-1K prices to USD per 1M tokens', () => {
    expect(find('DeepSeek v3.2', 'regional', 'input')?.usdPerMtok).toBeCloseTo(0.62, 9);
    expect(find('DeepSeek v3.2', 'regional', 'output')?.usdPerMtok).toBeCloseTo(1.85, 9);
    expect(find('GLM 5', 'regional', 'input')?.usdPerMtok).toBeCloseTo(1, 9);
    expect(find('GLM 5', 'regional', 'output')?.usdPerMtok).toBeCloseTo(3.2, 9);
  });

  test('keeps standard and global-standard rows, with cache reads', () => {
    expect(find('Kimi K3', 'regional', 'input')?.usdPerMtok).toBeCloseTo(3.3, 9);
    expect(find('Kimi K3', 'global', 'input')?.usdPerMtok).toBeCloseTo(3, 9);
    expect(find('Kimi K3', 'global', 'output')?.usdPerMtok).toBeCloseTo(15, 9);
    expect(find('Kimi K3', 'regional', 'cache_read')?.usdPerMtok).toBeCloseTo(0.33, 9);
  });

  test('rows labelled "Output tokens" but billed as batch are skipped', () => {
    expect(find('gpt-oss-120b', 'regional', 'output')?.usdPerMtok).toBeCloseTo(0.6, 9);
    expect(find('gpt-oss-120b', 'regional', 'input')?.usdPerMtok).toBeCloseTo(0.15, 9);
  });

  test('nothing is parsed for GovCloud-only layouts or custom-model units', () => {
    expect(rows.filter((r) => r.model === 'openai.gpt-5.6-luna')).toEqual([]);
    // Nova caching is genuinely free to write; the model-unit "custom-model" variants must not leak in.
    const nova = rows.filter((r) => r.model === 'Nova Micro');
    expect(nova.map((r) => r.kind).sort()).toEqual(['cache_read', 'cache_write_5m', 'input', 'output']);
    expect(nova.find((r) => r.kind === 'cache_write_5m')?.usdPerMtok).toBe(0);
  });

  test('one row per key and sorted', () => {
    const keys = rows.map((r) => `${r.model}|${r.region}|${r.tier}|${r.kind}|${r.longCtx}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });
});

describe('parseBedrockOffer (edge cases)', () => {
  const parse = (extra: Parameters<typeof bedrockDoc>[1]) => parseBedrockOffer(bedrockDoc([], extra)).rows;
  const row = (over: Partial<NonNullable<Parameters<typeof bedrockDoc>[1]>[number]> = {}) => ({
    model: 'M', usagetype: 'USE1-m-input-tokens', inferenceType: 'Input tokens', usdPer1k: 0.001, ...over,
  });

  test('unit handling: 1K and 1k convert, anything else is skipped', () => {
    expect(parse([row({ unit: '1K tokens' })]).map((r) => r.usdPerMtok)).toEqual([1]);
    expect(parse([row({ unit: '1k tokens' })]).map((r) => r.usdPerMtok)).toEqual([1]);
    expect(parse([row({ unit: '1M tokens' })])).toEqual([]);
    expect(parse([row({ unit: 'Text Requests' })])).toEqual([]);
  });

  test.each(['USE1-m-input-tokens-batch', 'USE1-m-input-tokens-flex', 'USE1-m-input-tokens-priority', 'USE1-m-custom-model-input', 'USE1-m-provisioned-input-tokens', 'USE1-m-reserved-input-tokens'])(
    'usagetype %s is not standard on-demand',
    (usagetype) => {
      expect(parse([row({ usagetype })])).toEqual([]);
    },
  );

  test.each([
    ['priority', true], ['flex', true], ['batch', true], ['global-priority', true], ['standard', false], ['global-standard', false], [null, false],
  ])('service_tier %p skipped=%p', (tier, skipped) => {
    expect(parse([row({ tier })]).length).toBe(skipped ? 0 : 1);
  });

  test('inferenceType decides kind and tier', () => {
    const rows = parse([
      row({ inferenceType: 'Output tokens' }),
      row({ inferenceType: 'Input tokens global' }),
      row({ inferenceType: 'Cache read tokens' }),
      row({ inferenceType: 'Cache read tokens global' }),
      row({ inferenceType: 'Prompt cache read input tokens', usagetype: 'USE1-n-cache-read-input-token-count' }),
      row({ inferenceType: 'Prompt cache write input tokens', usagetype: 'USE1-n-cache-write-input-token-count' }),
      row({ inferenceType: 'Prompt cache write input tokens', usagetype: 'USE1-n-cache-write-1h-input-token-count' }),
    ]);
    const sig = rows.map((r) => `${r.kind}/${r.tier}`).sort();
    expect(sig).toEqual(['cache_read/global', 'cache_read/regional', 'cache_write_1h/regional', 'cache_write_5m/regional', 'input/global', 'output/regional']);
  });

  test.each(['Input tokens priority', 'input tokens batch', 'Cache write tokens 30m', 'Text Input Tokens', 'Input Image Token Count', null])(
    'inferenceType %p is ignored',
    (inferenceType) => {
      expect(parse([row({ inferenceType })])).toEqual([]);
    },
  );

  test('global-standard service tier marks the row global; long-ctx usagetypes are flagged', () => {
    const rows = parse([
      row({ tier: 'global-standard', usagetype: 'USE1-m-mantle-input-tokens-global-standard' }),
      row({ usagetype: 'USE1-m-mantle-input-tokens-long-ctx-standard', tier: 'standard' }),
    ]);
    expect(rows.map((r) => `${r.tier}/${r.longCtx}`).sort()).toEqual(['global/false', 'regional/true']);
  });

  test('duplicates (plain + mantle rows) keep the highest price; bad docs throw', () => {
    const rows = parse([row({ usdPer1k: 0.001 }), row({ usagetype: 'USE1-m-mantle-input-tokens-standard', tier: 'standard', usdPer1k: 0.002 })]);
    expect(rows.map((r) => r.usdPerMtok)).toEqual([2]);
    expect(() => parseBedrockOffer({})).toThrow();
  });
});
