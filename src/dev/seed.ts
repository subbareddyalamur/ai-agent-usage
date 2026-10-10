// Generates a realistic DEMO database through the real schema. Prices below are illustrative, not AWS's.
import type { Database } from 'bun:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultDbPath, openDb } from '../core/db';

const DAY = 86_400_000;

export interface SeedOptions {
  now?: number;
  days?: number;
  seed?: number;
}

interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cw5m: number;
  cw1h: number;
}

interface DemoModel {
  canonical: string;
  raw: string;
  provider: string;
  tier: 'regional' | 'global';
  /** null = deliberately unpriced (e.g. a local Ollama model). */
  rates: Rates | null;
}

const MODELS: Record<string, DemoModel> = {
  sonnet55: { canonical: 'Claude Sonnet 5.5', raw: 'us.anthropic.claude-sonnet-5-5', provider: 'amazon-bedrock', tier: 'regional', rates: { input: 2.2, output: 11, cacheRead: 0.11, cw5m: 2.75, cw1h: 4.4 } },
  opus55: { canonical: 'Claude Opus 5.5', raw: 'us.anthropic.claude-opus-5-5', provider: 'amazon-bedrock', tier: 'regional', rates: { input: 5.5, output: 27.5, cacheRead: 0.55, cw5m: 6.875, cw1h: 11 } },
  haiku55: { canonical: 'Claude Haiku 5.5', raw: 'us.anthropic.claude-haiku-5-5', provider: 'amazon-bedrock', tier: 'regional', rates: { input: 1.1, output: 5.5, cacheRead: 0.11, cw5m: 1.375, cw1h: 2.2 } },
  sonnet46: { canonical: 'Claude Sonnet 4.6', raw: 'claude-sonnet-4-6', provider: 'amazon-bedrock', tier: 'regional', rates: { input: 3.3, output: 16.5, cacheRead: 0.33, cw5m: 4.125, cw1h: 6.6 } },
  opus48: { canonical: 'Claude Opus 4.8', raw: 'global.anthropic.claude-opus-4-8', provider: 'amazon-bedrock', tier: 'global', rates: { input: 5, output: 25, cacheRead: 0.5, cw5m: 6.25, cw1h: 10 } },
  gemma: { canonical: 'gemma3:1b', raw: 'gemma3:1b', provider: 'ollama', tier: 'regional', rates: null },
};

const PROJECTS = ['/Users/demo/work/api-gateway', '/Users/demo/work/web-dashboard', '/Users/demo/work/infra-terraform', '/Users/demo/work/agent-usage'];
const TITLES = ['Refactor billing module', 'Investigate flaky CI job', 'Add pagination to list endpoint', 'Review terraform plan drift', 'Write migration for audit table', 'Debug websocket reconnects', 'Document onboarding flow', 'Upgrade dependencies'];
const TOOLS: Array<{ name: string; weight: number; min: number; max: number }> = [
  { name: 'Read', weight: 30, min: 500, max: 40_000 },
  { name: 'Bash', weight: 25, min: 200, max: 20_000 },
  { name: 'Grep', weight: 15, min: 300, max: 8_000 },
  { name: 'Edit', weight: 14, min: 100, max: 1_000 },
  { name: 'Glob', weight: 6, min: 100, max: 3_000 },
  { name: 'WebFetch', weight: 4, min: 5_000, max: 60_000 },
  { name: 'mcp__exa__web_search_exa', weight: 3, min: 3_000, max: 25_000 },
  { name: 'mcp__github__get_file_contents', weight: 3, min: 1_000, max: 30_000 },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Snapshot {
  id: number;
  fetchedAt: number;
  scale: (model: DemoModel) => number;
}

function insertSnapshots(db: Database, now: number): Snapshot[] {
  const defs = [
    { fetchedAt: now - 50 * DAY, scale: (_m: DemoModel) => 1 },
    // A later list lowered Haiku by 10%; earlier usage keeps the older price.
    { fetchedAt: now - 20 * DAY, scale: (m: DemoModel) => (m.canonical === 'Claude Haiku 5.5' ? 0.9 : 1) },
  ];
  const insSnap = db.prepare(
    `INSERT INTO price_snapshots (fetched_at, last_checked_at, content_hash, source_url, publication_date, row_count)
     VALUES (?, ?, ?, 'demo://aws-price-list', NULL, 0)`,
  );
  const insPrice = db.prepare(
    `INSERT INTO prices (snapshot_id, model, region, tier, kind, long_ctx, usd_per_mtok) VALUES (?, ?, 'us-east-1', ?, ?, 0, ?)`,
  );
  return defs.map((d, i) => {
    const id = Number(insSnap.run(d.fetchedAt, i === defs.length - 1 ? now : d.fetchedAt, `demo-${i}`).lastInsertRowid);
    db.transaction(() => {
      for (const m of Object.values(MODELS)) {
        if (!m.rates) continue;
        const s = d.scale(m);
        // m.rates are the rates of the model's own tier; the other tier differs by 10%, like the real list.
        for (const tier of ['regional', 'global'] as const) {
          const f = s * (tier === m.tier ? 1 : tier === 'global' ? 1 / 1.1 : 1.1);
          const kinds: Array<[string, number]> = [
            ['input', m.rates.input], ['output', m.rates.output], ['cache_read', m.rates.cacheRead],
            ['cache_write_5m', m.rates.cw5m], ['cache_write_1h', m.rates.cw1h],
          ];
          for (const [kind, v] of kinds) insPrice.run(id, m.canonical, tier, kind, v * f);
        }
      }
    })();
    return { id, fetchedAt: d.fetchedAt, scale: d.scale };
  });
}

interface Tokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cw5m: number;
  cw1h: number;
}

function costOf(snaps: readonly Snapshot[], m: DemoModel, ts: number, t: Tokens): { cost: number | null; approx: boolean } {
  if (!m.rates) return { cost: null, approx: false };
  const inEffect = [...snaps].reverse().find((s) => s.fetchedAt <= ts);
  const snap = inEffect ?? (snaps[0] as Snapshot);
  const f = snap.scale(m);
  const r = m.rates;
  const cost = (t.input * r.input + (t.output + t.reasoning) * r.output + t.cacheRead * r.cacheRead + t.cw5m * r.cw5m + t.cw1h * r.cw1h) * f / 1e6;
  return { cost, approx: inEffect === undefined };
}

export function seedDemo(db: Database, opts: SeedOptions = {}): { events: number; sessions: number } {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? 60;
  const rng = mulberry32(opts.seed ?? 42);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;
  const between = (a: number, b: number): number => a + rng() * (b - a);
  const snaps = insertSnapshots(db, now);

  const insEvent = db.prepare(`
    INSERT INTO events (id, agent, session_id, project, ts, provider, model_raw, model, priced, tier,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
      is_subagent, kind, reported_cost_usd, aws_profile_hint, cost_usd, cost_approx, ingested_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?)`);
  const insTool = db.prepare(`INSERT INTO tool_calls (agent, call_id, event_id, name, result_bytes, is_error) VALUES (?,?,?,?,?,?)`);
  const insSession = db.prepare(`INSERT INTO sessions (agent, session_id, title, project) VALUES (?,?,?,?)`);

  let events = 0;
  let sessions = 0;

  function weightedTool(): (typeof TOOLS)[number] {
    const total = TOOLS.reduce((a, t) => a + t.weight, 0);
    let x = rng() * total;
    for (const t of TOOLS) {
      x -= t.weight;
      if (x <= 0) return t;
    }
    return TOOLS[0] as (typeof TOOLS)[number];
  }

  function writeEvent(agent: string, sessionId: string, i: number, ts: number, m: DemoModel, t: Tokens, sub: boolean, kind: 'step' | 'session_total', toolCount: number): number {
    const { cost, approx } = costOf(snaps, m, ts, t);
    const id = `${agent}:${sessionId}:${i}`;
    const project = projectFor(sessionId);
    insEvent.run(id, agent, sessionId, project, Math.round(ts), m.provider, m.raw, m.canonical, m.rates ? 1 : 0, m.tier,
      Math.round(t.input), Math.round(t.output), Math.round(t.reasoning), Math.round(t.cacheRead), Math.round(t.cw5m), Math.round(t.cw1h),
      sub ? 1 : 0, kind, cost, approx ? 1 : 0, now);
    events++;
    let bytesTotal = 0;
    for (let k = 0; k < toolCount; k++) {
      const tool = weightedTool();
      const huge = tool.name === 'Bash' && rng() < 0.03;
      const bytes = Math.round(huge ? between(150_000, 400_000) : between(tool.min, tool.max));
      insTool.run(agent, `${id}:t${k}`, id, tool.name, bytes, rng() < 0.03 ? 1 : 0);
      bytesTotal += bytes;
    }
    return bytesTotal;
  }

  function session(agent: string, sessionId: string, startTs: number, steps: number, mains: DemoModel[], opts2: { cache: boolean; subagents: boolean; oneHour: boolean; reasoning: boolean; baseCtx?: number; growth?: number }): void {
    insSession.run(agent, sessionId, pick(TITLES), projectFor(sessionId));
    sessions++;
    const model = pick(mains);
    let ctx = opts2.baseCtx ?? between(12_000, 27_000);
    let ts = startTs;
    let prevToolBytes = 0;
    for (let i = 0; i < steps; i++) {
      const add = i === 0 ? 0 : 400 + prevToolBytes / 4 + (opts2.growth ?? 0);
      const compacted = ctx + add > 175_000;
      ctx = compacted ? between(18_000, 28_000) : ctx + add;
      const expired = i > 0 && !compacted && rng() < 0.04;
      ts += expired ? between(6, 15) * 60_000 : between(15_000, 120_000);
      const t: Tokens = { input: 0, output: between(150, 1_950), reasoning: opts2.reasoning && rng() < 0.4 ? between(100, 800) : 0, cacheRead: 0, cw5m: 0, cw1h: 0 };
      if (!opts2.cache || !model.rates) {
        t.input = ctx;
      } else if (i === 0 || expired || compacted) {
        t.input = between(60, 300);
        if (opts2.oneHour) t.cw1h = ctx; else t.cw5m = ctx;
      } else {
        t.cacheRead = ctx - add;
        t.input = between(60, 300);
        if (opts2.oneHour) t.cw1h = add; else t.cw5m = add;
      }
      prevToolBytes = writeEvent(agent, sessionId, i, ts, model, t, false, 'step', Math.floor(rng() * 3.4));
      if (opts2.subagents && i > 3 && rng() < 0.08) {
        const sub = MODELS.haiku55 as DemoModel;
        const n = 3 + Math.floor(rng() * 7);
        let sctx = between(8_000, 15_000);
        for (let j = 0; j < n; j++) {
          sctx += between(500, 6_000);
          ts += between(8_000, 40_000);
          const sb = writeEvent(agent, sessionId, 1000 + i * 20 + j, ts, sub, { input: between(60, 200), output: between(100, 900), reasoning: 0, cacheRead: j === 0 ? 0 : sctx - 2_000, cw5m: j === 0 ? sctx : 2_000, cw1h: 0 }, true, 'step', 1 + Math.floor(rng() * 2));
          sctx += sb / 4;
        }
      }
    }
  }

  db.transaction(() => {
    for (let d = days - 1; d >= 0; d--) {
      const dayTs = now - d * DAY;
      const dow = new Date(dayTs).getUTCDay();
      const weekend = dow === 0 || dow === 6;
      const plan: Array<{ agent: string; n: number }> = [
        { agent: 'claude-code', n: weekend ? Math.floor(rng() * 2) : 1 + Math.floor(rng() * 3) },
        { agent: 'opencode', n: Math.floor(rng() * (weekend ? 1.5 : 2.6)) },
        { agent: 'pi', n: Math.floor(rng() * 2) },
        { agent: 'cowork', n: d > 20 ? Math.floor(rng() * 2) : 0 },
      ];
      for (const { agent, n } of plan) {
        for (let k = 0; k < n; k++) {
          const sid = `${agent}-${d}-${k}`;
          const start = dayTs - between(0.1, 0.45) * DAY;
          const long = rng() < 0.12;
          const steps = long ? 70 + Math.floor(rng() * 50) : 6 + Math.floor(rng() * rng() * 45);
          if (agent === 'claude-code') session(agent, sid, start, steps, [MODELS.sonnet55 as DemoModel, MODELS.sonnet55 as DemoModel, MODELS.opus55 as DemoModel], { cache: true, subagents: true, oneHour: rng() < 0.2, reasoning: false });
          else if (agent === 'opencode') session(agent, sid, start, steps, [MODELS.sonnet55 as DemoModel, MODELS.sonnet46 as DemoModel, MODELS.opus48 as DemoModel], { cache: rng() < 0.85, subagents: false, oneHour: false, reasoning: true });
          else if (agent === 'pi') session(agent, sid, start, steps, [MODELS.sonnet46 as DemoModel, MODELS.haiku55 as DemoModel, MODELS.gemma as DemoModel], { cache: true, subagents: false, oneHour: false, reasoning: false });
          else session(agent, sid, start, steps, [MODELS.sonnet55 as DemoModel, MODELS.haiku55 as DemoModel], { cache: true, subagents: false, oneHour: false, reasoning: false });
        }
      }
    }

    // Pathological: an AIP-ARN session where prompt caching silently never engaged (~9M input tokens).
    const bad: DemoModel = { ...(MODELS.sonnet55 as DemoModel), raw: 'arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/demo1234' };
    session('opencode', 'opencode-nocache', now - 2 * DAY, 68, [bad], { cache: false, subagents: false, oneHour: false, reasoning: false, baseCtx: 30_000, growth: 1_800 });

    // Deterministic cache-miss showcases: a model switch and an unexplained prompt change, both without any pause.
    for (const kind of ['switch', 'prefix'] as const) {
      const sid = `claude-code-showcase-${kind}`;
      insSession.run('claude-code', sid, kind === 'switch' ? 'Switch to Opus mid-task' : 'Prompt changed mid-session', projectFor(sid));
      sessions++;
      let ctx = 20_000;
      let ts = now - 3 * 3_600_000 - (kind === 'switch' ? 0 : 900_000);
      for (let i = 0; i < 14; i++) {
        const add = i === 0 ? 0 : 1_200;
        ctx += add;
        ts += 45_000;
        const model = kind === 'switch' && i >= 7 ? (MODELS.opus55 as DemoModel) : (MODELS.sonnet55 as DemoModel);
        const miss = i === 0 || (kind === 'switch' && i === 7) || (kind === 'prefix' && i === 8);
        const t: Tokens = miss
          ? { input: 150, output: 600, reasoning: 0, cacheRead: 0, cw5m: ctx, cw1h: 0 }
          : { input: 150, output: 600, reasoning: 0, cacheRead: ctx - add, cw5m: add, cw1h: 0 };
        writeEvent('claude-code', sid, i, ts, model, t, false, 'step', 1);
      }
    }

    // Legacy opencode sessions that only have session level totals.
    for (let k = 0; k < 4; k++) {
      const sid = `opencode-legacy-${k}`;
      insSession.run('opencode', sid, pick(TITLES), projectFor(sid));
      sessions++;
      writeEvent('opencode', sid, 0, now - (days - 2 - k) * DAY, MODELS.sonnet46 as DemoModel, { input: between(300_000, 900_000), output: between(20_000, 60_000), reasoning: 0, cacheRead: 0, cw5m: 0, cw1h: 0 }, false, 'session_total', 0);
    }

    const run = db.prepare(`INSERT INTO adapter_runs (adapter, label, installed, detail, error, last_ingest_at) VALUES (?,?,?,?,NULL,?)`);
    run.run('claude-code', 'Claude Code', 1, '~/.claude/projects', now);
    run.run('opencode', 'opencode', 1, '~/.local/share/opencode/opencode.db', now);
    run.run('pi', 'Pi', 1, '~/.pi/agent/sessions', now);
    run.run('cowork', 'Claude desktop (Cowork)', 0, 'not found (history kept)', now);
  })();

  return { events, sessions };
}

function projectFor(sessionId: string): string {
  return PROJECTS[Math.abs(hash(sessionId)) % PROJECTS.length] ?? '/Users/demo/work/misc';
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const target = args.find((a) => !a.startsWith('--')) ?? process.env.AGENT_USAGE_DB;
  if (!target) {
    process.stderr.write('usage: bun run src/dev/seed.ts <db-path> [--force]\n');
    process.exit(2);
  }
  if (resolve(target) === resolve(defaultDbPath())) {
    process.stderr.write('refusing to seed the default (real) database path\n');
    process.exit(2);
  }
  if (existsSync(target)) {
    if (!force) {
      process.stderr.write(`${target} exists; pass --force to replace it\n`);
      process.exit(2);
    }
    for (const f of [target, `${target}-wal`, `${target}-shm`]) rmSync(f, { force: true });
  }
  const db = openDb(target);
  const r = seedDemo(db);
  db.close();
  process.stdout.write(`seeded ${r.events} events in ${r.sessions} sessions -> ${target}\n`);
}
