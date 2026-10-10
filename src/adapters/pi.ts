import { basename, join } from 'node:path';
import {
  asString, contentBytes, getCursor, hasFile, isObject, listFiles, parseTs, readNewJsonl, relKey, stableId, toInt,
} from './kit';
import type { Json } from './kit';
import type { Adapter, DetectResult, IngestItem, ToolCall } from '../core/types';

const AGENT = 'pi';
const isJsonl = (p: string): boolean => p.endsWith('.jsonl');
const sessionsDir = (home: string): string => join(home, '.pi', 'agent', 'sessions');

/** `<timestamp>_<uuid>.jsonl` -> uuid (fallback when the file has no session line). */
function sessionIdFromFile(file: string): string {
  const stem = basename(file, '.jsonl');
  const i = stem.indexOf('_');
  return i >= 0 ? stem.slice(i + 1) : stem;
}

interface FileCtx {
  sessionId: string;
  cwd?: string;
  title?: string;
}

function eventFrom(entry: Json, message: Json, ctx: FileCtx): IngestItem | undefined {
  const usage = isObject(message.usage) ? message.usage : undefined;
  const model = asString(message.model);
  const entryId = asString(entry.id);
  const ts = parseTs(entry.timestamp) ?? parseTs(message.timestamp);
  if (!usage || !model || !entryId || ts === undefined) return undefined;

  const input = toInt(usage.input);
  const output = toInt(usage.output);
  const cacheRead = toInt(usage.cacheRead);
  const cacheWrite = toInt(usage.cacheWrite);
  if (input + output + cacheRead + cacheWrite === 0) return undefined;

  const tools: ToolCall[] = [];
  if (Array.isArray(message.content)) {
    for (const b of message.content) {
      if (!isObject(b) || b.type !== 'toolCall') continue;
      const callId = asString(b.id);
      const name = asString(b.name);
      if (callId && name) tools.push({ callId, name });
    }
  }
  const cost = isObject(usage.cost) && typeof usage.cost.total === 'number' ? usage.cost.total : undefined;
  const provider = asString(message.provider);

  return {
    type: 'event',
    event: {
      id: stableId(AGENT, ctx.sessionId, entryId),
      agent: AGENT,
      sessionId: ctx.sessionId,
      ...(ctx.cwd ? { project: ctx.cwd } : {}),
      ts,
      ...(provider ? { provider } : {}),
      modelRaw: model,
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: 0,
      cacheReadTokens: cacheRead,
      cacheWrite5mTokens: cacheWrite,
      cacheWrite1hTokens: 0,
      isSubagent: false,
      kind: 'step',
      ...(cost !== undefined ? { reportedCostUsd: cost } : {}),
      tools,
    },
  };
}

function* parseRecords(records: readonly Json[], ctx: FileCtx): Generator<IngestItem> {
  for (const rec of records) {
    if (rec.type === 'session') {
      ctx.sessionId = asString(rec.id) ?? ctx.sessionId;
      ctx.cwd = asString(rec.cwd) ?? ctx.cwd;
    } else if (rec.type === 'session_info') {
      ctx.title = asString(rec.name) ?? ctx.title;
    } else if (rec.type === 'message' && isObject(rec.message)) {
      const m = rec.message;
      if (m.role === 'assistant') {
        const ev = eventFrom(rec, m, ctx);
        if (ev) yield ev;
      } else if (m.role === 'toolResult') {
        const callId = asString(m.toolCallId);
        if (callId) {
          yield {
            type: 'toolResult',
            agent: AGENT,
            result: { callId, resultBytes: contentBytes(m.content), ...(m.isError === true ? { isError: true } : {}) },
          };
        }
      }
    }
  }
  yield {
    type: 'session',
    meta: {
      agent: AGENT,
      sessionId: ctx.sessionId,
      ...(ctx.title ? { title: ctx.title } : {}),
      ...(ctx.cwd ? { project: ctx.cwd } : {}),
    },
  };
}

const adapter: Adapter = {
  id: AGENT,
  label: 'Pi',

  async detect({ home }): Promise<DetectResult> {
    try {
      const dir = sessionsDir(home);
      return hasFile(dir, isJsonl)
        ? { installed: true, detail: dir }
        : { installed: false, detail: `no sessions under ${dir}` };
    } catch {
      return { installed: false, detail: 'detect failed' };
    }
  },

  async *ingest(ctx) {
    const root = sessionsDir(ctx.home);
    for (const file of listFiles(root, isJsonl)) {
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

      const carry = !read.fromStart && prev ? prev : undefined;
      const fileCtx: FileCtx = {
        sessionId: typeof carry?.sessionId === 'string' ? carry.sessionId : sessionIdFromFile(file),
        cwd: typeof carry?.cwd === 'string' ? carry.cwd : undefined,
        title: typeof carry?.title === 'string' ? carry.title : undefined,
      };
      if (read.records.length > 0) yield* parseRecords(read.records, fileCtx);
      ctx.state.set(key, { ...read.cursor, sessionId: fileCtx.sessionId, cwd: fileCtx.cwd, title: fileCtx.title });
    }
  },
};

export default adapter;
