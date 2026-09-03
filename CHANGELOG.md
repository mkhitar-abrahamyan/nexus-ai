# Changelog

Notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use semantic versioning.

## [Unreleased]

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

[Unreleased]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/releases/tag/v1.0.0
[0.9.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/releases/tag/v0.9.0
