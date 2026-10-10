import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeJsonl(path: string, records: readonly unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function appendJsonl(path: string, records: readonly unknown[]): void {
  appendFileSync(path, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  output_tokens_details?: { thinking_tokens?: number };
}

/** Claude Code style assistant line. Cowork uses session_id instead of sessionId (sessionKey). */
export function claudeAssistant(o: {
  msgId: string;
  sessionId?: string;
  sessionKey?: 'sessionId' | 'session_id';
  model?: string;
  usage?: ClaudeUsage;
  content?: unknown[];
  ts?: string;
  cwd?: string;
  isSidechain?: boolean;
  parentToolUseId?: string | null;
}): Record<string, unknown> {
  return {
    type: 'assistant',
    [o.sessionKey ?? 'sessionId']: o.sessionId ?? 'sess-1',
    ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
    ...(o.isSidechain !== undefined ? { isSidechain: o.isSidechain } : {}),
    ...(o.parentToolUseId !== undefined ? { parent_tool_use_id: o.parentToolUseId } : {}),
    timestamp: o.ts ?? '2026-10-01T10:00:00.000Z',
    uuid: `u-${o.msgId}-${Math.random().toString(36).slice(2, 8)}`,
    message: {
      id: o.msgId,
      role: 'assistant',
      model: o.model ?? 'claude-sonnet-4-6',
      content: o.content ?? [{ type: 'text', text: 'hi' }],
      usage: o.usage ?? { input_tokens: 10, output_tokens: 5 },
    },
  };
}

export function claudeToolResult(o: {
  toolUseId: string;
  content: unknown;
  isError?: boolean;
  sessionId?: string;
  sessionKey?: 'sessionId' | 'session_id';
}): Record<string, unknown> {
  return {
    type: 'user',
    [o.sessionKey ?? 'sessionId']: o.sessionId ?? 'sess-1',
    timestamp: '2026-10-01T10:00:01.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: o.toolUseId, content: o.content, ...(o.isError ? { is_error: true } : {}) }],
    },
  };
}
