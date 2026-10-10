import type { PricingService, ResolvedModel, UsageEvent } from '../src/core/types';

export function fakePricing(opts: { unpriced?: readonly string[] } = {}): PricingService {
  const unpriced = new Set(opts.unpriced ?? []);
  return {
    async refreshIfStale() {
      return { refreshed: false };
    },
    async resolveModel(raw: string): Promise<ResolvedModel> {
      return { canonical: raw.toLowerCase(), priced: !unpriced.has(raw), tier: raw.startsWith('global.') ? 'global' : 'regional' };
    },
    priceEvent(model, input) {
      if (!model.priced) return { costUsd: null, approx: false };
      // $1/M input, $5/M output+reasoning, $0.1/M cache read, $1.25/M cache write
      const cost =
        (input.inputTokens * 1 + (input.outputTokens + input.reasoningTokens) * 5 +
          input.cacheReadTokens * 0.1 + (input.cacheWrite5mTokens + input.cacheWrite1hTokens) * 1.25) / 1e6;
      return { costUsd: cost, approx: false };
    },
  };
}

export function makeEvent(over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: 'e1',
    agent: 'test',
    sessionId: 's1',
    ts: 1_700_000_000_000,
    modelRaw: 'claude-sonnet-5',
    inputTokens: 100,
    outputTokens: 10,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    isSubagent: false,
    kind: 'step',
    tools: [],
    ...over,
  };
}
