import type { Database } from 'bun:sqlite';
import index from '../../ui/index.html';
import { runInsights } from '../insights';
import * as q from '../core/query';
import { createApiHandler, type ApiDeps } from './api';

/** Structural subset of the application object (src/app.ts) the server relies on. */
export interface ServerApp {
  db: Database;
  dbPath: string;
  ingestAll(): Promise<unknown>;
}

export interface RunningServer {
  url: string;
  port: number;
  stop(): void;
}

export function depsFromApp(app: ServerApp): ApiDeps {
  const { db } = app;
  return {
    filterOptions: () => q.filterOptions(db),
    summary: (f) => q.summary(db, f),
    series: (f, bucket, split) => q.series(db, f, bucket, split),
    sessions: (f, o) => q.sessions(db, f, o),
    sessionDetail: (agent, id) => q.sessionDetail(db, agent, id),
    models: (f) => q.models(db, f),
    tools: (f) => q.tools(db, f),
    cache: (f) => q.cacheReport(db, f),
    insights: (f) => runInsights(db, f),
    status: () => q.status(db, app.dbPath),
    refresh: () => app.ingestAll(),
  };
}

export function startServer(app: ServerApp, opts: { port: number }): RunningServer {
  let hosts: ReadonlySet<string> = new Set();
  const handler = createApiHandler(depsFromApp(app), {
    allowedHosts: () => hosts,
    logError: (message, error) => {
      process.stderr.write(`${message}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    },
  });

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port,
    development: false,
    routes: {
      '/api/*': handler,
      '/*': index,
    },
  });
  const port = server.port ?? opts.port;
  hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stop: () => {
      server.stop(true);
    },
  };
}
