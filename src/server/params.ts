import type { Filters } from '../core/api-types';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export type Bucket = 'day' | 'week' | 'month';
export type Split = 'model' | 'agent';
export type SessionSort = 'cost' | 'ts' | 'context' | 'cacheHit' | 'steps';

export interface SessionQuery {
  sort: SessionSort;
  dir: 'asc' | 'desc';
  limit: number;
  offset: number;
}

const MAX_LIST_ITEMS = 100;
const MAX_ITEM_LENGTH = 200;
const BUCKETS: readonly Bucket[] = ['day', 'week', 'month'];
const SPLITS: readonly Split[] = ['model', 'agent'];
const SORTS: readonly SessionSort[] = ['cost', 'ts', 'context', 'cacheHit', 'steps'];

function fail<T>(field: string): Parsed<T> {
  // Only the field name is ever echoed back, never the offending value.
  return { ok: false, error: `invalid "${field}"` };
}

function parseEpoch(sp: URLSearchParams, field: string): Parsed<number | undefined> {
  const raw = sp.get(field);
  if (raw === null || raw === '') return { ok: true, value: undefined };
  if (!/^\d{1,16}$/.test(raw)) return fail(field);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return fail(field);
  return { ok: true, value: n };
}

function parseList(sp: URLSearchParams, field: string): Parsed<string[] | undefined> {
  const all = sp.getAll(field);
  if (all.length === 0) return { ok: true, value: undefined };
  const items = all
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  if (items.length === 0) return { ok: true, value: undefined };
  if (items.length > MAX_LIST_ITEMS) return fail(field);
  if (items.some((v) => v.length > MAX_ITEM_LENGTH)) return fail(field);
  return { ok: true, value: [...new Set(items)] };
}

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function parseFilters(sp: URLSearchParams): Parsed<Filters> {
  const from = parseEpoch(sp, 'from');
  if (!from.ok) return from;
  const to = parseEpoch(sp, 'to');
  if (!to.ok) return to;
  if (from.value !== undefined && to.value !== undefined && from.value > to.value) return fail('from');

  const agents = parseList(sp, 'agents');
  if (!agents.ok) return agents;
  const models = parseList(sp, 'models');
  if (!models.ok) return models;
  const projects = parseList(sp, 'projects');
  if (!projects.ok) return projects;

  let includeSubagents: boolean | undefined;
  const sub = sp.get('subagents');
  if (sub !== null && sub !== '') {
    if (sub !== '0' && sub !== '1') return fail('subagents');
    includeSubagents = sub === '1';
  }

  let tz: string | undefined;
  const rawTz = sp.get('tz');
  if (rawTz !== null && rawTz !== '') {
    if (rawTz.length > 64 || !validTimeZone(rawTz)) return fail('tz');
    tz = rawTz;
  }

  const filters: Filters = {
    ...(from.value !== undefined && { from: from.value }),
    ...(to.value !== undefined && { to: to.value }),
    ...(agents.value && { agents: agents.value }),
    ...(models.value && { models: models.value }),
    ...(projects.value && { projects: projects.value }),
    ...(includeSubagents !== undefined && { includeSubagents }),
    ...(tz && { tz }),
  };
  return { ok: true, value: filters };
}

function pick<T extends string>(sp: URLSearchParams, field: string, allowed: readonly T[], fallback: T): Parsed<T> {
  const raw = sp.get(field);
  if (raw === null || raw === '') return { ok: true, value: fallback };
  const hit = allowed.find((a) => a === raw);
  return hit ? { ok: true, value: hit } : fail(field);
}

export function parseSeriesParams(sp: URLSearchParams): Parsed<{ bucket: Bucket; split: Split }> {
  const bucket = pick(sp, 'bucket', BUCKETS, 'day');
  if (!bucket.ok) return bucket;
  const split = pick(sp, 'split', SPLITS, 'model');
  if (!split.ok) return split;
  return { ok: true, value: { bucket: bucket.value, split: split.value } };
}

function parseIntInRange(sp: URLSearchParams, field: string, min: number, max: number, fallback: number): Parsed<number> {
  const raw = sp.get(field);
  if (raw === null || raw === '') return { ok: true, value: fallback };
  if (!/^\d{1,9}$/.test(raw)) return fail(field);
  const n = Number(raw);
  if (n < min || n > max) return fail(field);
  return { ok: true, value: n };
}

export function parseSessionQuery(sp: URLSearchParams): Parsed<SessionQuery> {
  const sort = pick(sp, 'sort', SORTS, 'ts');
  if (!sort.ok) return sort;
  const dir = pick(sp, 'dir', ['asc', 'desc'] as const, 'desc');
  if (!dir.ok) return dir;
  const limit = parseIntInRange(sp, 'limit', 1, 1000, 50);
  if (!limit.ok) return limit;
  const offset = parseIntInRange(sp, 'offset', 0, 10_000_000, 0);
  if (!offset.ok) return offset;
  return { ok: true, value: { sort: sort.value, dir: dir.value, limit: limit.value, offset: offset.value } };
}
