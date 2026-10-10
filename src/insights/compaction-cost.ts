import type { Finding } from '../core/api-types';
import {
  contextOf, fmtPct, fmtTokens, fmtUsd, median, MIN_SAMPLE, robustSigma, severityForShare, toChains,
  type Chain, type InsightRule,
} from './kit';

/** A "sharp" drop means at least this fraction of the previous context disappeared (compaction or /clear). */
const MIN_DROP = 0.5;
/** Sigmas below the typical step-to-step change that also count as sharp when the data is noisy. */
const FENCE_SIGMAS = 4;

function relativeChanges(chains: readonly Chain[]): number[] {
  const out: number[] = [];
  for (const c of chains) {
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1];
      const b = c[i];
      if (!a || !b) continue;
      const prev = contextOf(a);
      if (prev > 0) out.push(contextOf(b) / prev - 1);
    }
  }
  return out;
}

const rule: InsightRule = {
  id: 'compaction-cost',
  run(ctx): Finding[] {
    const histChains = toChains(ctx.historySteps(), { mainOnly: true });
    const deltas = relativeChanges(histChains);
    if (deltas.length < MIN_SAMPLE) return [];
    // Calibrated to this user's data, never looser than "context at least halved".
    const dropAt = Math.min(-MIN_DROP, median(deltas) - FENCE_SIGMAS * robustSigma(deltas));
    const minPrev = median(histChains.flat().map(contextOf));

    const events: Array<{ chain: Chain; index: number; before: number; after: number; costUsd: number; written: number }> = [];
    for (const chain of toChains(ctx.steps(), { mainOnly: true })) {
      for (let i = 1; i < chain.length; i++) {
        const before = chain[i - 1];
        const cur = chain[i];
        if (!before || !cur) continue;
        const prev = contextOf(before);
        if (prev < minPrev || prev === 0) continue;
        if (contextOf(cur) / prev - 1 <= dropAt) {
          events.push({ chain, index: i, before: prev, after: contextOf(cur), costUsd: cur.costUsd ?? 0, written: cur.cacheWrite5m + cur.cacheWrite1h });
        }
      }
    }
    if (events.length === 0) return [];

    const cost = events.reduce((a, e) => a + e.costUsd, 0);
    const sessions = new Map<string, typeof events>();
    for (const e of events) {
      const k = `${e.chain[0]?.agent}\u001f${e.chain[0]?.sessionId}`;
      sessions.set(k, [...(sessions.get(k) ?? []), e]);
    }
    const written = events.reduce((a, e) => a + e.written, 0);
    return [{
      id: 'compaction-cost',
      severity: severityForShare(cost, ctx.windowCostUsd()),
      title: `${events.length} context reset${events.length === 1 ? '' : 's'} (compaction or /clear) in ${sessions.size} session${sessions.size === 1 ? '' : 's'}`,
      detail:
        `The context shrank by at least ${fmtPct(-dropAt)} between two consecutive steps, which is what compaction or clearing looks like. ` +
        `After a reset the cache has to be rebuilt: the step right after each one cost ${fmtUsd(cost)} in total` +
        `${written > 0 ? `, re-writing ${fmtTokens(written)} tokens to the cache` : ''}. ` +
        `Compaction is useful, but frequent resets mean sessions are running past a comfortable size; wrapping up earlier avoids the rebuild.`,
      evidence: [...sessions.values()].sort((a, b) => b.length - a.length).slice(0, 10).map((list) => ({
        label: `${list.length} reset${list.length === 1 ? '' : 's'}, e.g. ${fmtTokens(list[0]?.before ?? 0)} to ${fmtTokens(list[0]?.after ?? 0)} tokens; following step${list.length === 1 ? '' : 's'} cost ${fmtUsd(list.reduce((a, e) => a + e.costUsd, 0))}`,
        agent: list[0]?.chain[0]?.agent,
        sessionId: list[0]?.chain[0]?.sessionId,
        value: String(list.length),
      })),
      concept: 'compaction',
    }];
  },
};

export default rule;
