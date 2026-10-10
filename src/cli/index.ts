import { createApp, type App } from '../app';
import { CliError, parseCli } from './args';
import {
  runIngestCmd, runInsightsCmd, runPrices, runReport, runServe, runStatus, type Deps, type Output, type ServerModule,
} from './commands';

export const HELP = `AI Agent Usage - token usage and estimated cost across your coding agents

usage: agent-usage <command> [options]

commands
  serve      start the dashboard (ingests first, then every 2s)  --port 4317 --no-ingest --no-watch
  ingest     read all installed agents into the database
  prices     refresh the AWS public price list           --force
  status     adapters, price snapshot, unpriced models
  report     usage table                                 --by day|week|model|agent|session
  insights   patterns worth knowing about

filters (report, insights)
  --since 7d|36h|2w|YYYY-MM-DD   --until now|YYYY-MM-DD   --agent a,b   --model m1,m2
  --no-subagents   --tz Europe/Berlin   --limit N (sessions)   --json
`;

const stdout: Output = {
  write: (t) => void process.stdout.write(t),
  error: (t) => void process.stderr.write(t),
};

export const defaultDeps: Deps = {
  now: Date.now,
  loadServer: async () => {
    const spec = '../server/index';
    return (await import(spec)) as ServerModule;
  },
  waitForExit: () =>
    new Promise<void>((resolve) => {
      process.once('SIGINT', () => resolve());
      process.once('SIGTERM', () => resolve());
    }),
  setInterval: (fn, ms) => {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
};

export interface MainOptions {
  out?: Output;
  deps?: Partial<Deps>;
  /** Injected in tests; defaults to the real app on the default database. */
  makeApp?: () => Promise<App>;
}

export async function main(argv: readonly string[], opts: MainOptions = {}): Promise<number> {
  const out = opts.out ?? stdout;
  const deps: Deps = { ...defaultDeps, ...opts.deps };
  let args;
  try {
    args = parseCli(argv);
  } catch (error: unknown) {
    if (!(error instanceof CliError)) throw error;
    out.error(`error: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (args.command === 'help') {
    out.write(HELP);
    return 0;
  }

  const app = await (opts.makeApp ?? (() => createApp()))();
  try {
    switch (args.command) {
      case 'serve': return await runServe(app, args, out, deps);
      case 'ingest': return await runIngestCmd(app, args, out);
      case 'prices': return await runPrices(app, args, out);
      case 'status': return await runStatus(app, args, out);
      case 'report': return await runReport(app, args, out, deps);
      case 'insights': return await runInsightsCmd(app, args, out, deps);
    }
  } catch (error: unknown) {
    if (!(error instanceof CliError)) throw error;
    out.error(`error: ${error.message}\n`);
    return 2;
  } finally {
    app.close();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.exit(1);
    },
  );
}
