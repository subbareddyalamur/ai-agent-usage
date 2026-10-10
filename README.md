# AI Agent Usage

Local dashboard + CLI for token usage and estimated cost across your coding agents
(opencode, Claude Code, Pi, Claude desktop/Cowork, ...). Everything is read-only against the
agents' own files, stored as metadata only (no prompts, no responses, no tool output).

```bash
bun run ingest          # read all installed agents into the local DB (idempotent)
bun run serve           # dashboard on http://127.0.0.1:4317; ingests on start and every 2s (--no-ingest / --no-watch to skip)
bun run src/cli/index.ts report --since 7d --by model
bun run src/cli/index.ts insights
bun run src/cli/index.ts status
bun test                # unit + integration tests
```

DB: `~/.local/share/agent-usage/usage.db` (override with `AGENT_USAGE_DB`).

## Live view and cache misses

- The **Overview** page refetches every 2 seconds (paused while the tab is hidden, backs off to 10 s if the server stops
  answering, pause/resume button in the page header). `serve` re-ingests every 2 s, which is cheap because ingest is incremental.
  Relative ranges (Today, 7 days...) slide forward with the clock.
- The **Cache** page classifies every step that re-sent prompt tokens a cache hit could have served into one of six reasons
  (cold start, context reset, caching off, cache expired, model switch, prompt changed) and prices the avoidable ones.
  Session pages mark those steps on the timeline. `GET /api/cache` returns the same report.

## Automatic by design

| Thing that changes | What happens |
|---|---|
| Prices change / new models | Public AWS Price List is fetched (no credentials) when the newest snapshot is >24h old. Every distinct price list is kept as a dated snapshot; each call is costed with the snapshot in effect when it happened. Deprecated models stay priceable. |
| New model id appears | Matched to the price list by normalised name; Bedrock ARNs are resolved with a read-only `aws bedrock get-inference-profile`. Anything unmatched is listed under Status as *unmapped*, never guessed. |
| Agent installed / uninstalled | Adapters are auto-discovered and `detect()` runs each time. Not installed = skipped silently, history kept. |
| New tools / MCP servers | Tool names come from the events; MCP tools group by server automatically. |
| Insight thresholds | Calibrated from your own history (percentiles); nothing to configure. |

Costs are **estimates** at AWS list price for the region (regional rate for `us.*`/ARNs, global rate for
`global.*`). Long-context surcharges are not modelled yet.

## Add a new coding agent (one file)

1. Create `src/adapters/<agent>.ts` with a default export implementing `Adapter` from `src/core/types.ts`:
   - `detect({home})` -> `{installed, detail}` (never throw; resolve every path from `home`).
   - `ingest(ctx)` -> async iterable of `{type:'event'|'toolResult'|'session'}` items. Use
     `ctx.state` for incremental progress (byte offsets / watermarks) and make event ids deterministic.
   - Helpers for JSONL tailing, sizes and safe JSON live in `src/adapters/kit.ts`.
2. Create `test/adapters/<agent>.test.ts` calling the shared `adapterContract` suite
   (`test/adapters/contract.ts`) with a synthetic fixture home.
3. Run `bun run ingest`. No registration step: the adapter is picked up automatically.

Rules: store counts, ids, names and byte sizes only; report reasoning tokens separately only if the source
does; put cache writes in the 5m bucket when the source has no TTL split.

## Layout

```
src/core/       types, db schema, ingest runner, pricing, model resolver, queries
src/adapters/   one file per agent (+ kit.ts helpers)
src/insights/   one file per insight rule (auto-discovered)
src/server/     127.0.0.1-only HTTP API + static UI
ui/             React dashboard (Overview, Sessions, Models, Tools, Insights, Concepts, Status)
src/cli/        serve | ingest | prices | status | report | insights
src/dev/seed.ts demo data generator (never touches the real DB)
```
