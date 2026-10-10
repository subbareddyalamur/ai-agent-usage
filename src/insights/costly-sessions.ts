import type { Finding } from '../core/api-types';
import { all, buildWhere } from '../core/query-filters';
import { zonedMidnight } from '../core/query-time';
import { dailyCosts, fmtPct, fmtUsd, median, MIN_SAMPLE, percentile, robustSigma, type InsightContext, type InsightRule } from './kit';

/** Active days of baseline behind each day when looking for spikes. */
const BASELINE_DAYS = 14;
/** Fewest earlier active days required before a day can be judged a spike. */
const MIN_BASELINE_DAYS = 7;
const SPIKE_Z = 3;

interface SessionCost {
  agent: string;
  session_id: string;
  cost: number;
  steps: number;
  title: string | null;
}

function costlySessions(ctx: InsightContext): Finding[] {
  const hist = all<{ cost: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(e.cost_usd), 0) AS cost FROM events e GROUP BY e.agent, e.session_id`,
  ).map((r) => r.cost);
  if (hist.length < MIN_SAMPLE) return [];
  const threshold = percentile(hist, 0.95);

  const w = buildWhere(ctx.filters);
  const rows = all<SessionCost>(
    ctx.db,
    `SELECT e.agent AS agent, e.session_id AS session_id, COALESCE(SUM(e.cost_usd), 0) AS cost,
            SUM(CASE WHEN e.kind = 'step' THEN 1 ELSE 0 END) AS steps, MAX(s.title) AS title
     FROM events e LEFT JOIN sessions s ON s.agent = e.agent AND s.session_id = e.session_id
     WHERE ${w.sql} GROUP BY e.agent, e.session_id ORDER BY cost DESC LIMIT 5`,
    w.params,
  ).filter((r) => r.cost > threshold && r.cost > 0);
  if (rows.length === 0) return [];

  const windowCost = ctx.windowCostUsd();
  const top = rows[0] as SessionCost;
  return [{
    id: 'costly-sessions',
    severity: windowCost > 0 && top.cost / windowCost >= 0.2 ? 'warn' : 'info',
    title: `${rows.length} session${rows.length === 1 ? '' : 's'} cost more than 95% of all your sessions`,
    detail:
      `A session above ${fmtUsd(threshold)} is in the top 5% of everything you have run. ` +
      `The most expensive one cost about ${fmtUsd(top.cost)}${windowCost > 0 ? ` (${fmtPct(top.cost / windowCost)} of spend in this range)` : ''}. ` +
      `Open it to see whether context size, missing caching or a pricey model drove the cost.`,
    evidence: rows.map((r) => ({
      label: `${r.title ?? r.session_id}: ${fmtUsd(r.cost)}${r.steps ? `, ${r.steps} steps` : ''}`,
      agent: r.agent,
      sessionId: r.session_id,
      value: fmtUsd(r.cost),
    })),
    concept: 'context',
  }];
}

function spikeDays(ctx: InsightContext): Finding[] {
  const tz = ctx.tz();
  const daily = dailyCosts(ctx.db, tz);
  // Idle days say nothing about "normal spend", so the baseline is the previous active days only.
  const active = [...daily.entries()].filter(([, c]) => c > 0).sort(([a], [b]) => a.localeCompare(b));
  if (active.length < MIN_BASELINE_DAYS + 1) return [];
  const floor = percentile(active.map(([, c]) => c), 0.75);

  const spikes: Array<{ day: string; cost: number; base: number; ratio: number }> = [];
  for (let i = MIN_BASELINE_DAYS; i < active.length; i++) {
    const [day, cost] = active[i] as [string, number];
    const dayStart = zonedMidnight(day, tz);
    if (ctx.filters.from !== undefined && dayStart + 86_400_000 <= ctx.filters.from) continue;
    if (ctx.filters.to !== undefined && dayStart > ctx.filters.to) continue;
    const prior = active.slice(Math.max(0, i - BASELINE_DAYS), i).map(([, c]) => c);
    const base = median(prior);
    const sigma = robustSigma(prior) || base;
    if (cost > floor && cost > base + SPIKE_Z * sigma) spikes.push({ day, cost, base, ratio: base > 0 ? cost / base : Infinity });
  }
  if (spikes.length === 0) return [];
  spikes.sort((a, b) => b.cost - a.cost);
  const worst = spikes[0] as (typeof spikes)[number];
  return [{
    id: 'cost-spikes',
    severity: spikes.length >= 3 || worst.ratio >= 3 ? 'warn' : 'info',
    title: `${spikes.length} day${spikes.length === 1 ? '' : 's'} with unusually high spend`,
    detail:
      `${worst.day} cost about ${fmtUsd(worst.cost)} against a typical ${fmtUsd(worst.base)} on your previous ${BASELINE_DAYS} active days` +
      `${Number.isFinite(worst.ratio) ? ` (${worst.ratio.toFixed(1)}x)` : ''}. ` +
      `A day counts as a spike when it is far outside your own recent range (more than ${SPIKE_Z} robust standard deviations above the median of your recent active days) and above your busier days.`,
    evidence: spikes.slice(0, 10).map((s) => ({
      label: `${s.day}: ${fmtUsd(s.cost)} vs typical ${fmtUsd(s.base)}`,
      value: fmtUsd(s.cost),
    })),
    concept: 'tiers',
  }];
}

const rule: InsightRule = {
  id: 'costly-sessions',
  run: (ctx) => [...costlySessions(ctx), ...spikeDays(ctx)],
};

export default rule;
