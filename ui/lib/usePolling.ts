import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_POLL, Poller, type PollerEnv, type PollerOptions } from './poller';

export interface Polled<T> {
  data: T | null;
  /** Latest error; `data` keeps the last good value while this is set. */
  error: string | null;
  /** Epoch ms of the last successful fetch. */
  updatedAt: number | null;
  paused: boolean;
  setPaused(paused: boolean): void;
  /** True while the shown data belongs to a previous key and the new one is still loading. */
  refreshing: boolean;
  /** Consecutive failures so far (0 = healthy). */
  failures: number;
  /** Fetch right now (manual retry). */
  refetch(): void;
}

const browserEnv: PollerEnv = {
  now: Date.now,
  setTimer: (fn, ms) => {
    const id = window.setTimeout(fn, ms);
    return () => window.clearTimeout(id);
  },
  isHidden: () => document.hidden,
};

/**
 * Polls `fetcher` (default every 2 s) while the component is mounted, stale-while-revalidate:
 * the previous data stays on screen during refetches and key changes, so nothing flickers.
 * `key` identifies what is being fetched (filters etc.); changing it restarts polling at once.
 * `fetcher` may change identity freely; the latest one is used for every tick.
 */
export function usePolling<T>(fetcher: (signal: AbortSignal) => Promise<T>, key: string, options: Partial<PollerOptions> = {}): Polled<T> {
  const [data, setData] = useState<{ value: T; key: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [failures, setFailures] = useState(0);
  const [paused, setPausedState] = useState(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const pollerRef = useRef<Poller<T> | null>(null);
  const { intervalMs, backoffMs, failuresBeforeBackoff } = { ...DEFAULT_POLL, ...options };

  useEffect(() => {
    const poller = new Poller<T>(
      {
        fetch: (signal) => fetcherRef.current(signal),
        onData: (value, at) => {
          setData({ value, key });
          setError(null);
          setFailures(0);
          setUpdatedAt(at);
        },
        onError: (message, count) => {
          setError(message);
          setFailures(count);
        },
      },
      { intervalMs, backoffMs, failuresBeforeBackoff },
      browserEnv,
    );
    pollerRef.current = poller;
    poller.setPaused(pausedRef.current);
    if (!pausedRef.current) poller.start();
    const onVisibility = () => poller.setHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [key, intervalMs, backoffMs, failuresBeforeBackoff]);

  const setPaused = useCallback((next: boolean) => {
    setPausedState(next);
    const poller = pollerRef.current;
    if (!poller) return;
    // A poller that was created paused was never started: start() is idempotent and fetches once.
    poller.setPaused(next);
    if (!next) poller.start();
  }, []);

  const refetch = useCallback(() => pollerRef.current?.fetchNow(), []);

  return {
    data: data?.value ?? null,
    error,
    updatedAt,
    paused,
    setPaused,
    refreshing: data !== null && data.key !== key,
    failures,
    refetch,
  };
}
