const compact = (n: number, digits: number): string => n.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');

export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${compact(n / 1e9, 2)}B`;
  if (abs >= 1e6) return `${compact(n / 1e6, 2)}M`;
  if (abs >= 1e4) return `${compact(n / 1e3, 1)}k`;
  return Math.round(n).toLocaleString('en-US');
}

export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–';
  if (n === 0) return '$0.00';
  if (Math.abs(n) < 0.01) return '<$0.01';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 100 ? 0 : 2 });
}

/** Price per 1M tokens: always show enough precision for cheap cache reads. */
export function formatRate(n: number): string {
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

export function formatPct(r: number | null | undefined): string {
  if (r === null || r === undefined) return '–';
  return `${(r * 100).toFixed(r >= 0.995 || r === 0 ? 0 : 1)}%`;
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${compact(n / 1e9, 2)} GB`;
  if (n >= 1e6) return `${compact(n / 1e6, 2)} MB`;
  if (n >= 1e3) return `${compact(n / 1e3, 1)} KB`;
  return `${Math.round(n)} B`;
}

export function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function relativeTime(ts: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function baseName(path: string | null): string {
  if (!path) return '–';
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
