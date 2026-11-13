// Codex rollout JSONL. Each token_count event's last_token_usage is one step.
// total_token_usage is the running sum and is ignored. cached_input_tokens is a subset of input_tokens.
import { basename, join } from 'node:path';
import {
  asString, contentBytes, getCursor, hasFile, isObject, listFiles, parseTs, providerForModel, readNewJsonl, relKey, stableId, toInt,
} from './kit';
import type { Json } from './kit';
import type { Adapter, DetectResult, IngestItem, ToolCall } from '../core/types';

const AGENT = 'codex';
const isJsonl = (p: string): boolean => p.endsWith('.jsonl');
const sessionsDir = (home: string): string => join(home, '.codex', 'sessions');

interface PendingTool {
  callId: string;
  name: string;
  resultBytes?: number;
}

interface Carry {
  sessionId?: string;
  cwd?: string;
  model?: string;
  provider?: string;
  ordinal: number;
  pending: PendingTool[];
}

function sessionIdFromFile(file: string): string {
  const stem = basename(file, '.jsonl');
  const match = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return match?.[0] ?? stem;
}

function* parseRecords(records: readonly Json[], carry: Carry, file: string): Generator<IngestItem> {
  if (!carry.sessionId) carry.sessionId = sessionIdFromFile(file);
  for (const rec of records) {
    const payload = isObject(rec.payload) ? rec.payload : undefined;
    if (!payload) continue;
    if (rec.type === 'session_meta') {
      carry.sessionId = asString(payload.id) ?? carry.sessionId;
      carry.cwd = asString(payload.cwd) ?? carry.cwd;
      carry.provider = asString(payload.model_provider) ?? carry.provider;
    } else if (rec.type === 'turn_context') {
      carry.model = asString(payload.model) ?? carry.model;
      carry.cwd = asString(payload.cwd) ?? carry.cwd;
    } else if (rec.type === 'response_item') {
      const kind = asString(payload.type);
      const callId = asString(payload.call_id);
      if ((kind === 'function_call' || kind === 'custom_tool_call') && callId) {
        const name = asString(payload.name);
        if (name) carry.pending.push({ callId, name });
      } else if ((kind === 'function_call_output' || kind === 'custom_tool_call_output') && callId) {
        const bytes = contentBytes(payload.output);
        const pending = carry.pending.find((t) => t.callId === callId);
        if (pending) pending.resultBytes = bytes;
        else yield { type: 'toolResult', agent: AGENT, result: { callId, resultBytes: bytes } };
      }
    } else if (rec.type === 'event_msg' && payload.type === 'token_count') {
      const info = isObject(payload.info) ? payload.info : undefined;
      const last = info && isObject(info.last_token_usage) ? info.last_token_usage : undefined;
      carry.ordinal += 1;
      if (!last || !carry.sessionId) continue;
      const cached = toInt(last.cached_input_tokens);
      const input = Math.max(0, toInt(last.input_tokens) - cached);
      const output = toInt(last.output_tokens);
      const reasoning = toInt(last.reasoning_output_tokens);
      if (input + cached + output + reasoning === 0) continue;
      const ts = parseTs(rec.timestamp);
      if (ts === undefined) continue;
      const model = carry.model ?? 'unknown';
      const provider = carry.provider ?? providerForModel(model);
      const tools: ToolCall[] = carry.pending.splice(0).map((t) => ({
        callId: t.callId,
        name: t.name,
        ...(t.resultBytes !== undefined ? { resultBytes: t.resultBytes } : {}),
      }));
      yield {
        type: 'event',
        event: {
          id: stableId(AGENT, carry.sessionId, carry.ordinal),
          agent: AGENT,
          sessionId: carry.sessionId,
          ...(carry.cwd ? { project: carry.cwd } : {}),
          ts,
          ...(provider ? { provider } : {}),
          modelRaw: model,
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: reasoning,
          cacheReadTokens: cached,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          isSubagent: false,
          kind: 'step',
          tools,
        },
      };
    }
  }
}

function carryFrom(prev: ReturnType<typeof getCursor> | undefined, file: string): Carry {
  const pending = Array.isArray(prev?.pending) ? prev.pending.flatMap((item) => {
    if (!isObject(item)) return [];
    const callId = asString(item.callId);
    const name = asString(item.name);
    if (!callId || !name) return [];
    const resultBytes = toInt(item.resultBytes);
    return [{ callId, name, ...(resultBytes > 0 ? { resultBytes } : {}) }];
  }) : [];
  return {
    sessionId: asString(prev?.sessionId) ?? sessionIdFromFile(file),
    cwd: asString(prev?.cwd),
    model: asString(prev?.model),
    provider: asString(prev?.provider),
    ordinal: typeof prev?.ordinal === 'number' && prev.ordinal >= 0 ? prev.ordinal : 0,
    pending,
  };
}

const adapter: Adapter = {
  id: AGENT,
  label: 'Codex',

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
      const carry = carryFrom(read.fromStart ? undefined : prev, file);
      let saw = false;
      for (const item of parseRecords(read.records, carry, file)) {
        saw = true;
        yield item;
      }
      if (saw && carry.sessionId) {
        yield {
          type: 'session',
          meta: { agent: AGENT, sessionId: carry.sessionId, ...(carry.cwd ? { project: carry.cwd } : {}) },
        };
      }
      ctx.state.set(key, {
        ...read.cursor,
        sessionId: carry.sessionId,
        cwd: carry.cwd,
        model: carry.model,
        provider: carry.provider,
        ordinal: carry.ordinal,
        pending: carry.pending,
      });
    }
  },
};

export default adapter;
