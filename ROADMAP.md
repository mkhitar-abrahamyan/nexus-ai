# nexus-ai-pro Roadmap

This roadmap is a design proposal, not a compatibility promise. Stable and experimental
surfaces are defined in [API_STABILITY.md](./API_STABILITY.md).

Status baseline: **1.5.0**. 59 export subpaths, 12 completion providers, 5 embedding providers, 99
completion registry models plus 63 aliases, and 11 embedding models plus 5 aliases. 234 unit tests
pass; coverage sits at **85.7% lines / 70.9% branches / 80.8% functions** against gates of
82/67/73. CI verifies lint, format, build, tests, coverage, mock conformance, packed-package smoke,
API contract, consumer type resolution, and clean install on Node 22 and 24.

---

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

### 1.9 Operations, evaluation, and packaging

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

### 2.1 Media families still do not get the platform

Narrowed in 1.5.0: `EmbeddingManager` shares the runtime's rate limiter, audit log, and metrics
collector, and `RateLimiter` now buckets on a structural request rather than a `CompletionRequest`,
so a family no longer has to be a completion to be governed. `ImageManager`, `VoiceManager`,
`TelephonyManager`, and `RealtimeSession` still emit nothing to `MetricsCollector` and pass through
no rate limit or audit stage, so an application running phone agents and image generation has
observability for only part of its spend.

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

### 2.4 Durable-execution primitives are process-local

`RateLimiter` is an in-memory token bucket with no distributed adapter. There is no circuit breaker
(health monitoring exists, but nothing opens a circuit). `OperationHandle` is process-bound;
`MemoryAssetStore` is process-local. Realtime conversation snapshots and exports live in memory.
Cross-process recovery, distributed deduplication, and provider-state replay remain application
responsibilities.

### 2.5 Image family blockers

OpenAI masks are deliberately rejected ([src/images/openai.ts:176](src/images/openai.ts#L176)) until
a transformer can verify dimensions and convert neutral mask polarity into provider alpha semantics.
The adapter also rejects `aspectRatio`, `negativePrompt`, `seed`, `background`, and `references` for
generation. Only one hosted provider exists, so the provider-neutral contract has never been tested
against a second wire protocol. There is no filesystem or S3-compatible asset store, no durable
operation state machine, and no media evaluation. None of these can be waived before promotion.

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

## 5. Next release: 1.6.0 — durable operations and batch economics

The theme is work that outlives a process.

- **Operation state machine.** `queued → running → succeeded | failed | cancelling | cancelled | expired`,
  with leases, heartbeats, progress events, delayed retry, dead-letter handling, timestamps, signed
  webhooks, and trace propagation. Applies to images first, then to any long-running family.
- **Durable operation adapters.** Redis and BullMQ-backed handles so `submit()` survives a restart.
  Queue asset references only; never JSON-serialize binary media into job payloads.
- **Provider batch APIs.** OpenAI Batch and Anthropic Message Batches behind the same operation
  handle, exposing the discounted asynchronous tier that local `runBatch()` concurrency cannot reach.
  Idempotency keys replay an accepted operation; ambiguous timeouts must not produce duplicate
  charges.
- **Distributed rate limiting and circuit breaking.** Redis-backed limiter adapter, plus a breaker
  that consumes existing `ProviderHealthMonitor` signals and trips routing away from a failing
  provider.
- **Filesystem and S3-compatible asset stores** implementing the existing `AssetStore` interface,
  with retention, tenant ownership, checksums, streaming, and signing. Provider URLs remain temporary
  delivery locations, never durable storage.
- **Generated model registry** from versioned provider data, consuming the 1.4.0 provenance fields.
- **Cross-family observability.** Route image, voice, telephony, and realtime operations through the
  rate limiter, audit log, and metrics collector, closing gap 2.1 without waiting for the full
  lifecycle refactor.

---

## 6. 1.7.0 — image portability, then promotion

Images cannot leave experimental until the neutral contract survives a second wire protocol.

- **Second hosted image provider** (Google Gemini image or a comparable API) exercising masks, seeds,
  negative prompts, polling, formats, and quality controls that OpenAI currently refuses.
- **Mask support.** An `AssetTransformer` seam that verifies dimensions and converts neutral polarity
  into provider alpha semantics, unblocking [src/images/openai.ts:176](src/images/openai.ts#L176).
- **Local ComfyUI adapter** to validate the contract against a self-hosted, graph-based backend and
  to expose assumptions a hosted API hides.
- **Input resolution hardening.** SSRF protection, MIME sniffing, byte/pixel limits,
  decompression-bomb protection, and a redirect policy for remote inputs.
- **Visual moderation** on both input and output; text-only checks are insufficient for media.
- **Media evaluation.** Prompt/image semantic alignment, OCR accuracy for generated text, perceptual
  similarity for edit preservation, safety pass rate with false-positive tracking, latency/cost/retry/
  failover metrics, repeated-run statistical baselines for stochastic output, and human-review queues.
  A `MediaEvalRunner` or a generic evaluation target — string-only golden-file tests are not an
  image-quality gate.
- **Modality cleanup.** Split model capabilities into `inputModalities` and `outputModalities` and
  retire the semantic overlap between `vision`, `image`, and `pdf`. This is a breaking registry change
  and may need to wait for 2.0.

Promotion criterion: packed-package tests, provider conformance across two hosted providers plus
ComfyUI, and media evals covering the supported capability matrix. Only then does the experimental
label come off.

---

## 7. 2.0 candidate — one lifecycle for every operation

Create an internal typed lifecycle and adapt every family to it:

`validate → authorize → input policy → resolve assets → route → reserve budget → execute →`
`output policy → persist → reconcile cost → audit`

Completions, streams, embeddings, voice, realtime, telephony, images, and jobs share the same
authorization, budget, hooks, audit, metrics, and finalization stages, including cache hits.
Transport-specific code only performs the provider call and normalizes the result. Every provider
family gets a shared internal `ProviderCallContext` carrying abort signal, deadline, request ID,
trace context, and idempotency key — generalizing the one images already has.

Also in the 2.0 window, because each requires a breaking change:

- retype `PipelineContext` generically over request/response instead of hard-coding
  `CompletionRequest`/`NexusResponse`, and remove the `| string` escape from `PipelineStepName`;
- remove the deprecated `estimatedCost` string in favor of the numeric `cost` object;
- land the `inputModalities`/`outputModalities` registry split if it has not shipped;
- true mixed text/asset outputs, so tool results can pass asset references without base64 JSON.

---

## 8. Longer-term backlog

1. MCP client and server adapters with asset and tool interoperability.
2. Video generation through the same asynchronous operation, job, and asset contracts.
3. Realtime follow-ons: a second provider, SIP and video transports, durable session recovery,
   browser compatibility automation, and published latency/load benchmark methodology.
4. Telephony follow-ons: a second provider (Vonage, Telnyx, or SIP-native), outbound SMS and
   messaging as an operation family, call recording with retention policy, and conference/transfer
   control.
5. OCR, captioning, visual question answering, image embeddings, and media search/RAG.
6. Human approval checkpoints for high-impact tools and generated-media publication.
7. Policy-as-code presets versioned independently from the runtime.
8. Prompt and workflow versioning with offline replay and A/B evaluation.
9. Multi-tenant credential-vault adapters and per-provider residency routing.
10. Record/replay provider fixtures so most conformance tests run without credentials, plus capability
    drift detection.
11. An optional local control plane for approvals, traces, evals, costs, provider health, assets,
    retention, and queued operations.
12. Smaller install surface: keep a provider-neutral core and move heavy or environment-specific
    integrations (OpenTelemetry, BullMQ, image transforms, provider adapters) into optional exports or
    a scoped package family, isolating Node filesystem, crypto, DNS, and stream dependencies behind
    adapters so browser and edge compatibility is explicit.

---

## 9. Design notes carried forward

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

## 10. How an item graduates

1. Provider-neutral types and a deterministic mock land first.
2. One real adapter proves the contract; conformance fixtures cover it.
3. A second adapter on a different wire protocol proves portability.
4. Packed-package, clean-install, and consumer type-resolution tests pass on every supported Node
   line.
5. Evaluation appropriate to the modality covers the supported capability matrix.
6. Only then does the surface leave experimental status in
   [API_STABILITY.md](./API_STABILITY.md).
