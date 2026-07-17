# Security Policy

## Supported versions

Security fixes are provided for the latest published minor release. Users should upgrade to the newest `0.9.x` patch as fixes become available.

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/mkhitar-abrahamyan/nexus-ai/security/advisories/new). Do not open a public issue for an undisclosed vulnerability and do not include real credentials, personal data, or exploit targets in a report.

Include the affected version, impact, a minimal reproduction, and any suggested mitigation. You can expect an acknowledgement within five business days. A confirmed issue will be coordinated privately until a fix and disclosure plan are ready.

## Scope and safe operation

Nexus guardrails reduce common AI application risks, but they are not a complete authorization or security boundary. Applications remain responsible for access control, provider-side safety controls, tool authorization, network egress policy, secret storage, and review of high-impact model actions.

## Realtime voice security

- Never ship a permanent provider API key to a browser or mobile client. For WebRTC, configure a
  same-origin `sessionEndpoint` that performs provider negotiation or returns a short-lived client
  secret. For WebSocket API-key authentication, run the transport on a trusted server and inject a
  WebSocket factory that can set authorization headers.
- Authenticate and authorize the session endpoint before contacting the provider. Restrict origins,
  apply CSRF and rate-limit controls, cap request size and duration, and derive the model, tools,
  instructions, retention, and safety settings from trusted server policy rather than client input.
- Treat microphone permission, remote audio, provider data-channel events, transcripts, and raw events
  as sensitive data. Request microphone access only after a user action, stop owned tracks on cleanup,
  minimize retention, and avoid putting transcripts or audio in logs and telemetry by default.
- Use `security.maxSessionDurationMs`, `security.maxAudioDurationMs`, `security.toolAllowlist`,
  `security.retainTranscripts`, `security.piiHook`, and bounded raw-event retention as defense-in-depth.
  These process-local controls do not replace tenant quotas, durable retention enforcement, or a DLP
  system.
- A realtime tool confirmation is a user-experience checkpoint, not authorization. Every read and write
  tool must enforce tenant access and validate arguments server-side. Writes should require explicit
  confirmation, use the supplied idempotency key, and remain safe under retries and duplicate provider
  events.
- Redact API keys, ephemeral tokens, SDP diagnostics, tool arguments/results, and PII from errors and
  telemetry. Realtime telemetry transcript fields are redacted by default; set
  `telemetry.includeTranscripts: true` only when the destination and retention policy are explicitly
  approved. `piiHook` applies to normalized events and conversation state, not retained raw events.
- Reconnects can repeat provider events or tool requests and do not guarantee restoration of remote
  conversation state. Keep write tools idempotent, deduplicate by call ID/idempotency key, and surface
  recovery failures to the user.
- Browser WebRTC still requires a backend security boundary. A direct media path reduces latency; it
  does not remove the need for server-owned credentials, session policy, tool authorization, abuse
  monitoring, and provider-side safety controls.
