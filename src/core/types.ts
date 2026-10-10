// Shared contracts. Adapters, pricing, queries and UI all depend on these shapes only.

export interface ToolCall {
  /** Id unique within (agent); used to attach the result size later. */
  callId: string;
  name: string;
  resultBytes?: number;
  isError?: boolean;
}

export interface UsageEvent {
  /** Stable, deterministic id. Re-ingesting the same step must produce the same id (upsert key). */
  id: string;
  agent: string;
  sessionId: string;
  /** Working directory / project the session ran in. */
  project?: string;
  /** Epoch milliseconds, UTC. */
  ts: number;
  /** e.g. "amazon-bedrock", "ollama", "anthropic". */
  provider?: string;
  /** Model id exactly as the agent recorded it (may be an alias, a Bedrock id or an ARN). */
  modelRaw: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  /** Cache writes with the default 5 minute TTL. If the agent does not split TTLs, put the total here. */
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  isSubagent: boolean;
  /** "step" = one model call. "session_total" = only session level totals exist (no per-step data). */
  kind: 'step' | 'session_total';
  /** Cost as reported by the agent itself, if any. Used only as a cross-check, never as the cost shown. */
  reportedCostUsd?: number;
  /** AWS profile the agent used, if known; lets ARN resolution use the right credentials. */
  awsProfileHint?: string;
  tools: ToolCall[];
}

export interface ToolResult {
  callId: string;
  resultBytes: number;
  isError?: boolean;
}

export interface SessionMeta {
  agent: string;
  sessionId: string;
  title?: string;
  project?: string;
}

/** Everything an adapter can yield. Order does not matter; all writes are idempotent upserts. */
export type IngestItem =
  | { type: 'event'; event: UsageEvent }
  | { type: 'toolResult'; agent: string; result: ToolResult }
  | { type: 'session'; meta: SessionMeta };

export interface DetectResult {
  installed: boolean;
  /** Human readable, e.g. the data path found or why it was not found. */
  detail?: string;
}

/** Per-adapter key/value store for incremental ingest state (byte offsets, watermarks...). */
export interface AdapterState {
  get<T = unknown>(key: string): T | undefined;
  /** Buffered: persisted by the runner only after the adapter finished and all items were written. */
  set(key: string, value: unknown): void;
}

export interface IngestContext {
  state: AdapterState;
  /** Home directory; tests point this at a fixture dir. Adapters must resolve all paths from it. */
  home: string;
  log: (msg: string) => void;
}

/**
 * To support a new coding agent: add ONE file in src/adapters/ exporting a default Adapter.
 * It is discovered automatically; if detect() says not installed it is silently skipped
 * (previously ingested history is kept).
 */
export interface Adapter {
  /** Stable id stored on every event, e.g. "claude-code". */
  id: string;
  label: string;
  detect(ctx: { home: string }): Promise<DetectResult>;
  ingest(ctx: IngestContext): AsyncIterable<IngestItem>;
}

export type PriceTier = 'regional' | 'global';

export interface ResolvedModel {
  /** Canonical display name, e.g. "Claude Sonnet 5.5". Falls back to a normalised raw id when unknown. */
  canonical: string;
  /** True when a price exists for it in the current or any past price snapshot. */
  priced: boolean;
  tier: PriceTier;
}

/** The part of an event the pricer needs. */
export interface PriceInput {
  ts: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

export interface PricingService {
  /** Fetches the public AWS Price List when the newest snapshot is older than maxAgeMs (default 24h). Never throws; offline keeps the last snapshot. */
  refreshIfStale(opts?: { maxAgeMs?: number; force?: boolean }): Promise<{ refreshed: boolean; snapshotId?: number; error?: string }>;
  /** Maps a raw model id (alias, Bedrock id, ARN...) to a canonical priced model. Results are cached. */
  resolveModel(raw: string, hint?: { awsProfile?: string; provider?: string }): Promise<ResolvedModel>;
  /** Cost in USD using the snapshot in effect at input.ts. null = unpriced. approx=true when ts predates the first snapshot. */
  priceEvent(model: ResolvedModel, input: PriceInput): { costUsd: number | null; approx: boolean };
}
