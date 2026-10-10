// Framework-free polling controller (the React hook in usePolling.ts is a thin wrapper), so the
// timing rules can be unit-tested with fake timers.
//
// Rules: never two requests at once (the next tick is scheduled only after the previous one settled);
// no requests while the tab is hidden, and one immediate refetch when it becomes visible again;
// after N consecutive failures slow down to a back-off interval, and speed up again on the first success;
// a response that was superseded (restart, key change, stop) is ignored.

export interface PollerEnv {
  now(): number;
  /** Schedules `fn` once after `ms`; returns a cancel function. */
  setTimer(fn: () => void, ms: number): () => void;
  isHidden(): boolean;
}

export interface PollerOptions {
  intervalMs: number;
  backoffMs: number;
  failuresBeforeBackoff: number;
}

export interface PollerCallbacks<T> {
  fetch(signal: AbortSignal): Promise<T>;
  onData(data: T, at: number): void;
  onError(message: string, failures: number): void;
}

export const DEFAULT_POLL: PollerOptions = { intervalMs: 2_000, backoffMs: 10_000, failuresBeforeBackoff: 3 };

export function pollDelay(failures: number, o: PollerOptions): number {
  return failures >= o.failuresBeforeBackoff ? o.backoffMs : o.intervalMs;
}

export class Poller<T> {
  private running = false;
  private paused = false;
  private waitingForVisible = false;
  private failures = 0;
  private generation = 0;
  private cancelTimer: (() => void) | null = null;
  private controller: AbortController | null = null;

  constructor(
    private readonly cb: PollerCallbacks<T>,
    private readonly opts: PollerOptions,
    private readonly env: PollerEnv,
  ) {}

  get consecutiveFailures(): number {
    return this.failures;
  }

  /** Fetch immediately, then keep polling. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.fetchNow();
  }

  stop(): void {
    this.running = false;
    this.generation++;
    this.clearTimer();
    this.controller?.abort();
    this.controller = null;
  }

  setPaused(paused: boolean): void {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.clearTimer();
      this.waitingForVisible = false;
    } else if (this.running) {
      this.fetchNow();
    }
  }

  /** Call from visibilitychange. */
  setHidden(hidden: boolean): void {
    if (hidden || !this.running || this.paused) return;
    if (this.waitingForVisible) this.fetchNow();
  }

  /** Abort anything in flight and fetch right now (manual retry, filter change). */
  fetchNow(): void {
    if (!this.running || this.paused) return;
    this.clearTimer();
    this.waitingForVisible = false;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const mine = ++this.generation;
    this.cb.fetch(controller.signal).then(
      (data) => {
        if (mine !== this.generation) return;
        this.failures = 0;
        this.cb.onData(data, this.env.now());
        this.schedule();
      },
      (error: unknown) => {
        if (mine !== this.generation || controller.signal.aborted) return;
        this.failures++;
        this.cb.onError(error instanceof Error ? error.message : 'Request failed', this.failures);
        this.schedule();
      },
    );
  }

  private schedule(): void {
    if (!this.running || this.paused) return;
    this.clearTimer();
    this.cancelTimer = this.env.setTimer(() => {
      this.cancelTimer = null;
      if (this.env.isHidden()) {
        // Do not poll a hidden tab; setHidden(false) resumes with an immediate fetch.
        this.waitingForVisible = true;
        return;
      }
      this.fetchNow();
    }, pollDelay(this.failures, this.opts));
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
  }
}
