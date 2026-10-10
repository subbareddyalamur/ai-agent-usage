import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { asString, isObject, readJsonSafe, stableId, toInt } from './kit';
import type { Json } from './kit';
import type { Adapter, DetectResult, IngestItem, ToolCall } from '../core/types';

const AGENT = 'opencode';
const dbPath = (home: string): string => join(home, '.local', 'share', 'opencode', 'opencode.db');

function openReadonly(path: string): Database {
  return new Database(path, { readonly: true });
}

function hasTable(db: Database, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

function parseJson(v: unknown): Json | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const p: unknown = JSON.parse(v);
    return isObject(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

/** opencode.json -> amazon-bedrock profile name, so ARNs can be resolved with the right credentials. */
function bedrockProfile(home: string): string | undefined {
  const cfg = readJsonSafe(join(home, '.config', 'opencode', 'opencode.json'));
  const provider = isObject(cfg) && isObject(cfg.provider) ? cfg.provider : undefined;
  const bedrock = provider && isObject(provider['amazon-bedrock']) ? provider['amazon-bedrock'] : undefined;
  const options = bedrock && isObject(bedrock.options) ? bedrock.options : undefined;
  return options ? asString(options.profile) : undefined;
}

interface ToolRow {
  mid: string;
  cid: string | null;
  name: string | null;
  st: string | null;
  bytes: number | null;
  err: number;
}

interface StepRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  tokens: string;
  model: string | null;
  tcreated: number | null;
  cost: number | null;
  parent_id: string | null;
  directory: string | null;
}

interface SessionRow {
  id: string;
  title: string | null;
  directory: string | null;
  parent_id: string | null;
  model: string | null;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  time_created: number;
  time_updated: number;
}

const TOTAL_TOKENS = '(tokens_input + tokens_output + tokens_reasoning + tokens_cache_read + tokens_cache_write) > 0';

function toolsByMessage(db: Database, wm: number): Map<string, ToolCall[]> {
  const rows = db
    .query(
      `SELECT m.id AS mid,
              json_extract(c.value, '$.id') AS cid,
              json_extract(c.value, '$.name') AS name,
              json_extract(c.value, '$.state.status') AS st,
              length(CAST(json_extract(c.value, '$.state.content') AS BLOB)) AS bytes,
              json_extract(c.value, '$.state.error') IS NOT NULL AS err
       FROM session_message m, json_each(m.data, '$.content') c
       WHERE m.type = 'assistant' AND m.time_updated >= ?
         AND json_extract(c.value, '$.type') = 'tool'`,
    )
    .all(wm) as ToolRow[];
  const out = new Map<string, ToolCall[]>();
  for (const r of rows) {
    if (!r.cid || !r.name) continue;
    const done = r.st === 'completed' || r.st === 'error';
    const call: ToolCall = {
      callId: r.cid,
      name: r.name,
      ...(done ? { resultBytes: toInt(r.bytes) } : {}),
      ...(r.err ? { isError: true } : {}),
    };
    const list = out.get(r.mid);
    if (list) list.push(call);
    else out.set(r.mid, [call]);
  }
  return out;
}

function* steps(db: Database, wm: number, hint: string | undefined): Generator<IngestItem> {
  const tools = toolsByMessage(db, wm);
  const stmt = db.query(
    `SELECT m.id, m.session_id, m.time_created, m.time_updated,
            json_extract(m.data, '$.tokens') AS tokens,
            json_extract(m.data, '$.model') AS model,
            json_extract(m.data, '$.time.created') AS tcreated,
            json_extract(m.data, '$.cost') AS cost,
            s.parent_id, s.directory
     FROM session_message m LEFT JOIN session_v2 s ON s.id = m.session_id
     WHERE m.type = 'assistant' AND m.time_updated >= ?
       AND json_extract(m.data, '$.tokens') IS NOT NULL
     ORDER BY m.time_updated, m.id`,
  );
  for (const r of stmt.iterate(wm) as Iterable<StepRow>) {
    const t = parseJson(r.tokens);
    if (!t) continue;
    const cache = isObject(t.cache) ? t.cache : {};
    const input = toInt(t.input);
    const output = toInt(t.output);
    const reasoning = toInt(t.reasoning);
    const read = toInt(cache.read);
    const write = toInt(cache.write);
    if (input + output + reasoning + read + write === 0) continue;

    const model = parseJson(r.model);
    const provider = asString(model?.providerID);
    yield {
      type: 'event',
      event: {
        id: stableId(AGENT, r.session_id, r.id),
        agent: AGENT,
        sessionId: r.session_id,
        ...(r.directory ? { project: r.directory } : {}),
        ts: r.tcreated ?? r.time_created,
        ...(provider ? { provider } : {}),
        modelRaw: asString(model?.id) ?? 'unknown',
        inputTokens: input,
        outputTokens: output,
        reasoningTokens: reasoning,
        cacheReadTokens: read,
        cacheWrite5mTokens: write,
        cacheWrite1hTokens: 0,
        isSubagent: r.parent_id !== null,
        kind: 'step',
        ...(typeof r.cost === 'number' && r.cost > 0 ? { reportedCostUsd: r.cost } : {}),
        ...(provider === 'amazon-bedrock' && hint ? { awsProfileHint: hint } : {}),
        tools: tools.get(r.id) ?? [],
      },
    };
  }
}

function totalEvent(id: string, r: SessionRow, hint: string | undefined): IngestItem {
  const model = parseJson(r.model);
  const provider = asString(model?.providerID);
  return {
    type: 'event',
    event: {
      id,
      agent: AGENT,
      sessionId: r.id,
      ...(r.directory ? { project: r.directory } : {}),
      ts: r.time_created,
      ...(provider ? { provider } : {}),
      modelRaw: asString(model?.id) ?? 'unknown',
      inputTokens: toInt(r.tokens_input),
      outputTokens: toInt(r.tokens_output),
      reasoningTokens: toInt(r.tokens_reasoning),
      cacheReadTokens: toInt(r.tokens_cache_read),
      cacheWrite5mTokens: toInt(r.tokens_cache_write),
      cacheWrite1hTokens: 0,
      isSubagent: r.parent_id !== null,
      kind: 'session_total',
      ...(provider === 'amazon-bedrock' && hint ? { awsProfileHint: hint } : {}),
      tools: [],
    },
  };
}

function* sessionLevel(db: Database, wm: number, hint: string | undefined): Generator<IngestItem> {
  const cols = `id, title, directory, parent_id, model, tokens_input, tokens_output, tokens_reasoning,
                tokens_cache_read, tokens_cache_write, time_created, time_updated`;

  // Titles / project for every session touched since the watermark.
  for (const r of db.query(`SELECT ${cols} FROM session_v2 WHERE time_updated >= ?`).all(wm) as SessionRow[]) {
    yield {
      type: 'session',
      meta: {
        agent: AGENT,
        sessionId: r.id,
        ...(r.title ? { title: r.title } : {}),
        ...(r.directory ? { project: r.directory } : {}),
      },
    };
  }

  // Sessions that have token totals but no per-step data at all.
  const noSteps = db
    .query(
      `SELECT ${cols} FROM session_v2 v
       WHERE ${TOTAL_TOKENS} AND v.time_updated >= ?
         AND NOT EXISTS (
           SELECT 1 FROM session_message m
           WHERE m.session_id = v.id AND m.type = 'assistant'
             AND json_extract(m.data, '$.tokens') IS NOT NULL)`,
    )
    .all(wm) as SessionRow[];
  for (const r of noSteps) yield totalEvent(stableId(AGENT, 'total', r.id), r, hint);

  // Pre-v2 sessions that were never migrated into session_v2.
  if (hasTable(db, 'session')) {
    const legacy = db
      .query(
        `SELECT ${cols} FROM session s
         WHERE ${TOTAL_TOKENS} AND s.time_updated >= ?
           AND s.id NOT IN (SELECT id FROM session_v2)`,
      )
      .all(wm) as SessionRow[];
    for (const r of legacy) yield totalEvent(stableId(AGENT, 'legacy', r.id), r, hint);
  }
}

const adapter: Adapter = {
  id: AGENT,
  label: 'opencode',

  async detect({ home }): Promise<DetectResult> {
    const path = dbPath(home);
    if (!existsSync(path)) return { installed: false, detail: `no database at ${path}` };
    try {
      const db = openReadonly(path);
      try {
        const ok = hasTable(db, 'session_v2') && hasTable(db, 'session_message');
        return ok
          ? { installed: true, detail: path }
          : { installed: false, detail: 'database has no session_v2/session_message tables' };
      } finally {
        db.close();
      }
    } catch (error: unknown) {
      return { installed: false, detail: error instanceof Error ? error.message : 'unreadable database' };
    }
  },

  async *ingest(ctx) {
    const db = openReadonly(dbPath(ctx.home));
    try {
      const hint = bedrockProfile(ctx.home);
      const stepWm = ctx.state.get<number>('steps_wm') ?? 0;
      const sessWm = ctx.state.get<number>('sessions_wm') ?? 0;

      // Capture the high-water marks BEFORE reading, so rows written while we read are picked up next run.
      const maxStep = db
        .query("SELECT MAX(time_updated) AS t FROM session_message WHERE type = 'assistant'")
        .get() as { t: number | null };
      const maxSess = db.query('SELECT MAX(time_updated) AS t FROM session_v2').get() as { t: number | null };

      yield* steps(db, stepWm, hint);
      yield* sessionLevel(db, sessWm, hint);

      if (maxStep.t !== null) ctx.state.set('steps_wm', maxStep.t);
      if (maxSess.t !== null) ctx.state.set('sessions_wm', maxSess.t);
    } finally {
      db.close();
    }
  },
};

export default adapter;
