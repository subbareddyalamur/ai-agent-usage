import { useCallback, useMemo, useSyncExternalStore } from 'react';

export interface Route {
  segments: string[];
  params: URLSearchParams;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

const snapshot = (): string => window.location.hash;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const q = raw.indexOf('?');
  const path = q === -1 ? raw : raw.slice(0, q);
  const query = q === -1 ? '' : raw.slice(q + 1);
  return {
    segments: path.split('/').filter(Boolean).map(safeDecode),
    params: new URLSearchParams(query),
  };
}

export function buildHash(segments: readonly string[], params: URLSearchParams): string {
  const path = segments.map(encodeURIComponent).join('/');
  const q = params.toString();
  return `#/${path}${q ? `?${q}` : ''}`;
}

export function useRoute(): Route & {
  setParams(updates: Record<string, string | null>): void;
  hrefFor(segments: readonly string[], extra?: Record<string, string | null>): string;
} {
  const hash = useSyncExternalStore(subscribe, snapshot, () => '');
  const route = useMemo(() => parseHash(hash), [hash]);

  const setParams = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(route.params);
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      // Filter tweaks replace the history entry instead of piling up back-button stops.
      window.history.replaceState(null, '', buildHash(route.segments, next));
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    },
    [route],
  );

  const hrefFor = useCallback(
    (segments: readonly string[], extra: Record<string, string | null> = {}) => {
      const next = new URLSearchParams(route.params);
      for (const k of ['section', 'sort', 'dir', 'page', 'group']) next.delete(k);
      for (const [k, v] of Object.entries(extra)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      return buildHash(segments, next);
    },
    [route],
  );

  return { ...route, setParams, hrefFor };
}
