import { describe, expect, test } from 'bun:test';
import { buildModelIndex, fallbackCanonical, isFreeModel, modelCandidates, slugify, tierOf } from '../../src/core/models';

// Model names exactly as published in the AWS price list.
const NAMES = [
  'Claude 2.0', 'Claude 3 Haiku', 'Claude 3 Opus', 'Claude 3 Sonnet', 'Claude 3.5 Haiku', 'Claude 3.5 Sonnet',
  'Claude 3.5 Sonnet v2', 'Claude 3.7 Sonnet', 'Claude Fable 5', 'Claude Fable 5.1', 'Claude Haiku 4.5',
  'Claude Haiku 5.5', 'Claude Instant', 'Claude Opus 4', 'Claude Opus 4.1', 'Claude Opus 4.5', 'Claude Opus 4.6',
  'Claude Opus 4.7', 'Claude Opus 4.8', 'Claude Opus 5', 'Claude Opus 5.5', 'Claude Sonnet 4', 'Claude Sonnet 4.5',
  'Claude Sonnet 4.6', 'Claude Sonnet 5', 'Claude Sonnet 5.5', 'DeepSeek v3.2', 'OpenAI GPT-6 Astra', 'Command R+',
];

describe('slugify / tierOf', () => {
  test('slugify', () => {
    expect(slugify('Claude 3.5 Sonnet v2')).toBe('claude-3-5-sonnet-v2');
    expect(slugify('  --A__b.. ')).toBe('a-b');
  });
  test('tier comes from the global. prefix only', () => {
    expect(tierOf('global.anthropic.claude-opus-4-8')).toBe('global');
    expect(tierOf('us.anthropic.claude-opus-4-8')).toBe('regional');
    expect(tierOf('claude-opus-4-8')).toBe('regional');
  });
});

describe('modelCandidates', () => {
  test.each([
    ['claude-sonnet-5', ['claude-sonnet-5']],
    ['us.anthropic.claude-sonnet-5-5', ['claude-sonnet-5-5', 'anthropic-claude-sonnet-5-5']],
    ['anthropic.claude-haiku-4-5-20251001-v1:0', ['claude-haiku-4-5', 'anthropic-claude-haiku-4-5']],
    ['claude-sonnet-4-6[1m]', ['claude-sonnet-4-6']],
    ['us.anthropic.claude-3-5-sonnet-20241022-v2:0', ['claude-3-5-sonnet-v2', 'anthropic-claude-3-5-sonnet-v2']],
    ['anthropic.claude-3-5-sonnet-20240620-v1:0', ['claude-3-5-sonnet', 'anthropic-claude-3-5-sonnet']],
    ['deepseek.v3.2', ['v3-2', 'deepseek-v3-2']],
    ['claude-opus-4-6-v1', ['claude-opus-4-6']],
    ['  GLM-5 ', ['glm-5']],
  ])('%s', (raw, expected) => {
    expect(modelCandidates(raw)).toEqual(expected);
  });

  test('empty-ish input yields no candidates', () => {
    expect(modelCandidates('')).toEqual([]);
    expect(modelCandidates('...')).toEqual([]);
  });
});

describe('buildModelIndex.match', () => {
  const index = buildModelIndex(NAMES);

  test.each([
    ['claude-sonnet-5', 'Claude Sonnet 5'],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    ['us.anthropic.claude-sonnet-5-5', 'Claude Sonnet 5.5'],
    ['global.anthropic.claude-opus-4-8', 'Claude Opus 4.8'],
    ['anthropic.claude-haiku-4-5-20251001-v1:0', 'Claude Haiku 4.5'],
    ['us.anthropic.claude-haiku-5-5', 'Claude Haiku 5.5'],
    ['claude-sonnet-4-6[1m]', 'Claude Sonnet 4.6'],
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['us.anthropic.claude-fable-5-1', 'Claude Fable 5.1'],
    ['us.anthropic.claude-fable-5', 'Claude Fable 5'],
    ['us.anthropic.claude-opus-4-1-20250805-v1:0', 'Claude Opus 4.1'],
    ['us.anthropic.claude-opus-4-5-20251101-v1:0', 'Claude Opus 4.5'],
    ['us.anthropic.claude-sonnet-4-20250514-v1:0', 'Claude Sonnet 4'],
    ['us.anthropic.claude-opus-4-6-v1', 'Claude Opus 4.6'],
    ['us.anthropic.claude-opus-4-7', 'Claude Opus 4.7'],
    ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'Claude 3.5 Sonnet v2'],
    ['anthropic.claude-3-5-sonnet-20240620-v1:0', 'Claude 3.5 Sonnet'],
    ['claude-3-7-sonnet-20250219', 'Claude 3.7 Sonnet'],
    ['us.anthropic.claude-3-haiku-20240307-v1:0', 'Claude 3 Haiku'],
    ['deepseek.v3.2', 'DeepSeek v3.2'],
    ['deepseek-v3-2', 'DeepSeek v3.2'],
    ['claude-sonnet-3-5', 'Claude 3.5 Sonnet'], // token-set fallback, same version numbers
  ])('%s -> %s', (raw, expected) => {
    expect(index.match(raw)).toBe(expected);
  });

  test.each([
    'inherit', '<synthetic>', 'glm-5', 'openai-gpt-5-6-luna', 'claude-sonnet-9', 'claude-opus-4-9',
    'claude-sonnet-5-6', 'gemini-3.6-flash', 'qwen3.5:4b', 'mimo-v2.6-flash-free',
  ])('does not guess: %s', (raw) => {
    expect(index.match(raw)).toBeNull();
  });

  test('never matches across versions (v2 is not v1)', () => {
    const only = buildModelIndex(['Claude 3.5 Sonnet']);
    expect(only.match('anthropic.claude-3-5-sonnet-20241022-v2:0')).toBeNull();
    expect(only.match('anthropic.claude-3-5-sonnet-20240620-v1:0')).toBe('Claude 3.5 Sonnet');
  });

  test('ambiguous token sets are not used', () => {
    const amb = buildModelIndex(['Foo Bar 1', 'Bar Foo 1']);
    expect(amb.match('foo-bar-1')).toBe('Foo Bar 1');
    expect(amb.match('bar-1-foo-x')).toBeNull();
    expect(buildModelIndex(['Foo Bar 1', 'Bar Foo 1']).match('1-foo-bar')).toBeNull();
  });

  test('size', () => {
    expect(index.size).toBe(NAMES.length);
  });
});

describe('fallbackCanonical', () => {
  test('uses the normalised id, or the raw string when nothing normalises', () => {
    expect(fallbackCanonical('us.anthropic.claude-new-9')).toBe('claude-new-9');
    expect(fallbackCanonical('...')).toBe('...');
  });
});

describe('isFreeModel', () => {
  test.each([
    'minimax-m2.5-free', 'deepseek-v4-flash-free', 'nemotron-3-super-free', 'openrouter/free', 'mimo-v2.6-flash-free',
    'hy3-preview-free', 'nvidia/nemotron-3-super-120b-a12b:free', 'MiniMax-M2.5-FREE', 'some-model-free[1m]',
  ])('%s is free', (raw) => {
    expect(isFreeModel(raw)).toBe(true);
  });

  test.each([
    'freedom-7b', 'big-pickle', 'gpt-5-nano', 'gemini-3.6-flash', 'gemini-flash-latest', 'claude-sonnet-5', 'glm-5',
    'carefree', 'free-tier-model', 'free', 'freebird:7b', 'x-freedom', 'unfree',
  ])('%s is not free', (raw) => {
    expect(isFreeModel(raw)).toBe(false);
  });

  test.each([
    ['gemma3:1b', 'ollama'], ['qwen3.5:4b', 'Ollama'], ['llama3', 'lmstudio'], ['llama3', 'LM Studio'],
    ['llama3', 'llama.cpp'], ['llama3', 'llamacpp'], ['llama3', 'llamafile'],
  ])('%s on local runtime %s is free', (raw, provider) => {
    expect(isFreeModel(raw, provider)).toBe(true);
  });

  test.each([
    ['gemma3:1b', undefined], ['gemma3:1b', 'amazon-bedrock'], ['gemma3:1b', 'openrouter'], ['gemma3:1b', 'google'],
    ['gemma3:1b', 'ollama-cloud'], ['gemma3:1b', ''], ['claude-sonnet-5', 'anthropic'],
  ])('%s with provider %p is not free', (raw, provider) => {
    expect(isFreeModel(raw, provider)).toBe(false);
  });
});
