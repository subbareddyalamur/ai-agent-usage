import { useId } from 'react';

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: readonly string[];
  selected: readonly string[];
  onChange(next: string[]): void;
}) {
  const id = useId();
  const toggle = (o: string) =>
    onChange(selected.includes(o) ? selected.filter((s) => s !== o) : [...selected, o]);
  const summary = selected.length === 0 ? `All ${label.toLowerCase()}` : `${selected.length} selected`;
  return (
    <div className="field">
      <span className="label" id={id}>
        {label}
      </span>
      <details className="ms">
        <summary aria-labelledby={id}>{summary}</summary>
        <div className="menu" role="group" aria-labelledby={id}>
          {options.length === 0 && <div className="muted" style={{ padding: 6 }}>No options yet</div>}
          {selected.length > 0 && (
            <button className="btn clear" onClick={() => onChange([])}>
              Clear
            </button>
          )}
          {options.map((o) => (
            <label key={o}>
              <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} />
              {o}
            </label>
          ))}
        </div>
      </details>
    </div>
  );
}
