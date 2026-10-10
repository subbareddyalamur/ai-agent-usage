// Parser for the Claude Code transcript format. Shared by the claude-code and cowork adapters
// (Cowork's audit.jsonl is the same shape with `session_id` instead of `sessionId`).
import { asString, contentBytes, isObject, parseTs, stableId, toInt } from '../kit';
import type { Json } from '../kit';
import type { IngestItem, ToolCall } from '../../core/types';

export interface ClaudeFormatConfig {
  agent: string;
  isSubagent: (rec: Json) => boolean;
  /** Carried over from the previous run of the same file (incremental ingest). */
  cwd?: string;
  sessionId?: string;
  awsProfileHint?: string;
}

export interface ClaudeFormatResult {
  items: IngestItem[];
  /** Latest cwd / session id seen, to be persisted for the next incremental run. */
  cwd?: string;
  sessionId?: string;
}

interface Agg {
  sessionId: string;
  project?: string;
  ts: number;
  model: string;
  msgId: string;
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheCreationTotal: number;
  write5m: number;
  write1h: number;
  subagent: boolean;
  tools: Map<string, string>;
}

function mergeMax(a: number, b: number): number {
  return a > b ? a : b;
}

function providerFor(msgId: string, model: string): string {
  return msgId.startsWith('msg_bdrk_') || model.startsWith('anthropic.') ? 'amazon-bedrock' : 'anthropic';
}

function contentBlocks(message: Json): Json[] {
  const c = message.content;
  return Array.isArray(c) ? c.filter(isObject) : [];
}

/**
 * One API response is written as several lines sharing `message.id` (one content block per line,
 * usage growing as the stream progresses). Lines are merged per message id: usage = field-wise max,
 * tool_use blocks = union.
 */
export function parseClaudeRecords(records: readonly Json[], cfg: ClaudeFormatConfig): ClaudeFormatResult {
  let cwd = cfg.cwd;
  let lastSession = cfg.sessionId;
  let lastTs: number | undefined;
  const aggs = new Map<string, Agg>();
  const toolResults: IngestItem[] = [];
  const sessions = new Map<string, { title?: string; project?: string }>();

  const touchSession = (sid: string, patch: { title?: string; project?: string }): void => {
    const cur = sessions.get(sid) ?? {};
    sessions.set(sid, { title: patch.title ?? cur.title, project: patch.project ?? cur.project });
  };

  for (const rec of records) {
    const sid = asString(rec.sessionId) ?? asString(rec.session_id) ?? lastSession;
    if (sid) lastSession = sid;
    const recCwd = asString(rec.cwd);
    if (recCwd) cwd = recCwd;
    // Some transcripts (Cowork) omit `timestamp` on streamed lines and only carry `_audit_timestamp`.
    const recTs = parseTs(rec.timestamp) ?? parseTs(rec._audit_timestamp);
    if (recTs !== undefined) lastTs = recTs;

    if (rec.type === 'ai-title') {
      const title = asString(rec.aiTitle);
      if (sid && title) touchSession(sid, { title });
      continue;
    }

    const message = isObject(rec.message) ? rec.message : undefined;
    if (!message) continue;

    if (rec.type === 'user') {
      if (Array.isArray(message.content)) {
        for (const b of message.content) {
          if (!isObject(b) || b.type !== 'tool_result') continue;
          const callId = asString(b.tool_use_id);
          if (!callId) continue;
          toolResults.push({
            type: 'toolResult',
            agent: cfg.agent,
            result: { callId, resultBytes: contentBytes(b.content), ...(b.is_error === true ? { isError: true } : {}) },
          });
        }
      }
      continue;
    }

    if (rec.type !== 'assistant') continue;
    const model = asString(message.model);
    if (!model || model === '<synthetic>') continue;
    const msgId = asString(message.id) ?? asString(rec.uuid);
    const ts = recTs ?? lastTs;
    if (!msgId || ts === undefined) continue;
    const sessionId = sid ?? 'unknown';
    const key = stableId(sessionId, msgId);

    let agg = aggs.get(key);
    if (!agg) {
      agg = {
        sessionId, project: recCwd ?? cwd, ts, model, msgId,
        input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreationTotal: 0, write5m: 0, write1h: 0,
        subagent: cfg.isSubagent(rec), tools: new Map(),
      };
      aggs.set(key, agg);
    }

    const usage = isObject(message.usage) ? message.usage : {};
    const cc = isObject(usage.cache_creation) ? usage.cache_creation : {};
    const details = isObject(usage.output_tokens_details) ? usage.output_tokens_details : {};
    agg.input = mergeMax(agg.input, toInt(usage.input_tokens));
    agg.output = mergeMax(agg.output, toInt(usage.output_tokens));
    agg.thinking = mergeMax(agg.thinking, toInt(details.thinking_tokens));
    agg.cacheRead = mergeMax(agg.cacheRead, toInt(usage.cache_read_input_tokens));
    agg.cacheCreationTotal = mergeMax(agg.cacheCreationTotal, toInt(usage.cache_creation_input_tokens));
    agg.write5m = mergeMax(agg.write5m, toInt(cc.ephemeral_5m_input_tokens));
    agg.write1h = mergeMax(agg.write1h, toInt(cc.ephemeral_1h_input_tokens));

    for (const b of contentBlocks(message)) {
      if (b.type !== 'tool_use') continue;
      const id = asString(b.id);
      const name = asString(b.name);
      if (id && name) agg.tools.set(id, name);
    }
    if (agg.project) touchSession(sessionId, { project: agg.project });
  }

  const items: IngestItem[] = [];
  for (const a of aggs.values()) {
    const thinking = Math.min(a.thinking, a.output);
    const split = a.write5m + a.write1h > 0;
    const write5m = split ? a.write5m : a.cacheCreationTotal;
    const write1h = split ? a.write1h : 0;
    if (a.input + a.output + a.cacheRead + write5m + write1h === 0) continue;
    const tools: ToolCall[] = [...a.tools].map(([callId, name]) => ({ callId, name }));
    items.push({
      type: 'event',
      event: {
        id: stableId(cfg.agent, a.sessionId, a.msgId),
        agent: cfg.agent,
        sessionId: a.sessionId,
        ...(a.project ? { project: a.project } : {}),
        ts: a.ts,
        provider: providerFor(a.msgId, a.model),
        modelRaw: a.model,
        inputTokens: a.input,
        outputTokens: a.output - thinking,
        reasoningTokens: thinking,
        cacheReadTokens: a.cacheRead,
        cacheWrite5mTokens: write5m,
        cacheWrite1hTokens: write1h,
        isSubagent: a.subagent,
        kind: 'step',
        ...(cfg.awsProfileHint ? { awsProfileHint: cfg.awsProfileHint } : {}),
        tools,
      },
    });
  }
  items.push(...toolResults);
  for (const [sessionId, s] of sessions) {
    items.push({
      type: 'session',
      meta: { agent: cfg.agent, sessionId, ...(s.title ? { title: s.title } : {}), ...(s.project ? { project: s.project } : {}) },
    });
  }
  return { items, cwd, sessionId: lastSession };
}
