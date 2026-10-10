import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Adapter } from './types';

const SKIP = new Set(['kit.ts', 'index.ts']);

function isAdapter(value: unknown): value is Adapter {
  const a = value as Partial<Adapter> | null;
  return (
    !!a &&
    typeof a.id === 'string' &&
    typeof a.label === 'string' &&
    typeof a.detect === 'function' &&
    typeof a.ingest === 'function'
  );
}

/**
 * Loads every adapter module in `dir` (default: src/adapters). Files that do not
 * default-export a valid Adapter are reported in `problems` and otherwise ignored,
 * so one broken adapter never takes the others down.
 */
export async function discoverAdapters(
  dir: string = join(import.meta.dir, '..', 'adapters'),
): Promise<{ adapters: Adapter[]; problems: string[] }> {
  const adapters: Adapter[] = [];
  const problems: string[] = [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !SKIP.has(f))
    .sort();

  for (const file of files) {
    try {
      const mod: { default?: unknown } = await import(join(dir, file));
      if (isAdapter(mod.default)) adapters.push(mod.default);
      else problems.push(`${file}: default export is not an Adapter`);
    } catch (error: unknown) {
      problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const seen = new Set<string>();
  for (const a of adapters) {
    if (seen.has(a.id)) problems.push(`duplicate adapter id: ${a.id}`);
    seen.add(a.id);
  }
  return { adapters, problems };
}
