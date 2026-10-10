import type { Finding } from '../core/api-types';
import {
  cacheWriteOf, contextOf, dominantModel, fmtPct, fmtUsd, MIN_SAMPLE, percentile,
  severityForShare, toChains, TTL_1H_MS, TTL_5M_MS, type Chain, type InsightRule,
} from './kit';

interface Expiry {
  chain: Chain;
  gapMs: number;
  rewritten: number;
  premiumUsd: number;
}

const rule: InsightRule = {
  id: 'cache-expiry',
  run(ctx): Finding[] {
    const writes = ctx.historySteps().map(cacheWriteOf).filter((w) => w > 0);
    if (writes.length < MIN_SAMPLE) return [];
    // "Large" write = at least as big as the typical write in the user's own history.
    const largeWrite = percentile(writes, 0.5);

    const expiries: Expiry[] = [];
    for (const chain of toChains(ctx.steps(), { mainOnly: true })) {
      const ttl = chain.some((s) => s.cacheWrite1h > 0) ? TTL_1H_MS : TTL_5M_MS;
      for (let i = 1; i < chain.length; i++) {
        const prev = chain[i - 1];
        const cur = chain[i];
        if (!prev || !cur) continue;
        const gap = cur.ts - prev.ts;
        const hadCache = prev.cacheRead + cacheWriteOf(prev) > 0;
        const write = cacheWriteOf(cur);
        if (gap <= ttl || !hadCache || write < largeWrite || write <= cur.cacheRead) continue;
        const r = ctx.rates(cur.model, cur.tier);
        if (!r || r.cacheRead <= 0) continue;
        const writeRate = ttl === TTL_1H_MS ? r.cacheWrite1h : r.cacheWrite5m;
        const rewritten = Math.min(write, contextOf(prev));
        expiries.push({ chain, gapMs: gap, rewritten, premiumUsd: (rewritten * Math.max(0, writeRate - r.cacheRead)) / 1e6 });
      }
    }
    if (expiries.length === 0) return [];

    const savings = expiries.reduce((a, e) => a + e.premiumUsd, 0);
    if (!ctx.isMaterial(savings)) return [];

    const bySession = new Map<string, Expiry[]>();
    for (const e of expiries) {
      const k = `${e.chain[0]?.agent}\u001f${e.chain[0]?.sessionId}`;
      bySession.set(k, [...(bySession.get(k) ?? []), e]);
    }
    const beyondHour = expiries.filter((e) => e.gapMs > TTL_1H_MS).length;
    const sample = expiries[0] as Expiry;
    const r = ctx.rates(dominantModel(sample.chain), sample.chain[0]?.tier ?? 'regional');
    const readPct = r && r.input > 0 ? ` (a cache read costs ${fmtPct(r.cacheRead / r.input)} of the input price, a write ${fmtPct(r.cacheWrite5m / r.input)})` : '';
    return [{
      id: 'cache-expiry',
      severity: severityForShare(savings, ctx.windowCostUsd()),
      title: `Cache expired ${expiries.length} time${expiries.length === 1 ? '' : 's'} during pauses`,
      detail:
        `Cached prompts only live for a short time: 5 minutes by default, 1 hour when written with the long option. ` +
        `In these sessions you paused longer than that and the next step had to write the whole conversation to the cache again instead of reading it${readPct}. ` +
        `Re-writing cost about ${fmtUsd(savings)} more than reading would have. ` +
        `Keeping pauses shorter, finishing a thought before stepping away, or using the 1-hour cache where your agent supports it avoids this.` +
        `${beyondHour > 0 ? ` ${beyondHour} of the pauses were longer than an hour, so no cache setting would have helped; after a long break a fresh session (with a short summary) is cheaper than resuming a big one.` : ''}`,
      evidence: [...bySession.values()].sort((a, b) => b.length - a.length).slice(0, 10).map((list) => ({
        label: `${list.length} expiries, longest pause ${Math.round(Math.max(...list.map((e) => e.gapMs)) / 60_000)} min, ~${fmtUsd(list.reduce((a, e) => a + e.premiumUsd, 0))} extra`,
        agent: list[0]?.chain[0]?.agent,
        sessionId: list[0]?.chain[0]?.sessionId,
        value: String(list.length),
      })),
      estSavingsUsd: savings,
      concept: 'ttl',
    }];
  },
};

export default rule;
