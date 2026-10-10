import type { ReactNode } from 'react';

export function Loading({ what = 'data' }: { what?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      Loading {what}…
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="banner bad" role="alert">
      <strong>Something went wrong.</strong> {message}{' '}
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children && <div>{children}</div>}
    </div>
  );
}

/** Renders loading / error / data for a fetched value. */
export function Async<T>({
  state,
  what,
  children,
}: {
  state: { data: T | null; error: string | null; loading: boolean; reload(): void };
  what?: string;
  children: (data: T) => ReactNode;
}) {
  if (state.error) return <ErrorBox message={state.error} onRetry={state.reload} />;
  if (state.data === null) return <Loading what={what} />;
  return <>{children(state.data)}</>;
}
