import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/core/db';

test('migrations are idempotent and backfill cost_source on pre-existing priced events', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'mig-')), 'u.db');
  // Simulate a database from before cost_source existed: apply everything, then drop the new data back to NULL.
  let total = 0;
  const first = openDb(path);
  const ins = first.prepare(
    `INSERT INTO events (id, agent, session_id, ts, model_raw, model, cost_usd, ingested_at) VALUES (?, 'a', 's', 1, 'm', 'm', ?, 1)`,
  );
  ins.run('paid', 1.5);
  ins.run('free', 0);
  ins.run('unpriced', null);
  total = (first.query('PRAGMA user_version').get() as { user_version: number }).user_version;
  first.exec(`UPDATE events SET cost_source = NULL; PRAGMA user_version = ${total - 1};`); // replay only the backfill (last migration)
  first.close();

  const db = openDb(path);
  const rows = db.query('SELECT id, cost_source FROM events ORDER BY id').all();
  expect(rows).toEqual([
    { id: 'free', cost_source: 'free-model' },
    { id: 'paid', cost_source: 'aws-price-list' },
    { id: 'unpriced', cost_source: null },
  ]);
  db.close();
  const after = new Database(path);
  expect(after.query('PRAGMA user_version').get()).toEqual({ user_version: total });
  after.close();
});
