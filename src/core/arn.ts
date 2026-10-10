import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ExecResult {
  stdout: string;
  code: number;
}
/** `env` entries set to undefined are removed from the child environment. */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string | undefined> },
) => Promise<ExecResult>;

const EXEC_TIMEOUT_MS = 15_000;
const FAILURE_RETRY_MS = 3600 * 1000;
/** Static credentials in the environment override --profile; they must not leak into profile lookups. */
const STATIC_CREDENTIAL_VARS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'] as const;

export const defaultExec: ExecFn = async (cmd, args, opts) => {
  const env: Record<string, string> = {};
  const merged = { ...process.env, ...(opts?.env ?? {}) };
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) env[k] = v;
  try {
    const proc = Bun.spawn([cmd, ...args], { env, stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
    const timer = setTimeout(() => proc.kill(), EXEC_TIMEOUT_MS);
    const stdout = await new Response(proc.stdout).text();
    const code = await proc.exited;
    clearTimeout(timer);
    return { stdout, code };
  } catch {
    return { stdout: '', code: 127 };
  }
};

export interface ParsedArn {
  region: string;
  account: string;
  /** Last path segment: the profile id (or a system profile name like us.anthropic.claude-...). */
  id: string;
}

const PROFILE_ARN = /^arn:aws[a-z-]*:bedrock:([a-z0-9-]+):(\d*):(?:application-)?inference-profile\/(.+)$/;

export function parseProfileArn(raw: string): ParsedArn | null {
  const m = PROFILE_ARN.exec(raw.trim());
  return m && m[1] && m[3] ? { region: m[1], account: m[2] ?? '', id: m[3] } : null;
}

export function isProfileArn(raw: string): boolean {
  return parseProfileArn(raw) !== null;
}

/** "arn:...:foundation-model/anthropic.claude-sonnet-5-v1:0" -> "anthropic.claude-sonnet-5-v1:0" */
function modelIdFromArn(modelArn: string): string | null {
  const i = modelArn.indexOf('foundation-model/');
  return i === -1 ? null : modelArn.slice(i + 'foundation-model/'.length) || null;
}

const SAFE_ENV: Record<string, string | undefined> = { AWS_PAGER: '', AWS_EC2_METADATA_DISABLED: 'true' };

/** Env for an explicit profile: static credentials in the ambient environment would override it. */
function profileEnv(profile: string | undefined): Record<string, string | undefined> {
  const env = { ...SAFE_ENV };
  if (profile) for (const v of STATIC_CREDENTIAL_VARS) env[v] = undefined;
  return env;
}

async function lookupProfileModel(
  arn: ParsedArn,
  fullArn: string,
  exec: ExecFn,
  profile?: string,
): Promise<{ modelId: string | null; error?: string }> {
  const args = [
    'bedrock', 'get-inference-profile',
    '--inference-profile-identifier', fullArn,
    '--region', arn.region,
    '--output', 'json',
    ...(profile ? ['--profile', profile] : []),
  ];
  const res = await exec('aws', args, { env: profileEnv(profile) });
  if (res.code !== 0) return { modelId: null, error: `aws exited with ${res.code}` };
  try {
    const parsed = JSON.parse(res.stdout) as { models?: Array<{ modelArn?: string }> };
    const first = parsed.models?.map((m) => (m.modelArn ? modelIdFromArn(m.modelArn) : null)).find((x) => x);
    return first ? { modelId: first } : { modelId: null, error: 'profile has no models' };
  } catch {
    return { modelId: null, error: 'unparseable aws output' };
  }
}

// ---- profile discovery -----------------------------------------------------------------------

/** Profile names from ~/.aws/credentials ([name]) and ~/.aws/config ([profile name] / [default]). */
export function listAwsProfiles(home: string, env: Record<string, string | undefined> = process.env): string[] {
  const files = [
    env.AWS_SHARED_CREDENTIALS_FILE ?? join(home, '.aws', 'credentials'),
    env.AWS_CONFIG_FILE ?? join(home, '.aws', 'config'),
  ];
  const names: string[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    let text = '';
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const m = /^\s*\[\s*([^\]]+?)\s*\]/.exec(line);
      if (!m || !m[1]) continue;
      const header = m[1];
      if (/^(sso-session|services)\s/.test(header)) continue;
      const name = header.replace(/^profile\s+/, '');
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/** Order: explicit hint, AWS_PROFILE, then `default` (when they exist), then everything else. */
export function candidateProfiles(
  home: string,
  env: Record<string, string | undefined>,
  hint?: string,
): string[] {
  const known = listAwsProfiles(home, env);
  const ordered = [hint, env.AWS_PROFILE, ...['default'].filter((p) => known.includes(p)), ...known];
  return [...new Set(ordered.filter((p): p is string => !!p))];
}

const ACCOUNT_OK_TTL_MS = 7 * 24 * 3600 * 1000;
const ACCOUNT_FAIL_TTL_MS = 3600 * 1000;
const CONCURRENCY = 4;
interface AccountEntry {
  account: string | null;
  at: number;
}
const accountMemo = new WeakMap<Database, Map<string, AccountEntry>>();
const fresh = (e: AccountEntry, now: number): boolean => now - e.at < (e.account ? ACCOUNT_OK_TTL_MS : ACCOUNT_FAIL_TTL_MS);

/** Account id behind a profile via sts, cached in memory and in kv (success 7d, failure 1h). */
async function accountOf(db: Database, profile: string, region: string, exec: ExecFn, now: number): Promise<string | null> {
  let memo = accountMemo.get(db);
  if (!memo) accountMemo.set(db, (memo = new Map()));
  const remembered = memo.get(profile);
  if (remembered && fresh(remembered, now)) return remembered.account;

  const key = `aws.account.${profile}`;
  const row = db.query('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | null;
  if (row) {
    try {
      const c = JSON.parse(row.value) as AccountEntry;
      if (fresh(c, now)) {
        memo.set(profile, c);
        return c.account;
      }
    } catch {
      // fall through and ask sts again
    }
  }

  const res = await exec('aws', ['sts', 'get-caller-identity', '--profile', profile, '--region', region, '--output', 'json'], {
    env: profileEnv(profile),
  });
  let account: string | null = null;
  if (res.code === 0) {
    try {
      account = (JSON.parse(res.stdout) as { Account?: string }).Account ?? null;
    } catch {
      account = null;
    }
  }
  const entry: AccountEntry = { account, at: now };
  memo.set(profile, entry);
  db.query('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(entry),
  );
  return account;
}

export interface ArnResolveOptions {
  exec: ExecFn;
  now: number;
  /** Profile the agent itself used, if it said so. Tried first, without the account pre-check. */
  awsProfile?: string;
  home?: string;
  env?: Record<string, string | undefined>;
}

function cacheResult(db: Database, raw: string, modelId: string | null, now: number, error?: string): void {
  db.query(
    `INSERT INTO arn_cache (arn, model_raw, resolved_at, error) VALUES (?, ?, ?, ?)
     ON CONFLICT(arn) DO UPDATE SET model_raw = excluded.model_raw, resolved_at = excluded.resolved_at, error = excluded.error`,
  ).run(raw, modelId, now, error ?? null);
}

/**
 * Resolves an inference-profile ARN to the underlying model id, fully automatically:
 *  1. system profile ARNs already carry the model id (no AWS call);
 *  2. the agent's own profile hint, if any;
 *  3. every local AWS profile whose account (via sts get-caller-identity) equals the ARN's account,
 *     ordered AWS_PROFILE, default, rest;
 *  4. as a last resort the ambient credentials.
 * Static credentials in the environment are stripped whenever a profile is passed explicitly.
 * Successes are cached forever; failures are cached with a reason and retried after 1h.
 * Never throws: no aws CLI / expired credentials / deleted profile simply yields null.
 */
export async function resolveArn(db: Database, raw: string, opts: ArnResolveOptions): Promise<string | null> {
  const arn = parseProfileArn(raw);
  if (!arn) return null;
  if (/^[a-z-]+\.[a-z0-9]+\./.test(arn.id)) return arn.id;

  const cached = db
    .query('SELECT model_raw, resolved_at FROM arn_cache WHERE arn = ?')
    .get(raw) as { model_raw: string | null; resolved_at: number } | null;
  if (cached?.model_raw) return cached.model_raw;
  if (cached && opts.now - cached.resolved_at < FAILURE_RETRY_MS) return null;

  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const candidates = candidateProfiles(home, env, opts.awsProfile);
  let lastError = 'no AWS credentials available';
  const attempted: string[] = [];

  const attempt = async (profile: string | undefined): Promise<string | null> => {
    const r = await lookupProfileModel(arn, raw, opts.exec, profile);
    if (r.modelId) {
      cacheResult(db, raw, r.modelId, opts.now);
      return r.modelId;
    }
    lastError = `${profile ? `profile ${profile}` : 'ambient credentials'}: ${r.error ?? 'failed'}`;
    return null;
  };

  if (opts.awsProfile) {
    attempted.push(opts.awsProfile);
    const hit = await attempt(opts.awsProfile);
    if (hit) return hit;
  }

  const rest = candidates.filter((p) => p !== opts.awsProfile);
  for (let i = 0; i < rest.length; i += CONCURRENCY) {
    const chunk = rest.slice(i, i + CONCURRENCY);
    const accounts = await Promise.all(chunk.map((p) => accountOf(db, p, arn.region, opts.exec, opts.now)));
    for (let j = 0; j < chunk.length; j++) {
      if (!arn.account || accounts[j] !== arn.account) continue;
      attempted.push(chunk[j] as string);
      const hit = await attempt(chunk[j] as string);
      if (hit) return hit;
    }
  }

  if (attempted.length === 0) {
    const noMatch = `no AWS profile with working credentials for account ${arn.account || '?'} (checked ${rest.length} profile${rest.length === 1 ? '' : 's'})`;
    const hit = await attempt(undefined);
    if (hit) return hit;
    lastError = `${noMatch}; ${lastError}`;
  }
  cacheResult(db, raw, null, opts.now, lastError);
  return null;
}

/** ARNs that could not be resolved, with the reason; for the status page. */
export function arnResolutionFailures(db: Database): Array<{ arn: string; reason: string }> {
  return (
    db.query('SELECT arn, error FROM arn_cache WHERE model_raw IS NULL ORDER BY arn').all() as Array<{ arn: string; error: string | null }>
  ).map((r) => ({ arn: r.arn, reason: r.error ?? 'unresolved' }));
}
