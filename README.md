# AI Agent Usage

Local dashboard + CLI for token usage and estimated cost across your coding agents
(opencode, Claude Code, Pi / Pi-Bolt, Claude desktop/Cowork, Cursor, Antigravity, Antigravity CLI,
Antigravity IDE, Codex, Gemini CLI, ...). Everything is read-only against the
agents' own files, stored as metadata only (no prompts, no responses, no tool output).

```bash
bun run ingest                                      # read installed agents into the local DB
bun run serve                                       # dashboard on http://127.0.0.1:4317
bun run src/cli/index.ts report --since 7d --by model
bun run src/cli/index.ts insights --since 7d
bun run src/cli/index.ts status
bun run src/cli/index.ts prices                     # refresh price lists (--force to refetch today)
bun test
```

`serve` ingests on start and every 2 seconds. `--no-ingest` and `--no-watch` turn those off. `--port` changes the port (default 4317).

`report` and `insights` take `--since 7d|36h|2w|YYYY-MM-DD`, `--until now|YYYY-MM-DD`, `--agent a,b`, `--model m1,m2`, `--no-subagents`, `--tz Europe/Berlin`, and `--json`. `report --by` is `day` (default), `week`, `model`, `agent`, or `session`.

DB: `~/.local/share/agent-usage/usage.db` (override with `AGENT_USAGE_DB`).

Pi and Pi-Bolt sessions in `~/.pi/agent/sessions` share the `pi` agent filter and the
same pricing pipeline. They are not counted twice or attributed separately: their shared
session format does not reliably identify which executable created a session. The adapter
reads the default session directory; custom session directories, ephemeral sessions, and
nested tool or summary usage are not included. Newly supported standalone usage entries
and token breakdowns are ingested as files are read; previously consumed lines are not
backfilled automatically.

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
| Prices change / new models | Checked once a day, no credentials. AWS Bedrock snapshots are kept, and each Bedrock call keeps the snapshot in effect when it happened. Google, Anthropic, OpenAI, and xAI pages are fetched on the same cadence and win over models.dev. A later rate prices new and still-unpriced calls only. |
| New model id appears | Matched to the price list by normalised name; Bedrock ARNs are resolved with a read-only `aws bedrock get-inference-profile`. Anything unmatched is listed under Status as *unmapped*, never guessed. |
| Agent installed / uninstalled | Adapters are auto-discovered and `detect()` runs each time. Not installed = skipped silently, history kept. |
| New tools / MCP servers | Tool names come from the events; MCP tools group by server automatically. |
| Insight thresholds | Calibrated from your own history (percentiles); nothing to configure. |

Costs are **estimates** at public list price, not an invoice. Bedrock ids use the regional rate, except `global.*`, which uses the global rate. Other providers use the official page when it lists the model, then models.dev. Long-context surcharges are not modelled. An unmatched model stays unpriced and is never shown as $0.

The first matching source wins:

1. AWS Bedrock price list, then the AWS pricing page for models the list does not have yet.
2. The provider's own page: Google, Anthropic, OpenAI, xAI. Standard, short-context rates. A dated "through / starting" price uses the rate in effect that day.
3. models.dev, for models those pages do not list.
4. Free and local models, at $0.
5. The agent's own reported cost, marked approximate, until a list matches the model.

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
agensi/         SKILL.md package listed on Agensi
src/dev/seed.ts demo data generator (never touches the real DB)
```
