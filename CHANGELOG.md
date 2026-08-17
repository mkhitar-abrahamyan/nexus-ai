# Changelog

Notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use semantic versioning.

## [Unreleased]

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

[Unreleased]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/releases/tag/v1.0.0
[0.9.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/releases/tag/v0.9.0
