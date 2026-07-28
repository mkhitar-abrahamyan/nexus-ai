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

The package is ESM-only and supports Node.js 22 or newer. CommonJS `require()` and deep imports into `dist` or `src` are not supported.

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

## Deprecation process

Deprecated APIs are marked with `@deprecated` in declarations and described in the changelog. Removals
are reserved for major releases, except when an urgent security issue requires otherwise.

Report accidental compatibility regressions through the project issue tracker. Security issues should follow [SECURITY.md](./SECURITY.md).
