import { describe, expect, test } from 'bun:test';
import type { ExecFn } from '../../src/core/arn';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/core/db';
import { createPricingService } from '../../src/core/pricing';
import { DAY, T0, bedrockDoc, harness, priceDoc } from './pricing-helpers';

const NAMES = [
  'Claude 3 Haiku', 'Claude 3.5 Sonnet', 'Claude 3.5 Sonnet v2', 'Claude 3.7 Sonnet', 'Claude Fable 5', 'Claude Fable 5.1',
  'Claude Haiku 4.5', 'Claude Haiku 5.5', 'Claude Opus 4', 'Claude Opus 4.1', 'Claude Opus 4.5', 'Claude Opus 4.6',
  'Claude Opus 4.7', 'Claude Opus 4.8', 'Claude Opus 5', 'Claude Opus 5.5', 'Claude Sonnet 4', 'Claude Sonnet 4.5',
  'Claude Sonnet 4.6', 'Claude Sonnet 5', 'Claude Sonnet 5.5',
];
const book = priceDoc(NAMES.map((model) => ({ model, rates: { input: 1, output: 5 } })));
const AIP = 'arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/abcd1234efgh';

async function ready() {
  const h = harness(openDb(':memory:'), book);
  await h.svc.refreshIfStale();
  return h;
}

describe('resolveModel: ids seen in the real agent data', () => {
  const priced: Array<[string, string, 'regional' | 'global']> = [
    ['claude-sonnet-5', 'Claude Sonnet 5', 'regional'],
    ['deepseek-v3-2', 'DeepSeek v3.2', 'regional'], // from the second (AmazonBedrock) price source
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5', 'regional'],
    ['us.anthropic.claude-sonnet-5', 'Claude Sonnet 5', 'regional'],
    ['us.anthropic.claude-sonnet-5-5', 'Claude Sonnet 5.5', 'regional'],
    ['global.anthropic.claude-opus-4-8', 'Claude Opus 4.8', 'global'],
    ['global.anthropic.claude-sonnet-4-6', 'Claude Sonnet 4.6', 'global'],
    ['anthropic.claude-haiku-4-5-20251001-v1:0', 'Claude Haiku 4.5', 'regional'],
    ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'Claude Haiku 4.5', 'regional'],
    ['claude-haiku-4-5', 'Claude Haiku 4.5', 'regional'],
    ['us.anthropic.claude-haiku-5-5', 'Claude Haiku 5.5', 'regional'],
    ['claude-sonnet-4-6', 'Claude Sonnet 4.6', 'regional'],
    ['claude-sonnet-4-6[1m]', 'Claude Sonnet 4.6', 'regional'],
    ['us.anthropic.claude-sonnet-4-6', 'Claude Sonnet 4.6', 'regional'],
    ['claude-opus-4-7', 'Claude Opus 4.7', 'regional'],
    ['us.anthropic.claude-opus-4-7', 'Claude Opus 4.7', 'regional'],
    ['claude-opus-4-8', 'Claude Opus 4.8', 'regional'],
    ['claude-opus-5', 'Claude Opus 5', 'regional'],
    ['us.anthropic.claude-opus-5-5', 'Claude Opus 5.5', 'regional'],
    ['claude-opus-5-5', 'Claude Opus 5.5', 'regional'],
    ['us.anthropic.claude-fable-5-1', 'Claude Fable 5.1', 'regional'],
    ['us.anthropic.claude-opus-4-1-20250805-v1:0', 'Claude Opus 4.1', 'regional'],
    ['us.anthropic.claude-opus-4-5-20251101-v1:0', 'Claude Opus 4.5', 'regional'],
    ['us.anthropic.claude-sonnet-4-20250514-v1:0', 'Claude Sonnet 4', 'regional'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'Claude Sonnet 4.5', 'regional'],
    ['us.anthropic.claude-opus-4-6-v1', 'Claude Opus 4.6', 'regional'],
    ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'Claude 3.5 Sonnet v2', 'regional'],
  ];
  test.each(priced)('%s -> %s (%s)', async (raw, canonical, tier) => {
    const h = await ready();
    expect(await h.svc.resolveModel(raw)).toEqual({ canonical, priced: true, tier });
  });

  const unpriced: Array<[string, string]> = [
    ['inherit', 'inherit'],
    ['<synthetic>', 'synthetic'],
    ['glm-5', 'glm-5'],
    ['openai-gpt-5-6-luna', 'openai-gpt-5-6-luna'],
    ['gemini-3.6-flash', 'gemini-3-6-flash'],
    ['us.anthropic.claude-brand-new-9', 'claude-brand-new-9'],
  ];
  test.each(unpriced)('%s stays unpriced as %s', async (raw, canonical) => {
    const h = await ready();
    expect(await h.svc.resolveModel(raw)).toEqual({ canonical, priced: false, tier: 'regional' });
  });
});

describe('resolveModel: caching and retries', () => {
  test('outcomes are stored in model_cache and reused', async () => {
    const h = await ready();
    await h.svc.resolveModel('claude-sonnet-5');
    await h.svc.resolveModel('claude-sonnet-5');
    expect(h.db.query('SELECT raw, canonical, priced FROM model_cache').all()).toEqual([
      { raw: 'claude-sonnet-5', canonical: 'Claude Sonnet 5', priced: 1 },
    ]);
    const fresh = createPricingService(h.db, { now: () => h.clock.t });
    expect(await fresh.resolveModel('claude-sonnet-5')).toEqual({ canonical: 'Claude Sonnet 5', priced: true, tier: 'regional' });
  });

  test('a model unknown before the first price fetch becomes priced after the next snapshot', async () => {
    const h = harness(openDb(':memory:'), book);
    expect((await h.svc.resolveModel('claude-sonnet-5')).priced).toBe(false);
    h.clock.t = T0 + DAY;
    await h.svc.refreshIfStale();
    expect(await h.svc.resolveModel('claude-sonnet-5')).toEqual({ canonical: 'Claude Sonnet 5', priced: true, tier: 'regional' });
  });

  test('unpriced results are retried only when a newer snapshot exists', async () => {
    const h = await ready();
    h.clock.t = T0 + 5 * DAY;
    expect((await h.svc.resolveModel('claude-nova-9')).priced).toBe(false);
    h.setDoc(priceDoc([...NAMES, 'Claude Nova 9'].map((model) => ({ model, rates: { input: 1, output: 5 } }))));
    h.clock.t = T0 + 6 * DAY;
    await h.svc.refreshIfStale();
    expect(await h.svc.resolveModel('claude-nova-9')).toEqual({ canonical: 'Claude Nova 9', priced: true, tier: 'regional' });
  });
});

describe('resolveModel: application inference profile ARNs', () => {
  const okExec = (modelId: string): { exec: ExecFn; calls: string[][] } => {
    const calls: string[][] = [];
    return {
      calls,
      exec: async (_c, args) => {
        calls.push(args);
        return { stdout: JSON.stringify({ models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${modelId}` }] }), code: 0 };
      },
    };
  };

  test('resolves through aws, using the profile hint, and is cached', async () => {
    const e = okExec('anthropic.claude-sonnet-5-v1:0');
    const h = harness(openDb(':memory:'), book, { exec: e.exec });
    await h.svc.refreshIfStale();
    const r = await h.svc.resolveModel(AIP, { awsProfile: 'work' });
    expect(r).toEqual({ canonical: 'Claude Sonnet 5', priced: true, tier: 'regional' });
    expect(e.calls[0]).toContain('work');
    await h.svc.resolveModel(AIP, { awsProfile: 'work' });
    expect(e.calls).toHaveLength(1);
  });

  test('a resolved model that is not in the price list is unpriced under its own name', async () => {
    const e = okExec('zai.glm-5-v1:0');
    const h = harness(openDb(':memory:'), book, { exec: e.exec });
    await h.svc.refreshIfStale();
    expect(await h.svc.resolveModel(AIP)).toEqual({ canonical: 'glm-5', priced: false, tier: 'regional' });
  });

  test('unresolvable ARN (no aws / no creds) is labelled, unpriced, and retried after an hour', async () => {
    const h = harness(openDb(':memory:'), book);
    await h.svc.refreshIfStale();
    expect(await h.svc.resolveModel(AIP)).toEqual({ canonical: 'bedrock-profile/abcd1234efgh', priced: false, tier: 'regional' });
    expect(h.db.query('SELECT COUNT(*) c FROM model_cache').get()).toEqual({ c: 0 });

    const e = okExec('anthropic.claude-opus-5-v1:0');
    const later = harness(h.db, book, { exec: e.exec });
    later.clock.t = T0 + 2 * 3600 * 1000;
    expect(await later.svc.resolveModel(AIP)).toEqual({ canonical: 'Claude Opus 5', priced: true, tier: 'regional' });
  });

  test('system profile ARNs resolve without aws', async () => {
    const e = okExec('unused');
    const h = harness(openDb(':memory:'), book, { exec: e.exec });
    await h.svc.refreshIfStale();
    const r = await h.svc.resolveModel('arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-opus-4-8');
    expect(r.canonical).toBe('Claude Opus 4.8');
    expect(e.calls).toHaveLength(0);
  });
});

describe('resolveModel: ARN through automatic profile discovery', () => {
  test('no hint, stale ambient env: the profile whose account matches the ARN is found by itself', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    mkdirSync(join(home, '.aws'));
    writeFileSync(join(home, '.aws', 'config'), '[profile dev]\n[profile work]\n');
    const calls: string[][] = [];
    const exec: ExecFn = async (_c, args) => {
      calls.push(args);
      const profile = args[args.indexOf('--profile') + 1];
      if (args[0] === 'sts') return profile === 'work' ? { stdout: JSON.stringify({ Account: '111122223333' }), code: 0 } : { stdout: '', code: 254 };
      return profile === 'work'
        ? { stdout: JSON.stringify({ models: [{ modelArn: 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-5-v1:0' }] }), code: 0 }
        : { stdout: '', code: 254 };
    };
    const h = harness(openDb(':memory:'), book, { exec, home, env: { AWS_PROFILE: 'dev', AWS_ACCESS_KEY_ID: 'ASIASTALE' } });
    await h.svc.refreshIfStale();
    expect(await h.svc.resolveModel(AIP)).toEqual({ canonical: 'Claude Opus 5', priced: true, tier: 'regional' });
    expect(calls.filter((a) => a[0] === 'bedrock').map((a) => a[a.indexOf('--profile') + 1])).toEqual(['work']);
  });
});

describe('resolveModel: free and local models cost $0', () => {
  const ev = { ts: T0, inputTokens: 5 * 1_000_000, outputTokens: 1_000_000, reasoningTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };

  test.each([
    ['minimax-m2.5-free', undefined, 'minimax-m2-5-free'],
    ['deepseek-v4-flash-free', 'opencode', 'deepseek-v4-flash-free'],
    ['nvidia/nemotron-3-super-120b-a12b:free', 'openrouter', 'nvidia-nemotron-3-super-120b-a12b-free'],
    ['openrouter/free', 'openrouter', 'openrouter-free'],
    ['mimo-v2.6-flash-free', 'opencode', 'mimo-v2-6-flash-free'],
    ['gemma3:1b', 'ollama', 'gemma3-1b'],
    ['qwen3.5:4b', 'ollama', 'qwen3-5-4b'],
    ['some-gguf', 'llama.cpp', 'some-gguf'],
  ])('%s (%p) is priced at $0 as %s', async (raw, provider, canonical) => {
    const h = harness(openDb(':memory:'), book);
    const m = await h.svc.resolveModel(raw, { provider });
    expect(m).toEqual({ canonical, priced: true, tier: 'regional' });
    expect(h.svc.priceEvent(m, ev)).toEqual({ costUsd: 0, approx: false });
  });

  test('works before any price list has been fetched and does not touch model_cache', async () => {
    const h = harness(openDb(':memory:'), book);
    const m = await h.svc.resolveModel('gemma3:1b', { provider: 'ollama' });
    expect(h.svc.priceEvent(m, ev).costUsd).toBe(0);
    expect(h.db.query('SELECT COUNT(*) c FROM model_cache').get()).toEqual({ c: 0 });
  });

  test.each([
    ['big-pickle', 'opencode'], ['gpt-5-nano', 'openai'], ['gemini-3.6-flash', 'google'], ['freedom-7b', 'openrouter'],
    ['gemma3:1b', 'amazon-bedrock'], ['gemma3:1b', undefined], ['glm-5', 'ollama-cloud'],
  ])('%s (%p) stays unpriced', async (raw, provider) => {
    const h = await ready();
    const m = await h.svc.resolveModel(raw, { provider });
    expect(m.priced).toBe(false);
    expect(h.svc.priceEvent(m, ev).costUsd).toBeNull();
  });

  test('a local model that shares its name with a paid one is free only for the local provider', async () => {
    const h = harness(openDb(':memory:'), book);
    h.setBedrockDoc(bedrockDoc([{ model: 'gpt-oss-120b', inputPerMtok: 0.15, outputPerMtok: 0.6 }]));
    await h.svc.refreshIfStale();
    const local = await h.svc.resolveModel('gpt-oss:120b', { provider: 'ollama' });
    const paid = await h.svc.resolveModel('gpt-oss-120b', { provider: 'amazon-bedrock' });
    expect(local.canonical).toBe(paid.canonical);
    expect(h.svc.priceEvent(local, ev).costUsd).toBe(0);
    expect(h.svc.priceEvent(paid, ev).costUsd).toBeCloseTo(5 * 0.15 + 0.6, 9);
  });
});
