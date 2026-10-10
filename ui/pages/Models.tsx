import type { ModelRow } from '../../src/core/api-types';
import type { PageProps } from '../App';
import { DataTable, type Column } from '../components/DataTable';
import { Async, Empty } from '../components/States';
import { useApi } from '../lib/api';
import { formatPct, formatRate, formatTokens, formatUsd } from '../lib/format';
import { useRoute } from '../lib/router';

const rate = (r: ModelRow, pick: (x: NonNullable<ModelRow['rates']>) => number) => (r.rates ? formatRate(pick(r.rates)) : '–');
const prompt = (r: ModelRow) => r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;

export function Models({ query, refreshKey }: PageProps) {
  const route = useRoute();
  const state = useApi<ModelRow[]>(`/api/models?${query}`, refreshKey);

  const cols: Column<ModelRow>[] = [
    {
      key: 'm',
      header: 'Model',
      wrap: true,
      render: (r) => (
        <>
          {r.model}{' '}
          {!r.priced && <span className="tag warn" title="No price found in any snapshot. Tokens are counted, cost is not.">unpriced</span>}
        </>
      ),
    },
    { key: 'tier', header: 'Rate tier', hint: 'Regional or global price list used for this model', render: (r) => <span className="tag">{r.tier}</span> },
    { key: 'agents', header: 'Agents', wrap: true, render: (r) => r.agents.join(', ') },
    { key: 'calls', header: 'Calls', num: true, render: (r) => r.events.toLocaleString() },
    { key: 'prompt', header: 'Prompt tokens', num: true, hint: 'fresh input + cache read + cache write', render: (r) => formatTokens(prompt(r)) },
    { key: 'out', header: 'Output', num: true, render: (r) => formatTokens(r.outputTokens + r.reasoningTokens) },
    { key: 'hit', header: 'Cache hit', num: true, render: (r) => formatPct(r.cacheHitRatio) },
    { key: 'ctx', header: 'Avg context', num: true, render: (r) => formatTokens(r.avgContext) },
    { key: 'cost', header: 'Est. cost', num: true, render: (r) => (r.priced ? formatUsd(r.costUsd) : <span className="muted">unpriced</span>) },
  ];
  const rateCols: Column<ModelRow>[] = [
    { key: 'm', header: 'Model', wrap: true, render: (r) => r.model },
    { key: 'in', header: 'Input', num: true, render: (r) => rate(r, (x) => x.input) },
    { key: 'out', header: 'Output', num: true, render: (r) => rate(r, (x) => x.output) },
    { key: 'cr', header: 'Cache read', num: true, render: (r) => rate(r, (x) => x.cacheRead) },
    { key: 'c5', header: 'Cache write 5m', num: true, render: (r) => rate(r, (x) => x.cacheWrite5m) },
    { key: 'c1', header: 'Cache write 1h', num: true, render: (r) => rate(r, (x) => x.cacheWrite1h) },
  ];

  return (
    <>
      <h1>Models</h1>
      <Async state={state} what="models">
        {(rows) =>
          rows.length === 0 ? (
            <Empty title="No models in this range" />
          ) : (
            <>
              <section className="card">
                <DataTable caption="Usage per model (costs are estimates)" columns={cols} rows={rows} rowKey={(r) => r.model} />
              </section>
              <section className="card" style={{ marginTop: 14 }}>
                <h2>Current rates, USD per 1M tokens</h2>
                <p className="muted">
                  Read from the newest saved AWS price list. Past usage keeps the price that was in effect at the time. Why cache reads and writes differ:{' '}
                  <a href={route.hrefFor(['concepts'], { section: 'prompt-caching' })}>prompt caching</a>.
                </p>
                <DataTable caption="Rates" columns={rateCols} rows={rows.filter((r) => r.rates)} rowKey={(r) => r.model} />
              </section>
            </>
          )
        }
      </Async>
    </>
  );
}
