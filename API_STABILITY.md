# API Stability Policy

This policy describes compatibility guarantees for `nexus-ai-pro`. The 1.x compatibility guarantees
apply beginning with version 1.0.0.

## Release stages

The package follows semantic versioning. Within the 1.x line, incompatible changes to stable public
APIs require a major release. Minor releases may add backward-compatible features, and patch releases
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

## Deprecation process

Deprecated APIs are marked with `@deprecated` in declarations and described in the changelog. Removals
are reserved for major releases, except when an urgent security issue requires otherwise.

Report accidental compatibility regressions through the project issue tracker. Security issues should follow [SECURITY.md](./SECURITY.md).
