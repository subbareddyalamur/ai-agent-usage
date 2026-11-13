import type { ExternalPrice } from './pricing-modelsdev';

/**
 * Provider pricing pages, checked on the same daily cadence as the AWS price list.
 * Standard (not batch) token rates only. A dated "through" / "starting" sentence uses the
 * rate in effect at `now`. models.dev still fills any model these pages do not list.
 *
 * Called from refresh() in pricing.ts. pricing-sources.ts is AWS only, and
 * pricing-modelsdev.ts is the third-party catalogue. This module only parses text.
 */
export interface OfficialFeed {
  id: string;
  provider: string;
  url: string;
}

export const OFFICIAL_FEEDS: readonly OfficialFeed[] = [
  { id: 'google', provider: 'google', url: 'https://ai.google.dev/gemini-api/docs/pricing' },
  { id: 'anthropic', provider: 'anthropic', url: 'https://platform.claude.com/docs/en/about-claude/pricing.md' },
  { id: 'openai', provider: 'openai', url: 'https://developers.openai.com/api/docs/pricing.md' },
  { id: 'xai', provider: 'xai', url: 'https://docs.x.ai/developers/pricing.md' },
];

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

function decode(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function clean(cell: string): string {
  return cell
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function usd(cell: string): number | null {
  const m = cell.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/** UTC midnight, or the last millisecond of that UTC day when `end` is set. */
function utcDay(label: string, end: boolean): number | null {
  const m = label.trim().toLowerCase().match(/^([a-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1] ?? '');
  if (month < 0) return null;
  const start = Date.UTC(Number(m[3]), month, Number(m[2]));
  if (Number.isNaN(start)) return null;
  return end ? start + 86_400_000 - 1 : start;
}

/** The dollar amount in effect at `now`. Dated sentences win over a bare amount. */
export function priceInEffect(cell: string, now: number): number | null {
  const text = cell.replace(/\s+/g, ' ');
  let through: number | null = null;
  let starting: number | null = null;
  let sawDated = false;
  for (const m of text.matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)\s+through\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/g)) {
    sawDated = true;
    const until = utcDay(m[2] ?? '', true);
    if (until !== null && now <= until) through = Number(m[1]);
  }
  for (const m of text.matchAll(/\$\s*([0-9]+(?:\.[0-9]+)?)\s+starting\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/g)) {
    sawDated = true;
    const from = utcDay(m[2] ?? '', false);
    if (from !== null && now >= from) starting = Number(m[1]);
  }
  if (starting !== null) return starting;
  if (through !== null) return through;
  if (sawDated) return null;
  return usd(text.replace(/per hour/gi, ''));
}

function tables(md: string): string[][][] {
  const out: string[][][] = [];
  let cur: string[][] | null = null;
  for (const line of md.split('\n')) {
    if (!line.trim().startsWith('|')) {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => clean(c));
    if (cells.every((c) => /^:?-+:?$/.test(c.replace(/\s/g, '')))) continue;
    cur ??= [];
    cur.push(cells);
  }
  if (cur) out.push(cur);
  return out;
}

function col(header: readonly string[], pred: (h: string) => boolean): number {
  return header.findIndex((h) => pred(h.toLowerCase()));
}

function rowPrice(cells: readonly string[], index: number, now: number): number | null {
  if (index < 0) return null;
  const cell = cells[index] ?? '';
  if (cell === '-' || cell === '') return null;
  return priceInEffect(cell, now) ?? usd(cell);
}

function entry(
  provider: string,
  modelId: string,
  name: string,
  input: number | null,
  output: number | null,
  cacheRead: number | null,
  cacheWrite: number | null,
  cacheWrite1h: number | null,
): ExternalPrice | null {
  if (input === null || output === null || !modelId) return null;
  return { provider, modelId, name, input, output, cacheRead, cacheWrite, cacheWrite1h, origin: 'official' };
}

function parseGoogle(text: string, now: number): ExternalPrice[] {
  const doc = decode(text);
  const out: ExternalPrice[] = [];
  const seen = new Set<string>();
  for (const section of doc.split(/^## /m).slice(1)) {
    const ids = [...section.matchAll(/\[`(gemini-[a-z0-9.-]+)`\]/g)].map((m) => m[1] ?? '');
    const standard = section.match(/\{% tab title="Standard" %\}([\s\S]*?)\{% \/tab %\}/)?.[1];
    if (!standard || ids.length === 0) continue;
    let input: number | null = null;
    let output: number | null = null;
    let cacheRead: number | null = null;
    for (const block of standard.split(/\n\s*---\s*\n/)) {
      const cells: string[][] = [];
      for (const line of block.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('* ')) cells.push([trimmed.slice(2)]);
        else if (cells.length > 0) cells[cells.length - 1]?.push(trimmed);
      }
      const feature = (cells[0]?.join(' ') ?? '').toLowerCase();
      const paid = cells.at(-1)?.join(' ') ?? '';
      if (feature.startsWith('input price')) input = priceInEffect(paid, now);
      else if (feature.startsWith('output price')) output = priceInEffect(paid, now);
      else if (feature.startsWith('context caching')) cacheRead = priceInEffect(paid, now);
    }
    for (const id of ids) {
      if (seen.has(id)) continue;
      const row = entry('google', id, id, input, output, cacheRead, null, null);
      if (!row) continue;
      seen.add(id);
      out.push(row);
    }
  }
  return out;
}

function parseAnthropic(text: string, now: number): ExternalPrice[] {
  const doc = text.split(/^## /m)[1] ?? text;
  const table = tables(doc).find((t) => (t[0] ?? []).some((c) => c.toLowerCase().includes('base input')));
  if (!table) return [];
  const header = table[0] ?? [];
  const inputAt = col(header, (h) => h.includes('base input'));
  const write5 = col(header, (h) => h.includes('5m'));
  const write1h = col(header, (h) => h.includes('1h'));
  const readAt = col(header, (h) => h.includes('cache hit'));
  const outputAt = col(header, (h) => h.includes('output'));
  const out: ExternalPrice[] = [];
  const seen = new Set<string>();
  for (const cells of table.slice(1)) {
    const raw = cells[0] ?? '';
    if (/over\s+[\d,]+/.test(raw.toLowerCase())) continue;
    const name = raw.replace(/\([^)]*\)/g, '').trim();
    const modelId = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (seen.has(modelId)) continue;
    const row = entry(
      'anthropic', modelId, name,
      rowPrice(cells, inputAt, now), rowPrice(cells, outputAt, now),
      rowPrice(cells, readAt, now), rowPrice(cells, write5, now), rowPrice(cells, write1h, now),
    );
    if (!row) continue;
    seen.add(modelId);
    out.push(row);
  }
  return out;
}

function parseOpenAI(text: string, now: number): ExternalPrice[] {
  const doc = text.split(/\nBatch\b/)[0] ?? text;
  const out: ExternalPrice[] = [];
  const seen = new Set<string>();
  for (const table of tables(doc)) {
    const header = table[0] ?? [];
    const lower = header.map((h) => h.toLowerCase());
    const short = lower.some((h) => h.includes('short context'));
    const inputAt = col(header, (h) => (short ? h.includes('short context input') : h === 'input'));
    const outputAt = col(header, (h) => (short ? h.includes('short context output') : h === 'output'));
    const readAt = col(header, (h) => (short ? h.includes('short context cached') : h.includes('cached input')));
    const write5 = col(header, (h) => short && h.includes('30m'));
    const write1h = col(header, (h) => short && h.includes('12h'));
    if (inputAt < 0 || outputAt < 0) continue;
    for (const cells of table.slice(1)) {
      const modelId = (cells[0] ?? '').split('(')[0]?.trim().toLowerCase() ?? '';
      if (!modelId || seen.has(modelId)) continue;
      const row = entry(
        'openai', modelId, modelId,
        rowPrice(cells, inputAt, now), rowPrice(cells, outputAt, now),
        rowPrice(cells, readAt, now), rowPrice(cells, write5, now), rowPrice(cells, write1h, now),
      );
      if (!row) continue;
      seen.add(modelId);
      out.push(row);
    }
  }
  return out;
}

function parseXai(text: string, now: number): ExternalPrice[] {
  const doc = text.split(/### Text API/)[1]?.split(/\n### /)[0] ?? '';
  const table = tables(doc)[0];
  if (!table) return [];
  const header = table[0] ?? [];
  const inputAt = col(header, (h) => h.startsWith('input'));
  const readAt = col(header, (h) => h.includes('cached'));
  const outputAt = col(header, (h) => h.startsWith('output'));
  const out: ExternalPrice[] = [];
  const seen = new Set<string>();
  for (const cells of table.slice(1)) {
    const raw = cells[0] ?? '';
    if (/≥|>=/.test(raw)) continue;
    const modelId = raw.split('(')[0]?.trim().toLowerCase() ?? '';
    if (!modelId || seen.has(modelId)) continue;
    const row = entry(
      'xai', modelId, modelId,
      rowPrice(cells, inputAt, now), rowPrice(cells, outputAt, now),
      rowPrice(cells, readAt, now), null, null,
    );
    if (!row) continue;
    seen.add(modelId);
    out.push(row);
  }
  return out;
}

/** Parses one official pricing page. Throws when the page has no standard token rates. */
export function parseOfficial(provider: string, text: string, now: number): ExternalPrice[] {
  const rows = provider === 'google' ? parseGoogle(text, now)
    : provider === 'anthropic' ? parseAnthropic(text, now)
      : provider === 'openai' ? parseOpenAI(text, now)
        : provider === 'xai' ? parseXai(text, now)
          : [];
  if (rows.length === 0) throw new Error('price list contained no token prices');
  return rows;
}
