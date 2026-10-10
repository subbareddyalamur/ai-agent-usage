import { useMemo, useState } from 'react';
import type { ToolRow } from '../../src/core/api-types';
import type { PageProps } from '../App';
import { DataTable, type Column, type Sort } from '../components/DataTable';
import { Async, Empty } from '../components/States';
import { useApi } from '../lib/api';
import { formatBytes, formatTokens } from '../lib/format';
import { useRoute } from '../lib/router';

type Key = 'calls' | 'total' | 'avg' | 'max';
const value = (r: ToolRow, k: Key): number => (k === 'calls' ? r.calls : k === 'total' ? r.totalResultBytes : k === 'avg' ? r.avgResultBytes : r.maxResultBytes);

export function Tools({ query, refreshKey }: PageProps) {
  const route = useRoute();
  const state = useApi<ToolRow[]>(`/api/tools?${query}`, refreshKey);
  const group = route.params.get('group');
  const [sort, setSort] = useState<Sort>({ key: 'total', dir: 'desc' });

  const groups = useMemo(() => {
    const m = new Map<string, { calls: number; bytes: number }>();
    for (const t of state.data ?? []) {
      const g = m.get(t.group) ?? { calls: 0, bytes: 0 };
      m.set(t.group, { calls: g.calls + t.calls, bytes: g.bytes + t.totalResultBytes });
    }
    return [...m.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  }, [state.data]);

  const rows = useMemo(() => {
    const all = (state.data ?? []).filter((t) => !group || t.group === group);
    const k = sort.key as Key;
    return [...all].sort((a, b) => (sort.dir === 'asc' ? 1 : -1) * (value(a, k) - value(b, k)));
  }, [state.data, group, sort]);

  const onSort = (key: string) => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }));
  const maxBytes = Math.max(1, ...rows.map((r) => r.totalResultBytes));

  const cols: Column<ToolRow>[] = [
    { key: 'name', header: 'Tool', wrap: true, render: (r) => <code>{r.name}</code> },
    { key: 'group', header: 'Source', hint: 'built-in tool or the MCP server it comes from', render: (r) => <span className="tag">{r.group}</span> },
    { key: 'agents', header: 'Agents', wrap: true, render: (r) => r.agents.join(', ') },
    { key: 'calls', header: 'Calls', num: true, sortKey: 'calls', render: (r) => r.calls.toLocaleString() },
    {
      key: 'total',
      header: 'Total result size',
      num: true,
      sortKey: 'total',
      hint: 'How much text the tool sent back into the conversation. Every later step re-sends it.',
      render: (r) => (
        <span title={`≈ ${formatTokens(r.totalResultBytes / 4)} tokens (rough: 4 bytes per token)`}>
          {formatBytes(r.totalResultBytes)}
          <span className="bar" style={{ height: 4, margin: '3px 0 0', width: 80, marginLeft: 'auto' }} aria-hidden="true"><span style={{ width: `${(r.totalResultBytes / maxBytes) * 100}%`, background: '#6ea8fe' }} /></span>
        </span>
      ),
    },
    { key: 'avg', header: 'Avg result', num: true, sortKey: 'avg', render: (r) => formatBytes(r.avgResultBytes) },
    { key: 'max', header: 'Largest result', num: true, sortKey: 'max', render: (r) => formatBytes(r.maxResultBytes) },
  ];

  return (
    <>
      <h1>Tools</h1>
      <p className="muted prose">
        Tool results are appended to the conversation and re-sent on every later step, so big results are expensive repeatedly. Sizes are bytes of text; token counts are a rough estimate.
        See <a href={route.hrefFor(['concepts'], { section: 'tools' })}>Tools &amp; MCP</a>.
      </p>
      <Async state={state} what="tools">
        {(all) =>
          all.length === 0 ? (
            <Empty title="No tool calls in this range" />
          ) : (
            <>
              <div className="controls" role="group" aria-label="Filter by source">
                <div className="seg">
                  <button type="button" aria-pressed={!group} onClick={() => route.setParams({ group: null })}>All sources</button>
                  {groups.map(([g, v]) => (
                    <button type="button" key={g} aria-pressed={group === g} onClick={() => route.setParams({ group: g })} title={`${v.calls.toLocaleString()} calls · ${formatBytes(v.bytes)}`}>
                      {g}
                    </button>
                  ))}
                </div>
              </div>
              <section className="card">
                <DataTable caption={`${rows.length} tools`} columns={cols} rows={rows} rowKey={(r) => r.name} sort={sort} onSort={onSort} />
              </section>
            </>
          )
        }
      </Async>
    </>
  );
}
