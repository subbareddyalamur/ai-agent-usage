import { useCallback, useMemo } from 'react';
import type { SeriesPoint, SummaryResult, Totals } from '../../src/core/api-types';
import type { PageProps } from '../App';
import { DataTable, type Column } from '../components/DataTable';
import { LiveIndicator } from '../components/LiveIndicator';
import { EstTag, Kpi } from '../components/Kpi';
import { Seg } from '../components/Seg';
import { StackedBars } from '../components/StackedBars';
import { Empty, ErrorBox, Loading } from '../components/States';
import { getJson } from '../lib/api';
import { toApiQuery } from '../lib/filters';
import { usePolling } from '../lib/usePolling';
import { TOKEN_COLORS } from '../lib/colors';
import { formatPct, formatTokens, formatUsd } from '../lib/format';
import { pivot, type Metric, type Pivoted } from '../lib/series';
import { useRoute } from '../lib/router';

type Bucket = 'day' | 'week' | 'month';
type Split = 'model' | 'agent';

function TokenBar({ t }: { t: Totals }) {
  const parts = [
    { label: 'Fresh input', value: t.inputTokens, color: TOKEN_COLORS.input, tip: 'Prompt tokens sent at full price' },
    { label: 'Output', value: t.outputTokens + t.reasoningTokens, color: TOKEN_COLORS.output, tip: 'Tokens the model wrote (includes reasoning)' },
    { label: 'Cache read', value: t.cacheReadTokens, color: TOKEN_COLORS.cacheRead, tip: 'Prompt tokens served from cache at a steep discount' },
    { label: 'Cache write', value: t.cacheWriteTokens, color: TOKEN_COLORS.cacheWrite, tip: 'Prompt tokens stored in the cache (priced above normal input)' },
  ];
  const total = parts.reduce((a, p) => a + p.value, 0) || 1;
  return (
    <>
      <div className="bar" role="img" aria-label={parts.map((p) => `${p.label} ${formatPct(p.value / total)}`).join(', ')}>
        {parts.map((p) => (
          <span key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <div className="legendrow">
        {parts.map((p) => (
          <span key={p.label} title={p.tip}>
            <i className="dot" style={{ background: p.color }} />
            {p.label} {formatTokens(p.value)} ({formatPct(p.value / total)})
          </span>
        ))}
      </div>
    </>
  );
}

const money = (t: Totals) => (t.unpricedEvents > 0 && t.costUsd === 0 ? <span className="muted">unpriced</span> : formatUsd(t.costUsd));
const totalTokens = (t: Totals) => t.inputTokens + t.outputTokens + t.reasoningTokens + t.cacheReadTokens + t.cacheWriteTokens;

const modelCols: Column<SummaryResult['byModel'][number]>[] = [
  { key: 'm', header: 'Model', render: (r) => <>{r.model} {!r.priced && <span className="tag warn" title="No price found: usage is counted but cost is not.">unpriced</span>}</> },
  { key: 'c', header: 'Calls', num: true, render: (r) => r.events.toLocaleString() },
  { key: 't', header: 'Tokens', num: true, render: (r) => formatTokens(totalTokens(r)) },
  { key: 'h', header: 'Cache hit', num: true, render: (r) => formatPct(r.cacheHitRatio) },
  { key: 'u', header: 'Est. cost', num: true, render: (r) => money(r) },
];
const agentCols: Column<SummaryResult['byAgent'][number]>[] = [
  { key: 'a', header: 'Agent', render: (r) => r.agent },
  { key: 'c', header: 'Calls', num: true, render: (r) => r.events.toLocaleString() },
  { key: 't', header: 'Tokens', num: true, render: (r) => formatTokens(totalTokens(r)) },
  { key: 'h', header: 'Cache hit', num: true, render: (r) => formatPct(r.cacheHitRatio) },
  { key: 'u', header: 'Est. cost', num: true, render: (r) => money(r) },
];

interface BodyProps {
  s: SummaryResult;
  data: Pivoted;
  metric: Metric;
  split: Split;
  bucket: Bucket;
}

function OverviewBody({ s, data, metric, split, bucket }: BodyProps) {
  const route = useRoute();
  if (s.totals.events === 0) {
    return <Empty title="No usage in this range">Try a wider date range, clear the agent/model filters, or wait for new usage.</Empty>;
  }
  return (
    <>
      {s.totals.unpricedTokens > 0 && (
        <div className="banner" role="status">
          <strong>{formatTokens(s.totals.unpricedTokens)} tokens ({s.totals.unpricedEvents.toLocaleString()} calls) have no price</strong> and are
          not in the cost total (they are not counted as $0, either). See <a href={route.hrefFor(['status'])}>Status</a> for which models.
        </div>
      )}
      <div className="grid kpis">
        <Kpi label="Cost" tag={<EstTag />} value={formatUsd(s.totals.costUsd)} hint="priced usage only, at the price in effect when each call happened" />
        <Kpi label="Cache hit rate" value={formatPct(s.totals.cacheHitRatio)} hint={<>share of prompt tokens served from cache · <a href={route.hrefFor(['cache'])}>see cache misses</a></>} tag={s.totals.cacheHitRatio !== null && s.totals.cacheHitRatio < 0.3 ? <span className="tag bad">low</span> : undefined} />
        <Kpi label="Sessions" value={s.totals.sessions.toLocaleString()} hint={`${s.totals.events.toLocaleString()} model calls`} />
        <div className="card kpi">
          <h3>Tokens {formatTokens(totalTokens(s.totals))}</h3>
          <TokenBar t={s.totals} />
        </div>
      </div>
      <section className="card" aria-labelledby="trend">
        <h2 id="trend">{metric === 'cost' ? 'Estimated cost' : 'Tokens'} per {bucket}, by {split}</h2>
        <div className="controls">
          <Seg<Metric> label="Show" value={metric} onChange={(v) => route.setParams({ metric: v === 'cost' ? null : v })} options={[{ id: 'cost', label: 'Cost' }, { id: 'tokens', label: 'Tokens' }]} />
          <Seg<Split> label="Split by" value={split} onChange={(v) => route.setParams({ split: v === 'model' ? null : v })} options={[{ id: 'model', label: 'Model' }, { id: 'agent', label: 'Agent' }]} />
          <Seg<Bucket> label="Group by" value={bucket} onChange={(v) => route.setParams({ bucket: v === 'day' ? null : v })} options={[{ id: 'day', label: 'Day' }, { id: 'week', label: 'Week' }, { id: 'month', label: 'Month' }]} />
        </div>
        {data.rows.length === 0 ? <Empty title="Nothing to chart" /> : <StackedBars data={data} metric={metric} label={`Stacked bar chart of ${metric} per ${bucket} split by ${split}`} />}
      </section>
      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <section className="card"><DataTable caption="By model" columns={modelCols} rows={s.byModel} rowKey={(r) => r.model} /></section>
        <section className="card"><DataTable caption="By agent" columns={agentCols} rows={s.byAgent} rowKey={(r) => r.agent} /></section>
      </div>
    </>
  );
}

export function Overview({ filters, refreshKey }: PageProps) {
  const route = useRoute();
  const metric: Metric = route.params.get('metric') === 'tokens' ? 'tokens' : 'cost';
  const split: Split = route.params.get('split') === 'agent' ? 'agent' : 'model';
  const rawBucket = route.params.get('bucket');
  const bucket: Bucket = rawBucket === 'week' || rawBucket === 'month' ? rawBucket : 'day';

  // Recomputed on every tick so relative presets ("Today", "7 days"...) slide forward with the clock.
  const fetcher = useCallback(
    async (signal: AbortSignal) => {
      const q = toApiQuery(filters, new Date());
      const [summary, series] = await Promise.all([
        getJson<SummaryResult>(`/api/summary?${q}`, signal),
        getJson<SeriesPoint[]>(`/api/series?${q}&bucket=${bucket}&split=${split}`, signal),
      ]);
      return { summary, series };
    },
    [filters, bucket, split],
  );
  const poll = usePolling(fetcher, `${JSON.stringify(filters)}|${bucket}|${split}|${refreshKey}`);
  const summary = poll.data?.summary ?? null;
  const data = useMemo(() => pivot(poll.data?.series ?? [], metric), [poll.data, metric]);

  return (
    <>
      <div className="pagehead">
        <h1>Overview</h1>
        <LiveIndicator poll={poll} />
      </div>
      {poll.error && summary !== null && (
        <div className="banner" role="status">Live updates are failing ({poll.error}); showing the last good data and retrying.</div>
      )}
      {poll.error && summary === null && <ErrorBox message={poll.error} onRetry={poll.refetch} />}
      {!poll.error && summary === null && <Loading what="summary" />}
      {summary !== null && (
        <div className={poll.refreshing ? 'refreshing' : undefined} aria-busy={poll.refreshing}>
          <OverviewBody s={summary} data={data} metric={metric} split={split} bucket={bucket} />
        </div>
      )}
    </>
  );
}
