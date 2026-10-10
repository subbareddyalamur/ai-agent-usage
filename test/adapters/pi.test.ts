import { describe, expect, test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import adapter from '../../src/adapters/pi';
import type { IngestItem } from '../../src/core/types';
import { adapterContract, collect, eventsOf, memoryState, tempHome } from './contract';
import { appendJsonl, writeJsonl } from './fixtures';

const file = (home: string, name = '2026-10-01T10-00-00-000Z_sess-uuid-1.jsonl'): string =>
  join(home, '.pi', 'agent', 'sessions', '--work-app--', name);

const assistant = (id: string, over: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) => ({
  type: 'message',
  id,
  parentId: null,
  timestamp: '2026-10-01T10:00:05.000Z',
  message: {
    role: 'assistant',
    provider: 'amazon-bedrock',
    model: 'global.anthropic.claude-opus-4-6-v1',
    content: [{ type: 'text', text: 'x' }],
    usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20, totalTokens: 135, cost: { total: 0.0123 }, ...usage },
    ...over,
  },
});

function fixtureHome(): string {
  const home = tempHome();
  writeJsonl(file(home), [{ type: 'session', id: 'sess-uuid-1', cwd: '/work/app', timestamp: '2026-10-01T10:00:00.000Z' }, assistant('a1')]);
  return home;
}

adapterContract(adapter, fixtureHome);

const resultsOf = (items: readonly IngestItem[]) => items.flatMap((i) => (i.type === 'toolResult' ? [i.result] : []));

describe('pi parsing', () => {
  test('maps usage, provider, cost, project and ids', async () => {
    const [e] = eventsOf(await collect(adapter, fixtureHome()));
    expect(e).toMatchObject({
      id: 'pi:sess-uuid-1:a1', agent: 'pi', sessionId: 'sess-uuid-1', project: '/work/app', provider: 'amazon-bedrock',
      modelRaw: 'global.anthropic.claude-opus-4-6-v1', inputTokens: 10, outputTokens: 5, cacheReadTokens: 100,
      cacheWrite5mTokens: 20, cacheWrite1hTokens: 0, reasoningTokens: 0, reportedCostUsd: 0.0123, kind: 'step', isSubagent: false,
    });
  });

  test('takes the session id from the filename when there is no session line', async () => {
    const home = tempHome();
    writeJsonl(file(home), [assistant('a1')]);
    expect(eventsOf(await collect(adapter, home))[0]?.sessionId).toBe('sess-uuid-1');
  });

  test('keeps ARN and non-bedrock providers as recorded', async () => {
    const home = tempHome();
    writeJsonl(file(home), [
      assistant('a1', { model: 'arn:aws:bedrock:us-east-1:1:application-inference-profile/abc' }),
      assistant('a2', { provider: 'ollama', model: 'glm-4.7:cloud' }, { cost: { total: 0 } }),
    ]);
    const events = eventsOf(await collect(adapter, home));
    expect(events.map((e) => [e.provider, e.modelRaw, e.reportedCostUsd])).toEqual([
      ['amazon-bedrock', 'arn:aws:bedrock:us-east-1:1:application-inference-profile/abc', 0.0123],
      ['ollama', 'glm-4.7:cloud', 0],
    ]);
  });

  test('skips zero-usage (failed/aborted) assistant messages and non-assistant roles', async () => {
    const home = tempHome();
    writeJsonl(file(home), [
      assistant('z', {}, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
      { type: 'message', id: 'u1', timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: 'hi' } },
      assistant('ok'),
    ]);
    expect(eventsOf(await collect(adapter, home)).map((e) => e.id)).toEqual(['pi:sess-uuid-1:ok']);
  });

  test('collects toolCall blocks and toolResult sizes', async () => {
    const home = tempHome();
    writeJsonl(file(home), [
      assistant('a1', { content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }, { type: 'toolCall', id: 'c2', name: 'read', arguments: {} }] }),
      { type: 'message', id: 'r1', timestamp: '2026-10-01T10:00:06.000Z', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'hello' }], isError: false } },
      { type: 'message', id: 'r2', timestamp: '2026-10-01T10:00:07.000Z', message: { role: 'toolResult', toolCallId: 'c2', toolName: 'read', content: [{ type: 'text', text: 'oops' }], isError: true } },
    ]);
    const items = await collect(adapter, home);
    expect(eventsOf(items)[0]?.tools).toEqual([{ callId: 'c1', name: 'bash' }, { callId: 'c2', name: 'read' }]);
    expect(resultsOf(items)).toEqual([{ callId: 'c1', resultBytes: 5 }, { callId: 'c2', resultBytes: 4, isError: true }]);
  });

  test('emits the session title from session_info', async () => {
    const home = tempHome();
    writeJsonl(file(home), [{ type: 'session', id: 's', cwd: '/w' }, { type: 'session_info', id: 'i', name: 'My session' }, assistant('a1')]);
    const meta = (await collect(adapter, home)).flatMap((i) => (i.type === 'session' ? [i.meta] : []));
    expect(meta).toEqual([{ agent: 'pi', sessionId: 's', title: 'My session', project: '/w' }]);
  });
});

describe('pi incremental ingest', () => {
  test('resumes and keeps session id / cwd for appended lines', async () => {
    const home = fixtureHome();
    const state = memoryState();
    await collect(adapter, home, state);
    appendJsonl(file(home), [assistant('a2')]);
    const [e, ...rest] = eventsOf(await collect(adapter, home, state));
    expect(rest).toHaveLength(0);
    expect(e).toMatchObject({ id: 'pi:sess-uuid-1:a2', project: '/work/app' });
    expect(await collect(adapter, home, state)).toEqual([]);
  });

  test('defers a partial trailing line', async () => {
    const home = fixtureHome();
    const state = memoryState();
    await collect(adapter, home, state);
    const line = JSON.stringify(assistant('a2'));
    appendFileSync(file(home), line.slice(0, 25));
    expect(await collect(adapter, home, state)).toEqual([]);
    appendFileSync(file(home), line.slice(25) + '\n');
    expect(eventsOf(await collect(adapter, home, state)).map((e) => e.id)).toEqual(['pi:sess-uuid-1:a2']);
  });
});
