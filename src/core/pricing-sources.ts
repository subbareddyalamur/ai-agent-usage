import { feedUrl, PAGE_URL, pageServices, parsePricingPage, type FeedRegions } from './pricing-page';
import { parseBedrockOffer, parsePriceList, type ParsedPriceList } from './pricing-parse';

const OFFERS = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/';
const FETCH_TIMEOUT_MS = 120_000;
/** The pricing page and its data feed are served to browsers; a bare fetch user agent is refused. */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
};

export interface PriceFeed {
  id: string;
  url: string;
  /** When true the source only fills models that no higher-priority source prices at all. */
  fillOnly?: boolean;
  /** Fetches and parses once; throws on any failure (the caller turns that into an error string). */
  load(doFetch: typeof fetch): Promise<ParsedPriceList>;
}

async function getText(doFetch: typeof fetch, url: string, headers?: Record<string, string>): Promise<string> {
  const res = await doFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(headers ? { headers } : {}) });
  if (!res.ok) throw new Error(`price list fetch failed: HTTP ${res.status}`);
  return res.text();
}

function offerSource(id: string, offer: string, parse: (json: unknown) => ParsedPriceList): PriceFeed {
  const url = `${OFFERS}${offer}/current/index.json`;
  return { id, url, load: async (f) => parse(JSON.parse(await getText(f, url))) };
}

const pricingPage: PriceFeed = {
  id: 'pricing-page',
  url: PAGE_URL,
  fillOnly: true,
  async load(f) {
    const html = await getText(f, PAGE_URL, BROWSER_HEADERS);
    const entries = await Promise.all(
      pageServices(html).map(async (service): Promise<[string, FeedRegions]> => {
        const feed = JSON.parse(await getText(f, feedUrl(service), BROWSER_HEADERS)) as { regions?: unknown };
        if (typeof feed.regions !== 'object' || feed.regions === null) throw new Error(`price feed ${service} has no regions`);
        return [service, feed.regions as FeedRegions];
      }),
    );
    const { rows } = parsePricingPage(html, Object.fromEntries(entries));
    return { rows };
  },
};

/** Highest priority first: when two sources price the same key, the earlier one wins. */
export const PRICE_SOURCES: readonly PriceFeed[] = [
  offerSource('foundation-models', 'AmazonBedrockFoundationModels', parsePriceList),
  offerSource('bedrock', 'AmazonBedrock', parseBedrockOffer),
  pricingPage,
];
