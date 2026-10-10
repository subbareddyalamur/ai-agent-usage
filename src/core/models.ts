import type { PriceTier } from './types';

/** Geo routing prefixes of Bedrock cross-region inference profile ids (us.anthropic.claude-...). */
const GEO_PREFIX = /^(?:us-gov|us|eu|apac|global|jp|au|ca|sa|me|af|in)\.(?=[a-z][a-z0-9-]*\.)/;

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function tierOf(raw: string): PriceTier {
  return raw.trim().toLowerCase().startsWith('global.') ? 'global' : 'regional';
}

/**
 * Normalised match candidates for a raw model id, most specific first.
 * Handles bracket suffixes ([1m]), geo prefixes, vendor prefixes, version suffixes (-v1:0)
 * and date stamps. A -v2 (or higher) revision is kept because it is a different price-list
 * model ("Claude 3.5 Sonnet v2"); -v1 is the implicit first revision and dropped.
 * A vendor prefix yields a second candidate with the vendor re-attached, because some
 * price-list names include it ("DeepSeek v3.2") and some ids carry it ("deepseek.v3.2").
 */
export function modelCandidates(raw: string): string[] {
  let s = raw.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  s = s.replace(GEO_PREFIX, '');

  let vendor: string | undefined;
  const dotted = /^([a-z][a-z-]*)\.(.+)$/.exec(s);
  if (dotted && dotted[1] && dotted[2] && !/\d/.test(dotted[1])) {
    vendor = dotted[1];
    s = dotted[2];
  }

  let revision: number | undefined;
  s = s.replace(/-v(\d+)(?::\d+)?$/, (_m, n: string) => {
    revision = Number(n);
    return '';
  });
  s = s.replace(/:\d+$/, '').replace(/-\d{8}$/, '');

  let base = slugify(s);
  if (revision !== undefined && revision >= 2) base = `${base}-v${revision}`;
  if (base === '') return [];
  return vendor ? [base, `${slugify(vendor)}-${base}`] : [base];
}

/** Fallback display name for ids that match nothing in the price list. */
export function fallbackCanonical(raw: string): string {
  return modelCandidates(raw)[0] ?? raw;
}

const tokenKey = (slug: string): string => slug.split('-').filter(Boolean).sort().join('-');

export interface ModelIndex {
  /** Canonical price-list model names this index knows. */
  readonly size: number;
  match(raw: string): string | null;
}

/**
 * Index over price-list model names (every snapshot, so deprecated models stay matchable).
 * Matching is exact on the normalised slug first, then on equal token sets
 * ("claude-sonnet-3-5" == "Claude 3.5 Sonnet"). Version numbers are tokens, so a different
 * version can never match.
 */
export function buildModelIndex(names: readonly string[]): ModelIndex {
  const bySlug = new Map<string, string>();
  const byTokens = new Map<string, string | null>();
  for (const name of names) {
    const slug = slugify(name);
    if (!bySlug.has(slug)) bySlug.set(slug, name);
    const tk = tokenKey(slug);
    byTokens.set(tk, byTokens.has(tk) && byTokens.get(tk) !== name ? null : name);
  }
  return {
    size: bySlug.size,
    match(raw: string): string | null {
      const candidates = modelCandidates(raw);
      for (const c of candidates) {
        const hit = bySlug.get(c);
        if (hit) return hit;
      }
      for (const c of candidates) {
        const hit = byTokens.get(tokenKey(c));
        if (hit) return hit;
      }
      return null;
    },
  };
}

// ---- zero-cost models -------------------------------------------------------------------------
// Everything that decides "this model costs nothing" lives here. Unknown models stay unpriced.

/** Ids marked free by the provider: "...-free", "...:free", ".../free". "freedom-7b" is not free. */
const FREE_ID_PATTERN = /[-:/]free$/;
/** Providers that run on the user's own machine (slugified provider names). */
const LOCAL_RUNTIME_PROVIDERS: ReadonlySet<string> = new Set([
  'ollama',
  'lmstudio',
  'lm-studio',
  'llamacpp',
  'llama-cpp',
  'llamafile',
]);

export function isFreeModel(raw: string, provider?: string): boolean {
  const id = raw.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  if (FREE_ID_PATTERN.test(id)) return true;
  return provider !== undefined && LOCAL_RUNTIME_PROVIDERS.has(slugify(provider));
}
