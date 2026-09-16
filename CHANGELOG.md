# Changelog

Notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use semantic versioning.

## [Unreleased]

Parallel graphs. A fan-out that looks parallel now runs in parallel, a graph can fan out over data it
discovers at run time, and a node can retry or time out on its own.

### Added

- **Concurrent supersteps.** Every task in a superstep starts together: four branches of 300 ms
  finish in about 310 ms, where they used to take 1,253 ms. `npm run bench:graph` measures it and
  fails if the gain disappears.
  - `maxConcurrency` bounds how many run at once. It defaults to 16, is settable per compile and per
    run, and `1` restores strictly sequential execution.
  - Writes are reduced in task order, never completion order, so timing cannot change the state a
    replay produces.
  - A superstep with a single task skips the scheduler, so a linear graph pays nothing for this.
- **`Send`, for fan-out over run-time data.** A router can return `new Send(node, input)` values,
  creating one task per value, each reading its own `context.input`. Fifty-seven URLs become
  fifty-seven tasks of one node in one superstep.
  - Each copy is checkpointed separately, so a resume re-runs only the copies that did not finish.
  - Task ids come from the step and the order produced, so a replay rebuilds the same tasks.
  - `addNode(name, fn, { ends })` declares `Send` targets, keeping reachability checks exact.
- **Per-node retries and timeouts.** `addNode(name, fn, { retry, timeoutMs })`, with
  `compile({ retry })` as the default for every node.
  - Retrying is off unless asked for, because only the application knows whether a node is
    idempotent. Interrupts, aborts, and validation errors are never retried.
  - `context.attempt` tells a node which try it is on, and step events report the attempts a task
    needed.
  - A timeout aborts the node's signal and fails that attempt with `GraphNodeTimeoutError`, even if
    the node ignores its signal.
- **`onNodeError`.** When a task fails, its siblings are aborted (`fail-fast`, the default) or left to
  finish (`settle`). Either way, what they already wrote is kept.
- **Several questions at once.** Parallel tasks can each interrupt. Paused checkpoints and results
  carry `interrupts`, and `resumeInterrupts()` answers any subset by id. A single question still works
  exactly as before through `resume()`.

### Fixed

- **A retry no longer lets the process exit while it waits.** The backoff timer was unref'd, so a run
  waiting to retry could be abandoned by an otherwise idle process.

## [1.10.0] - 2026-09-16

Image portability. Three image backends now sit behind one contract: OpenAI, Google Imagen, and a
self-hosted ComfyUI server. Masked edits work on all three, and every input is validated before any
provider sees it. Visual moderation inspects both the request and the generated images. Image output
can be evaluated for alignment, rendered text, preservation, and safety. Each piece is its own subpath,
and none is loaded by the root import.

### Added

- **Google Imagen adapter** (`nexus-ai-pro/images/google`). It calls the `:predict` protocol on the
  Gemini API with an API key, or on Vertex AI with a bearer token, for generation and masked
  inpainting.
  - It differs from OpenAI, and negotiation says so. Output is sized by aspect ratio, so `dimensions`
    is refused. `seed` and `negativePrompt` are supported.
  - A seed disables the watermark, and the result reports that as a warning.
  - When Imagen filters some images in a batch, the images that passed are still returned.
- **ComfyUI adapter** (`nexus-ai-pro/images/comfyui`) for a self-hosted server.
  - It uploads inputs, queues a workflow, polls with backoff, and downloads saved outputs.
  - It records the seed it used, even when the caller chose none, so a good run can be reproduced.
  - It removes an abandoned or failed prompt from the queue and interrupts it, so the GPU is not left
    working on a result nobody is waiting for.
  - The workflow graph belongs to the application. Stock text-to-image and inpainting builders are
    included.
- **Mask conversion** (`nexus-ai-pro/images/transform`). You draw a mask once, with either polarity, and
  it becomes OpenAI's alpha channel or the white-is-editable greyscale that Imagen and ComfyUI read.
  - A size mismatch is refused unless `resizeMode` allows `stretch`, `contain`, or `cover`. Resampling
    is nearest-neighbour, so a binary mask gains no grey fringe, and `contain` padding is never
    editable.
  - Partly transparent pixels count as non-editable, so a soft brush edge never widens an edit.
  - The PNG codec loads on the first masked request. An application that never masks never pays for
    it.
  - `AssetTransformer` is an injection seam for applications that want JPEG or WebP masks.
- **Validated inputs** (`nexus-ai-pro/images/inputs`). `ImageInputResolver` applies the same checks to
  byte uploads, remote URLs, and stored assets, and plugs into `ImageConfig.inputResolver`.
  - The type is decided by the bytes. A declared or served MIME type that disagrees is refused rather
    than corrected.
  - Byte and pixel limits are enforced. The pixel limit is read from the header before decoding, so a
    small file claiming a huge canvas is refused without allocating anything.
  - Remote fetches get the web connector's SSRF protection: pinned DNS, redirect revalidation, and
    blocking of private networks and cloud metadata.
  - Refusals are `ImageInputError`s with a machine-readable `reason`.
- **Visual moderation** (`nexus-ai-pro/images/moderation`). `createOpenAIVisualModeration` screens the
  prompt, input and reference images, and every generated image, because an innocuous prompt can
  still produce an unsafe image.
  - Block and review thresholds can be set per category.
  - If the moderation call fails, the request is blocked unless `failOpen` is set.
  - A stored output that cannot be sent for moderation is routed to review.
  - `combineSafetyPolicies` runs several policies and keeps every finding.
- **Media evaluation** (`nexus-ai-pro/images/evals`). `MediaEvalRunner` checks four things:
  - prompt alignment, using an injected judge;
  - rendered text, using OCR and edit distance;
  - edit preservation, using a perceptual hash that survives re-encoding;
  - blocking behaviour, reported as false-positive and false-negative rates.

  Every case runs repeatedly and reports mean, spread, and a 95% interval, plus latency, cost, error,
  and failover figures. Scores inside a configured uncertainty band go to a `ReviewQueue` instead of
  being decided automatically.
- **A masked-edit conformance case.** It runs for every provider that declares `supportsMask`. The
  fixture is a literal PNG, so the testing entry point does not load the codec.

### Changed

- **OpenAI masked edits and transparency are enabled.** `OpenAIImageProvider` now declares
  `supportsMask` and `supportsTransparency`. `background: 'transparent'` is refused only with JPEG
  output.
- **A provider can explain missing images.** A blocking output finding marked `metadata.withheld`
  counts toward the requested image count, and it does not block the images that were returned. Any
  other blocking finding still blocks the whole result.
- **SSRF protection is shared.** It moved out of the web connector into one module that the connector
  and image inputs both use. The web connector behaves the same, and its security tests pass
  unchanged. Policy refusals are now a `UrlPolicyError`, with the same messages.
- **Graphs checkpoint by default, as the documentation always said.** `compile()` now uses an
  in-process `MemoryGraphCheckpointer` when none is given, so `interrupt()`, `state()`, and
  `history()` work without setup. The default keeps at most 1,000 threads, dropping the least recently
  written one, so a service that never resumes cannot grow without limit. `maxThreads` is configurable,
  and `checkpointer: false` turns checkpointing off. Before this fix, `compile()` created no
  checkpointer and `interrupt()` threw.
- **The whole-package size limit is higher.** The new modules are about 200 KB unpacked across both
  builds, so the tarball limit rose from 460 KB to 500 KB packed and from 2.85 MB to 3.1 MB unpacked.
  No existing import got heavier because of them. Each new module has its own per-subpath budget, and
  the root import loads none of them.

### Fixed

- **A failed graph step no longer re-runs the siblings that finished.** The failed checkpoint used to
  discard their writes, so `continue()` ran them again and repeated their side effects. It now keeps
  those writes, and `continue()` retries only the nodes that did not finish.
- **Finished siblings still route onward after a paused or failed step resumes.** The checkpoint
  carried only the unfinished nodes, so the outgoing edges of siblings that had already finished were
  lost. A new optional `completed` field on the checkpoint records those siblings.
- **A subgraph that asks a question now pauses its parent.** `asNode()` used to treat an interrupted
  subgraph as finished: the parent merged its partial state and carried on. The parent now interrupts
  with the same question, and resuming the parent passes the answer into the subgraph, which continues
  where it stopped. A subgraph that asks several questions works across several resumes.
- **Rewinding no longer leaves checkpoints from the abandoned timeline.** After `resumeFrom(step)`,
  both checkpointers kept the later steps, so `state()` could return a step that no longer existed.
  Writing a step now drops any stored steps at or after it.
- **`context.report()` works.** It did nothing. Progress now reaches the new
  `GraphRunOptions.onProgress` callback, and a callback that throws does not fail the node.
- **`CompileOptions.name` is used.** It was documented but never read. It is now recorded on every
  checkpoint as `metadata.graph`.
- **An unnamed graph run now reports its thread id.** `invoke()` without a `threadId` returned
  `threadId: ''` even though it had generated one, so the run could not be inspected or resumed.
- **`AgentLoop` no longer runs a tool with arguments the model did not send.** Malformed tool-call
  JSON, or arguments that are not an object, used to become `{}` and the tool ran anyway. The tool is
  now skipped, and the parse error goes back to the model as the tool result.
- **`AgentLoop` says why it stopped.** `AgentResult.stopReason` is `completed` or `max_iterations`, so
  a caller can tell a final answer from a run that hit the iteration limit.

## [1.9.0] - 2026-09-15

Install weight, made measurable and enforced. Every export subpath now has a size budget that
CI holds it to, the README publishes what each import costs, and enforcing a cost budget no
longer loads the model catalogue. No public API changed.

### Added

- **A per-subpath size budget, enforced in CI.** `npm run size:check` measures the transitive import
  graph of every one of the 70 export subpaths and fails when an entry point grows past its recorded
  budget. The package already budgeted the whole tarball, which is exactly why per-entry growth went
  unnoticed across three releases while the total budget was raised three times: a shared module
  pulled into an otherwise small entry point does not move the tarball at all, it only moves what a
  consumer pays to import one piece. `npm run size:update` rewrites the budgets and regenerates the
  README table.
- **A published size table.** The README now carries what each import actually costs, generated from
  the build rather than written by hand, and the check fails if it goes stale. The claim is now
  verifiable before installing.

### Changed

- **Enforcing a cost budget no longer loads the model catalogue.** `assertWithinCostBudget`,
  `CostBudgetError`, `formatCost`, and `DEFAULT_CURRENCY` moved to `optimizer/cost-budget.ts`, which
  has no registry dependency; `optimizer/cost.ts` re-exports all four, so no import changes and the
  error classes stay identical rather than becoming copies. Comparing two numbers had been dragging
  30 KB of chat-model data along with it.
- **`nexus-ai-pro/embeddings` is 29% smaller**, 129 KB down to 91 KB, and no longer reaches
  `types/providers.js` at all. A test pins that, not just the budget.

## [1.8.0] - 2026-09-14

Graphs. Nodes, edges, cycles, fan-out and subgraphs over typed state, with every superstep
checkpointed so a run is resumable, inspectable and interruptible by construction rather than
after opting in, on a subpath that costs 5% of the root import.

### Added

- **Typed state graphs.** `nexus-ai-pro/graph` adds nodes, edges, conditional edges, cycles, fan-out,
  and subgraphs over typed state channels: explicit nodes and edges, persistent graph state,
  checkpoint and resume, human-in-the-loop interrupts, and complex branching.
- **Durable by construction.** Every superstep is checkpointed, so a run is resumable without opting
  into a checkpointer first. `MemoryGraphCheckpointer` covers a single process;
  `OperationStoreCheckpointer` persists through the `OperationStore` that already backs durable
  operations, which makes a Redis-backed thread a one-line change and lets a different worker resume
  what another suspended. The store is imported as a type only, so the graph subpath stays small.
- **Human in the loop.** A node calls `context.interrupt()`; the graph checkpoints and reports
  `awaiting_input`, and `resume()` supplies the value. On replay the same call returns that value
  instead of throwing, keyed by node, step, and position, so one node can ask several questions
  across several resumes. A sibling branch that already completed is not re-run.
- **Channels with reducers** — `lastValue`, `appendList`, `appendSet`, `mergeObject`, `counter`, and
  `reducerChannel` — so two branches writing the same slot in one superstep combine rather than
  clobber.
- **Time travel.** `state()`, `history()`, and `resumeFrom(step)` read and rewind a thread.
- **Compile-time validation.** An edge to an unknown node, a node nothing routes to, a duplicate node
  name, and a reserved name are all refused at `compile()` rather than at run time.
- New subpath `nexus-ai-pro/graph`. It is deliberately absent from the root import, so a user who
  does not build graphs pays nothing for it.

## [1.7.0] - 2026-09-08

Batch economics, distributed limits, and durable assets: the rest of the theme *work that
outlives a process*. The half-price asynchronous tier is reachable, one rate-limit budget covers
every worker, a failing provider leaves routing until it recovers, generated media persists
outside the process, and every operation family reports into the same metrics and audit log.

### Added

- **Circuit breaking.** `CircuitBreaker` consumes the same attempt signals as `ProviderHealthMonitor`
  and trips routing away from a failing provider entirely, rather than merely ranking it lower. Two
  independent triggers: consecutive failures, and a failure rate over a rolling window that catches a
  provider failing half its calls without ever failing several in a row. After a cooldown the circuit
  admits a limited number of probes; a success closes it, a failure reopens it and restarts the
  cooldown. Exposed through `circuitBreaker` config, `ai.getCircuitBreakerStatus()`,
  `ai.resetCircuitBreaker()`, and the `nexus-ai-pro/ops/circuit-breaker` subpath.
- **Distributed rate limiting.** A `RateLimitStore` contract with `MemoryRateLimitStore` and
  `RedisRateLimitStore`, set through `rateLimit.store`, so one budget covers every worker instead of
  each process getting the full limit. The Redis store does the increment and the expiry in one
  atomic Lua call when the client exposes `eval`, and re-arms a missing TTL on the fallback path so a
  crash between `INCR` and `PEXPIRE` cannot block a key forever. Completions and embeddings share the
  limiter, so they share the budget.
- `NexusRateLimitError` now carries `resetAt` and a `retryAfterSeconds` accessor, so a gateway can
  answer with a real `Retry-After` header.
- New subpaths `nexus-ai-pro/ops/circuit-breaker` and `nexus-ai-pro/ops/rate-limit-adapters`.
- **Provider batch tiers.** `BatchManager` puts OpenAI Batch and Anthropic Message Batches behind one
  operation handle, reaching the roughly half-price asynchronous tier that local `runBatch()`
  concurrency cannot. Results are matched by a required `customId` rather than by position, since a
  batch provider does not guarantee output order; a duplicate id is refused before submission.
  Polling backs off up to a configurable ceiling, an idempotency key replays instead of submitting
  twice, and `resume()` collects a batch from its `BatchJobRef` alone so a restarted worker can
  finish what another submitted. Ships with a deterministic `MockBatchProvider`.
- **Filesystem and S3 asset stores.** `FilesystemAssetStore` and `S3AssetStore` implement the
  existing `AssetStore` contract, with tenant isolation, retention, SHA-256 checksums, and signing.
  A missing asset and one owned by another tenant are indistinguishable, because a distinguishable
  error leaks the existence of another tenant asset. Both write bytes and a JSON sidecar per asset
  rather than a shared index, so concurrent writers do not contend and a torn write loses at most
  one record. `S3LikeClient` is structural, so S3, R2, and MinIO all work without an SDK dependency.
- **Generated model registry.** `data/models/*.json` is now the versioned source of truth, and
  `scripts/generate-model-registry.mjs` emits `src/models/generated.ts` from it. The generator
  validates required fields, price signs, context bounds, status values, and dangling aliases;
  `npm run registry:check` runs inside `npm run check` so committed data and output cannot drift.
  The runtime still reads `KNOWN_MODELS`, and a test asserts the two match exactly. The generated
  module and its data are build-time artifacts and are not published: they duplicate `KNOWN_MODELS`
  exactly, so shipping them would add roughly 310KB to every install for data nothing reads.
- New subpaths `nexus-ai-pro/batch`, `batch/openai`, `batch/anthropic`, `batch/mock`, and
  `nexus-ai-pro/images/stores`.
- **Cross-family observability.** Image, voice, and telephony operations now report into the same
  metrics collector, audit log, and rate limiter as completions and embeddings, closing the gap where
  an application running phone agents and image generation had observability for only part of its
  spend. Metrics carry `family` and `operation` labels, and one rate-limit budget now covers every
  family. `FamilyTelemetry` is exported for a family an application adds itself.

### Changed

- `RateLimiter` gained `checkAsync()` for the store-aware path. `check()` keeps its synchronous
  signature and behavior, and the runtime only awaits when a store is configured, so a request
  without one pays no extra microtask.
- `ImageManager`, `VoiceManager`, and `TelephonyManager` accept an optional second constructor
  argument carrying the shared observability objects. It defaults to empty, so constructing one
  standalone is unchanged and simply records nothing.
- The shared asset contract, errors, and validation moved from `images/assets` to an internal
  `asset-support` module so the filesystem, S3, and memory stores cannot drift on what a valid asset
  is. `images/assets` re-exports all of it, so existing imports are unchanged.
- Documentation consolidated from nine files to seven. `NEXUS.md` and `EXPLANATION.md` were four
  releases stale and largely restated the README; their unique content moved to `CONTRIBUTING.md`
  (real-provider test setup, the public-feature checklist, the manual smoke checklist) and to a new
  README "Known Limitations" section. The published package now carries only `README.md`,
  `API_STABILITY.md`, `CHANGELOG.md`, `SECURITY.md`, and `LICENSE`; `ROADMAP.md` is a design proposal
  and stays on GitHub.
- `SECURITY.md` no longer names a specific supported version line. It claimed `0.9.x` while 1.6.0 was
  the published release, so the wording is now version-independent and cannot go stale again.
- `RouterContext` gained an optional `openCircuits`, and `Router.route()` an optional trailing
  parameter. When every candidate's circuit is open the router routes anyway: that usually means a
  shared dependency is down, and one attempt beats a certain failure with no attempt at all.

## [1.6.0] - 2026-09-03

Durable operations, the first half of the theme *work that outlives a process*. Long-running work now
runs through one lifecycle that survives a worker crash. Everything here is additive.

The rest of the theme — provider batch APIs, distributed rate limiting and circuit breaking,
filesystem and S3 asset stores, a generated model registry, and cross-family observability — moves to
1.7.0. The operation handle they all sit behind ships here, which is what unblocks them.

### Added

- **`OperationRunner` and a shared operation lifecycle.** `queued → running → succeeded | failed`,
  with `retrying`, `cancelling`, `cancelled`, and `expired` covering the rest, exposed through the
  new `nexus-ai-pro/operations` subpath. The runner persists a record before doing any work, claims
  a lease, heartbeats while the executor runs, retries with backoff and jitter, dead-letters what
  never succeeds, and emits signed webhooks.
- **Restart survival through leases rather than locks.** A worker that dies leaves a record whose
  lease lapses; another worker's `recover()` sweep resumes it. Every store write is a compare-and-set
  on the record's `sequence`, so two workers racing on one operation cannot both win, and the loser
  is told it lost instead of silently overwriting.
- **`RedisOperationStore` and `BullMQOperationDispatcher`.** Redis persists records, with the
  compare-and-set done in one Lua call when the client exposes `eval`. BullMQ dispatch queues the
  operation id and its routing metadata only, never a payload.
- **Idempotency keys.** A key matching an existing record replays that operation instead of starting
  a second one, so an ambiguous timeout cannot produce a duplicate charge.
- **Progress and cancellation.** An executor reports progress through `context.report()`, which
  reaches both `handle.events()` and the persisted record. `runner.cancel()` settles an operation
  owned by another worker, observed there through its heartbeat.
- **Signed webhooks, with the verifying half included.** Deliveries are HMAC-SHA256 over
  `${timestamp}.${body}`, so a captured delivery cannot be replayed indefinitely.
  `verifyOperationWebhook()` ships alongside `signOperationWebhook()` rather than leaving every
  receiver to hand-roll a constant-time comparison. A failed delivery is reported and never fails
  the operation it describes.
- **A binary-payload guard.** Persisting a result carrying a `Uint8Array`, `Buffer`, `Blob`, or
  stream throws `OperationSerializationError` naming the exact path and pointing at `AssetStore`.
  Base64 in a job payload inflates it by a third and most queue backends cap job size well below one
  image, so this fails loudly at the boundary instead of appearing later as a truncated job.
- New subpaths `nexus-ai-pro/operations`, `operations/adapters`, and `operations/webhooks`.

### Changed

- The operation lifecycle types moved from `types/images.ts` to a family-neutral `types/operations.ts`
  and are re-exported from their old home, so existing image imports resolve unchanged. The image
  family's private handle was replaced by the shared `LocalOperationHandle`, which is told to reject
  with `ImageOperationCancelledError` so callers catching that error see no difference.
- `OperationStatus` gained `retrying`; `OperationEvent` gained `progress` and `retrying` variants and
  an `attempt` field on `running`. Additive, but code switching exhaustively on either union should
  add the new members.

### Fixed

- A handle driven by the runner stayed in `queued` for the whole run, so no `running` event was
  emitted and every `context.report()` call was silently dropped. Found while testing the runner's
  event sequence; the handle now exposes `markRunning()` and the runner calls it before each attempt.

## [1.5.0] - 2026-08-31

Embeddings become a first-class operation. `ai.embed()` gets the routing, caching, batching, budget,
retry, audit, and metrics that until now only completions had, so embedding spend is visible next to
completion spend instead of leaving the platform entirely. Everything here is additive.

### Added

- **`ai.embed()` and `ai.embedOne()`.** A provider-neutral embeddings operation family behind
  `EmbeddingManager`, reached through `ai.embeddings` or the new `nexus-ai-pro/embeddings` subpath.
  The manager is built on first access, so a runtime that never embeds pays nothing for it.
- **Adapters for OpenAI, Google, Cohere, Mistral, and Ollama**, plus any OpenAI-compatible
  `/embeddings` server through `OpenAIEmbeddingProvider`'s `baseUrl` and `providerName`. They are
  registered automatically from the provider credentials already in `providers`, so a configured
  chat provider makes `ai.embedOne('text')` work with no embedding-specific configuration. Explicit
  registration through `registerEmbeddingProvider()` always wins, and auto-registration can be
  turned off with `embeddings.autoRegisterProviders: false`.
- **Batching, deduplication, and per-input caching.** A batch larger than the model's limit is split
  and run with bounded concurrency, and the vectors still come back in input order. Repeated texts
  within one request are answered by a single provider call, and caching is keyed per input, so a
  partially repeated batch only sends the texts it has not seen. `meta.batches`, `meta.cachedInputs`,
  and `meta.deduplicatedInputs` report what actually happened.
- **Structured usage and numeric cost for embeddings.** `meta.usage` and `meta.cost` reuse the same
  `TokenUsage` and `ResponseCost` shapes as completions, priced from a new embedding model registry.
  When a provider reports no token counts — Google's `batchEmbedContents` does not — tokens are
  estimated locally rather than reported as zero, so a call is never priced at nothing.
- **An embedding model registry** with dimensions, supported truncation sizes, input limits, batch
  limits, and prices for eleven models across five providers, with aliases (`auto`, `embed-fast`,
  `embed-quality`, `embed-multilingual`, `embed-local`) and full override through
  `embeddings.models.registry`. It is deliberately separate from `KNOWN_MODELS`, because completion
  routing scores models on context window, output price, and tool support, none of which an
  embedding model has.
- **Capability refusal.** An unsupported `dimensions`, `inputType`, `encodingFormat`, or `truncate`
  value throws `EmbeddingCapabilityError` before the provider call. Embeddings refuse rather than
  drop: a vector built with different dimensions is silently incompatible with the vectors already
  in a store, and the mismatch only surfaces later as unexplained retrieval quality loss. An option
  the registry says nothing about is still passed through, and `providerOptions` reaches the
  provider body untouched.
- **`toEmbeddingFunction()`**, which adapts the family to the plain `EmbeddingProvider` function that
  `MemoryVectorStore`, the semantic cache, and RAG ingestion already accept. An existing vector store
  gains routing, caching, retry, and metrics without changing its own contract.
- **`normalize`** for unit-length vectors, applied locally when the provider does not already return
  them, and reapplied after a locally truncated vector loses its length.
- **A deterministic `MockEmbeddingProvider`** and `runEmbeddingProviderConformance()`, which checks
  one vector per input, input order, consistent width, optional determinism, and an honored abort.
- New subpaths `nexus-ai-pro/embeddings`, `embeddings/adapters`, `embeddings/mock`, and
  `embeddings/models`.

### Changed

- `RateLimiter.check()` accepts the new structural `RateLimitedRequest` instead of a
  `CompletionRequest`, so one limiter instance and one budget cover every operation family.
  `CompletionRequest` still satisfies it, so no call site changes.
- Coverage rose from 82.6% lines / 68.9% branches / 78.2% functions to 85.7% / 70.9% / 80.8%, with
  65 new tests. `embeddings/providers.ts`, previously the weakest file in the package at 37% lines,
  is now at 99%.

### Notes

- Bundled embedding dimensions and prices are defaults, not financial truth; override them through
  `embeddings.models.registry` when exact numbers matter.
- Which concrete model an embedding alias resolves to can change in a minor release. Two targets do
  not produce interchangeable vectors, so pin a concrete model when a stored index must stay valid
  across upgrades.

## [1.4.0] - 2026-08-25

Request parity and cost truth: the completion request can now express what current models actually
do, and the response reports what the call really cost. Every addition is an optional field or a new
union member, so existing code is unaffected.

### Added

- **Provider prompt caching.** `CompletionRequest.cache` selects `off`, `auto`, or `explicit` mode
  with a `5m` or `1h` lifetime, and `Message.cache` / `ToolDefinition.cache` mark the end of a
  cacheable prefix. The Anthropic adapter translates marks into `cache_control` breakpoints,
  respecting the four-breakpoint limit by keeping the deepest marks, and every adapter reports what
  the provider actually reused.
- **Reasoning controls.** `CompletionRequest.reasoning` carries `effort`, `maxTokens`, and `summary`.
  These map to OpenAI `reasoning_effort` and the Responses `reasoning` field, Anthropic extended
  thinking with a token budget, and Gemini `thinkingConfig`. A new `'reasoning'` `StreamChunk`
  variant carries reasoning summaries, kept separate from `'text'` so existing consumers that switch
  on chunk type see no change.
- **Tool and sampling controls.** `toolChoice`, `parallelToolCalls`, `seed`, `topK`,
  `frequencyPenalty`, and `presencePenalty` on `CompletionRequest`, mapped per provider.
- **Structured usage and numeric cost.** `ResponseMeta.usage` reports input, output, cached-read,
  cached-write, and reasoning tokens; `ResponseMeta.cost` reports a numeric amount with a currency
  and an `estimated` or `reported` basis. Cached reads and cache writes are priced at their own
  rates, with a long-lived write costing more than a short-lived one. `models.cachePricing`
  overrides the bundled multipliers.
- **Capability negotiation.** `negotiateCompletionRequest()` reconciles a request against the routed
  model under a `strict`, `warn`, or `off` policy, set through `capabilities.policy` or per request
  through `capabilityPolicy`. Refused options are reported on `ResponseMeta.capabilityWarnings` and
  in `plan()` warnings. An option the registry does not mention is passed through: absence means
  unknown, not unsupported, so an application-registered model is never restricted by fields it does
  not declare, and `off` guarantees a newer provider feature is never blocked by stale metadata.
- **Registry provenance.** Model entries accept `verifiedAt` and `source`; `MODEL_ALIAS_METADATA`
  reports each alias's stage and whether its target floats between releases. `describeModel()`,
  `checkRegistryFreshness()`, and `assertRegistryFreshness()` make drift visible instead of silent.
- **Streamed usage on OpenAI.** `stream_options.include_usage` is requested for OpenAI and Azure, so
  a streamed response reports real tokens and cost rather than zeros. Other OpenAI-compatible
  servers opt in with the new `streamUsage` provider option.
- A `nexus-ai-pro/capabilities` subpath for the negotiation API.

### Fixed

- Claude 5 models were declared as non-reasoning. The registry decided extended-thinking support by
  looking for a `4` in the family name, which is absent from `claude-sonnet-5.0`, `claude-haiku-5.0`,
  and `claude-fable-5.0`. Support is now derived from the family version, so every release from 3.7
  onward is reported correctly, together with the thinking budget each model can accept.
- The Anthropic adapter priced every completion at a hardcoded $0.003/$0.015 per 1k tokens instead of
  using the model registry, so cost was wrong for every Claude model except one. All adapters now
  share one pricing path.
- Streamed Anthropic and Google responses reported zero tokens and `$0.00`. Both now carry the
  provider's own usage totals on the final chunk.
- Google reasoning summaries could be concatenated into visible output. Parts marked `thought` are
  excluded from content and emitted as `'reasoning'` chunks instead.
- A chat stream that ended without a finish reason produced no `done` chunk, leaving consumers
  without terminal metadata.

### Changed

- `ResponseMeta.estimatedCost` is deprecated in favor of the numeric `cost` object. It is still
  populated and stays until the next major release. The metrics path no longer parses money out of
  its own display string.
- `ResponseMeta.tokensInput` keeps its original meaning of every prompt token; the uncached share
  billed at the standard rate is `usage.inputTokens`. Adapters whose provider folds cached tokens
  into one prompt total subtract them so no token is priced twice.
- `resolveModel()` no longer merges the bundled and application registries into a new object on each
  call. It reads both maps directly, which removes a per-request allocation from the hot path;
  `getModelRegistry()` and `getModelAliases()` are unchanged as the merged views.
- Coverage gates raised from 70/60/60 to 82% lines, 67% branches, and 73% functions, with new tests
  for the agent loop, the rules router, the evaluation metric library, and the Google, Ollama, and
  Cohere adapters. The gates sit a couple of points below the lowest figure the supported Node
  versions report, because Node 22 and Node 24 do not count functions identically: the same suite
  measures 78.7% on Node 22 and 75.9% on Node 24. A gate set from one version alone fails on the
  other.

### Notes

Image operations keep their existing strict capability behavior. An unsupported image option changes
the artifact that comes back, so silently dropping one is worse than refusing the request; the
shared policy vocabulary is in place for a future release that revisits this.

## [1.3.0] - 2026-08-17

### Added

- SMS routing on `updatePhoneNumber`. `UpdatePhoneNumberRequest` now carries `smsUrl`, `smsMethod`,
  `smsFallbackUrl`, and `smsFallbackMethod`, and the Twilio provider maps them to `SmsUrl`,
  `SmsMethod`, `SmsFallbackUrl`, and `SmsFallbackMethod`. Only the voice leg could be repointed
  before, so an application holding SMS-enabled numbers had to drop to the provider SDK to say where
  inbound messages should be delivered.
- `TelephonyPhoneNumber` reports the number's current `smsUrl`, `smsMethod`, `smsFallbackUrl`, and
  `smsFallbackMethod`, so message routing can be verified the same way voice routing already is.

## [1.2.1] - 2026-08-10

### Fixed

- TypeScript consumers of the CommonJS build no longer resolve ESM declarations. The CommonJS build
  now emits its own `.d.ts` files, and each export subpath carries per-condition types, so `require()`
  resolves CommonJS declarations instead of reporting TS1479 against the ESM ones.
- Subpath types are discoverable under `moduleResolution: "node10"`, which ignores `exports` and is
  still the default for NestJS projects. A `typesVersions` map now points each subpath at its
  CommonJS declarations, so `nexus-ai-pro/telephony` and friends type-check without a consumer having
  to migrate its `tsconfig.json` to `node16`.

## [1.2.0] - 2026-08-10

### Added

- A `telephony/realtime-bridge` subpath joining a provider media stream to a realtime session:
  inbound-only caller audio forwarding, outbound audio framing in emission order, barge-in that clears
  provider-queued audio before cancelling the response, playback marks that resolve
  `markAudioPlayed()`, stream lifecycle, and custom stream parameters for tenant routing.
- `twilioRealtimeAudioOptions()` pinning both directions to 8 kHz G.711 mu-law so telephony audio
  reaches the model without transcoding.
- Call control and usage metering on `TelephonyProvider` and the Twilio adapter: `getCall`, `endCall`,
  and `parseStatusCallback`, surfaced on `NexusAI` as `getCall`, `endCall`, and
  `parseTelephonyStatusCallback`. Status callbacks carry the authoritative billable call duration.
- Phone-number management on `TelephonyProvider` and the Twilio adapter: `listPhoneNumbers` and
  `updatePhoneNumber`, so an app can point a number at its own voice webhook and status callback.

### Changed

- The package now ships parallel ESM and CommonJS builds. Every export subpath gained a `require`
  condition, so NestJS and other `"module": "commonjs"` consumers can load it without a dynamic-import
  shim. Types stay shared between both builds, and the packed-size guards were raised to account for the
  duplicated JS payload.

## [1.1.0] - 2026-07-28

### Added

- An experimental provider-neutral image operation family with portable asset locations,
  `ImageManager`, generation/editing, strict capability negotiation, runtime provider registration,
  visual-safety hooks, and cancellable local operation handles.
- Opt-in `images`, `images/assets`, `images/mock`, and `images/openai` subpaths with a deterministic
  mock provider and an OpenAI Image API adapter for one-shot generation and reference-based editing.
- An image-provider conformance harness covering normalized assets, metadata, generation, editing, and
  pre-aborted calls.
- A bounded tenant-isolated `MemoryAssetStore` with retention, defensive byte copies, computed SHA-256
  checksums, capacity enforcement, and optional HTTP(S) signing.

### Changed

- Reconciled the changelog and API stability policy with the tagged 1.0.0 release.

## [1.0.0] - 2026-07-17

### Added

- An opt-in realtime package family with `realtime`, `realtime/session`, `realtime/tools`,
  `realtime/conversation`, provider transport, server-helper, and deterministic mock subpaths. Realtime
  code is not added to the root or batch voice import graph.
- Framework-independent OpenAI WebRTC and WebSocket transports with injectable platform interfaces,
  secure server-owned WebRTC negotiation, microphone and remote-audio handling, cancellation, and
  reconnect support.
- A persistent `RealtimeSession` and higher-level `createRealtimeAgent()` API with normalized and raw
  events, barge-in, response cancellation, unheard-audio truncation, typed tools, confirmations,
  idempotency keys, bounded execution, and transcript/usage state.
- Immutable normalized conversations with JSON, OpenAI-event, text, and analytics exports, plus
  connection, first-audio, turn, tool, interruption, reconnect, token, audio-duration, and cost metrics.
- Realtime security controls for tool allowlists, transcript retention, PII hooks, and maximum session
  and audio duration, with structural OpenTelemetry-compatible tracing and metrics hooks.
- Opt-in safe-tool result caching, active-connection/audio-duration metrics, and an application-owned
  realtime cost estimator hook without bundled pricing tables.
- A network-free realtime scheduling example using the deterministic mock transport.

### Changed

- Realtime connections are documented as a separate opt-in operation family. Existing `VoiceSession`
  behavior remains the batch transcription -> completion/tools -> speech workflow.

## [0.9.0] - 2026-07-15

### Added

- Full JSON Schema validation through Ajv and standard format validation through `ajv-formats`.
- Node.js 22 and 24 CI gates for linting, builds, tests, consumer type checks, and packed-package installation.
- OIDC trusted publishing with npm provenance for tagged releases.
- API stability, security, and contribution policies.
- Biome formatting/lint gates, test/example type checks, and built-in Node.js coverage thresholds.

### Changed

- The supported runtime is now Node.js 22 or newer and the package is explicitly ESM-only.
- Provider, cache, and job entry points now use an explicit export map instead of wildcard exports.
- Published tarballs contain the runtime and essential package documentation, excluding repository examples and marketing assets.
- Provider peer dependency ranges are bounded to tested SDK lines.
- Build and publish scripts always clean and rebuild `dist` before packing.
- Security-enabled output streams validate the complete bounded response before yielding chunks.

### Fixed

- Blocking output policies now stop unsafe completions instead of returning blocked content as successful output.
- Streaming redaction protects values that cross provider chunk boundaries.
- Provider timeouts abort in-flight completion and streaming requests.
- URL fetching rejects unsafe private-network targets and limits response reads.
- CLI and audit findings no longer disclose detected secret values.

[Unreleased]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.10.0...HEAD
[1.10.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/releases/tag/v1.0.0
[0.9.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/releases/tag/v0.9.0
