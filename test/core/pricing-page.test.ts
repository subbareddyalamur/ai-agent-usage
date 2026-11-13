import { describe, expect, test } from 'bun:test';
import { decodeEntities, feedUrl, pageServices, parsePricingPage, PAGE_REGION, TRUSTED_FEED_SERVICES } from '../../src/core/pricing-page';
import feedFixture from '../fixtures/pricing-feed-mini.json';

const pageFixture = await Bun.file(new URL('../fixtures/pricing-page-mini.html', import.meta.url)).text();
const feeds = { bedrockfoundationmodels: feedFixture.regions };

type R = ReturnType<typeof parsePricingPage>['rows'][number];
const price = (rows: readonly R[], model: string, tier: string, kind: string): number | undefined =>
  rows.find((r) => r.model === model && r.tier === tier && r.kind === kind)?.usdPerMtok;

/** Wraps a table in the tab chain the real page uses (Model Pricing > Provider > Tab). */
function page(table: string, opts: { regions?: string; labels?: string[] } = {}): string {
  const labels = opts.labels ?? ['Model Pricing', 'Provider', 'Tab'];
  const tabs = labels.map((l, i) => `<li role="tab" aria-controls="p-panel-${i}">${l}</li>`).join('');
  const open = labels.map((_, i) => `<div id="p-panel-${i}">`).join('');
  const regions = opts.regions ? `<p><b>${opts.regions}</b></p>` : '';
  return `<ul role="tablist">${tabs}</ul>${open}${regions}${table}${labels.map(() => '</div>').join('')}`;
}
const modelsTable = (header: string[], ...rows: string[][]): string =>
  `<table><tr>${header.map((h) => `<td>${h}</td>`).join('')}</tr>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</table>`;
const US = 'Regions: US East (N. Virginia), US East (Ohio)';

describe('decodeEntities', () => {
  test.each([
    ['a &amp; b', 'a & b'], ['&lt;p&gt;', '<p>'], ['&quot;x&quot; &#39;y&#39;', '"x" \'y\''], ['a&nbsp;b', 'a b'],
    ['&#x41;&#66;', 'AB'], ['&unknown; &#xZZ; &#0;', '&unknown; &#xZZ; &#0;'], ['&#1114112;', '&#1114112;'],
  ])('%s', (input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });
});

describe('parsePricingPage: the real-shaped fixture', () => {
  const { rows, skipped } = parsePricingPage(pageFixture, feeds);

  test('GLM 5.3 inference-option table: Global CRIS -> global, US CRIS -> regional, us-east-1', () => {
    expect(price(rows, 'GLM 5.3', 'global', 'input')).toBeCloseTo(1.68, 9);
    expect(price(rows, 'GLM 5.3', 'global', 'output')).toBeCloseTo(5.28, 9);
    expect(price(rows, 'GLM 5.3', 'global', 'cache_read')).toBeCloseTo(0.312, 9);
    expect(price(rows, 'GLM 5.3', 'global', 'cache_write_5m')).toBeCloseTo(2.1, 9);
    expect(price(rows, 'GLM 5.3', 'regional', 'input')).toBeCloseTo(1.848, 9);
    expect(price(rows, 'GLM 5.3', 'regional', 'output')).toBeCloseTo(5.808, 9);
    expect(price(rows, 'GLM 5.3', 'regional', 'cache_read')).toBeCloseTo(0.3432, 9);
    expect(price(rows, 'GLM 5.3', 'regional', 'cache_write_5m')).toBeCloseTo(2.31, 9);
    expect(rows.every((r) => r.region === PAGE_REGION && !r.longCtx)).toBe(true);
  });

  test('literal model tables count only when the preceding region list includes US East (N. Virginia)', () => {
    expect(price(rows, 'GLM 5', 'regional', 'input')).toBe(1);
    expect(price(rows, 'GLM 5', 'regional', 'output')).toBe(3.2);
    expect(price(rows, 'Devstral 2 123B', 'regional', 'input')).toBe(0.4); // not the Frankfurt 0.48
    expect(price(rows, 'Magistral Small 1.2', 'regional', 'output')).toBe(1.5); // footnote asterisk is ignored
  });

  test('data-pricing-markup placeholders resolve through the feed (US East column only)', () => {
    expect(price(rows, 'Jurassic-2 Mid', 'regional', 'input')).toBe(12.5);
    expect(price(rows, 'Jurassic-2 Ultra', 'regional', 'output')).toBe(18.8);
  });

  test('only the standard tier is read', () => {
    expect(price(rows, 'DeepSeek v3.2', 'regional', 'input')).toBe(0.62);
    expect(price(rows, 'DeepSeek v3.2', 'regional', 'output')).toBe(1.85);
    expect(rows.filter((r) => r.model === 'DeepSeek v3.2')).toHaveLength(2);
  });

  test('everything that cannot be mapped confidently is skipped, and counted', () => {
    const models = new Set(rows.map((r) => r.model));
    for (const bad of ['Ghost Model', 'Other Service Model', 'Claude Page Only', 'Eval Model', 'Script Model']) {
      expect(models.has(bad)).toBe(false);
    }
    expect(skipped).toEqual({
      'region not US East (N. Virginia)': 3, // GLM 5 x2, Devstral Frankfurt
      'non-standard section': 3, // DeepSeek Priority + Batch, Model Evaluation
      'unresolved price': 2, // hash missing in the feed; placeholder of an untrusted service
      'anthropic table: global/regional ambiguous': 1,
    });
  });

  test('output is sorted and has one row per key', () => {
    const keys = rows.map((r) => `${r.model}|${r.region}|${r.tier}|${r.kind}|${r.longCtx}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([...keys].sort((a, b) => a.localeCompare(b)));
  });
});

describe('parsePricingPage: columns and units', () => {
  const parse = (html: string) => parsePricingPage(html, feeds).rows;

  test('"per 1,000" and "per 1K" headers are scaled to per 1M', () => {
    const rows = parse(page(modelsTable(['Old models', 'Price per 1,000 input tokens', 'Price per 1K output tokens'], ['Old One', '$0.001', '$0.002']), { regions: US }));
    expect(price(rows, 'Old One', 'regional', 'input')).toBeCloseTo(1, 9);
    expect(price(rows, 'Old One', 'regional', 'output')).toBeCloseTo(2, 9);
  });

  test('cache columns: 60 minutes is the 1h write, any other TTL maps to the 5m write', () => {
    const header = ['Inference option', 'Input', 'Output', 'Cache read', 'Cache write (60 min)'];
    const tbl = modelsTable(header, ['US CRIS', '$1', '$2', '$0.1', '$1.25']);
    expect(price(parse(page(tbl)), 'Tab', 'regional', 'cache_write_1h')).toBe(1.25);
    const tbl30 = modelsTable([...header.slice(0, 4), 'Cache write - 30m'], ['US CRIS', '$1', '$2', '$0.1', '$1.5']);
    expect(price(parse(page(tbl30)), 'Tab', 'regional', 'cache_write_5m')).toBe(1.5);
    const tbl90 = modelsTable([...header.slice(0, 4), 'Cache write - 90m'], ['US CRIS', '$1', '$2', '$0.1', '$1.6']);
    expect(price(parse(page(tbl90)), 'Tab', 'regional', 'cache_write_5m')).toBe(1.6);
    const tblH = modelsTable([...header.slice(0, 4), 'Cache write (1 hour)'], ['US CRIS', '$1', '$2', '$0.1', '$1.7']);
    expect(price(parse(page(tblH)), 'Tab', 'regional', 'cache_write_1h')).toBe(1.7);
  });

  test('explicit "(5m cache write)" / "(1h cache write)" / "(cache read)" headers', () => {
    const h = ['New models', 'Price per 1M input tokens', 'Price per 1M output tokens', 'Price per 1M input tokens (5m cache write)', 'Price per 1M input tokens (1h cache write)', 'Price per 1M input tokens (cache read)'];
    const rows = parse(page(modelsTable(h, ['M', '$1', '$2', '$1.25', '$2', '$0.1']), { regions: US }));
    expect(price(rows, 'M', 'regional', 'cache_write_5m')).toBe(1.25);
    expect(price(rows, 'M', 'regional', 'cache_write_1h')).toBe(2);
    expect(price(rows, 'M', 'regional', 'cache_read')).toBe(0.1);
  });

  test('batch, long-context, modality and commitment columns are ignored', () => {
    const h = ['X models', 'Price per 1M input tokens', 'Price per 1M output tokens', 'Price per 1M input tokens (batch)', 'Price per 1M long-context input tokens', 'Price per 1M input tokens (text)', 'Price per hour per model unit'];
    const rows = parse(page(modelsTable(h, ['M', '$1', '$2', '$0.5', '$3', '$4', '$99']), { regions: US }));
    expect(rows.map((r) => r.kind).sort()).toEqual(['input', 'output']);
  });

  test('a table without both input and output columns yields nothing', () => {
    expect(parse(page(modelsTable(['X models', 'Price per 1M input tokens'], ['M', '$1']), { regions: US }))).toEqual([]);
  });

  test('a row needs both an input and an output price', () => {
    const rows = parse(page(modelsTable(['X models', 'Price per 1M input tokens', 'Price per 1M output tokens'], ['Half', '$1', 'TBD'], ['Whole', '$1', '$2']), { regions: US }));
    expect(rows.map((r) => r.model)).toEqual(['Whole', 'Whole']);
  });

  test('inference options other than Global/US CRIS are skipped', () => {
    const tbl = modelsTable(['Inference option', 'Input', 'Output'], ['EU CRIS', '$1', '$2'], ['In-region', '$1', '$2'], ['APAC CRIS', '$1', '$2'], ['Global CRIS', '$3', '$4']);
    const r = parsePricingPage(page(tbl), feeds);
    expect(r.rows.map((x) => x.tier)).toEqual(['global', 'global']);
    expect(r.skipped['inference option "EU CRIS"']).toBe(1);
  });

  test('an inference-option table with no model tab around it cannot be named, so it is skipped', () => {
    const tbl = modelsTable(['Inference option', 'Input', 'Output'], ['US CRIS', '$1', '$2']);
    const r = parsePricingPage(page(tbl, { labels: ['Model Pricing', 'Provider'] }), feeds);
    expect(r.rows).toEqual([]);
    expect(r.skipped['unnamed inference-option table']).toBe(1);
  });

  test('the model name skips "Standard"/"On-Demand" sub-tabs', () => {
    const tbl = modelsTable(['Inference option', 'Input', 'Output'], ['US CRIS', '$1', '$2']);
    const rows = parse(page(tbl, { labels: ['Model Pricing', 'Z AI', 'GLM 9', 'Standard'] }));
    expect(rows.map((r) => r.model)).toEqual(['GLM 9', 'GLM 9']);
  });

  test('a model table without a region list is skipped', () => {
    expect(parse(page(modelsTable(['X models', 'Price per 1M input tokens', 'Price per 1M output tokens'], ['M', '$1', '$2'])))).toEqual([]);
  });

  test('"Region:" (singular) paragraphs are understood too', () => {
    const rows = parse(page(modelsTable(['X models', 'Price per 1M input tokens', 'Price per 1M output tokens'], ['M', '$1', '$2']), { regions: 'Region: US East (N. Virginia)' }));
    expect(rows).toHaveLength(2);
  });

  test('non-token section labels and storage rows are skipped', () => {
    const t = modelsTable(['X models', 'Price per 1M input tokens', 'Price per 1M output tokens'], ['Monthly storage cost per Custom Model Unit', '$1', '$2']);
    expect(parse(page(t, { regions: US }))).toEqual([]);
  });
});

describe('parsePricingPage: placeholders', () => {
  const ph = (hash: string, svc = 'bedrockfoundationmodels'): string => `{priceOf!${svc}/${svc}!${hash}}`;
  const feed = (prices: Record<string, string>) => ({
    bedrockfoundationmodels: { 'US East (N. Virginia)': Object.fromEntries(Object.entries(prices).map(([h, p]) => [h, { price: p }])), 'US West (Oregon)': { H1: { price: '999' } } },
  });
  const markup = (table: string): string => `<div id="m-panel-0" data-pricing-markup="${table.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}"></div>`;
  const tbl = (...rows: string[][]): string => `<p>{regionSelector}</p>${modelsTable(['X models', 'Price per 1M input tokens', 'Price per 1M output tokens'], ...rows)}`;

  test('resolves through the feed regardless of region lists, using the US East column', () => {
    const html = `<ul role="tablist"><li role="tab" aria-controls="m-panel-0">Model Pricing</li></ul>${markup(tbl(['M', ph('H1'), ph('H2')]))}`;
    const rows = parsePricingPage(html, feed({ H1: '1.5', H2: '3' })).rows;
    expect(price(rows, 'M', 'regional', 'input')).toBe(1.5);
    expect(price(rows, 'M', 'regional', 'output')).toBe(3);
  });

  test('missing hashes, negative or non-numeric feed prices, and untrusted services drop the row', () => {
    const html = markup(tbl(['A', ph('H1'), ph('NOPE')], ['B', ph('H3'), ph('H3')], ['C', ph('H4', 'bedrock'), ph('H4', 'bedrock')], ['D', ph('H5'), ph('H5')]));
    const r = parsePricingPage(html, feed({ H1: '1', H3: '-1', H5: 'abc' }));
    expect(r.rows).toEqual([]);
    expect(r.skipped['unresolved price']).toBe(4);
  });

  test('no feed supplied: placeholder rows are skipped but literal rows still parse', () => {
    const html = markup(tbl(['A', ph('H1'), ph('H2')], ['B', '$ 1', '$ 2']));
    const rows = parsePricingPage(html, {}).rows;
    expect(rows.map((r) => r.model)).toEqual(['B', 'B']);
  });

  test('pageServices lists only trusted services referenced by the page', () => {
    expect(pageServices(markup(tbl(['A', ph('H1'), ph('H2')], ['B', ph('H3', 'bedrock'), ph('H3', 'bedrock')])))).toEqual(['bedrockfoundationmodels']);
    expect(pageServices('<p>no placeholders</p>')).toEqual([]);
    expect(TRUSTED_FEED_SERVICES).toContain('bedrockfoundationmodels');
    expect(feedUrl('bedrockfoundationmodels')).toBe('https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/bedrockfoundationmodels.json');
  });
});

describe('parsePricingPage: hostile or changed markup never throws', () => {
  test.each([
    ['empty', ''],
    ['plain text', 'no markup at all'],
    ['unclosed tags', '<div><table><tr><td>x<td>y<table><tr>'],
    ['stray closers', '</div></table></tr></td></li></p>'],
    ['comment only', '<!-- <table><tr><td>x</td></tr></table> -->'],
    ['attribute soup', '<div data-pricing-markup=\'&lt;table&gt;&lt;tr&gt;\' class=a=b id=\'x"y\'>text</div>'],
    ['nested tables', '<table><tr><td><table><tr><td>inner</td></tr></table></td></tr></table>'],
    ['empty table', '<table></table><table><tr></tr></table>'],
  ])('%s', (_name, html) => {
    expect(() => parsePricingPage(html, feeds)).not.toThrow();
    expect(parsePricingPage(html, feeds).rows).toEqual([]);
  });

  test('a changed layout (no recognisable price tables) produces no rows', () => {
    const html = pageFixture.replaceAll('Inference option', 'Option').replaceAll('models</b>', 'things</b>').replaceAll('{priceOf!', '{cost!');
    expect(parsePricingPage(html, feeds).rows).toEqual([]);
  });
});
