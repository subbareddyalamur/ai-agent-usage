import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/core/db';
import { repriceUnpriced, runIngest } from '../../src/core/ingest';
import type { Adapter, IngestItem } from '../../src/core/types';
import { fakePricing, makeEvent } from '../helpers';

function adapter(id: string, items: IngestItem[], installed = true): Adapter {
  return {
    id,
    label: id,
    async detect() {
      return { installed, detail: installed ? 'ok' : 'missing' };
    },
    async *ingest(ctx) {
      const seen = (ctx.state.get<number>('n') ?? 0) + 1;
      ctx.state.set('n', seen);
      for (const i of items) yield i;
    },
  };
}

const count = (db: ReturnType<typeof openDb>, sql: string): number =>
  (db.query(sql).get() as { c: number }).c;

describe('runIngest', () => {
  test('writes events, tool calls and session meta', async () => {
    const db = openDb(':memory:');
    const a = adapter('a', [
      { type: 'event', event: makeEvent({ id: 'x', agent: 'a', tools: [{ callId: 't1', name: 'bash' }] }) },
      { type: 'toolResult', agent: 'a', result: { callId: 't1', resultBytes: 500 } },
      { type: 'session', meta: { agent: 'a', sessionId: 's1', title: 'hello' } },
    ]);
    const [r] = await runIngest(db, [a], fakePricing(), { home: '/h' });
    expect(r).toEqual({ id: 'a', installed: true, events: 1 });
    expect(db.query('SELECT result_bytes AS b, name FROM tool_calls').get()).toEqual({ b: 500, name: 'bash' });
    expect(db.query('SELECT title FROM sessions').get()).toEqual({ title: 'hello' });
    const ev = db.query('SELECT cost_usd AS c, priced FROM events').get() as { c: number; priced: number };
    expect(ev.priced).toBe(1);
    expect(ev.c).toBeCloseTo((100 + 10 * 5) / 1e6);
  });

  test('is idempotent: re-running does not duplicate rows', async () => {
    const db = openDb(':memory:');
    const items: IngestItem[] = [{ type: 'event', event: makeEvent({ id: 'x', agent: 'a' }) }];
    await runIngest(db, [adapter('a', items)], fakePricing(), { home: '/h' });
    await runIngest(db, [adapter('a', items)], fakePricing(), { home: '/h' });
    expect(count(db, 'SELECT COUNT(*) c FROM events')).toBe(1);
  });

  test('tool result arriving before the call still ends up with name and size', async () => {
    const db = openDb(':memory:');
    await runIngest(db, [adapter('a', [
      { type: 'toolResult', agent: 'a', result: { callId: 't1', resultBytes: 42 } },
      { type: 'event', event: makeEvent({ id: 'x', agent: 'a', tools: [{ callId: 't1', name: 'grep' }] }) },
    ])], fakePricing(), { home: '/h' });
    expect(db.query('SELECT name, result_bytes AS b FROM tool_calls').get()).toEqual({ name: 'grep', b: 42 });
  });

  test('not-installed adapters are skipped silently and history is kept', async () => {
    const db = openDb(':memory:');
    await runIngest(db, [adapter('a', [{ type: 'event', event: makeEvent({ id: 'x', agent: 'a' }) }])], fakePricing(), { home: '/h' });
    const [r] = await runIngest(db, [adapter('a', [], false)], fakePricing(), { home: '/h' });
    expect(r).toEqual({ id: 'a', installed: false, events: 0 });
    expect(count(db, 'SELECT COUNT(*) c FROM events')).toBe(1);
    expect(db.query('SELECT installed FROM adapter_runs').get()).toEqual({ installed: 0 });
  });

  test('a failing adapter does not stop others and its state is not advanced', async () => {
    const db = openDb(':memory:');
    const bad: Adapter = {
      id: 'bad', label: 'bad',
      async detect() { return { installed: true }; },
      async *ingest(ctx) { ctx.state.set('n', 1); yield* []; throw new Error('boom'); },
    };
    const good = adapter('good', [{ type: 'event', event: makeEvent({ id: 'g', agent: 'good' }) }]);
    const reports = await runIngest(db, [bad, good], fakePricing(), { home: '/h' });
    expect(reports.find((r) => r.id === 'bad')?.error).toBe('boom');
    expect(reports.find((r) => r.id === 'good')?.events).toBe(1);
    expect(count(db, "SELECT COUNT(*) c FROM adapter_state WHERE adapter = 'bad'")).toBe(0);
    expect(count(db, "SELECT COUNT(*) c FROM adapter_state WHERE adapter = 'good'")).toBe(1);
  });

  test('unpriced events get null cost and are re-priced later without touching priced ones', async () => {
    const db = openDb(':memory:');
    const items: IngestItem[] = [
      { type: 'event', event: makeEvent({ id: 'u', agent: 'a', modelRaw: 'mystery' }) },
      { type: 'event', event: makeEvent({ id: 'p', agent: 'a' }) },
    ];
    await runIngest(db, [adapter('a', items)], fakePricing({ unpriced: ['mystery'] }), { home: '/h' });
    expect(count(db, 'SELECT COUNT(*) c FROM events WHERE cost_usd IS NULL')).toBe(1);
    const changed = await repriceUnpriced(db, fakePricing());
    expect(changed).toBe(1);
    expect(count(db, 'SELECT COUNT(*) c FROM events WHERE cost_usd IS NULL')).toBe(0);
  });

  test('a session_total stand-in is dropped once per-step rows exist for that session', async () => {
    const db = openDb(':memory:');
    const total = { type: 'event' as const, event: makeEvent({ id: 'tot', agent: 'a', sessionId: 's9', kind: 'session_total' }) };
    await runIngest(db, [adapter('a', [total])], fakePricing(), { home: '/h' });
    expect(count(db, 'SELECT COUNT(*) c FROM events')).toBe(1);
    const step = { type: 'event' as const, event: makeEvent({ id: 'st', agent: 'a', sessionId: 's9' }) };
    await runIngest(db, [adapter('a', [total, step])], fakePricing(), { home: '/h' });
    expect(db.query('SELECT id FROM events').all()).toEqual([{ id: 'st' }]);
  });

  test('provider is passed to the pricing resolver', async () => {
    const db = openDb(':memory:');
    const seen: Array<string | undefined> = [];
    const pricing = fakePricing();
    const orig = pricing.resolveModel.bind(pricing);
    pricing.resolveModel = async (raw, hint) => { seen.push(hint?.provider); return orig(raw); };
    await runIngest(db, [adapter('a', [{ type: 'event', event: makeEvent({ id: 'p', agent: 'a', provider: 'ollama' }) }])], pricing, { home: '/h' });
    expect(seen).toEqual(['ollama']);
  });
});
