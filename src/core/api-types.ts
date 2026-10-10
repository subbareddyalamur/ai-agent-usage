// Shapes shared by the query layer (src/core/query.ts), the HTTP server and the UI.
// All timestamps are epoch milliseconds (UTC); day buckets are YYYY-MM-DD in the viewer's local timezone.

export interface Filters {
  from?: number;
  to?: number;
  agents?: readonly string[];
  /** Canonical model names. */
  models?: readonly string[];
  projects?: readonly string[];
  /** Default true. */
  includeSubagents?: boolean;
  /** IANA tz used for day bucketing; default = server local tz. */
  tz?: string;
}

export interface Totals {
  events: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of priced events only. */
  costUsd: number;
  unpricedEvents: number;
  unpricedTokens: number;
  /** cacheRead / (input + cacheRead + cacheWrite); null when there is no prompt traffic. */
  cacheHitRatio: number | null;
}

export interface SeriesPoint {
  bucket: string;
  /** Model or agent name depending on `split`. */
  key: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface SummaryResult {
  totals: Totals;
  byAgent: Array<{ agent: string } & Totals>;
  byModel: Array<{ model: string; priced: boolean } & Totals>;
}

export interface SessionRow {
  agent: string;
  sessionId: string;
  title: string | null;
  project: string | null;
  firstTs: number;
  lastTs: number;
  steps: number;
  models: string[];
  /** True if only session level totals exist (no per-step data). */
  totalOnly: boolean;
  totals: Totals;
  /** Largest prompt (input + cacheRead + cacheWrite) seen in any single step. */
  peakContext: number;
  hasSubagents: boolean;
}

export interface StepRow {
  ts: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + cacheRead + cacheWrite for this step. */
  context: number;
  costUsd: number | null;
  isSubagent: boolean;
  tools: Array<{ name: string; resultBytes: number | null }>;
  cacheMiss?: StepCacheMiss;
}

export interface SessionDetail {
  row: SessionRow;
  steps: StepRow[];
}

export interface ModelRow extends Totals {
  model: string;
  priced: boolean;
  tier: 'regional' | 'global';
  agents: string[];
  avgContext: number;
  /** Live price per 1M tokens from the newest snapshot (null if unpriced). */
  rates: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number } | null;
}

export interface ToolRow {
  name: string;
  /** "builtin" or the MCP server name parsed from mcp__<server>__<tool>. */
  group: string;
  calls: number;
  totalResultBytes: number;
  avgResultBytes: number;
  maxResultBytes: number;
  agents: string[];
}

export type Severity = 'info' | 'warn' | 'high';

export interface FindingEvidence {
  label: string;
  agent?: string;
  sessionId?: string;
  model?: string;
  value?: string;
}

export interface Finding {
  /** Rule id, e.g. "cache-off". */
  id: string;
  severity: Severity;
  title: string;
  /** Plain-language "why this matters / what to do", with live numbers filled in. */
  detail: string;
  evidence: FindingEvidence[];
  /** Estimated avoidable spend over the filtered range, when computable. */
  estSavingsUsd?: number;
  /** Anchor on the Concepts page. */
  concept?: string;
}

export interface AdapterStatus {
  id: string;
  label: string;
  installed: boolean;
  detail?: string;
  events: number;
  firstTs: number | null;
  lastTs: number | null;
  lastIngestAt: number | null;
  error?: string;
}

export interface StatusInfo {
  adapters: AdapterStatus[];
  pricing: {
    latestSnapshotAt: number | null;
    snapshots: number;
    modelsPriced: number;
    stale: boolean;
    lastError?: string;
  };
  unmappedModels: Array<{ raw: string; events: number; tokens: number }>;
  db: { path: string; sizeBytes: number };
}

export interface FilterOptions {
  agents: string[];
  models: string[];
  projects: string[];
  minTs: number | null;
  maxTs: number | null;
}

// ---- Cache miss analysis -------------------------------------------------

/**
 * Why a step re-sent prompt tokens that a cache hit would have served.
 * cold-start / context-reset are normally unavoidable; the others are avoidable.
 */
export type MissReason =
  | 'cold-start' // first call of a conversation: nothing to read yet
  | 'context-reset' // prompt shrank sharply: compaction or a new conversation
  | 'caching-off' // the session shows no cache reads/writes at all for this model
  | 'expired' // the pause since the previous step outlived the cache TTL
  | 'model-switch' // model changed from the previous step (caches are per model)
  | 'prefix-change'; // no pause, same model, still missed: something early in the prompt changed

export interface CacheMissStep {
  ts: number;
  agent: string;
  sessionId: string;
  title: string | null;
  model: string;
  reason: MissReason;
  /** False for cold-start and context-reset. */
  avoidable: boolean;
  /** input + cacheRead + cacheWrite for the step. */
  promptTokens: number;
  cacheReadTokens: number;
  /** input + cache writes: prompt tokens not served from cache. */
  freshTokens: number;
  /** Fresh tokens beyond genuinely new content (growth since the previous step). */
  missTokens: number;
  /** Time since the previous step in the same conversation; null for the first. */
  gapMs: number | null;
  /** Extra spend vs serving missTokens as cache reads; null when the model is unpriced. */
  extraCostUsd: number | null;
}

export interface CacheReasonRow {
  reason: MissReason;
  avoidable: boolean;
  steps: number;
  missTokens: number;
  extraCostUsd: number;
  /** Plain-language explanation with live numbers (TTL, rates) filled in. */
  explanation: string;
}

export interface CacheModelRow {
  model: string;
  steps: number;
  promptTokens: number;
  cacheReadTokens: number;
  hitRatio: number | null;
  missTokens: number;
  extraCostUsd: number;
  /** True if any cache read/write was ever seen for this model in the filtered range. */
  cacheSeen: boolean;
}

export interface CacheSessionRow {
  agent: string;
  sessionId: string;
  title: string | null;
  steps: number;
  missSteps: number;
  hitRatio: number | null;
  extraCostUsd: number;
  dominantReason: MissReason | null;
}

export interface CacheDayPoint {
  bucket: string;
  hitRatio: number | null;
  promptTokens: number;
  cacheReadTokens: number;
  extraCostUsd: number;
}

export interface CacheReport {
  totals: {
    steps: number;
    promptTokens: number;
    cacheReadTokens: number;
    hitRatio: number | null;
    /** Tokens that no cache could have served (cold starts, resets). */
    unavoidableTokens: number;
    avoidableMissTokens: number;
    extraCostUsd: number;
    /** Cache lifetime used to judge "expired": derived from observed 5m vs 1h cache writes. */
    ttlMs: number;
    ttlSource: '5m' | '1h' | 'mixed';
  };
  reasons: CacheReasonRow[];
  models: CacheModelRow[];
  /** Top sessions by extra cost (max 25). */
  sessions: CacheSessionRow[];
  days: CacheDayPoint[];
  /** Avoidable misses, newest first (max 100). */
  recent: CacheMissStep[];
}

/** Attached to StepRow when the step re-sent avoidable or unavoidable prompt tokens. */
export interface StepCacheMiss {
  reason: MissReason;
  avoidable: boolean;
  missTokens: number;
  extraCostUsd: number | null;
}
