---
name: AI Agent Usage
description: Reports token use and estimated cost from local coding-agent logs. Use when the user asks what Claude Code, Cursor, Codex, Gemini CLI, OpenCode, Pi, Cowork, or Antigravity spent, which model cost the most, or why cache misses were expensive.
summary: Local token and cost report across the coding agents already on this machine. Costs are list-price estimates. Prompts and responses are never read.
version: 0.1.0
tags: [usage, cost, tokens, coding-agents]
keywords: [claude code, cursor, codex, gemini cli, token cost, cache]
use_cases: [today's spend, cost by model, cache misses, unpriced models]
docs_url: https://github.com/subbareddyalamur/ai-agent-usage
---

# AI Agent Usage

Answer cost and token questions by running this tool. Do not open agent transcripts, session logs, or editor databases yourself. The tool stores counts, ids, names, and byte sizes only.

## Setup

Requires [Bun](https://bun.sh). The database is `~/.local/share/agent-usage/usage.db`. Override it with `AGENT_USAGE_DB` only when the user asks for a different file.

If `ai-agent-usage` is not already checked out:

```bash
git clone https://github.com/subbareddyalamur/ai-agent-usage.git
cd ai-agent-usage
bun install
```

Run later commands from that directory.

## Answer a question

1. Refresh the local database:

```bash
bun run ingest
```

A missing agent is skipped. Its old rows stay. An adapter error is reported on that line; continue with the agents that succeeded.

2. Read the answer from the CLI. Prefer `--json`.

| Question | Command |
|---|---|
| Spend over a period | `bun run src/cli/index.ts report --since 7d --json` |
| Which model cost the most | `bun run src/cli/index.ts report --since 7d --by model --json` |
| Which agent | `bun run src/cli/index.ts report --since 7d --by agent --json` |
| Which session | `bun run src/cli/index.ts report --since 7d --by session --limit 20 --json` |
| One agent or model | add `--agent cursor` or `--model claude-sonnet-5` (comma-separated) |
| Why it cost that much | `bun run src/cli/index.ts insights --since 7d --json` |
| What is installed, what is unpriced | `bun run src/cli/index.ts status --json` |

`--since` and `--until` accept `7d`, `36h`, `2w`, or `YYYY-MM-DD`. `--until now` is allowed. Add `--no-subagents` to exclude sub-agent calls. Add `--tz Europe/Berlin` when the user names a timezone. Default timezone is the machine's.

3. When the price list is stale, or the user asks for current provider rates:

```bash
bun run src/cli/index.ts prices
```

Use `--force` only when the user wants a refetch inside the same day. Official Google, Anthropic, OpenAI, and xAI pages win over models.dev. AWS Bedrock wins over both. A new rate prices new and still-unpriced calls. Calls that already have a cost keep it.

4. Start the dashboard only when the user wants to look at it:

```bash
bun run serve
```

It listens on `http://127.0.0.1:4317` and ingests every 2 seconds. Stop it when the user is done. Do not expose it off the machine.

## How to report the result

- Say the cost is an estimate at public list price, not an invoice. Long-context surcharges are not included.
- An unpriced model has an unknown cost. Leave it out of the total. Never call it $0.
- A model priced as Free costs nothing. A model priced as official, AWS, or models.dev uses that source. Say which source the CLI reports.
- Cache-hit ratio and insight findings are the explanation for avoidable spend. Quote the finding title, severity, and estimated savings. Do not invent a saving the tool did not print.
- If `status` shows an agent as not installed, say so. Do not guess that agent's usage.

Command details live in `references/commands.md`.
