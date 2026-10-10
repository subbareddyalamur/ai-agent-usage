import type { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import type { AdapterStatus, FilterOptions, StatusInfo } from './api-types';
import { all, one } from './query-filters';
import { pricingStatus } from './rates';

export function filterOptions(db: Database): FilterOptions {
  const agents = all<{ v: string }>(db, 'SELECT DISTINCT agent AS v FROM events ORDER BY agent').map((r) => r.v);
  const models = all<{ v: string }>(db, 'SELECT DISTINCT model AS v FROM events ORDER BY model').map((r) => r.v);
  const projects = all<{ v: string }>(
    db,
    'SELECT DISTINCT project AS v FROM events WHERE project IS NOT NULL ORDER BY project',
  ).map((r) => r.v);
  const range = one<{ lo: number | null; hi: number | null }>(db, 'SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM events');
  return { agents, models, projects, minTs: range?.lo ?? null, maxTs: range?.hi ?? null };
}

interface AdapterRow {
  adapter: string;
  label: string;
  installed: number;
  detail: string | null;
  error: string | null;
  last_ingest_at: number | null;
}

export function status(db: Database, dbPath: string): StatusInfo {
  const runs = all<AdapterRow>(db, 'SELECT adapter, label, installed, detail, error, last_ingest_at FROM adapter_runs ORDER BY adapter');
  const stats = new Map(
    all<{ agent: string; n: number; lo: number; hi: number }>(
      db,
      'SELECT agent, COUNT(*) AS n, MIN(ts) AS lo, MAX(ts) AS hi FROM events GROUP BY agent',
    ).map((r) => [r.agent, r]),
  );

  const adapters: AdapterStatus[] = runs.map((r) => {
    const s = stats.get(r.adapter);
    return {
      id: r.adapter,
      label: r.label,
      installed: r.installed === 1,
      ...(r.detail ? { detail: r.detail } : {}),
      events: s?.n ?? 0,
      firstTs: s?.lo ?? null,
      lastTs: s?.hi ?? null,
      lastIngestAt: r.last_ingest_at,
      ...(r.error ? { error: r.error } : {}),
    };
  });
  // History from an adapter that no longer exists stays visible.
  const known = new Set(runs.map((r) => r.adapter));
  for (const [agent, s] of stats) {
    if (known.has(agent)) continue;
    adapters.push({
      id: agent, label: agent, installed: false, detail: 'no adapter registered; history retained',
      events: s.n, firstTs: s.lo, lastTs: s.hi, lastIngestAt: null,
    });
  }

  const unmappedModels = all<{ raw: string; events: number; tokens: number }>(
    db,
    `SELECT model_raw AS raw, COUNT(*) AS events,
            SUM(input_tokens + output_tokens + reasoning_tokens + cache_read_tokens
                + cache_write_5m_tokens + cache_write_1h_tokens) AS tokens
     FROM events WHERE priced = 0 GROUP BY model_raw ORDER BY tokens DESC, raw`,
  );

  const sizeBytes = dbPath !== ':memory:' && existsSync(dbPath) ? statSync(dbPath).size : 0;
  return { adapters, pricing: pricingStatus(db), unmappedModels, db: { path: dbPath, sizeBytes } };
}
