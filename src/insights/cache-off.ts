import type { Finding, FindingEvidence } from '../core/api-types';
import {
  contextOf, dominantModel, fmtPct, fmtTokens, fmtUsd, median, MIN_SAMPLE,
  percentile, severityForShare, toChains, type Chain, type InsightContext, type InsightRule,
} from './kit';

/** Cache traffic below this share of prompt tokens counts as "no cache activity" (float/noise tolerance). */
const NO_ACTIVITY = 0.01;

/**
 * Smallest prompt that the user's own data shows being cached. If nothing was ever cached,
 * fall back to the median prompt so only above-typical prompts are judged.
 */
function minCacheable(ctx: InsightContext): number {
  const hist = ctx.historySteps();
  const cached = hist.filter((s) => s.cacheRead + s.cacheWrite5m + s.cacheWrite1h > 0).map(contextOf);
  if (cached.length >= MIN_SAMPLE) return percentile(cached, 0.05);
  return median(hist.map(contextOf));
}

interface ChainResult {
  chain: Chain;
  uncachedInput: number;
  savings: number;
}

function evaluate(ctx: InsightContext, chain: Chain, threshold: number): ChainResult | null {
  if (chain.length < 2) return null;
  const totalPrompt = chain.reduce((a, s) => a + contextOf(s), 0);
  const cacheTraffic = chain.reduce((a, s) => a + s.cacheRead + s.cacheWrite5m + s.cacheWrite1h, 0);
  if (totalPrompt === 0 || cacheTraffic / totalPrompt >= NO_ACTIVITY) return null;
  if (median(chain.map(contextOf)) < threshold) return null;

  let savings = 0;
  let capableSteps = 0;
  let prevCtx = 0;
  for (const s of chain) {
    const r = ctx.rates(s.model, s.tier);
    const cur = contextOf(s);
    if (r && r.cacheRead > 0 && r.input > 0) {
      capableSteps++;
      const reusable = Math.min(s.input, prevCtx);
      const fresh = Math.max(0, cur - prevCtx);
      savings += (reusable * (r.input - r.cacheRead) - fresh * Math.max(0, r.cacheWrite5m - r.input)) / 1e6;
    }
    prevCtx = cur;
  }
  if (capableSteps === 0 || savings <= 0) return null;
  return { chain, uncachedInput: chain.reduce((a, s) => a + s.input, 0), savings };
}

const rule: InsightRule = {
  id: 'cache-off',
  run(ctx): Finding[] {
    const steps = ctx.steps();
    if (steps.length === 0 || ctx.historySteps().length === 0) return [];
    const threshold = minCacheable(ctx);
    const results = toChains(steps)
      .map((c) => evaluate(ctx, c, threshold))
      .filter((r): r is ChainResult => r !== null)
      .sort((a, b) => b.savings - a.savings);
    if (results.length === 0) return [];

    const savings = results.reduce((a, r) => a + r.savings, 0);
    if (!ctx.isMaterial(savings)) return [];

    const worst = results[0] as ChainResult;
    const model = dominantModel(worst.chain);
    const tier = worst.chain[0]?.tier ?? 'regional';
    const r = ctx.rates(model, tier);
    const readShare = r && r.input > 0 ? ` On ${model}, cache reads are billed at ${fmtPct(r.cacheRead / r.input)} of the normal input price.` : '';
    const evidence: FindingEvidence[] = results.slice(0, 10).map((x) => ({
      label: `${x.chain.length} steps, ${fmtTokens(x.uncachedInput)} prompt tokens all billed as fresh input, ~${fmtUsd(x.savings)} avoidable`,
      agent: x.chain[0]?.agent,
      sessionId: x.chain[0]?.sessionId,
      model: dominantModel(x.chain),
      value: fmtUsd(x.savings),
    }));
    return [{
      id: 'cache-off',
      severity: severityForShare(savings, ctx.windowCostUsd()),
      title: `Prompt caching looks switched off in ${results.length} session${results.length === 1 ? '' : 's'}`,
      detail:
        `Every step re-sends the whole conversation. With caching, the repeated part is read back cheaply instead of being billed as new input.${readShare} ` +
        `These sessions used large prompts on models that support caching but recorded no cache reads or writes at all, so every step paid the full input price. ` +
        `Usual causes: the agent does not recognise the model id as cache-capable (for example an application inference profile ARN instead of a model id), or caching is disabled in its settings. ` +
        `Estimated avoidable spend: about ${fmtUsd(savings)} (an estimate that includes the one-time cost of writing the cache).`,
      evidence,
      estSavingsUsd: savings,
      concept: 'cache',
    }];
  },
};

export default rule;
