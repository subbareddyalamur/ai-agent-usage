import type { ReactNode } from 'react';

export interface Column<R> {
  key: string;
  header: string;
  render(row: R): ReactNode;
  num?: boolean;
  wrap?: boolean;
  /** Present = header is a sort button. */
  sortKey?: string;
  hint?: string;
}

export interface Sort {
  key: string;
  dir: 'asc' | 'desc';
}

export function DataTable<R>({
  caption,
  columns,
  rows,
  rowKey,
  sort,
  onSort,
}: {
  caption: string;
  columns: ReadonlyArray<Column<R>>;
  rows: readonly R[];
  rowKey(row: R): string;
  sort?: Sort;
  onSort?(key: string): void;
}) {
  return (
    <div className="tablewrap">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => {
              const active = !!c.sortKey && sort?.key === c.sortKey;
              return (
                <th
                  key={c.key}
                  className={c.num ? 'num' : undefined}
                  scope="col"
                  title={c.hint}
                  aria-sort={active ? (sort?.dir === 'asc' ? 'ascending' : 'descending') : c.sortKey ? 'none' : undefined}
                >
                  {c.sortKey && onSort ? (
                    <button onClick={() => onSort(c.sortKey as string)}>
                      {c.header}
                      <span aria-hidden="true">{active ? (sort?.dir === 'asc' ? '▲' : '▼') : ''}</span>
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.key} className={[c.num ? 'num' : '', c.wrap ? 'wrap' : ''].join(' ').trim() || undefined}>
                  {c.render(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
