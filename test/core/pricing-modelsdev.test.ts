import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/core/db';
import {
  buildExternalIndex, externalNameKey, loadExternalPrices, modelsDevFetchedAt, modelsDevStatus, parseModelsDev, storeExternalPrices,
  type ExternalPrice,
} from '../../src/core/pricing-modelsdev';
import fixture from '../fixtures/models-dev-mini.json';

const entries = parseModelsDev(fixture);
const index = buildExternalIndex(entries);
const rates = (e: ExternalPrice | null) => e && { provider: e.provider, input: e.input, output: e.output, cacheRead: e.cacheRead, cacheWrite: e.cacheWrite };
const price = (raw: string, provider?: string) => {
  const e = index.lookup(raw, provider);
  return e && `${e.input}/${e.output}`;
};

describe('parseModelsDev', () => {
  test('reads cost.input/output/cache_read/cache_write per provider and model', () => {
    expect(entries.length).toBe(30);
    const nano = entries.find((e) => e.provider === 'opencode' && e.modelId === 'gpt-5-nano');
    expect(rates(nano ?? null)).toEqual({ provider: 'opencode', input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: null });
  });

  test('skips providers without models and models without a usable cost; ignores extra cost fields', () => {
    const doc = {
      a: { models: { ok: { name: 'Ok', cost: { input: 1, output: 2, input_audio: 9, tiers: [{}], context_over_200k: { input: 5 }, reasoning: 7 } } } },
      b: {},
      c: { models: { nocost: { name: 'x' }, partial: { cost: { input: 1 } }, negative: { cost: { input: -1, output: 1 } }, text: { cost: { input: '1', output: 2 } }, nan: { cost: { input: NaN, output: 1 } }, nul: null } },
      d: null,
      e: { models: 'nope' },
    };
    expect(parseModelsDev(doc).map((e) => `${e.provider}/${e.modelId}`)).toEqual(['a/ok']);
    expect(parseModelsDev(doc)[0]).toMatchObject({ input: 1, output: 2, cacheRead: null, cacheWrite: null, name: 'Ok' });
  });

  test.each([[null], [[]], ['text'], [42]])('rejects %p', (doc) => {
    expect(() => parseModelsDev(doc)).toThrow('not a models.dev document');
  });
});

describe('storeExternalPrices', () => {
  const one = (over: Partial<ExternalPrice> = {}): ExternalPrice => ({ provider: 'p', modelId: 'm', name: 'M', input: 1, output: 2, cacheRead: null, cacheWrite: null, ...over });

  test('upserts, counts only new or changed rows, records the fetch time', () => {
    const db = openDb(':memory:');
    expect(storeExternalPrices(db, [one(), one({ modelId: 'n' })], 1000)).toBe(2);
    expect(storeExternalPrices(db, [one(), one({ modelId: 'n' })], 2000)).toBe(0);
    expect(storeExternalPrices(db, [one({ input: 1.5 }), one({ modelId: 'n', cacheRead: 0.1 })], 3000)).toBe(2);
    expect(loadExternalPrices(db).find((e) => e.modelId === 'm')?.input).toBe(1.5);
    expect(modelsDevFetchedAt(db)).toBe(3000);
    expect(modelsDevStatus(db)).toEqual({ entries: 2, fetchedAt: 3000 });
    expect(db.query('SELECT last_seen_at AS t FROM external_prices ORDER BY model_id').all()).toEqual([{ t: 3000 }, { t: 3000 }]);
  });

  test('never deletes: models missing from a later fetch stay priceable', () => {
    const db = openDb(':memory:');
    storeExternalPrices(db, [one(), one({ modelId: 'old' })], 1000);
    storeExternalPrices(db, [one()], 2000);
    expect(loadExternalPrices(db).map((e) => e.modelId).sort()).toEqual(['m', 'old']);
    expect(db.query("SELECT last_seen_at AS t FROM external_prices WHERE model_id = 'old'").get()).toEqual({ t: 1000 });
  });

  test('fetch time is null before the first fetch', () => {
    expect(modelsDevFetchedAt(openDb(':memory:'))).toBeNull();
  });
});

describe('externalNameKey', () => {
  test.each([
    ['z-ai/glm-5.3', 'glm-5-3'], ['zai-org/GLM-5', 'glm-5'], ['minimaxai/minimax-m2.7', 'minimax-m2-7'],
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'], ['gemini-2.5-flash-2025-09-01', 'gemini-2-5-flash'],
    ['gpt-4o-2024-08-06', 'gpt-4o'], ['gemini-flash-latest', 'gemini-flash-latest'], ['claude-sonnet-4-6[1m]', 'claude-sonnet-4-6'],
    ['gc/gpt-5-nano', 'gpt-5-nano'], ['GPT-5-Nano', 'gpt-5-nano'], ['glm5', 'glm5'], ['', ''],
  ])('%s -> %s', (raw, expected) => {
    expect(externalNameKey(raw)).toBe(expected);
  });
});

describe('lookup: the verified examples from real data', () => {
  test('provider + exact id', () => {
    expect(rates(index.lookup('gpt-5-nano', 'opencode'))).toMatchObject({ provider: 'opencode', input: 0.05, output: 0.4, cacheRead: 0.005 });
    expect(rates(index.lookup('gemini-3-flash-preview', 'google'))).toMatchObject({ input: 0.5, output: 3, cacheRead: 0.05 });
    expect(rates(index.lookup('gemini-3.6-flash', 'google'))).toMatchObject({ input: 0.75, output: 3.75, cacheRead: 0.075 });
    expect(rates(index.lookup('deepseek/deepseek-v4-flash', 'openrouter'))).toMatchObject({ provider: 'openrouter', input: 0.0085, output: 1.28, cacheRead: 0.0085 });
    expect(rates(index.lookup('mistral-large-latest', 'mistral'))).toMatchObject({ input: 0.5, output: 1.5, cacheRead: 0.05 });
    expect(rates(index.lookup('open-mistral-7b', 'mistral'))).toMatchObject({ input: 0.25, output: 0.25, cacheRead: null });
  });

  test('zero-cost entries are real answers (free), not misses', () => {
    expect(rates(index.lookup('big-pickle', 'opencode'))).toMatchObject({ input: 0, output: 0 });
    expect(rates(index.lookup('minimaxai/minimax-m2.7', 'nvidia'))).toMatchObject({ input: 0, output: 0 });
  });

  test('ids are matched case-insensitively and bracket suffixes are ignored', () => {
    expect(price('GPT-5-NANO', 'OpenCode')).toBe('0.05/0.4');
    expect(price('gpt-5-nano[1m]', 'opencode')).toBe('0.05/0.4');
  });
});

describe('lookup: conservative matching', () => {
  test('gpt-5-nano never matches gpt-5, in either direction', () => {
    expect(price('gpt-5-nano')).toBe('0.05/0.4');
    expect(price('gpt-5')).toBe('1.25/10');
    expect(price('gpt-5-nano', 'opencode')).toBe('0.05/0.4');
    expect(price('gpt-5', 'opencode')).toBe('1.07/8.5'); // the gateway's own listing, not openai's
    expect(price('gpt-5-mini')).toBeNull();
  });

  test('"-latest" aliases only match their own exact entry', () => {
    expect(price('gemini-flash-latest')).toBe('0.75/3.75');
    expect(price('gemini-pro-latest')).toBeNull();
    expect(price('mistral-large-latest')).toBe('0.5/1.5');
    expect(price('mistral-small-latest')).toBeNull();
  });

  test('an exact id beats dated siblings that share its normalised name', () => {
    expect(price('gpt-4o')).toBe('2.5/10');
    expect(price('gpt-4o-2024-05-13')).toBe('5/15');
    expect(price('gpt-4o-2024-08-06')).toBe('2.5/10');
  });

  test('an unknown dated variant whose siblings disagree is unresolved, not guessed', () => {
    expect(price('gpt-4o-2024-99-99')).toBeNull();
  });

  test('vendor / gateway path prefixes are stripped, in the provider and across makers', () => {
    expect(price('z-ai/glm-5')).toBe('1/3.2'); // zai is the maker
    expect(price('z-ai/glm-5', 'nano-gpt')).toBe('0.5/2.55'); // the gateway's own entry wins
    expect(price('openai/gpt-5-nano', 'openrouter')).toBe('0.05/0.4');
    expect(price('gc/gpt-5-nano', 'gc')).toBe('0.05/0.4'); // custom gateway prefix and provider id
    expect(price('gc/gpt-5-nano')).toBe('0.05/0.4');
  });

  test('a spelling that only differs by punctuation placement is not matched', () => {
    expect(price('z-ai/glm5')).toBeNull();
    expect(price('glm5', 'zai')).toBeNull();
    expect(price('glm-5-3')).toBe('1.4/4.4');
  });

  test('maker providers answer before aggregators; the maker wins over cheaper resellers', () => {
    expect(rates(index.lookup('deepseek-v4-flash'))).toMatchObject({ provider: 'deepseek', input: 0.15, output: 0.6 });
    expect(rates(index.lookup('glm-5'))).toMatchObject({ provider: 'zai', input: 1, output: 3.2 });
    expect(rates(index.lookup('glm-5', 'alibaba-token-plan'))).toMatchObject({ provider: 'alibaba-token-plan', input: 0, output: 0 });
  });

  test('without a maker, agreeing resellers resolve and disagreeing ones do not', () => {
    expect(price('grok-4')).toBe('3/15');
    expect(price('xai/grok-4')).toBe('3/15');
    expect(price('tencent/hy3')).toBeNull();
    expect(price('hy3')).toBeNull();
    expect(price('tencent/hy3', 'nano-gpt')).not.toBeNull(); // but the gateway's own entry is fine
  });

  test('unknown or empty ids are unresolved', () => {
    expect(price('definitely-not-a-model')).toBeNull();
    expect(price('')).toBeNull();
    expect(price('   ', 'google')).toBeNull();
    expect(price('///')).toBeNull();
  });

  test('an unknown provider hint falls back to the maker and cross-provider rules', () => {
    expect(price('gpt-5-nano', 'my-custom-gateway')).toBe('0.05/0.4');
    expect(price('tencent/hy3', 'my-custom-gateway')).toBeNull();
  });

  test('agreement uses a tolerance, so floating point noise does not create conflicts', () => {
    const idx = buildExternalIndex([
      { provider: 'a', modelId: 'zz-1', name: null, input: 0.1 + 0.2, output: 1, cacheRead: null, cacheWrite: null },
      { provider: 'b', modelId: 'zz-1', name: null, input: 0.3, output: 1, cacheRead: null, cacheWrite: null },
    ]);
    expect(idx.lookup('zz-1')).not.toBeNull();
    expect(idx.size).toBe(2);
  });
});
