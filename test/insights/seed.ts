import type { Database } from 'bun:sqlite';
import { openDb } from '../../src/core/db';
import { runIngest } from '../../src/core/ingest';
import type { Rates } from '../../src/core/rates';
import type { Adapter, IngestItem, PricingService, ResolvedModel, UsageEvent } from '../../src/core/types';
import { makeEvent } from '../helpers';

export const HOUR = 3_600_000;
export const MIN = 60_000;
/** 2026-03-02 00:00:00 UTC, a Monday. */
export const T0 = Date.UTC(2026, 2, 2);

export const DEFAULT_RATES: Rates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 };

export function seedPrices(db: Database, models: Record<string, Rates>, fetchedAt = T0 - 30 * 24 * HOUR): void {
  db.query(
    `INSERT INTO price_snapshots (fetched_at, last_checked_at, content_hash, source_url, row_count)
     VALUES (?, ?, 'h', 'test', 0)`,
  ).run(fetchedAt, fetchedAt);
  const snap = (db.query('SELECT MAX(id) AS id FROM price_snapshots').get() as { id: number }).id;
  const ins = db.prepare(
    `INSERT INTO prices (snapshot_id, model, region, tier, kind, long_ctx, usd_per_mtok)
     VALUES (?, ?, 'us-east-1', 'regional', ?, 0, ?)`,
  );
  const kinds: Array<[string, keyof Rates]> = [
    ['input', 'input'], ['output', 'output'], ['cache_read', 'cacheRead'],
    ['cache_write_5m', 'cacheWrite5m'], ['cache_write_1h', 'cacheWrite1h'],
  ];
  for (const [model, r] of Object.entries(models)) for (const [kind, field] of kinds) ins.run(snap, model, kind, r[field]);
}

/** Prices events with the same rates that are written to the prices table. */
export function ratesPricing(rates: Record<string, Rates>, unpriced: readonly string[] = []): PricingService {
  const skip = new Set(unpriced);
  return {
    async refreshIfStale() { return { refreshed: false }; },
    async resolveModel(raw: string): Promise<ResolvedModel> {
      const canonical = raw.toLowerCase();
      return { canonical, priced: !skip.has(raw) && canonical in rates, tier: 'regional' };
    },
    priceEvent(model, i) {
      const r = rates[model.canonical];
      if (!model.priced || !r) return { costUsd: null, approx: false };
      const usd = (i.inputTokens * r.input + (i.outputTokens + i.reasoningTokens) * r.output +
        i.cacheReadTokens * r.cacheRead + i.cacheWrite5mTokens * r.cacheWrite5m + i.cacheWrite1hTokens * r.cacheWrite1h) / 1e6;
      return { costUsd: usd, approx: false };
    },
  };
}

export interface ChainSpec {
  agent?: string;
  sessionId: string;
  model?: string;
  start?: number;
  gapMs?: number;
  /** Prompt size (tokens) at every step. */
  contexts: readonly number[];
  /** true: prompt is served from cache (read prev, write the delta). false: all uncached input. */
  cached?: boolean;
  output?: number;
  isSubagent?: boolean;
  writeKind?: '5m' | '1h';
  tools?: ReadonlyArray<{ step: number; name: string; resultBytes?: number }>;
}

export function chain(spec: ChainSpec): UsageEvent[] {
  const agent = spec.agent ?? 'test';
  const start = spec.start ?? T0 + 9 * HOUR;
  const gap = spec.gapMs ?? 30_000;
  return spec.contexts.map((ctx, i) => {
    const prev = i === 0 ? 0 : (spec.contexts[i - 1] as number);
    const cached = spec.cached ?? false;
    const write = Math.max(0, ctx - Math.min(prev, ctx));
    return makeEvent({
      id: `${agent}:${spec.sessionId}:${spec.isSubagent ? 'sub:' : ''}${i}`,
      agent,
      sessionId: spec.sessionId,
      modelRaw: spec.model ?? 'claude-sonnet-5',
      ts: start + i * gap,
      inputTokens: cached ? 20 : ctx,
      outputTokens: spec.output ?? 100,
      cacheReadTokens: cached ? Math.min(prev, ctx) : 0,
      cacheWrite5mTokens: cached && spec.writeKind !== '1h' ? write : 0,
      cacheWrite1hTokens: cached && spec.writeKind === '1h' ? write : 0,
      isSubagent: spec.isSubagent ?? false,
      tools: (spec.tools ?? []).filter((t) => t.step === i).map((t, j) => ({
        callId: `${agent}:${spec.sessionId}:${i}:${j}`,
        name: t.name,
        ...(t.resultBytes !== undefined ? { resultBytes: t.resultBytes } : {}),
      })),
    });
  });
}

export async function seedDb(
  events: readonly UsageEvent[],
  opts: { rates?: Record<string, Rates>; titles?: Record<string, string>; unpriced?: readonly string[] } = {},
): Promise<Database> {
  const db = openDb(':memory:');
  const models = [...new Set(events.map((e) => e.modelRaw.toLowerCase()))];
  const rates = opts.rates ?? Object.fromEntries(models.map((m) => [m, DEFAULT_RATES]));
  seedPrices(db, rates);
  const items: IngestItem[] = events.map((event) => ({ type: 'event', event }));
  for (const [key, title] of Object.entries(opts.titles ?? {})) {
    const [agent, sessionId] = key.split('/') as [string, string];
    items.push({ type: 'session', meta: { agent, sessionId, title } });
  }
  const agents = [...new Set(events.map((e) => e.agent))];
  const adapters: Adapter[] = agents.map((id) => ({
    id, label: id,
    async detect() { return { installed: true, detail: `${id} data` }; },
    async *ingest() {
      for (const i of items) if (i.type !== 'event' || i.event.agent === id) yield i;
    },
  }));
  // each adapter yields only its own events; session/tool items are idempotent so duplicates are harmless
  await runIngest(db, adapters, ratesPricing(rates, opts.unpriced), { home: '/h' });
  return db;
}
