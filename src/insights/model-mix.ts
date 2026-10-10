import type { Finding } from '../core/api-types';
import type { Rates } from '../core/rates';
import {
  contextOf, fmtTokens, fmtUsd, MIN_SAMPLE, percentile, severityForShare, stepCostWith,
  type InsightContext, type InsightRule, type Step,
} from './kit';

/** Vendor line of a canonical model name, e.g. "Claude Opus 5.5" -> "claude". */
const vendorOf = (model: string): string => model.toLowerCase().split(/[\s\-_/.:]/)[0] ?? '';

/** Tier line without versions, e.g. "Claude Sonnet 4.6" and "Claude Sonnet 5.5" are both "claude sonnet". A successor is not a cheaper tier. */
const lineOf = (model: string): string =>
  model.toLowerCase().split(/[\s\-_/:]+/).filter((t) => t && !/^v?\d[\d.]*$/.test(t)).join(' ');

/** Prices a step on another model; if that model has no cache rates, cached tokens fall back to the input rate. */
function repriced(step: Step, r: Rates): number {
  return stepCostWith(step, {
    ...r,
    cacheRead: r.cacheRead > 0 ? r.cacheRead : r.input,
    cacheWrite5m: r.cacheWrite5m > 0 ? r.cacheWrite5m : r.input,
    cacheWrite1h: r.cacheWrite1h > 0 ? r.cacheWrite1h : r.input,
  });
}

interface Candidate {
  model: string;
  rates: Rates;
}

/** The closest cheaper alternative the user already runs: same vendor, lower input and output price. */
function cheaperAlternative(ctx: InsightContext, model: string, tier: Step['tier'], own: Rates): Candidate | null {
  const used = new Map<string, Step['tier']>();
  for (const s of ctx.historySteps()) if (s.priced) used.set(s.model, s.tier);
  let best: Candidate | null = null;
  for (const [m, t] of used) {
    if (m === model || vendorOf(m) !== vendorOf(model) || lineOf(m) === lineOf(model)) continue;
    const r = ctx.rates(m, t === tier ? t : tier) ?? ctx.rates(m, t);
    if (!r || r.input >= own.input || r.output >= own.output) continue;
    if (!best || r.output > best.rates.output) best = { model: m, rates: r };
  }
  return best;
}

const rule: InsightRule = {
  id: 'model-mix',
  run(ctx): Finding[] {
    const byModel = new Map<string, Step[]>();
    for (const s of ctx.steps()) {
      if (!s.priced) continue;
      byModel.set(s.model, [...(byModel.get(s.model) ?? []), s]);
    }
    const history = new Map<string, Step[]>();
    for (const s of ctx.historySteps()) history.set(s.model, [...(history.get(s.model) ?? []), s]);

    const windowCost = ctx.windowCostUsd();
    const evidence: Finding['evidence'] = [];
    let total = 0;
    let firstLine = '';
    for (const [model, steps] of byModel) {
      const hist = history.get(model) ?? [];
      const sample = steps[0];
      if (hist.length < MIN_SAMPLE || !sample) continue;
      const own = ctx.rates(model, sample.tier);
      if (!own) continue;
      const alt = cheaperAlternative(ctx, model, sample.tier, own);
      if (!alt) continue;

      const outLimit = percentile(hist.map((s) => s.output + s.reasoning), 0.25);
      const ctxLimit = percentile(hist.map(contextOf), 0.25);
      const light = steps.filter((s) => s.output + s.reasoning <= outLimit && contextOf(s) <= ctxLimit);
      if (light.length === 0) continue;
      const savings = light.reduce((a, s) => a + stepCostWith(s, own) - repriced(s, alt.rates), 0);
      if (savings <= 0) continue;
      total += savings;
      if (!firstLine) firstLine = `${model} to ${alt.model}`;
      evidence.push({
        label: `${light.length} light steps on ${model} (output up to ${fmtTokens(outLimit)}, context up to ${fmtTokens(ctxLimit)}) could run on ${alt.model}: ~${fmtUsd(savings)}`,
        model,
        value: fmtUsd(savings),
      });
    }
    if (evidence.length === 0 || !ctx.isMaterial(total)) return [];

    return [{
      id: 'model-mix',
      severity: severityForShare(total, windowCost),
      title: `Some small steps ran on a pricier model than needed`,
      detail:
        `Steps with short answers and small prompts (both in the bottom quarter of your own history for that model) often do not need the most capable model. ` +
        `Running them on a cheaper model you already use (${firstLine}${evidence.length > 1 ? ' and others' : ''}) would have cost about ${fmtUsd(total)} less. ` +
        `This is an estimate from current list prices; answer quality on those steps may differ, so treat it as a place to experiment, not a rule.`,
      evidence,
      estSavingsUsd: total,
      concept: 'model-mix',
    }];
  },
};

export default rule;
