import { describe, expect, test } from 'bun:test';
import { createApiHandler, type ApiDeps } from '../../src/server/api';
import type { CacheReport, Totals } from '../../src/core/api-types';

const totals: Totals = {
  events: 1, sessions: 1, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, cacheReadTokens: 0,
  cacheWriteTokens: 0, costUsd: 0.5, unpricedEvents: 0, unpricedTokens: 0, cacheHitRatio: null,
};

const emptyCache: CacheReport = {
  totals: { steps: 0, promptTokens: 0, cacheReadTokens: 0, hitRatio: null, unavoidableTokens: 0, avoidableMissTokens: 0, extraCostUsd: 0, ttlMs: 300_000, ttlSource: '5m' },
  reasons: [], models: [], sessions: [], days: [], recent: [],
};

function makeDeps(over: Partial<ApiDeps> = {}): { deps: ApiDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: ApiDeps = {
    filterOptions: () => ({ agents: ['a'], models: ['m'], projects: [], minTs: 1, maxTs: 2 }),
    summary: (f) => { calls.push(`summary:${JSON.stringify(f)}`); return { totals, byAgent: [], byModel: [] }; },
    series: (f, b, s) => { calls.push(`series:${b}:${s}`); return []; },
    sessions: (_f, q) => { calls.push(`sessions:${JSON.stringify(q)}`); return { rows: [], total: 0 }; },
    sessionDetail: (agent, id) => (agent === 'a' && id === 's/1' ? { row: {} as never, steps: [] } : null),
    models: () => [],
    tools: () => [],
    cache: (f) => { calls.push(`cache:${JSON.stringify(f)}`); return emptyCache; },
    insights: () => [],
    status: () => ({ adapters: [], pricing: { latestSnapshotAt: null, snapshots: 0, modelsPriced: 0, stale: true }, unmappedModels: [], db: { path: ':memory:', sizeBytes: 0 } }),
    refresh: async () => { calls.push('refresh'); },
    ...over,
  };
  return { deps, calls };
}

const HOST = '127.0.0.1:4000';
function handler(deps: ApiDeps, errors: string[] = []) {
  return createApiHandler(deps, {
    allowedHosts: () => new Set([HOST, 'localhost:4000']),
    logError: (m) => { errors.push(m); },
  });
}
const req = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Request =>
  new Request(`http://${HOST}${path}`, { ...init, headers: { host: HOST, ...(init.headers ?? {}) } });

describe('api routing', () => {
  test('passes parsed filters and params to the deps', async () => {
    const { deps, calls } = makeDeps();
    const h = handler(deps);
    const res = await h(req('/api/summary?agents=a&subagents=0&from=5'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(calls[0]).toBe('summary:{"from":5,"agents":["a"],"includeSubagents":false}');
    await h(req('/api/series?bucket=week&split=agent'));
    expect(calls).toContain('series:week:agent');
    await h(req('/api/sessions?sort=cost&limit=5'));
    expect(calls).toContain('sessions:{"sort":"cost","dir":"desc","limit":5,"offset":0}');
  });

  test('GET /api/cache passes filters and returns the report; 400 on bad input; POST rejected', async () => {
    const { deps, calls } = makeDeps();
    const h = handler(deps);
    const res = await h(req('/api/cache?agents=a,b&models=m&from=5&to=9&subagents=0'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(emptyCache);
    expect(calls[0]).toBe('cache:{"from":5,"to":9,"agents":["a","b"],"models":["m"],"includeSubagents":false}');
    expect((await h(req('/api/cache?to=nope'))).status).toBe(400);
    expect((await h(req('/api/cache', { method: 'POST' }))).status).toBe(405);
  });

  test('400 on bad input without echoing it', async () => {
    const h = handler(makeDeps().deps);
    const res = await h(req('/api/summary?from=zzz'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid "from"' });
  });

  test('session detail: decodes path, 404 when missing', async () => {
    const h = handler(makeDeps().deps);
    expect((await h(req('/api/sessions/a/s%2F1'))).status).toBe(200);
    expect((await h(req('/api/sessions/a/nope'))).status).toBe(404);
    expect((await h(req('/api/sessions/a/%E0%A4%A'))).status).toBe(400);
  });

  test('unknown api path 404, wrong method 405', async () => {
    const h = handler(makeDeps().deps);
    expect((await h(req('/api/nope'))).status).toBe(404);
    expect((await h(req('/api/summary', { method: 'POST' }))).status).toBe(405);
    expect((await h(req('/api/refresh'))).status).toBe(405);
  });

  test('refresh is single-flight', async () => {
    let runs = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const { deps } = makeDeps({ refresh: async () => { runs++; await gate; } });
    const h = handler(deps);
    const a = h(req('/api/refresh', { method: 'POST' }));
    const b = h(req('/api/refresh', { method: 'POST' }));
    release();
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect(runs).toBe(1);
    await h(req('/api/refresh', { method: 'POST' }));
    expect(runs).toBe(2);
  });

  test('internal errors are logged server-side and opaque to the client', async () => {
    const errors: string[] = [];
    const { deps } = makeDeps({ models: () => { throw new Error('secret path /Users/x'); } });
    const res = await handler(deps, errors)(req('/api/models'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
    expect(errors.length).toBe(1);
  });
});

describe('api security', () => {
  test('rejects unknown Host (DNS rebinding)', async () => {
    const h = handler(makeDeps().deps);
    const res = await h(new Request('http://evil.example/api/summary', { headers: { host: 'evil.example' } }));
    expect(res.status).toBe(403);
  });

  test('rejects cross-origin POST, allows same-origin and no-origin', async () => {
    const { deps, calls } = makeDeps();
    const h = handler(deps);
    expect((await h(req('/api/refresh', { method: 'POST', headers: { origin: 'https://evil.example' } }))).status).toBe(403);
    expect(calls).not.toContain('refresh');
    expect((await h(req('/api/refresh', { method: 'POST', headers: { origin: `http://${HOST}` } }))).status).toBe(200);
    expect((await h(req('/api/refresh', { method: 'POST' }))).status).toBe(200);
  });
});
