import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import adapter from '../../src/adapters/cursor';
import type { IngestItem } from '../../src/core/types';
import { adapterContract, collect, eventsOf, memoryState, tempHome } from './contract';

function dbFile(home: string): string {
  const dir = join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'state.vscdb');
}

function open(home: string): Database {
  const db = new Database(dbFile(home), { create: true });
  db.exec(`CREATE TABLE IF NOT EXISTS cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS composerHeaders (
      composerId TEXT PRIMARY KEY, createdAt INTEGER, isSubagent INTEGER, value TEXT)`);
  return db;
}

const T0 = 1_763_000_000_000;

function seed(home: string): void {
  const db = open(home);
  db.query('INSERT INTO composerHeaders (composerId, createdAt, isSubagent, value) VALUES (?, ?, ?, ?)').run(
    'comp-1', T0, 0, JSON.stringify({ trackedGitRepos: [{ repoPath: '/work/app', branches: [] }] }),
  );
  db.query('INSERT INTO composerHeaders (composerId, createdAt, isSubagent, value) VALUES (?, ?, ?, ?)').run(
    'comp-sub', T0, 1, JSON.stringify({ trackedGitRepos: [] }),
  );
  db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'composerData:comp-1',
    JSON.stringify({
      name: 'Fix tests',
      contextTokensUsed: 999999,
      modelConfig: { modelName: 'grok-4.7', selectedModels: [{ modelId: 'grok-4.7' }] },
    }),
  );
  db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'composerData:comp-sub',
    JSON.stringify({ name: 'Sub', modelConfig: { modelName: 'default', selectedModels: [{ modelId: 'gpt-5.5' }] } }),
  );
  db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'bubbleId:comp-1:bub-1',
    JSON.stringify({
      bubbleId: 'bub-1',
      createdAt: T0 + 5,
      text: 'PROMPT_SECRET',
      tokenCount: { inputTokens: 100, outputTokens: 20 },
      toolFormerData: { name: 'read_file', toolCallId: 'call-1', result: 'abcd' },
    }),
  );
  db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'bubbleId:comp-1:bub-0',
    JSON.stringify({ bubbleId: 'bub-0', createdAt: T0, tokenCount: { inputTokens: 0, outputTokens: 0 }, text: 'ZERO' }),
  );
  db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
    'bubbleId:comp-sub:bub-9',
    JSON.stringify({ bubbleId: 'bub-9', createdAt: T0 + 9, tokenCount: { inputTokens: 4, outputTokens: 1 } }),
  );
  db.close();
}

adapterContract(adapter, () => {
  const home = tempHome();
  seed(home);
  return home;
});

const metas = (items: readonly IngestItem[]) => items.flatMap((i) => (i.type === 'session' ? [i.meta] : []));

describe('cursor parsing', () => {
  test('uses per-bubble counts, the composer model, and not the context gauge', async () => {
    const home = tempHome();
    seed(home);
    const items = await collect(adapter, home);
    const events = eventsOf(items);
    expect(events.map((e) => e.id).sort()).toEqual(['cursor:comp-1:bub-1', 'cursor:comp-sub:bub-9']);
    expect(events.find((e) => e.id === 'cursor:comp-1:bub-1')).toMatchObject({
      agent: 'cursor', sessionId: 'comp-1', project: '/work/app', provider: 'xai', modelRaw: 'grok-4.7',
      inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, reasoningTokens: 0, ts: T0 + 5, isSubagent: false, kind: 'step',
      tools: [{ callId: 'call-1', name: 'read_file', resultBytes: 4 }],
    });
    expect(events.find((e) => e.sessionId === 'comp-sub')).toMatchObject({ modelRaw: 'gpt-5.5', isSubagent: true, provider: 'openai' });
    expect(events.reduce((s, e) => s + e.inputTokens, 0)).toBe(104);
    expect(JSON.stringify(items)).not.toContain('PROMPT_SECRET');
    expect(metas(items)).toContainEqual({ agent: 'cursor', sessionId: 'comp-1', title: 'Fix tests', project: '/work/app' });
  });

  test('a chat with only a context window still counts, and a chat with bubble tokens ignores the window', async () => {
    const home = tempHome();
    const db = open(home);
    db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      'composerData:comp-win',
      JSON.stringify({
        name: 'Today', lastUpdatedAt: T0 + 20, contextTokensUsed: 5000,
        modelConfig: { modelName: 'grok-4.7' },
      }),
    );
    db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      'bubbleId:comp-win:bub-z',
      JSON.stringify({ bubbleId: 'bub-z', createdAt: T0 + 20, tokenCount: { inputTokens: 0, outputTokens: 0 } }),
    );
    db.close();
    const events = eventsOf(await collect(adapter, home));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: 'cursor:comp-win:context', modelRaw: 'grok-4.7', provider: 'xai',
      inputTokens: 5000, outputTokens: 0, ts: T0 + 20,
    });
  });

  test('a bubble with no timestamp uses the composer last update', async () => {
    const home = tempHome();
    const db = open(home);
    const updated = T0 + 50;
    db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      'composerData:comp-late',
      JSON.stringify({ name: 'Late', createdAt: T0, lastUpdatedAt: updated, modelConfig: { modelName: 'gpt-5.5' } }),
    );
    db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      'bubbleId:comp-late:bub-late',
      JSON.stringify({ bubbleId: 'bub-late', tokenCount: { inputTokens: 12, outputTokens: 3 } }),
    );
    db.close();
    const [e] = eventsOf(await collect(adapter, home));
    expect(e).toMatchObject({ id: 'cursor:comp-late:bub-late', ts: updated, inputTokens: 12, outputTokens: 3, modelRaw: 'gpt-5.5' });
  });

  test('a corrupt database is skipped', async () => {
    const home = tempHome();
    const dir = join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.vscdb'), 'not sqlite');
    expect((await adapter.detect({ home })).installed).toBe(true);
    expect(await collect(adapter, home)).toEqual([]);
  });

  test('a second run reads only when the database changes', async () => {
    const home = tempHome();
    seed(home);
    const state = memoryState();
    expect(eventsOf(await collect(adapter, home, state)).map((e) => e.id).sort()).toEqual(['cursor:comp-1:bub-1', 'cursor:comp-sub:bub-9']);
    expect(eventsOf(await collect(adapter, home, state))).toEqual([]);
    const db = new Database(dbFile(home));
    db.query('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run(
      'bubbleId:comp-1:bub-2',
      JSON.stringify({ bubbleId: 'bub-2', createdAt: T0 + 8, tokenCount: { inputTokens: 3, outputTokens: 1 } }),
    );
    db.close();
    const touched = dbFile(home);
    const later = new Date(Date.now() + 2000);
    utimesSync(touched, later, later);
    expect(eventsOf(await collect(adapter, home, state)).map((e) => e.id)).toContain('cursor:comp-1:bub-2');
  });
});
