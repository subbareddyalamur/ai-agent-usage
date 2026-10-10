import type { Database } from 'bun:sqlite';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { Filters, Finding, Severity } from '../core/api-types';
import { createContext, type InsightRule } from './kit';

export type { InsightContext, InsightRule } from './kit';

const SKIP = new Set(['index.ts', 'kit.ts']);
const RANK: Record<Severity, number> = { high: 0, warn: 1, info: 2 };

const load = createRequire(import.meta.url);
let cached: InsightRule[] | undefined;

function isRule(v: unknown): v is InsightRule {
  const r = v as Partial<InsightRule> | null;
  return !!r && typeof r.id === 'string' && typeof r.run === 'function';
}

/** Every file in this folder that default-exports an InsightRule is a rule; add a file to add an insight. */
export function loadRules(dir: string = import.meta.dir): InsightRule[] {
  if (dir !== import.meta.dir) return discover(dir);
  cached ??= discover(dir);
  return cached;
}

function discover(dir: string): InsightRule[] {
  const rules: InsightRule[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !SKIP.has(f)).sort();
  for (const file of files) {
    try {
      const mod: { default?: unknown } = load(join(dir, file));
      if (isRule(mod.default)) rules.push(mod.default);
    } catch {
      // a broken rule must not take the others down
    }
  }
  return rules;
}

export interface InsightRun {
  findings: Finding[];
  problems: string[];
}

export function runInsightsDetailed(db: Database, f: Filters, ruleDir?: string): InsightRun {
  const ctx = createContext(db, f);
  const findings: Finding[] = [];
  const problems: string[] = [];
  for (const rule of loadRules(ruleDir)) {
    try {
      findings.push(...rule.run(ctx));
    } catch (error: unknown) {
      problems.push(`${rule.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  findings.sort((a, b) => RANK[a.severity] - RANK[b.severity] || (b.estSavingsUsd ?? 0) - (a.estSavingsUsd ?? 0) || a.id.localeCompare(b.id));
  return { findings, problems };
}

export function runInsights(db: Database, f: Filters): Finding[] {
  return runInsightsDetailed(db, f).findings;
}
