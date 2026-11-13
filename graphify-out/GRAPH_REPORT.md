# Graph Report - ai-agent-usage  (2026-11-13)

## Corpus Check
- 144 files · ~107,669 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 3 file(s) not represented in the graph (top: (none) 1, .lock 1, .css 1)

## Summary
- 1098 nodes · 3405 edges · 36 communities
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 55 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `208e05e9`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- App.tsx
- types.ts
- insights/kit.ts
- ref_bun_test
- commands.ts
- pricing-page.ts
- dev/seed.ts
- api-types.ts
- server/api.ts
- Poller
- pricing-helpers.ts
- query.ts
- query-cache.ts
- arn.ts
- cache-miss.ts
- package.json
- pricing-modelsdev.ts
- pricing.ts
- openDb
- query-cache.test.ts
- pricing-official.ts
- FilterBar.tsx
- formatUsd
- compilerOptions
- query-sessions.ts
- Overview.tsx
- costly-sessions.ts
- useRoute
- cache.ts
- insights/index.ts
- models.ts
- model-mix.ts
- tool-output-bloat.ts
- Status.tsx
- AI Agent Usage
- .run

## God Nodes (most connected - your core abstractions)
1. `createPricingService()` - 30 edges
2. `formatUsd()` - 30 edges
3. `isObject()` - 29 edges
4. `formatTokens()` - 28 edges
5. `asString()` - 27 edges
6. `useRoute()` - 26 edges
7. `all()` - 26 edges
8. `openDb()` - 25 edges
9. `Filters` - 24 edges
10. `PriceTier` - 22 edges

## Surprising Connections (you probably didn't know these)
- `Add a new coding agent (one file)` --references--> `Adapter`  [INFERRED]
  README.md → src/core/types.ts
- `Add a new coding agent (one file)` --references--> `adapterContract()`  [INFERRED]
  README.md → test/adapters/contract.ts
- `ready()` --calls--> `openDb()`  [EXTRACTED]
  test/core/pricing-external.test.ts → src/core/db.ts
- `twoSnapshots()` --calls--> `openDb()`  [EXTRACTED]
  test/core/pricing.test.ts → src/core/db.ts
- `seedDb()` --calls--> `openDb()`  [EXTRACTED]
  test/insights/seed.ts → src/core/db.ts

## Import Cycles
- None detected.

## Communities (36 total, 0 thin omitted)

### Community 0 - "App.tsx"
Cohesion: 0.11
Nodes (35): react, App(), NAV, PageProps, Column, Sort, Async(), Empty() (+27 more)

### Community 1 - "types.ts"
Cohesion: 0.06
Nodes (79): awsProfile(), Carry, carryFrom(), parseRecords(), PendingTool, sessionIdFromFile(), awsProfile(), baseDir() (+71 more)

### Community 2 - "insights/kit.ts"
Cohesion: 0.24
Nodes (20): Finding, Expiry, ChainResult, relativeChanges(), evaluate(), Hit, cacheWriteOf(), Chain (+12 more)

### Community 3 - "ref_bun_test"
Cohesion: 0.06
Nodes (49): adapter, adapter, adapter, adapter, adapter, adapter, MIGRATIONS, discoverAdapters() (+41 more)

### Community 4 - "commands.ts"
Cohesion: 0.05
Nodes (66): App, AppOptions, createApp(), IngestAllResult, PriceRefreshResult, CliArgs, CliError, Command (+58 more)

### Community 5 - "pricing-page.ts"
Cohesion: 0.06
Nodes (52): collapse(), collectRows(), Column, columnOf(), decodeEntities(), FeedRegions, Feeds, Frame (+44 more)

### Community 6 - "dev/seed.ts"
Cohesion: 0.10
Nodes (31): CostSourceShare, SourceRow, PriceSource, costOf(), DemoModel, insertSnapshots(), MODELS, mulberry32() (+23 more)

### Community 7 - "api-types.ts"
Cohesion: 0.14
Nodes (19): AdapterStatus, Filters, FindingEvidence, ModelRow, StatusInfo, SummaryResult, ToolRow, Totals (+11 more)

### Community 8 - "server/api.ts"
Cohesion: 0.06
Nodes (39): SeriesPoint, SessionDetail, SessionRow, runInsights(), ApiDeps, ApiOptions, createApiHandler(), route() (+31 more)

### Community 9 - "Poller"
Cohesion: 0.11
Nodes (12): Deferred, deferred(), setup(), DEFAULT_POLL, pollDelay(), Poller, PollerCallbacks, PollerEnv (+4 more)

### Community 10 - "pricing-helpers.ts"
Cohesion: 0.09
Nodes (23): OFFICIAL_FEEDS, feedUrl(), PRICE_LIST_URL, PriceInput, ready(), SONNET, zero, DAY (+15 more)

### Community 11 - "query.ts"
Cohesion: 0.16
Nodes (31): all(), buildWhere(), one(), models(), toolGroup(), tools(), querySessionRows(), sessionDetail() (+23 more)

### Community 12 - "query-cache.ts"
Cohesion: 0.15
Nodes (21): CacheMissStep, CacheModelRow, CacheReasonRow, CacheSessionRow, deriveTtl(), Acc, ALL_REASONS, cacheReport() (+13 more)

### Community 13 - "arn.ts"
Cohesion: 0.12
Nodes (26): AccountEntry, accountMemo, accountOf(), arnResolutionFailures(), ArnResolveOptions, cacheResult(), candidateProfiles(), defaultExec() (+18 more)

### Community 14 - "cache-miss.ts"
Cohesion: 0.15
Nodes (18): ClassifiedStep, classifyConversations(), ClassifyOpts, classifySteps(), extraCost(), MIN_MISS_SHARE, MIN_MISS_TOKENS, notAMiss() (+10 more)

### Community 15 - "package.json"
Cohesion: 0.10
Nodes (23): dependencies, react@^19.0.0, react-dom@^19.0.0, recharts@^3.0.0, devDependencies, @types/bun@latest, @types/react@^19.0.0, @types/react-dom@^19.0.0 (+15 more)

### Community 16 - "pricing-modelsdev.ts"
Cohesion: 0.14
Nodes (16): agreed(), asPrice(), buildExternalIndex(), ExternalIndex, externalNameKey(), ExternalPrice, MAKER_PROVIDERS, MAKER_RANK (+8 more)

### Community 17 - "pricing.ts"
Cohesion: 0.13
Nodes (23): AwsOutcome, BILLED_MODEL, createPricingService(), errorMessage(), failedSources(), FALLBACK_REGIONS, feedFetchedKey(), FeedRows (+15 more)

### Community 18 - "openDb"
Cohesion: 0.13
Nodes (12): migrate(), openDb(), bedrockDoc(), ready(), DEEPSEEK, GLM, ready(), setup() (+4 more)

### Community 19 - "query-cache.test.ts"
Cohesion: 0.11
Nodes (31): ResolvedModel, UsageEvent, rule, rule, rule, rule, rule, makeApp() (+23 more)

### Community 20 - "pricing-official.ts"
Cohesion: 0.29
Nodes (16): clean(), col(), decode(), entry(), MONTHS, OfficialFeed, parseAnthropic(), parseGoogle() (+8 more)

### Community 21 - "FilterBar.tsx"
Cohesion: 0.24
Nodes (7): FilterOptions, FilterBar(), FilterBarProps, MultiSelect(), PRESETS, RangePreset, relativeTime()

### Community 22 - "formatUsd"
Cohesion: 0.31
Nodes (14): CacheDayPoint, CacheModelsTable(), CacheSessionsTable(), cost(), Href, ReasonsTable(), RecentMissesTable(), DataTable() (+6 more)

### Community 23 - "compilerOptions"
Cohesion: 0.15
Nodes (12): compilerOptions, jsx, lib, module, moduleResolution, noEmit, noUncheckedIndexedAccess, skipLibCheck (+4 more)

### Community 24 - "query-sessions.ts"
Cohesion: 0.16
Nodes (15): StepCacheMiss, StepRow, CacheStep, PriceRow, DbStep, StepDbRow, ModelAggRow, SessionAggRow (+7 more)

### Community 25 - "Overview.tsx"
Cohesion: 0.12
Nodes (24): recharts, EstTag(), Kpi(), Seg(), MONTHS, StackedBars(), colorFor(), OTHER_COLOR (+16 more)

### Community 26 - "costly-sessions.ts"
Cohesion: 0.23
Nodes (10): minCacheable(), costlySessions(), SessionCost, spikeDays(), dailyCosts(), fmtUsd(), InsightContext, median() (+2 more)

### Community 27 - "useRoute"
Cohesion: 0.27
Nodes (11): formatRate(), buildHash(), parseHash(), Route, safeDecode(), snapshot(), subscribe(), useRoute() (+3 more)

### Community 28 - "cache.ts"
Cohesion: 0.19
Nodes (16): CacheReport, MissReason, clock(), LABEL, LiveIndicator(), LiveState, liveState(), formatDuration() (+8 more)

### Community 29 - "insights/index.ts"
Cohesion: 0.23
Nodes (10): Severity, discover(), InsightRun, isRule(), load, loadRules(), RANK, runInsightsDetailed() (+2 more)

### Community 30 - "models.ts"
Cohesion: 0.31
Nodes (10): buildModelIndex(), fallbackCanonical(), isFreeModel(), LOCAL_RUNTIME_PROVIDERS, modelCandidates(), ModelIndex, slugify(), tierOf() (+2 more)

### Community 31 - "model-mix.ts"
Cohesion: 0.27
Nodes (9): Rates, evaluate(), stepCostWith(), Candidate, cheaperAlternative(), lineOf(), repriced(), rule (+1 more)

### Community 32 - "tool-output-bloat.ts"
Cohesion: 0.22
Nodes (7): fmtBytes(), MIN_SHARE, Step, sum(), CallRow, rule, ToolAgg

### Community 33 - "Status.tsx"
Cohesion: 0.38
Nodes (12): StepTimeline(), StepTip(), baseName(), compact(), formatBytes(), formatDate(), formatDateTime(), formatTokens() (+4 more)

### Community 34 - "AI Agent Usage"
Cohesion: 0.33
Nodes (5): Add a new coding agent (one file), AI Agent Usage, Automatic by design, Layout, Live view and cache misses

### Community 35 - ".run"
Cohesion: 0.50
Nodes (3): run(), run(), run()

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `App.tsx` to `Status.tsx`, `Poller`, `package.json`, `FilterBar.tsx`, `Overview.tsx`, `useRoute`, `cache.ts`?**
  _High betweenness centrality (0.026) - this node is a cross-community bridge._
- **Should `App.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.11081560283687943 - nodes in this community are weakly interconnected._
- **Why does `PriceTier` connect `query-sessions.ts` to `tool-output-bloat.ts`, `types.ts`, `insights/kit.ts`, `pricing-page.ts`, `api-types.ts`, `query-cache.ts`, `cache-miss.ts`, `pricing.ts`, `models.ts`, `model-mix.ts`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Should `types.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05678893178893179 - nodes in this community are weakly interconnected._
- **Why does `Filters` connect `api-types.ts` to `insights/kit.ts`, `commands.ts`, `server/api.ts`, `query.ts`, `query-cache.ts`, `query-cache.test.ts`, `query-sessions.ts`, `costly-sessions.ts`, `insights/index.ts`?**
  _High betweenness centrality (0.017) - this node is a cross-community bridge._
- **Should `ref_bun_test` be split into smaller, more focused modules?**
  _Cohesion score 0.057711950970377936 - nodes in this community are weakly interconnected._
- **Should `commands.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05124685426675818 - nodes in this community are weakly interconnected._