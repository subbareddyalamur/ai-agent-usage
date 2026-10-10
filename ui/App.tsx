import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FilterOptions } from '../src/core/api-types';
import { FilterBar } from './components/FilterBar';
import { postRefresh, useApi } from './lib/api';
import { filterUpdates, readFilters, toApiQuery, type FilterState } from './lib/filters';
import { useRoute } from './lib/router';
import { Cache } from './pages/Cache';
import { Concepts } from './pages/Concepts';
import { Insights } from './pages/Insights';
import { Models } from './pages/Models';
import { Overview } from './pages/Overview';
import { SessionDetail } from './pages/SessionDetail';
import { Sessions } from './pages/Sessions';
import { Status } from './pages/Status';
import { Tools } from './pages/Tools';

export interface PageProps {
  filters: FilterState;
  /** Query string shared by every /api call on this page. */
  query: string;
  refreshKey: number;
}

const NAV: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'models', label: 'Models' },
  { id: 'cache', label: 'Cache' },
  { id: 'tools', label: 'Tools' },
  { id: 'insights', label: 'Insights' },
  { id: 'concepts', label: 'Concepts' },
  { id: 'status', label: 'Status' },
];

export function App() {
  const route = useRoute();
  const page = route.segments[0] ?? 'overview';
  const filters = useMemo(() => readFilters(route.params), [route.params]);
  const query = useMemo(() => toApiQuery(filters), [filters]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const options = useApi<FilterOptions>('/api/filter-options', refreshKey);

  useEffect(() => {
    const titles: Record<string, string> = { overview: 'Overview', sessions: 'Sessions', models: 'Models', cache: 'Cache', tools: 'Tools', insights: 'Insights', concepts: 'Concepts', status: 'Status' };
    document.title = `${titles[page] ?? 'AI Agent Usage'} · AI Agent Usage`;
  }, [page]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setRefreshError(null);
    postRefresh()
      .then(() => {
        setRefreshKey((k) => k + 1);
        setLastRefreshAt(Date.now());
      })
      .catch((e: unknown) => setRefreshError(e instanceof Error ? e.message : 'Refresh failed'))
      .finally(() => setRefreshing(false));
  }, []);

  const props: PageProps = { filters, query, refreshKey };

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="topbar">
        <span className="brand">AI Agent Usage</span>
        <nav className="nav" aria-label="Pages">
          {NAV.map((n) => (
            <a key={n.id} href={route.hrefFor([n.id])} aria-current={page === n.id ? 'page' : undefined}>
              {n.label}
            </a>
          ))}
        </nav>
      </header>
      {page !== 'concepts' && page !== 'status' && !(page === 'sessions' && route.segments.length >= 3) && (
        <FilterBar
          filters={filters}
          options={options.data}
          onChange={(patch) => route.setParams(filterUpdates(patch))}
          refreshing={refreshing}
          refreshError={refreshError}
          lastRefreshAt={lastRefreshAt}
          onRefresh={onRefresh}
        />
      )}
      <main id="main" tabIndex={-1}>
        {page === 'overview' && <Overview {...props} />}
        {page === 'sessions' && route.segments.length >= 3 && <SessionDetail agent={route.segments[1] as string} sessionId={route.segments[2] as string} refreshKey={refreshKey} />}
        {page === 'sessions' && route.segments.length < 3 && <Sessions {...props} />}
        {page === 'models' && <Models {...props} />}
        {page === 'cache' && <Cache {...props} />}
        {page === 'tools' && <Tools {...props} />}
        {page === 'insights' && <Insights {...props} />}
        {page === 'concepts' && <Concepts section={route.params.get('section')} refreshKey={refreshKey} />}
        {page === 'status' && <Status refreshKey={refreshKey} onRefresh={onRefresh} refreshing={refreshing} refreshError={refreshError} />}
        {!NAV.some((n) => n.id === page) && <p>Page not found. <a href={route.hrefFor(['overview'])}>Go to Overview</a>.</p>}
      </main>
    </>
  );
}
