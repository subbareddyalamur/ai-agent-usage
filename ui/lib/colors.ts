const PALETTE = ['#6ea8fe', '#7ee0b5', '#f5c26b', '#f28b82', '#c4a1ff', '#5ad1d1', '#ff9f68', '#9db4c8'] as const;
export const OTHER_COLOR = '#667386';

export const TOKEN_COLORS = {
  input: '#f28b82',
  output: '#c4a1ff',
  cacheRead: '#7ee0b5',
  cacheWrite: '#f5c26b',
} as const;

/** Stable colour per series key within one chart (ordered by caller). */
export function colorFor(key: string, ordered: readonly string[]): string {
  if (key === 'Other') return OTHER_COLOR;
  const i = ordered.indexOf(key);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length] as string;
}
