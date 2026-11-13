import { expect, test } from 'bun:test';
import { openDb } from '../../src/core/db';
import { pricingStatus } from '../../src/core/rates';

function insert(db: ReturnType<typeof openDb>, id: string, cost: number | null, source: string | null): void {
  db.query(
    `INSERT INTO events (id, agent, session_id, ts, model_raw, model, cost_usd, cost_source, ingested_at) VALUES (?, 'a', 's', 1, 'm', 'm', ?, ?, 1)`,
  ).run(id, cost, source);
}

test('pricingStatus groups ALL events by cost source, largest first, with unpriced as null', () => {
  const db = openDb(':memory:');
  insert(db, '1', 1.5, 'aws-price-list');
  insert(db, '2', 2.5, 'aws-price-list');
  insert(db, '3', 0.25, 'models.dev');
  insert(db, '4', 0, 'free-model');
  insert(db, '5', null, null);
  insert(db, '6', 3, null); // priced before cost_source existed
  const s = pricingStatus(db);
  expect(s.costSources).toEqual([
    { source: 'aws-price-list', events: 3, costUsd: 7 },
    { source: 'models.dev', events: 1, costUsd: 0.25 },
    { source: 'free-model', events: 1, costUsd: 0 },
    { source: null, events: 1, costUsd: 0 },
  ]);
});

test('pricingStatus has empty sources on an empty database', () => {
  const s = pricingStatus(openDb(':memory:'));
  expect(s.costSources).toEqual([]);
  expect(s.latestSnapshotAt).toBeNull();
});
