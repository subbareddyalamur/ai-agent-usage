import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import adapter from '../../src/adapters/opencode';
import type { IngestItem } from '../../src/core/types';
import { adapterContract, collect, eventsOf, memoryState, tempHome } from './contract';
import { writeJson } from './fixtures';

const SESSION_COLS = `title TEXT, directory TEXT, parent_id TEXT, model TEXT,
  tokens_input INTEGER DEFAULT 0, tokens_output INTEGER DEFAULT 0, tokens_reasoning INTEGER DEFAULT 0,
  tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0,
  time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL`;

function openFixture(home: string, withLegacy = false): Database {
  const dir = join(home, '.local', 'share', 'opencode');
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, 'opencode.db'), { create: true });
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, ${SESSION_COLS});
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`);
  if (withLegacy) db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, ${SESSION_COLS});`);
  return db;
}

const T0 = 1_790_000_000_000;

function addSession(db: Database, id: string, o: { parent?: string; title?: string; model?: unknown; tokens?: number[]; updated?: number } = {}): void {
  const [i, out, r, cr, cw] = o.tokens ?? [0, 0, 0, 0, 0];
  db.query(`INSERT INTO session_v2 (id, title, directory, parent_id, model, tokens_input, tokens_output, tokens_reasoning,
      tokens_cache_read, tokens_cache_write, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, o.title ?? null, '/work/app', o.parent ?? null, o.model ? JSON.stringify(o.model) : null,
    i ?? 0, out ?? 0, r ?? 0, cr ?? 0, cw ?? 0, T0, o.updated ?? T0,
  );
}

function addStep(db: Database, id: string, session: string, o: {
  tokens?: unknown; model?: unknown; updated?: number; content?: unknown[]; cost?: number; type?: string;
} = {}): void {
  const data: Record<string, unknown> = {
    time: { created: T0 + 5 },
    model: o.model ?? { providerID: 'amazon-bedrock', id: 'claude-sonnet-5', variant: 'default' },
    content: o.content ?? [{ type: 'text', text: 'hi' }],
    cost: o.cost ?? 0,
    ...(o.tokens === null ? {} : { tokens: o.tokens ?? { input: 100, output: 10, reasoning: 4, cache: { read: 1000, write: 50 } } }),
  };
  db.query(`INSERT OR REPLACE INTO session_message (id, session_id, type, seq, time_created, time_updated, data)
    VALUES (?,?,?,?,?,?,?)`).run(id, session, o.type ?? 'assistant', 1, T0, o.updated ?? T0 + 10, JSON.stringify(data));
}

function fixtureHome(): string {
  const home = tempHome();
  const db = openFixture(home);
  addSession(db, 'ses_1', { title: 'Hello', tokens: [100, 10, 4, 1000, 50] });
  addStep(db, 'msg_1', 'ses_1');
  db.close();
  return home;
}

adapterContract(adapter, fixtureHome);

const metas = (items: readonly IngestItem[]) => items.flatMap((i) => (i.type === 'session' ? [i.meta] : []));

describe('opencode parsing', () => {
  test('maps a step: tokens, model key, provider, project, ids', async () => {
    const [e] = eventsOf(await collect(adapter, fixtureHome()));
    expect(e).toMatchObject({
      id: 'opencode:ses_1:msg_1', agent: 'opencode', sessionId: 'ses_1', project: '/work/app', provider: 'amazon-bedrock',
      modelRaw: 'claude-sonnet-5', inputTokens: 100, outputTokens: 10, reasoningTokens: 4, cacheReadTokens: 1000,
      cacheWrite5mTokens: 50, cacheWrite1hTokens: 0, kind: 'step', isSubagent: false, ts: T0 + 5,
    });
    expect(e?.reportedCostUsd).toBeUndefined();
  });

  test('passes through a positive reported cost only', async () => {
    const home = tempHome();
    const db = openFixture(home);
    addSession(db, 's');
    addStep(db, 'a', 's', { cost: 0.5 });
    addStep(db, 'b', 's', { cost: 0 });
    db.close();
    const byId = Object.fromEntries(eventsOf(await collect(adapter, home)).map((e) => [e.id.split(':')[2], e.reportedCostUsd]));
    expect(byId).toEqual({ a: 0.5, b: undefined });
  });

  test('skips steps without tokens (in progress) and non-assistant messages', async () => {
    const home = tempHome();
    const db = openFixture(home);
    addSession(db, 's');
    addStep(db, 'inprog', 's', { tokens: null });
    addStep(db, 'user', 's', { type: 'user' });
    addStep(db, 'zero', 's', { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
    addStep(db, 'ok', 's');
    db.close();
    expect(eventsOf(await collect(adapter, home)).map((e) => e.id)).toEqual(['opencode:s:ok']);
  });

  test('flags child sessions as subagents', async () => {
    const home = tempHome();
    const db = openFixture(home);
    addSession(db, 'parent');
    addSession(db, 'child', { parent: 'parent' });
    addStep(db, 'a', 'parent');
    addStep(db, 'b', 'child');
    db.close();
    const byId = Object.fromEntries(eventsOf(await collect(adapter, home)).map((e) => [e.sessionId, e.isSubagent]));
    expect(byId).toEqual({ parent: false, child: true });
  });

  test('extracts tool calls with result sizes, pending calls have no size', async () => {
    const home = tempHome();
    const db = openFixture(home);
    addSession(db, 's');
    addStep(db, 'a', 's', {
      content: [
        { type: 'text', text: 'x' },
        { type: 'tool', id: 'c1', name: 'bash', state: { status: 'completed', content: 'héllo' } },
        { type: 'tool', id: 'c2', name: 'read', state: { status: 'error', content: 'oops', error: 'boom' } },
        { type: 'tool', id: 'c3', name: 'grep', state: { status: 'running' } },
      ],
    });
    db.close();
    expect(eventsOf(await collect(adapter, home))[0]?.tools).toEqual([
      { callId: 'c1', name: 'bash', resultBytes: 6 },
      { callId: 'c2', name: 'read', resultBytes: 4, isError: true },
      { callId: 'c3', name: 'grep' },
    ]);
  });

  test('awsProfileHint from opencode.json applies to bedrock steps only', async () => {
    const home = tempHome();
    const db = openFixture(home);
    addSession(db, 's');
    addStep(db, 'work', 's');
    addStep(db, 'oth', 's', { model: { providerID: 'openrouter', id: 'deepseek/x' } });
    db.close();
    writeJson(join(home, '.config', 'opencode', 'opencode.json'), { provider: { 'amazon-bedrock': { options: { profile: 'work' } } } });
    const byId = Object.fromEntries(eventsOf(await collect(adapter, home)).map((e) => [e.id.split(':')[2], e.awsProfileHint]));
    expect(byId).toEqual({ work: 'work', oth: undefined });
  });

  test('emits session titles and projects', async () => {
    expect(metas(await collect(adapter, fixtureHome()))).toEqual([
      { agent: 'opencode', sessionId: 'ses_1', title: 'Hello', project: '/work/app' },
    ]);
  });

  test('sessions with totals but no per-step data become one session_total event', async () => {
    const home = tempHome();
    const db = openFixture(home);
    addSession(db, 'bare', { tokens: [5, 6, 0, 7, 8], model: { providerID: 'amazon-bedrock', id: 'claude-sonnet-5' } });
    addSession(db, 'stepped', { tokens: [1, 1, 0, 0, 0] });
    addStep(db, 'a', 'stepped');
    db.close();
    const events = eventsOf(await collect(adapter, home));
    const total = events.find((e) => e.kind === 'session_total');
    expect(total).toMatchObject({
      id: 'opencode:total:bare', sessionId: 'bare', inputTokens: 5, outputTokens: 6, cacheReadTokens: 7, cacheWrite5mTokens: 8,
      modelRaw: 'claude-sonnet-5',
    });
    expect(events.filter((e) => e.kind === 'session_total')).toHaveLength(1);
  });

  test('pre-v2 sessions that never reached session_v2 become legacy session_total events', async () => {
    const home = tempHome();
    const db = openFixture(home, true);
    db.query(`INSERT INTO session (id, title, directory, model, tokens_input, tokens_output, time_created, time_updated)
      VALUES ('old', 't', '/work/old', '{"providerID":"opencode","id":"glm-4.7-free"}', 9, 3, ?, ?)`).run(T0, T0);
    db.close();
    const [e] = eventsOf(await collect(adapter, home));
    expect(e).toMatchObject({ id: 'opencode:legacy:old', kind: 'session_total', inputTokens: 9, outputTokens: 3, modelRaw: 'glm-4.7-free', provider: 'opencode' });
  });

  test('detect() is false when the database lacks the v2 tables', async () => {
    const home = tempHome();
    const dir = join(home, '.local', 'share', 'opencode');
    mkdirSync(dir, { recursive: true });
    const db = new Database(join(dir, 'opencode.db'), { create: true });
    db.exec('CREATE TABLE other (x INTEGER)');
    db.close();
    expect((await adapter.detect({ home })).installed).toBe(false);
  });

  test('detect() is false for a corrupt database file', async () => {
    const home = tempHome();
    const dir = join(home, '.local', 'share', 'opencode');
    mkdirSync(dir, { recursive: true });
    await Bun.write(join(dir, 'opencode.db'), 'this is not sqlite');
    expect((await adapter.detect({ home })).installed).toBe(false);
  });
});

describe('opencode incremental ingest', () => {
  test('only re-reads steps at/after the watermark; a completed step is picked up', async () => {
    const home = tempHome();
    const db = openFixture(home);
    addSession(db, 's', { updated: T0 + 100 });
    addStep(db, 'old', 's', { updated: T0 + 50 });
    addStep(db, 'a', 's', { updated: T0 + 100 });
    addStep(db, 'b', 's', { tokens: null, updated: T0 + 100 });
    const state = memoryState();
    expect(eventsOf(await collect(adapter, home, state)).map((e) => e.id).sort()).toEqual(['opencode:s:a', 'opencode:s:old']);

    addStep(db, 'b', 's', { updated: T0 + 200 });
    addStep(db, 'c', 's', { updated: T0 + 300 });
    const second = eventsOf(await collect(adapter, home, state)).map((e) => e.id);
    expect(second).toContain('opencode:s:b');
    expect(second).toContain('opencode:s:c');
    expect(second).not.toContain('opencode:s:old');
    db.close();
  });

  test('reads the live database read-only (never writes)', async () => {
    const home = fixtureHome();
    await collect(adapter, home);
    const db = new Database(join(home, '.local', 'share', 'opencode', 'opencode.db'));
    expect((db.query('SELECT COUNT(*) AS n FROM session_message').get() as { n: number }).n).toBe(1);
    db.close();
  });
});
