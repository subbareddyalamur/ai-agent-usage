// Gemini CLI chat JSON under ~/.gemini/tmp and ~/.gemini/history.
// A message counts only when it carries a tokens object or usageMetadata.
import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  asString, getCursor, hasFile, isObject, listFiles, parseTs, providerForModel, readJsonSafe, relKey, stableId, toInt,
} from './kit';
import type { Json } from './kit';
import type { Adapter, DetectResult, IngestItem } from '../core/types';

const AGENT = 'gemini-cli';

function isChatJson(path: string): boolean {
  return path.endsWith('.json') && basename(path) !== 'logs.json';
}

function roots(home: string): string[] {
  return [join(home, '.gemini', 'tmp'), join(home, '.gemini', 'history')];
}

function installedMarker(home: string): string | undefined {
  const markers = [join(home, '.gemini', 'settings.json'), join(home, '.gemini', 'config', 'config.json')];
  return markers.find((p) => existsSync(p));
}

interface TokenFields {
  input: number;
  output: number;
  cached: number;
  thoughts: number;
}

/** CLI `tokens` are already split. API usageMetadata.promptTokenCount includes the cached subset. */
function tokensOf(message: Json): TokenFields | undefined {
  const bag = isObject(message.tokens) ? message.tokens : isObject(message.usage) ? message.usage : undefined;
  const meta = isObject(message.usageMetadata) ? message.usageMetadata : undefined;
  if (!bag && !meta) return undefined;
  const cached = toInt(bag?.cached ?? bag?.cacheRead ?? bag?.cached_tokens ?? meta?.cachedContentTokenCount);
  const prompt = toInt(bag?.input ?? bag?.inputTokens ?? bag?.prompt_tokens ?? meta?.promptTokenCount);
  const output = toInt(bag?.output ?? bag?.outputTokens ?? bag?.completion_tokens ?? meta?.candidatesTokenCount);
  const thoughts = toInt(bag?.thoughts ?? bag?.reasoning ?? meta?.thoughtsTokenCount);
  if (prompt + output + cached + thoughts === 0) return undefined;
  const input = bag ? prompt : Math.max(0, prompt - cached);
  return { input, output, cached, thoughts };
}

function* fromSession(value: Json, file: string): Generator<IngestItem> {
  const sessionId = asString(value.sessionId) ?? asString(value.id) ?? basename(file, '.json');
  const project = asString(value.cwd) ?? asString(value.project) ?? asString(value.directory);
  const sessionModel = asString(value.model);
  const messages = Array.isArray(value.messages) ? value.messages : [value];
  let n = 0;
  for (const message of messages) {
    if (!isObject(message)) continue;
    const tokens = tokensOf(message);
    if (!tokens) continue;
    n += 1;
    const model = asString(message.model) ?? sessionModel ?? 'unknown';
    const ts = parseTs(message.timestamp) ?? parseTs(value.startTime) ?? parseTs(value.lastUpdated);
    if (ts === undefined) continue;
    const provider = providerForModel(model) ?? 'google';
    yield {
      type: 'event',
      event: {
        id: stableId(AGENT, sessionId, asString(message.id) ?? String(n)),
        agent: AGENT,
        sessionId,
        ...(project ? { project } : {}),
        ts,
        provider,
        modelRaw: model,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        reasoningTokens: tokens.thoughts,
        cacheReadTokens: tokens.cached,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        isSubagent: false,
        kind: 'step',
        tools: [],
      },
    };
  }
  if (n > 0) {
    const title = asString(value.title);
    yield {
      type: 'session',
      meta: {
        agent: AGENT,
        sessionId,
        ...(title ? { title } : {}),
        ...(project ? { project } : {}),
      },
    };
  }
}

const adapter: Adapter = {
  id: AGENT,
  label: 'Gemini CLI',

  async detect({ home }): Promise<DetectResult> {
    try {
      const marker = installedMarker(home);
      if (marker) return { installed: true, detail: marker };
      for (const root of roots(home)) {
        if (hasFile(root, isChatJson)) return { installed: true, detail: root };
      }
      return { installed: false, detail: 'no Gemini CLI config or chats' };
    } catch {
      return { installed: false, detail: 'detect failed' };
    }
  },

  async *ingest(ctx) {
    for (const root of roots(ctx.home)) {
      for (const file of listFiles(root, isChatJson)) {
        const key = `f:${relKey(root, file)}`;
        const prev = getCursor(ctx.state, key);
        let size = 0;
        let mtimeMs = 0;
        try {
          const st = statSync(file);
          size = st.size;
          mtimeMs = st.mtimeMs;
        } catch (error: unknown) {
          ctx.log(`skip ${key}: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        if (prev && prev.size === size && prev.mtimeMs === mtimeMs) continue;
        const parsed = readJsonSafe(file);
        if (isObject(parsed)) yield* fromSession(parsed, file);
        else if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (isObject(item)) yield* fromSession(item, file);
          }
        }
        ctx.state.set(key, { offset: size, size, mtimeMs });
      }
    }
  },
};

export default adapter;
