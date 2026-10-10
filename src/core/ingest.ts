import type { Database } from 'bun:sqlite';
import type {
  Adapter,
  AdapterState,
  IngestItem,
  PricingService,
  ResolvedModel,
  UsageEvent,
} from './types';

const BATCH_SIZE = 1000;

export interface IngestOptions {
  home: string;
  log?: (msg: string) => void;
  now?: () => number;
}

export interface AdapterReport {
  id: string;
  installed: boolean;
  events: number;
  error?: string;
}

class BufferedState implements AdapterState {
  private readonly loaded = new Map<string, unknown>();
  private readonly pending = new Map<string, unknown>();

  constructor(db: Database, private readonly adapter: string) {
    const rows = db
      .query('SELECT key, value FROM adapter_state WHERE adapter = ?')
      .all(adapter) as Array<{ key: string; value: string }>;
    for (const r of rows) this.loaded.set(r.key, JSON.parse(r.value));
  }

  get<T = unknown>(key: string): T | undefined {
    return (this.pending.has(key) ? this.pending.get(key) : this.loaded.get(key)) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.pending.set(key, value);
  }

  commit(db: Database): void {
    const stmt = db.prepare(
      `INSERT INTO adapter_state (adapter, key, value) VALUES (?, ?, ?)
       ON CONFLICT(adapter, key) DO UPDATE SET value = excluded.value`,
    );
    db.transaction(() => {
      for (const [k, v] of this.pending) stmt.run(this.adapter, k, JSON.stringify(v));
    })();
  }
}

function modelKey(e: UsageEvent): string {
  return `${e.awsProfileHint ?? ''}\u0000${e.provider ?? ''}\u0000${e.modelRaw}`;
}

async function resolveAll(
  events: readonly UsageEvent[],
  pricing: PricingService,
  memo: Map<string, ResolvedModel>,
): Promise<void> {
  for (const e of events) {
    const k = modelKey(e);
    if (memo.has(k)) continue;
    memo.set(k, await pricing.resolveModel(e.modelRaw, { awsProfile: e.awsProfileHint, provider: e.provider }));
  }
}

function writeBatch(
  db: Database,
  items: readonly IngestItem[],
  pricing: PricingService,
  memo: Map<string, ResolvedModel>,
  now: number,
): number {
  const upsertEvent = db.prepare(`
    INSERT INTO events (
      id, agent, session_id, project, ts, provider, model_raw, model, priced, tier,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
      cache_write_5m_tokens, cache_write_1h_tokens, is_subagent, kind,
      reported_cost_usd, aws_profile_hint, cost_usd, cost_approx, ingested_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      project = excluded.project, ts = excluded.ts, provider = excluded.provider,
      model_raw = excluded.model_raw, model = excluded.model, priced = excluded.priced,
      tier = excluded.tier, input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens, reasoning_tokens = excluded.reasoning_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_write_5m_tokens = excluded.cache_write_5m_tokens,
      cache_write_1h_tokens = excluded.cache_write_1h_tokens,
      is_subagent = excluded.is_subagent, kind = excluded.kind,
      reported_cost_usd = excluded.reported_cost_usd,
      aws_profile_hint = excluded.aws_profile_hint,
      cost_usd = excluded.cost_usd, cost_approx = excluded.cost_approx,
      ingested_at = excluded.ingested_at`);
  const upsertTool = db.prepare(`
    INSERT INTO tool_calls (agent, call_id, event_id, name, result_bytes, is_error)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, call_id) DO UPDATE SET
      event_id = COALESCE(excluded.event_id, event_id),
      name = CASE WHEN excluded.name = '' THEN name ELSE excluded.name END,
      result_bytes = COALESCE(excluded.result_bytes, result_bytes),
      is_error = MAX(is_error, excluded.is_error)`);
  const upsertSession = db.prepare(`
    INSERT INTO sessions (agent, session_id, title, project) VALUES (?, ?, ?, ?)
    ON CONFLICT(agent, session_id) DO UPDATE SET
      title = COALESCE(excluded.title, title),
      project = COALESCE(excluded.project, project)`);

  let events = 0;
  db.transaction(() => {
    for (const item of items) {
      if (item.type === 'event') {
        const e = item.event;
        const resolved = memo.get(modelKey(e)) as ResolvedModel;
        const { costUsd, approx } = pricing.priceEvent(resolved, e);
        upsertEvent.run(
          e.id, e.agent, e.sessionId, e.project ?? null, e.ts, e.provider ?? null,
          e.modelRaw, resolved.canonical, resolved.priced ? 1 : 0, resolved.tier,
          e.inputTokens, e.outputTokens, e.reasoningTokens, e.cacheReadTokens,
          e.cacheWrite5mTokens, e.cacheWrite1hTokens, e.isSubagent ? 1 : 0, e.kind,
          e.reportedCostUsd ?? null, e.awsProfileHint ?? null, costUsd, approx ? 1 : 0, now,
        );
        for (const t of e.tools) {
          upsertTool.run(e.agent, t.callId, e.id, t.name, t.resultBytes ?? null, t.isError ? 1 : 0);
        }
        events++;
      } else if (item.type === 'toolResult') {
        upsertTool.run(item.agent, item.result.callId, null, '', item.result.resultBytes, item.result.isError ? 1 : 0);
      } else {
        upsertSession.run(item.meta.agent, item.meta.sessionId, item.meta.title ?? null, item.meta.project ?? null);
      }
    }
  })();
  return events;
}

function recordRun(
  db: Database,
  a: Adapter,
  installed: boolean,
  detail: string | undefined,
  error: string | undefined,
  now: number,
  ingested: boolean,
): void {
  db.query(
    `INSERT INTO adapter_runs (adapter, label, installed, detail, error, last_ingest_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(adapter) DO UPDATE SET
       label = excluded.label, installed = excluded.installed, detail = excluded.detail,
       error = excluded.error,
       last_ingest_at = CASE WHEN ?7 THEN excluded.last_ingest_at ELSE last_ingest_at END`,
  ).run(a.id, a.label, installed ? 1 : 0, detail ?? null, error ?? null, ingested ? now : null, ingested ? 1 : 0);
}

/**
 * Runs every adapter. Idempotent: a second run over unchanged data rewrites identical rows.
 * Not-installed adapters are recorded and skipped; their history stays.
 * A failing adapter never affects the others and its incremental state is not advanced.
 */
export async function runIngest(
  db: Database,
  adapters: readonly Adapter[],
  pricing: PricingService,
  opts: IngestOptions,
): Promise<AdapterReport[]> {
  const log = opts.log ?? (() => {});
  const now = (opts.now ?? Date.now)();
  const memo = new Map<string, ResolvedModel>();
  const reports: AdapterReport[] = [];

  for (const adapter of adapters) {
    let detected: Awaited<ReturnType<Adapter['detect']>>;
    try {
      detected = await adapter.detect({ home: opts.home });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      recordRun(db, adapter, false, undefined, `detect failed: ${msg}`, now, false);
      reports.push({ id: adapter.id, installed: false, events: 0, error: msg });
      continue;
    }
    if (!detected.installed) {
      recordRun(db, adapter, false, detected.detail, undefined, now, false);
      reports.push({ id: adapter.id, installed: false, events: 0 });
      continue;
    }

    const state = new BufferedState(db, adapter.id);
    let count = 0;
    let batch: IngestItem[] = [];
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      await resolveAll(
        batch.flatMap((i) => (i.type === 'event' ? [i.event] : [])),
        pricing,
        memo,
      );
      count += writeBatch(db, batch, pricing, memo, now);
      batch = [];
    };

    try {
      for await (const item of adapter.ingest({ state, home: opts.home, log: (m) => log(`[${adapter.id}] ${m}`) })) {
        batch.push(item);
        if (batch.length >= BATCH_SIZE) await flush();
      }
      await flush();
      state.commit(db);
      recordRun(db, adapter, true, detected.detail, undefined, now, true);
      reports.push({ id: adapter.id, installed: true, events: count });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      try {
        await flush();
      } catch {
        // partial batch is dropped; the next run re-reads it because state was not advanced
      }
      recordRun(db, adapter, true, detected.detail, msg, now, true);
      reports.push({ id: adapter.id, installed: true, events: count, error: msg });
    }
  }
  dropSupersededSessionTotals(db);
  return reports;
}

/** A session_total row is only a stand-in: once real per-step rows exist for the session it would double count. */
export function dropSupersededSessionTotals(db: Database): number {
  return db
    .query(
      `DELETE FROM events WHERE kind = 'session_total' AND EXISTS (
         SELECT 1 FROM events e2 WHERE e2.agent = events.agent AND e2.session_id = events.session_id AND e2.kind = 'step')`,
    )
    .run().changes;
}

/**
 * Re-resolves and re-prices events that are currently unpriced, e.g. after a price
 * refresh added a model or an ARN became resolvable. Priced events are never touched,
 * so history keeps the price that was in effect when it happened.
 */
export async function repriceUnpriced(db: Database, pricing: PricingService): Promise<number> {
  const rows = db
    .query(
      `SELECT id, model_raw, provider, aws_profile_hint, ts, input_tokens, output_tokens, reasoning_tokens,
              cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens
       FROM events WHERE cost_usd IS NULL`,
    )
    .all() as Array<{
    id: string; model_raw: string; provider: string | null; aws_profile_hint: string | null; ts: number;
    input_tokens: number; output_tokens: number; reasoning_tokens: number;
    cache_read_tokens: number; cache_write_5m_tokens: number; cache_write_1h_tokens: number;
  }>;
  if (rows.length === 0) return 0;

  const memo = new Map<string, ResolvedModel>();
  const update = db.prepare(
    `UPDATE events SET model = ?, priced = ?, tier = ?, cost_usd = ?, cost_approx = ? WHERE id = ?`,
  );
  let changed = 0;
  for (const r of rows) {
    const k = `${r.aws_profile_hint ?? ''}\u0000${r.provider ?? ''}\u0000${r.model_raw}`;
    if (!memo.has(k)) memo.set(k, await pricing.resolveModel(r.model_raw, { awsProfile: r.aws_profile_hint ?? undefined, provider: r.provider ?? undefined }));
  }
  db.transaction(() => {
    for (const r of rows) {
      const resolved = memo.get(`${r.aws_profile_hint ?? ''}\u0000${r.provider ?? ''}\u0000${r.model_raw}`) as ResolvedModel;
      const { costUsd, approx } = pricing.priceEvent(resolved, {
        ts: r.ts, inputTokens: r.input_tokens, outputTokens: r.output_tokens,
        reasoningTokens: r.reasoning_tokens, cacheReadTokens: r.cache_read_tokens,
        cacheWrite5mTokens: r.cache_write_5m_tokens, cacheWrite1hTokens: r.cache_write_1h_tokens,
      });
      update.run(resolved.canonical, resolved.priced ? 1 : 0, resolved.tier, costUsd, approx ? 1 : 0, r.id);
      if (costUsd !== null) changed++;
    }
  })();
  return changed;
}
