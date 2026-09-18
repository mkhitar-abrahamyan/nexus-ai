# nexus-ai-pro Roadmap

This roadmap is a design proposal, not a compatibility promise. Stable and experimental
surfaces are defined in [API_STABILITY.md](./API_STABILITY.md).

Status baseline: **1.11.0**. 76 export subpaths, each held to a size budget in CI, 12 completion
providers, 5 embedding providers, 2 batch providers, 3 image providers plus a mock, 101 completion
registry models plus 63 aliases, and 11 embedding models plus 5 aliases. 496 unit tests pass;
coverage sits at **89.9% lines / 75.1% branches / 84.2% functions** against gates of 82/67/73. CI
verifies lint, format, build, tests, coverage, registry drift, per-subpath size, mock conformance,
packed-package smoke, API contract, consumer type resolution, and clean install on Node 22 and 24.

---

## How we measure progress

Two axes, weighed together: **capability** and **install weight**. A capability that only works by
importing the whole runtime fails the second test however well it does on the first, so install
weight is a constraint on every new feature rather than a feature of its own.

Measured from the 1.11.0 build, an entry point costs a fraction of the root import: `/graph` 8%,
`/operations` 8%, `/images/stores` 4%, `/ops/circuit-breaker` 1%, `/cache/memory-cache` 0.5%,
`/streaming` 0.2%. Every new capability gets its own export subpath and stays out of the root,
and `npm run size:check` fails the build when any entry point grows past its budget.

Two things this project deliberately does not chase: a large catalogue of third-party integrations,
and a second language runtime. Both are decided by headcount rather than design, and pursuing either
would come out of the budget for routing, guardrails, cost accounting, durability, and install size —
which is where the work is meant to show.

## 1. What is delivered

### 1.1 Completion core

Provider-neutral `complete()`, `stream()`, and `plan()` over twelve adapters: OpenAI, Anthropic,
Google, Azure OpenAI, Groq, Mistral, Cohere, DeepSeek, OpenRouter, Ollama, LM Studio, and llama.cpp.
Around that core:

- automatic, rules-based, and direct routing with health-aware penalties, candidate allow/deny
  lists, and a failover executor that retries retryable errors but refuses to retry after partial
  stream output;
- a traced completion pipeline (`responseFormat`, `contextWindow`, `tokenOptimization`,
  `inputSecurity`, `routing`, `costBudget`, `cacheLookup`, `providerCall`, `outputSecurity`,
  `responseValidation`, `cacheWrite`, `auditLog`) with five user hook points and injectable steps
  via `use()`;
- context-window management with truncation and model-backed summarization, applied to both
  buffered and streamed calls;
- token optimization, prompt densification, budget enforcement, and pre-flight cost estimation;
- response-format validation through Ajv with standard format support;
- memory, Redis, SQLite, and semantic caching;
- a tool/agent layer (`tool()`, `ToolExecutor`, `AgentLoop`) and web fetch/search connectors with
  SSRF protection.

### 1.2 Security

`SecurityPipeline` composes injection detection (heuristic and semantic classifier with a published
calibration set), PII detection and redaction, input/output guards, schema validation, prompt
hardening, upload scanning, and named guardrail policies. Streaming redaction protects values that
cross provider chunk boundaries, and blocking output policies stop unsafe completions rather than
returning them as successful output.

### 1.3 Batch voice

`VoiceManager` and `VoiceSession` implement the transcription → completion/tools → speech workflow
with task-prompt matching, tool execution, conversation history, and a registrable
`VoiceProvider` interface. OpenAI is the shipped adapter.

### 1.4 Realtime voice

The opt-in `realtime` family is public under 1.x rules: persistent `RealtimeSession` and
`createRealtimeAgent()`, OpenAI WebRTC and WebSocket transports over structural injectable platform
interfaces, a deterministic mock transport, normalized speech/transcript/text/response/tool/
interruption/error/conversation/metrics events with retained raw payloads, barge-in, response
cancellation, unheard-audio truncation, reconnect backoff, typed tools with confirmation, timeouts,
bounded parallelism, safe retries, opt-in read caching, allowlists, idempotency keys, normalized
conversation state with JSON/OpenAI-event/text/analytics exports, server-owned SDP and client-secret
helpers, retention and PII hooks, session/audio limits, and OpenTelemetry-compatible hooks.

### 1.5 Telephony

Delivered in 1.2.0–1.3.0 and **not yet reflected in prior roadmap text**, which still described a
telephone gateway as out of scope:

- `TelephonyManager`, a registrable `TelephonyProvider` contract, and a Twilio adapter;
- TwiML response construction, webhook signature validation, and media-stream event parsing;
- `telephony/realtime-bridge`, joining a provider media stream to a `RealtimeSession` with
  inbound-only caller audio forwarding, ordered outbound framing, barge-in that clears
  provider-queued audio before cancelling, playback marks resolving `markAudioPlayed()`, and custom
  stream parameters for tenant routing;
- `twilioRealtimeAudioOptions()` pinning both directions to 8 kHz G.711 mu-law so telephony audio
  reaches the model without transcoding;
- call control and metering (`getCall`, `endCall`, `parseTelephonyStatusCallback`) plus phone-number
  management (`listPhoneNumbers`, `updatePhoneNumber`) including voice and SMS webhook routing.

### 1.6 Images (experimental)

Portable byte/URL/stored asset locations; request, result, usage, safety, provenance,
provider-call-context, and operation-handle types; a provider-neutral `ImageManager` with generation,
editing, provider registration, strict capability negotiation, visual-safety hooks, and cancellable
in-process submissions; a deterministic network-free mock; an image-provider conformance harness; an
opt-in OpenAI Image API adapter; and a bounded tenant-aware `MemoryAssetStore` with retention,
defensive byte copies, computed SHA-256 checksums, capacity rejection, and optional signed URLs.

Delivered in 1.10.0:

- Google Imagen and ComfyUI adapters;
- masked edits on every backend through an `AssetTransformer`;
- validated input resolution;
- visual moderation;
- `MediaEvalRunner`.

### 1.7 Request controls and cost accounting

Delivered in 1.4.0. Prompt caching with caller-placed breakpoints on providers that accept them;
reasoning effort, thinking budgets, and normalized `reasoning` stream chunks; tool-choice,
parallel-tool-call, seed, top-k, and penalty controls; structured `usage` with cached-read,
cached-write, and reasoning token counts; numeric `cost` priced per token class; and capability
negotiation under a `strict`, `warn`, or `off` policy with registry provenance and a freshness check.

### 1.8 Embeddings

Delivered in 1.5.0. `ai.embed()` and `ai.embedOne()` over a provider-neutral `EmbeddingsProvider`
contract with adapters for OpenAI (and any OpenAI-compatible server), Google, Cohere, Mistral, and
Ollama, auto-registered from existing provider credentials. Around them: model-registry routing with
aliases and per-provider fallback, batch splitting with bounded concurrency, within-request
deduplication, per-input caching, cost budgets, retry, structured usage and numeric cost, capability
refusal rather than silent option dropping, `toEmbeddingFunction()` for existing vector stores, a
deterministic mock, and a conformance harness.

### 1.9 Durable operations

Delivered in 1.6.0. `OperationRunner` over an `OperationStore` contract, with a checked state
machine, leases and heartbeats, delayed retry with backoff and jitter, dead-lettering, progress
events, idempotency replay, crash recovery, and HMAC-signed webhooks with a matching verifier.
`MemoryOperationStore` keeps the single-process case dependency-free; `RedisOperationStore` and
`BullMQOperationDispatcher` make the same code survive a restart. Persisting raw bytes is refused
so binary media cannot end up in a queue payload.

### 1.10 Batch economics and resilience

Delivered in 1.7.0. `BatchManager` over OpenAI Batch and Anthropic Message Batches behind the
operation handle, matched by `customId`, with backoff polling, idempotency replay, and `resume()`
from a persisted ref. `CircuitBreaker` removes a failing provider from routing until a probe
succeeds, on either a consecutive-failure count or a windowed failure rate. `RedisRateLimitStore`
shares one budget across workers, and `FamilyTelemetry` routes images, voice, and telephony through
the same metrics collector, audit log, and rate limiter as completions.

### 1.11 Durable asset storage

Delivered in 1.7.0. `FilesystemAssetStore` and `S3AssetStore` implement the existing `AssetStore`
contract with tenant isolation, retention, SHA-256 checksums, and signing. A missing asset and one
owned by another tenant are indistinguishable. The shared contract and validation live in one module
so the three stores cannot drift.

### 1.12 Graphs

Delivered in 1.8.0. `nexus-ai-pro/graph`: nodes, static and conditional edges, cycles,
fan-out, and subgraphs over typed state channels with reducers. Every superstep is checkpointed, so
resume, time travel, and human-in-the-loop interrupts work without opting into a checkpointer first.
`OperationStoreCheckpointer` persists through the store that already backs durable operations, which
is what makes a thread survive a restart and lets a different worker finish it.

### 1.13 Install weight

Delivered in 1.9.0. Every export subpath is held to a size budget in CI, and the README publishes a
generated table of what each import costs, which the same check keeps from going stale. Enforcing a
cost budget no longer loads the model catalogue, which took `/embeddings` from 129 KB to 91 KB.

### 1.14 Operations, evaluation, and packaging

Rate limiting, audit logging, in-memory and OpenTelemetry metrics sinks, Prometheus export, an
OpenTelemetry trace exporter, provider health monitoring, `EvalRunner` with LLM-as-judge and a
fourteen-metric library, workflow chains and four domain workflows, local batch and job queues with
Redis/BullMQ durable adapters, RAG ingestion including PDF/OCR extractors, a Next.js route handler,
a CLI (`scan`, `models`, `eval`, `optimize`), provider conformance fixtures, parallel ESM and
CommonJS builds with per-condition types and a `typesVersions` map for `node10` resolution, and OIDC
trusted publishing with provenance.

---

## 2. Known gaps

Ordered by how much each one costs a consumer today.

### 2.1 The traced pipeline is still completion-only

Closed for observability: embeddings in 1.5.0, then images, voice, and telephony through a shared
`FamilyTelemetry`, so every one of them reports into the runtime's metrics collector, audit log, and
rate limiter. `RealtimeSession` remains outside it, because a persistent session's unit of work is an
event stream rather than a discrete call and does not fit a call wrapper.

Cost is deliberately not recorded for media families. Providers there price per second, per image, or
per minute, and inventing a number for a metric named after tokens would be worse than reporting
none.

The graph family is outside this path too. A graph is a composition of whatever its nodes call, so
the nodes report and the graph itself has nothing of its own to meter; what it needs instead is a
per-thread view over the checkpoints, which does not exist yet.

The traced pipeline itself remains completion-only. `PipelineContext` is typed strictly around
`CompletionRequest`/`NexusResponse`, so other families cannot reuse it without a refactor, and
`PipelineStepName` ends in `| string`, which erases the union it defines. Embeddings therefore share
the observability primitives but not the step trace.

### 2.2 Embeddings beyond text retrieval

Closed for text in 1.5.0: `ai.embed()` is an operation family with routing, per-input caching,
batching, deduplication, budget, retry, audit, and metrics, over five adapters and its own model
registry. What remains is everything the family does not yet cover: a provider batch-API tier for
large asynchronous ingestion jobs, image and multimodal embeddings, a distributed cache adapter for
vectors shared across processes, and reranking as a sibling operation.

### 2.3 The model registry is still hand-maintained

1.4.0 added `verifiedAt`, `source`, alias staging, and `assertRegistryFreshness()`, so drift is now
visible. The data itself is still a hand-written TypeScript literal of 99 models and 63 aliases.
Generation from versioned provider data remains outstanding, and the Claude 5 reasoning bug 1.4.0
fixed is the kind of error generation would have prevented.

### 2.4 Durable execution is only half distributed

Closed in 1.6.0 for operations: `OperationHandle` is no longer process-bound, cross-process recovery
works through lapsed leases, and idempotency keys deduplicate across workers.

Still process-local: `RateLimiter` is an in-memory token bucket with no distributed adapter, there is
no circuit breaker (health monitoring exists, but nothing opens a circuit), `MemoryAssetStore` holds
assets in one process, and realtime conversation snapshots and exports live in memory. Provider-state
replay remains an application responsibility. One caveat on what did land: `RedisOperationStore` is
atomic only when the client exposes `eval`; without it the compare-and-set degrades to a
read-compare-write that narrows but does not close the race.

### 2.5 Image family blockers

Closed in code for 1.10.0, not yet released:

- masks, on all three backends;
- a second hosted wire protocol, Imagen;
- a self-hosted backend, ComfyUI;
- input hardening, visual moderation, and media evaluation.

Filesystem and S3 asset stores and the durable operation state machine shipped in 1.7.0 and 1.6.0.

What still blocks promotion is verification, not code. Every adapter has been tested against recorded
wire shapes, but none has passed live conformance. OpenAI generation still refuses `aspectRatio`,
`negativePrompt`, `seed`, and `references`. The upstream API does not accept them, so a portable
application should route those requests to Imagen or ComfyUI.

### 2.6 Realtime family limitations

OpenAI remains the only native realtime provider. The package ships transports, not React hooks,
audio-player components, or mobile SDK wrappers. WebRTC requires application-owned HTTPS negotiation
and browser permission/autoplay handling; WebSocket consumers own capture and playback. Compatibility
and load validation across Safari, iOS Safari, Firefox, Android Chrome, long conversations, and high
concurrent-session counts has not been performed, so broad production-scale claims are not yet
supportable. Realtime video tracks, SIP transports, durable cost accounting beyond the configurable
local estimate, and a published latency benchmark methodology remain follow-on work.

### 2.7 Test coverage weak spots

1.4.0 closed the worst of these: the agent loop went from 40% to 95% line coverage, the rules router
from 34% to 91%, and the evaluation metric library from 40% (5% of functions) to 99%. 1.5.0 took
`embeddings/providers.ts` from 37% to 99% and landed the new embeddings family at 95–100% across its
seven files. What is still thin:

| Area | Lines | Note |
| --- | --- | --- |
| `hallucination/rag.ts`, `verification.ts` | 38% / 47% | Grounding claims deserve tests. |
| `workflow/chains.ts`, `domain.ts` | 51% / 50% | |
| `security/pii-detector.ts`, `semantic-injection-classifier.ts` | 49% / 49% | Security-relevant. |
| `jobs/queue.ts`, `batch.ts` | 47% / 53% | |
| `rag/file-ingestion.ts` | 43% | |
| `ops/otel-tracing.ts`, `rate-limiter.ts` | 44% / 55% | |

Provider conformance runs against fixtures but has no record/replay corpus, so most real provider
behavior is only verified when credentials are present.

---

## 3. Shipped in 1.4.0 — request parity and cost truth

The completion request can now express what current models actually do, and the response reports
what the call really cost. Every addition is an optional field or a new union member, which
[API_STABILITY.md](./API_STABILITY.md) permits in a minor release, so existing code is unaffected.

- **Prompt caching.** `CompletionRequest.cache` selects `off`, `auto`, or `explicit` mode with a
  `5m` or `1h` lifetime; `Message.cache` and `ToolDefinition.cache` mark the end of a cacheable
  prefix. Anthropic receives real `cache_control` breakpoints, capped at four with the deepest marks
  kept. Every adapter reports what the provider actually reused.
- **Reasoning controls.** `reasoning.effort`, `reasoning.maxTokens`, and `reasoning.summary` map to
  OpenAI `reasoning_effort` and the Responses `reasoning` field, Anthropic extended thinking, and
  Gemini `thinkingConfig`. Summaries arrive as a new `reasoning` stream chunk, kept separate from
  `text`.
- **Tool and sampling controls.** `toolChoice`, `parallelToolCalls`, `seed`, `topK`,
  `frequencyPenalty`, and `presencePenalty`.
- **Structured usage and numeric cost.** `ResponseMeta.usage` separates uncached input, output,
  cached reads, cache writes, and reasoning tokens; `ResponseMeta.cost` is numeric, carries a
  currency, and distinguishes an estimate from a reported charge. Cached reads and writes are priced
  at their own rates, overridable through `models.cachePricing`. The formatted `estimatedCost`
  string is deprecated, and no code path parses money out of it any more.
- **Capability negotiation.** A shared `negotiateCompletionRequest()` reconciles the request against
  the routed model under a `strict`, `warn`, or `off` policy. An option the registry does not
  mention is passed through, so absence of a declaration never blocks a request, and `off` is a
  guaranteed escape hatch for a provider feature newer than the bundled data.
- **Registry provenance.** `verifiedAt`, `source`, alias staging with a `floating` marker, and
  `assertRegistryFreshness()` for a release-time drift check.
- **Corrections.** API_STABILITY now describes the shipped dual ESM/CommonJS build and carries a
  telephony section; the changelog has a dated 1.3.0 entry and complete comparison links.

Three real defects surfaced while building this and were fixed: Claude 5 models were declared
non-reasoning because the registry looked for a `4` in the family name; the Anthropic adapter priced
every completion at a hardcoded rate instead of using the registry; and streamed Anthropic and
Google responses reported zero tokens and `$0.00`.

Deliberately unchanged: image operations stay strict. An unsupported image option changes the
artifact that comes back, so dropping one silently is worse than refusing the request. The shared
policy vocabulary is in place for a later release that revisits this.

---

## 4. Shipped in 1.5.0 — embeddings as an operation family

`ai.embed()` with routing, per-input caching, batching, deduplication, budget, retry, audit, and
metrics; the existing factory functions became one adapter shape behind it, and
`toEmbeddingFunction()` keeps `MemoryVectorStore`, the semantic cache, and RAG ingestion working
unchanged. Embeddings refuse an unsupported option rather than dropping it, because a mis-sized
vector is silently incompatible with a populated store rather than merely different.

Deliberately deferred: the provider batch-API tier, which belongs with the durable operation handle
below rather than with the synchronous path.

## 5. Shipped in 1.6.0 — durable operations

The first half of *work that outlives a process*. One lifecycle now covers every long-running
family, and it survives a worker crash.

- **Operation state machine.** `queued → running → retrying → succeeded | failed | cancelling |
  cancelled | expired`, with leases, heartbeats, progress events, delayed retry, dead-letter
  handling, timestamps, signed webhooks, and trace propagation. The image family runs on it, and the
  lifecycle types moved to a family-neutral `types/operations.ts` re-exported from their old home.
- **Durable operation adapters.** `RedisOperationStore` persists records with a compare-and-set on
  `sequence`, done in one Lua call when the client exposes `eval`. `BullMQOperationDispatcher`
  queues the operation id only. A record carrying raw bytes is refused rather than serialized.
- **Idempotency and recovery.** A matching key replays an accepted operation instead of starting a
  second; `recover()` resumes records whose lease lapsed, expiring those past their deadline and
  dead-lettering those that used every attempt.

Restart survival comes from leases rather than locks. There is no distributed lock anywhere: every
store write is a compare-and-set, so a losing writer is told it lost instead of overwriting.

Deliberately deferred: everything below, which needed the operation handle to exist first.

---

## 6. Shipped in 1.7.0 — batch economics, distributed limits, and durable assets

The rest of *work that outlives a process*, now that the handle they sit behind exists.

- **Provider batch APIs.** `BatchManager` over OpenAI Batch and Anthropic Message Batches, matched
  by `customId`, with backoff polling, idempotency replay, and `resume()` from a persisted ref. Both
  hosted adapters are verified against mocked wire responses, not live APIs; a real smoke test
  against each provider is still owed before depending on the discount.
- **Distributed rate limiting and circuit breaking.** `RedisRateLimitStore` shares one budget across
  workers; `CircuitBreaker` consumes the existing attempt signals and removes a failing provider from
  routing until a probe succeeds. Breaker state stays per process by design.
- **Filesystem and S3-compatible asset stores** with retention, tenant ownership, checksums, and
  signing. Streaming reads remain outstanding: both stores return whole byte arrays, which is fine
  for an image and wrong for video.
- **Generated model registry.** `data/models/*.json` is the source of truth and `registry:check`
  gates drift. The runtime still reads `KNOWN_MODELS`; switching the resolver over is deliberately a
  separate change, so generation could not alter pricing in the release that introduced it.
- **Cross-family observability** for images, voice, and telephony: each reports through the runtime's
  metrics collector, audit log, and rate limiter via a shared `FamilyTelemetry`. Realtime is still
  outstanding — a persistent session's unit of work is an event stream rather than a call, so it
  needs its own shape rather than this wrapper.

Documentation was consolidated from nine files to seven in the same release, and the published
package now carries only `README.md`, `API_STABILITY.md`, `CHANGELOG.md`, `SECURITY.md`, and
`LICENSE`.

---

## 7. Shipped in 1.8.0 — graphs

Stateful orchestration on a subpath measuring 29 KB across six files.

- **Nodes, edges, and typed state.** Channels declare how concurrent writes combine, which is what
  makes fan-out safe; assignment would silently drop a branch's work.
- **Cycles as a supported shape**, bounded by `maxSteps` so a mistaken router fails with the pending
  nodes named rather than hanging.
- **Checkpoint and resume.** Each superstep writes a checkpoint, so `state()`, `history()`, and
  `resumeFrom(step)` all follow from the execution model rather than being bolted on.
- **Human-in-the-loop.** `interrupt()` suspends and checkpoints; `resume()` supplies the value, which
  the replayed node receives instead of the throw. A branch that already finished is not re-run.
- **Subgraphs.** A compiled graph is a node. Shared channels pass through; the rest stays private.
- **Durable by construction**, through the existing `OperationStore`, imported as a type only so the
  subpath stays small.

Still open in this area: nodes within one superstep run sequentially in edge order, and the
API_STABILITY note says so rather than implying concurrency that does not exist. Parallel execution
is planned for 1.11.0 (section 11). A review of this release also found defects where the code
contradicts the docs; their fixes are listed in section 9.

---

## 8. Shipped in 1.9.0 — size and modularity

The differentiator, made checkable rather than claimed.

- **Budget enforcement split from price lookup.** Comparing two numbers no longer loads the 101-model
  catalogue. `/embeddings` fell 29%, from 129 KB to 91 KB, and no longer reaches
  `types/providers.js` at all.
- **A per-subpath size budget in CI**, across all 70 entry points, with the failure naming the entry
  point and pointing at the fix.
- **A generated size table in the README**, which the same check keeps honest.

`/batch` keeps the catalogue, and should: it prices each item against the model that item actually
ran on, so the data is doing real work there rather than riding along. The remaining idea — deferring
the catalogue behind a dynamic import on the async pricing paths — was left out because it trades a
measurable static cost for an unmeasured deferred one, and the guard now exists to tell us whether
that trade is worth making.

---

## 9. Shipped in 1.10.0 — image portability and graph correctness

The neutral image contract now runs against three backends that disagree with each other: OpenAI,
Google Imagen, and ComfyUI. Everything below is implemented and tested.

- **Second hosted provider: landed.** `nexus-ai-pro/images/google` calls Imagen through `:predict` on
  the Gemini API or Vertex AI.
  - It exercises what OpenAI refuses: seeds, negative prompts, and aspect-ratio sizing.
  - It exercises what OpenAI lacks: per-image safety filtering. That filtering made the manager learn
    about withheld outputs, so a partly filtered batch keeps the images that passed.
- **Mask support: landed.** The `AssetTransformer` seam and the bundled `PngMaskTransformer` check
  dimensions and convert neutral polarity into each backend's semantics.
  - OpenAI masked edits are now enabled.
  - The PNG codec loads on the first masked request.
- **Local ComfyUI adapter: landed.** It is queue based and graph based, and its inputs are uploaded
  files. It exposed two assumptions that a hosted API hides:
  - a cancelled request keeps running unless it is removed from the queue;
  - an unseeded run cannot be reproduced unless the adapter records the seed it used.
- **Input resolution hardening: landed.** `nexus-ai-pro/images/inputs` covers:
  - SSRF protection, shared with the web connector rather than copied;
  - content sniffing that overrides declared and served MIME types;
  - byte and pixel limits, with the pixel limit checked from the header before any decode;
  - redirect revalidation.
- **Visual moderation: landed.** `nexus-ai-pro/images/moderation` screens both input and output. If
  moderation itself fails, the request is blocked.
- **Media evaluation: landed.** `nexus-ai-pro/images/evals` measures:
  - prompt alignment and OCR accuracy;
  - perceptual similarity for edit preservation;
  - safety confusion counts with false-positive and false-negative rates;
  - latency, cost, error, and failover;
  - repeated-run statistics with a 95% interval.

  Scores in an uncertainty band go to a human-review queue.
- **Modality cleanup: deferred to 2.0.** Splitting `inputModalities` from `outputModalities` is a
  breaking registry change, and it is listed in section 18.

- **Graph and agent correctness: all nine fixed.** Fixing number 5 also exposed a related defect
  that is now fixed: after a paused step resumed, the outgoing edges of siblings that had already
  finished were lost. A review of the 1.9.0 source found nine
  defects where the code contradicts documented behaviour. Each fix restores what the docs already
  promise, so none changes the public API:
  1. **No default checkpointer.** `compile()` never creates one, although the README and the
     `MemoryGraphCheckpointer` doc comment both say it does. Without one, `interrupt()` throws and
     `state()` returns nothing. Fix: default to a `MemoryGraphCheckpointer` capped at a number of
     threads, dropping the least recently used thread when full, so a service that never resumes
     does not grow without limit. `checkpointer: false` opts out.
  2. **Unnamed runs report no thread id.** `invoke()` without a `threadId` returns `threadId: ''`,
     even though it generated one, so the run cannot be inspected or resumed.
  3. **Subgraph interrupts are swallowed.** A subgraph that interrupts is treated as finished: the
     parent merges its partial state and moves on. Fix for 1.10.0: surface it as an interrupt of the
     parent. Full resume into the subgraph lands in 1.12.0.
  4. **Rewinding leaves stale checkpoints.** After `resumeFrom(step)`, `MemoryGraphCheckpointer`
     keeps checkpoints from the abandoned future, so `state()` can return a step from a timeline
     that no longer exists. Fix: drop the later steps on rewind. Forking lands in 1.12.0.
  5. **A failed node re-runs its siblings.** The failed checkpoint discards writes from siblings that
     already succeeded, so `continue()` runs them again. That breaks the guarantee in API_STABILITY
     that a node which finished is never re-run by a resume.
  6. **`context.report()` does nothing.**
  7. **`CompileOptions.name` is documented but never read.**
  8. **Malformed tool arguments run the tool.** `AgentLoop` turns invalid tool-call JSON into `{}`
     and executes the tool with empty arguments. Fix: send the parse error back to the model as the
     tool result, and never execute.
  9. **Silent iteration limit.** `AgentLoop` stops at `maxIterations` without saying so. Fix: the
     result gains a `stopReason`.

**Not yet promoted.** The adapters are verified against recorded wire shapes and the shared
conformance suite, which now includes a masked-edit case. None of it has run against the live
services. The experimental label comes off in a later release, after both of these:

1. The opt-in live conformance suite passes against OpenAI, Imagen, and a real ComfyUI server.
2. Media evals cover the supported capability matrix against those live backends.

---

## 10. How releases are planned from here

Every release closes at least one capability gap that a user can see, and ships proof that it is
closed: a benchmark, a runnable example, or a test that fails on the previous version. A release may
be large to get there. Three rules apply to every item below.

1. **Weight follows use.**
   - Every capability lands on its own subpath, with its size budget recorded in the same commit.
   - Nothing new enters the root import.
   - Infrastructure (Redis, Postgres, OpenTelemetry, MCP, a UI) is reached through injected client
     interfaces or optional peer dependencies, loaded only by the subpath that needs it.
   - A caller who does not use a feature pays nothing for it: no bytes, no allocations, and no
     per-call work.
2. **Defaults plus escape hatches.**
   - Each feature has a sensible default and a fully expressive option: overrides at compile time and
     per run, injectable adapters, and access to raw data.
   - Tests cover both the smallest configuration and the largest.
3. **Breaking changes wait for 2.0.0.**
   - Ship the change additively in 1.x wherever possible.
   - Anything that must break is marked `@deprecated` and noted in the changelog at least one minor
     release before 2.0.0.
   - Every breaking item is collected in section 18.

| Release | Theme | Gap it closes | Proof it ships |
| --- | --- | --- | --- |
| 1.10.0 | Image portability, graph correctness | Masks and three image backends; documented graph behaviour made true | Masked-edit conformance on three backends; regression tests for the nine defects |
| 1.11.0 | Parallel graphs | Parallel nodes, dynamic fan-out, per-node retries; dependency cost shown | Graph benchmark in CI; size table with a dependency column |
| 1.12.0 | Graph control and introspection | Control commands, state editing and forks, visualization, mature subgraphs | Mermaid diagram rendered in the README; fork-and-edit test |
| 1.13.0 | Memory, agents, MCP | Cross-thread memory, agents with durable approvals, MCP tools | Agent that survives a restart and remembers across threads |
| 1.14.0 | Queryable traces | Run trees across every family, feedback, alerts | `nexus traces` showing a full agent run tree |
| 1.15.0 | Evaluation platform | Datasets, experiments, comparisons, online eval, annotation queues | CI gate that fails a pull request on a measured regression |
| 1.16.0 | Prompt and config versioning | Versioned prompts with environments and gated promotion | Promotion blocked until an experiment passes |
| 1.17.0 | Self-hosted agent server | Deployment: runs, threads, background work, horizontal scale | Two replicas; a run survives killing the one that started it |
| 1.18.0 | Local studio | UIs for traces, threads, approvals, experiments, prompts | `npx` studio against the example application |
| 2.0.0 | Consolidation | One lifecycle, slim root, optional validators, stable surfaces | Migration guide and codemod; install-footprint targets met |

---

## 11. Shipped in 1.11.0 — parallel graphs

A fan-out that looks parallel will run in parallel. Four branches of three seconds each should finish
in about three seconds, not twelve.

**Concurrent supersteps.**
- All tasks in a superstep start together.
- `maxConcurrency` limits them. It can be set at compile time and overridden per run, defaults to 16,
  and `1` restores sequential execution exactly.
- Writes are reduced in task order, not completion order, so a replay produces the same state
  regardless of timing.
- A superstep with one task skips the scheduler entirely, so a linear graph pays nothing new.
- API_STABILITY already reserves scheduling order, so this is not a breaking change.

**Failure semantics.**
- Each task's successful write is checkpointed as a pending write before the step completes. A resume
  or `continue()` after a failure re-runs only the tasks that did not finish, which makes the
  "a finished node never re-runs" guarantee hold under concurrency.
- `onNodeError` chooses what happens to siblings when one task fails:
  - `fail-fast` (the default) aborts the siblings through their signals;
  - `settle` lets them finish first.

**Several interrupts in one step.**
- Parallel tasks may each ask a question. The checkpoint gains `interrupts: PendingInterrupt[]`, each
  with a stable id.
- `resumeInterrupts(threadId, { [id]: value })` answers any subset of them.
- `interrupt` and `resume()` keep working whenever there is exactly one question.

**Dynamic fan-out.**
- A router or a node can return `new Send(node, input)` or an array of them. That creates N tasks of
  the same node, each with its own input, which the node reads from `context.input`.
- Task ids are derived from step and index, so a resume never duplicates a task.
- Targets must be declared through `mapping` or a node's `ends`, which keeps validation and
  visualization honest.
- The checkpoint gains an additive `tasks` field; `next` stays as the list of node names.

**Retry and timeout policies.**
- `addNode(name, fn, { retry, timeoutMs })` takes a per-node policy, and `compile({ retry })` sets
  the default.
- The retry policy fields are `maxAttempts`, `initialIntervalMs`, `backoffFactor`, `maxIntervalMs`,
  `jitter`, and `retryOn`.
- By default, interrupts, aborts, validation errors, and non-retryable provider errors are never
  retried.
- `context.attempt` and the stream events report retries.
- `timeoutMs` aborts a signal scoped to that node.

**Honest install weight: landed, except the lazy validators.**
- `size:check` follows bare imports as well, and the README table now reports what each entry point
  makes a consumer install. The measurement confirmed the claim for most of the package: `/graph`,
  `/operations`, `/batch`, `/embeddings`, and every image subpath force no third-party install. The
  root import, `/core`, `/config`, and `/security` force 3.4 to 4.7 MB.
- The clean-install test measures and bounds the whole production install: 10.0 MB of `node_modules`,
  3.0 MB of which is this package.
- **Deferred to 2.0.0: loading the validators lazily.** `applyResponseFormat` and the schema helpers
  are synchronous exported functions, and an ESM module cannot load a dependency synchronously on
  first use, so deferring `ajv` and `zod` behind a dynamic import would mean making public functions
  async — a breaking change. Moving them to optional peer dependencies in 2.0.0 fixes the install
  cost properly, and section 18 already carries it.

**Budgets.** `/graph` measured 52 KB after the work, against the 40 KB this section first guessed;
the estimate was wrong, not the implementation, and the budget file records the real number. The root
import did not grow.

**Proof: landed.** `npm run bench:graph` runs as part of `check:release` and measured 1,253 ms
sequential against 310 ms parallel, a 4x speedup on four 300 ms branches. It fails the build if the
parallel run stops being meaningfully faster.

---

## 12. 1.12.0: graph control flow and introspection

**Commands.**
- A node can return `new Command({ update, goto, resume, graph })`, which updates state and chooses
  the next step in a single return. `goto` accepts node names or `Send`s.
- `graph: Command.PARENT` routes from inside a subgraph to its parent.
- Nodes declare `ends` so that reachability checks and diagrams stay exact.

**State editing and forks.**
- Checkpoints gain `id` and `parentId`.
- `updateState(threadId, update, { asNode, checkpointId })` writes a new checkpoint as if that node
  had produced the update.
- `resumeFrom(checkpointId)` forks rather than overwrites.
- `history()` follows the lineage of the current head, and `forks(threadId)` lists the branches.
- Both bundled checkpointers store the lineage.

**Visualization.**
- `nexus-ai-pro/graph/visualize` exports `toMermaid(graph, options)` and `toGraphJSON(graph)`.
- Options: expanded or collapsed subgraphs, conditional and `Send` edges, and highlighting a
  checkpoint's position.
- PNG output is available through an injected renderer. None is bundled, so the graph runtime pays
  nothing for diagrams.

**Streaming modes.**
- `stream(input, { modes, subgraphs })` supports these modes, several at once:
  - `values`, full state after each step;
  - `updates`, per-task writes;
  - `tasks`, start, retry, and finish;
  - `checkpoints`;
  - `custom`, events a node emits through `context.emit()`;
  - `messages`, model tokens from inside nodes.
- Events are typed per mode.

**Mature subgraphs.**
- Each subgraph checkpoints under a namespace derived from its parent thread and task.
- Interrupts propagate up to the parent, and the parent's resume continues inside the subgraph.
- `state(threadId, { subgraphs: true })` includes nested state.

**Breakpoints, schemas, caching, and deferred nodes.**
- `interruptBefore` and `interruptAfter` pause a run at chosen nodes for debugging, set per compile or
  per run.
- `createGraph({ channels, input, output })` restricts what a caller may pass in and what comes back.
  Private channels stay internal.
- Per-node caching: `cache: { key, ttlMs, store }` through the existing cache adapters, imported as
  types only.
- `defer: true` holds a node until every other pending task has finished, so an aggregator waits for
  branches of different lengths.

**Budgets.** `/graph` at most 48 KB; `/graph/visualize` at most 6 KB.

**Proof.**
- The README graph section includes a live Mermaid diagram, which GitHub renders.
- A test forks a thread at step 2, edits the state, finishes both timelines, and reads both histories.

---

## 13. 1.13.0: long-term memory, agents on graphs, and MCP

**Store** (`nexus-ai-pro/store`).
- Operations: `put(namespace, key, value, { ttlMs, index })`, `get`, `delete`,
  `search(namespacePrefix, { query, filter, limit, offset })`, and `listNamespaces`.
- Semantic search is opt-in through an injected embedding function, so the store never imports the
  embeddings runtime.
- Adapters: `MemoryStore`, `/store/redis`, and `/store/postgres` (with pgvector when available). All
  use injected client-like interfaces, as the Redis operation store does.
- Tenant scoping, TTL sweeping, and a namespace authorization hook.
- `compile({ store })` exposes the store to nodes as `context.store`, which is how memory crosses
  threads.

**Agents on graphs** (`nexus-ai-pro/agent`, via `createAgent`).
- `createAgent` returns a compiled graph, so an agent inherits durability, streaming, forks, and
  retries without code of its own.
- Options: model, tools, `systemPrompt`, `responseFormat` for a typed final answer, `maxIterations`
  with a stop reason, per-run budget, checkpointer, and store.
- Tool calls run in parallel, limited by `toolConcurrency`.
- `interruptOn` gives each tool a human-approval policy: approve, edit, or reject. It is a graph
  interrupt, so an approval can arrive days later on another machine.
- Middleware hooks: `beforeModel`, `afterModel`, `wrapModelCall`, `wrapToolCall`, `beforeAgent`, and
  `afterAgent`.
- Bundled middleware, each on its own subpath: summarization through the context manager, PII
  redaction through the security module, tool-call limits, model fallback, and retries.
- Multi-agent helpers: an agent can be used as a tool, and a `handoff()` command transfers control.
- `AgentLoop` stays as the small path and gains parallel tool execution and `stopReason`.

**MCP** (`nexus-ai-pro/mcp`).
- A client over stdio and streamable HTTP maps MCP tools, resources, and prompts into tools and
  agents.
- A server exposes Nexus tools and compiled graphs to MCP clients.
- The protocol SDK is an optional peer dependency, loaded only by these subpaths.
- This is how the project reaches a broad tool ecosystem without maintaining its own integration
  catalogue.

**Budgets.** `/store` at most 8 KB. The two store adapters at most 10 KB each. `/agent` at most 20 KB
on top of `/graph`. `/mcp` at most 25 KB. `AgentLoop`'s entry point must not grow.

**Proof.** A runnable example shows three things:
- an agent that remembers a preference from an earlier thread through the store;
- a pause for approval before a side-effecting tool, where the process is killed and the approval
  resumes the run from Redis;
- tools called from a local MCP server.

---

## 14. 1.14.0: queryable traces

**Run model.**
- A run has an id, a trace id, and a parent, plus kind, inputs, outputs, error, timing, tokens, cost,
  tags, metadata, events, and feedback.
- Kinds cover every family: model, tool, graph, node, retriever, embedding, image, voice, realtime,
  and operation.
- This closes gap 2.1 for tracing. Realtime sessions and graphs finally report, alongside the
  families that already do.

**Instrumentation** (`nexus-ai-pro/tracing`).
- Families are instrumented automatically through the existing `FamilyTelemetry`.
- `traceable(fn, options)` wraps application code.
- Context propagates through `AsyncLocalStorage`, which is created only when tracing is configured,
  so untraced applications pay nothing.

**Storage and export.**
- `MemoryTraceStore`.
- `JsonlTraceStore`, with file rotation.
- `/tracing/postgres`, through a client interface.
- The existing OpenTelemetry exporter.
- Export uses a batching queue with backpressure and an explicit drop policy.

**Privacy and cost control.**
- Per-field input and output redaction, with PII detection loaded lazily.
- Head sampling, plus tail sampling that keeps every error, every slow run, and every run above a
  cost threshold.
- Retention by age and size.

**Querying and feedback.**
- `query()` filters by status, latency, cost, model, tags, metadata, and time.
- `getTree(traceId)` returns a run tree, and `compare(a, b)` gives a structural diff of two traces.
- `recordFeedback(runId, { key, score, value, comment, source })` attaches feedback.

**Alerts** (`/tracing/alerts`).
- Rules over error rate, latency percentiles, and cost per window, grouped by model, route, or tenant.
- Notifications through webhooks.
- The repository gains Grafana dashboards and Prometheus alert rules. They live in the repository
  only and are not shipped in the package.

**Also in scope.** Circuit-breaker state through a distributed adapter, closing the per-process
caveat in gap 2.4.

**Budgets.** `/tracing` at most 12 KB. Adding tracing must not grow any other entry point's static
import cost.

**Proof.** `nexus traces tail` and `nexus traces show <id>` print the run tree of an agent, with
graph nodes, tool calls, model calls, tokens, and cost. A test shows tail sampling keeping every error
at a 1% head rate.

---

## 15. 1.15.0: evaluation platform

**One evaluation entry point** (`nexus-ai-pro/evaluate`).
- `evaluate(target, dataset, evaluators, { concurrency, repetitions, experiment, metadata })` accepts
  any target: a completion, an agent, a graph, an image operation, or plain code.
- `EvalRunner` and `MediaEvalRunner` keep their APIs and are rebuilt on top of it.

**Datasets.**
- Versioned examples with inputs, reference outputs, metadata, and splits.
- `DatasetStore` adapters: memory, JSONL files, and Postgres.
- Versions can be pinned by tag.
- Datasets can be built from traces: "add this production run to the regression set."

**Evaluators.**
- Code evaluators, the existing LLM judge, and pairwise comparison.
- Summary evaluators over a whole experiment.
- Trajectory evaluators for agents and graphs: expected tool sequence and node path.
- Similarity through an injected embedder, plus the existing metric library.

**Experiments and comparisons.**
- Results are stored with repetition statistics, reusing the media evaluation stats.
- `compareExperiments(baseline, candidate)` reports per-example differences, with paired bootstrap
  confidence intervals and a regression verdict.
- Backtesting replays stored production traces against a new version.
- `nexus eval run`, `nexus eval compare`, and `nexus eval gate --fail-on-regression` give CI a real
  quality gate.

**Online evaluation.**
- Sampling rules select traces from the trace store.
- Evaluators run asynchronously through the operation runner, with leases and retries.
- Scores return as trace feedback, and alert rules can watch them.

**Annotation queues.**
- A generic `AnnotationQueue` extends the image review queue into rubrics, reviewer leases through
  the operation store, and consensus. Reviewed items feed back into datasets.

**Record and replay.**
- Provider responses are recorded once and replayed in tests, so conformance and evaluations run
  without credentials.
- This is backlog item 10, and it gives image promotion a repeatable gate. The image family leaves
  experimental in the first release after the live conformance suite passes against every hosted
  backend.

**Budgets.** `/evaluate` at most 25 KB. Stores and the CLI stay on their own subpaths.

**Proof.** An example pull request changes a prompt, and `nexus eval gate` fails it with a
per-example diff and a confidence interval. An online evaluator scores sampled traces in a running
example.

---

## 16. 1.16.0: prompt and configuration versioning

**Templates.** Message templates with typed variables, partials, and a model configuration bundled
with each version.

**Registry** (`nexus-ai-pro/prompts`).
- Content-addressed versions, tags, and environments such as development, staging, and production.
- History, diffs, and rollback.
- Promotion can require a named experiment to pass first.
- Webhooks fire on promotion.
- Storage adapters: memory, files, Redis, and Postgres.

**Serving.**
- A client cache with a TTL and stale-while-revalidate.
- If the registry is unreachable, the last known version for an environment keeps serving.
- A/B serving with sticky assignment. Every trace records the prompt version it used.

**Headless playground.** Run a prompt version against dataset examples; the output is a stored
experiment.

**Budgets.** `/prompts` at most 12 KB. The storage adapters sit on their own subpaths.

**Proof.** A promotion from staging to production is refused until its experiment passes. A trace
names the prompt version it ran. A simulated registry outage keeps serving the cached version.

---

## 17. 1.17.0 and 1.18.0: self-hosted server and local studio

### 1.17.0: agent server (`nexus-ai-pro/server`, experimental)

**API.**
- REST and server-sent events for assistants, threads, runs, and cron jobs, over Node `http`.
- Adapters for Express, Fastify, and NestJS.

**Runs.**
- Background runs execute through the operation runner, so leases, heartbeats, crash recovery, and
  idempotency come from infrastructure that already exists.
- Horizontal scaling through Redis.
- When a new message arrives while a run is still going, the behaviour is configurable: `reject`,
  `enqueue`, `interrupt`, or `rollback`.

**Streaming.** Resumable with `Last-Event-ID`.

**Integration.**
- Authentication and tenancy through hooks.
- Webhooks on completion.
- A `RemoteGraph` client, so a deployed graph can be used as a subgraph.

**Deployment.** Docker and Compose templates in the repository.

**Proof.** A Compose example runs two replicas with Redis. A run keeps going after the replica that
started it is killed, and a reconnecting client resumes its event stream.

### 1.18.0: local studio (separate package)

**Packaging.** A separate npm package, so the core install never carries a UI. Its name is still to
be decided.

**Views.**
- Traces, with trees and diffs.
- Threads, with a live diagram, state, forks, edit, and resume.
- An approvals inbox covering interrupts and annotation queues.
- Datasets and experiment comparisons.
- Prompts and the playground.
- Costs and budgets.
- Provider health and circuit states.
- The operation queue and assets.

**Architecture.** It reads the stores above through their adapters, requires no hosted service, and
protects local access with a token.

**Proof.** `npx <studio-package>` against the example application shows a traced agent run, an
approval waiting in the inbox, and an experiment comparison.

---

## 18. 2.0.0: consolidation

2.0.0 ships once 1.11.0 through 1.18.0 are released, each experimental surface has had at least one
minor release to settle, and every removal below has been deprecated in a 1.x release.

**Breaking changes.**
- **One lifecycle for every operation:**
  `validate → authorize → input policy → resolve assets → route → reserve budget → execute →`
  `output policy → persist → reconcile cost → audit`
  - Completions, streams, embeddings, voice, realtime, telephony, images, jobs, graphs, and agents
    share authorization, budgets, hooks, audit, metrics, tracing, and finalization, including cache
    hits.
  - Every family gets a shared `ProviderCallContext` carrying the abort signal, deadline, request id,
    trace context, and idempotency key.
- `PipelineContext` becomes generic over request and response, and `PipelineStepName` loses its
  `| string` escape.
- The deprecated `estimatedCost` string is removed in favour of the numeric `cost` object.
- The registry splits `inputModalities` from `outputModalities`, ending the overlap between
  `vision`, `image`, and `pdf`.
- True mixed text-and-asset outputs, so a tool result can pass asset references instead of base64
  JSON.
- **A slim root import.** The root exports the core client, config builders, types, and errors, and
  every family is reached through its subpath. Target: at most 250 KB, down from 674 KB.
- **Optional validators and types.**
  - `zod`, `ajv`, and `ajv-formats` become optional peer dependencies, needed only when a caller
    passes a schema.
  - `@types/node` becomes an optional peer.
  - Target: a graph-only consumer installs at most 3.5 MB, down from about 10 MB.
- **Checkpoint schema v2.**
  - Task and checkpoint ids become required.
  - `interrupt` gives way to `interrupts`.
  - `migrateCheckpoint()` reads v1, and both checkpointers keep reading v1 for the whole 2.x line.
- Deprecated aliases are removed, including `ImageManagerConfig`. The full list is audited when the
  2.0 branch opens.

**Promotions to stable.** Advanced graph APIs, the store, agents, tracing, evaluation, prompts, and
the server. Images too, if live conformance has passed.

**Migration.**
- `MIGRATING.md` covers every breaking item, with before-and-after code.
- `nexus migrate` rewrites import paths.
- The last 1.x minor release logs each deprecated call once per process.

**Runtime.** Node 22 reaches end of life in April 2027. If 2.0.0 ships after that, the engine floor
moves to Node 24.

---

## 19. Longer-term backlog

**Absorbed by the releases above.** MCP adapters, human approval checkpoints, prompt and workflow
versioning, record and replay fixtures, and the local control plane.

**Remaining:**
1. Video generation through the same asynchronous operation, job, and asset contracts.
2. Realtime follow-ons: a second provider, SIP and video transports, durable session recovery,
   browser compatibility automation, and a published method for latency and load benchmarks.
3. Telephony follow-ons: a second provider (Vonage, Telnyx, or SIP-native), outbound SMS and
   messaging as an operation family, call recording with a retention policy, and conference and
   transfer control.
4. OCR, captioning, visual question answering, image embeddings, and media search and RAG.
5. Policy-as-code presets versioned independently from the runtime.
6. Multi-tenant credential-vault adapters and routing by provider residency.
7. Browser and edge builds: Node filesystem, crypto, DNS, and stream dependencies isolated behind
   adapters, so that compatibility is explicit.
8. Streaming reads and writes for the filesystem and S3 asset stores.
9. Vector store adapters for retrieval (pgvector, Qdrant) through injected client interfaces.

**Deliberately not planned.**
- A hosted service. Deployment stays self-hosted through the server and templates.
- A large third-party integration catalogue. MCP covers breadth instead.
- A second language runtime.

---

## 20. Design notes carried forward

These decisions predate this revision and still hold.

**Media stays a separate operation family.** Text completions and generated assets have different
request shapes, response lifecycles, costs, safety checks, storage needs, and retry semantics. Image
generation is `ai.images.generate()`, not another `complete()` mode.

**Aliases, not model names, are the durable API.** `auto` and family aliases resolve through
versioned, verified entries so a model name never becomes part of the public contract.

**Portable media types.** Prefer `Uint8Array`, `Blob`, URLs, and web streams in public types; keep
Node `Buffer` as a convenience input. Use discriminated asset locations — `{ kind: 'bytes' }`,
`{ kind: 'url' }`, `{ kind: 'stored' }` — rather than several optional fields. Keep dimensions, MIME
type, checksum, storage location, and provenance on each asset; keep latency, cost, route, and usage
in result-level `OperationMeta`.

**Explicit editing semantics.** `input`, `mask`, and `references` are separate fields with defined
mask polarity, sizing, and resize rules, so an adapter cannot silently reinterpret a request.

**Idempotency is not caching.** An idempotency key replays the same accepted operation. Generative
caching stays opt-in and keys on model version, policy version, parameters, and source-asset hashes.

**Budget is reserved and reconciled**, using provider-appropriate pricing — per-token, per-image,
per-megapixel, or compute time.

**The reference API shape:**

```ts
const result = await ai.images.generate({
  model: 'auto',
  prompt: 'A clean product photograph of a red mechanical keyboard',
  aspectRatio: '16:9',
  quality: 'high',
  delivery: { kind: 'bytes', format: 'png' },
});

await ai.images.edit({
  model: 'auto',
  prompt: 'Replace the background with a softly lit studio wall',
  input: result.assets[0],
  mask: {
    location: { kind: 'bytes', data: maskBytes },
    mimeType: 'image/png',
    polarity: 'white-is-editable',
  },
  references: [styleReference],
});
```

---

## 21. How an item graduates

1. Provider-neutral types and a deterministic mock land first.
2. One real adapter proves the contract; conformance fixtures cover it.
3. A second adapter on a different wire protocol proves portability.
4. Packed-package, clean-install, and consumer type-resolution tests pass on every supported Node
   line.
5. Evaluation appropriate to the modality covers the supported capability matrix.
6. Only then does the surface leave experimental status in
   [API_STABILITY.md](./API_STABILITY.md).
