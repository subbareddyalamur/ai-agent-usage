import { useCallback, useEffect, useState } from 'react';

export class ApiError extends Error {}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // keep the generic message
    }
    throw new ApiError(msg);
  }
  return (await res.json()) as T;
}

export async function postRefresh(): Promise<void> {
  const res = await fetch('/api/refresh', { method: 'POST' });
  if (!res.ok) throw new ApiError(`Refresh failed (${res.status})`);
}

export interface Fetched<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): void;
}

/** Fetches `url` (null = idle). Re-fetches when the url or `refreshKey` changes; stale responses are dropped. */
export function useApi<T>(url: string | null, refreshKey = 0): Fetched<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: url !== null,
  });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (url === null) return;
    const ctrl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    getJson<T>(url, ctrl.signal)
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setState({ data: null, error: e instanceof Error ? e.message : 'Request failed', loading: false });
      });
    return () => ctrl.abort();
  }, [url, refreshKey, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
