import type { CacheReport } from '../../src/core/api-types';
import type { PageProps } from '../App';
import { CacheModelsTable, CacheSessionsTable, ReasonsTable, RecentMissesTable } from '../components/CacheTables';
import { HitTrend } from '../components/HitTrend';
import { EstTag, Kpi } from '../components/Kpi';
import { Async, Empty } from '../components/States';
import { useApi } from '../lib/api';
import { formatDuration, ttlSourceLabel } from '../lib/cache';
import { formatPct, formatTokens, formatUsd } from '../lib/format';
import { useRoute } from '../lib/router';

export function Cache({ query, refreshKey }: PageProps) {
  const route = useRoute();
  const state = useApi<CacheReport>(`/api/cache?${query}`, refreshKey);
  const concepts = route.hrefFor(['concepts'], { section: 'cache-misses' });

  return (
    <>
      <h1>Cache misses</h1>
      <p className="muted">
        Every step re-sends the whole conversation. When the provider's cache serves most of it you pay a fraction of the price; a <em>miss</em> means those tokens were
        processed again at full or write price. Some misses are unavoidable (the first call of a conversation), others show a fixable pattern.
      </p>
      <Async state={state} what="cache report">
        {(r) =>
          r.totals.steps === 0 ? (
            <Empty title="No steps in this range">Try a wider date range or clear the agent/model filters.</Empty>
          ) : (
            <>
              <div className="grid kpis">
                <Kpi label="Cache hit ratio" value={formatPct(r.totals.hitRatio)} hint={`${formatTokens(r.totals.cacheReadTokens)} of ${formatTokens(r.totals.promptTokens)} prompt tokens`} />
                <Kpi label="Avoidable misses" value={formatTokens(r.totals.avoidableMissTokens)} hint={`tokens · ${formatTokens(r.totals.unavoidableTokens)} more were unavoidable (cold starts, resets)`} />
                <Kpi label="Extra cost" tag={<EstTag />} value={formatUsd(r.totals.extraCostUsd)} hint="avoidable misses vs. serving them as cache reads" />
                <Kpi label="Cache lifetime" value={formatDuration(r.totals.ttlMs)} hint={ttlSourceLabel(r.totals.ttlSource)} />
              </div>
              <section className="card" aria-labelledby="why">
                <h2 id="why">Why misses happen</h2>
                <ReasonsTable rows={r.reasons} conceptsHref={concepts} />
              </section>
              <section className="card" aria-labelledby="trend" style={{ marginTop: 14 }}>
                <h2 id="trend">Hit ratio by day</h2>
                {r.days.length === 0 ? <Empty title="Nothing to chart" /> : <HitTrend days={r.days} />}
              </section>
              <section className="card" style={{ marginTop: 14 }}><CacheModelsTable rows={r.models} /></section>
              <section className="card" style={{ marginTop: 14 }}>
                {r.sessions.length === 0 ? <p className="muted">No session has avoidable misses in this range.</p> : <CacheSessionsTable rows={r.sessions} href={route.hrefFor} />}
              </section>
              <section className="card" style={{ marginTop: 14 }}>
                {r.recent.length === 0 ? <p className="muted">No avoidable misses in this range.</p> : <RecentMissesTable rows={r.recent} href={route.hrefFor} />}
              </section>
            </>
          )
        }
      </Async>
    </>
  );
}
