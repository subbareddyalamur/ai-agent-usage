import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter, AdapterState, IngestItem, UsageEvent } from '../../src/core/types';

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'au-home-'));
}

/** State that persists immediately (what the runner does after a successful run). */
export function memoryState(): AdapterState & { dump(): Record<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    get: <T = unknown>(k: string) => m.get(k) as T | undefined,
    set: (k, v) => void m.set(k, JSON.parse(JSON.stringify(v))),
    dump: () => Object.fromEntries(m),
  };
}

export async function collect(adapter: Adapter, home: string, state: AdapterState = memoryState()): Promise<IngestItem[]> {
  const out: IngestItem[] = [];
  for await (const item of adapter.ingest({ state, home, log: () => {} })) out.push(item);
  return out;
}

export const eventsOf = (items: readonly IngestItem[]): UsageEvent[] =>
  items.flatMap((i) => (i.type === 'event' ? [i.event] : []));

export function adapterContract(adapter: Adapter, buildHome: () => string): void {
  describe(`${adapter.id} adapter contract`, () => {
    test('detect() is false (and never throws) on an empty HOME', async () => {
      const r = await adapter.detect({ home: tempHome() });
      expect(r.installed).toBe(false);
    });

    test('detect() is false for a HOME that does not exist', async () => {
      const r = await adapter.detect({ home: join(tmpdir(), 'au-does-not-exist-xyz') });
      expect(r.installed).toBe(false);
    });

    test('detect() is true for the fixture HOME', async () => {
      expect((await adapter.detect({ home: buildHome() })).installed).toBe(true);
    });

    test('ingest yields well-formed events with deterministic ids', async () => {
      const home = buildHome();
      const a = eventsOf(await collect(adapter, home));
      const b = eventsOf(await collect(adapter, home));
      expect(a.length).toBeGreaterThan(0);
      expect(a.map((e) => e.id).sort()).toEqual(b.map((e) => e.id).sort());
      expect(new Set(a.map((e) => e.id)).size).toBe(a.length);
      for (const e of a) {
        expect(e.agent).toBe(adapter.id);
        expect(e.id.length).toBeGreaterThan(0);
        expect(e.sessionId.length).toBeGreaterThan(0);
        expect(e.modelRaw.length).toBeGreaterThan(0);
        expect(e.ts).toBeGreaterThan(0);
        for (const n of [
          e.inputTokens, e.outputTokens, e.reasoningTokens, e.cacheReadTokens,
          e.cacheWrite5mTokens, e.cacheWrite1hTokens,
        ]) {
          expect(Number.isInteger(n)).toBe(true);
          expect(n).toBeGreaterThanOrEqual(0);
        }
        for (const t of e.tools) {
          expect(t.name.length).toBeGreaterThan(0);
          if (t.resultBytes !== undefined) expect(t.resultBytes).toBeGreaterThanOrEqual(0);
        }
      }
    });

    test('a second run with saved state only repeats known ids (idempotent)', async () => {
      const home = buildHome();
      const state = memoryState();
      const first = new Set(eventsOf(await collect(adapter, home, state)).map((e) => e.id));
      const second = eventsOf(await collect(adapter, home, state));
      for (const e of second) expect(first.has(e.id)).toBe(true);
    });
  });
}
