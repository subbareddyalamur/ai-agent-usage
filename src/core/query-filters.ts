import type { Database } from 'bun:sqlite';
import type { Filters } from './api-types';

export type SqlParam = string | number;

export interface Where {
  sql: string;
  params: SqlParam[];
}

/**
 * Builds a parameterised WHERE body (no leading "WHERE") over the events table.
 * Only column names from this file are interpolated; every value is a bound parameter.
 * Empty lists mean "no restriction".
 */
export function buildWhere(f: Filters, alias = 'e'): Where {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  const col = (c: string): string => `${alias}.${c}`;
  const inList = (column: string, values: readonly string[] | undefined): void => {
    if (!values || values.length === 0) return;
    clauses.push(`${col(column)} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  };

  if (f.from !== undefined) {
    clauses.push(`${col('ts')} >= ?`);
    params.push(f.from);
  }
  if (f.to !== undefined) {
    clauses.push(`${col('ts')} <= ?`);
    params.push(f.to);
  }
  inList('agent', f.agents);
  inList('model', f.models);
  inList('project', f.projects);
  if (f.includeSubagents === false) clauses.push(`${col('is_subagent')} = 0`);

  return { sql: clauses.length > 0 ? clauses.join(' AND ') : '1=1', params };
}

/** Runs a one-off statement and always finalizes it (dynamic SQL must not pile up in the statement cache). */
export function all<T>(db: Database, sql: string, params: readonly SqlParam[] = []): T[] {
  const st = db.prepare(sql);
  try {
    return st.all(...params) as T[];
  } finally {
    st.finalize();
  }
}

export function one<T>(db: Database, sql: string, params: readonly SqlParam[] = []): T | null {
  const st = db.prepare(sql);
  try {
    return (st.get(...params) as T | null | undefined) ?? null;
  } finally {
    st.finalize();
  }
}
