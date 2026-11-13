// Cursor composer bubbles in state.vscdb. Per-message tokenCount when it is non-zero.
// Current chats leave tokenCount at 0 and only store contextTokensUsed, the live context
// window. For those chats that window is the usage event, so the session shows up.
import { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { asString, isObject, parseTs, providerForModel, stableId, toInt } from './kit';
import type { Adapter, DetectResult, IngestItem, ToolCall } from '../core/types';

const AGENT = 'cursor';

function dbPath(home: string): string | undefined {
  const candidates = [
    join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
  ];
  return candidates.find((p) => existsSync(p));
}

interface Composer {
  model: string;
  title?: string;
  project?: string;
  isSubagent: boolean;
  /** Session start, from the header or composer document. */
  ts?: number;
  /** Last time the composer was written. Used when a bubble has no timestamp of its own. */
  updated?: number;
  /** Live context window. Used only when no bubble recorded a token count. */
  contextTokens: number;
}

function modelFrom(name: unknown, selected: unknown): string | undefined {
  const raw = asString(name);
  const parsed: unknown = typeof selected === 'string'
    ? (() => { try { return JSON.parse(selected) as unknown; } catch { return undefined; } })()
    : selected;
  const picked = Array.isArray(parsed)
    ? parsed.map((item) => (isObject(item) ? asString(item.modelId) : undefined)).find((id): id is string => !!id)
    : undefined;
  if (raw && raw !== 'default' && raw !== 'auto') return raw;
  return picked ?? raw;
}

function projectFrom(repos: unknown): string | undefined {
  let parsed: unknown = repos;
  if (typeof repos === 'string') {
    try { parsed = JSON.parse(repos) as unknown; } catch { return undefined; }
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const item of parsed) {
    if (isObject(item)) {
      const path = asString(item.repoPath);
      if (path) return path;
    }
  }
  return undefined;
}

function loadComposers(db: Database): Map<string, Composer> {
  const out = new Map<string, Composer>();
  try {
    const headers = db.query(
      `SELECT composerId, createdAt, isSubagent, json_extract(value, '$.trackedGitRepos') AS repos,
              json_extract(value, '$.name') AS headerName
       FROM composerHeaders`,
    ).all() as { composerId: string; createdAt: number | null; isSubagent: number | null; repos: string | null; headerName: string | null }[];
    for (const row of headers) {
      const title = asString(row.headerName);
      const project = projectFrom(row.repos);
      const ts = parseTs(row.createdAt);
      out.set(row.composerId, {
        model: 'unknown',
        contextTokens: 0,
        ...(title ? { title } : {}),
        ...(project ? { project } : {}),
        isSubagent: row.isSubagent === 1,
        ...(ts !== undefined ? { ts } : {}),
      });
    }
  } catch {
    // older databases have no composerHeaders table
  }

  try {
    const rows = db.query(
      `SELECT substr(key, 14) AS id,
              json_extract(value, '$.name') AS name,
              json_extract(value, '$.createdAt') AS createdAt,
              json_extract(value, '$.lastUpdatedAt') AS updatedAt,
              json_extract(value, '$.modelConfig.modelName') AS model,
              json_extract(value, '$.modelConfig.selectedModels') AS selected,
              CAST(json_extract(value, '$.contextTokensUsed') AS INTEGER) AS contextTokens
       FROM cursorDiskKV WHERE key LIKE 'composerData:%'`,
    ).all() as { id: string; name: string | null; createdAt: number | null; updatedAt: number | null; model: string | null; selected: string | null; contextTokens: number | null }[];
    for (const row of rows) {
      const prev = out.get(row.id) ?? { model: 'unknown', isSubagent: false, contextTokens: 0 };
      const model = modelFrom(row.model, row.selected) ?? prev.model;
      const title = asString(row.name) ?? prev.title;
      const ts = prev.ts ?? parseTs(row.createdAt);
      const updated = parseTs(row.updatedAt) ?? prev.updated;
      const contextTokens = Math.max(toInt(row.contextTokens), prev.contextTokens);
      out.set(row.id, {
        ...prev,
        contextTokens,
        model,
        ...(title ? { title } : {}),
        ...(ts !== undefined ? { ts } : {}),
        ...(updated !== undefined ? { updated } : {}),
      });
    }
  } catch {
    // bubbles can still be read without composer metadata
  }
  return out;
}

interface BubbleRow {
  key: string;
  bubbleId: string | null;
  createdAt: number | string | null;
  input: number | null;
  output: number | null;
  toolName: string | null;
  tool: string | null;
  callId: string | null;
  resultBytes: number | null;
}

function dbStamp(path: string): { size: number; mtimeMs: number } {
  const st = statSync(path);
  let size = st.size;
  let mtimeMs = st.mtimeMs;
  try {
    const wal = statSync(`${path}-wal`);
    size += wal.size;
    if (wal.mtimeMs > mtimeMs) mtimeMs = wal.mtimeMs;
  } catch {
    // no write-ahead log
  }
  return { size, mtimeMs };
}

function composerIdFromKey(key: string): { composerId: string; bubbleId: string } | undefined {
  const rest = key.startsWith('bubbleId:') ? key.slice('bubbleId:'.length) : '';
  const sep = rest.indexOf(':');
  if (sep <= 0) return undefined;
  return { composerId: rest.slice(0, sep), bubbleId: rest.slice(sep + 1) };
}

const adapter: Adapter = {
  id: AGENT,
  label: 'Cursor',

  async detect({ home }): Promise<DetectResult> {
    try {
      const path = dbPath(home);
      return path ? { installed: true, detail: path } : { installed: false, detail: 'no Cursor state database' };
    } catch {
      return { installed: false, detail: 'detect failed' };
    }
  },

  async *ingest(ctx): AsyncGenerator<IngestItem> {
    const path = dbPath(ctx.home);
    if (!path) return;
    let size = 0;
    let mtimeMs = 0;
    try {
      const stamp = dbStamp(path);
      size = stamp.size;
      mtimeMs = stamp.mtimeMs;
    } catch (error: unknown) {
      ctx.log(`skip cursor db: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const prev = ctx.state.get<{ size?: number; mtimeMs?: number; v?: number }>('db');
    if (prev?.v === 2 && prev.size === size && prev.mtimeMs === mtimeMs) return;

    let db: Database;
    try {
      db = new Database(path, { readonly: true });
    } catch (error: unknown) {
      ctx.log(`skip cursor db: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    try {
      const composers = loadComposers(db);
      const bubbles = db.query(
        `SELECT key,
                json_extract(value, '$.bubbleId') AS bubbleId,
                json_extract(value, '$.createdAt') AS createdAt,
                CAST(json_extract(value, '$.tokenCount.inputTokens') AS INTEGER) AS input,
                CAST(json_extract(value, '$.tokenCount.outputTokens') AS INTEGER) AS output,
                json_extract(value, '$.toolFormerData.name') AS toolName,
                json_extract(value, '$.toolFormerData.tool') AS tool,
                json_extract(value, '$.toolFormerData.toolCallId') AS callId,
                length(json_extract(value, '$.toolFormerData.result')) AS resultBytes
         FROM cursorDiskKV
         WHERE key LIKE 'bubbleId:%' AND json_extract(value, '$.tokenCount') IS NOT NULL`,
      ).all() as BubbleRow[];

      const sessions = new Set<string>();
      for (const row of bubbles) {
        const ids = composerIdFromKey(row.key);
        if (!ids) continue;
        const input = toInt(row.input);
        const output = toInt(row.output);
        if (input + output === 0) continue;
        const composer = composers.get(ids.composerId);
        const model = composer?.model && composer.model.length > 0 ? composer.model : 'unknown';
        const bubbleId = asString(row.bubbleId) ?? ids.bubbleId;
        const ts = parseTs(row.createdAt) ?? composer?.updated ?? composer?.ts;
        if (ts === undefined) continue;
        const toolName = asString(row.toolName) ?? asString(row.tool);
        const tools: ToolCall[] = [];
        if (toolName) {
          const bytes = toInt(row.resultBytes);
          tools.push({
            callId: asString(row.callId) ?? stableId(ids.composerId, bubbleId, 'tool'),
            name: toolName,
            ...(bytes > 0 ? { resultBytes: bytes } : {}),
          });
        }
        const provider = providerForModel(model);
        sessions.add(ids.composerId);
        yield {
          type: 'event',
          event: {
            id: stableId(AGENT, ids.composerId, bubbleId),
            agent: AGENT,
            sessionId: ids.composerId,
            ...(composer?.project ? { project: composer.project } : {}),
            ts,
            ...(provider ? { provider } : {}),
            modelRaw: model,
            inputTokens: input,
            outputTokens: output,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
            isSubagent: composer?.isSubagent ?? false,
            kind: 'step',
            tools,
          },
        };
      }
      for (const [sessionId, composer] of composers) {
        if (sessions.has(sessionId) || composer.contextTokens <= 0) continue;
        const ts = composer.updated ?? composer.ts;
        if (ts === undefined) continue;
        const provider = providerForModel(composer.model);
        sessions.add(sessionId);
        yield {
          type: 'event',
          event: {
            id: stableId(AGENT, sessionId, 'context'),
            agent: AGENT,
            sessionId,
            ...(composer.project ? { project: composer.project } : {}),
            ts,
            ...(provider ? { provider } : {}),
            modelRaw: composer.model,
            inputTokens: composer.contextTokens,
            outputTokens: 0,
            reasoningTokens: 0,
            cacheReadTokens: 0,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
            isSubagent: composer.isSubagent,
            kind: 'step',
            tools: [],
          },
        };
      }
      for (const sessionId of sessions) {
        const composer = composers.get(sessionId);
        yield {
          type: 'session',
          meta: {
            agent: AGENT,
            sessionId,
            ...(composer?.title ? { title: composer.title } : {}),
            ...(composer?.project ? { project: composer.project } : {}),
          },
        };
      }
      ctx.state.set('db', { v: 2, size, mtimeMs });
    } catch (error: unknown) {
      ctx.log(`skip cursor db: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      db.close();
    }
  },
};

export default adapter;
