// Small, agent-agnostic helpers for adapters. Not an adapter itself (skipped by the registry).
import { existsSync, openSync, closeSync, readSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { AdapterState } from '../core/types';

export type Json = Record<string, unknown>;

export function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Non-negative integer or 0. Never NaN/negative so downstream sums stay sane. */
export function toInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}

/** ISO string or epoch (ms) -> epoch ms. */
export function parseTs(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

export function readJsonSafe(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export function stableId(...parts: ReadonlyArray<string | number>): string {
  return parts.join(':');
}

const utf8 = new TextEncoder();
function strBytes(s: string): number {
  return utf8.encode(s).length;
}

/**
 * Size in bytes of a tool result "content" value: a string, or an array of blocks
 * (text blocks count their text; other blocks, e.g. images, count their JSON size).
 */
export function contentBytes(content: unknown): number {
  if (typeof content === 'string') return strBytes(content);
  if (Array.isArray(content)) {
    let total = 0;
    for (const b of content) {
      if (isObject(b) && b.type === 'text' && typeof b.text === 'string') total += strBytes(b.text);
      else total += strBytes(JSON.stringify(b) ?? '');
    }
    return total;
  }
  if (content === undefined || content === null) return 0;
  return strBytes(JSON.stringify(content) ?? '');
}

/** Recursively lists files under `root` matching `pred`, sorted. Missing dirs yield []. */
export function listFiles(root: string, pred: (path: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && pred(p)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

export function hasFile(root: string, pred: (path: string) => boolean): boolean {
  return existsSync(root) && listFiles(root, pred).length > 0;
}

export interface FileCursor {
  /** Bytes consumed so far (always on a line boundary). */
  offset: number;
  size: number;
  mtimeMs: number;
}

export interface JsonlRead {
  records: Json[];
  cursor: FileCursor;
  /** True when the file was re-read from the start (first time, or it shrank). */
  fromStart: boolean;
  /** True when nothing new was found. */
  unchanged: boolean;
}

/**
 * Reads complete JSON lines appended since `prev`. A trailing partial line is left for the
 * next call. Malformed lines are skipped. If the file shrank, it is re-read from byte 0.
 */
export function readNewJsonl(path: string, prev: FileCursor | undefined): JsonlRead {
  const st = statSync(path);
  let start = prev?.offset ?? 0;
  let fromStart = prev === undefined;
  if (prev && st.size < prev.offset) {
    start = 0;
    fromStart = true;
  }
  if (prev && !fromStart && st.size === prev.size && st.mtimeMs === prev.mtimeMs) {
    return { records: [], cursor: prev, fromStart: false, unchanged: true };
  }
  if (st.size <= start) {
    return {
      records: [],
      cursor: { offset: start, size: st.size, mtimeMs: st.mtimeMs },
      fromStart,
      unchanged: true,
    };
  }

  const len = st.size - start;
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < len) {
      const n = readSync(fd, buf, read, len - read, start + read);
      if (n === 0) break;
      read += n;
    }
  } finally {
    closeSync(fd);
  }

  const lastNl = buf.lastIndexOf(0x0a);
  const complete = lastNl === -1 ? 0 : lastNl + 1;
  const text = buf.subarray(0, complete).toString('utf8');
  const records: Json[] = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObject(parsed)) records.push(parsed);
    } catch {
      // malformed line: skip
    }
  }
  return {
    records,
    cursor: { offset: start + complete, size: st.size, mtimeMs: st.mtimeMs },
    fromStart,
    unchanged: false,
  };
}

/** Path of `file` relative to `root`, using forward slashes (stable state keys). */
export function relKey(root: string, file: string): string {
  const rel = file.startsWith(root) ? file.slice(root.length + 1) : file;
  return rel.split(sep).join('/');
}

export function getCursor(state: AdapterState, key: string): (FileCursor & Json) | undefined {
  const v = state.get<unknown>(key);
  return isObject(v) && typeof v.offset === 'number' ? (v as FileCursor & Json) : undefined;
}
