// Shared reader for Antigravity, Antigravity CLI, and Antigravity IDE.
// Token counts come from brain transcripts. The model id is read from conversation
// SQLite blobs only when the blob itself labels it. Prompts are never stored.
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  asString, contentBytes, getCursor, hasFile, isObject, listFiles, parseTs, providerForModel, readNewJsonl, relKey, stableId, toInt,
} from '../kit';
import type { Json } from '../kit';
import type { Adapter, DetectResult, IngestContext, IngestItem, ToolCall } from '../../core/types';

// Lowercase public-style ids only. Mixed-case protobuf hashes (o1-j92p-…) are not model names.
const MODEL_RE = /(?:gemini|claude|gpt|grok)-[a-z0-9][a-z0-9.-]{0,78}/g;

export interface AntigravityOptions {
  id: string;
  label: string;
  root: (home: string) => string;
}

interface Generation {
  idx: number;
  lastStep: number;
  model: string;
}

interface SessionInfo {
  title?: string;
  project?: string;
  isSubagent: boolean;
}

function isTranscript(path: string): boolean {
  const parts = path.split(sep);
  return parts.at(-1) === 'transcript.jsonl' && parts.at(-2) === 'logs' && parts.at(-3) === '.system_generated';
}

function conversationId(path: string): string {
  const parts = path.split(sep);
  return parts.at(-4) ?? 'unknown';
}

function fileUriToPath(uri: string): string | undefined {
  if (uri.startsWith('/')) return uri;
  if (!uri.startsWith('file://')) return undefined;
  try {
    return decodeURIComponent(new URL(uri).pathname);
  } catch {
    return undefined;
  }
}

/** First labelled model id and last_step_index in a gen_metadata blob. Unlabelled numbers are ignored. */
export function generationFromBlob(data: Uint8Array, idx: number): Generation | undefined {
  const buf = Buffer.from(data);
  const latin = buf.toString('latin1');
  const model = latin.match(MODEL_RE)?.[0];
  if (!model) return undefined;
  let lastStep = Number.MAX_SAFE_INTEGER;
  const at = latin.indexOf('last_step_index');
  if (at >= 0) {
    const rest = buf.subarray(at + 'last_step_index'.length, at + 'last_step_index'.length + 12);
    for (let i = 0; i < rest.length - 2; i++) {
      if (rest[i] !== 0x12) continue;
      const len = rest[i + 1] ?? 0;
      if (len < 1 || len > 8 || i + 2 + len > rest.length) break;
      const text = rest.subarray(i + 2, i + 2 + len).toString('ascii');
      if (/^\d+$/.test(text)) lastStep = Number(text);
      break;
    }
  }
  return { idx, lastStep, model };
}

function modelForStep(gens: readonly Generation[], step: number): string | undefined {
  const sorted = [...gens].sort((a, b) => a.lastStep - b.lastStep || a.idx - b.idx);
  return sorted.find((g) => g.lastStep >= step)?.model ?? sorted.at(-1)?.model;
}

function openReadonly(path: string): Database {
  const uri = `file:${path.split('/').map((part, i) => (i === 0 ? part : encodeURIComponent(part))).join('/')}?mode=ro&immutable=1`;
  let db: Database | undefined;
  try {
    db = new Database(path, { readonly: true });
    db.query('SELECT 1').get();
    return db;
  } catch {
    try {
      db?.close();
    } catch {
      // the handle never became usable
    }
    return new Database(uri, { readonly: true });
  }
}

function loadModels(root: string, log: (msg: string) => void): Map<string, Generation[]> {
  const out = new Map<string, Generation[]>();
  for (const file of listFiles(join(root, 'conversations'), (p) => p.endsWith('.db'))) {
    const id = file.slice(file.lastIndexOf(sep) + 1, -'.db'.length);
    try {
      const db = openReadonly(file);
      try {
        const rows = db.query('SELECT idx, data FROM gen_metadata').all() as { idx: number; data: Uint8Array | null }[];
        const gens: Generation[] = [];
        for (const row of rows) {
          if (!row.data) continue;
          const gen = generationFromBlob(row.data, row.idx);
          if (gen) gens.push(gen);
        }
        if (gens.length > 0) out.set(id, gens);
      } finally {
        db.close();
      }
    } catch (error: unknown) {
      log(`skip model db ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out;
}

function parseJson(text: string | null): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function loadSummaries(root: string): Map<string, SessionInfo> {
  const out = new Map<string, SessionInfo>();
  const path = join(root, 'conversation_summaries.db');
  if (!existsSync(path)) return out;
  try {
    const db = openReadonly(path);
    try {
      const rows = db.query(
        `SELECT conversation_id, title, workspace_uris, parent_conversation_id, nesting_depth FROM conversation_summaries`,
      ).all() as {
        conversation_id: string;
        title: string | null;
        workspace_uris: string | null;
        parent_conversation_id: string | null;
        nesting_depth: number | null;
      }[];
      for (const row of rows) {
        const uris = parseJson(row.workspace_uris);
        const project = Array.isArray(uris)
          ? uris.map((u) => (typeof u === 'string' ? fileUriToPath(u) : undefined)).find((p): p is string => !!p)
          : undefined;
        const title = asString(row.title?.trim());
        out.set(row.conversation_id, {
          ...(title ? { title } : {}),
          ...(project ? { project } : {}),
          isSubagent: (row.nesting_depth ?? 0) > 0 || (row.parent_conversation_id ?? '').length > 0,
        });
      }
    } finally {
      db.close();
    }
  } catch {
    // summaries are optional
  }
  return out;
}

function toolsFrom(step: Json, sessionId: string, stepIndex: number): ToolCall[] {
  if (!Array.isArray(step.tool_calls)) return [];
  const tools: ToolCall[] = [];
  step.tool_calls.forEach((call, i) => {
    if (!isObject(call)) return;
    const name = asString(call.name);
    if (!name) return;
    const callId = asString(call.id) ?? stableId(sessionId, stepIndex, i);
    const output = call.output ?? call.result;
    tools.push({
      callId,
      name,
      ...(output !== undefined ? { resultBytes: contentBytes(output) } : {}),
    });
  });
  return tools;
}

function eventFrom(agent: string, sessionId: string, step: Json, model: string, info: SessionInfo | undefined): IngestItem | undefined {
  const hasTokens = 'input_tokens' in step || 'output_tokens' in step || 'cache_read_tokens' in step;
  if (!hasTokens) return undefined;
  const input = toInt(step.input_tokens);
  const output = toInt(step.output_tokens);
  const cacheRead = toInt(step.cache_read_tokens);
  if (input + output + cacheRead === 0) return undefined;
  const stepIndex = typeof step.step_index === 'number' ? step.step_index : toInt(step.step_index);
  const ts = parseTs(step.created_at);
  if (ts === undefined) return undefined;
  const provider = providerForModel(model);
  return {
    type: 'event',
    event: {
      id: stableId(agent, sessionId, stepIndex),
      agent,
      sessionId,
      ...(info?.project ? { project: info.project } : {}),
      ts,
      ...(provider ? { provider } : {}),
      modelRaw: model,
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: toInt(step.thinking_tokens),
      cacheReadTokens: cacheRead,
      cacheWrite5mTokens: toInt(step.cache_write_tokens),
      cacheWrite1hTokens: 0,
      isSubagent: info?.isSubagent ?? false,
      kind: 'step',
      tools: toolsFrom(step, sessionId, stepIndex),
    },
  };
}

function* historySessions(agent: string, records: readonly Json[]): Generator<IngestItem> {
  for (const rec of records) {
    const sessionId = asString(rec.conversationId);
    if (!sessionId) continue;
    const title = asString(rec.display);
    const workspace = asString(rec.workspace);
    const project = workspace && (workspace.startsWith('/') || workspace.startsWith('file://')) ? fileUriToPath(workspace) : undefined;
    yield {
      type: 'session',
      meta: {
        agent,
        sessionId,
        ...(title ? { title } : {}),
        ...(project ? { project } : {}),
      },
    };
  }
}

export function antigravityAdapter(opts: AntigravityOptions): Adapter {
  return {
    id: opts.id,
    label: opts.label,

    async detect({ home }): Promise<DetectResult> {
      try {
        const root = opts.root(home);
        const installed = hasFile(join(root, 'brain'), isTranscript)
          || hasFile(join(root, 'conversations'), (p) => p.endsWith('.db') || p.endsWith('.pb'))
          || existsSync(join(root, 'history.jsonl'))
          || existsSync(join(root, 'conversation_summaries.db'));
        return installed
          ? { installed: true, detail: root }
          : { installed: false, detail: `no sessions under ${root}` };
      } catch {
        return { installed: false, detail: 'detect failed' };
      }
    },

    async *ingest(ctx: IngestContext) {
      const root = opts.root(ctx.home);
      const models = loadModels(root, ctx.log);
      const summaries = loadSummaries(root);

      const history = join(root, 'history.jsonl');
      if (existsSync(history)) {
        const prev = getCursor(ctx.state, 'history');
        try {
          const read = readNewJsonl(history, prev);
          if (!read.unchanged) {
            yield* historySessions(opts.id, read.records);
            ctx.state.set('history', read.cursor);
          }
        } catch (error: unknown) {
          ctx.log(`skip history: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      for (const file of listFiles(join(root, 'brain'), isTranscript)) {
        const key = `f:${relKey(root, file)}`;
        const prev = getCursor(ctx.state, key);
        let read;
        try {
          read = readNewJsonl(file, prev);
        } catch (error: unknown) {
          ctx.log(`skip ${key}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        if (read.unchanged) continue;
        const sessionId = conversationId(file);
        const info = summaries.get(sessionId);
        const gens = models.get(sessionId) ?? [];
        for (const rec of read.records) {
          const step = typeof rec.step_index === 'number' ? rec.step_index : toInt(rec.step_index);
          const model = modelForStep(gens, step) ?? 'unknown';
          const item = eventFrom(opts.id, sessionId, rec, model, info);
          if (item) yield item;
        }
        yield {
          type: 'session',
          meta: {
            agent: opts.id,
            sessionId,
            ...(info?.title ? { title: info.title } : {}),
            ...(info?.project ? { project: info.project } : {}),
          },
        };
        ctx.state.set(key, read.cursor);
      }
    },
  };
}
