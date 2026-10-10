import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CacheDayPoint } from '../../src/core/api-types';
import { TOKEN_COLORS } from '../lib/colors';
import { formatPct, formatTokens, formatUsd } from '../lib/format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const tick = (b: string): string => {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(b);
  return m ? `${MONTHS[Number(m[1]) - 1] ?? ''} ${Number(m[2])}` : b;
};

export function HitTrend({ days }: { days: readonly CacheDayPoint[] }) {
  const data = days.map((d) => ({ ...d, pct: d.hitRatio === null ? null : d.hitRatio * 100 }));
  return (
    <div className="chart" role="img" aria-label="Cache hit ratio per day, as a percentage of prompt tokens served from cache">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#2a3441" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="bucket" tickFormatter={tick} stroke="#9aa7b5" fontSize={12} minTickGap={16} />
          <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} stroke="#9aa7b5" fontSize={12} width={48} />
          <Tooltip
            contentStyle={{ background: '#1b232d', border: '1px solid #2a3441', borderRadius: 8 }}
            labelFormatter={(l) => String(l)}
            formatter={(_v, _n, item) => {
              const p = item.payload as CacheDayPoint;
              return [`${formatPct(p.hitRatio)} · ${formatTokens(p.cacheReadTokens)} of ${formatTokens(p.promptTokens)} tokens · avoidable ${formatUsd(p.extraCostUsd)}`, 'Hit ratio'];
            }}
          />
          <Line type="monotone" dataKey="pct" name="Hit ratio" stroke={TOKEN_COLORS.cacheRead} strokeWidth={2} dot={{ r: 2 }} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
