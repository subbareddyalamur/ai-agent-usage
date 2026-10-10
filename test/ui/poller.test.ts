import { describe, expect, test } from 'bun:test';
import { DEFAULT_POLL, Poller, pollDelay, type PollerEnv } from '../../ui/lib/poller';

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(opts = DEFAULT_POLL) {
  let hidden = false;
  let clock = 1_000;
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const env: PollerEnv = {
    now: () => clock,
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; },
    isHidden: () => hidden,
  };
  const calls: Array<{ signal: AbortSignal; d: Deferred<number> }> = [];
  const data: Array<[number, number]> = [];
  const errors: Array<[string, number]> = [];
  const poller = new Poller<number>(
    {
      fetch: (signal) => { const d = deferred<number>(); calls.push({ signal, d }); return d.promise; },
      onData: (v, at) => data.push([v, at]),
      onError: (m, n) => errors.push([m, n]),
    },
    opts,
    env,
  );
  const pending = () => timers.filter((t) => !t.cancelled);
  /** Fire the single pending timer. */
  const fire = () => { const t = pending().at(-1); if (!t) throw new Error('no timer'); t.cancelled = true; t.fn(); };
  return { poller, calls, data, errors, pending, fire, setHidden: (h: boolean) => { hidden = h; }, tick: (ms: number) => { clock += ms; } };
}

describe('pollDelay', () => {
  test('uses the interval until enough consecutive failures, then the back-off', () => {
    expect(pollDelay(0, DEFAULT_POLL)).toBe(2_000);
    expect(pollDelay(2, DEFAULT_POLL)).toBe(2_000);
    expect(pollDelay(3, DEFAULT_POLL)).toBe(10_000);
    expect(pollDelay(50, DEFAULT_POLL)).toBe(10_000);
  });
});

describe('Poller', () => {
  test('fetches immediately, then schedules the next tick only after the response settled', async () => {
    const h = setup();
    h.poller.start();
    expect(h.calls.length).toBe(1);
    expect(h.pending().length).toBe(0); // nothing scheduled while the request is in flight
    h.calls[0]?.d.resolve(7);
    await flush();
    expect(h.data).toEqual([[7, 1_000]]);
    expect(h.pending().map((t) => t.ms)).toEqual([2_000]);
    h.fire();
    expect(h.calls.length).toBe(2);
  });

  test('never runs two requests at once', async () => {
    const h = setup();
    h.poller.start();
    h.poller.start(); // idempotent
    expect(h.calls.length).toBe(1);
    h.calls[0]?.d.resolve(1);
    await flush();
    h.fire();
    // second request is slow; no timer exists to start a third
    expect(h.pending().length).toBe(0);
    expect(h.calls.length).toBe(2);
  });

  test('a superseded request is aborted and its late response ignored', async () => {
    const h = setup();
    h.poller.start();
    h.poller.fetchNow(); // e.g. filters changed
    expect(h.calls[0]?.signal.aborted).toBe(true);
    h.calls[0]?.d.resolve(111); // late answer for the old request
    h.calls[1]?.d.resolve(222);
    await flush();
    expect(h.data.map(([v]) => v)).toEqual([222]);
  });

  test('skips ticks while hidden and refetches immediately when visible again', async () => {
    const h = setup();
    h.poller.start();
    h.calls[0]?.d.resolve(1);
    await flush();
    h.setHidden(true);
    h.fire(); // timer fires while hidden
    expect(h.calls.length).toBe(1);
    expect(h.pending().length).toBe(0);
    h.setHidden(false);
    h.poller.setHidden(false);
    expect(h.calls.length).toBe(2);
  });

  test('becoming visible without a skipped tick does not cause an extra fetch', async () => {
    const h = setup();
    h.poller.start();
    h.calls[0]?.d.resolve(1);
    await flush();
    h.poller.setHidden(false);
    expect(h.calls.length).toBe(1);
  });

  test('backs off after repeated failures and recovers on the first success', async () => {
    const h = setup();
    h.poller.start();
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      h.calls.at(-1)?.d.reject(new Error('down'));
      await flush();
      delays.push(h.pending().at(-1)?.ms ?? -1);
      h.fire();
    }
    expect(delays).toEqual([2_000, 2_000, 10_000, 10_000]);
    expect(h.errors.at(-1)).toEqual(['down', 4]);
    h.calls.at(-1)?.d.resolve(5);
    await flush();
    expect(h.poller.consecutiveFailures).toBe(0);
    expect(h.pending().at(-1)?.ms).toBe(2_000);
  });

  test('pause stops scheduling; resume fetches at once', async () => {
    const h = setup();
    h.poller.start();
    h.calls[0]?.d.resolve(1);
    await flush();
    h.poller.setPaused(true);
    expect(h.pending().length).toBe(0);
    h.poller.setPaused(true); // no-op
    h.poller.setPaused(false);
    expect(h.calls.length).toBe(2);
  });

  test('a response that arrives while paused is applied but does not schedule', async () => {
    const h = setup();
    h.poller.start();
    h.poller.setPaused(true);
    h.calls[0]?.d.resolve(9);
    await flush();
    expect(h.data.length).toBe(1);
    expect(h.pending().length).toBe(0);
  });

  test('stop aborts in-flight work and ignores its response', async () => {
    const h = setup();
    h.poller.start();
    h.poller.stop();
    expect(h.calls[0]?.signal.aborted).toBe(true);
    h.calls[0]?.d.resolve(3);
    await flush();
    expect(h.data).toEqual([]);
    expect(h.pending().length).toBe(0);
    h.poller.fetchNow(); // stopped pollers stay stopped
    expect(h.calls.length).toBe(1);
  });

  test('aborted requests do not count as failures', async () => {
    const h = setup();
    h.poller.start();
    h.poller.fetchNow();
    h.calls[0]?.d.reject(new DOMException('aborted', 'AbortError'));
    await flush();
    expect(h.errors).toEqual([]);
    expect(h.poller.consecutiveFailures).toBe(0);
  });
});
