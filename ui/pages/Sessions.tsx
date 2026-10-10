import type { SessionRow } from '../../src/core/api-types';
import type { PageProps } from '../App';
import { DataTable, type Column } from '../components/DataTable';
import { Async, Empty } from '../components/States';
import { useApi } from '../lib/api';
import { baseName, formatDateTime, formatPct, formatTokens, formatUsd } from '../lib/format';
import { useRoute } from '../lib/router';

const PAGE_SIZE = 25;
const SORTS = new Set(['cost', 'ts', 'context', 'cacheHit', 'steps']);

export function Sessions({ query, refreshKey }: PageProps) {
  const route = useRoute();
  const rawSort = route.params.get('sort') ?? 'ts';
  const sort = SORTS.has(rawSort) ? rawSort : 'ts';
  const dir = route.params.get('dir') === 'asc' ? 'asc' : 'desc';
  const page = Math.max(1, Number(route.params.get('page') ?? '1') || 1);

  const state = useApi<{ rows: SessionRow[]; total: number }>(
    `/api/sessions?${query}&sort=${sort}&dir=${dir}&limit=${PAGE_SIZE}&offset=${(page - 1) * PAGE_SIZE}`,
    refreshKey,
  );

  const onSort = (key: string) =>
    route.setParams({ sort: key, dir: key === sort && dir === 'desc' ? 'asc' : 'desc', page: null });

  const cols: Column<SessionRow>[] = [
    { key: 'ts', header: 'Last active', sortKey: 'ts', render: (r) => formatDateTime(r.lastTs) },
    { key: 'agent', header: 'Agent', render: (r) => r.agent },
    {
      key: 'title',
      header: 'Session',
      wrap: true,
      render: (r) => (
        <a href={route.hrefFor(['sessions', r.agent, r.sessionId])}>{r.title || r.sessionId}</a>
      ),
    },
    { key: 'project', header: 'Project', render: (r) => <span title={r.project ?? undefined}>{baseName(r.project)}</span> },
    {
      key: 'models',
      header: 'Models',
      render: (r) => <span title={r.models.join(', ')}>{r.models[0] ?? '–'}{r.models.length > 1 ? ` +${r.models.length - 1}` : ''}</span>,
    },
    {
      key: 'steps',
      header: 'Steps',
      num: true,
      sortKey: 'steps',
      render: (r) => (r.totalOnly ? <span className="tag" title="Only session totals exist for this session">totals only</span> : r.steps.toLocaleString()),
    },
    { key: 'ctx', header: 'Peak context', num: true, sortKey: 'context', hint: 'Largest single prompt in the session', render: (r) => (r.totalOnly ? '–' : formatTokens(r.peakContext)) },
    {
      key: 'hit',
      header: 'Cache hit',
      num: true,
      sortKey: 'cacheHit',
      render: (r) => {
        const h = r.totals.cacheHitRatio;
        return <span className={h !== null && h < 0.05 && r.totals.inputTokens > 100_000 ? 'tag bad' : undefined}>{formatPct(h)}</span>;
      },
    },
    { key: 'cost', header: 'Est. cost', num: true, sortKey: 'cost', render: (r) => formatUsd(r.totals.costUsd) },
  ];

  return (
    <>
      <h1>Sessions</h1>
      <Async state={state} what="sessions">
        {({ rows, total }) =>
          rows.length === 0 ? (
            <Empty title="No sessions in this range" />
          ) : (
            <section className="card">
              <DataTable
                caption={`${total.toLocaleString()} sessions · click a column header to sort`}
                columns={cols}
                rows={rows}
                rowKey={(r) => `${r.agent}/${r.sessionId}`}
                sort={{ key: sort, dir }}
                onSort={onSort}
              />
              <div className="pager">
                <button className="btn" disabled={page <= 1} onClick={() => route.setParams({ page: page <= 2 ? null : String(page - 1) })}>
                  Previous
                </button>
                <span>
                  Page {page} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}
                </span>
                <button className="btn" disabled={page * PAGE_SIZE >= total} onClick={() => route.setParams({ page: String(page + 1) })}>
                  Next
                </button>
              </div>
            </section>
          )
        }
      </Async>
    </>
  );
}
