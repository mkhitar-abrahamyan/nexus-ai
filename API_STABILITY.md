# API Stability Policy

This policy describes compatibility guarantees for `nexus-ai-pro`. The 2.x guarantees apply beginning
with version 2.0.0, as the 1.x guarantees applied from 1.0.0. The sections for the 1.x stages below
still describe each surface; where they say "the 1.x rules", read the rules of the current major line.

## Release stages

The package follows semantic versioning. Within a major line, incompatible changes to stable public
APIs require the next major release. Minor releases may add backward-compatible features, and patch releases
are intended to remain backward compatible.

The following surfaces are public and covered by this policy:

- exports documented in the root package or an explicit `package.json` subpath;
- exported TypeScript types and runtime symbols;
- documented configuration keys, response shapes, and CLI commands.

Source files, `dist` file paths, examples, test helpers that are not exported, and undocumented implementation details are not public API. Import only from `nexus-ai-pro` or one of its explicit subpaths.

## Compatibility rules

- A public symbol will not be removed or incompatibly changed in a patch release.
- Deprecations will be documented before removal whenever practical.
- New optional fields, providers, exports, error subclasses, and enum-like union members may be added in a minor release.
- TypeScript improvements that expose previously invalid usage may arrive in a patch release.
- Security fixes may tighten validation or blocking behavior in a patch release when preserving the old behavior would leave users exposed.
- Provider behavior can change when an upstream API changes; Nexus will preserve its normalized request and response contracts where possible.

## Module formats

Since 1.2.0 the package ships parallel ESM and CommonJS builds and supports Node.js 22 or newer.
Both are covered by this policy:

- every export subpath carries `import` and `require` conditions, each resolving to its own build and
  its own declarations, so a CommonJS consumer never lands on ESM declarations;
- `typesVersions` maps each subpath to its CommonJS declarations, so subpath types resolve under
  `moduleResolution: "node10"` without a consumer migrating its `tsconfig.json`;
- dropping either build, or removing a subpath from either condition, requires a major release.

Deep imports into `dist`, `dist-cjs`, or `src` are not supported. Import only from `nexus-ai-pro` or
one of its explicit subpaths.

## 2.4 stage (Unreleased)

Everything 2.4 adds is stable from the start and additive. These security fixes tighten behavior,
as the compatibility rules allow:
- the upload scanner checks the larger of the declared and actual sizes;
- an allowlist refuses a file with no MIME type;
- textual bytes are scanned;
- secret findings carry a preview instead of the value;
- card and phone matches must pass their checks.

New and stable:
- `confidence`, `minErrorRateIncrease`, `minFeedbackDrop`, and `resamples` on `watchCanaries()`;
  the same options and `seed` on `compareRuns()`; `Regression.interval`;
- `Deployments.evaluate()` with `RunEvaluationOptions` and `RunEvaluationReport`;
- `RunRecord.feedback`, `RunManager.addFeedback()`, and `POST /runs/:id/feedback`;
- `nexus-ai-pro/adapter-kit`: the `define*()` builders, `Adapter`, `AdapterDefinition`,
  `AdapterReport`, `AdapterError` and its codes, the contract runners, and the capability types.
  Contract checks may be added in a minor release when they test something the contract already
  promised. A new check for a new promise arrives behind a capability an adapter must declare.
- `nexus-ai-pro/protocols/ag-ui`, `nexus-ai-pro/protocols/a2a`, and `nexus-ai-pro/protocols/acp`:
  the handlers, `a2aClient()`, `a2aTool()`, `serveAcp()`, and their types. Each speaks the
  protocol version it names. A minor release may send an event or answer a method it did not
  before, as a protocol adds them. An event or field already sent keeps its meaning. A new major
  version of a protocol arrives beside the old one, not in its place.
- `nexus-ai-pro/runtime`, `runtimeInfo()`, `RuntimeInfo`, and `RuntimeName`, which may gain
  names in a minor release; the `fetch` option on the OpenAI, Anthropic, Google, and Cohere
  provider configurations.
- Portability, for the client, the kernel, the provider adapters, graphs, agents, and the agent
  protocols: none of them starts needing Node.js in a minor release, and the build fails if one
  does.

Without `confidence`, a canary is judged as before.

These security fixes tighten more behavior, each closing a finding of a graduation review in
[SECURITY.md](./SECURITY.md#threat-reviews):
- the Git loader never follows a symbolic link, nor a path that leaves the checkout;
- a gzipped sitemap may inflate to 50 MB at most, the sitemap protocol's maximum;
- a local MCP server inherits only what a process needs to run, not this process's environment.
  `inheritEnv` restores the old behavior, by name or entirely;
- a canary is judged on runs, so each run counts once per feedback key, as the mean of its scores;
- the file prompt store's label compare-and-set holds within one process;
- changes to one deployment through one `Deployments` object apply in order.

### Graduation

A surface left experimental status in 2.4 only when every requirement in
[How an item graduates](./ROADMAP.md#how-an-item-graduates) had evidence. That evidence is below.
"n/a" names a requirement that does not apply, and says why. Every test named here runs in CI.
Load and soak budgets are checked by `npm run bench:surfaces` and `npm run bench:runtime`, which are
part of `check:release`. Upgrade tests run against the published 2.3.0 package, installed as a
development alias.

Every graduated surface is covered by the 2.x compatibility rules, with no breaking change planned.
That is the "API stability" requirement, met by all of them.

**The SQLite adapters** (`nexus-ai-pro/sqlite` and its subpaths):

| Requirement | Evidence |
| --- | --- |
| Conformance | The operation store, store, and vector store contracts: `tests/sqlite.test.ts`, `tests/vector-stores.test.ts` |
| Crash recovery | A crash at every durable boundary resumes to the uninterrupted state: `tests/crash-injection.test.ts` |
| Concurrency | Ten workers race one thread, one idempotency key, one queue, and one budget: `tests/ten-workers.test.ts` |
| Load | `checkpoint.sqlite` and `operations.claim-10k-queued` in `runtime-budget.json`; `sqlite.vectors-query-2k` and `sqlite.store-put-get-search` in `surface-budget.json` |
| Tenant isolation | Every SQLite store: `tests/tenant-isolation.test.ts` |
| Security | [Review](./SECURITY.md#sqlite-adapters): no findings |
| Upgrade | A 2.3 file upgrades in place, and a 2.3 worker shares its queue: `tests/upgrade-previous-minor.test.ts`; likewise from 2.0: `tests/upgrade.test.ts` |
| Soak | 20,000 queue lifecycles and 2,000 open, migrate, and close cycles, with flat memory and no handle left open |

**The Postgres and SQLite vector stores** (`PostgresVectorStore`, `SqliteVectorStore`):

| Requirement | Evidence |
| --- | --- |
| Conformance | The vector store contract on pgvector and on SQLite: `tests/vector-stores.test.ts`. The retriever contract over each: `tests/graduation-conformance.test.ts` |
| Crash recovery | n/a: a store keeps no run state, and a reload upserts the same ids |
| Concurrency | Ten writers upserting the same ids at once leave one whole row per id: `tests/graduation-conformance.test.ts` |
| Load | `sqlite.vectors-query-2k` and `postgres.vectors-query-1k` in `surface-budget.json` |
| Tenant isolation | Both stores: `tests/tenant-isolation.test.ts` |
| Security | [Review](./SECURITY.md#the-postgres-and-sqlite-vector-stores): no findings |
| Upgrade | A table 2.3 wrote is searched and filtered here: `tests/upgrade-previous-minor.test.ts` |
| Soak | 1,000 write, search, and delete cycles on pgvector |

**The loaders** (`nexus-ai-pro/loaders/*`):

| Requirement | Evidence |
| --- | --- |
| Conformance | Every format, the web loader through the SSRF-safe fetch, and Git cloned and in place: `tests/loaders.test.ts` |
| Crash recovery | n/a: a loader keeps no state, and reloading replaces the same chunks |
| Concurrency | n/a: a loader shares no records |
| Load | `loaders.markdown-csv-html` in `surface-budget.json` |
| Tenant isolation | n/a: a loader stores nothing; the store it loads into is isolated |
| Security | [Review](./SECURITY.md#loaders): two findings, both fixed |
| Upgrade | The same files give the same ids and text as in 2.3: `tests/upgrade-previous-minor.test.ts` |
| Soak | 2,000 load cycles |

**The retrievers** (`nexus-ai-pro/rag/retrievers`):

| Requirement | Evidence |
| --- | --- |
| Conformance | The retriever contract on `KeywordIndex`, on a vector retriever over memory, SQLite, and pgvector, and on `hybridRetriever()`: `tests/graduation-conformance.test.ts` |
| Crash recovery | n/a: an index is held in memory, and rebuilt by loading |
| Concurrency | n/a: an index belongs to one process |
| Load | `retrievers.keyword-query-5k` and `retrievers.hybrid-query` in `surface-budget.json` |
| Tenant isolation | Filters narrow every retriever, by the contract; the stores behind them are isolated |
| Security | [Review](./SECURITY.md#retrievers): no findings |
| Upgrade | The same corpus ranks the same, score for score, as in 2.3: `tests/upgrade-previous-minor.test.ts` |
| Soak | 50,000 add and delete cycles |

**The MCP registry** (`nexus-ai-pro/mcp/registry`):

| Requirement | Evidence |
| --- | --- |
| Conformance | Servers over the protocol in process and as a real child process: `tests/mcp-registry.test.ts` |
| Crash recovery | A server that fails to start is reported, and the rest serve: `tests/mcp-registry.test.ts` |
| Concurrency | n/a: a registry shares no records |
| Load | `mcp.registry-tools-10-servers` in `surface-budget.json` |
| Tenant isolation | n/a: a registry stores nothing |
| Security | [Review](./SECURITY.md#mcp-registry): one finding, fixed |
| Upgrade | A configuration reads the same as in 2.3: `tests/upgrade-previous-minor.test.ts` |
| Soak | 1,000 connect, call, and close cycles, with no handle left open |

**The context hub** (`nexus-ai-pro/context-hub`):

| Requirement | Evidence |
| --- | --- |
| Conformance | The same behavior on memory, files, Redis, and Postgres: `tests/graduation-conformance.test.ts` |
| Crash recovery | A commit is content-addressed, so repeating an interrupted one writes the same version: `tests/context-hub.test.ts` |
| Concurrency | Two hubs racing for one label never both win, on every backend: `tests/graduation-conformance.test.ts` |
| Load | `context-hub.commit-resolve` in `surface-budget.json` |
| Tenant isolation | Context bundles: `tests/tenant-isolation.test.ts` |
| Security | [Review](./SECURITY.md#context-hub): one finding, fixed |
| Upgrade | A bundle has the same version as in 2.3, and a 2.3 export imports: `tests/upgrade-previous-minor.test.ts` |
| Soak | 2,000 commit, resolve, and render cycles |

**Insights** (`nexus-ai-pro/insights`):

| Requirement | Evidence |
| --- | --- |
| Conformance | The same issues from runs in memory and in Postgres: `tests/graduation-conformance.test.ts`; proposals in memory and in files: `tests/insights.test.ts` |
| Crash recovery | n/a: analysis is read-only, and a proposal is one write |
| Concurrency | n/a: a proposal is decided once, by a person |
| Load | `insights.find-issues-5k-runs` in `surface-budget.json` |
| Tenant isolation | Insights read through the trace store, which is isolated: `tests/tenant-isolation.test.ts` |
| Security | [Review](./SECURITY.md#insights): no findings |
| Upgrade | A 2.3 proposal reads here, and errors group under the same signatures: `tests/upgrade-previous-minor.test.ts` |
| Soak | 300 clustering cycles |

**Tenant limits and the server's worker queue** (`nexus-ai-pro/server/tenancy`, and the queue
`createAgentServer()` runs on its operation store):

| Requirement | Evidence |
| --- | --- |
| Conformance | Tenant usage in memory and in Redis; the queue on every operation store: `tests/deployments.test.ts`, `tests/operations.test.ts` |
| Crash recovery | A crash at every durable boundary resumes to the same state, and a draining worker hands a run to another: `tests/crash-injection.test.ts`, `tests/deployments.test.ts` |
| Concurrency | Ten workers drain one queue, and spend one tenant budget without over-granting a slot: `tests/ten-workers.test.ts` |
| Load | `tenancy.admit-release` in `surface-budget.json`; `operations.claim-10k-queued` and `server.sse-fanout` in `runtime-budget.json` |
| Tenant isolation | Operations: `tests/tenant-isolation.test.ts` |
| Security | [Review](./SECURITY.md#tenant-limits-and-the-worker-queue): no findings |
| Upgrade | A 2.3 worker and a 2.4 worker drain one queue: `tests/upgrade-previous-minor.test.ts` |
| Soak | 50,000 admit and release cycles, and 500 replica lifecycles with no timer left running |

**Still experimental**, each with what remains:
- **Deployments** (`nexus-ai-pro/server/deployments`). Two replicas changing one deployment in the
  same instant can lose one change, because the state store has no atomic compare-and-set. Every
  other requirement has evidence above or in its review.
- **Images.** Recorded live conformance must pass on all three backends. The scheduled live workflow
  now records it, wherever a backend's credential is set.
- **The Qdrant, Redis, Pinecone, Weaviate, and Chroma vector stores.** The contract must pass against
  the real servers, not only stubs. The scheduled live workflow now runs it against each one as a
  service container, and Pinecone runs when its secret is set.
- **The studio and its accounts.** A threat review of its sign-in, sessions, and roles, and a soak
  of its server, are still to do.

## 2.3 stage (2.3.0)

Everything 2.3 adds is stable from the start and additive: no default changes meaning.

- `ToolDefinition.capabilities` and the capability grammar; `permissionPolicy()`, `PermissionPolicy`,
  `PermissionRules`, `PermissionRequest`, `PermissionVerdict`, `PermissionDecision`,
  `PermissionPolicyLike`, `parseCapability()`, `capabilitiesOf()`, `isSensitiveCapability()`, and
  `normalizePath()` (`nexus-ai-pro/agent/permissions`); `CreateAgentOptions.permissions`;
- the sandbox contract: `Sandbox`, its option, result, and isolation types, `sandboxTools()`,
  `runSandboxConformance()` and its report types, `SandboxPathError` (`nexus-ai-pro/agent/sandbox`).
  `processSandbox()` is a development reference and may change; conformance checks may be added;
- `NodeOptions.effects` and `interrupts`, `CompileOptions.tools`, `GraphToolDescription`, and the lint
  codes `SENSITIVE_TOOL_WITHOUT_APPROVAL`, `UNDECLARED_TOOL_CAPABILITIES`, and
  `SIDE_EFFECT_BEFORE_INTERRUPT`;
- `nexus-ai-pro/agent/middleware` and every middleware and option type on it;
  `AgentMiddleware.wrapModelCall`, `AgentMiddlewareContext`, `AgentModelCallContext`, the third
  argument of `wrapToolCall`, `next(call)`, and `AgentStopReason` `'stopped'`. The PII patterns
  may be tightened in a minor release to cut false positives, and new `PiiKind` members may be
  added;
- `nexus-ai-pro/server/auth`: `jwtAuth()`, `apiKeyAuth()`, `trustedProxyAuth()`, `anyAuth()`,
  `createJwtVerifier()`, `hashApiKey()`, `JwtError` and its codes, and every option type. New
  `JwtAlgorithm` and `JwtErrorCode` members may be added;
- `Principal.roles`, `method`, and `claims`; `GraphRunOptions.principal`, `NodeContext.principal`,
  `WorkflowRunOptions.principal`, and `WorkflowContext.principal`; `ToolContext` and the second
  argument of `ToolDefinition.execute`; `AgentMiddlewareContext.principal` and
  `PermissionRequest.principal`. A checkpoint's `metadata.userId` is recorded when a run has a
  principal with a subject;
- `SparseRetriever`; `PostgresKeywordIndex` and `keywordIndexMigrations()`
  (`nexus-ai-pro/postgres/fulltext`); `ElasticsearchKeywordIndex` and `ElasticsearchError`
  (`nexus-ai-pro/rag/elasticsearch`); and every reranker and option type on
  `nexus-ai-pro/rag/rerankers`. The default endpoints of hosted rerankers follow their providers'
  current API versions;
- `nexus-ai-pro/rag/pipeline`: `createIngestionPipeline()`, `ingestionExecutor()`, and their types.
  The manifest's layout under `['nexus', 'ingestion', <name>]` is stable: a later release reads a
  manifest an earlier one wrote;
- `nexus-ai-pro/deep-agent`: `createDeepAgent()`, `DeepAgentOptions`, `DeepSubagent`, and
  `DeepSkill`, and the names and arguments of the tools it gives the model (`write_todos`,
  `delegate`, `load_skill`, `edit_file`). The wording of its system prompt may change in any release.

## 2.2 stage (2.2.0)

Everything 2.2 adds is stable from the start and additive: no default changes meaning.

- versioned migrations: `SchemaMigration`, `AppliedMigration`, `MigrationStatus`, `MigrationResult`,
  `SchemaMigrationError`, `migrationChecksum()`, `applyPostgresMigrations()`,
  `postgresMigrationStatus()`, `postgresMigrations()`, `PostgresMigrateOptions`, every adapter's
  `…Migrations()`, and the SQLite twins (`nexus-ai-pro/postgres`, `nexus-ai-pro/postgres/migrations`,
  `nexus-ai-pro/sqlite`, `nexus-ai-pro/sqlite/migrations`). A migration, once released, never
  changes; later releases add versions. `migrate()` now resolves to a `MigrationResult` instead of
  nothing;
- `nexus db status` and `nexus db migrate`, and `nexus db sql --record`;
- `RedisOperationStoreOptions.index` and `reindex()`;
- `CircuitBreakerConfig.shareObservations`, `CircuitStateStore.observe()`, `CircuitObservation`,
  `CircuitWindow`, and `CircuitSnapshot.shared`;
- `PostgresRollupStore` (`nexus-ai-pro/postgres/rollups`);
- the tenant model (`nexus-ai-pro/tenancy`): every `tenant…()` view, `tenantScope()`,
  `TenantAssetStore`, `TenantStores`, `assertTenantId()`, `TenantIdError`, and `TENANT_NAMESPACE`.
  The prefix a view stores names under (`tenant/<id>/`) is part of the contract and does not change
  within 2.x; `GraphRunOptions.tenantId`, `NodeContext.tenantId`, the `tenantId` options of `state()`,
  `history()`, `fork()`, and `updateState()`, `OperationRecord.tenantId`,
  `OperationSubmitOptions.tenantId`, `OperationStoreFilter.tenantId`, `RateLimitedRequest.tenantId`,
  and `rateLimit.key: 'tenantId'`;
- `CacheConfig.namespace`, `CacheNamespace`, `CacheOutcome` and `ResponseMeta.cache`,
  `CompletionRequest.responseCache`, `MemoryCache.lookup()`, and the `scope` of `SemanticCache`'s
  `get()` and `set()`;
- `diagnose()` and its types (`nexus-ai-pro/doctor`), and `nexus doctor`. Checks may be added in a
  minor release; a check's id and what makes it fail do not change within 2.x;
- workflow steps' `timeout`, `onError`, `StepTimeout`, `StepFailure`, `StepRecovery`,
  `StepContext.heartbeat()`, `WorkflowOptions.stepDefaults`, `WorkflowRunOptions.control` and
  `tenantId`, `WorkflowContext.tenantId`, and `WorkflowStepTimeoutError.kind`;
- `RunHandOffError`, `AssistantRunContext.saveProgress()` and `progress`.

Three races are closed rather than added: a busy thread is claimed atomically, and the in-memory and
Redis operation stores refuse a second record under a held idempotency key, as the SQL stores
already did. The semantic cache no longer matches across tenants, and a failing response cache no
longer fails a request.

## 2.1 stage (2.1.0)

Everything 2.1 adds is stable from the start and additive: no default changes meaning.

- graph durability modes, `flush()`, `maxPendingWrites`, `onError` with `NodeFailure` and
  `RecoveredFailure`, `nodeDefaults`, `NodeTimeout`, `context.heartbeat()`, `SendOptions`,
  `RunControl` and `RunControlLike`, and `GraphDrainedError` (`nexus-ai-pro/graph`);
- `lintGraph()` and its finding types (`nexus-ai-pro/graph/lint`). New rules may be added in a minor
  release; a rule's code and severity do not change within 2.x;
- `OperationContext.previousHeartbeat` and `OperationRecord.heartbeatDetails`;
- `AssistantRunContext.control`;
- the graph event stream: `events()`, `resumeEvents()`, `continueEvents()`, `GraphEventStream`, its
  event and option types, `GraphStreamOverflowError`, `context.message()` and `context.tool()`, and
  `subgraphEvents`. New projections may be added in a minor release;
- `TracerOptions.incremental` and `exporters`, `TraceExporter`, `traceparent` in and out, `flush()`,
  `closeAbandonedRuns()`, `w3cTraceId()` and `w3cSpanId()` (`nexus-ai-pro/tracing`);
- `OtlpTraceExporter` and `runToOtlpSpan()` (`nexus-ai-pro/tracing/otlp`). Attributes may be added as
  the GenAI conventions settle; the ones listed in the tracing guide stay;
- rollups (`nexus-ai-pro/tracing/rollups`), timed replay (`timing`, `pace`), evaluator provenance
  (`withProvenance()`, `Experiment.evaluators` and `framework`, `LLMJudge.asEvaluator()`),
  `createAgent({ streamTokens })`, and `graphAssistant(graph, { events })`;
- `rateLimit.algorithm` and `burst`, `RateLimitStore.gcra()`, `RateLimitDecision`, and `gcraDecide()`;
  `health.observationTtlMs`, `ProviderHealthStatus`, a snapshot's `status` and `stale`, and
  `checkProviders({ staleOnly })`.

The studio's `rollups` source follows the studio's experimental label.

## 2.0 stage (2.0.0)

2.0 removes what 1.x deprecated and promotes the surfaces that have settled.

**Promoted to stable.** These follow the 2.x rules without an experimental label:

- graphs, with their advanced APIs: `Send`, `Command`, breakpoints, `updateState()`, `fork()`, node
  caching, and functional workflows (`nexus-ai-pro/graph`, `/graph/functional`, `/graph/visualize`);
- the store (`nexus-ai-pro/store`, `/store/redis`), agents (`nexus-ai-pro/agent`), and tracing
  (`nexus-ai-pro/tracing`);
- evaluation (`nexus-ai-pro/evaluate`) and prompts (`nexus-ai-pro/prompts` and `/postgres/prompts`);
- the agent server (`nexus-ai-pro/server`): its routes, `RunRecord`, `ThreadRecord`, `RunEvent`, and
  recovery.

**New in 2.0, and stable from the start:**

- the operation lifecycle: the stage order, `LifecycleConfig`, `LifecycleHooks`, the
  `OperationDescriptor`, `OperationOutcome`, and `OperationTicket` shapes, the `BudgetLedger`
  contract, and `ProviderCallContext`. New families and stages may be added in a minor release;
  existing ones keep their names;
- mixed content: `AssetContent`, `ToolOutput`, and `response.assets`;
- checkpoint schema version 2. Both checkpointers read version 1 throughout 2.x.

**Still experimental in production readiness**, each following the 2.x rules all the same:

- images, until recorded live conformance passes on all three backends;
- the studio package;
- deployments, tenant limits, and the server's worker queue (1.24);
- the context hub, insights, and the studio's accounts (1.23);
- the loaders, the vector stores added in 1.20 and 1.22, the retrievers, and the MCP registry;
- the SQLite adapters (1.21).

**Root import.** The root exports the core client, its config builders, its types, the errors it
throws, the lifecycle, and `tool()` and `toolOutput()`. Adding anything else to the root waits for a
major release, and a check in CI fails when the root grows.

**Dependencies.** The package has no required dependency. `zod`, `ajv`, `ajv-formats`, and
`@types/node` are optional peers; making any of them required again would need a major release.

## Capability negotiation stage

`negotiateCompletionRequest()`, `NexusCapabilityError`, `CapabilityPolicy`, `CapabilityWarning`, and
the `nexus-ai-pro/capabilities` subpath are public and follow the 1.x rules.

Which options a given model accepts is registry data, not a compatibility guarantee. A model's
declared capabilities, cache lifetimes, reasoning effort levels, and prices can change in a minor
release when a provider changes its lineup, and new normalized warning entries may be added. What is
guaranteed is the behavior of each policy: `strict` throws before the provider call, `warn` records a
warning and continues, `off` sends the request unchanged, and an option a model does not mention is
always passed through rather than refused.

`ResponseMeta.usage` and `ResponseMeta.cost` are public normalized shapes. Reported token counts and
prices originate with the provider or with bundled defaults and are not compatibility guarantees;
`cost.basis` distinguishes the two. `ResponseMeta.estimatedCost` is deprecated in favor of
`cost.amount` and will be removed in the next major release.

## Telephony API stage

The `nexus-ai-pro/telephony`, `telephony/twilio`, and `telephony/realtime-bridge` subpaths are public
and follow the 1.x rules. This covers `TelephonyManager`, the `TelephonyProvider` contract, the
normalized call, media-stream, status-callback, and phone-number types, the TwiML helpers, and the
realtime bridge.

Provider payloads under `raw`, TwiML markup details beyond the documented helper options, webhook
signature formats, upstream call-status vocabularies, and carrier behavior are controlled by the
provider and are not normalized guarantees. `TelephonyProvider` methods are optional by design, so a
provider adapter may implement any subset; adding a new optional method is a minor change.

## Realtime API stage

The opt-in `nexus-ai-pro/realtime` family is public in the current development line. This includes the
explicit `realtime/session`, `realtime/tools`, `realtime/conversation`, `realtime/openai-webrtc`,
`realtime/openai-websocket`, `realtime/openai-server`, and `realtime/mock` subpaths. Its exported symbols,
normalized event names, configuration fields, and conversation/export shapes follow the same patch
compatibility rules as the rest of the package.

The realtime surface follows the 1.x compatibility rules for its normalized public API. Provider-specific
wire events returned by `openai-events`, values
under `raw`, SDP/ICE behavior, and upstream model or voice availability are controlled by the provider
and are not normalized compatibility guarantees. New normalized event variants or optional metrics may
be added in a minor release. Incompatible normalized API changes require a major release unless an urgent
security fix makes preserving the old behavior unsafe.

Platform interfaces for WebRTC and WebSocket are structural so applications can inject browser, server,
mobile, or test adapters without a framework dependency. A documented structural member is public;
private transport internals and unexported protocol helpers are not.

`VoiceSession` and `RealtimeSession` are independent public APIs. `VoiceSession` remains a batch,
turn-oriented transcription/completion/speech workflow. `RealtimeSession` owns a persistent transport,
live events, interruption, and normalized realtime conversation state. Neither is a compatibility alias
for the other.

## Image API stage

The `nexus-ai-pro/images` family is experimental in production-readiness, but published normalized
types, manager methods, operation events, and explicit subpath exports still follow the 1.x semantic
versioning rules. The experimental label does not permit an incompatible minor or patch release.

Provider payloads under `raw`, provider-specific error metadata, temporary delivery URLs, upstream model
availability, and generative output are not normalized compatibility guarantees. The current local
operation handle is process-bound and does not promise durable recovery, distributed cancellation, or
exactly-once provider execution. Those capabilities will use additive adapters and contracts when added.
`MemoryAssetStore` is likewise process-local and does not promise cross-process durability or shared
tenant state.

### Image portability (1.10.0)

The following are public under the same 1.x rules. None is exported from the root or from
`nexus-ai-pro/images`:

- `nexus-ai-pro/images/google`
- `nexus-ai-pro/images/comfyui`
- `nexus-ai-pro/images/transform`, which re-exports the PNG codec and header helpers
- `nexus-ai-pro/images/inputs`
- `nexus-ai-pro/images/moderation`
- `nexus-ai-pro/images/evals`

The following changes are additive:

- `ImageConfig.inputResolver` and `ImageConfig.tenantId` are optional. With no resolver, requests are
  handled exactly as before.
- `ImageAssetResolver` and `ImageAssetResolverContext` are new types.
- Output from the new modules is still generative. Backend wire shapes such as Imagen `:predict` and
  the ComfyUI queue API are upstream contracts outside this policy, like `raw`.

Behaviour that changed:

- **OpenAI masks and transparency.** `OpenAIImageProvider` now declares `supportsMask: true` and
  `supportsTransparency: true`, and accepts masked edits. A mask whose size differs from the input is
  still refused unless `resizeMode` allows resampling. `background: 'transparent'` is refused only with
  JPEG output.
- **Withheld outputs.** A provider finding with `source: 'output'`, `action: 'block'`, and
  `metadata.withheld: true` describes an image the provider removed before responding. The manager
  accepts one fewer asset per such finding, and does not let that finding block the images that were
  returned. Any other blocking finding still blocks the whole result.
- **Masked-edit conformance case.** `runImageProviderConformance` adds a `masked-image-edit` case for
  providers that declare `supportsMask`. Pass `testMask: false` to skip it.
- **`UrlPolicyError`.** Safe-fetch policy refusals are now this subclass of `Error`. Their messages are
  unchanged.

## Embeddings API stage

The `nexus-ai-pro/embeddings` family is public and follows the 1.x rules, including the explicit
`embeddings/adapters`, `embeddings/mock`, and `embeddings/models` subpaths. This covers
`EmbeddingManager`, `ai.embed()` and `ai.embedOne()`, the `EmbeddingsProvider` contract, the
normalized request, embedding, and meta shapes, the error subclasses, and `toEmbeddingFunction()`.

`EmbeddingsProvider` is a distinct contract from the pre-existing `EmbeddingProvider` function type
used by `MemoryVectorStore`, the semantic cache, and RAG ingestion. That function type is unchanged
and remains supported; `toEmbeddingFunction()` converts one into the other.

Two behaviors are guaranteed and differ deliberately from completions. Vectors are returned in input
order regardless of how the request was split, deduplicated, or served from cache. And an option the
target model or adapter declares it cannot honor is **refused**, not dropped, because a vector built
with different dimensions or a different input type is silently incompatible with vectors already in
a store. An option nothing in the registry describes is still passed through, on the same
absence-means-unknown rule the completion path uses.

Embedding model entries are registry data, not compatibility guarantees. Bundled dimensions, input
limits, batch limits, and prices can change in a minor release when a provider changes its lineup,
and are overridable through `embeddings.models.registry`. Which concrete model an alias such as
`embed-quality` resolves to can also change in a minor release: the vectors two targets produce are
not interchangeable, so pin a concrete model whenever a stored index must stay valid across
upgrades. Provider payloads under `raw` and reported token counts are controlled by the provider.

## Operations API stage

The `nexus-ai-pro/operations` family is public and follows the 1.x rules, including the
`operations/adapters` and `operations/webhooks` subpaths. This covers `OperationRunner`,
`LocalOperationHandle`, `MemoryOperationStore`, the `OperationStore` and `OperationDispatcher`
contracts, the Redis and BullMQ adapters, the webhook signing and verification helpers, the state
machine predicates, and the normalized record, event, and error shapes.

The lifecycle types moved out of `types/images.ts` and are re-exported from it, so existing image
imports of `OperationStatus`, `OperationEvent`, `OperationHandle`, `OperationEventBase`, and
`OperationErrorDescriptor` resolve unchanged. `OperationStatus` gained `retrying`, and
`OperationEvent` gained `progress` and `retrying` variants and an `attempt` field on `running` —
additive changes this policy permits in a minor release. Code that switches exhaustively on either
union should add the new members.

Three behaviors are guaranteed. Terminal statuses are final, so a late provider callback cannot
resurrect a settled operation. Store writes are compare-and-set on `sequence`, so a losing writer
is told it lost rather than silently overwriting. And a record carrying raw bytes is refused with
`OperationSerializationError` rather than persisted, because a base64 round trip through a queue
payload is a failure mode that otherwise appears only as a truncated job.

Durability is a property of the configured store, not of the runner. `MemoryOperationStore` does
not survive a restart and does not promise cross-process recovery. `RedisOperationStore` is atomic
only when the client exposes `eval`; without it the compare-and-set degrades to a read-compare-write
that narrows but does not close the race, and that limitation is documented rather than hidden.
Webhook delivery is best-effort and never fails the operation it describes.

## Resilience API stage

`CircuitBreaker`, the `RateLimitStore` contract, `MemoryRateLimitStore`, `RedisRateLimitStore`, and
the `ops/circuit-breaker` and `ops/rate-limit-adapters` subpaths are public and follow the 1.x rules,
together with `circuitBreaker` and `rateLimit.store` in `NexusAIConfig`.

`RateLimiter.check()` keeps its synchronous signature and in-memory behavior; `checkAsync()` is the
additive store-aware path. `NexusRateLimitError` gained an optional `resetAt` and a
`retryAfterSeconds` accessor. `RouterContext` gained an optional `openCircuits`, and `Router.route()`
an optional trailing parameter, both additive.

Which provider a breaker excludes at a given moment is a runtime decision, not a compatibility
guarantee: thresholds, scoring, and the exact ordering of candidates can change in a minor release.
What is guaranteed is the state machine — closed, open after a threshold is crossed, half-open after
the cooldown, closed again only after the configured probe successes — and that routing still selects
a provider when every circuit is open rather than failing the request untried.

Breaker state is per process unless `circuitBreaker.store` is set (since 1.16.0). With a store,
workers converge on each other's decisions within about `syncIntervalMs`, and one worker at a time
holds the probe; this is eventual agreement, not consensus, and two workers may briefly disagree.
Failure counting stays per worker either way. The `CircuitStateStore` contract and the memory, Redis,
and Postgres adapters follow the 1.x rules. Since 1.16.0 a caller's cancellation does not count as a
failure unless `isFailure` says so, and probe limits apply to every attempt the failover executor
makes. Rate-limit counters are only shared when a store is configured, and the default in-memory
counter gives each worker its own budget.

## Batch API stage

`BatchManager`, the `BatchProvider` contract, the OpenAI and Anthropic adapters, the deterministic
mock, and the `nexus-ai-pro/batch`, `batch/openai`, `batch/anthropic`, and `batch/mock` subpaths are
public and follow the 1.x rules, as are the normalized request, ref, state, and result shapes.

`BatchJobRef` is guaranteed to stay JSON-serializable and sufficient on its own to poll, collect, or
cancel a batch. That is what makes a persisted ref survive a restart, and narrowing it would break
every stored ref, so it requires a major release.

Two behaviors are guaranteed. Results are matched by `customId`, never by position, and a duplicate
`customId` is refused before submission. And a failed batch returns no items rather than fabricated
ones.

Provider vocabulary is not normalized beyond `BatchJobStatus`. Anthropic reports only `in_progress`
and `ended`, with the real outcome on the per-item results; that adapter maps `ended` to `completed`
and lets item errors carry the detail rather than inventing a batch-level failure. Payloads under
`raw`, provider quotas, completion windows, and the discount rate itself are provider-controlled and
may change without a major release.

## Asset store stage

`FilesystemAssetStore`, `S3AssetStore`, the `S3LikeClient` contract, and the
`nexus-ai-pro/images/stores` subpath are public under the 1.x rules and implement the existing
`AssetStore` contract unchanged. The shared contract, errors, and validation moved to an internal
`asset-support` module and are re-exported from `images/assets`, so every existing import resolves
as before.

All three stores guarantee that a missing asset and one owned by another tenant are
indistinguishable, that stored bytes carry a SHA-256 checksum, and that a lapsed asset is unreadable
before it is purged. `S3AssetStore.purgeExpired()` lists the record prefix on every call; on a large
bucket prefer the provider lifecycle rules. Neither durable store coordinates concurrent deletes
across processes.

## Model registry generation stage

`data/models/*.json` is the versioned source of truth in the repository, and
`scripts/generate-model-registry.mjs` emits `src/models/generated.ts` from it.

Neither is published, and neither is public API. They duplicate `KNOWN_MODELS` exactly, so shipping
them would add roughly 310KB to every install for data nothing reads. Generation is a build-time
guarantee about how the registry is maintained, not a runtime surface: the resolver continues to read
`KNOWN_MODELS`, and a test asserts the two match. Switching the resolver over is a later change, so
that introducing generation cannot alter pricing behavior in the same release.

## Graph API stage

`createGraph`, `StateGraph`, `CompiledGraph`, the channel constructors, both checkpointers, the error
classes, and the `nexus-ai-pro/graph` subpath are public and follow the 1.x rules, as are the
normalized checkpoint, result, and step-event shapes.

Four behaviors are guaranteed. A superstep is atomic with respect to checkpointing: state is reduced
and written before the next set of nodes is computed. A node that finished is never re-run by a
resume, so a completed branch's side effect happens once. `interrupt()` returns the supplied value on
replay rather than throwing again, keyed by node, step, and position, so a node may ask more than one
question. And `GraphCheckpoint` stays JSON-serializable, because a checkpoint that cannot be written
to Redis is not a checkpoint.

`GraphCheckpointer` is deliberately not generic over the channel schema: it persists opaque state,
and threading the schema through it would force an annotation on every construction for no benefit.
The graph casts at that boundary and hands typed state back through `state()` and `history()`.

`compile()` without a checkpointer uses an in-process `MemoryGraphCheckpointer` capped at 1,000
threads (since 1.10.0; earlier releases created none). `checkpointer: false` disables checkpointing. A
run started without a `threadId` reports its generated id on the result.

Also since 1.10.0:

- A paused or failed superstep records its already finished nodes in the optional `completed` field.
  Those nodes are not run again, and their edges still count when the step completes.
- Writing checkpoint N drops any stored checkpoints at or after N, so a rewound thread has one
  timeline. Keeping several branches is planned work (forks), not current behaviour.
- A subgraph interrupt surfaces as an interrupt of the parent node.
- `onProgress` receives `context.report()` calls.

Scheduling within a superstep is not a guarantee, and 1.11.0 makes use of that: tasks in a
superstep now run concurrently, bounded by `maxConcurrency` (default 16, settable per compile and per
run; `1` is strictly sequential). A node still must not depend on observing another node's write
within the same superstep — that is what channels are for. What is guaranteed is that writes are
reduced in task order rather than completion order, so a replay of the same decisions produces the
same state. The default `maxSteps` and `maxConcurrency` may change; pass them explicitly when a run
depends on the bound.

Also since 1.11.0, all additive:

- `Send` creates one task per value, with the task's input on `context.input`. Task ids are derived
  from the step and the order produced, and appear in the checkpoint's optional `tasks` field, which
  is written only when it says more than `next` does.
- `NodeOptions` on `addNode` carries `retry`, `timeoutMs`, and `ends`; `compile({ retry })` sets the
  default policy. Retrying is off unless asked for. A timeout raises `GraphNodeTimeoutError`.
- `onNodeError` chooses `fail-fast` (default) or `settle` for the siblings of a failed task.
- A paused checkpoint and result carry `interrupts`, every question the step asked;
  `interrupt` remains the first of them. `resumeInterrupts()` and `resumeInterruptsWith()` answer any
  subset by interrupt id. Interrupt ids are keyed by task, so ids written by earlier releases for
  ordinary nodes still resolve.
- `context.taskId` and `context.attempt` are new. Step events carry `tasks` and `attempts` when there
  is something to report.

Also since 1.12.0, all additive:

- `Command` (with `Command.PARENT`) may be returned from a node; `NodeResult` names what a node may
  return. `goto` routes are added to the node's outgoing edges, and a paused checkpoint records them in
  the optional `gotos` field.
- `interruptBefore` and `interruptAfter` on compile and run options; a paused checkpoint and result
  carry `breakpoint`, and step events may have type `breakpoint`.
- `NodeOptions.defer`, `GraphRunOptions.onEvent` with the `GraphEvent` union, and `context.emit()`.
  New `GraphEvent` variants may be added in a minor release.
- `updateState()`, `fork()`, and `describe()` on a compiled graph, and the `nexus-ai-pro/graph/visualize`
  subpath. The exact Mermaid text `toMermaid()` produces is not a guarantee — diagram layout may
  improve in a minor release — but `GraphDescription` is a normalized shape.
- A subgraph node's thread id is `<parent thread>:<task id>`, which equals the previous
  `<parent thread>:<node>` for any node not reached through `Send`.

Also since 1.16.0, all additive:

- `createGraph({ channels, input, output })`. `StateGraph`, `CompiledGraph`, and `GraphResult` gained
  defaulted type parameters for the input and output channels, so existing annotations such as
  `CompiledGraph<S>` keep their meaning. A write to an undeclared input rejects with
  `GraphValidationError`. Checkpoints and stream events still carry every channel.
- `NodeOptions.cache` and `CompileOptions.cache`. Guaranteed: a failure, an interrupt, a node that
  consumed an interrupt's answer, and a `Command.PARENT` result are never served from the cache, and a
  cache that throws is treated as a miss. Not guaranteed: the default key's exact text, so entries
  written by one minor release may miss after an upgrade.
- `task_end` events may carry `cached: true`; `GraphDescription` may carry `input`, `output`, and a
  node's `cache` flag.

## Agent, store, MCP, and tracing stages (1.14.0)

The `nexus-ai-pro/agent`, `nexus-ai-pro/store`, `nexus-ai-pro/store/redis`, and `nexus-ai-pro/mcp`
subpaths are public and follow the 1.x rules. None is exported from the root import.

- `createAgent()` returns a compiled graph, so the graph guarantees above apply to an agent: a
  superstep is atomic with respect to checkpointing, a finished task is never re-run by a resume, and
  an approval survives a restart. The agent's state channels (`messages`, `iterations`, `answer`,
  `stopReason`) are a normalized shape; what a model decides to put in them is not.
- `Store` is the contract; `MemoryStore` and `RedisStore` implement it. Ranking from a semantic search
  depends on the embedding function a caller injects and is not a guarantee. `MemoryStore` is
  process-local and bounded, and drops the least recently written item past `maxItems`.
- The MCP subpath implements a subset of the Model Context Protocol: initialize, tools, resources, and
  prompts, over stdio and HTTP. Protocol versions and server behaviour are upstream contracts outside
  this policy. Server-initiated streaming, sampling, and roots are not implemented; new methods may be
  added in a minor release.
- `nexus-ai-pro/tracing` is public: `Tracer`, the `TraceStore` contract, `MemoryTraceStore`,
  `JsonlTraceStore`, `traceGraph()`, `traceModelClient()`, `compareTraces()`, and `AlertEvaluator`.
  The `Run`, `RunTree`, and `RunQuery` shapes are normalized; what a model puts in a run's inputs and
  outputs is not. New `RunKind` values and query fields may be added in a minor release. Sampling is
  probabilistic by definition, so which traces are kept is not a guarantee, but the tail rules are:
  an error, a run past `keepSlowerThanMs`, or one past `keepCostlierThan` is always kept.
- `agentAsTool()` and the bundled middleware (`summarizeHistory`, `redactMessages`, `limitToolCalls`)
  are public and additive.
- `AgentLoop`, `tool()`, and `ToolExecutor` keep their behaviour and are re-exported from
  `nexus-ai-pro/agent` as well as the root.

## Evaluation stage (1.15.0)

`nexus-ai-pro/evaluate` is public and follows the 1.x rules, and is not exported from the root.
`Dataset`, `DatasetExample`, `Experiment`, `ExampleResult`, `MetricSummary`, and the comparison shapes
are normalized; new optional fields and new bundled evaluators may be added in a minor release.

- A dataset version is derived from example content. The hash itself is an implementation detail, but
  the guarantee is not: identical examples produce identical versions, and any change produces a
  different one.
- `compareExperiments()` is statistical. Its intervals come from a seeded paired bootstrap, so the
  same inputs give the same verdict; the exact interval bounds may change if the method improves, and
  a verdict is a judgement about evidence rather than a compatibility guarantee.
- `evaluate()` reports a target's failure as a failed example and an evaluator's failure as a failed
  measurement; neither throws. Since 1.16.0 an aborted evaluation rejects with the abort reason and
  stores nothing.
- `EvalRunner` and `MediaEvalRunner` keep their APIs. Since 1.16.0 both run on `evaluate()` and carry
  the resulting experiment in an optional `experiment` field; their reports are otherwise unchanged.
- Since 1.16.0, additive: `underCost()`, `FileExperimentStore`, `readExperiment()`, the `cost`
  option, per-example `repetitions`, and `signal` on the target's context.

## Postgres, command-line, and record-and-replay stages (1.16.0)

The `nexus-ai-pro/postgres` subpaths, `nexus-ai-pro/ops/circuit-store`, and
`nexus-ai-pro/testing/record` are public and follow the 1.x rules. None is exported from the root.

- Each Postgres adapter implements the same contract as the corresponding in-memory store, and is
  tested against it. Ordering among rows that tie on a timestamp is not a guarantee.
- `PostgresLikeClient` is the whole driver contract: `query(text, values)` resolving to `{ rows }`.
- The schema is guaranteed additive for the 1.x line: a minor release may add a column or an index,
  never drop or rename one, and `migrate()` stays idempotent. A change that needs a data migration
  waits for 2.0.
- Unique idempotency keys in `PostgresOperationStore` are a guarantee, and `OperationDuplicateError`
  is the signal the runner relies on.
- The `nexus` commands and flags listed by `nexus help` are public. Human-readable output is not a
  guarantee and may improve in any release; `--json` output follows the 1.x rules; exit codes are
  guaranteed — 0 for success, 1 for a failed check, 2 for a usage error.
- The fixture file format and the default match key of `testing/record` are stable for the 1.x line,
  so recordings made with one release keep replaying with the next. A change that would invalidate
  recordings waits for 2.0.

## Prompt stages (1.17.0)

The `nexus-ai-pro/prompts` subpaths and `nexus-ai-pro/postgres/prompts` are experimental in
production readiness, as the image family is: their exported types, functions, and classes follow the
1.x semantic versioning rules, and the experimental label does not permit an incompatible minor or
patch release. None is exported from the root.

- The content version algorithm is a guarantee. `promptVersion()` gives the same version for the
  same content in every 1.x release, so an upgrade never re-versions a committed prompt.
- Version, label, and history records only gain fields in the 1.x line, and the Postgres schema
  follows the additive rule above.
- The wording of gate reasons, of the note a forced promotion records, and of `formatPromptDiff()`
  output is for people and may improve in any release.

## Agent server stage (1.18.0)

The `nexus-ai-pro/server` subpaths are experimental in production readiness, as the image and prompt
families are: their exported types, functions, and classes follow the 1.x semantic versioning rules,
and the experimental label does not permit an incompatible minor or patch release. Neither is exported
from the root.

- The routes listed in the server guide, their status codes, and the shape of `RunRecord`,
  `ThreadRecord`, and `RunEvent` follow the 1.x rules. A minor release may add routes and fields.
- Event ids are per run and strictly increasing, which is what `Last-Event-ID` depends on. A client
  that reconnects with an id never receives it again.
- The server is not a security boundary on its own: authentication, and authorization beyond tenancy
  and scopes, are the application's, through the hooks. Per-tenant limits are opt-in, through
  `tenants`.
- Recovery repeats the step a run died in for graphs and workflows served by `graphAssistant()`, and
  the whole run for any other assistant, so the repeated part should be idempotent or the run left at a
  single attempt.

## Studio stage (1.19.0)

`nexus-ai-pro-studio` is a separate package, experimental in production readiness. It is versioned
with nexus-ai-pro and declares the core versions it works with as a peer dependency.

- The `nexus-studio` command, its flags, and the shape of the config module's default export follow
  the 1.x rules. A minor release may add sources and flags.
- `createStudio()`, `startStudio()`, and the exported types follow the 1.x rules.
- The JSON routes behind the page are for the page and may change in any release; build on the
  stores themselves rather than on the studio's routes.
- The access rules are a guarantee: loopback binding by default, a token on every request, the token
  in a header for every change, and loopback hosts only unless others are allowed.

## 2.0 preparation stage (1.25.0)

The last 1.x minor deprecates what 2.0 removes. Deprecated APIs keep working, unchanged, for the rest
of the 1.x line.

- The 2.0 root import keeps the core client, its config builders, the types of its configuration,
  requests, and responses, and the errors it throws. Every other root export is deprecated in favour of
  the subpath that already provides it, under the same name or, where noted, another.
- Every deprecated option warns once per process through Node's `DeprecationWarning` channel, so
  `--throw-deprecation` finds them in a test run. Deprecated exports and fields are marked in the type
  declarations, where editors show them.
- `nexus migrate` and its map follow the root's deprecations; both are generated from the export map,
  so they cannot disagree.
- A 1.x checkpoint stays readable throughout 2.x, by both checkpointers and by `migrateCheckpoint()`.

## Deployment stage (1.24.0)

Tenant limits and the worker queue graduated in 2.4; see the 2.4 stage for their evidence.
Deployments remain experimental.

Deployments (`nexus-ai-pro/server/deployments`), tenant limits (`nexus-ai-pro/server/tenancy`), and the
server's worker queue are experimental in production readiness. Their contracts follow the 1.x rules.

- `bucket()` is stable across 1.x, so a thread keeps its place in a traffic split through an upgrade.
- The stored `DeploymentRecord` and `ReplicaReport` shapes may gain fields but not lose them, so
  replicas on different minor releases share one store.
- The metric names on `/metrics` and the fields of `/scaling` follow the 1.x rules; a minor release may
  add metrics and fields. Autoscaler configurations that read them keep working.
- `drain()` hands off only runs it could not finish; a hand-off never counts against the retry budget.
- The files under `deploy/` are templates in the repository, not part of the package, and may change in
  any release.

## Team platform stage (1.23.0)

The context hub and insights graduated in 2.4; see the 2.4 stage for their evidence. The studio's
accounts remain experimental.

The context hub (`nexus-ai-pro/context-hub`), insights (`nexus-ai-pro/insights`), and the studio's
accounts are experimental in production readiness. Their contracts follow the 1.x rules.

- A bundle's content version covers its name, description, prompts, instructions, tools, skills, and
  config, and is stable across 1.x, so the same content is the same version in every release.
- The export format is `nexus-context-bundle`, format version 1; a later release reads it.
- A cached evaluation output is keyed by the fingerprint, the example's id and inputs, and the
  repetition. The key's derivation is stable across 1.x, so a cache survives an upgrade.
- The studio's roles keep their order and meaning; new actions are assigned to an existing role.

## Retrieval breadth stage (1.22.0)

The loaders, the SQLite vector store, the retrievers, and the MCP registry graduated in 2.4; see the
2.4 stage for their evidence. The Redis, Pinecone, Weaviate, and Chroma stores remain experimental.

The loaders (`nexus-ai-pro/loaders/*`), the Redis, Pinecone, Weaviate, Chroma, and SQLite vector
stores, the retrievers (`nexus-ai-pro/rag/retrievers`), and the MCP registry
(`nexus-ai-pro/mcp/registry`) are experimental in production readiness. Their contracts follow the
1.x rules.

- Every vector store keeps the `VectorStore` contract and its contract test, which checks that a
  metadata filter matches type as well as value.
- A loader's document ids are stable: the path relative to a directory or repository, the final URL
  of a page, and the file name plus key or position of a row or record. Chunk ids built from them do
  not change in a minor release, so a reload keeps replacing the same chunks.
- The REST stores' payload layout — `content`, `source`, `metadata` as JSON, and `meta_` filter fields
  — is stable across 1.x, so an index written by one release is read by the next.
- The registry reads `servers` and `mcpServers`; new configuration fields are optional.

## Durable execution stage (1.21.0)

The SQLite adapters graduated in 2.4; see the 2.4 stage for their evidence.

Functional workflows (`nexus-ai-pro/graph/functional`) and the SQLite adapters (`nexus-ai-pro/sqlite`)
are experimental in production readiness. Their contracts follow the 1.x rules.

- A workflow checkpoint is a graph checkpoint whose state holds the input, the recorded step results
  keyed by step name and call order, and the output. That layout is stable across 1.x, so a thread
  started by one release resumes on the next.
- The SQLite table layouts may gain columns in a minor release; `migrate()` adds what is missing.
- `ServerAssistant.recover()` and `AssistantRunContext.attempt` are optional additions: an assistant
  without `recover()` behaves as before.

## Retrieval stores stage (1.20.0)

`PostgresVectorStore` graduated in 2.4; see the 2.4 stage for its evidence. `QdrantVectorStore`
remains experimental.

`PostgresVectorStore` (`nexus-ai-pro/postgres/vectors`) and `QdrantVectorStore` (`nexus-ai-pro/rag/qdrant`)
are experimental in production readiness. The `VectorStore` contract they share with
`MemoryVectorStore` follows the 1.x rules: a minor release may add optional methods and options, not
remove or reshape these.

- The pgvector table layout may gain columns in a minor release; `migrate()` adds what is missing.
- A Qdrant point id is derived from the chunk id and is stable across releases, so a collection
  written by one version is read by the next.

## Deprecation process

Deprecated APIs are marked with `@deprecated` in declarations and described in the changelog. Removals
are reserved for major releases, except when an urgent security issue requires otherwise.

Report accidental compatibility regressions through the project issue tracker. Security issues should follow [SECURITY.md](./SECURITY.md).
