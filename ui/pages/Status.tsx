import type { AdapterStatus, StatusInfo } from '../../src/core/api-types';
import { DataTable, type Column } from '../components/DataTable';
import { Async } from '../components/States';
import { useApi } from '../lib/api';
import { formatBytes, formatDate, formatDateTime, formatTokens, relativeTime } from '../lib/format';

export function Status({ refreshKey, onRefresh, refreshing, refreshError }: { refreshKey: number; onRefresh(): void; refreshing: boolean; refreshError: string | null }) {
  const state = useApi<StatusInfo>('/api/status', refreshKey);

  const cols: Column<AdapterStatus>[] = [
    { key: 'a', header: 'Agent', render: (r) => <><strong>{r.label}</strong> <span className="muted">({r.id})</span></> },
    {
      key: 's',
      header: 'Detection',
      wrap: true,
      render: (r) =>
        r.installed ? (
          <><span className="tag good">detected</span> <span className="muted">{r.detail}</span></>
        ) : (
          <><span className="tag">not installed</span> <span className="muted">history is kept{r.events === 0 ? ' (none yet)' : ''}</span></>
        ),
    },
    { key: 'e', header: 'Events', num: true, render: (r) => r.events.toLocaleString() },
    { key: 'r', header: 'Data range', render: (r) => (r.firstTs && r.lastTs ? `${formatDate(r.firstTs)} → ${formatDate(r.lastTs)}` : '–') },
    { key: 'i', header: 'Last ingest', render: (r) => (r.lastIngestAt ? relativeTime(r.lastIngestAt) : '–') },
    { key: 'x', header: 'Problems', wrap: true, render: (r) => (r.error ? <span className="tag bad">{r.error}</span> : <span className="muted">none</span>) },
  ];

  return (
    <>
      <h1>Status</h1>
      <p className="muted">Everything here is detected and refreshed automatically; there is nothing to configure. New agents appear as soon as their adapter finds data.</p>
      <p>
        <button className="btn primary" onClick={onRefresh} disabled={refreshing}>{refreshing ? 'Refreshing…' : 'Refresh data now'}</button>
        <span aria-live="polite" className="muted" style={{ marginLeft: 10 }}>{refreshing ? 'Reading agent data and checking prices…' : ''}</span>
      </p>
      {refreshError && <div className="banner bad" role="alert">{refreshError}</div>}
      <Async state={state} what="status">
        {(s) => (
          <div className="grid">
            <section className="card">
              <DataTable caption="Coding agents" columns={cols} rows={s.adapters} rowKey={(r) => r.id} />
            </section>
            <section className="card">
              <h2>Prices</h2>
              {s.pricing.latestSnapshotAt === null ? (
                <div className="banner">No price list saved yet. Press “Refresh data now”; costs show as unpriced until then.</div>
              ) : (
                <ul>
                  <li>Newest price list saved {formatDateTime(s.pricing.latestSnapshotAt)} ({relativeTime(s.pricing.latestSnapshotAt)}) · {s.pricing.snapshots} saved version{s.pricing.snapshots === 1 ? '' : 's'}</li>
                  <li>{s.pricing.modelsPriced.toLocaleString()} models priced</li>
                  <li>{s.pricing.stale ? <span className="tag warn">stale</span> : <span className="tag good">up to date</span>} The list is re-checked automatically when it is over a day old.</li>
                </ul>
              )}
              {s.pricing.lastError && <div className="banner bad" role="alert">Last price check failed: {s.pricing.lastError}. The previous list is still used.</div>}
            </section>
            <section className="card">
              <h2>Models without a price</h2>
              {s.unmappedModels.length === 0 ? (
                <p className="muted">Every model seen so far was matched to a price.</p>
              ) : (
                <>
                  <p className="muted">These ids could not be matched yet. Their tokens are counted; their cost is left out of totals. They are retried automatically after each price refresh.</p>
                  <DataTable
                    caption="Unmapped model ids"
                    columns={[
                      { key: 'raw', header: 'Model id as recorded', wrap: true, render: (r: StatusInfo['unmappedModels'][number]) => <code>{r.raw}</code> },
                      { key: 'e', header: 'Calls', num: true, render: (r) => r.events.toLocaleString() },
                      { key: 't', header: 'Tokens', num: true, render: (r) => formatTokens(r.tokens) },
                    ]}
                    rows={s.unmappedModels}
                    rowKey={(r) => r.raw}
                  />
                </>
              )}
            </section>
            <section className="card">
              <h2>Database</h2>
              <p><code>{s.db.path}</code> · {formatBytes(s.db.sizeBytes)}</p>
            </section>
          </div>
        )}
      </Async>
    </>
  );
}
