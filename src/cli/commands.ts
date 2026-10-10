import type { App } from '../app';
import type { Filters, SeriesPoint, Totals } from '../core/api-types';
import { runInsightsDetailed } from '../insights';
import { series, sessions, status, summary, localDate, resolveTz } from '../core/query';
import { fmtBytes } from '../insights/kit';
import { fmtCost, fmtHit, fmtTokens, renderTable, truncate, type Align } from './format';
import { filtersFromArgs, type CliArgs } from './args';

export interface Output {
  write(text: string): void;
  error(text: string): void;
}

export interface ServerModule {
  startServer(app: App, opts: { port: number }): { url: string; stop(): void };
}

export interface Deps {
  now: () => number;
  loadServer: () => Promise<ServerModule>;
  /** Resolves when the process should exit (signal); injectable for tests. */
  waitForExit: () => Promise<void>;
  setInterval: (fn: () => void, ms: number) => () => void;
}

export const WATCH_INTERVAL_MS = 2_000;
/** The same watch error is logged at most this often; a different error or a recovery is logged immediately. */
export const WATCH_ERROR_REPEAT_MS = 60_000;

const line = (out: Output, text = ''): void => out.write(`${text}\n`);
const json = (out: Output, value: unknown): void => line(out, JSON.stringify(value, null, 2));

function totalsRow(label: string, t: Totals): string[] {
  return [label, fmtTokens(t.inputTokens), fmtTokens(t.outputTokens + t.reasoningTokens), fmtTokens(t.cacheReadTokens), fmtTokens(t.cacheWriteTokens), fmtHit(t.cacheHitRatio), fmtCost(t.costUsd)];
}

const TOTAL_HEADERS = ['input', 'output', 'cache read', 'cache write', 'cache hit', 'cost'];
const TOTAL_ALIGN: Align[] = ['r', 'r', 'r', 'r', 'r', 'r'];

function footer(app: App, t: Totals): string[] {
  const out: string[] = [];
  if (t.unpricedEvents > 0) {
    out.push(`unpriced: ${t.unpricedEvents} events, ${fmtTokens(t.unpricedTokens)} tokens are not included in cost (model has no known price)`);
  }
  const at = status(app.db, app.dbPath).pricing.latestSnapshotAt;
  out.push(`costs are estimates from AWS public list prices${at ? ` (snapshot ${new Date(at).toISOString().slice(0, 10)})` : ' (no price snapshot yet: run "prices")'}`);
  return out;
}

function foldBuckets(points: readonly SeriesPoint[]): Map<string, SeriesPoint> {
  const m = new Map<string, SeriesPoint>();
  for (const p of points) {
    const a = m.get(p.bucket);
    m.set(p.bucket, {
      bucket: p.bucket, key: '',
      costUsd: (a?.costUsd ?? 0) + p.costUsd, inputTokens: (a?.inputTokens ?? 0) + p.inputTokens,
      outputTokens: (a?.outputTokens ?? 0) + p.outputTokens, cacheReadTokens: (a?.cacheReadTokens ?? 0) + p.cacheReadTokens,
      cacheWriteTokens: (a?.cacheWriteTokens ?? 0) + p.cacheWriteTokens,
    });
  }
  return m;
}

export async function runReport(app: App, args: CliArgs, out: Output, deps: Deps): Promise<number> {
  const f: Filters = filtersFromArgs(args, deps.now());
  const sum = summary(app.db, f);
  const t = sum.totals;
  if (t.events === 0) {
    if (args.json) json(out, { by: args.by, rows: [], totals: t });
    else line(out, 'No usage found for this selection. Run "ingest" first, or widen --since/--agent/--model.');
    return 0;
  }

  const tz = resolveTz(args.tz);
  let headers: string[];
  let align: Align[];
  let rows: string[][];
  let raw: unknown;
  switch (args.by) {
    case 'day':
    case 'week': {
      const pts = [...foldBuckets(series(app.db, f, args.by, 'agent')).values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
      raw = pts;
      headers = [args.by, ...TOTAL_HEADERS];
      align = ['l', ...TOTAL_ALIGN];
      rows = pts.map((p) => [p.bucket, fmtTokens(p.inputTokens), fmtTokens(p.outputTokens), fmtTokens(p.cacheReadTokens), fmtTokens(p.cacheWriteTokens),
        fmtHit(p.inputTokens + p.cacheReadTokens + p.cacheWriteTokens > 0 ? p.cacheReadTokens / (p.inputTokens + p.cacheReadTokens + p.cacheWriteTokens) : null), fmtCost(p.costUsd)]);
      break;
    }
    case 'model':
      raw = sum.byModel;
      headers = ['model', ...TOTAL_HEADERS];
      align = ['l', ...TOTAL_ALIGN];
      rows = sum.byModel.map((m) => totalsRow(m.priced ? m.model : `${m.model} *`, m));
      break;
    case 'agent':
      raw = sum.byAgent;
      headers = ['agent', ...TOTAL_HEADERS];
      align = ['l', ...TOTAL_ALIGN];
      rows = sum.byAgent.map((a) => totalsRow(a.agent, a));
      break;
    case 'session': {
      const { rows: ss } = sessions(app.db, f, { sort: 'cost', limit: args.limit });
      raw = ss;
      headers = ['agent', 'session', 'last', 'steps', 'peak ctx', 'cache hit', 'cost'];
      align = ['l', 'l', 'l', 'r', 'r', 'r', 'r'];
      rows = ss.map((s) => [s.agent, truncate(s.title ?? s.sessionId, 34), localDate(s.lastTs, tz), s.totalOnly ? '-' : String(s.steps),
        s.totalOnly ? '-' : fmtTokens(s.peakContext), fmtHit(s.totals.cacheHitRatio), fmtCost(s.totals.costUsd)]);
      break;
    }
  }

  if (args.json) {
    json(out, { by: args.by, rows: raw, totals: t });
    return 0;
  }
  line(out, renderTable(headers, rows, align));
  line(out);
  line(out, renderTable(['total', ...TOTAL_HEADERS], [totalsRow(`${t.events} events, ${t.sessions} sessions`, t)], ['l', ...TOTAL_ALIGN]));
  line(out);
  for (const note of footer(app, t)) line(out, note);
  return 0;
}

export async function runStatus(app: App, args: CliArgs, out: Output): Promise<number> {
  const s = status(app.db, app.dbPath);
  if (args.json) {
    json(out, s);
    return 0;
  }
  const d = (ts: number | null): string => (ts === null ? '-' : new Date(ts).toISOString().slice(0, 10));
  line(out, renderTable(['agent', 'state', 'events', 'first', 'last', 'note'],
    s.adapters.map((a) => [a.id, a.installed ? 'installed' : 'not installed', String(a.events), d(a.firstTs), d(a.lastTs), a.error ? `error: ${truncate(a.error, 60)}` : a.installed ? '' : 'history kept']),
    ['l', 'l', 'r', 'l', 'l', 'l']));
  line(out);
  const p = s.pricing;
  line(out, `prices: ${p.latestSnapshotAt ? `snapshot ${d(p.latestSnapshotAt)}, ${p.modelsPriced} models, ${p.snapshots} snapshot(s)${p.stale ? ', STALE (run "prices")' : ''}` : 'none yet (run "prices")'}`);
  if (s.unmappedModels.length) {
    const shown = s.unmappedModels.slice(0, 8).map((m) => `${truncate(m.raw, 48)} (${fmtTokens(m.tokens)} tokens)`);
    const more = s.unmappedModels.length - shown.length;
    line(out, `unpriced models: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}`);
  }
  if (app.problems.length) line(out, `adapter problems: ${app.problems.join('; ')}`);
  line(out, `db: ${s.db.path} (${fmtBytes(s.db.sizeBytes)})`);
  return 0;
}

export async function runInsightsCmd(app: App, args: CliArgs, out: Output, deps: Deps): Promise<number> {
  const { findings, problems } = runInsightsDetailed(app.db, filtersFromArgs(args, deps.now()));
  if (args.json) {
    json(out, { findings, problems });
    return 0;
  }
  if (findings.length === 0) line(out, 'No findings for this selection.');
  for (const f of findings) {
    line(out, `[${f.severity.toUpperCase()}] ${f.title}${f.estSavingsUsd ? `  (${fmtCost(f.estSavingsUsd)} avoidable)` : ''}`);
    line(out, `  ${f.detail}`);
    for (const e of f.evidence.slice(0, 5)) line(out, `  - ${e.label}`);
    line(out);
  }
  for (const p of problems) out.error(`insight rule failed: ${p}\n`);
  return 0;
}

export async function runIngestCmd(app: App, args: CliArgs, out: Output): Promise<number> {
  const res = await app.ingestAll();
  if (args.json) {
    json(out, res);
    return 0;
  }
  for (const r of res.reports) {
    line(out, `${r.id}: ${r.installed ? `${r.events} events${r.error ? ` (error: ${r.error})` : ''}` : 'not installed, skipped'}`);
  }
  line(out, `prices: ${res.priceRefresh.error ? `refresh failed (${res.priceRefresh.error}), using last snapshot` : res.priceRefresh.refreshed ? 'refreshed' : 'up to date'}`);
  if (res.repriced > 0) line(out, `${res.repriced} previously unpriced events now have a cost`);
  return res.reports.some((r) => r.error) ? 1 : 0;
}

export async function runPrices(app: App, args: CliArgs, out: Output): Promise<number> {
  const r = await app.pricing.refreshIfStale({ force: args.force });
  if (args.json) {
    json(out, r);
    return r.error ? 1 : 0;
  }
  line(out, r.error ? `price refresh failed: ${r.error} (last snapshot kept)` : r.refreshed ? `prices refreshed${r.snapshotId ? ` (snapshot ${r.snapshotId})` : ''}` : 'prices are up to date (use --force to refetch)');
  return r.error ? 1 : 0;
}

/** One watch tick: re-ingest, never throw, and keep the log quiet while the same failure repeats. */
export function watchTick(app: App, out: Output, now: () => number): () => void {
  let lastMessage: string | null = null;
  let lastLoggedAt = 0;
  let suppressed = 0;
  return () => {
    app.ingestAll().then(
      () => {
        if (lastMessage !== null) {
          out.error(`ingest recovered${suppressed > 0 ? ` (${suppressed} repeats suppressed)` : ''}\n`);
          lastMessage = null;
          suppressed = 0;
        }
      },
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        const t = now();
        if (message === lastMessage && t - lastLoggedAt < WATCH_ERROR_REPEAT_MS) {
          suppressed++;
          return;
        }
        out.error(`ingest failed: ${message}${suppressed > 0 ? ` (${suppressed} repeats suppressed)` : ''}\n`);
        lastMessage = message;
        lastLoggedAt = t;
        suppressed = 0;
      },
    );
  };
}

export async function runServe(app: App, args: CliArgs, out: Output, deps: Deps): Promise<number> {
  if (!args.noIngest) {
    const res = await app.ingestAll();
    line(out, `ingested ${res.reports.reduce((n, r) => n + r.events, 0)} events from ${res.reports.filter((r) => r.installed).length} agent(s)`);
  }
  const { startServer } = await deps.loadServer();
  const server = startServer(app, { port: args.port });
  line(out, `AI Agent Usage dashboard: ${server.url}`);
  const cancel = args.watch ? deps.setInterval(watchTick(app, out, deps.now), WATCH_INTERVAL_MS) : () => {};
  await deps.waitForExit();
  cancel();
  server.stop();
  return 0;
}
