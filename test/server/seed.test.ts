import { describe, expect, test } from 'bun:test';
import { openDb } from '../../src/core/db';
import { seedDemo } from '../../src/dev/seed';

const NOW = Date.UTC(2026, 9, 9, 12);

function seeded() {
  const db = openDb(':memory:');
  const r = seedDemo(db, { now: NOW, days: 60, seed: 7 });
  return { db, r };
}
const one = <T>(db: ReturnType<typeof openDb>, sql: string): T => db.query(sql).get() as T;

describe('seedDemo', () => {
  test('is deterministic for a given seed', () => {
    const a = seeded();
    const b = seeded();
    expect(a.r).toEqual(b.r);
    const sum = (d: ReturnType<typeof openDb>) => one<{ s: number }>(d, 'SELECT SUM(input_tokens + cache_read_tokens) s FROM events').s;
    expect(sum(a.db)).toBe(sum(b.db));
  });

  test('covers 4 agents, a deliberately unpriced model, subagents and tools', () => {
    const { db } = seeded();
    expect(one<{ n: number }>(db, 'SELECT COUNT(DISTINCT agent) n FROM events').n).toBe(4);
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) n FROM events WHERE cost_usd IS NULL').n).toBeGreaterThan(0);
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) n FROM events WHERE is_subagent = 1').n).toBeGreaterThan(0);
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) n FROM tool_calls WHERE result_bytes > 100000').n).toBeGreaterThan(0);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM events WHERE kind = 'session_total'").n).toBe(4);
  });

  test('contains the no-cache pathological session (~9M uncached input tokens)', () => {
    const { db } = seeded();
    const s = one<{ i: number; r: number; w: number }>(db, "SELECT SUM(input_tokens) i, SUM(cache_read_tokens) r, SUM(cache_write_5m_tokens + cache_write_1h_tokens) w FROM events WHERE session_id = 'opencode-nocache'");
    expect(s.i).toBeGreaterThan(6_000_000);
    expect(s.r + s.w).toBe(0);
  });

  test('prices are snapshot based and a not-installed adapter keeps its history', () => {
    const { db } = seeded();
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) n FROM price_snapshots').n).toBe(2);
    expect(one<{ n: number }>(db, "SELECT installed n FROM adapter_runs WHERE adapter = 'cowork'").n).toBe(0);
    expect(one<{ n: number }>(db, "SELECT COUNT(*) n FROM events WHERE agent = 'cowork'").n).toBeGreaterThan(0);
    expect(one<{ n: number }>(db, 'SELECT COUNT(*) n FROM events WHERE cost_approx = 1').n).toBeGreaterThan(0);
  });
});
