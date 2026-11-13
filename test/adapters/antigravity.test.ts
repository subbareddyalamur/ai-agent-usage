import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import adapter from '../../src/adapters/antigravity';
import cli from '../../src/adapters/antigravity-cli';
import ide from '../../src/adapters/antigravity-ide';
import { generationFromBlob } from '../../src/adapters/lib/antigravity';
import type { IngestItem } from '../../src/core/types';
import { adapterContract, collect, eventsOf, tempHome } from './contract';
import { writeJsonl } from './fixtures';

const T0 = '2026-11-13T04:12:33Z';

function metaBlob(model: string, lastStep: number): Buffer {
  const step = String(lastStep);
  // A protobuf tag separates the model string from the next field, as in the real blobs.
  return Buffer.concat([
    Buffer.from([0x9a, 0x01, model.length]),
    Buffer.from(model),
    Buffer.from([0xa2]),
    Buffer.from('last_step_index'),
    Buffer.from([0x12, step.length]),
    Buffer.from(step),
  ]);
}

function transcript(home: string, product: string, id = 'conv-1'): string {
  return join(home, '.gemini', product, 'brain', id, '.system_generated', 'logs', 'transcript.jsonl');
}

function seed(home: string, product: string): void {
  const id = 'conv-1';
  writeJsonl(transcript(home, product, id), [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: T0, content: 'PROMPT_SECRET' },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      created_at: '2026-11-13T04:13:00Z',
      content: 'PROMPT_SECRET',
      thinking: 'SECRET_THINKING',
      input_tokens: 2369,
      cache_read_tokens: 9879,
      output_tokens: 756,
      tool_calls: [{ name: 'view_file', args: { path: 'SECRET_ARG' } }],
    },
  ]);
  const dir = join(home, '.gemini', product, 'conversations');
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, `${id}.db`), { create: true });
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)');
  const insert = db.query('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)');
  const early = metaBlob('gemini-2.0-old', 0);
  const late = metaBlob('gemini-3.5-flash', 4);
  insert.run(0, early, early.length);
  insert.run(1, late, late.length);
  db.close();
  const summaries = new Database(join(home, '.gemini', product, 'conversation_summaries.db'), { create: true });
  summaries.exec(`CREATE TABLE conversation_summaries (
    conversation_id TEXT PRIMARY KEY, title TEXT, workspace_uris TEXT,
    parent_conversation_id TEXT, nesting_depth INTEGER)`);
  summaries.query('INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)').run(
    id, 'Plan the change', '["file:///work/app"]', 'parent-1', 1,
  );
  summaries.close();
}

adapterContract(adapter, () => {
  const home = tempHome();
  seed(home, 'antigravity');
  return home;
});

const metas = (items: readonly IngestItem[]) => items.flatMap((i) => (i.type === 'session' ? [i.meta] : []));

describe('antigravity parsing', () => {
  test('maps a transcript step and takes the model that covers it', async () => {
    const home = tempHome();
    seed(home, 'antigravity');
    const items = await collect(adapter, home);
    const [e] = eventsOf(items);
    expect(e).toMatchObject({
      id: 'antigravity:conv-1:2',
      agent: 'antigravity',
      sessionId: 'conv-1',
      project: '/work/app',
      provider: 'google',
      modelRaw: 'gemini-3.5-flash',
      inputTokens: 2369,
      outputTokens: 756,
      cacheReadTokens: 9879,
      reasoningTokens: 0,
      kind: 'step',
      isSubagent: true,
      ts: Date.parse('2026-11-13T04:13:00Z'),
    });
    expect(e?.tools).toEqual([{ callId: 'conv-1:2:0', name: 'view_file' }]);
    expect(JSON.stringify(items)).not.toContain('PROMPT_SECRET');
    expect(JSON.stringify(items)).not.toContain('SECRET_THINKING');
    expect(JSON.stringify(items)).not.toContain('SECRET_ARG');
    expect(metas(items)).toContainEqual({
      agent: 'antigravity', sessionId: 'conv-1', title: 'Plan the change', project: '/work/app',
    });
  });

  test('a step with no token fields produces no event', async () => {
    const home = tempHome();
    writeJsonl(transcript(home, 'antigravity'), [
      { step_index: 1, created_at: T0, type: 'VIEW_FILE', content: 'file body' },
    ]);
    expect(eventsOf(await collect(adapter, home))).toEqual([]);
  });

  test('reads a labelled model id out of a metadata blob and ignores other bytes', () => {
    const blob = Buffer.concat([Buffer.from([0x00, 0x99, 0x01]), metaBlob('claude-opus-4-6', 3)]);
    expect(generationFromBlob(blob, 1)).toEqual({ idx: 1, lastStep: 3, model: 'claude-opus-4-6' });
    expect(generationFromBlob(Buffer.from('VOiT\x00\x01no model here'), 0)).toBeUndefined();
    const noisy = Buffer.concat([Buffer.from('o1-j92p-Q_MvK_BDAJ'), Buffer.from([0xa2]), metaBlob('gemini-pro-orchestrator-g1-pro', 4)]);
    expect(generationFromBlob(noisy, 2)?.model).toBe('gemini-pro-orchestrator-g1-pro');
  });
});

describe('antigravity cli and ide', () => {
  test('cli contract home is detected', async () => {
    const home = tempHome();
    seed(home, 'antigravity-cli');
    expect((await cli.detect({ home })).installed).toBe(true);
    expect(eventsOf(await collect(cli, home))[0]?.agent).toBe('antigravity-cli');
  });

  test('a cli transcript without token counts yields the session and no usage', async () => {
    const home = tempHome();
    writeJsonl(join(home, '.gemini', 'antigravity-cli', 'history.jsonl'), [
      { display: 'Hello', timestamp: 1_700_000_000_000, workspace: '/work/cli', conversationId: 'hist-1' },
    ]);
    writeJsonl(transcript(home, 'antigravity-cli', 'hist-1'), [
      { step_index: 1, created_at: T0, type: 'PLANNER_RESPONSE', content: 'no counts' },
    ]);
    const items = await collect(cli, home);
    expect(eventsOf(items)).toEqual([]);
    expect(metas(items)).toContainEqual({ agent: 'antigravity-cli', sessionId: 'hist-1', title: 'Hello', project: '/work/cli' });
  });

  test('ide detect is false until a transcript exists', async () => {
    expect((await ide.detect({ home: tempHome() })).installed).toBe(false);
    const home = tempHome();
    seed(home, 'antigravity-ide');
    expect((await ide.detect({ home })).installed).toBe(true);
    expect(eventsOf(await collect(ide, home)).length).toBe(1);
  });
});
