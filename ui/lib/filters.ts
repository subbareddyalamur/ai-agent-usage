export type RangePreset = 'today' | '7d' | '30d' | '90d' | 'all' | 'custom';

export interface FilterState {
  range: RangePreset;
  /** YYYY-MM-DD, local; used when range === 'custom'. */
  from: string;
  to: string;
  agents: string[];
  models: string[];
  subagents: boolean;
}

export const PRESETS: ReadonlyArray<{ id: RangePreset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'all', label: 'All' },
  { id: 'custom', label: 'Custom' },
];

const RANGES = new Set<string>(PRESETS.map((p) => p.id));
const list = (v: string | null): string[] => (v ? v.split(',').filter(Boolean) : []);

export function readFilters(p: URLSearchParams): FilterState {
  const r = p.get('range') ?? '30d';
  return {
    range: RANGES.has(r) ? (r as RangePreset) : '30d',
    from: p.get('from') ?? '',
    to: p.get('to') ?? '',
    agents: list(p.get('agents')),
    models: list(p.get('models')),
    subagents: p.get('sub') !== '0',
  };
}

function startOfLocalDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function parseLocalDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Epoch-ms bounds for the current range (undefined = open ended). */
export function rangeBounds(f: FilterState, now: Date = new Date()): { from?: number; to?: number } {
  const today = startOfLocalDay(now);
  const day = 86_400_000;
  switch (f.range) {
    case 'today':
      return { from: today };
    case '7d':
      return { from: today - 6 * day };
    case '30d':
      return { from: today - 29 * day };
    case '90d':
      return { from: today - 89 * day };
    case 'all':
      return {};
    case 'custom': {
      const a = parseLocalDate(f.from);
      const b = parseLocalDate(f.to);
      return {
        ...(a && { from: a.getTime() }),
        // inclusive end date: up to the last millisecond of that local day
        ...(b && { to: new Date(b.getFullYear(), b.getMonth(), b.getDate() + 1).getTime() - 1 }),
      };
    }
  }
}

/** Query string for the /api endpoints. */
export function toApiQuery(f: FilterState, now: Date = new Date()): string {
  const q = new URLSearchParams();
  const { from, to } = rangeBounds(f, now);
  if (from !== undefined) q.set('from', String(from));
  if (to !== undefined) q.set('to', String(to));
  if (f.agents.length) q.set('agents', f.agents.join(','));
  if (f.models.length) q.set('models', f.models.join(','));
  if (!f.subagents) q.set('subagents', '0');
  q.set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
  return q.toString();
}

export function filterUpdates(f: Partial<FilterState>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (f.range !== undefined) out.range = f.range === '30d' ? null : f.range;
  if (f.from !== undefined) out.from = f.from || null;
  if (f.to !== undefined) out.to = f.to || null;
  if (f.agents !== undefined) out.agents = f.agents.length ? f.agents.join(',') : null;
  if (f.models !== undefined) out.models = f.models.length ? f.models.join(',') : null;
  if (f.subagents !== undefined) out.sub = f.subagents ? null : '0';
  return out;
}
