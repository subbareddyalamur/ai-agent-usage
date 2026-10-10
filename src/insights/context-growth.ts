import type { Finding } from '../core/api-types';
import {
  contextOf, dominantModel, fmtTokens, fmtUsd, mean, MIN_SAMPLE, percentile,
  severityForShare, toChains, type Chain, type InsightRule, type InsightContext,
} from './kit';

/** A chain needs at least this many steps to compare its start with its end. */
const MIN_STEPS = 6;

interface Hit {
  chain: Chain;
  peak: number;
  excessTokens: number;
  savings: number;
}

function evaluate(ctx: InsightContext, chain: Chain, p90: number): Hit | null {
  if (chain.length < MIN_STEPS) return null;
  const third = Math.floor(chain.length / 3);
  const first = mean(chain.slice(0, third).map(contextOf));
  const last = mean(chain.slice(-third).map(contextOf));
  if (!(last > p90 && last > first)) return null;

  let excessTokens = 0;
  let savings = 0;
  for (const s of chain) {
    const cur = contextOf(s);
    if (cur <= p90) continue;
    const r = ctx.rates(s.model, s.tier);
    if (!r) continue;
    const promptCost = (s.input * r.input + s.cacheRead * r.cacheRead + s.cacheWrite5m * r.cacheWrite5m + s.cacheWrite1h * r.cacheWrite1h) / 1e6;
    const excessShare = (cur - p90) / cur;
    excessTokens += cur - p90;
    savings += promptCost * excessShare;
  }
  if (savings <= 0) return null;
  return { chain, peak: Math.max(...chain.map(contextOf)), excessTokens, savings };
}

const rule: InsightRule = {
  id: 'context-growth',
  run(ctx): Finding[] {
    const history = ctx.historySteps().filter((s) => !s.isSubagent).map(contextOf);
    if (history.length < MIN_SAMPLE) return [];
    const p90 = percentile(history, 0.9);

    const hits = toChains(ctx.steps(), { mainOnly: true })
      .map((c) => evaluate(ctx, c, p90))
      .filter((h): h is Hit => h !== null)
      .sort((a, b) => b.savings - a.savings);
    if (hits.length === 0) return [];

    const savings = hits.reduce((a, h) => a + h.savings, 0);
    if (!ctx.isMaterial(savings)) return [];
    return [{
      id: 'context-growth',
      severity: severityForShare(savings, ctx.windowCostUsd()),
      title: `${hits.length} session${hits.length === 1 ? '' : 's'} kept growing past your usual context size`,
      detail:
        `Your typical step sends up to ${fmtTokens(p90)} tokens (the 90th percentile of your own history). ` +
        `These sessions ended well above that and were still growing. Each step re-sends the whole conversation, so every extra token is paid for again on every following step, ` +
        `cheaply when cached and at full price when not. Starting a fresh session or compacting once a session crosses ${fmtTokens(p90)} would have avoided about ${fmtTokens(hits.reduce((a, h) => a + h.excessTokens, 0))} ` +
        `tokens of repeated prompt, roughly ${fmtUsd(savings)} (an estimate).`,
      evidence: hits.slice(0, 10).map((h) => ({
        label: `peaked at ${fmtTokens(h.peak)} tokens over ${h.chain.length} steps, ~${fmtUsd(h.savings)} above your usual size`,
        agent: h.chain[0]?.agent,
        sessionId: h.chain[0]?.sessionId,
        model: dominantModel(h.chain),
        value: fmtTokens(h.peak),
      })),
      estSavingsUsd: savings,
      concept: 'context',
    }];
  },
};

export default rule;
