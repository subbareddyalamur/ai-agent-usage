import { parseArgs } from 'node:util';
import type { Filters } from '../core/api-types';
import { addDays, localDate, resolveTz, zonedMidnight } from '../core/query-time';

export class CliError extends Error {}

export const COMMANDS = ['serve', 'ingest', 'prices', 'status', 'report', 'insights', 'help'] as const;
export type Command = (typeof COMMANDS)[number];
export const REPORT_BY = ['day', 'week', 'model', 'agent', 'session'] as const;
export type ReportBy = (typeof REPORT_BY)[number];

export interface CliArgs {
  command: Command;
  since?: string;
  until?: string;
  agents: string[];
  models: string[];
  by: ReportBy;
  json: boolean;
  noSubagents: boolean;
  port: number;
  noIngest: boolean;
  watch: boolean;
  force: boolean;
  limit: number;
  tz?: string;
}

const split = (v: string | undefined): string[] => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export function parseCli(argv: readonly string[]): CliArgs {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        since: { type: 'string' },
        until: { type: 'string' },
        agent: { type: 'string' },
        model: { type: 'string' },
        by: { type: 'string' },
        json: { type: 'boolean' },
        'no-subagents': { type: 'boolean' },
        port: { type: 'string' },
        'no-ingest': { type: 'boolean' },
        watch: { type: 'boolean' },
        'no-watch': { type: 'boolean' },
        force: { type: 'boolean' },
        limit: { type: 'string' },
        tz: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error: unknown) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  const v = parsed.values as Record<string, string | boolean | undefined>;
  const word = parsed.positionals[0];
  const command: Command = v.help || !word ? 'help' : (COMMANDS as readonly string[]).includes(word) ? (word as Command) : fail(`unknown command: ${word}`);
  if (parsed.positionals.length > 1) fail(`unexpected argument: ${parsed.positionals[1]}`);

  const by = (v.by as string | undefined) ?? 'day';
  if (!(REPORT_BY as readonly string[]).includes(by)) fail(`--by must be one of ${REPORT_BY.join('|')}`);
  const port = Number(v.port ?? 4317);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail('--port must be 0-65535');
  const limit = Number(v.limit ?? 20);
  if (!Number.isInteger(limit) || limit < 1) fail('--limit must be a positive integer');

  return {
    command,
    since: v.since as string | undefined,
    until: v.until as string | undefined,
    agents: split(v.agent as string | undefined),
    models: split(v.model as string | undefined),
    by: by as ReportBy,
    json: v.json === true,
    noSubagents: v['no-subagents'] === true,
    port,
    noIngest: v['no-ingest'] === true,
    // serve watches by default; --watch is accepted as a no-op alias, --no-watch turns it off.
    watch: v['no-watch'] !== true,
    force: v.force === true,
    limit,
    tz: v.tz as string | undefined,
  };
}

function fail(message: string): never {
  throw new CliError(message);
}

const UNIT_MS: Record<string, number> = { h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REL = /^(\d+)([hdw])$/;

/** "7d" / "36h" / "2w" (that long ago) or YYYY-MM-DD (start of that local day). */
export function parseSince(value: string, now: number, tz: string): number {
  const rel = REL.exec(value);
  if (rel) return now - Number(rel[1]) * (UNIT_MS[rel[2] as string] as number);
  if (DATE.test(value)) return zonedMidnight(value, tz);
  return fail(`invalid --since "${value}" (use 7d, 36h, 2w or YYYY-MM-DD)`);
}

/** Same forms as --since, but a date means the END of that local day, and "now" is allowed. */
export function parseUntil(value: string, now: number, tz: string): number {
  if (value === 'now') return now;
  const rel = REL.exec(value);
  if (rel) return now - Number(rel[1]) * (UNIT_MS[rel[2] as string] as number);
  if (DATE.test(value)) return zonedMidnight(addDays(value, 1), tz) - 1;
  return fail(`invalid --until "${value}" (use now, 7d, 36h, 2w or YYYY-MM-DD)`);
}

export function filtersFromArgs(args: CliArgs, now: number = Date.now()): Filters {
  const tz = resolveTz(args.tz);
  const from = args.since ? parseSince(args.since, now, tz) : undefined;
  const to = args.until ? parseUntil(args.until, now, tz) : undefined;
  if (from !== undefined && to !== undefined && from > to) fail('--since is after --until');
  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(args.agents.length ? { agents: args.agents } : {}),
    ...(args.models.length ? { models: args.models } : {}),
    ...(args.noSubagents ? { includeSubagents: false } : {}),
    tz,
  };
}

export const today = (now: number, tz: string): string => localDate(now, tz);
