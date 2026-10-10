import type { ReactNode } from 'react';

export function Kpi({ label, value, hint, tag }: { label: string; value: ReactNode; hint?: ReactNode; tag?: ReactNode }) {
  return (
    <div className="card kpi">
      <h3>
        {label} {tag}
      </h3>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function EstTag() {
  return (
    <span className="tag est" title="Computed from the public AWS price list; your invoice may differ.">
      estimate
    </span>
  );
}
