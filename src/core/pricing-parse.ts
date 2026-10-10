import type { PriceTier } from './types';

export type PriceKind = 'input' | 'output' | 'cache_read' | 'cache_write_5m' | 'cache_write_1h';

export interface PriceRow {
  model: string;
  region: string;
  tier: PriceTier;
  kind: PriceKind;
  longCtx: boolean;
  /** USD per 1M tokens. */
  usdPerMtok: number;
}

export interface ParsedPriceList {
  publicationDate?: string;
  rows: PriceRow[];
}

export interface UsageClass {
  kind: PriceKind;
  tier: PriceTier;
  longCtx: boolean;
}

const TOKEN_TYPES = new Set([
  'Input tokens',
  'Output tokens',
  'Prompt cache read input tokens',
  'Prompt cache write input tokens',
]);
const TOKEN_UNIT = '1M tokens';
/** Service tiers / purchase options that are not plain on-demand standard pricing. */
const NON_STANDARD = /batch|latencyoptimized|reserved|priority|flex|provisioned|custommodel|tpm/;

/** Body of a usagetype: drops the region prefix (+ "MP:REGION_" marketplace prefix) and "-Units" suffix. */
function usageBody(usagetype: string): string {
  const noRegion = usagetype.replace(/^[A-Z0-9]+-(?:MP:[A-Z0-9]+_)?/, '');
  return noRegion.replace(/-Units$/, '').toLowerCase();
}

/**
 * Classifies an AWS usagetype into kind/tier/long-context, or null when it is not a plain
 * on-demand standard token price (batch, latency-optimized, reserved, 30m cache TTL, ...).
 * Works on both naming families seen in the price list:
 *   input_tokens_long_ctx_global_standard   and   CacheWrite1hInputTokenCount_Global
 */
export function classifyUsageType(usagetype: string): UsageClass | null {
  const body = usageBody(usagetype);
  if (NON_STANDARD.test(body)) return null;

  let kind: PriceKind;
  if (/cache_?read/.test(body)) kind = 'cache_read';
  else if (/cache_?write/.test(body)) {
    if (/30m/.test(body)) return null;
    kind = /1h/.test(body) ? 'cache_write_1h' : 'cache_write_5m';
  } else if (/^input|input_?token/.test(body)) kind = 'input';
  else if (/^output|output_?token/.test(body)) kind = 'output';
  else return null;

  return {
    kind,
    tier: /(^|_)global($|_)/.test(body) ? 'global' : 'regional',
    longCtx: /long_?ctx/.test(body),
  };
}

interface RawAttributes {
  model?: string;
  regionCode?: string;
  inferenceType?: string | null;
  usagetype?: string;
  service_tier?: string | null;
  tokenType?: string | null;
}
interface RawPriceDimension {
  unit?: string;
  pricePerUnit?: { USD?: string };
}
interface RawPriceList {
  publicationDate?: string;
  products?: Record<string, { attributes?: RawAttributes }>;
  terms?: { OnDemand?: Record<string, Record<string, { priceDimensions?: Record<string, RawPriceDimension> }>> };
}

function isRawPriceList(v: unknown): v is RawPriceList {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as RawPriceList;
  return typeof r.products === 'object' && r.products !== null && typeof r.terms === 'object' && r.terms !== null;
}

type UnitFactor = (unit: string | undefined) => number | null;

/** USD per 1M tokens for a SKU, or null when it has no usable on-demand token price. */
function onDemandUsdPerMtok(
  terms: NonNullable<RawPriceList['terms']>,
  sku: string,
  factor: UnitFactor,
): number | null {
  const offer = terms.OnDemand?.[sku];
  if (!offer) return null;
  for (const term of Object.values(offer)) {
    for (const dim of Object.values(term.priceDimensions ?? {})) {
      const f = factor(dim.unit);
      if (f === null) continue;
      const usd = Number(dim.pricePerUnit?.USD);
      if (Number.isFinite(usd) && usd >= 0) return usd * f;
    }
  }
  return null;
}

const perMillion: UnitFactor = (unit) => (unit === TOKEN_UNIT ? 1 : null);
/** The AmazonBedrock offer quotes per 1K tokens ("1K tokens" / "1k tokens"). */
const perThousand: UnitFactor = (unit) => (/^1k tokens$/i.test(unit ?? '') ? 1000 : null);

function rowKey(r: PriceRow): string {
  return `${r.model}\u0000${r.region}\u0000${r.tier}\u0000${r.kind}\u0000${r.longCtx}`;
}

/** Highest price wins on duplicate keys, so an estimate never under-reports; output is sorted. */
function collect(rows: Iterable<PriceRow>): PriceRow[] {
  const byKey = new Map<string, PriceRow>();
  for (const row of rows) {
    const prev = byKey.get(rowKey(row));
    if (!prev || row.usdPerMtok > prev.usdPerMtok) byKey.set(rowKey(row), row);
  }
  const sortKey = (r: PriceRow): string => `${r.model}|${r.region}|${r.tier}|${r.kind}|${r.longCtx}`;
  return [...byKey.values()].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
}

/**
 * Parses an AWS Price List offer file (AmazonBedrockFoundationModels) into on-demand
 * standard token rows. Throws if the document does not look like a price list.
 * Duplicate (model, region, tier, kind, longCtx) rows keep the highest price, so an
 * estimate never under-reports.
 */
export function parsePriceList(json: unknown): ParsedPriceList {
  if (!isRawPriceList(json)) throw new Error('not an AWS price list document');
  const { products = {}, terms = {} } = json;
  const rows: PriceRow[] = [];

  for (const [sku, product] of Object.entries(products)) {
    const a = product.attributes;
    if (!a?.model || !a.regionCode || !a.usagetype || !a.inferenceType || !TOKEN_TYPES.has(a.inferenceType)) continue;
    const cls = classifyUsageType(a.usagetype);
    if (!cls) continue;
    const usd = onDemandUsdPerMtok(terms, sku, perMillion);
    if (usd === null) continue;
    rows.push({ model: a.model, region: a.regionCode, ...cls, usdPerMtok: usd });
  }
  return { publicationDate: json.publicationDate, rows: collect(rows) };
}

/** inferenceType values of plain on-demand token prices in the AmazonBedrock offer. */
const BEDROCK_TYPES: Readonly<Record<string, { kind: PriceKind; global: boolean }>> = {
  'Input tokens': { kind: 'input', global: false },
  'Input tokens global': { kind: 'input', global: true },
  'Output tokens': { kind: 'output', global: false },
  'Output tokens global': { kind: 'output', global: true },
  'Cache read tokens': { kind: 'cache_read', global: false },
  'Cache read tokens global': { kind: 'cache_read', global: true },
  'Prompt cache read input tokens': { kind: 'cache_read', global: false },
  'Prompt cache write input tokens': { kind: 'cache_write_5m', global: false },
};
/**
 * Some rows are labelled "Input tokens" but are batch/flex/priority (only the usagetype says so),
 * and custom-model rows are billed per model unit; neither is plain on-demand pricing.
 */
const BEDROCK_EXCLUDE = /batch|flex|priority|custom-?model|provisioned|reserved|latency|30m|tpm/i;

/**
 * Parses the AmazonBedrock offer (non-Anthropic models: DeepSeek, GLM, Kimi, Qwen, gpt-oss...).
 * Prices are quoted per 1K tokens and are converted to USD per 1M. Keeps only standard
 * on-demand input/output/cache token rows; batch, flex, priority, provisioned and custom-model
 * rows are skipped. Throws if the document does not look like a price list.
 */
export function parseBedrockOffer(json: unknown): ParsedPriceList {
  if (!isRawPriceList(json)) throw new Error('not an AWS price list document');
  const { products = {}, terms = {} } = json;
  const rows: PriceRow[] = [];

  for (const [sku, product] of Object.entries(products)) {
    const a = product.attributes;
    if (!a?.model || !a.regionCode || !a.usagetype || !a.inferenceType) continue;
    const type = BEDROCK_TYPES[a.inferenceType];
    if (!type || BEDROCK_EXCLUDE.test(a.usagetype)) continue;
    const tierAttr = a.service_tier ?? null;
    if (tierAttr !== null && tierAttr !== 'standard' && tierAttr !== 'global-standard') continue;
    const usd = onDemandUsdPerMtok(terms, sku, perThousand);
    if (usd === null) continue;
    const kind: PriceKind = type.kind === 'cache_write_5m' && /1h/.test(a.usagetype) ? 'cache_write_1h' : type.kind;
    rows.push({
      model: a.model,
      region: a.regionCode,
      tier: type.global || tierAttr === 'global-standard' ? 'global' : 'regional',
      kind,
      longCtx: /long[-_]?ctx/i.test(`${a.usagetype} ${a.tokenType ?? ''}`),
      usdPerMtok: usd,
    });
  }
  return { publicationDate: json.publicationDate, rows: collect(rows) };
}
