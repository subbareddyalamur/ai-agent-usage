/** Timezone-aware day/week/month bucketing. DST-safe: every instant is mapped through Intl. */

/** Aggregation granularity in SQL. Real-world UTC offsets are multiples of 15 minutes, so folding 15-minute buckets into local days is exact. */
export const BUCKET_MS = 15 * 60 * 1000;

export type Granularity = 'day' | 'week' | 'month';

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const partFormatters = new Map<string, Intl.DateTimeFormat>();

export function defaultTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Returns `tz` when it is a valid IANA zone, otherwise the server's local zone. */
export function resolveTz(tz: string | undefined): string {
  if (!tz) return defaultTz();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return defaultTz();
  }
}

function dateFormatter(tz: string): Intl.DateTimeFormat {
  let f = dateFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFormatters.set(tz, f);
  }
  return f;
}

function partFormatter(tz: string): Intl.DateTimeFormat {
  let f = partFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    partFormatters.set(tz, f);
  }
  return f;
}

function pick(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  return Number(parts.find((p) => p.type === type)?.value ?? 0);
}

/** YYYY-MM-DD of `ts` in `tz`. */
export function localDate(ts: number, tz: string): string {
  const parts = dateFormatter(tz).formatToParts(new Date(ts));
  const y = String(pick(parts, 'year')).padStart(4, '0');
  const m = String(pick(parts, 'month')).padStart(2, '0');
  const d = String(pick(parts, 'day')).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function offsetMs(ts: number, tz: string): number {
  const p = partFormatter(tz).formatToParts(new Date(ts));
  const asUtc = Date.UTC(pick(p, 'year'), pick(p, 'month') - 1, pick(p, 'day'), pick(p, 'hour'), pick(p, 'minute'), pick(p, 'second'));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Epoch ms of local 00:00 on `date` (YYYY-MM-DD) in `tz`. */
export function zonedMidnight(date: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const base = Date.UTC(y, m - 1, d);
  const first = base - offsetMs(base, tz);
  return base - offsetMs(first, tz);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Label for the bucket that contains local day `date`: the day itself, the Monday of its week, or YYYY-MM. */
export function bucketLabel(date: string, granularity: Granularity): string {
  if (granularity === 'day') return date;
  if (granularity === 'month') return date.slice(0, 7);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}
