import type { ParsedPriceList, PriceKind, PriceRow } from './pricing-parse';
import type { PriceTier } from './types';

// Third, lowest-priority price source: the public https://aws.amazon.com/bedrock/pricing/ page.
// It is HTML, not an API, so everything here is defensive: unknown layouts yield no rows (never a throw).

export const PAGE_URL = 'https://aws.amazon.com/bedrock/pricing/';
export const PAGE_REGION = 'us-east-1';
/** The page quotes dynamic prices per selected region; we read the US East (N. Virginia) column. */
const FEED_REGION = 'US East (N. Virginia)';
const FEEDS_ROOT = 'https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps';
/** Services whose feed prices are per 1M tokens, verified against the bulk offers. */
export const TRUSTED_FEED_SERVICES: readonly string[] = ['bedrockfoundationmodels'];

export type FeedRegions = Readonly<Record<string, Readonly<Record<string, { price?: string }>>>>;
export type Feeds = Readonly<Record<string, FeedRegions>>;

export interface PageParseResult extends ParsedPriceList {
  /** Why candidate rows were not ingested, as reason -> count. */
  skipped: Record<string, number>;
}

export function feedUrl(service: string): string {
  return `${FEEDS_ROOT}/${service}/USD/current/${service}.json`;
}

// ---- tiny tolerant HTML walker ----------------------------------------------------------------

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();
const VOID_TAGS = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'col', 'wbr', 'source', 'area', 'base']);
const TOKEN = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR)) {
    const name = m[1]?.toLowerCase();
    if (name) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

interface RawTable {
  rows: string[][];
  /** Panel ids from outermost to innermost. */
  panels: string[];
  /** Text of the nearest preceding "Regions: ..." paragraph in the innermost panel, if any. */
  regionsText: string | null;
  /** True for tables parsed from a data-pricing-markup block (prices are region-selectable). */
  fromMarkup: boolean;
}

interface MarkupBlock {
  markup: string;
  panels: string[];
}

interface WalkResult {
  tables: RawTable[];
  tabLabels: Map<string, string>;
  markup: MarkupBlock[];
}

interface Frame {
  tag: string;
  panel?: string;
}

/** Walks `html` once, collecting tab labels, tables (with panel chain and region text) and markup blocks. */
function walk(html: string, hostPanels: readonly string[], fromMarkup: boolean): WalkResult {
  const body = html.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  const result: WalkResult = { tables: [], tabLabels: new Map(), markup: [] };
  const stack: Frame[] = [];
  const panels = (): string[] => [...hostPanels, ...stack.flatMap((f) => (f.panel ? [f.panel] : []))];
  const regionsByPanel = new Map<string, string>();

  let tab: { panelId: string; depth: number; text: string } | null = null;
  let para: { depth: number; text: string } | null = null;
  let table: RawTable | null = null;
  let row: string[] | null = null;
  let cell: string | null = null;

  const addText = (raw: string): void => {
    const text = decodeEntities(raw);
    if (cell !== null) cell += text;
    else if (tab) tab.text += text;
    if (para && cell === null) para.text += text;
  };

  let last = 0;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(body); m !== null; m = TOKEN.exec(body)) {
    addText(body.slice(last, m.index));
    last = TOKEN.lastIndex;
    if (!m[2]) continue; // comment
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();

    if (closing) {
      let i = stack.length - 1;
      while (i >= 0 && stack[i]?.tag !== tag) i--;
      if (i < 0) continue;
      const depth = i;
      stack.length = i;
      if (tab && depth <= tab.depth && tag === 'li') {
        result.tabLabels.set(tab.panelId, collapse(tab.text));
        tab = null;
      }
      if (para && depth <= para.depth) {
        const text = collapse(para.text);
        const innermost = panels().at(-1);
        if (/^regions?:/i.test(text) && innermost) regionsByPanel.set(innermost, text);
        para = null;
      }
      if ((tag === 'td' || tag === 'th') && row && cell !== null) {
        row.push(collapse(cell));
        cell = null;
      } else if (tag === 'tr' && table && row) {
        table.rows.push(row);
        row = null;
      } else if (tag === 'table' && table) {
        result.tables.push(table);
        table = null;
      }
      continue;
    }

    const attrs = parseAttrs(m[3] ?? '');
    const selfClosing = VOID_TAGS.has(tag) || (m[3] ?? '').trimEnd().endsWith('/');
    if (tag === 'br' && cell !== null) cell += ' ';
    if (!selfClosing) {
      const panel = attrs.id && /-panel-\d+$/.test(attrs.id) ? attrs.id : undefined;
      stack.push({ tag, ...(panel ? { panel } : {}) });
      if (tag === 'li' && attrs.role === 'tab' && attrs['aria-controls']) {
        tab = { panelId: attrs['aria-controls'], depth: stack.length - 1, text: '' };
      }
      if (tag === 'p' && !table) para = { depth: stack.length - 1, text: '' };
      if (tag === 'table') {
        const p = panels();
        const innermost = p.at(-1);
        table = { rows: [], panels: p, regionsText: (innermost && regionsByPanel.get(innermost)) || null, fromMarkup };
      } else if (tag === 'tr' && table) row = [];
      else if ((tag === 'td' || tag === 'th') && row) cell = '';
    }
    const markup = attrs['data-pricing-markup'];
    if (markup) result.markup.push({ markup, panels: panels() });
  }
  return result;
}

// ---- table interpretation ---------------------------------------------------------------------

/** Tab labels that mark non-standard or non-token sections; tables below them are skipped. */
const SKIP_LABELS = /priority|flex|batch|customization|custom model|reserved|provisioned|evaluat|guardrail|knowledge|training|latency|agent|automation/i;
const SKIP_MODEL_NAMES = /^(model selected|price per|custom model|monthly storage|index storage)/i;
const PLACEHOLDER = /\{priceOf!([^!}]+)!([^}]+)\}/;

interface Column {
  index: number;
  kind: PriceKind;
  /** Multiplier to turn the quoted price into USD per 1M tokens. */
  factor: number;
}

function unitFactor(header: string): number | null {
  if (/per\s+1\s*m\b|per\s+1,000,000|per\s+million/i.test(header)) return 1;
  if (/per\s+1,?000\b|per\s+1\s*k\b/i.test(header)) return 1000;
  return null;
}

/** Maps a header cell to a price kind, or null when it is not a plain on-demand token column. */
function columnOf(header: string, index: number): Column | null {
  const h = collapse(header).toLowerCase();
  if (/batch|long-?context|\((text|image|video|audio)\)|commitment|per hour|training|storage/.test(h)) return null;

  const cacheWrite = /cache write\)?[\s\-–(]*(\d+)\s*(m|min|minutes?|h|hours?)?\)?|\((\d+)\s*(m|h)\s*cache write\)/.exec(h);
  if (cacheWrite) {
    const n = Number(cacheWrite[1] ?? cacheWrite[3]);
    const unit = (cacheWrite[2] ?? cacheWrite[4] ?? 'm').charAt(0);
    const minutes = unit === 'h' ? n * 60 : n;
    if (!Number.isFinite(minutes)) return null;
    return { index, kind: minutes === 60 ? 'cache_write_1h' : 'cache_write_5m', factor: unitFactor(h) ?? 1 };
  }
  if (/cache read/.test(h)) return { index, kind: 'cache_read', factor: unitFactor(h) ?? 1 };
  if (/^input$/.test(h)) return { index, kind: 'input', factor: 1 };
  if (/^output$/.test(h)) return { index, kind: 'output', factor: 1 };
  if (/^price per .* input tokens?$/.test(h)) {
    const f = unitFactor(h);
    return f === null ? null : { index, kind: 'input', factor: f };
  }
  if (/^price per .* output tokens?$/.test(h)) {
    const f = unitFactor(h);
    return f === null ? null : { index, kind: 'output', factor: f };
  }
  return null;
}

function priceOfCell(text: string, feeds: Feeds): number | null {
  const ph = PLACEHOLDER.exec(text);
  if (ph) {
    const service = (ph[1] ?? '').split('/')[0] ?? '';
    if (!TRUSTED_FEED_SERVICES.includes(service)) return null;
    const raw = feeds[service]?.[FEED_REGION]?.[ph[2] ?? '']?.price;
    const n = Number(raw);
    return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (!/\d/.test(text)) return null;
  const n = Number(text.replace(/[$,\s*†]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const OPTION_TIERS: Readonly<Record<string, PriceTier>> = { 'global cris': 'global', 'us cris': 'regional' };

function tableRows(
  t: RawTable,
  labels: ReadonlyMap<string, string>,
  feeds: Feeds,
  skip: (reason: string) => void,
): PriceRow[] {
  const none = (reason: string): PriceRow[] => {
    skip(reason);
    return [];
  };
  const chain = t.panels.map((p) => labels.get(p) ?? '');
  if (chain.some((l) => SKIP_LABELS.test(l))) return none('non-standard section');
  const header = t.rows[0];
  if (!header || t.rows.length < 2) return [];
  const columns = header.flatMap((h, i) => (i === 0 ? [] : [columnOf(h, i)])).filter((c): c is Column => c !== null);
  if (!columns.some((c) => c.kind === 'input') || !columns.some((c) => c.kind === 'output')) return none('no token columns');

  const isOptionTable = /^inference option$/i.test(header[0] ?? '');
  const isModelTable = /models$/i.test(collapse(header[0] ?? ''));
  if (!isOptionTable && !isModelTable) return none('unrecognised table');
  // Anthropic tables mix global and regional prices without labelling which is which.
  if (/^anthropic/i.test(collapse(header[0] ?? ''))) return none('anthropic table: global/regional ambiguous');

  // Inference-option tables carry the model name only in the surrounding tab ("Z AI > GLM 5.3").
  const tabModel = chain.length >= 3 ? [...chain].reverse().find((l) => l && !/^(standard|on-demand.*)$/i.test(l)) : undefined;
  if (isOptionTable && !tabModel) return none('unnamed inference-option table');
  if (isModelTable && !t.fromMarkup && !/US East \(N\. Virginia\)/i.test(t.regionsText ?? '')) {
    return none('region not US East (N. Virginia)');
  }

  const out: PriceRow[] = [];
  for (const r of t.rows.slice(1)) {
    const label = collapse(r[0] ?? '').replace(/[*†]+$/, '').trim();
    let model = label;
    let tier: PriceTier = 'regional';
    if (isOptionTable) {
      const mapped = OPTION_TIERS[label.toLowerCase()];
      if (!mapped) {
        skip(`inference option "${label}"`);
        continue;
      }
      tier = mapped;
      model = tabModel as string;
    } else if (!label || SKIP_MODEL_NAMES.test(label)) continue;

    const rowPrices: PriceRow[] = [];
    for (const c of columns) {
      const v = priceOfCell(r[c.index] ?? '', feeds);
      if (v !== null) rowPrices.push({ model, region: PAGE_REGION, tier, kind: c.kind, longCtx: false, usdPerMtok: v * c.factor });
    }
    if (rowPrices.some((p) => p.kind === 'input') && rowPrices.some((p) => p.kind === 'output')) out.push(...rowPrices);
    else skip('unresolved price');
  }
  return out;
}

/** Distinct feed services referenced by price placeholders in the page, restricted to trusted ones. */
export function pageServices(html: string): string[] {
  const found = new Set<string>();
  for (const m of decodeEntities(html).matchAll(/\{priceOf!([a-z0-9_-]+)\//gi)) {
    if (m[1] && TRUSTED_FEED_SERVICES.includes(m[1])) found.add(m[1]);
  }
  return [...found];
}

/** Highest price wins on duplicate keys (same rule as the bulk parsers); sorted for a stable hash. */
function collectRows(rows: readonly PriceRow[]): PriceRow[] {
  const key = (r: PriceRow): string => `${r.model}|${r.region}|${r.tier}|${r.kind}|${r.longCtx}`;
  const byKey = new Map<string, PriceRow>();
  for (const r of rows) {
    const prev = byKey.get(key(r));
    if (!prev || r.usdPerMtok > prev.usdPerMtok) byKey.set(key(r), r);
  }
  return [...byKey.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

/**
 * Parses the pricing page. Understands literal tables and data-pricing-markup blocks whose cells are
 * `{priceOf!<service>/<service>!<hash>}` placeholders (resolved through `feeds`, US East column).
 * Only standard on-demand US East (N. Virginia) token prices are returned: "Global CRIS" and "US CRIS"
 * rows of inference-option tables, and model tables whose region list includes US East (N. Virginia)
 * (or whose prices come from the region-selectable feed). Never throws on unexpected markup.
 */
export function parsePricingPage(html: string, feeds: Feeds): PageParseResult {
  const skipped: Record<string, number> = {};
  const skip = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const page = walk(html, [], false);
  const labels = new Map(page.tabLabels);
  const tables = [...page.tables];
  for (const block of page.markup) {
    const inner = walk(decodeEntities(block.markup).includes('<table') ? block.markup : '', block.panels, true);
    tables.push(...inner.tables);
  }
  const rows = tables.flatMap((t) => tableRows(t, labels, feeds, skip));
  return { rows: collectRows(rows), skipped };
}
