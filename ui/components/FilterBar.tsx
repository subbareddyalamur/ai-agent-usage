import type { FilterOptions } from '../../src/core/api-types';
import { PRESETS, type FilterState, type RangePreset } from '../lib/filters';
import { relativeTime } from '../lib/format';
import { MultiSelect } from './MultiSelect';

export interface FilterBarProps {
  filters: FilterState;
  options: FilterOptions | null;
  onChange(patch: Partial<FilterState>): void;
  refreshing: boolean;
  refreshError: string | null;
  lastRefreshAt: number | null;
  onRefresh(): void;
}

export function FilterBar({ filters, options, onChange, refreshing, refreshError, lastRefreshAt, onRefresh }: FilterBarProps) {
  return (
    <form className="filterbar" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
      <div className="field" role="group" aria-label="Date range">
        <span className="label">Date range</span>
        <div className="seg">
          {PRESETS.map((p) => (
            <button
              type="button"
              key={p.id}
              aria-pressed={filters.range === p.id}
              onClick={() => onChange({ range: p.id as RangePreset })}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {filters.range === 'custom' && (
        <>
          <div className="field">
            <label htmlFor="f-from">From</label>
            <input id="f-from" type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => onChange({ from: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="f-to">To</label>
            <input id="f-to" type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => onChange({ to: e.target.value })} />
          </div>
        </>
      )}
      <MultiSelect label="Agents" options={options?.agents ?? []} selected={filters.agents} onChange={(agents) => onChange({ agents })} />
      <MultiSelect label="Models" options={options?.models ?? []} selected={filters.models} onChange={(models) => onChange({ models })} />
      <label className="check">
        <input type="checkbox" checked={filters.subagents} onChange={(e) => onChange({ subagents: e.target.checked })} />
        Include subagents
      </label>
      <div className="field" style={{ marginLeft: 'auto' }}>
        <span className="label" aria-live="polite">
          {refreshing ? 'Refreshing…' : lastRefreshAt ? `Refreshed ${relativeTime(lastRefreshAt)}` : 'Data'}
        </span>
        <button type="button" className="btn primary" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Refreshing
            </>
          ) : (
            'Refresh data'
          )}
        </button>
      </div>
      {refreshError && (
        <div className="banner bad" role="alert" style={{ flexBasis: '100%', margin: 0 }}>
          {refreshError}
        </div>
      )}
    </form>
  );
}
