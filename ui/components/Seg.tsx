export function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string }>;
  onChange(v: T): void;
}) {
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="label">{label}</span>
      <div className="seg">
        {options.map((o) => (
          <button type="button" key={o.id} aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
