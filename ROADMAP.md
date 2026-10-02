# nexus-ai-pro Roadmap

This roadmap is a design proposal, not a compatibility promise. Stable and experimental
surfaces are defined in [API_STABILITY.md](./API_STABILITY.md).

Status baseline: **1.18.0**. 99 export subpaths, each
held to a size budget in CI, 12 completion providers, 5 embedding providers, 2 batch providers, 3
image providers plus a mock, 101 completion registry models plus 63 aliases, and 11 embedding models
plus 5 aliases. 643 unit tests pass; coverage sits at **92.1% lines / 77.6% branches / 87.2%
functions** against gates of 82/67/73. CI verifies lint, format, build, tests, coverage, registry
drift, per-subpath size, documentation and guide coverage, a graph benchmark, mock conformance, packed-package smoke, API contract,
consumer type resolution, and clean install on Node 22 and 24.

---

## How we measure progress

Two axes, weighed together: **capability** and **install weight**. A capability that only works by
importing the whole runtime fails the second test however well it does on the first, so install
weight is a constraint on every new feature rather than a feature of its own.

Measured from the current build, an entry point costs a fraction of the root import: `/agent` 11%,
`/graph` 9%, `/operations` 7%, `/evaluate` 5%, `/tracing` 4%, `/mcp` 2%, `/store` 1%,
`/cache/memory-cache` 0.5%, `/streaming` 0.2%. Dependencies are counted as well as bytes: 95 of the
99 entry points import no third-party package at all, and the four that do — the root, `/config`,
`/core`, and `/security` — are the ones that reach the schema validators. Every new capability gets its own export subpath and stays out of the
root, and `npm run size:check` fails the build when any entry point grows past its budget or picks up
a dependency it did not have.

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

### 1.15 Memory, agents, MCP, and traces

Delivered in 1.14.0. `nexus-ai-pro/store` gives cross-thread long-term memory with namespaces, TTL,
and optional vector search, so what an agent learns in one conversation is available in the next.
`nexus-ai-pro/agent` builds an agent as a compiled graph, which is what makes durable approvals,
checkpoints, and time travel apply to agents without a second runtime beside the first.
`nexus-ai-pro/mcp` speaks the protocol in both directions over a JSON-RPC subset written here, so
breadth of integration costs no dependency. `nexus-ai-pro/tracing` records run trees with feedback,
cost roll-ups, tail sampling, and alert rules, which is the queryable model the OpenTelemetry
exporter never provided.

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
visible, and the catalogue has since moved out of the TypeScript source into versioned JSON under
`data/models`, compiled by `npm run registry:generate` and checked for drift in CI. The data itself
is still written by hand: 101 models and 63 aliases across nine provider files, with provenance
recorded beside them. Fetching from versioned provider sources remains outstanding, and the Claude 5
reasoning bug 1.4.0 fixed is the kind of error that fetching would have prevented.

### 2.4 Durable execution is only half distributed

Closed in 1.6.0 for operations: `OperationHandle` is no longer process-bound, cross-process recovery
works through lapsed leases, and idempotency keys deduplicate across workers.

Closed further since: the rate limiter takes a `RateLimitStore` with a Redis adapter beside the
in-memory default, and `CircuitBreaker` opens on measured failure instead of only reporting health.

Still process-local: circuit state, so one worker's open circuit is invisible to the rest — the first
thing section 16 fixes. `MemoryAssetStore` holds assets in one process, and realtime conversation
snapshots and exports live in memory. Provider-state replay remains an application responsibility.
One caveat on what did land: `RedisOperationStore` is atomic only when the client exposes `eval`;
without it the compare-and-set degrades to a read-compare-write that narrows but does not close the
race.

### 2.5 Image family blockers

Closed in 1.10.0:

- masks, on all three backends;
- a second hosted wire protocol, Imagen;
- a self-hosted backend, ComfyUI;
- input hardening, visual moderation, and media evaluation.

Filesystem and S3 asset stores and the durable operation state machine shipped in 1.7.0 and 1.6.0.

What still blocks promotion is verification, not code. Every adapter has been tested against recorded
wire shapes, but none has passed live conformance, and a suite that only runs where credentials exist
does not run often enough to gate a promotion. Record and replay in section 16 is what gives it a
home in CI, and promotion is decided there rather than postponed again. OpenAI generation still
refuses `aspectRatio`, `negativePrompt`, `seed`, and `references`. The upstream API does not accept
them, so a portable application should route those requests to Imagen or ComfyUI.

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
`embeddings/providers.ts` from 37% to 99%. Everything added since lands high — the store, agents,
MCP, tracing, and evaluation sit between 88% and 100% lines — and `ops/rate-limiter.ts` and
`ops/circuit-breaker.ts` are now at 100%. What is still thin, measured on the current build:

| Area | Lines | Note |
| --- | --- | --- |
| `hallucination/rag.ts`, `verification.ts` | 38% / 61% | Grounding claims deserve tests. |
| `rag/file-ingestion.ts`, `ingestion.ts` | 43% / 55% | |
| `ops/otel-tracing.ts` | 44% | The exporter; the run trees beside it are covered. |
| `optimizer/densifier.ts`, `budget.ts` | 46% / 49% | |
| `jobs/queue.ts`, `batch.ts` | 47% / 53% | |
| `security/pii-detector.ts`, `semantic-injection-classifier.ts` | 49% / 49% | Security-relevant. |
| `workflow/chains.ts`, `domain.ts` | 51% / 50% | |
| `providers/{mistral,groq,openrouter,azure-openai}.ts` | 48–60% | Request shaping is covered; error and stream paths are not. |

Provider conformance runs against fixtures but has no record/replay corpus, so most real provider
behavior is only verified when credentials are present. Section 16 closes that.

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
  breaking registry change, and it is listed in section 26.

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
   - Every breaking item is collected in section 26.

| Release | Theme | Gap it closes | Proof it ships |
| --- | --- | --- | --- |
| 1.10.0 | Image portability, graph correctness | Masks and three image backends; documented graph behaviour made true | Masked-edit conformance on three backends; regression tests for the nine defects |
| 1.11.0 | Parallel graphs | Parallel nodes, dynamic fan-out, per-node retries; dependency cost shown | Graph benchmark in CI; size table with a dependency column |
| 1.12.0 | Graph control and introspection | Control commands, state editing and forks, visualization, mature subgraphs | Mermaid diagram rendered in the README; fork-and-edit test |
| 1.14.0 | Memory, agents, MCP, traces | Cross-thread memory, agents with durable approvals, MCP tools, run trees with feedback and alerts | Agent that survives a restart, remembers across threads, and records its run tree |
| 1.15.0 | Evaluation | Datasets, experiments, comparisons with a verdict, online evaluation, annotation queues | A seeded change reported as `better` or `unchanged`, and the same verdict twice |
| 1.16.0 | Shared state, command line, promotion | Circuit state and stores shared across processes; evaluation and traces usable from a terminal; provider fixtures | A thread started on one worker finished by another; a gate that fails a pull request on a regression |
| 1.17.0 | Prompt and config versioning | Versioned prompts with environments and gated promotion | Promotion blocked until an experiment passes |
| 1.18.0 | Self-hosted agent server | Deployment: runs, threads, background work, horizontal scale | Two replicas; a run survives killing the one that started it |
| 1.19.0 | Local studio | UIs for traces, threads, approvals, experiments, prompts | `npx` studio against the example application |
| 1.20.0 | Retrieval stores, deprecation warnings | Vector search that scales past one process; deprecations visible at run time | One contract test passing on memory, pgvector, and Qdrant |
| 1.21.0 | Durable execution everywhere | Durable plain control flow; recovery at the step, not the run; SQLite; diagram images | A killed workflow and a killed server run each resume at the step that died |
| 1.22.0 | Retrieval and integration breadth | Loaders, more vector stores, hybrid and reranked retrieval, an MCP registry | Hybrid retrieval beats vector-only on a stored dataset |
| 1.23.0 | Team engineering platform | Shared studio with roles, a context hub, insights with proposed fixes, evaluation caching | A seeded regression found, clustered, and answered with an evaluated fix |
| 1.24.0 | Deployment at scale, self-managed | Revisions, canaries, autoscaling signals, Helm, tenant quotas | A canary rolled back on a regression; workers scaling on queue depth |
| 1.25.0 | The bridge to 2.0 | Every capability on its own subpath; everything 2.0 removes deprecated | A migrated consumer compiles; a codemod and a migration guide |
| 2.0.0 | Consolidation | One lifecycle, slim root, optional validators, stable surfaces | One authorize, audit, and budget across ten families; a migrated consumer compiles; a 5.3 MB install with no optional peer |

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
  cost properly, and section 26 already carries it.

**Budgets.** `/graph` measured 52 KB after the work, against the 40 KB this section first guessed;
the estimate was wrong, not the implementation, and the budget file records the real number. The root
import did not grow.

**Proof: landed.** `npm run bench:graph` runs as part of `check:release` and measured 1,253 ms
sequential against 310 ms parallel, a 4x speedup on four 300 ms branches. It fails the build if the
parallel run stops being meaningfully faster.

---

## 12. Shipped in 1.12.0 — graph control flow and introspection

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

**What landed, and what moved.** Commands, state editing, visualization, breakpoints, and deferred
nodes landed as described above. Three items changed shape:

- **Forks are separate threads.** `fork()` copies history into a new thread rather than storing
  branches inside one thread with checkpoint ids and parent pointers. Both timelines stay readable and
  runnable, which is what the item was for, without changing either checkpointer's storage format.
  Branches within one thread remain possible later if a use case needs them.
- **Streaming modes became one event callback.** `onEvent` delivers task, retry, checkpoint, and
  custom events, and `context.emit()` carries model tokens, so a caller filters by type instead of
  choosing modes. `stream()` still yields one event per superstep.
- **Input and output schemas and per-node caching moved to the next release**, alongside the store
  they would share infrastructure with. They did not land there either; they are now in section 16,
  which is where the rest of the twice-deferred work is scheduled.

**Budgets.** `/graph/visualize` imports no runtime code at all.

**Proof: landed.** The README graph section includes a Mermaid diagram that is `toMermaid()`'s actual
output, which GitHub renders. A test forks a thread, edits the fork's state, finishes it, and checks
that the original timeline is untouched.

---

## 13. Shipped in 1.14.0 — long-term memory, agents on graphs, and MCP

**Store** (`nexus-ai-pro/store`).
- Operations: `put(namespace, key, value, { ttlMs, index })`, `get`, `delete`,
  `search(namespacePrefix, { query, filter, limit, offset })`, and `listNamespaces`.
- Semantic search is opt-in through an injected embedding function, so the store never imports the
  embeddings runtime.
- Adapters: `MemoryStore` and `/store/redis`, both through injected client-like interfaces, as the
  Redis operation store does. The Postgres adapter, with pgvector when available, moved out of this
  release and is now in section 16 with the rest of that family.
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

**What landed, and what moved.** The store, the agent, and MCP in both directions landed as
described. Four adjustments:

- **The two graph items carried from 1.12.0 did not land.** `createGraph({ channels, input, output })`
  and per-node caching were listed in this release's plan and are not in the shipped API;
  `createGraph()` still takes `{ channels }` alone and `NodeOptions` has no `cache`. Recording that
  here rather than leaving the plan to read as a claim: both are in section 16.

- **Postgres is not in this release.** `MemoryStore` and `RedisStore` ship; a Postgres adapter with
  pgvector is worth doing against a real database rather than a mocked client, so it moves to 1.14.0
  with the trace store, which needs the same adapter.
- **Multi-agent helpers move to 1.14.0.** An agent is a compiled graph, so it already works as a
  subgraph node and can hand control back with `Command.PARENT`; named `handoff()` helpers are sugar
  on top, and are better designed once the tracing work shows what a multi-agent run looks like.
- **Bundled middleware is a seam, not a set.** `beforeModel`, `afterModel`, and `wrapToolCall` ship;
  the summarization and redaction middleware move to 1.14.0, where the context and security modules
  they wrap are already being touched.

**Budgets.** `/store` and `/mcp` import no third-party package; `/agent` costs the graph runtime plus
its own code. The size table records the measured figures.

**Proof: landed as tests rather than an example script.** The suite covers an agent that pauses for
approval and resumes with corrected arguments, a graph node reading memory written by an earlier
thread, and an MCP client calling tools through an MCP server — the two sides wired to each other in
memory, which exercises both halves of the protocol in one test.

---

## 14. Shipped in 1.14.0 — queryable traces

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
- The OpenTelemetry exporter that already existed, now fed by the run model rather than replacing
  it.
- Export uses a batching queue with backpressure and an explicit drop policy.
- A Postgres trace store moved out of this release; it is in section 16 with the other adapters.

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

**What landed, and what moved.** The run model, instrumentation, storage, privacy, querying,
comparison, feedback, and alerts landed. Four items moved, each for a reason:

- **The Postgres trace store and the Postgres store adapter moved on**, first to 1.15.0 and then,
  when evaluation filled that release, to 1.16.0. Both need the same client interface and both
  deserve to be written against a real database rather than a mocked client. They are now the first
  item of section 16 rather than a line at the end of someone else's release.
- **The `nexus traces` CLI moved on with them**, for the same reason: it shares argument parsing and
  output formatting with the evaluation commands, and those are built in section 16. `formatTree()`
  already prints a run tree, which is what the command would do.
- **Realtime sessions are still outside the traced path.** A persistent session's unit of work is an
  event stream rather than a discrete call, which is the same reason gap 2.1 has always excluded it;
  deciding what a realtime "run" is belongs with that work, not beside it.
- **A distributed circuit breaker moved on too**, and is in section 16 with the other shared-state
  adapters.

The release also carried the three items deferred from section 13: the bundled agent middleware
(`summarizeHistory`, `redactMessages`, `limitToolCalls`) and `agentAsTool()` for delegation.

**Budgets.** `/tracing` imports no third-party package, and no other entry point grew: nothing else
imports it.

**Proof: landed as tests.** One test traces an agent run end to end and asserts the shape of the
tree — the agent run, a node run per task, and each model call nested inside the node that made it,
carrying its tokens and cost. Another shows tail sampling keeping a failure at a 0% head rate, and a
third compares two traces of the same shape and reports the step whose output changed.

---

## 15. Shipped in 1.15.0 — evaluation

One entry point, `nexus-ai-pro/evaluate`, measured at 33 KB with no third-party import.

**One evaluation contract, whatever is being evaluated.**
- `evaluate(target, dataset, evaluators, options)` accepts any target: a completion, an agent, a
  graph, an image operation, or plain code.
- Examples run concurrently, with repetitions for a target that is not deterministic, a timeout per
  example, and per-metric statistics including a 95% interval.
- A target that throws is recorded as a failed example; an evaluator that throws is recorded as a
  failed measurement. Neither voids the experiment.

**Datasets.**
- Versioned by content: change an example and the version changes with it, so two experiments are
  comparable only when they really ran over the same data.
- Inputs, reference outputs, metadata, splits, and tags, with `splitOf()` for train and test splits.
- `MemoryDatasetStore`, and `FileDatasetStore`, which writes one reviewable JSON file per version.
- `datasetFromTraces()` turns recorded runs into examples, each keeping the run it came from, so
  yesterday's production failure becomes tomorrow's regression test.

**Evaluators.** `exactMatch`, `contains`, `mustNotMatch`, `completed`, `underLatency`,
`embeddingSimilarity` through any injected embedder, `pairwise` for side-by-side judgements, and
`trajectory`, which scores how an answer was reached rather than only what it said. `passRate` and
`totalCost` summarize a whole experiment. The existing LLM judge plugs in as one more evaluator.

**Comparisons that give a verdict.** `compareExperiments()` runs a seeded paired bootstrap over the
per-example differences and gives each metric a 95% interval; a metric whose interval spans zero is
reported as `unchanged` rather than as an improvement. The report names the examples that moved most,
the failures that are new, the ones that were fixed, and any dataset-version mismatch.
`formatComparison()` renders it for a pull-request comment or a CI log.

**Online evaluation and review.** `evaluateOnline()` samples traces, scores them, and writes the
scores back as feedback that an alert rule can watch. `AnnotationQueue` holds what people owe:
rubrics, per-reviewer claims that expire so a closed tab strands nothing, consensus when one opinion
is not enough, and `toExamples()`, which turns reviewed items back into dataset examples.

**Budgets.** `/evaluate` imports no third-party package. The size table records the measured figure.

**Proof: landed as tests, not as a CLI.** One test shows a clear improvement reported as `better`
with an interval that excludes zero, while a single example moving by 0.1 across twenty is reported
as `unchanged` — the distinction a quality gate exists to make. Another shows a regression caught
with the new failures named, and the same verdict produced twice from the same inputs. A third runs
online evaluation over recorded runs, writes feedback, and routes the uncertain one to a review
queue.

### What did not land, and where it went

- **The Postgres adapters, the command-line work, record and replay, and the distributed circuit
  breaker moved to 1.16.0.** They were carried into this release from 1.13.0 and 1.14.0 and deferred
  a second time; evaluation filled the release on its own. A thing deferred twice is a thing to
  schedule deliberately, so 1.16.0 is built around them rather than appending them to another theme.
- **A Postgres `DatasetStore` and `ExperimentStore`** belong to that adapter family and move with it.
  Memory and file stores cover everything that does not need a database.
- **`EvalRunner` and `MediaEvalRunner` are not yet rebuilt on `evaluate()`.** Both keep working
  unchanged. Rebuilding them is an internal change with no user-visible effect, so it waits rather
  than adding risk to a release that already introduces a new entry point.
- **Backtesting and a `--fail-on-regression` gate** need the command line and record/replay, and move
  with them. The same gate is available today as a few lines around `compareExperiments()`.

---

## 16. Shipped in 1.16.0 — shared state and the command line

Six items that had been deferred twice landed together: four shared-state and tooling items carried
from 1.13.0 and 1.14.0, and two graph items carried from 1.12.0.

**One Postgres adapter family.**
- One injected connection contract: anything with `query(text, values)` resolving to `{ rows }`, so
  `pg`, a pool, a serverless driver, or PGlite all work, and `fromPostgresJs()` adapts `postgres.js`.
  No driver becomes a dependency.
- Adapters for the operation store, the long-term store (with pgvector when dimensions are given),
  the trace store, the dataset and experiment stores, and shared circuit state, each on its own
  subpath.
- One migration per adapter, and `postgresMigration()` to combine them. Nothing creates a schema at
  import.
- Tested against real Postgres in-process, so the suite needs no server and never silently passes.

**Distributed circuit state.** `CircuitBreaker` takes a `store`, with `MemoryCircuitStateStore`,
`RedisCircuitStateStore`, and the Postgres adapter. A failure in one worker opens the circuit for the
rest, and a half-open probe is leased to one worker at a time. Without a store the breaker is the
per-process one it always was, and the coordination code is never loaded.

**The command line.** `nexus eval run`, `compare`, and `gate --fail-on-regression`; `nexus traces
list`, `show`, and `export`; and `nexus db sql` to print migrations. Shared argument parsing, `--json`
on every command, and exit code 2 for usage errors. No subpath imports the command line.

**Record and replay.** `nexus-ai-pro/testing/record` captures provider traffic once, with credential
headers and query parameters removed and a `redact` hook for the rest, writes one reviewable file per
exchange, and replays it with no network. An unrecorded request fails with `FixtureMissingError`
rather than reaching the live API.

**`EvalRunner` and `MediaEvalRunner` rebuilt on `evaluate()`,** loaded on first run, so neither entry
point grew. Their results and errors are unchanged.

**The two graph items.** `createGraph({ channels, input, output })` restricts what a caller passes in
and what comes back, in the types and at run time. Per-node caching, `cache: { key, ttlMs, store }`,
through the cache adapters, loaded only by graphs that cache.

**Documentation coverage.** Every public export and every public member now has a doc comment, 4,651
declarations across 88 entry points, and `npm run docs:check` holds it at 100%. The pass doubled as an
audit of what the configuration accepts: `routing.fallback` and a provider's `isLocal` were accepted
but ignored, and now work; five options that were never read are deprecated for removal in 2.0.

**Budgets.** No new entry point imports a third-party package. The Postgres adapters measure 3 to
11 KB against a 12 KB target. Comments are now stripped from the emitted JavaScript and kept in the
type declarations, so documenting every export cost nothing at run time, and the root import fell
from 612 to 572 KB. The declarations are where the documentation now lives, and they are shipped
twice, once per module format, so the unpacked package grew from 3.5 to 4.1 MB; sharing one set of
declarations between the two formats is on the 1.17.0 list.

**Proof.** A graph thread started on one worker is finished by another through Postgres. A provider
failure seen by one breaker opens the circuit for a second. `nexus eval gate` fails a seeded
regression and passes noise of the same size.

### What did not land, and where it went

- **Image promotion is still blocked.** The image conformance suite now runs from recordings, but
  there are no recordings yet: capturing them needs live credentials for each backend, and none were
  available for this release. The suite reports each backend without recordings instead of counting
  it as a pass, so the family stays experimental until the recordings are made. That is a one-off
  task, not a design question, and it is the first thing on the list for 1.17.0.

---

## 17. Shipped in 1.17.0 — prompt versioning, and a guide per feature

**Templates that type themselves.** `definePrompt()` reads a prompt's variables out of its template
text, so `render()` requires every variable without a default and a misspelling is a compile error
rather than a blank in production. Dot paths, partials, placeholders for whole messages, defaults, and
a request configuration versioned with the prompt; an unknown partial or a cycle fails when the prompt
is defined, not on its first render. Typing it needed no `const` type parameter, so the TypeScript
floor is unchanged.

**Versions derived from content.** `promptVersion()` hashes the definition over a canonical encoding,
so the same prompt has the same version in a test, in CI, and in production, and committing unchanged
content is a no-op. Hashing uses Web Crypto, so the value is the same in Node, a browser, and an edge
runtime.

**A registry with gates** (`nexus-ai-pro/prompts/registry`). Labels — `production`, `staging`, a tag —
point at versions. `promote()` moves one only after the gates registered for the destination agree:
`experimentGate()` requires a passing experiment for that exact version, with per-metric thresholds
and an optional no-regression comparison against the version it would replace, and `servedByGate()`
requires staging before production. Refusals are reported per gate and nothing moves; `force` records
which gates were overridden. `rollback()`, `split()` for sticky A/B tests, `diff()` with
`formatPromptDiff()`, and a full history. Label writes are compare-and-set, so two workers promoting
at once cannot both win, and changes can be posted to signed webhooks.

**The headless playground.** `evaluatePrompt()` runs a version over a dataset and stores an experiment
tagged with that version — the tag the gate looks for — so the loop from "try a wording" to "it is
allowed into production" closes without a bespoke script.

**Serving that survives the registry** (`nexus-ai-pro/prompts/client`). A label is read at most once
per TTL, answered from cache while it refreshes in the background, and when the registry is
unreachable the last version seen keeps serving; a process that starts during an outage serves the
prompts bundled in its code. A split label picks its arm by key, so a user sees one version.

**Stores.** Memory, files (one reviewable JSON file per version, for version control), Redis, and
Postgres, all tested against one contract, the Postgres one against real Postgres in process.

**Traces name the prompt.** A model call rendered from a version records its name, version, label, and
arm, so a trace answers which prompt produced an output.

**A guide for every feature.** 24 guides under `docs/`, each covering every export of its entry points
and ending with a reference generated from the doc comments. `npm run docs:guides` fails when an
export is not named or a reference is stale, and runs in `npm test`. The README is an overview that
links to them, down from 2,516 lines to about 230.

**Budgets.** `/prompts` is 10 KB against a 12 KB target; serving is 15 KB and the write side 34 KB, on
their own subpaths, so an application that only renders prompts loads the smallest of the three. No
new entry point imports a third-party package, and `/prompts` and `/prompts/client` compile and run
without Node's types.

**Proof.** A promotion is refused until an experiment for that exact version passes, and refused again
when it regresses against the version it would replace. A registry outage keeps serving the last
version, and a cold start during one serves the bundled fallback. Four stores pass one contract suite.

### What did not land, and where it went

- **One set of type declarations moved to 1.18.0.** Every approach breaks the constraint it was set
  under. Pointing the CommonJS `require` types at the ESM declarations makes them resolve as ESM for
  consumers on `node16` resolution; re-exporting across formats needs TypeScript 5.3's
  `resolution-mode`, which raises the floor for everyone. The package stays at about 4.2 MB unpacked.
- **Image recordings moved to 1.18.0**, again. The suite replays from fixtures and reports each backend
  that has none, but recording them needs live credentials for OpenAI, Google, and ComfyUI, which this
  release did not have. The image family stays experimental.

---

## 18. Shipped in 1.18.0 — the self-hosted agent server

`nexus-ai-pro/server`, experimental, with `nexus-ai-pro/server/remote` as its client.

**One handler, any runtime.** `createAgentServer()` answers a `Request` with a `Response`, so it runs
on Node's `http` through `toNodeListener()`, and as Express or Fastify middleware. Assistants are
structural: `graphAssistant()` serves a compiled graph and `functionAssistant()` a plain function, so
the entry point imports neither runtime.

**Runs are durable operations.** Leases, heartbeats, retries, idempotency, dead-lettering, and
webhooks come from the operations family rather than from anything new. A run outlives the request
that started it; a worker that dies leaves a record whose lease lapses, and another replica claims it.

**Resumable streaming.** Every event carries its id in the run's log, so a client that drops
reconnects with `Last-Event-ID` and receives exactly what it missed. `MemoryRunEventLog` covers one
replica and `RedisRunEventLog` lets a client reconnect to any of them.

**A busy thread is a decision, not a race.** `reject`, `enqueue`, `interrupt`, or `rollback`, set per
server or per run; `rollback` needs an assistant that can restore a thread, and one that cannot says
so rather than doing something else.

**Cron without coordination.** Every replica ticks and every firing carries the idempotency key
`<job>:<slot>`, so the operation store decides which replica wins. No lock, no leader election. The
five-field syntax is parsed in UTC.

**Integration.** Authentication and tenancy are hooks: a `Principal` carries a tenant, a user, and
scopes, and another tenant's resource is a `404` rather than a `403`. `createRemoteGraph()` calls a
deployed assistant, and `asNode()` makes it a node in a local graph.

**Deployment.** `deploy/Dockerfile`, a Compose file running two replicas behind Redis, an nginx
configuration that does not buffer event streams, and `examples/agent-server.ts`.

**Documentation.** Guides now hold their own family's exports rather than everything reachable only
from the root: the client guide fell from 249 exports to 141, grounding gained a guide, and the
agents, batch, caching, and client guides explain every export they cover.

**Proof.** Twenty tests, including: a stream that disconnects and resumes with no gaps and no repeats;
a run whose worker stops being finished by a second replica sharing the store; the four busy policies;
a cron slot that fires once across two replicas; and a remote graph driven over real HTTP, both
directly and as a node inside a local graph.

### What did not land, and where it went

- **One set of type declarations: closed, not carried.** Every route breaks the constraint it was set
  under. Pointing the CommonJS `require` types at the ESM declarations makes them resolve as ESM for
  consumers on `node16` resolution, and re-exporting across formats needs TypeScript 5.3's
  `resolution-mode`, which raises the floor for everyone. Dual declarations stay until 2.0, where the
  module layout is already being reworked and the floor can move with it.
- **Image recordings moved to 1.19.0.** The conformance suite replays from fixtures and names each
  backend that has none, but recording them needs live credentials for OpenAI, Google, and ComfyUI,
  which this release did not have. The image family stays experimental.

---

## 19. Shipped in 1.19.0 — the local studio

`nexus-ai-pro-studio`, experimental, a separate package with the `nexus-studio` command, so the
core install never carries a UI.

**Eight views over the application's own stores.** Traces with run trees, comparison, and feedback;
threads with a diagram, state at any step, fork, edit, and resume; an inbox of interrupts and review
items; experiments and datasets with comparisons; prompts with diffs, gated promotion, rollback, and
a playground; costs against budgets; provider health and circuit state; and the operation queue with
asset totals. A config module's default export lists the stores; every source is optional.

**Locked down for a local tool.** It binds `127.0.0.1`, takes a token that moves from the URL into an
HTTP-only same-site cookie, requires the token in a header for every change, refuses non-loopback
`Host` headers, and serves every page under a strict content security policy with every value
inserted as text.

**Proof.** The packaged install test runs `nexus-studio` from the packed tarballs against a config
with a traced agent run, an interrupted thread, and two experiments, and reads each back through the
studio.

**Also in this release.** The operation-store checkpointer lists its threads. Fixes found while
documenting: input secret detection now detects and blocks by default; PII `remove` removes;
`summarizeVerifyFormat()` verifies what it summarized; MCP error codes and handshakes; and traced
model runs record the model and provider that answered.

### What did not land, and where it went

- **Image recordings moved to 2.0.0.** Recording needs live OpenAI, Google, and ComfyUI credentials,
  which this release did not have. The image family stays experimental until they exist.
- **The studio's first npm publish is manual.** Trusted publishing can only be configured for a
  package that exists, so the release workflow skips the studio until its first version is published
  by hand.
- **The documentation prose pass is partial.** Operations, embeddings, evaluation, images, and
  realtime still describe some exports only in their generated reference.

---

## 20. Shipped in 1.20.0 — retrieval stores and deprecation warnings

**Retrieval that scales past one process.** A shared `VectorStore` contract — upsert by id, search by
text or vector, delete, and a metadata filter — with pgvector (`nexus-ai-pro/postgres/vectors`) and
Qdrant (`nexus-ai-pro/rag/qdrant`) adapters beside the in-memory store. Neither adds a dependency: the
Postgres adapter takes the client contract the family already uses, and the Qdrant adapter speaks
REST through `fetch`.

**Deprecations visible at run time.** Every deprecated option warns once per process through the
platform's deprecation channel, which 2.0 requires before it removes them.

**Documentation.** Every guide explains every export it lists, enforced by the guide check.

**Proof.** One contract test passes unchanged on the memory store, on pgvector with and without an
HNSW index (PGlite), and on Qdrant's REST API.

### What did not land, and where it went

- **Qdrant is tested against a stand-in for its REST API**, not a live server; a run against a real
  Qdrant joins the opt-in live conformance suite in 1.22.0, with the other vector stores.
- **Image recordings** still need live credentials, and remain the condition for the image family
  leaving experimental.

---

## 21. Shipped in 1.21.0 — durable execution everywhere

**Functional workflows.** `workflow()` on `nexus-ai-pro/graph/functional` makes an ordinary async
function durable: each `step()` result is checkpointed, so a workflow that is resumed, continued, or
recovered on another worker returns finished steps from its checkpoint and carries on from the first
that did not finish. Steps run in parallel through `Promise.all`, bounded by `maxConcurrency`, with
per-step retries and timeouts; `interrupt()` works as in a graph node; and the checkpoints are graph
checkpoints, so every checkpointer, `traceGraph()`, and `graphAssistant()` work with them unchanged.

**Step-level recovery in the server.** A run whose worker dies continues from the last checkpoint that
run wrote, for graph and workflow assistants, so only the step in flight runs again.
`AssistantRunContext.attempt` and the optional `ServerAssistant.recover()` hook carry it.

**SQLite persistence.** `SqliteOperationStore` and `SqliteStore` on `nexus-ai-pro/sqlite`, over the
database you open — `node:sqlite`, `better-sqlite3`, or libSQL — with no driver as a dependency.
Graph and workflow checkpoints go through `OperationStoreCheckpointer` on the operation store.

**Diagrams as images.** `toSvg()` on `nexus-ai-pro/graph/visualize` draws a graph as a standalone SVG
with no dependency; the layered layout moved from the studio into the core, so both draw the same one.

**Proof.** A workflow stopped between two steps finishes on a second worker without re-running the
first, on the memory, SQLite, Postgres (PGlite), and Redis checkpointers; a server run killed mid-run
resumes at the step it died on, for a graph and a workflow alike.

### What did not land, and where it went

- **No dedicated SQLite checkpointer class.** Checkpoints use `OperationStoreCheckpointer` over
  `SqliteOperationStore`, as they do over Redis and Postgres, which covers the need with one fewer
  contract.
- **Redis is proven against a stand-in client**, not a live server; a live run joins the opt-in live
  conformance suite in 1.22.0.
- **Functional workflows and the SQLite adapters are experimental**, and leave that stage once they
  have seen production use.

---

## 22. Shipped in 1.22.0 — retrieval and integration breadth

**Document loaders.** `nexus-ai-pro/loaders/*`, one entry point per format: text files and
directories, Markdown with front matter, HTML, CSV, JSON and JSON Lines, PDF through a parser you
inject, web pages and sitemaps through the SSRF-safe fetch, and Git repositories through the `git`
executable. Each streams `DocumentSource` values, and `loadIntoStore()` splits them into chunks and
adds them to one or more stores in batches — a vector store and a keyword index in one pass.

**More vector stores**, behind the `VectorStore` contract and its contract test, which now also
checks that a filter matches a value's type: Redis with RediSearch, Pinecone, Weaviate, and Chroma,
each through REST or an injected client, and SQLite, ranked in JavaScript or by sqlite-vec.

**Better retrieval.** `nexus-ai-pro/rag/retrievers`: BM25 keyword search, hybrid search fused by
reciprocal rank, reranking through any scorer or a chat model, maximal marginal relevance,
parent-document retrieval, and multi-query retrieval, all composable over any store; `recallAtK()`
and `reciprocalRank()` measure them.

**Integration breadth through MCP.** `McpRegistry` on `nexus-ai-pro/mcp/registry`: many servers from
one configuration file — including the one desktop MCP clients use — with per-server allow and deny
lists, credentials from the environment by placeholder, health checks, and tool bundles an agent
receives by name.

**Proof.** A fixed corpus loaded through the Markdown, CSV, and HTML loaders into the memory, SQLite,
and Redis stores; on each, hybrid retrieval with reranking finds every question's page first where
vector-only misses most, and `compareExperiments()` over a dataset stored on disk calls it better.

### What did not land, and where it went

- **The new stores are proven against stand-ins for their APIs**, not live servers. The opt-in live
  suite (`npm run test:vectors:live`) runs the same contract against real Qdrant, Pinecone, Weaviate,
  Chroma, and Redis when their variables are set; running it against each is the condition for the
  retrieval family leaving experimental.
- **Keyword search is in memory.** A database's own full-text search plugs in as a `Retriever`; a
  bundled Postgres full-text retriever is a candidate for a later release.
- **Pinecone indexes are not created by the store**, which is a control-plane operation.

---

## 23. Shipped in 1.23.0 — the team engineering platform

**A shared studio.** Accounts through an authenticator — personal links, identity headers from a
signing-in proxy, or bearer tokens verified by an injected function such as OIDC — with four roles
(viewer, reviewer, editor, admin), an audit log of every change and every refused attempt, comments on
runs, review items, proposals, threads, and bundles, per-person page tokens for changes, and `Secure`
cookies behind HTTPS. Local, token-only use stays the default; binding beyond loopback without
accounts warns.

**A context hub.** `nexus-ai-pro/context-hub`: prompts, instructions, tool sets, skills, and settings
versioned together as bundles, committed by content, labelled, promoted through evaluation gates,
diffed, rolled back, and exported with their prompts. Bundles live in any prompt store, so files,
Redis, and Postgres all serve them.

**Insights.** `nexus-ai-pro/insights`: failing and slow runs clustered by error, trajectory, or
meaning; regressions between time windows; and, opt-in, a proposed fix evaluated against the dataset
before it waits in the studio's inbox for a person, with an optional pull request through an injected
client.

**Evaluation caching.** `evaluate()` reuses a target's outputs when the example and the target's
fingerprint are unchanged; `evaluatePrompt()` and `evaluateContext()` fingerprint the version
themselves.

**Proof.** Two people with different roles share one studio over HTTP; a seeded rise in failures is
detected, clustered, and answered with a proposed fix that is evaluated, commented on by the reviewer,
refused to them, and promoted by the admin through the production gate, with every step audited.

**Documentation.** Every guide was rewritten for readability: purpose and an example first, options
in tables, and short sentences, with every export still explained.

### What did not land, and where it went

- **The studio runs no sign-in flow of its own.** People in a browser sign in through a proxy in
  front of it, or with a personal link; bearer tokens serve scripts.
- **Proposed fixes rewrite prompts and bundle instructions**, not tools or code. A fix that needs a
  code change goes through the optional pull request.
- **The new studio views are covered by API tests**, not browser tests.

---

## 24. Shipped in 1.24.0 — deployment at scale, self-managed

**Revisions.** `nexus-ai-pro/server/deployments`: several revisions of an assistant ship in one image,
and the traffic split between them lives in the server's state store. `canary()`, `split()`,
`promote()`, and `rollback()` change it, each kept in a history with who and why and guarded by an
expected version. New threads are split by a stable hash, a thread keeps its revision while that
revision takes traffic, and every run records its revision, share, reason, and deployment version.

**A canary guard.** `watchCanaries()` compares each canary with the live revision over the same window,
with the insights' statistics (`compareRuns()`), rolls back a regression, and moves one that holds up
through its steps to promotion.

**Scaling signals.** A worker queue in the server: a per-replica cap, API-only replicas, takeover of
lapsed runs, and `drain()`, which hands runs still going to another worker without using a retry.
`GET /scaling` and `GET /metrics` report queued and running runs, their load, the oldest wait, lapsed
leases, replica capacity, and run counts and latency per revision. `deploy/kubernetes` and
`deploy/helm` run an API tier and a worker pool that KEDA, or an HPA, scales on the load.

**Tenancy at the server.** `nexus-ai-pro/server/tenancy`: per-tenant active runs, runs per window, and
spending per period, in memory or shared through Redis, answered with `429` and `Retry-After`.

**A deployments view.** The studio shows traffic splits and their history, each revision's runs since
the last change, replicas, the queue, and tenant usage, and admins canary, promote, and roll back.
`nexus deploy` does the same from a pipeline.

**Proof.** A canary takes a tenth of 1,000 runs, each recording its revision; a canary seeded to fail is
rolled back by the guard with the regression as the reason; and a load test in which an autoscaler reads
`/scaling` grows the worker pool from one to at least four and back, with no run lost or run twice. The
deployment template runs against the packed package in the clean-install test.

**Documentation.** A deployments guide, and the last nine guides rewritten for readability.

### What did not land, and where it went

- **Tenant usage has no Postgres store.** Memory and Redis are included; any shared store can implement
  the five-method `TenantUsageStore`.
- **The Redis operation store reads every record to find queued work.** Postgres and SQLite do it in one
  indexed query, which is the recommendation for large queues.
- **The manifests and chart are not run on a live cluster in CI.** They are rendered and checked against
  the server, and the autoscaling proof is an in-process autoscaler reading `/scaling`.
- **A revision's code ships in every replica's image.** There are no per-revision replica pools; roll
  out an image before giving its new revision traffic.
- **Deployment changes are last-writer-wins** unless the caller passes `expectedVersion`, which the
  guard, the studio, and `nexus deploy --version` do.

---

## 25. Shipped in 1.25.0 — the bridge to 2.0

**A subpath for every capability.** What could only be imported from the root has an entry point of
its own, each without a third-party dependency: `grounding`, `connectors`, `ops`, `pipeline`,
`router`, `testing`, `next`, `rag/files`, and `optimizer/cost`. Grounding alone is 15 KB, where it used
to mean the 584 KB root and its validators.

**The root import, deprecated down to the core.** 499 root exports are marked deprecated with the
subpath to use; the 2.0 root keeps the core client, its config builders, its types, and the errors it
throws. `scripts/root-migration.mjs` generates the marks and the codemod's map from the export map and
checks them in CI.

**`nexus migrate`.** A codemod for TypeScript, JavaScript, and Markdown code blocks that moves imports,
keeps local names for exports that moved under another name, and lists what it cannot rewrite safely.
`MIGRATING.md` ships in the package.

**The 2.0 shapes, readable now.** `inputModalities` and `outputModalities` beside the old list, read
through `modalitiesOf()` and usable as routing requirements; and the 2.0 checkpoint schema through
`migrateCheckpoint()`.

**Proof.** The type consumer migrates its own code with the codemod and compiles against the packed
package, and all 499 mapped names resolve where the map points. An editor marks a moved root import
deprecated and nothing else, and every guide's examples already use the 2.0 imports.

### What did not land, and where it went

- **Root imports are flagged by editors, not at run time.** A re-export has no hook to warn from, so
  the type declarations and `nexus migrate --check` carry the deprecation; deprecated options still
  warn once per process.
- **The built-in registry does not declare the directional modalities yet.** `modalitiesOf()` derives
  them; 2.0 writes them into the registry and requires them.
- **Checkpointers still write the 1.x schema**, by design until 2.0, which writes version 2 and keeps
  reading version 1.
- **The codemod works on text.** Comments inside an import list it splits are not kept, and an import
  statement inside a string is rewritten too.
- **One lifecycle, `ProviderCallContext`, typed pipeline contexts, and mixed outputs** are 2.0 design
  work, listed in section 26.

---

## 26. Shipped in 2.0.0 — consolidation

**One lifecycle for every operation.** Completions, streams, embeddings, voice, telephony, images,
realtime sessions, graphs, agents, queued jobs, and provider batches pass through the same stages,
from validation to audit. They share one `authorize` callback, one spend budget, hooks, audit, and
metrics, cache hits included. Every provider call gets a `ProviderCallContext` with the request id,
the abort signal, the deadline, trace headers, and the idempotency key.

**A shared budget.** `budgetLedger()` on `nexus-ai-pro/lifecycle` holds a call's estimate before it
runs and charges what it cost after. It keeps totals per tenant and per period, in memory or in any
tenant usage store, Redis included.

**A slim root, and no required dependencies.** The root exports the core client and costs 323 KB,
down from 572 KB. Provider adapters and engines load on first use. `zod`, `ajv`, `ajv-formats`, and
`@types/node` are optional peers.

**The 2.0 shapes.** The registry says which way each modality flows. Checkpoints are schema version 2,
and version 1 is still read. Pipeline step names are a closed list, with typed contexts. A tool can
return text and asset references, and a model that makes images returns them on `response.assets`.
Everything 1.x deprecated is removed.

**What the redesign fixed.** Tool calls reach the OpenAI, Anthropic, and Google adapters whole.
Responses are priced on the model they were routed to. Streams honour the circuit breaker, the
budget, audit, and metrics.

**A current model registry.** Every provider was re-checked on 2026-10-02. New models are in, models
their providers shut down are out, and so are four names no provider served. Announced shutdowns are
marked deprecated. Claude 4.6 onward get adaptive thinking and an effort level, which they require.
`nexus migrate` reports each dropped model name with its replacement.

**`llms.txt` and `llms-full.txt`.** An index of the guides for AI assistants, and the guides in one
file, both generated from the documentation and checked in CI.

**Promotions to stable.** Graphs with their advanced APIs and functional workflows, the store,
agents, tracing, evaluation, prompts, and the agent server.

**Proof.** In `tests/lifecycle.test.ts`, one authorize, audit, and hooks setup covers ten families, a
refused call never reaches a provider, and concurrent calls cannot overshoot a budget together. A
version 1 thread resumes on both checkpointers. A clean install with no optional peer is 5.3 MB, and
the type consumer migrates its own code with the codemod and compiles against the packed package.

**Runtime.** 2.0.0 shipped before Node 22's end of life in April 2027, so the engine floor stays at
Node 22.

### What did not land, and where it went

- **The root is 323 KB, not the 250 KB target.** The client itself carries routing, the registry data,
  default guardrails, the context window, and the synchronous parts of voice, telephony, and images.
- **A graph-only install is 5.3 MB, not 3.5 MB.** It installs no third-party package, but the package
  ships two builds, each with fully documented declarations. Shipping the declarations once, or one
  build, is a major release of its own.
- **Images stay experimental**, until recorded live conformance passes on all three backends. So do
  deployments, tenant limits, the worker queue, the context hub, insights, the studio's accounts, the
  loaders, the newer vector stores, the retrievers, the MCP registry, and SQLite.
- **`plan()` is not an operation.** The agent server admits runs through tenancy rather than the
  client lifecycle, and pipeline hooks stay completion-only.
- **Mixed content is partial.** Only Google maps the images a model makes to `response.assets`.
  Stored assets reach chat providers as references, and OpenAI chat puts tool images in a following
  user message. Cohere, Ollama, and Google ignore idempotency keys and trace headers.
- **The codemod finds removed options and model names by name**, so it reports them for a person to
  check rather than rewriting them.
- **Some registry data is not verified:** the effort levels of GPT-5 through 5.5, the knowledge
  cutoffs of Gemini 3.x, Mistral's output limits, and whether Claude takes structured outputs.

---

## 27. Longer-term backlog

**Absorbed by the releases above.** MCP adapters, human approval checkpoints, long-term memory, an
evaluation platform, prompt and workflow versioning, record and replay fixtures, and the local
control plane.

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

**Deliberately not planned.**
- A hosted service. Deployment stays self-hosted through the server and templates.
- A large third-party integration catalogue. MCP covers breadth instead.
- A second language runtime.

---

## 28. Design notes carried forward

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

## 29. How an item graduates

1. Provider-neutral types and a deterministic mock land first.
2. One real adapter proves the contract; conformance fixtures cover it.
3. A second adapter on a different wire protocol proves portability.
4. Packed-package, clean-install, and consumer type-resolution tests pass on every supported Node
   line.
5. Evaluation appropriate to the modality covers the supported capability matrix.
6. Only then does the surface leave experimental status in
   [API_STABILITY.md](./API_STABILITY.md).
