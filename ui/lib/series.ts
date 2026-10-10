import type { SeriesPoint } from '../../src/core/api-types';

export type Metric = 'cost' | 'tokens';

export interface Pivoted {
  keys: string[];
  rows: Array<Record<string, number | string>>;
}

export function pointValue(p: SeriesPoint, metric: Metric): number {
  return metric === 'cost' ? p.costUsd : p.inputTokens + p.outputTokens + p.cacheReadTokens + p.cacheWriteTokens;
}

/** Wide rows (one per bucket) for stacked charts; keys beyond `topN` collapse into "Other". */
export function pivot(points: readonly SeriesPoint[], metric: Metric, topN = 8): Pivoted {
  const totals = new Map<string, number>();
  for (const p of points) totals.set(p.key, (totals.get(p.key) ?? 0) + pointValue(p, metric));
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const top = new Set(ranked.slice(0, topN));
  const keys = ranked.slice(0, topN);
  const hasOther = ranked.length > topN;
  if (hasOther) keys.push('Other');

  const byBucket = new Map<string, Record<string, number | string>>();
  for (const p of points) {
    const row = byBucket.get(p.bucket) ?? { bucket: p.bucket, ...Object.fromEntries(keys.map((k) => [k, 0])) };
    const k = top.has(p.key) ? p.key : 'Other';
    row[k] = (row[k] as number) + pointValue(p, metric);
    byBucket.set(p.bucket, row);
  }
  const rows = [...byBucket.values()].sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)));
  return { keys, rows };
}
