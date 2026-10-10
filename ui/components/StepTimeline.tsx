import { Area, CartesianGrid, ComposedChart, Legend, Line, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from 'recharts';
import type { StepRow } from '../../src/core/api-types';
import { TOKEN_COLORS } from '../lib/colors';
import { REASON_HINT, REASON_LABEL } from '../lib/cache';
import { formatBytes, formatDateTime, formatTokens, formatUsd } from '../lib/format';

interface Point {
  step: number;
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
  src: StepRow;
}

function StepTip({ active, payload }: TooltipContentProps) {
  const p = (active && payload?.[0]?.payload) as Point | undefined;
  if (!p) return null;
  const s = p.src;
  return (
    <div style={{ background: '#1b232d', border: '1px solid #2a3441', borderRadius: 8, padding: '8px 10px', maxWidth: 280, fontSize: 12 }}>
      <strong>Step {p.step}</strong> · {formatDateTime(s.ts)} {s.isSubagent && <span className="tag">subagent</span>}
      <div className="muted">{s.model}</div>
      <div>Context {formatTokens(s.context)}</div>
      <div><i className="dot" style={{ background: TOKEN_COLORS.cacheRead }} />cache read {formatTokens(s.cacheReadTokens)}</div>
      <div><i className="dot" style={{ background: TOKEN_COLORS.cacheWrite }} />cache write {formatTokens(s.cacheWriteTokens)}</div>
      <div><i className="dot" style={{ background: TOKEN_COLORS.input }} />fresh input {formatTokens(s.inputTokens)}</div>
      <div>Output {formatTokens(s.outputTokens + s.reasoningTokens)} · cost {formatUsd(s.costUsd)}</div>
      {s.cacheMiss && (
        <div style={{ marginTop: 4 }}>
          <strong>{s.cacheMiss.avoidable ? 'Avoidable cache miss' : 'Cache miss (normal)'}: {REASON_LABEL[s.cacheMiss.reason]}</strong>
          <div className="muted">{REASON_HINT[s.cacheMiss.reason]}</div>
          <div>{formatTokens(s.cacheMiss.missTokens)} tokens missed{s.cacheMiss.extraCostUsd !== null ? <> · ~{formatUsd(s.cacheMiss.extraCostUsd)} extra</> : null}</div>
        </div>
      )}
      {s.tools.length > 0 && (
        <div className="muted">Tools: {s.tools.map((t) => `${t.name}${t.resultBytes !== null ? ` (${formatBytes(t.resultBytes)})` : ''}`).join(', ')}</div>
      )}
    </div>
  );
}

export function StepTimeline({ steps }: { steps: readonly StepRow[] }) {
  const data: Point[] = steps.map((s, i) => ({
    step: i + 1,
    fresh: s.inputTokens,
    cacheRead: s.cacheReadTokens,
    cacheWrite: s.cacheWriteTokens,
    cost: s.costUsd,
    src: s,
  }));
  return (
    <>
    <div className="chart tall" role="img" aria-label="Per-step prompt size split into cache read, cache write and fresh input, with per-step cost; dots mark cache misses">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#2a3441" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="step" stroke="#9aa7b5" fontSize={12} minTickGap={20} />
          <YAxis yAxisId="tok" tickFormatter={(v: number) => formatTokens(v)} stroke="#9aa7b5" fontSize={12} width={60} />
          <YAxis yAxisId="usd" orientation="right" tickFormatter={(v: number) => formatUsd(v)} stroke="#9aa7b5" fontSize={12} width={60} />
          <Tooltip content={(p) => <StepTip {...p} />} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area yAxisId="tok" type="monotone" dataKey="cacheRead" name="Cache read" stackId="p" stroke={TOKEN_COLORS.cacheRead} fill={TOKEN_COLORS.cacheRead} fillOpacity={0.55} isAnimationActive={false} />
          <Area yAxisId="tok" type="monotone" dataKey="cacheWrite" name="Cache write" stackId="p" stroke={TOKEN_COLORS.cacheWrite} fill={TOKEN_COLORS.cacheWrite} fillOpacity={0.6} isAnimationActive={false} />
          <Area yAxisId="tok" type="monotone" dataKey="fresh" name="Fresh input" stackId="p" stroke={TOKEN_COLORS.input} fill={TOKEN_COLORS.input} fillOpacity={0.6} isAnimationActive={false} />
          <Line yAxisId="usd" type="monotone" dataKey="cost" name="Step cost (estimate)" stroke="#ffffff" dot={false} strokeWidth={1.5} isAnimationActive={false} connectNulls />
          {data.map((p) =>
            p.src.cacheMiss ? (
              <ReferenceDot key={p.step} yAxisId="tok" x={p.step} y={p.src.context} r={p.src.cacheMiss.avoidable ? 5 : 3.5} ifOverflow="visible"
                fill={p.src.cacheMiss.avoidable ? '#f5c26b' : 'none'} stroke={p.src.cacheMiss.avoidable ? '#1b232d' : '#9aa7b5'} strokeWidth={1.5} className="stepmark" />
            ) : null,
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
    {data.some((p) => p.src.cacheMiss) && (
      <p className="muted">
        <i className="dot" style={{ background: '#f5c26b' }} /> avoidable cache miss · <i className="dot" style={{ background: 'none', border: '1px solid #9aa7b5' }} /> normal miss (cold start or reset). Hover a step for the reason.
      </p>
    )}
    </>
  );
}
