import { useState } from 'react';
import type { Finding, Severity } from '../../src/core/api-types';
import type { PageProps } from '../App';
import { Async, Empty } from '../components/States';
import { useApi } from '../lib/api';
import { formatUsd } from '../lib/format';
import { useRoute } from '../lib/router';

const ORDER: Record<Severity, number> = { high: 0, warn: 1, info: 2 };
const LABEL: Record<Severity, string> = { high: 'High', warn: 'Worth a look', info: 'FYI' };

export function Insights({ query, refreshKey }: PageProps) {
  const route = useRoute();
  const state = useApi<Finding[]>(`/api/insights?${query}`, refreshKey);
  const [only, setOnly] = useState<Severity | 'all'>('all');

  return (
    <>
      <h1>Insights</h1>
      <p className="muted prose">
        Patterns found in your own usage. Thresholds are calibrated against your history, so nothing here needs configuring. Savings are rough estimates and can overlap.
      </p>
      <Async state={state} what="insights">
        {(all) => {
          const list = [...all].filter((f) => only === 'all' || f.severity === only).sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (b.estSavingsUsd ?? 0) - (a.estSavingsUsd ?? 0));
          const savings = all.reduce((a, f) => a + (f.estSavingsUsd ?? 0), 0);
          return all.length === 0 ? (
            <Empty title="Nothing notable found">Either everything looks healthy for this range, or there is not enough data yet.</Empty>
          ) : (
            <>
              <div className="controls">
                <div className="seg" role="group" aria-label="Severity">
                  {(['all', 'high', 'warn', 'info'] as const).map((s) => (
                    <button type="button" key={s} aria-pressed={only === s} onClick={() => setOnly(s)}>
                      {s === 'all' ? `All (${all.length})` : `${LABEL[s]} (${all.filter((f) => f.severity === s).length})`}
                    </button>
                  ))}
                </div>
                {savings > 0 && <span className="tag est">possible savings ≈ {formatUsd(savings)} (estimate)</span>}
              </div>
              <div className="grid">
                {list.map((f, i) => (
                  <article key={`${f.id}-${i}`} className={`card finding ${f.severity}`}>
                    <header>
                      <h2>{f.title}</h2>
                      <span>
                        <span className={`tag ${f.severity === 'high' ? 'bad' : f.severity === 'warn' ? 'warn' : ''}`}>{LABEL[f.severity]}</span>{' '}
                        {f.estSavingsUsd !== undefined && f.estSavingsUsd > 0 && <span className="tag est">≈ {formatUsd(f.estSavingsUsd)}</span>}
                      </span>
                    </header>
                    <p>{f.detail}</p>
                    {f.evidence.length > 0 && (
                      <ul aria-label="Evidence">
                        {f.evidence.slice(0, 8).map((e, j) => (
                          <li key={j}>
                            {e.agent && e.sessionId ? <a href={route.hrefFor(['sessions', e.agent, e.sessionId])}>{e.label}</a> : e.label}
                            {e.model && <> · {e.model}</>}
                            {e.value && !e.label.includes(e.value) && <> · <strong>{e.value}</strong></>}
                          </li>
                        ))}
                        {f.evidence.length > 8 && <li>…and {f.evidence.length - 8} more</li>}
                      </ul>
                    )}
                    <p style={{ margin: '10px 0 0' }}>
                      <a href={route.hrefFor(['concepts'], { section: f.concept ?? null })}>Why this matters →</a>
                    </p>
                  </article>
                ))}
              </div>
            </>
          );
        }}
      </Async>
    </>
  );
}
