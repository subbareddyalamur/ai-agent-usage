import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import adapter from '../../src/adapters/cowork';
import { adapterContract, collect, eventsOf, memoryState, tempHome } from './contract';
import { appendJsonl, claudeAssistant, claudeToolResult, writeJson, writeJsonl } from './fixtures';

const base = (home: string): string => join(home, 'Library', 'Application Support', 'Claude-3p');
const audit = (home: string, id = 'a1'): string => join(base(home), 'local-agent-mode-sessions', 'u1', 'u2', id, 'audit.jsonl');
const K = { sessionKey: 'session_id' as const, sessionId: 'cw-1' };

function fixtureHome(): string {
  const home = tempHome();
  writeJsonl(audit(home), [
    { type: 'system', subtype: 'init', session_id: 'cw-1', cwd: '/work/cowork', timestamp: '2026-10-01T09:59:00.000Z' },
    claudeAssistant({ msgId: 'msg_bdrk_1', ...K, usage: { input_tokens: 50, output_tokens: 5, cache_read_input_tokens: 200 } }),
  ]);
  return home;
}

adapterContract(adapter, fixtureHome);

describe('cowork parsing', () => {
  test('uses session_id, takes project from the system init record, provider from message id', async () => {
    const [e] = eventsOf(await collect(adapter, fixtureHome()));
    expect(e).toMatchObject({
      id: 'cowork:cw-1:msg_bdrk_1', agent: 'cowork', sessionId: 'cw-1', project: '/work/cowork',
      provider: 'amazon-bedrock', inputTokens: 50, cacheReadTokens: 200, isSubagent: false,
    });
  });

  test('flags messages with a parent_tool_use_id as subagent work', async () => {
    const home = tempHome();
    writeJsonl(audit(home), [
      claudeAssistant({ msgId: 'main', ...K, parentToolUseId: null }),
      claudeAssistant({ msgId: 'sub', ...K, parentToolUseId: 'toolu_1' }),
    ]);
    const byId = Object.fromEntries(eventsOf(await collect(adapter, home)).map((e) => [e.id.split(':')[2], e.isSubagent]));
    expect(byId).toEqual({ main: false, sub: true });
  });

  test('tool_result sizes work with session_id records', async () => {
    const home = tempHome();
    writeJsonl(audit(home), [claudeToolResult({ toolUseId: 't', content: 'abcd', ...K })]);
    const items = await collect(adapter, home);
    expect(items.find((i) => i.type === 'toolResult')).toEqual({
      type: 'toolResult', agent: 'cowork', result: { callId: 't', resultBytes: 4 },
    });
  });

  test('carries cwd from the init record to later incremental runs', async () => {
    const home = fixtureHome();
    const state = memoryState();
    await collect(adapter, home, state);
    appendJsonl(audit(home), [claudeAssistant({ msgId: 'msg_2', ...K })]);
    expect(eventsOf(await collect(adapter, home, state))[0]?.project).toBe('/work/cowork');
  });

  test('awsProfileHint comes from the applied configLibrary entry', async () => {
    const home = fixtureHome();
    writeJson(join(base(home), 'configLibrary', '_meta.json'), { appliedId: 'cfg1', entries: [] });
    writeJson(join(base(home), 'configLibrary', 'cfg1.json'), { inferenceBedrockProfile: 'work' });
    expect(eventsOf(await collect(adapter, home))[0]?.awsProfileHint).toBe('work');
  });

  test('no hint when configLibrary is absent or malformed', async () => {
    expect(eventsOf(await collect(adapter, fixtureHome()))[0]?.awsProfileHint).toBeUndefined();
    const home = fixtureHome();
    writeJson(join(base(home), 'configLibrary', '_meta.json'), { appliedId: 'missing' });
    expect(eventsOf(await collect(adapter, home))[0]?.awsProfileHint).toBeUndefined();
  });
});

describe('cowork timestamps', () => {
  test('falls back to _audit_timestamp, then to the last seen timestamp', async () => {
    const home = tempHome();
    const noTs = (msgId: string, extra: Record<string, unknown>): Record<string, unknown> => {
      const rec = claudeAssistant({ msgId, ...K }) as Record<string, unknown>;
      delete rec.timestamp;
      return { ...rec, ...extra };
    };
    writeJsonl(audit(home), [
      { type: 'system', subtype: 'init', session_id: 'cw-1', timestamp: '2026-10-02T08:00:00.000Z' },
      noTs('audit', { _audit_timestamp: '2026-10-02T08:00:05.000Z' }),
      noTs('carried', {}),
    ]);
    const byId = Object.fromEntries(eventsOf(await collect(adapter, home)).map((e) => [e.id.split(':')[2], e.ts]));
    expect(byId).toEqual({ audit: Date.parse('2026-10-02T08:00:05.000Z'), carried: Date.parse('2026-10-02T08:00:05.000Z') });
  });

  test('skips a message when no timestamp is available anywhere', async () => {
    const home = tempHome();
    const rec = claudeAssistant({ msgId: 'x', ...K }) as Record<string, unknown>;
    delete rec.timestamp;
    writeJsonl(audit(home), [rec]);
    expect(eventsOf(await collect(adapter, home))).toEqual([]);
  });
});
