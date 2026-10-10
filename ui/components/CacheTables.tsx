import type { CacheMissStep, CacheModelRow, CacheReasonRow, CacheSessionRow } from '../../src/core/api-types';
import { formatDuration, REASON_LABEL, sortReasons } from '../lib/cache';
import { formatDateTime, formatPct, formatTokens, formatUsd } from '../lib/format';
import { DataTable, type Column } from './DataTable';
import { ReasonTag } from './ReasonTag';

type Href = (segments: readonly string[], extra?: Record<string, string | null>) => string;

const cost = (v: number | null) => (v === null ? <span className="muted">unpriced</span> : formatUsd(v));

export function ReasonsTable({ rows, conceptsHref }: { rows: readonly CacheReasonRow[]; conceptsHref: string }) {
  const cols: Column<CacheReasonRow>[] = [
    { key: 'r', header: 'Reason', render: (r) => <ReasonTag reason={r.reason} avoidable={r.avoidable} /> },
    { key: 's', header: 'Steps', num: true, render: (r) => r.steps.toLocaleString() },
    { key: 't', header: 'Missed tokens', num: true, hint: 'Prompt tokens re-sent at write/full price that a cache read could have served', render: (r) => formatTokens(r.missTokens) },
    { key: 'c', header: 'Extra cost', num: true, hint: 'Estimate: what those tokens cost beyond a cache read', render: (r) => (r.avoidable ? formatUsd(r.extraCostUsd) : <span className="muted" title="Normally unavoidable, shown for reference">{formatUsd(r.extraCostUsd)}</span>) },
    { key: 'e', header: 'What it means', wrap: true, render: (r) => <span className="explain">{r.explanation}</span> },
  ];
  return (
    <>
      <DataTable caption="Reasons, avoidable ones first" columns={cols} rows={sortReasons(rows)} rowKey={(r) => r.reason} />
      <p className="muted">Not sure what to do about a reason? <a href={conceptsHref}>Read the explanations</a>.</p>
    </>
  );
}

export function CacheModelsTable({ rows }: { rows: readonly CacheModelRow[] }) {
  const cols: Column<CacheModelRow>[] = [
    {
      key: 'm', header: 'Model', wrap: true,
      render: (r) => (
        <>
          {r.model}{' '}
          {!r.cacheSeen && <span className="tag bad" title="No cache read or write was ever recorded for this model in this range: caching is probably not engaging.">caching never observed</span>}
        </>
      ),
    },
    { key: 's', header: 'Steps', num: true, render: (r) => r.steps.toLocaleString() },
    { key: 'p', header: 'Prompt tokens', num: true, render: (r) => formatTokens(r.promptTokens) },
    { key: 'h', header: 'Hit ratio', num: true, render: (r) => formatPct(r.hitRatio) },
    { key: 'mt', header: 'Missed tokens', num: true, render: (r) => formatTokens(r.missTokens) },
    { key: 'c', header: 'Extra cost', num: true, render: (r) => formatUsd(r.extraCostUsd) },
  ];
  return <DataTable caption="By model" columns={cols} rows={rows} rowKey={(r) => r.model} />;
}

export function CacheSessionsTable({ rows, href }: { rows: readonly CacheSessionRow[]; href: Href }) {
  const cols: Column<CacheSessionRow>[] = [
    { key: 't', header: 'Session', wrap: true, render: (r) => <a href={href(['sessions', r.agent, r.sessionId])}>{r.title || r.sessionId}</a> },
    { key: 'a', header: 'Agent', render: (r) => r.agent },
    { key: 's', header: 'Steps', num: true, render: (r) => r.steps.toLocaleString() },
    { key: 'ms', header: 'Missed steps', num: true, render: (r) => r.missSteps.toLocaleString() },
    { key: 'h', header: 'Hit ratio', num: true, render: (r) => formatPct(r.hitRatio) },
    { key: 'd', header: 'Main reason', render: (r) => (r.dominantReason ? REASON_LABEL[r.dominantReason] : '–') },
    { key: 'c', header: 'Extra cost', num: true, render: (r) => formatUsd(r.extraCostUsd) },
  ];
  return <DataTable caption="Sessions with the most avoidable cost" columns={cols} rows={rows} rowKey={(r) => `${r.agent}/${r.sessionId}`} />;
}

export function RecentMissesTable({ rows, href }: { rows: readonly CacheMissStep[]; href: Href }) {
  const cols: Column<CacheMissStep>[] = [
    { key: 'ts', header: 'Time', render: (r) => formatDateTime(r.ts) },
    { key: 's', header: 'Session', wrap: true, render: (r) => <a href={href(['sessions', r.agent, r.sessionId])}>{r.title || r.sessionId}</a> },
    { key: 'm', header: 'Model', wrap: true, render: (r) => r.model },
    { key: 'r', header: 'Reason', render: (r) => <ReasonTag reason={r.reason} avoidable={r.avoidable} /> },
    { key: 'g', header: 'Gap', num: true, hint: 'Time since the previous call in the same conversation', render: (r) => formatDuration(r.gapMs) },
    { key: 'p', header: 'Prompt', num: true, render: (r) => formatTokens(r.promptTokens) },
    { key: 'mt', header: 'Missed', num: true, render: (r) => formatTokens(r.missTokens) },
    { key: 'c', header: 'Extra cost', num: true, render: (r) => cost(r.extraCostUsd) },
  ];
  return <DataTable caption="Recent avoidable misses (newest first)" columns={cols} rows={rows} rowKey={(r) => `${r.agent}/${r.sessionId}/${r.ts}/${r.model}`} />;
}
