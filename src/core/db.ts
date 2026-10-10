import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Append-only. Never edit a released entry; add a new one. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    session_id TEXT NOT NULL,
    project TEXT,
    ts INTEGER NOT NULL,
    provider TEXT,
    model_raw TEXT NOT NULL,
    model TEXT NOT NULL,
    priced INTEGER NOT NULL DEFAULT 0,
    tier TEXT NOT NULL DEFAULT 'regional',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
    cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
    is_subagent INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'step',
    reported_cost_usd REAL,
    aws_profile_hint TEXT,
    cost_usd REAL,
    cost_approx INTEGER NOT NULL DEFAULT 0,
    ingested_at INTEGER NOT NULL
  );
  CREATE INDEX events_ts_idx ON events (ts);
  CREATE INDEX events_session_idx ON events (agent, session_id, ts);
  CREATE INDEX events_model_idx ON events (model);

  CREATE TABLE tool_calls (
    agent TEXT NOT NULL,
    call_id TEXT NOT NULL,
    event_id TEXT,
    name TEXT NOT NULL,
    result_bytes INTEGER,
    is_error INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (agent, call_id)
  );
  CREATE INDEX tool_calls_event_idx ON tool_calls (event_id);
  CREATE INDEX tool_calls_name_idx ON tool_calls (name);

  CREATE TABLE sessions (
    agent TEXT NOT NULL,
    session_id TEXT NOT NULL,
    title TEXT,
    project TEXT,
    PRIMARY KEY (agent, session_id)
  );

  CREATE TABLE adapter_state (
    adapter TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (adapter, key)
  );

  CREATE TABLE adapter_runs (
    adapter TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    installed INTEGER NOT NULL,
    detail TEXT,
    error TEXT,
    last_ingest_at INTEGER
  );

  -- One row per distinct price list content. fetched_at = first time this content was observed
  -- (effective-from); last_checked_at moves forward on every refresh that finds identical content.
  CREATE TABLE price_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fetched_at INTEGER NOT NULL,
    last_checked_at INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    source_url TEXT NOT NULL,
    publication_date TEXT,
    row_count INTEGER NOT NULL
  );

  CREATE TABLE prices (
    snapshot_id INTEGER NOT NULL REFERENCES price_snapshots(id),
    model TEXT NOT NULL,
    region TEXT NOT NULL,
    tier TEXT NOT NULL,
    kind TEXT NOT NULL,
    long_ctx INTEGER NOT NULL DEFAULT 0,
    usd_per_mtok REAL NOT NULL,
    PRIMARY KEY (snapshot_id, model, region, tier, kind, long_ctx)
  );

  CREATE TABLE model_cache (
    raw TEXT NOT NULL,
    tier TEXT NOT NULL,
    canonical TEXT NOT NULL,
    priced INTEGER NOT NULL,
    resolved_at INTEGER NOT NULL,
    PRIMARY KEY (raw, tier)
  );

  CREATE TABLE arn_cache (
    arn TEXT PRIMARY KEY,
    model_raw TEXT,
    resolved_at INTEGER NOT NULL,
    error TEXT
  );
  `,
  `
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `ALTER TABLE prices ADD COLUMN source TEXT NOT NULL DEFAULT 'foundation-models';`,
];

export function defaultDbPath(): string {
  return process.env.AGENT_USAGE_DB ?? join(homedir(), '.local', 'share', 'agent-usage', 'usage.db');
}

export function openDb(path: string = defaultDbPath()): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const row = db.query('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v] as string);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    })();
  }
}
