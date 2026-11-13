import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import adapter from '../../src/adapters/gemini-cli';
import { adapterContract, collect, eventsOf, tempHome } from './contract';
import { writeJson } from './fixtures';

function chat(home: string): string {
  return join(home, '.gemini', 'tmp', 'proj', 'chats', 'session-1.json');
}

function seed(home: string): void {
  writeJson(chat(home), {
    sessionId: 'chat-1',
    cwd: '/work/app',
    title: 'Rename the helper',
    messages: [
      { id: 'u1', timestamp: '2026-11-01T00:00:00.000Z', type: 'user', content: 'PROMPT_SECRET' },
      {
        id: 'm1',
        timestamp: '2026-11-01T00:00:02.000Z',
        type: 'gemini',
        model: 'gemini-3.5-flash',
        content: 'PROMPT_SECRET',
        tokens: { input: 100, output: 20, cached: 40, thoughts: 5 },
      },
      {
        id: 'm2',
        timestamp: '2026-11-01T00:00:03.000Z',
        type: 'gemini',
        model: 'gemini-3.5-flash',
        usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 4, cachedContentTokenCount: 2, thoughtsTokenCount: 1 },
      },
    ],
  });
  writeJson(join(home, '.gemini', 'tmp', 'proj', 'logs.json'), {
    messages: [{ id: 'nope', timestamp: '2026-11-01T00:00:00.000Z', model: 'gemini-3.5-flash', tokens: { input: 500, output: 500 } }],
  });
}

adapterContract(adapter, () => {
  const home = tempHome();
  seed(home);
  return home;
});

describe('gemini cli parsing', () => {
  test('reads split token objects and subtracts cache from API prompt counts', async () => {
    const home = tempHome();
    seed(home);
    const events = eventsOf(await collect(adapter, home));
    expect(events.map((e) => e.id)).toEqual(['gemini-cli:chat-1:m1', 'gemini-cli:chat-1:m2']);
    expect(events[0]).toMatchObject({
      agent: 'gemini-cli', sessionId: 'chat-1', project: '/work/app', provider: 'google', modelRaw: 'gemini-3.5-flash',
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, reasoningTokens: 5, kind: 'step',
    });
    expect(events[1]).toMatchObject({ inputTokens: 9, outputTokens: 4, cacheReadTokens: 2, reasoningTokens: 1 });
    expect(JSON.stringify(events)).not.toContain('PROMPT_SECRET');
  });

  test('settings with no chats is installed and ingests nothing', async () => {
    const home = tempHome();
    writeJson(join(home, '.gemini', 'settings.json'), { model: 'gemini-3.5-flash' });
    expect((await adapter.detect({ home })).installed).toBe(true);
    expect(eventsOf(await collect(adapter, home))).toEqual([]);
  });
});
