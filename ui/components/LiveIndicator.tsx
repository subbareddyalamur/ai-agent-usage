import type { Polled } from '../lib/usePolling';

const clock = (ts: number): string => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

type LiveState = 'live' | 'paused' | 'retrying';

export function liveState(p: Pick<Polled<unknown>, 'paused' | 'failures'>): LiveState {
  if (p.paused) return 'paused';
  return p.failures > 0 ? 'retrying' : 'live';
}

const LABEL: Record<LiveState, string> = { live: 'Live', paused: 'Paused', retrying: 'Reconnecting' };

/** Small status chip: pulsing dot, last update time, pause/resume. The time text is not announced to screen readers. */
export function LiveIndicator({ poll }: { poll: Pick<Polled<unknown>, 'paused' | 'failures' | 'updatedAt' | 'setPaused'> }) {
  const state = liveState(poll);
  return (
    <div className={`live ${state}`}>
      <span className="sr-only" role="status">{LABEL[state]}</span>
      <i className="livedot" aria-hidden="true" />
      <span aria-hidden="true">
        {LABEL[state]}
        {poll.updatedAt !== null && <> · updated {clock(poll.updatedAt)}</>}
      </span>
      <button type="button" className="btn small" onClick={() => poll.setPaused(!poll.paused)} aria-pressed={poll.paused}>
        {poll.paused ? 'Resume' : 'Pause'}
      </button>
    </div>
  );
}
