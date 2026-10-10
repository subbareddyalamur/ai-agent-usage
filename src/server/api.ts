import type {
  CacheReport,
  Filters,
  FilterOptions,
  Finding,
  ModelRow,
  SeriesPoint,
  SessionDetail,
  SessionRow,
  StatusInfo,
  SummaryResult,
  ToolRow,
} from '../core/api-types';
import {
  parseFilters,
  parseSeriesParams,
  parseSessionQuery,
  type Bucket,
  type Parsed,
  type SessionQuery,
  type Split,
} from './params';

/** Everything the HTTP layer needs. Wired to the real query layer in index.ts, stubbed in tests. */
export interface ApiDeps {
  filterOptions(): FilterOptions;
  summary(f: Filters): SummaryResult;
  series(f: Filters, bucket: Bucket, split: Split): SeriesPoint[];
  sessions(f: Filters, q: SessionQuery): { rows: SessionRow[]; total: number };
  sessionDetail(agent: string, sessionId: string): SessionDetail | null;
  models(f: Filters): ModelRow[];
  tools(f: Filters): ToolRow[];
  cache(f: Filters): CacheReport;
  insights(f: Filters): Finding[];
  status(): StatusInfo;
  refresh(): Promise<unknown>;
}

export interface ApiOptions {
  /** Hosts (header value incl. port) the server may be addressed as. */
  allowedHosts: () => ReadonlySet<string>;
  /** Server-side error sink; details never reach the client. */
  logError: (message: string, error: unknown) => void;
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS },
  });
}

function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

function unwrap<T>(parsed: Parsed<T>): { value: T } | { response: Response } {
  return parsed.ok ? { value: parsed.value } : { response: error(400, parsed.error) };
}

function decodeSegment(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.length > 0 && decoded.length <= 300 ? decoded : null;
  } catch {
    return null;
  }
}

function originAllowed(req: Request, hosts: ReadonlySet<string>): boolean {
  const origin = req.headers.get('origin');
  if (origin === null) return true;
  for (const h of hosts) if (origin === `http://${h}`) return true;
  return false;
}

export function createApiHandler(deps: ApiDeps, opts: ApiOptions): (req: Request) => Promise<Response> {
  let refreshing: Promise<unknown> | null = null;

  async function route(req: Request, url: URL): Promise<Response> {
    const path = url.pathname.replace(/\/+$/, '');
    const sp = url.searchParams;
    const isRead = req.method === 'GET' || req.method === 'HEAD';

    if (path === '/api/refresh') {
      if (req.method !== 'POST') return error(405, 'method not allowed');
      // Single flight: concurrent clicks share one ingest run.
      refreshing ??= deps.refresh().finally(() => {
        refreshing = null;
      });
      await refreshing;
      return json({ ok: true });
    }
    if (!isRead) return error(405, 'method not allowed');

    if (path === '/api/filter-options') return json(deps.filterOptions());
    if (path === '/api/status') return json(deps.status());

    const sessionMatch = /^\/api\/sessions\/([^/]+)\/([^/]+)$/.exec(path);
    if (sessionMatch) {
      const agent = decodeSegment(sessionMatch[1] as string);
      const id = decodeSegment(sessionMatch[2] as string);
      if (agent === null || id === null) return error(400, 'invalid path');
      const detail = deps.sessionDetail(agent, id);
      return detail ? json(detail) : error(404, 'not found');
    }

    const known = ['/api/summary', '/api/series', '/api/sessions', '/api/models', '/api/tools', '/api/cache', '/api/insights'];
    if (!known.includes(path)) return error(404, 'not found');

    const f = unwrap(parseFilters(sp));
    if ('response' in f) return f.response;

    switch (path) {
      case '/api/summary':
        return json(deps.summary(f.value));
      case '/api/series': {
        const p = unwrap(parseSeriesParams(sp));
        if ('response' in p) return p.response;
        return json(deps.series(f.value, p.value.bucket, p.value.split));
      }
      case '/api/sessions': {
        const q = unwrap(parseSessionQuery(sp));
        if ('response' in q) return q.response;
        return json(deps.sessions(f.value, q.value));
      }
      case '/api/models':
        return json(deps.models(f.value));
      case '/api/tools':
        return json(deps.tools(f.value));
      case '/api/cache':
        return json(deps.cache(f.value));
      default:
        return json(deps.insights(f.value));
    }
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const hosts = opts.allowedHosts();
    const host = req.headers.get('host');
    // DNS-rebinding guard: only answer to our own loopback names.
    if (host === null || !hosts.has(host)) return error(403, 'forbidden');
    // CSRF guard for the one mutating endpoint (and any future one).
    if (!originAllowed(req, hosts)) return error(403, 'forbidden');
    try {
      return await route(req, url);
    } catch (e: unknown) {
      opts.logError(`${req.method} ${url.pathname} failed`, e);
      return error(500, 'internal error');
    }
  };
}
