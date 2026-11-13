import type { CostSourceShare } from '../../src/core/api-types';
import type { PriceSource } from '../../src/core/types';

export type SourceKey = PriceSource | 'unpriced';

export interface SourceInfo {
  label: string;
  /** Distinct leading symbol so the badge never relies on colour alone. */
  glyph: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
  explain: string;
}

export const SOURCE_INFO: Readonly<Record<SourceKey, SourceInfo>> = {
  'aws-price-list': { label: 'AWS price list', glyph: '■', tone: 'good', explain: 'List price from the public AWS Bedrock price list.' },
  'aws-pricing-page': { label: 'AWS pricing page', glyph: '▣', tone: 'good', explain: 'List price read from the public AWS Bedrock pricing page (the bulk price list did not have the model yet).' },
  official: { label: 'Official price list', glyph: '●', tone: 'good', explain: 'List price fetched daily from the provider pricing page (Google, Anthropic, OpenAI, or xAI).' },
  'models.dev': { label: 'models.dev (third-party)', glyph: '◆', tone: 'neutral', explain: 'Price from models.dev, a community-maintained price database. Used when the provider page does not list the model.' },
  'free-model': { label: 'Free', glyph: '○', tone: 'neutral', explain: 'Free or local model: costs nothing.' },
  'agent-reported': { label: 'Agent-reported (approx.)', glyph: '≈', tone: 'warn', explain: "The agent's own cost number, used because no price list knows this model. Replaced automatically once a price list gains it." },
  unpriced: { label: 'Unpriced', glyph: '?', tone: 'bad', explain: 'No public price found. Tokens are counted; the cost is unknown and left out of totals (never counted as $0).' },
};

export const sourceKey = (s: PriceSource | null): SourceKey => s ?? 'unpriced';
export const sourceLabel = (s: PriceSource | null): string => SOURCE_INFO[sourceKey(s)].label;

/** Largest source (by events) plus the rest; empty input means nothing is known. */
export function dominantSource(shares: readonly CostSourceShare[]): { main: CostSourceShare | null; others: CostSourceShare[] } {
  if (shares.length === 0) return { main: null, others: [] };
  const sorted = [...shares].sort((a, b) => b.events - a.events || b.costUsd - a.costUsd);
  return { main: sorted[0] ?? null, others: sorted.slice(1) };
}

/** Multi-line plain-text tooltip listing every source of a model. */
export function sourceTooltip(shares: readonly CostSourceShare[]): string {
  const total = shares.reduce((n, s) => n + s.events, 0);
  return shares
    .map((s) => `${sourceLabel(s.source)}: ${s.events.toLocaleString('en-US')} call${s.events === 1 ? '' : 's'}${total > 0 ? ` (${Math.round((s.events / total) * 100)}%)` : ''}`)
    .join('\n');
}

export const shareOfEvents = (events: number, all: readonly CostSourceShare[]): number => {
  const total = all.reduce((n, s) => n + s.events, 0);
  return total === 0 ? 0 : events / total;
};
