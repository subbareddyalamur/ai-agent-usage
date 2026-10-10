// Starts the dashboard against a freshly seeded DEMO database (never touches the real one).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../core/db';
import { startServer } from '../server';
import { seedDemo } from './seed';

const port = Number(process.argv[2] ?? 0);
const dbPath = join(mkdtempSync(join(tmpdir(), 'agent-usage-demo-')), 'demo.db');
const db = openDb(dbPath);
const seeded = seedDemo(db);
const server = startServer({ db, dbPath, ingestAll: async () => {} }, { port });
process.stdout.write(`demo: ${seeded.events} events, ${seeded.sessions} sessions\n${server.url}\n`);
