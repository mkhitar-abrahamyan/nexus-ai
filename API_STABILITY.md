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

Breaker state is per process by design. Two workers can disagree about a provider, and neither the
breaker nor its snapshot promises cluster-wide consensus. Rate-limit counters are the opposite: they
are only shared when a store is configured, and the default in-memory counter gives each worker its
own budget.

## Deprecation process

Deprecated APIs are marked with `@deprecated` in declarations and described in the changelog. Removals
are reserved for major releases, except when an urgent security issue requires otherwise.

Report accidental compatibility regressions through the project issue tracker. Security issues should follow [SECURITY.md](./SECURITY.md).
