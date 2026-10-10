import { fmtPct, fmtTokens, fmtUsd } from '../insights/kit';

export { fmtPct, fmtTokens };

/** Costs are list-price estimates; the leading "~" says so everywhere they are shown. */
export const fmtCost = (usd: number): string => `~${fmtUsd(usd)}`;

export function fmtHit(ratio: number | null): string {
  return ratio === null ? '-' : fmtPct(ratio);
}

export function fmtDate(ts: number | null): string {
  return ts === null ? '-' : new Date(ts).toISOString().slice(0, 10);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export type Align = 'l' | 'r';

/** Plain aligned text table: header, rule, rows. */
export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[], align: readonly Align[]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const cell = (text: string, i: number): string =>
    align[i] === 'r' ? text.padStart(widths[i] as number) : text.padEnd(widths[i] as number);
  const line = (cells: readonly string[]): string => cells.map(cell).join('  ').trimEnd();
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map((r) => line(r))].join('\n');
}
