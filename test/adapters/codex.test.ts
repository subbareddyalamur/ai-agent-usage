import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import adapter from '../../src/adapters/codex';
import { adapterContract, collect, eventsOf, memoryState, tempHome } from './contract';
import { appendJsonl, writeJsonl } from './fixtures';

const file = (home: string): string => join(home, '.codex', 'sessions', '2026', '11', '13', 'rollout-2026-11-13T00-00-00-019e6cf1-cc27-7e72-bf2d-5131d5d18f21.jsonl');

function lines(): Record<string, unknown>[] {
  return [
    { timestamp: '2026-11-13T00:00:00.000Z', type: 'session_meta', payload: { id: 'sess-1', cwd: '/work/app', model_provider: 'openai' } },
    { timestamp: '2026-11-13T00:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5.4-mini', cwd: '/work/app' } },
    { timestamp: '2026-11-13T00:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: 'SECRET_ARG' } },
    { timestamp: '2026-11-13T00:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_1', output: 'hello' } },
    {
      timestamp: '2026-11-13T00:00:04.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 999, cached_input_tokens: 0, output_tokens: 999, reasoning_output_tokens: 0, total_tokens: 1998 },
          last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 113 },
        },
      },
    },
  ];
}

adapterContract(adapter, () => {
  const home = tempHome();
  writeJsonl(file(home), lines());
  return home;
});

describe('codex parsing', () => {
  test('uses last_token_usage and treats cached input as a subset', async () => {
    const home = tempHome();
    writeJsonl(file(home), lines());
    const [e] = eventsOf(await collect(adapter, home));
    expect(e).toMatchObject({
      id: 'codex:sess-1:1',
      agent: 'codex',
      sessionId: 'sess-1',
      project: '/work/app',
      provider: 'openai',
      modelRaw: 'gpt-5.4-mini',
      inputTokens: 60,
      outputTokens: 10,
      reasoningTokens: 3,
      cacheReadTokens: 40,
      kind: 'step',
      ts: Date.parse('2026-11-13T00:00:04.000Z'),
      tools: [{ callId: 'call_1', name: 'exec_command', resultBytes: 5 }],
    });
    expect(JSON.stringify(e)).not.toContain('SECRET_ARG');
    expect(e?.inputTokens).not.toBe(999);
  });

  test('appended turns keep the earlier ordinal', async () => {
    const home = tempHome();
    writeJsonl(file(home), lines());
    const state = memoryState();
    await collect(adapter, home, state);
    appendJsonl(file(home), [{
      timestamp: '2026-11-13T00:01:00.000Z',
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 8, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 10 } } },
    }]);
    expect(eventsOf(await collect(adapter, home, state)).map((e) => e.id)).toEqual(['codex:sess-1:2']);
  });
});
