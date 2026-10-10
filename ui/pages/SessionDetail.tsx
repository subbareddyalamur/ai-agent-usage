import { useMemo, useState } from 'react';
import type { SessionDetail as Detail } from '../../src/core/api-types';
import { DataTable, type Column } from '../components/DataTable';
import { EstTag, Kpi } from '../components/Kpi';
import { ReasonTag } from '../components/ReasonTag';
import { StepTimeline } from '../components/StepTimeline';
import { Async } from '../components/States';
import { useApi } from '../lib/api';
import { baseName, formatBytes, formatDateTime, formatPct, formatTokens, formatUsd } from '../lib/format';
import { useRoute } from '../lib/router';

interface ToolAgg {
  name: string;
  calls: number;
  bytes: number;
}

function aggregateTools(d: Detail): ToolAgg[] {
  const m = new Map<string, ToolAgg>();
  for (const s of d.steps)
    for (const t of s.tools) {
      const a = m.get(t.name) ?? { name: t.name, calls: 0, bytes: 0 };
      m.set(t.name, { name: t.name, calls: a.calls + 1, bytes: a.bytes + (t.resultBytes ?? 0) });
    }
  return [...m.values()].sort((a, b) => b.bytes - a.bytes);
}

export function SessionDetail({ agent, sessionId, refreshKey }: { agent: string; sessionId: string; refreshKey: number }) {
  const route = useRoute();
  const state = useApi<Detail>(`/api/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(sessionId)}`, refreshKey);
  const tools = useMemo(() => (state.data ? aggregateTools(state.data) : []), [state.data]);
  // Subagents run with their own, smaller context, so mixing them into one context-size chart is misleading.
  const [showSub, setShowSub] = useState(false);

  const toolCols: Column<ToolAgg>[] = [
    { key: 'n', header: 'Tool', render: (r) => r.name },
    { key: 'c', header: 'Calls', num: true, render: (r) => r.calls },
    { key: 'b', header: 'Result size', num: true, hint: 'Total size of what the tool sent back into the context', render: (r) => formatBytes(r.bytes) },
  ];

  return (
    <>
      <p className="crumbs"><a href={route.hrefFor(['sessions'])}>← All sessions</a></p>
      <Async state={state} what="session">
        {(d) => {
          const r = d.row;
          return (
            <>
              <h1>{r.title || r.sessionId}</h1>
              <p className="muted">
                {r.agent} · {baseName(r.project)} · {formatDateTime(r.firstTs)} → {formatDateTime(r.lastTs)} · {r.models.join(', ')}
                {r.hasSubagents && <> · <span className="tag">includes subagents</span></>}
              </p>
              {r.totalOnly && (
                <div className="banner info" role="status">This session only has totals (no per-step data), so there is no timeline. Older opencode history looks like this.</div>
              )}
              <div className="grid kpis">
                <Kpi label="Cost" tag={<EstTag />} value={formatUsd(r.totals.costUsd)} />
                <Kpi label="Cache hit rate" value={formatPct(r.totals.cacheHitRatio)} hint="cache read ÷ all prompt tokens" />
                <Kpi label="Peak context" value={formatTokens(r.peakContext)} hint="largest single prompt" />
                <Kpi label="Steps" value={r.steps.toLocaleString()} hint="model calls" />
              </div>
              {!r.totalOnly && d.steps.length > 0 && (
                <section className="card" aria-labelledby="tl">
                  <h2 id="tl">Prompt size per step</h2>
                  <p className="muted">
                    Every step re-sends the whole conversation. <span style={{ color: '#7ee0b5' }}>Cache read</span> is cheap, <span style={{ color: '#f5c26b' }}>cache write</span> costs a bit
                    more than normal input, and <span style={{ color: '#f28b82' }}>fresh input</span> is full price. A growing red area means caching is not working.
                    Drops are compactions. <a href={route.hrefFor(['concepts'], { section: 'context-growth' })}>Learn more</a>.
                  </p>
                  {r.hasSubagents && (
                    <label className="check">
                      <input type="checkbox" checked={showSub} onChange={(e) => setShowSub(e.target.checked)} />
                      Show subagent steps ({d.steps.filter((x) => x.isSubagent).length} steps, {formatUsd(d.steps.filter((x) => x.isSubagent).reduce((a, x) => a + (x.costUsd ?? 0), 0))}; always included in the cost above)
                    </label>
                  )}
                  <StepTimeline steps={showSub ? d.steps : d.steps.filter((x) => !x.isSubagent)} />
                </section>
              )}
              <div className="grid cols-2" style={{ marginTop: 14 }}>
                <section className="card">
                  {tools.length === 0 ? <p className="muted">No tool calls recorded.</p> : <DataTable caption="Tools used (biggest results first)" columns={toolCols} rows={tools} rowKey={(t) => t.name} />}
                </section>
                {!r.totalOnly && (
                  <section className="card">
                    <details>
                      <summary>Show the first {Math.min(100, d.steps.length)} steps as a table</summary>
                      <div className="tablewrap">
                        <table>
                          <caption>Steps</caption>
                          <thead><tr><th>#</th><th>Time</th><th className="num">Context</th><th className="num">Cache read</th><th>Cache miss</th><th className="num">Cost</th></tr></thead>
                          <tbody>
                            {d.steps.slice(0, 100).map((s, i) => (
                              <tr key={i}><td>{i + 1}</td><td>{formatDateTime(s.ts)}</td><td className="num">{formatTokens(s.context)}</td><td className="num">{formatTokens(s.cacheReadTokens)}</td><td>{s.cacheMiss ? <ReasonTag reason={s.cacheMiss.reason} avoidable={s.cacheMiss.avoidable} /> : null}</td><td className="num">{formatUsd(s.costUsd)}</td></tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  </section>
                )}
              </div>
            </>
          );
        }}
      </Async>
    </>
  );
}
