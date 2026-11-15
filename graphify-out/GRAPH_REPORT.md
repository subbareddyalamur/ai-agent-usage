# Graph Report - ai-agent-usage  (2026-11-15)

## Corpus Check
- 147 files · ~109,832 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 4 file(s) not represented in the graph (top: (none) 1, .zip 1, .lock 1)

## Summary
- 1114 nodes · 3449 edges · 33 communities
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 58 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1086a007`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- useApi
- types.ts
- insights/kit.ts
- ref_bun_test
- commands.ts
- pricing-page.ts
- dev/seed.ts
- ingest.ts
- server/api.ts
- Poller
- pricing-helpers.ts
- query-cache.ts
- useRoute
- arn.ts
- Commands
- package.json
- pricing-modelsdev.ts
- pricing.ts
- openDb
- query-cache.test.ts
- pricing-official.ts
- FilterBar.tsx
- Models.tsx
- compilerOptions
- AI Agent Usage
- Overview.tsx
- costly-sessions.ts
- cache.ts
- insights/index.ts
- model-mix.ts
- tool-output-bloat.ts
- SessionDetail.tsx
- .run

## God Nodes (most connected - your core abstractions)
1. `formatUsd()` - 30 edges
2. `createPricingService()` - 30 edges
3. `isObject()` - 29 edges
4. `formatTokens()` - 28 edges
5. `asString()` - 27 edges
6. `openDb()` - 27 edges
7. `useRoute()` - 26 edges
8. `all()` - 26 edges
9. `Filters` - 24 edges
10. `formatPct()` - 22 edges

## Surprising Connections (you probably didn't know these)
- `Add a new coding agent (one file)` --references--> `Adapter`  [INFERRED]
  README.md → src/core/types.ts
- `Add a new coding agent (one file)` --references--> `adapterContract()`  [INFERRED]
  README.md → test/adapters/contract.ts
- `AI Agent Usage` --references--> `session()`  [INFERRED]
  README.md → src/dev/seed.ts
- `Harness` --calls--> `createPricingService()`  [EXTRACTED]
  test/core/pricing-helpers.ts → src/core/pricing.ts
- `Harness` --references--> `PricingService`  [EXTRACTED]
  test/core/pricing-helpers.ts → src/core/types.ts

## Import Cycles
- None detected.

## Communities (33 total, 0 thin omitted)

### Community 0 - "useApi"
Cohesion: 0.23
Nodes (11): ApiError, Fetched, getJson(), postRefresh(), useApi(), formatRate(), CacheMissSection(), Live() (+3 more)

### Community 1 - "types.ts"
Cohesion: 0.06
Nodes (79): awsProfile(), Carry, carryFrom(), parseRecords(), PendingTool, sessionIdFromFile(), awsProfile(), baseDir() (+71 more)

### Community 2 - "insights/kit.ts"
Cohesion: 0.22
Nodes (21): Finding, FindingEvidence, Expiry, ChainResult, relativeChanges(), evaluate(), Hit, cacheWriteOf() (+13 more)

### Community 3 - "ref_bun_test"
Cohesion: 0.08
Nodes (40): adapter, adapter, adapter, adapter, adapter, adapter, discoverAdapters(), isAdapter() (+32 more)

### Community 4 - "commands.ts"
Cohesion: 0.08
Nodes (48): App, CliArgs, CliError, Command, COMMANDS, fail(), filtersFromArgs(), parseCli() (+40 more)

### Community 5 - "pricing-page.ts"
Cohesion: 0.06
Nodes (51): collapse(), collectRows(), Column, columnOf(), decodeEntities(), FeedRegions, Feeds, Frame (+43 more)

### Community 6 - "dev/seed.ts"
Cohesion: 0.07
Nodes (39): Add a new coding agent (one file), Agensi skill, AI Agent Usage, Automatic by design, Layout, Live view and cache misses, CostSourceShare, SourceRow (+31 more)

### Community 7 - "ingest.ts"
Cohesion: 0.10
Nodes (19): AppOptions, createApp(), IngestAllResult, PriceRefreshResult, defaultDbPath(), AdapterReport, BufferedState, dropSupersededSessionTotals() (+11 more)

### Community 8 - "server/api.ts"
Cohesion: 0.07
Nodes (36): Filters, runInsights(), ApiDeps, ApiOptions, createApiHandler(), route(), decodeSegment(), error() (+28 more)

### Community 9 - "Poller"
Cohesion: 0.09
Nodes (17): Deferred, deferred(), setup(), clock(), LABEL, LiveIndicator(), LiveState, liveState() (+9 more)

### Community 10 - "pricing-helpers.ts"
Cohesion: 0.07
Nodes (33): OFFICIAL_FEEDS, feedUrl(), PRICE_LIST_URL, PriceInput, ResolvedModel, ready(), SONNET, zero (+25 more)

### Community 11 - "query-cache.ts"
Cohesion: 0.05
Nodes (92): StatusInfo, StepCacheMiss, CacheStep, ClassifiedStep, classifyConversations(), ClassifyOpts, classifySteps(), deriveTtl() (+84 more)

### Community 12 - "useRoute"
Cohesion: 0.43
Nodes (7): buildHash(), parseHash(), Route, safeDecode(), snapshot(), subscribe(), useRoute()

### Community 13 - "arn.ts"
Cohesion: 0.12
Nodes (26): AccountEntry, accountMemo, accountOf(), arnResolutionFailures(), ArnResolveOptions, cacheResult(), candidateProfiles(), defaultExec() (+18 more)

### Community 14 - "Commands"
Cohesion: 0.40
Nodes (4): Agents the tool can read, Commands, Price sources, in order, Rules the tool already enforces

### Community 15 - "package.json"
Cohesion: 0.09
Nodes (24): dependencies, react@^19.0.0, react-dom@^19.0.0, recharts@^3.0.0, devDependencies, @types/bun@latest, @types/react@^19.0.0, @types/react-dom@^19.0.0 (+16 more)

### Community 16 - "pricing-modelsdev.ts"
Cohesion: 0.14
Nodes (18): agreed(), asPrice(), buildExternalIndex(), ExternalIndex, externalNameKey(), ExternalPrice, loadExternalPrices(), MAKER_PROVIDERS (+10 more)

### Community 17 - "pricing.ts"
Cohesion: 0.10
Nodes (33): buildModelIndex(), fallbackCanonical(), isFreeModel(), LOCAL_RUNTIME_PROVIDERS, modelCandidates(), ModelIndex, slugify(), tierOf() (+25 more)

### Community 18 - "openDb"
Cohesion: 0.15
Nodes (11): migrate(), MIGRATIONS, openDb(), db, dbPath, port, seeded, server (+3 more)

### Community 19 - "query-cache.test.ts"
Cohesion: 0.11
Nodes (30): UsageEvent, rule, rule, rule, rule, rule, makeApp(), ev() (+22 more)

### Community 20 - "pricing-official.ts"
Cohesion: 0.29
Nodes (16): clean(), col(), decode(), entry(), MONTHS, OfficialFeed, parseAnthropic(), parseGoogle() (+8 more)

### Community 21 - "FilterBar.tsx"
Cohesion: 0.17
Nodes (18): react, FilterOptions, App(), NAV, PageProps, FilterBar(), FilterBarProps, MultiSelect() (+10 more)

### Community 22 - "Models.tsx"
Cohesion: 0.17
Nodes (20): Severity, ToolRow, CacheSessionsTable(), Column, DataTable(), Sort, Async(), Empty() (+12 more)

### Community 23 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, jsx, lib, module, moduleResolution, noEmit, noUncheckedIndexedAccess, skipLibCheck (+4 more)

### Community 24 - "AI Agent Usage"
Cohesion: 0.40
Nodes (4): AI Agent Usage, Answer a question, How to report the result, Setup

### Community 25 - "Overview.tsx"
Cohesion: 0.13
Nodes (23): SeriesPoint, SummaryResult, Seg(), MONTHS, StackedBars(), colorFor(), OTHER_COLOR, PALETTE (+15 more)

### Community 26 - "costly-sessions.ts"
Cohesion: 0.23
Nodes (10): minCacheable(), costlySessions(), SessionCost, spikeDays(), dailyCosts(), fmtUsd(), InsightContext, median() (+2 more)

### Community 28 - "cache.ts"
Cohesion: 0.14
Nodes (27): AdapterStatus, CacheMissStep, CacheModelRow, CacheReasonRow, CacheReport, CacheSessionRow, MissReason, ModelRow (+19 more)

### Community 29 - "insights/index.ts"
Cohesion: 0.26
Nodes (9): discover(), InsightRun, isRule(), load, loadRules(), RANK, runInsightsDetailed(), SKIP (+1 more)

### Community 31 - "model-mix.ts"
Cohesion: 0.24
Nodes (10): Rates, evaluate(), Step, stepCostWith(), Candidate, cheaperAlternative(), lineOf(), repriced() (+2 more)

### Community 32 - "tool-output-bloat.ts"
Cohesion: 0.25
Nodes (6): fmtBytes(), MIN_SHARE, sum(), CallRow, rule, ToolAgg

### Community 33 - "SessionDetail.tsx"
Cohesion: 0.21
Nodes (23): recharts, CacheDayPoint, StepRow, HitTrend(), MONTHS, Point, StepTimeline(), StepTip() (+15 more)

### Community 35 - ".run"
Cohesion: 0.50
Nodes (3): run(), run(), run()

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Harness` connect `pricing-helpers.ts` to `pricing.ts`, `ingest.ts`?**
  _High betweenness centrality (0.027) - this node is a cross-community bridge._
- **Should `types.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05678893178893179 - nodes in this community are weakly interconnected._
- **Why does `PriceTier` connect `query-cache.ts` to `types.ts`, `insights/kit.ts`, `pricing-page.ts`, `pricing.ts`, `model-mix.ts`?**
  _High betweenness centrality (0.024) - this node is a cross-community bridge._
- **Should `ref_bun_test` be split into smaller, more focused modules?**
  _Cohesion score 0.08013640238704177 - nodes in this community are weakly interconnected._
- **Why does `InsightContext` connect `costly-sessions.ts` to `server/api.ts`, `insights/kit.ts`, `insights/index.ts`, `model-mix.ts`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Should `commands.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.08346134152585766 - nodes in this community are weakly interconnected._
- **Should `pricing-page.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.058469945355191254 - nodes in this community are weakly interconnected._