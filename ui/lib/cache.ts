import type { CacheReport, MissReason } from '../../src/core/api-types';

export const REASON_LABEL: Record<MissReason, string> = {
  'cold-start': 'Cold start',
  'context-reset': 'Context reset',
  'caching-off': 'Caching off',
  expired: 'Cache expired',
  'model-switch': 'Model switch',
  'prefix-change': 'Prompt changed',
};

/** Short "what happened" for tooltips; the long, data-filled explanation comes from the API. */
export const REASON_HINT: Record<MissReason, string> = {
  'cold-start': 'First call of a conversation: there was nothing cached to read yet.',
  'context-reset': 'The prompt shrank sharply (compaction or a new conversation), so the old cache no longer applied.',
  'caching-off': 'No cache reads or writes at all for this model in the session: caching never engaged.',
  expired: 'The pause since the previous call outlived the cache lifetime, so the prompt was re-written.',
  'model-switch': 'The model changed from the previous call; caches belong to one model.',
  'prefix-change': 'No pause and the same model, yet the cache was missed: something early in the prompt changed.',
};

/** Order the reasons are shown in: avoidable ones first. */
export const REASON_ORDER: readonly MissReason[] = ['caching-off', 'expired', 'prefix-change', 'model-switch', 'context-reset', 'cold-start'];

export function formatDuration(ms: number | null): string {
  if (ms === null) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = m / 60;
  if (h < 48) return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
  return `${Math.round(h / 24)} d`;
}

export function ttlSourceLabel(source: CacheReport['totals']['ttlSource']): string {
  switch (source) {
    case '5m':
      return 'from your 5-minute cache writes';
    case '1h':
      return 'from your 1-hour cache writes';
    case 'mixed':
      return 'you use both 5-minute and 1-hour writes; judged per session';
  }
}

export function sortReasons<T extends { reason: MissReason }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => REASON_ORDER.indexOf(a.reason) - REASON_ORDER.indexOf(b.reason));
}
