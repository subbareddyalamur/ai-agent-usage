import { describe, expect, test } from 'bun:test';
import { appendFileSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import adapter from '../../src/adapters/claude-code';
import type { IngestItem } from '../../src/core/types';
import { adapterContract, collect, eventsOf, memoryState, tempHome } from './contract';
import { appendJsonl, claudeAssistant, claudeToolResult, writeJson, writeJsonl } from './fixtures';

const transcript = (home: string, name = 'sess-1.jsonl'): string => join(home, '.claude', 'projects', '-proj', name);

function fixtureHome(): string {
  const home = tempHome();
  writeJsonl(transcript(home), [
    claudeAssistant({ msgId: 'msg_1', cwd: '/work/app', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 500 } }),
  ]);
  return home;
}

adapterContract(adapter, fixtureHome);

const toolResults = (items: readonly IngestItem[]) => items.flatMap((i) => (i.type === 'toolResult' ? [i.result] : []));
const sessions = (items: readonly IngestItem[]) => items.flatMap((i) => (i.type === 'session' ? [i.meta] : []));

describe('claude-code parsing', () => {
  test('maps usage, cache TTL split, project, provider and ids', async () => {
    const home = tempHome();
    writeJsonl(transcript(home), [
      claudeAssistant({
        msgId: 'msg_bdrk_abc', cwd: '/work/app', model: 'anthropic.claude-haiku-4-5-20251001-v1:0',
        usage: {
          input_tokens: 7, output_tokens: 11, cache_read_input_tokens: 13,
          cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
        },
      }),
    ]);
    const [e] = eventsOf(await collect(adapter, home));
    expect(e).toMatchObject({
      id: 'claude-code:sess-1:msg_bdrk_abc', agent: 'claude-code', sessionId: 'sess-1', project: '/work/app',
      provider: 'amazon-bedrock', modelRaw: 'anthropic.claude-haiku-4-5-20251001-v1:0', kind: 'step', isSubagent: false,
      inputTokens: 7, outputTokens: 11, cacheReadTokens: 13, cacheWrite5mTokens: 10, cacheWrite1hTokens: 20,
      ts: Date.parse('2026-10-01T10:00:00.000Z'),
    });
  });

  test('falls back to cache_creation_input_tokens as 5m writes when no TTL split', async () => {
    const home = tempHome();
    writeJsonl(transcript(home), [claudeAssistant({ msgId: 'm', usage: { input_tokens: 1, cache_creation_input_tokens: 42 } })]);
    const [e] = eventsOf(await collect(adapter, home));
    expect([e?.cacheWrite5mTokens, e?.cacheWrite1hTokens]).toEqual([42, 0]);
  });

  test('anthropic-api messages get provider "anthropic"', async () => {
    const home = tempHome();
    writeJsonl(transcript(home), [claudeAssistant({ msgId: 'msg_01X' })]);
    expect(eventsOf(await collect(adapter, home))[0]?.provider).toBe('anthropic');
  });

  test('merges streamed lines of one message: max usage, union of tool_use', async () => {
    const home = tempHome();
    writeJsonl(transcript(home), [
      claudeAssistant({ msgId: 'm', usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: 'thinking' }] }),
      claudeAssistant({ msgId: 'm', usage: { input_tokens: 10, output_tokens: 8 }, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }),
      claudeAssistant({ msgId: 'm', usage: { input_tokens: 10, output_tokens: 30 }, content: [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }] }),
    ]);
    const events = eventsOf(await collect(adapter, home));
    expect(events).toHaveLength(1);
    expect(events[0]?.outputTokens).toBe(30);
    expect(events[0]?.tools).toEqual([{ callId: 't1', name: 'Bash' }, { callId: 't2', name: 'Read' }]);
  });

  test('splits thinking tokens out of output (no double count)', async () => {
    const home = tempHome();
    writeJsonl(transcript(home), [
      claudeAssistant({ msgId: 'm', usage: { output_tokens: 100, output_tokens_details: { thinking_tokens: 30 } } }),
    ]);
    const [e] = eventsOf(await collect(adapter, home));
    expect([e?.outputTokens, e?.reasoningTokens]).toEqual([70, 30]);
  });

  test('skips <synthetic> models and zero-usage messages', async () => {
    const home = tempHome();
    writeJsonl(transcript(home), [
      claudeAssistant({ msgId: 's', model: '<synthetic>', usage: { input_tokens: 5 } }),
      claudeAssistant({ msgId: 'z', usage: { input_tokens: 0, output_tokens: 0 } }),
      claudeAssistant({ msgId: 'ok', usage: { input_tokens: 1 } }),
    ]);
    expect(eventsOf(await collect(adapter, home)).map((e) => e.id)).toEqual(['claude-code:sess-1:ok']);
  });

  test('flags subagents by isSidechain and by subagents/ path', async () => {
    const home = tempHome();
    writeJsonl(transcript(home), [
      claudeAssistant({ msgId: 'main' }),
      claudeAssistant({ msgId: 'side', isSidechain: true }),
    ]);
    writeJsonl(join(home, '.claude', 'projects', '-proj', 'sess-1', 'subagents', 'agent-abc.jsonl'), [
      claudeAssistant({ msgId: 'viapath' }),
    ]);
    const byId = Object.fromEntries(eventsOf(await collect(adapter, home)).map((e) => [e.id.split(':')[2], e.isSubagent]));
    expect(byId).toEqual({ main: false, side: true, viapath: true });
  });

  test('emits tool result sizes (string and block content) and error flag', async () => {
    const home = tempHome();
    writeJsonl(transcript(home), [
      claudeToolResult({ toolUseId: 'a', content: 'héllo' }),
      claudeToolResult({ toolUseId: 'b', content: [{ type: 'text', text: 'abc' }, { type: 'text', text: 'de' }] }),
      claudeToolResult({ toolUseId: 'c', content: 'x', isError: true }),
    ]);
    const r = toolResults(await collect(adapter, home));
    expect(r).toEqual([
      { callId: 'a', resultBytes: 6 },
      { callId: 'b', resultBytes: 5 },
      { callId: 'c', resultBytes: 1, isError: true },
    ]);
  });

  test('reads session titles from ai-title records and project from cwd', async () => {
    const home = tempHome();
    writeJsonl(transcript(home), [
      claudeAssistant({ msgId: 'm', cwd: '/work/app' }),
      { type: 'ai-title', sessionId: 'sess-1', aiTitle: 'Fix the thing' },
    ]);
    expect(sessions(await collect(adapter, home))).toEqual([
      { agent: 'claude-code', sessionId: 'sess-1', title: 'Fix the thing', project: '/work/app' },
    ]);
  });

  test('uses AWS_PROFILE from ~/.claude/settings.json as awsProfileHint', async () => {
    const home = fixtureHome();
    writeJson(join(home, '.claude', 'settings.json'), { env: { AWS_PROFILE: 'work' } });
    expect(eventsOf(await collect(adapter, home))[0]?.awsProfileHint).toBe('work');
  });

  test('ignores malformed lines', async () => {
    const home = fixtureHome();
    appendFileSync(transcript(home), 'not json at all\n{"type":"assistant"\n');
    expect(eventsOf(await collect(adapter, home))).toHaveLength(1);
  });
});

describe('claude-code incremental ingest', () => {
  test('resumes from the saved offset and does not re-emit old events', async () => {
    const home = fixtureHome();
    const state = memoryState();
    expect(eventsOf(await collect(adapter, home, state))).toHaveLength(1);
    appendJsonl(transcript(home), [claudeAssistant({ msgId: 'msg_2' })]);
    const second = eventsOf(await collect(adapter, home, state));
    expect(second.map((e) => e.id)).toEqual(['claude-code:sess-1:msg_2']);
    expect(await collect(adapter, home, state)).toEqual([]);
  });

  test('a partial trailing line is deferred until it is complete', async () => {
    const home = fixtureHome();
    const state = memoryState();
    await collect(adapter, home, state);
    const line = JSON.stringify(claudeAssistant({ msgId: 'msg_2' }));
    appendFileSync(transcript(home), line.slice(0, 40));
    expect(await collect(adapter, home, state)).toEqual([]);
    appendFileSync(transcript(home), line.slice(40) + '\n');
    expect(eventsOf(await collect(adapter, home, state)).map((e) => e.id)).toEqual(['claude-code:sess-1:msg_2']);
  });

  test('carries cwd across runs for lines that lack it', async () => {
    const home = fixtureHome();
    const state = memoryState();
    await collect(adapter, home, state);
    appendJsonl(transcript(home), [claudeAssistant({ msgId: 'msg_2' })]);
    expect(eventsOf(await collect(adapter, home, state))[0]?.project).toBe('/work/app');
  });

  test('re-reads a file from the start if it shrank', async () => {
    const home = fixtureHome();
    const state = memoryState();
    appendJsonl(transcript(home), [claudeAssistant({ msgId: 'msg_2' })]);
    await collect(adapter, home, state);
    truncateSync(transcript(home), Math.floor(statSync(transcript(home)).size / 2));
    writeJsonl(transcript(home), [claudeAssistant({ msgId: 'msg_9' })]);
    expect(eventsOf(await collect(adapter, home, state)).map((e) => e.id)).toEqual(['claude-code:sess-1:msg_9']);
  });
});
