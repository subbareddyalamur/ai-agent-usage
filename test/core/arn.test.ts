import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  arnResolutionFailures, candidateProfiles, defaultExec, isProfileArn, listAwsProfiles, parseProfileArn, resolveArn, type ExecFn,
} from '../../src/core/arn';
import { openDb } from '../../src/core/db';

const ACCOUNT = '111122223333';
const AIP = `arn:aws:bedrock:us-east-1:${ACCOUNT}:application-inference-profile/abcd1234efgh`;
const AIP2 = `arn:aws:bedrock:us-east-1:${ACCOUNT}:application-inference-profile/zzzzzzzzzzzz`;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const FOUNDATION = (id: string): string => JSON.stringify({ models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${id}` }] });

function homeWith(files: { config?: string; credentials?: string }): string {
  const home = mkdtempSync(join(tmpdir(), 'aws-home-'));
  mkdirSync(join(home, '.aws'));
  if (files.config !== undefined) writeFileSync(join(home, '.aws', 'config'), files.config);
  if (files.credentials !== undefined) writeFileSync(join(home, '.aws', 'credentials'), files.credentials);
  return home;
}

const CONFIG = `
# comment
[default]
region = us-east-1

[profile dev]
region = us-east-1

[profile work]
region = us-east-1

[sso-session corp]
sso_start_url = x

[services s3]
x = y

[profile work-2]
`;
const CREDENTIALS = `[work]\naws_access_key_id = x\n[prod]\naws_access_key_id = y\n[default]\nz = 1\n`;

interface Call { cmd: string; args: string[]; env?: Record<string, string | undefined> }

/** Fake aws CLI. `accounts`: profile -> account for sts. `models`: profile -> model id get-inference-profile returns. */
function fakeAws(spec: { accounts: Record<string, string>; models: Record<string, string>; ambientModel?: string }): { exec: ExecFn; calls: Call[]; lookups: string[]; sts: string[] } {
  const calls: Call[] = [];
  const lookups: string[] = [];
  const sts: string[] = [];
  const exec: ExecFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    const profile = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : undefined;
    if (args[0] === 'sts') {
      sts.push(profile ?? '');
      const account = profile ? spec.accounts[profile] : undefined;
      return account ? { stdout: JSON.stringify({ Account: account }), code: 0 } : { stdout: '', code: 254 };
    }
    lookups.push(profile ?? '(ambient)');
    const model = profile ? spec.models[profile] : spec.ambientModel;
    return model ? { stdout: FOUNDATION(model), code: 0 } : { stdout: '', code: 254 };
  };
  return { exec, calls, lookups, sts };
}

const STALE_ENV = { AWS_PROFILE: 'dev', AWS_ACCESS_KEY_ID: 'ASIASTALE', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't' };

describe('parseProfileArn', () => {
  test('application and system profile arns', () => {
    expect(parseProfileArn(AIP)).toEqual({ region: 'us-east-1', account: ACCOUNT, id: 'abcd1234efgh' });
    expect(parseProfileArn('arn:aws:bedrock:us-west-2:123:inference-profile/us.anthropic.claude-sonnet-5')).toEqual({
      region: 'us-west-2', account: '123', id: 'us.anthropic.claude-sonnet-5',
    });
  });
  test('non-profile strings', () => {
    expect(parseProfileArn('claude-sonnet-5')).toBeNull();
    expect(parseProfileArn('arn:aws:s3:::bucket')).toBeNull();
    expect(isProfileArn(AIP)).toBe(true);
    expect(isProfileArn('us.anthropic.claude-sonnet-5')).toBe(false);
  });
});

describe('profile discovery', () => {
  test('reads [name] from credentials and [profile name]/[default] from config, skipping sso-session and services', () => {
    const home = homeWith({ config: CONFIG, credentials: CREDENTIALS });
    expect(listAwsProfiles(home, {})).toEqual(['work', 'prod', 'default', 'dev', 'work-2']);
  });

  test('missing or unreadable files yield nothing; env overrides the file locations', () => {
    expect(listAwsProfiles(mkdtempSync(join(tmpdir(), 'empty-')), {})).toEqual([]);
    const custom = join(homeWith({ config: '[profile only-here]\n' }), '.aws', 'config');
    expect(listAwsProfiles('/nonexistent', { AWS_CONFIG_FILE: custom, AWS_SHARED_CREDENTIALS_FILE: '/nonexistent/x' })).toEqual(['only-here']);
    const dirAsFile = homeWith({}); // a directory where a file is expected
    expect(listAwsProfiles('/nonexistent', { AWS_CONFIG_FILE: join(dirAsFile, '.aws') })).toEqual([]);
  });

  test('order: hint, AWS_PROFILE, default, then the rest, without duplicates', () => {
    const home = homeWith({ config: CONFIG, credentials: CREDENTIALS });
    expect(candidateProfiles(home, { AWS_PROFILE: 'dev' }, 'prod')).toEqual(['prod', 'dev', 'default', 'work', 'work-2']);
    expect(candidateProfiles(home, {})).toEqual(['default', 'work', 'prod', 'dev', 'work-2']);
  });

  test('work/default are only tried when they actually exist', () => {
    const home = homeWith({ credentials: '[prod]\n' });
    expect(candidateProfiles(home, {})).toEqual(['prod']);
    expect(candidateProfiles(home, { AWS_PROFILE: 'ghost' })).toEqual(['ghost', 'prod']);
  });
});

describe('resolveArn without a profile hint', () => {
  const home = (): string => homeWith({ config: CONFIG, credentials: CREDENTIALS });

  test('finds the profile whose account matches, ignoring stale ambient credentials and the wrong AWS_PROFILE', async () => {
    const db = openDb(':memory:');
    const aws = fakeAws({
      accounts: { dev: '111111111111', work: ACCOUNT, default: '222222222222', prod: '333333333333', 'work-2': '444444444444' },
      models: { work: 'anthropic.claude-sonnet-5-v1:0' },
    });
    const id = await resolveArn(db, AIP, { exec: aws.exec, now: 0, home: home(), env: STALE_ENV });
    expect(id).toBe('anthropic.claude-sonnet-5-v1:0');
    expect(aws.lookups).toEqual(['work']); // only the matching account is ever used for the lookup
    expect(new Set(aws.sts)).toEqual(new Set(['dev', 'work', 'default', 'prod'])); // probes stop once a lookup succeeded

    const lookup = aws.calls.find((c) => c.args[0] === 'bedrock');
    expect(lookup?.args).toContain('--profile');
    expect(lookup?.env).toMatchObject({ AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined });
    for (const c of aws.calls.filter((x) => x.args[0] === 'sts')) {
      expect('AWS_ACCESS_KEY_ID' in (c.env ?? {})).toBe(true); // explicitly removed
    }
  });

  test('success is cached forever: no further aws calls', async () => {
    const db = openDb(':memory:');
    const aws = fakeAws({ accounts: { work: ACCOUNT }, models: { work: 'anthropic.claude-sonnet-5-v1:0' } });
    await resolveArn(db, AIP, { exec: aws.exec, now: 0, home: home(), env: {} });
    const before = aws.calls.length;
    expect(await resolveArn(db, AIP, { exec: aws.exec, now: 1000 * DAY, home: home(), env: {} })).toBe('anthropic.claude-sonnet-5-v1:0');
    expect(aws.calls.length).toBe(before);
  });

  test('stops at the first working profile among several for the same account', async () => {
    const db = openDb(':memory:');
    const aws = fakeAws({
      accounts: { work: ACCOUNT, default: ACCOUNT, dev: ACCOUNT },
      models: { work: 'anthropic.claude-opus-5-v1:0', default: 'anthropic.claude-sonnet-5-v1:0' },
    });
    expect(await resolveArn(db, AIP, { exec: aws.exec, now: 0, home: home(), env: {} })).toBe('anthropic.claude-sonnet-5-v1:0');
    expect(aws.lookups).toEqual(['default']);
  });

  test('moves on to the next matching profile when the first lookup fails', async () => {
    const db = openDb(':memory:');
    const aws = fakeAws({ accounts: { work: ACCOUNT, default: ACCOUNT }, models: { work: 'anthropic.claude-haiku-5-5-v1:0' } });
    expect(await resolveArn(db, AIP, { exec: aws.exec, now: 0, home: home(), env: {} })).toBe('anthropic.claude-haiku-5-5-v1:0');
    expect(aws.lookups).toEqual(['default', 'work']);
  });

  test('an explicit hint is tried first without an sts pre-check, then discovery takes over', async () => {
    const db = openDb(':memory:');
    const aws = fakeAws({ accounts: { work: ACCOUNT }, models: { work: 'anthropic.claude-sonnet-5-v1:0' } });
    expect(await resolveArn(db, AIP, { exec: aws.exec, now: 0, home: home(), env: {}, awsProfile: 'prod' })).toBe('anthropic.claude-sonnet-5-v1:0');
    expect(aws.lookups).toEqual(['prod', 'work']);
    expect(aws.sts).not.toContain('prod');
  });

  test('sts results persist in kv, so a new process does not re-probe profiles', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kv-')), 'u.db');
    const first = fakeAws({ accounts: { work: ACCOUNT }, models: {} });
    const db1 = openDb(path);
    await resolveArn(db1, AIP, { exec: first.exec, now: 0, home: home(), env: {} });
    expect(first.sts.length).toBeGreaterThan(0);
    db1.close();

    const second = fakeAws({ accounts: { work: ACCOUNT }, models: { work: 'anthropic.claude-sonnet-5-v1:0' } });
    const db2 = openDb(path);
    // 30 minutes later: the failure for AIP is still remembered, so use a different ARN to force a fresh attempt
    expect(await resolveArn(db2, AIP2, { exec: second.exec, now: 30 * 60 * 1000, home: home(), env: {} })).toBe('anthropic.claude-sonnet-5-v1:0');
    expect(second.sts).toEqual([]); // accounts came from kv
    expect(second.lookups).toEqual(['work']);
  });

  test('sts failures are cached for an hour, successes for a week', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'kv-')), 'u.db');
    const a = fakeAws({ accounts: { work: ACCOUNT }, models: {} });
    const db1 = openDb(path);
    await resolveArn(db1, AIP, { exec: a.exec, now: 0, home: home(), env: {} });
    db1.close();

    const b = fakeAws({ accounts: { work: ACCOUNT, prod: ACCOUNT }, models: { work: 'm.x-v1:0' } });
    const db2 = openDb(path);
    await resolveArn(db2, AIP2, { exec: b.exec, now: HOUR + 1, home: home(), env: {} });
    expect(new Set(b.sts)).toEqual(new Set(['default', 'prod', 'dev'])); // expired failures re-probed, work read from kv
    db2.close();

    const c = fakeAws({ accounts: { work: ACCOUNT }, models: { work: 'm.y-v1:0' } });
    const db3 = openDb(path);
    await resolveArn(db3, `arn:aws:bedrock:us-east-1:${ACCOUNT}:application-inference-profile/third`, { exec: c.exec, now: 8 * DAY, home: home(), env: {} });
    expect(c.sts).toContain('work'); // the 7 day entry expired
  });

  test('no working profile: fails quietly with a reason, retries only after an hour', async () => {
    const db = openDb(':memory:');
    const aws = fakeAws({ accounts: { dev: '111111111111' }, models: {} }); // work's credentials are expired
    const h = homeWith({ config: CONFIG });
    expect(await resolveArn(db, AIP, { exec: aws.exec, now: 0, home: h, env: STALE_ENV })).toBeNull();
    const [failure] = arnResolutionFailures(db);
    expect(failure?.arn).toBe(AIP);
    expect(failure?.reason).toContain(`no AWS profile with working credentials for account ${ACCOUNT}`);
    expect(failure?.reason).toContain('ambient credentials');

    const calls = aws.calls.length;
    expect(await resolveArn(db, AIP, { exec: aws.exec, now: HOUR - 1, home: h, env: STALE_ENV })).toBeNull();
    expect(aws.calls.length).toBe(calls);

    const fixed = fakeAws({ accounts: { work: ACCOUNT }, models: { work: 'anthropic.claude-sonnet-5-v1:0' } });
    expect(await resolveArn(db, AIP, { exec: fixed.exec, now: HOUR, home: h, env: STALE_ENV })).toBe('anthropic.claude-sonnet-5-v1:0');
    expect(arnResolutionFailures(db)).toEqual([]);
  });

  test('matching profile whose lookup fails reports that profile in the reason', async () => {
    const db = openDb(':memory:');
    const aws = fakeAws({ accounts: { work: ACCOUNT }, models: {} });
    await resolveArn(db, AIP, { exec: aws.exec, now: 0, home: home(), env: {} });
    expect(arnResolutionFailures(db)[0]?.reason).toBe('profile work: aws exited with 254');
  });

  test('no profiles anywhere: ambient credentials are the last resort', async () => {
    const db = openDb(':memory:');
    const aws = fakeAws({ accounts: {}, models: {}, ambientModel: 'anthropic.claude-sonnet-5-v1:0' });
    const empty = mkdtempSync(join(tmpdir(), 'empty-'));
    expect(await resolveArn(db, AIP, { exec: aws.exec, now: 0, home: empty, env: {} })).toBe('anthropic.claude-sonnet-5-v1:0');
    const lookup = aws.calls.find((c) => c.args[0] === 'bedrock');
    expect(lookup?.args).not.toContain('--profile');
    expect('AWS_ACCESS_KEY_ID' in (lookup?.env ?? {})).toBe(false); // ambient creds are what we want here
  });

  test('ARNs without an account never match a profile by account', async () => {
    const db = openDb(':memory:');
    const aws = fakeAws({ accounts: { work: ACCOUNT }, models: { work: 'x.y-v1:0' } });
    const arn = 'arn:aws:bedrock:us-east-1::application-inference-profile/abc';
    expect(await resolveArn(db, arn, { exec: aws.exec, now: 0, home: home(), env: {} })).toBeNull();
    expect(aws.lookups).toEqual(['(ambient)']);
  });
});

describe('resolveArn: other inputs', () => {
  test.each([
    ['garbage output', { stdout: 'not json', code: 0 }],
    ['no models', { stdout: JSON.stringify({ models: [] }), code: 0 }],
    ['non foundation-model arn', { stdout: JSON.stringify({ models: [{ modelArn: 'arn:aws:bedrock:us-east-1:1:something/else' }] }), code: 0 }],
  ])('%s resolves to null', async (_name, res) => {
    const db = openDb(':memory:');
    const exec: ExecFn = async () => res;
    const home = homeWith({});
    expect(await resolveArn(db, AIP, { exec, now: 0, home, env: {} })).toBeNull();
  });

  test('system profile arns need no aws call', async () => {
    const db = openDb(':memory:');
    const aws = fakeAws({ accounts: {}, models: {} });
    const id = await resolveArn(db, 'arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-sonnet-5', { exec: aws.exec, now: 0 });
    expect(id).toBe('us.anthropic.claude-sonnet-5');
    expect(aws.calls).toHaveLength(0);
  });

  test('non-arn input is null', async () => {
    expect(await resolveArn(openDb(':memory:'), 'claude-sonnet-5', { exec: fakeAws({ accounts: {}, models: {} }).exec, now: 0 })).toBeNull();
  });
});

describe('defaultExec', () => {
  test('runs a command and captures stdout', async () => {
    expect(await defaultExec('echo', ['hi'])).toEqual({ stdout: 'hi\n', code: 0 });
  });
  test('env overrides are applied and undefined removes a variable', async () => {
    const out = await defaultExec('sh', ['-c', 'printf "%s|%s" "$AU_TEST" "${HOME-unset}"'], { env: { AU_TEST: 'x', HOME: undefined } });
    expect(out.stdout).toBe('x|unset');
  });
  test('missing binary yields code 127, never throws', async () => {
    expect((await defaultExec('definitely-not-a-binary-xyz', [])).code).toBe(127);
  });
});
