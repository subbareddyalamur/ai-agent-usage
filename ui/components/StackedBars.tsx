import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { colorFor } from '../lib/colors';
import { formatTokens, formatUsd } from '../lib/format';
import type { Metric, Pivoted } from '../lib/series';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function tick(bucket: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(bucket);
  return m ? `${MONTHS[Number(m[1]) - 1] ?? ''} ${Number(m[2])}` : bucket;
}

export function StackedBars({ data, metric, label }: { data: Pivoted; metric: Metric; label: string }) {
  const fmt = metric === 'cost' ? formatUsd : formatTokens;
  return (
    <div className="chart" role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#2a3441" strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="bucket" tickFormatter={tick} stroke="#9aa7b5" fontSize={12} minTickGap={16} />
          <YAxis tickFormatter={(v: number) => fmt(v)} stroke="#9aa7b5" fontSize={12} width={64} />
          <Tooltip
            contentStyle={{ background: '#1b232d', border: '1px solid #2a3441', borderRadius: 8 }}
            labelFormatter={(l) => String(l)}
            formatter={(v) => fmt(Number(v))}
            itemSorter={(item) => -Number(item.value ?? 0)}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {data.keys.map((k) => (
            <Bar key={k} dataKey={k} stackId="a" fill={colorFor(k, data.keys)} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
