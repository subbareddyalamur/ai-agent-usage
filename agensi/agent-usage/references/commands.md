# Commands

Run from the `ai-agent-usage` checkout. The binary form is `bun run src/cli/index.ts <command>`.

```text
serve      dashboard on 127.0.0.1, ingest first, then every 2s
           --port 4317  --no-ingest  --no-watch
ingest     read installed agents into the local database
prices     refresh public price lists          --force
status     adapters, price snapshot, unpriced models
report     usage table                          --by day|week|model|agent|session
insights   patterns worth knowing about
```

Filters for `report` and `insights`:

```text
--since 7d|36h|2w|YYYY-MM-DD
--until now|7d|36h|2w|YYYY-MM-DD
--agent a,b
--model m1,m2
--no-subagents
--tz Europe/Berlin
--limit N          sessions only, default 20
--json
```

`report --by` defaults to `day`.

## Agents the tool can read

`claude-code`, `cowork`, `opencode`, `pi`, `cursor`, `codex`, `gemini-cli`, `antigravity`, `antigravity-cli`, `antigravity-ide`.

An agent that is not installed is skipped. History already stored for it is kept.

## Price sources, in order

1. AWS Bedrock price list.
2. AWS Bedrock pricing page, for models the bulk list does not have yet.
3. The provider's own page, fetched daily: Google, Anthropic, OpenAI, xAI.
4. models.dev, for models those pages do not list.
5. Free and local models, at $0.
6. The agent's own reported cost, marked approximate, until a price list matches the model.
7. Unknown. Tokens are counted. Cost is left blank.

## Rules the tool already enforces

- Read-only against the agents' own files.
- Store counts, ids, names, and byte sizes. Never prompts, responses, thinking text, or tool output.
- Reasoning tokens are counted only when the source reports them.
- Cache writes with no TTL split go in the 5-minute bucket.
- An unmatched model stays unpriced. Do not guess a price.
