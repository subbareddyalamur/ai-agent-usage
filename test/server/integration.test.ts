import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { openDb } from '../../src/core/db';
import { seedDemo } from '../../src/dev/seed';
import { startServer, type RunningServer } from '../../src/server';

let server: RunningServer;
let refreshes = 0;
const NOW = Date.now();

beforeAll(() => {
  const db = openDb(':memory:');
  seedDemo(db, { now: NOW, days: 30, seed: 3 });
  server = startServer(
    { db, dbPath: ':memory:', ingestAll: async () => { refreshes++; } },
    { port: 0 },
  );
});
afterAll(() => server.stop());

const get = async (path: string) => fetch(`${server.url}${path}`);

describe('server (real HTTP, seeded DB)', () => {
  test('binds to loopback only', () => {
    expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  test('serves the SPA shell and its bundled assets', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<div id="root">');
    const js = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
    expect(js).toBeTruthy();
    expect((await get(js as string)).status).toBe(200);
  });

  test('summary returns totals with sensible numbers', async () => {
    const r = await get('/api/summary');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { totals: { events: number; costUsd: number; unpricedEvents: number } };
    expect(body.totals.events).toBeGreaterThan(100);
    expect(body.totals.costUsd).toBeGreaterThan(0);
    expect(body.totals.unpricedEvents).toBeGreaterThan(0);
  });

  test('filters narrow results', async () => {
    const all = (await (await get('/api/summary')).json()) as { totals: { events: number } };
    const one = (await (await get('/api/summary?agents=claude-code')).json()) as { totals: { events: number } };
    const none = (await (await get(`/api/summary?to=${NOW - 365 * 86_400_000}`)).json()) as { totals: { events: number } };
    expect(one.totals.events).toBeGreaterThan(0);
    expect(one.totals.events).toBeLessThan(all.totals.events);
    expect(none.totals.events).toBe(0);
  });

  test.each(['/api/filter-options', '/api/series?bucket=week&split=agent', '/api/sessions?sort=cost&limit=3', '/api/models', '/api/tools', '/api/insights', '/api/status'])(
    '%s responds 200 JSON',
    async (path) => {
      const r = await get(path);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('application/json');
      await r.json();
    },
  );

  test('session drill-down works end to end; unknown session is 404', async () => {
    const list = (await (await get('/api/sessions?sort=steps&limit=1')).json()) as { rows: Array<{ agent: string; sessionId: string }> };
    const s = list.rows[0] as { agent: string; sessionId: string };
    const d = await get(`/api/sessions/${encodeURIComponent(s.agent)}/${encodeURIComponent(s.sessionId)}`);
    expect(d.status).toBe(200);
    expect(((await d.json()) as { steps: unknown[] }).steps.length).toBeGreaterThan(0);
    expect((await get('/api/sessions/nope/nope')).status).toBe(404);
  });

  test('bad input is a 400 that does not echo the value', async () => {
    const r = await get('/api/summary?from=%3Cb%3E');
    expect(r.status).toBe(400);
    expect(await r.text()).not.toContain('<b>');
  });

  test('POST /api/refresh runs the ingest; cross-origin is refused', async () => {
    const ok = await fetch(`${server.url}/api/refresh`, { method: 'POST' });
    expect(ok.status).toBe(200);
    expect(refreshes).toBe(1);
    const bad = await fetch(`${server.url}/api/refresh`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
    expect(refreshes).toBe(1);
  });

  test('cache report: the showcase reasons appear and numbers are consistent', async () => {
    const r = await get('/api/cache');
    expect(r.status).toBe(200);
    const c = (await r.json()) as import('../../src/core/api-types').CacheReport;
    const reasons = new Map(c.reasons.map((x) => [x.reason, x]));
    for (const k of ['cold-start', 'model-switch', 'prefix-change', 'caching-off'] as const) {
      expect(reasons.get(k)?.steps ?? 0).toBeGreaterThan(0);
    }
    expect(reasons.get('model-switch')?.avoidable).toBe(true);
    expect(reasons.get('cold-start')?.avoidable).toBe(false);
    expect(c.totals.hitRatio).toBeGreaterThan(0);
    expect(c.totals.hitRatio).toBeLessThan(1);
    expect(c.totals.ttlMs).toBeGreaterThan(0);
    expect(c.recent.length).toBeGreaterThan(0);
    expect(c.recent.every((m) => m.avoidable)).toBe(true);
    // the same filters narrow the report
    const one = (await (await get('/api/cache?agents=nope')).json()) as import('../../src/core/api-types').CacheReport;
    expect(one.totals.steps).toBe(0);
  });

  test('session detail marks the miss steps of a model switch', async () => {
    const r = await get('/api/sessions/claude-code/claude-code-showcase-switch');
    expect(r.status).toBe(200);
    const d = (await r.json()) as import('../../src/core/api-types').SessionDetail;
    const marked = d.steps.map((s, i) => [i, s.cacheMiss?.reason] as const).filter(([, reason]) => reason);
    expect(marked.map(([i]) => i)).toEqual([0, 7]);
    expect(marked.map(([, reason]) => reason)).toEqual(['cold-start', 'model-switch']);
  });

  test('/api/cache rejects bad filters with 400', async () => {
    expect((await get('/api/cache?from=zzz')).status).toBe(400);
  });
});
