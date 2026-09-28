# Realtime voice agents

<!-- covers: ./realtime ./realtime/session ./realtime/tools ./realtime/conversation ./realtime/openai-webrtc ./realtime/openai-websocket ./realtime/openai-server ./realtime/mock -->

Realtime voice agents from `nexus-ai-pro/realtime`: a session over WebRTC in the browser or WebSocket on a server, with barge-in, tools that can require confirmation, reconnection, metrics, and conversation exports. The browser entry points use no Node API.

## Realtime Voice Agents

Realtime is opt-in and is not re-exported from the package root or from `nexus-ai-pro/voice`:

```ts
import {
  createRealtimeAgent,
  defineTool,
  OpenAIRealtimeProvider,
} from 'nexus-ai-pro/realtime';
```

The framework-independent session normalizes connection, speech, transcript, response, tool,
interruption, error, conversation, and metrics events while retaining provider events when configured.
The browser and server transports use structural platform interfaces, so the realtime core does not
require React, a DOM shim, or an OpenAI SDK.

### Browser WebRTC

Give the browser a same-origin `sessionEndpoint`; never put a permanent provider API key in browser
code. The endpoint receives the SDP offer and returns the SDP answer while your server owns the
provider key and authoritative session configuration.

```ts
type BookingInput = { startTime: string; endTime: string; timezone: string };

const createBooking = defineTool({
  name: 'create_calendar_booking',
  description: 'Create a calendar booking after the user confirms it.',
  parameters: {
    type: 'object',
    properties: {
      startTime: { type: 'string', format: 'date-time' },
      endTime: { type: 'string', format: 'date-time' },
      timezone: { type: 'string' },
    },
    required: ['startTime', 'endTime', 'timezone'],
    additionalProperties: false,
  },
  requiresConfirmation: true,
  execute: async (input: BookingInput, context) =>
    calendar.create(input, { idempotencyKey: context.idempotencyKey, signal: context.signal }),
});

const provider = new OpenAIRealtimeProvider({
  sessionEndpoint: '/api/realtime/session',
});

const agent = createRealtimeAgent({
  provider,
  model: 'gpt-realtime',
  modalities: ['audio', 'text'],
  instructions: 'Check availability before booking. Never write without confirmation.',
  tools: [createBooking],
  voice: {
    transport: 'webrtc',
    voice: 'alloy',
    turnDetection: { type: 'server_vad', silenceDurationMs: 450 },
    interruption: {
      enabled: true,
      cancelResponse: true,
      truncateUnheardAudio: true,
    },
  },
  toolExecution: { mode: 'automatic', timeoutMs: 8_000, maxParallelCalls: 3 },
  reconnect: { enabled: true, maxAttempts: 3, initialDelayMs: 500 },
  conversation: { captureTranscripts: true, captureToolCalls: true, maxRawEvents: 2_000 },
  security: {
    maxSessionDurationMs: 30 * 60_000,
    maxAudioDurationMs: 20 * 60_000,
    toolAllowlist: ['create_calendar_booking'],
  },
  telemetry: {
    includeTranscripts: false,
    estimateCost: (usage) => pricing.estimateRealtime(usage),
  },
});

agent.on('tool.confirmation.required', ({ call }) => {
  const approved = window.confirm(`Create booking requested by ${call.name}?`);
  agent.confirmTool(call.callId, approved);
});

agent.on('metrics', (metrics) => {
  console.log('speech end -> first audio', metrics.speechEndToFirstAudioMs);
});

const audioElement = document.querySelector<HTMLAudioElement>('#assistant-audio')!;
await agent.connect({ microphone: true, audioElement });
```

WebRTC attaches the selected microphone track directly to the peer connection and assigns the remote
media stream to `audioElement`. Browsers still require HTTPS (or localhost), user permission, and often
a user gesture before audio playback. `sendAudio()` is intended for transports that accept binary
chunks; normal WebRTC microphone use should stay on the media track.

WebRTC first-audio timing uses the provider's `output_audio_buffer.started` event. WebSocket playback
remains application-owned, so its player must call `markAudioPlayed()` as described below.

A minimal server endpoint can use the focused server helper:

```ts
import { createOpenAIRealtimeCall } from 'nexus-ai-pro/realtime/openai-server';

export async function POST(request: Request) {
  const answerSdp = await createOpenAIRealtimeCall(await request.text(), {
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'gpt-realtime',
    session: {
      instructions: 'You are a concise scheduling assistant.',
      max_output_tokens: 1_024,
    },
  }, request.signal);

  return new Response(answerSdp, { headers: { 'content-type': 'application/sdp' } });
}
```

Authenticate that endpoint, authorize the tenant and requested tools, apply origin/CSRF and rate-limit
controls, and keep its accepted session options allowlisted. The client must not choose arbitrary tools,
instructions, limits, or credentials.

### Server WebSocket

Server-to-server agents can inject their WebSocket implementation and keep provider authorization in
request headers. The package deliberately does not force a WebSocket dependency:

```ts
import {
  OpenAIWebSocketTransport,
  type OpenAIWebSocketFactory,
} from 'nexus-ai-pro/realtime/openai-websocket';
import { createRealtimeSession } from 'nexus-ai-pro/realtime/session';

const webSocketFactory: OpenAIWebSocketFactory = (url, { headers, protocols }) =>
  serverWebSocketClient.connect(url, { headers, protocols });

const session = createRealtimeSession({
  provider: 'openai',
  model: 'gpt-realtime',
  transport: new OpenAIWebSocketTransport({
    apiKey: process.env.OPENAI_API_KEY!,
    webSocketFactory,
  }),
  modalities: ['audio', 'text'],
  reconnect: { enabled: true, maxAttempts: 3 },
  connection: {
    remoteAudioSink: (audio) => audioPlayer.enqueue(audio.data),
  },
});

await session.connect();
```

When an application plays WebSocket audio itself, call `session.markAudioPlayed()` when the first bytes
actually reach playback. That makes the primary latency metric—user speech ended to first assistant
audio played—represent user experience rather than network receipt.

The global browser WebSocket path accepts only an ephemeral token. Supplying a permanent API key to a
browser adapter is rejected; use an injected server factory or an ephemeral-token provider instead.

### Interruption, tools, state, and exports

With interruption enabled, a `speech.started` event can stop local playback, cancel the active response,
and, for WebSocket playback with a known position, truncate unheard assistant audio. Applications can
also call `session.interrupt('manual')`.

Realtime tools support structural `parse`, `safeParse`, or `validate` schemas, execution timeouts,
bounded parallelism, safe-tool retries, duplicate call suppression, idempotency keys, allowlists, and
write confirmation. A tool marked `safe: true` can also opt into cross-call caching with `cache: true`
or `{ ttlMs, key }` when `toolExecution.cache` supplies a structural cache adapter; cache failures are
ignored unless `cacheFailureMode: 'fail'` is configured. `requiresConfirmation` does not replace server
authorization: re-check identity, permissions, business invariants, and idempotency in the tool
implementation.

Session state is available as immutable snapshots and four export formats:

```ts
const json = session.export('json');
const providerEvents = session.export('openai-events');
const transcript = session.export('text');
const analytics = session.export('analytics');

session.on('conversation.updated', (snapshot) => conversationStore.save(snapshot));
session.on('error', (error) => telemetry.recordException(error));
```

`json` contains normalized user/assistant speech, text messages, tool calls/results, interruptions,
errors, and latency/usage metrics. `openai-events` returns retained raw provider events; it is useful for
diagnostics and replay but follows the upstream provider schema. Disable transcript/raw-event retention
for sensitive workloads. `piiHook` redacts normalized conversation/event text, but deliberately does not
rewrite raw provider exports. Telemetry transcript fields are redacted by default; `includeTranscripts`
must be explicitly enabled. `estimateCost` accepts an application-owned pricing callback so model price
changes are not hard-coded into the package. The built-in limits and telemetry hooks are local controls,
not a durable session store, distributed rate limiter, or authorization system.

Focused public imports are available for `realtime`, `realtime/session`, `realtime/tools`,
`realtime/conversation`, `realtime/openai-webrtc`, `realtime/openai-websocket`,
`realtime/openai-server`, and `realtime/mock`. The deterministic mock is suitable for tests and demos;
see [`examples/realtime-scheduling.ts`](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/examples/realtime-scheduling.ts).

## Sessions in detail

`createRealtimeSession()` builds a `RealtimeSession` from a `RealtimeSessionConfig`: an id, the
`provider` name (a `RealtimeProviderName`, `openai` by default), the `model`, the `transport`, the
`modalities` (each a `RealtimeModality`, `audio` or `text`), `instructions`, `tools` with a
`toolChoice` and `toolExecution`, `interruption`, `reconnect`, `audio`, `conversation`, `telemetry`,
`security`, browser `connection` options, metadata, `providerSession` fields passed through as they
are, a `signal` that ends the session, a `clock`, and an `idFactory`.

- `RealtimeAudioOptions` sets the input — its `RealtimeAudioFormat` (an encoding and a sample rate),
  a transcription model, and `RealtimeTurnDetectionOptions`: `server_vad` by silence, `semantic_vad`
  by meaning with an eagerness, or `null` to leave turn-taking to you — and the output format and
  voice.
- `RealtimeInterruptionOptions` decides what barge-in does: `enabled`, `cancelResponse`,
  `truncateUnheardAudio`, a `stopPlayback` hook for your speaker, and `getPlaybackPositionMs`, where
  truncation cuts.
- `RealtimeReconnectOptions` sets `maxAttempts` and a backoff from `initialDelayMs` by `multiplier` up
  to `maxDelayMs`.
- `RealtimeSecurityOptions` sets `maxSessionDurationMs` and `maxAudioDurationMs`, both fatal when
  reached, a `toolAllowlist`, `retainTranscripts`, and a `piiHook` that rewrites every transcript
  before anything sees it.
- `RealtimeConversationOptions` sets what the record keeps: transcripts, tool calls, raw events and
  how many (10,000), and a `redactTranscript` hook.
- `RealtimeTelemetryOptions` connects a `RealtimeTracerLike` — spans through `RealtimeSpanLike` — and a
  `RealtimeMeterLike` whose instruments are `RealtimeMetricInstrumentLike` values, so OpenTelemetry
  plugs in without a dependency; it also takes `includeTranscripts`, an `estimateCost` callback that
  receives `RealtimeTokenUsage` (provider, model, token counts, and the raw payload), attributes, and
  `onEvent` and `onMetrics` callbacks.
- `RealtimeConnectOptions` is what `connect()` takes in a browser: a signal, the microphone (`true`
  or `getUserMedia` constraints), an `audioElement` — anything shaped like a `RealtimeAudioElementLike`
  — or a `remoteAudioSink` for your own playback.

A session moves through `RealtimeSessionState`: `idle`, `connecting`, `connected`, `reconnecting`,
`disconnecting`, `disconnected`, and `failed`. Beyond `connect()` and `disconnect()`, it has
`sendText()`, `sendAudio()`, `commitAudio()`, `clearAudio()`, `createResponse()`, `updateSession()`,
`sendEvent()` for a raw `RealtimeClientEvent`, `interrupt()`, `markAudioPlayed()`, `confirmTool()`,
`executeTool()` and `submitToolResult()` for manual tool execution, `getConversation()`,
`getMetrics()`, `getRawEvents()` (each a `RealtimeServerEvent`), `whenIdle()`, and `export()`.

Every session event is a `RealtimeEvent`, and `RealtimeSessionEvents` maps each name to its payload for
`on()`. `TypedEventEmitter` is the small emitter underneath, with no dependency on Node's `events`.
`RealtimeClock` and `RealtimeIdFactory` are what tests replace; `createRealtimeId()` makes
`<prefix>_<uuid>` ids, falling back where `crypto.randomUUID` is missing.

## Agents and providers

`createRealtimeAgent()` takes `CreateRealtimeAgentOptions` — a session configuration with the
`provider` and `voice` kept apart — and `RealtimeAgentVoiceOptions`: the transport kind, interruption,
turn detection, the voice, and full audio settings. `OpenAIRealtimeProvider` is a
`RealtimeTransportProvider`: a name and `createTransport()`. `OpenAIRealtimeProviderOptions` sets the
default transport (`webrtc`), a `sessionEndpoint` for WebRTC, an `apiKey` for server WebSockets, and
options for each transport.

`createOpenAISessionUpdate()` builds OpenAI's `session.update` event from a configuration,
`createOpenAIToolResultEvents()` builds the events that return a tool result and ask the model to
continue, and `normalizeOpenAIRealtimeEvent()` turns one OpenAI event into neutral session events —
the pieces a custom transport for OpenAI reuses.

## Transports

A `RealtimeTransport` has a `kind` — a `RealtimeTransportKind`: `webrtc`, `websocket`, `mock`, or your
own — a `state` (a `RealtimeTransportState` from `idle` to `disconnected` or `failed`), `connect()`,
`sendAudio()`, `sendEvent()`, `interrupt()`, `disconnect()`, and `on()`. `RealtimeTransportEvents`
names what it emits: a `RealtimeTransportConnectedEvent`, each `RealtimeTransportDataEvent` from the
provider, each `RealtimeTransportAudioEvent` of model audio, and a `RealtimeTransportDisconnectedEvent`.

**Browser WebRTC.** `OpenAIWebRTCTransport` takes `OpenAIWebRTCTransportOptions`. An
`OpenAIWebRTCSessionMode` of `unified-sdp` sends the browser's offer to your `sessionEndpoint`;
`ephemeral-token` connects to OpenAI with an `OpenAIEphemeralCredential`, given directly or fetched by
an `OpenAIWebRTCTokenProvider`. It also takes headers for your endpoint, peer-connection settings and
a `RealtimePeerConnectionFactory`, the microphone or a stream or track of your own, a `fetch`, an abort
controller factory, timers, a connect timeout (15 seconds), an ICE-disconnect grace period, the data
channel's label and options, and whether `sendAudio()` may use the data channel. Every platform API
is structural — `RealtimePeerConnectionLike`, `RealtimeDataChannelLike`,
`RealtimeSessionDescriptionLike`, `RealtimeMediaDevicesLike`, `RealtimeMediaStreamLike`,
`RealtimeMediaTrackLike`, `RealtimeFetchLike` with `RealtimeFetchInitLike` and
`RealtimeFetchResponseLike`, and `RealtimeAbortControllerLike` — so it runs without a DOM shim and is
tested without a browser.

**Server WebSocket.** `OpenAIWebSocketTransport` takes `OpenAIWebSocketTransportOptions`: the URL, an
`apiKey` or an ephemeral token or an `OpenAIEphemeralTokenProvider`, headers and subprotocols, the
`OpenAIWebSocketFactory` that opens the socket — it receives `OpenAIWebSocketFactoryOptions` with the
headers and protocols, and returns a `RealtimeWebSocketLike` — connect and disconnect timeouts (10
seconds and 1 second), the largest audio chunk (15 MiB), a text codec, timers, and a clock.

**Server helpers.** `nexus-ai-pro/realtime/openai-server` keeps the API key on your server, through
`OpenAIRealtimeServerOptions`: the key, model, session settings, base URL, a `safetyIdentifier` for the
end user, a `fetch` (an `OpenAIRealtimeServerFetch` returning an `OpenAIRealtimeServerFetchResponse`),
and a `formDataFactory` for runtimes without `FormData` (a `FormDataLike`).
`createOpenAIRealtimeCall()` exchanges an SDP offer, `createOpenAIRealtimeSessionEndpoint()` wraps
that as a function for your route, and `createOpenAIRealtimeClientSecret()` mints an
`OpenAIRealtimeClientSecret` — a token, its expiry, and OpenAI's response — for a browser.

**Mock.** `MockRealtimeTransport` plays a script of `MockRealtimeTransportStep` values — provider
events, audio, errors, and disconnects — with `MockRealtimeTransportOptions` for the script,
`autoPlay`, a session id, a clock, and `strictState`. `enqueue()`, `advance()`, `flush()`, and the
`emit` methods drive it by hand.

## Tools in detail

A `RealtimeTool` has a name, a description, JSON Schema `parameters` or a `schema` — a
`RealtimeToolSchema` with `parse`, `safeParse` (returning a `RealtimeSchemaResult`), or `validate` —
`execute()`, `requiresConfirmation` (a flag or a function of the input), `safe`, `cache`, and metadata.
`defineTool()` checks it and, with `DefineRealtimeToolOptions`, infers the input type from the
schema through `InferRealtimeSchema`. `AnyRealtimeTool` is the type-erased shape a mixed list holds.
`toOpenAIRealtimeTools()` converts tools to OpenAI's definitions.

`execute()` receives a `RealtimeToolContext`: the session id, the call id, an idempotency key stable
across retries, the attempt, and a signal. The executor sees each call as a `RealtimeToolCall` — the
id, name, parsed arguments, the raw arguments and the parse error when parsing failed (the tool is not
run then), the item and response it belongs to, and its idempotency key — and returns a
`RealtimeToolResult`: the call, whether it succeeded, the result or error, the duration, and the
attempts.

`RealtimeToolExecutionOptions` is the session's `toolExecution`: `automatic` or `manual` mode, a
per-attempt timeout, parallel calls, retries and their delay (for `safe` tools only), allowed tools
intersected with the security allowlist, a `RealtimeToolCache` (`get` and `set` with a lifetime) with
its failure mode, and a `confirm` function. `RealtimeToolExecutor` is the executor on its own, with
`RealtimeToolExecutorOptions` — the session id, a signal, a clock, an id factory, and
`RealtimeToolExecutorHooks` for a call starting, needing confirmation, and completing — and
`register()`, `has()`, `list()`, `execute()`, and `clearCompleted()`. Each call id runs at most once.

## The conversation record

A `RealtimeConversation` has its id, provider, model, start and end, a status of `active`,
`completed`, or `failed`, the items in order, `ConversationMetrics` — turns, tool calls,
interruptions, reconnects, errors, audio durations, tokens, and the estimated cost, beside the
`RealtimeLatencyMetrics` of the latest turn: connection setup, speech end to response, speech end to
first audio, tool duration, tool result to first audio, and the whole turn — and metadata.

Each `ConversationItem` shares `ConversationItemBase` — an id, a time, the provider's item id, the raw
event, and metadata — and is one of `UserSpeechItem`, `AssistantSpeechItem`, `TextMessageItem`,
`ToolCallItem`, `ToolResultItem`, `InterruptionItem`, or `RealtimeConversationErrorItem`.

`nexus-ai-pro/realtime/conversation` is the record's logic as pure functions, for a server that
rebuilds a record from stored events: `createRealtimeConversation()` from
`CreateRealtimeConversationOptions`, `reduceRealtimeConversation()` to apply one event (with
`RealtimeConversationReducerOptions`), `createConversationMetrics()`, `withConversationMetrics()`,
`snapshotRealtimeConversation()`, and `exportRealtimeConversation()` in any
`RealtimeConversationExportFormat`: `json`, `openai-events`, `text`, or `analytics` — a
`RealtimeAnalyticsExport` of durations, item counts, and metrics, without transcripts.

## Errors

A `RealtimeError` has a message, the provider's code, a `RealtimeErrorCategory` — `authentication`,
`permission`, `configuration`, `capability`, `network`, `timeout`, `rate-limit`, `provider`,
`protocol`, `tool`, `confirmation`, `abort`, or `unknown` — whether retrying could succeed, whether it
is fatal to the session, the HTTP status, the provider event that reported it, the cause, and the raw
payload; `RealtimeErrorOptions` constructs one. `toRealtimeError()` wraps any error, inferring the
category.

## Limitations

- OpenAI is the only bundled provider. Another provider implements `RealtimeTransportProvider`.
- A session is not durable: a process that dies loses it, and the conversation record is what you
  store to keep it.
- Realtime sessions report through their own `telemetry` hooks, not yet through the client's shared
  metrics, audit log, and rate limiter that every other family uses.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/realtime`

| Export | Kind | Summary |
| --- | --- | --- |
| `AnyRealtimeTool` | type | Type-erased tool shape used by heterogeneous tool collections. |
| `AssistantSpeechItem` | interface | Something the model said aloud. |
| `ConversationItem` | type | One entry in a conversation record: speech, text, a tool call or result, an interruption, or an error. |
| `ConversationItemBase` | interface | Fields every item in a conversation record shares. |
| `ConversationMetrics` | interface | Running totals for a whole conversation, alongside the latest turn's latency. |
| `createOpenAISessionUpdate` | function | Builds OpenAI's `session.update` event from a session configuration. |
| `createOpenAIToolResultEvents` | function | Builds the events that return a tool result to OpenAI and ask the model to continue. |
| `createRealtimeAgent` | function | Creates a voice agent: a realtime session on a provider, with its voice settings folded into the session's audio configuration. |
| `CreateRealtimeAgentOptions` | interface | Options for `createRealtimeAgent()`: a session's configuration, with the provider and voice settings kept separate. |
| `createRealtimeId` | function | Creates `<prefix>_<uuid>` ids, falling back to time and random parts where `crypto.randomUUID` is unavailable. |
| `InferRealtimeSchema` | type | The argument type a schema produces, or a plain record when it cannot be inferred. |
| `InterruptionItem` | interface | The model being cut off mid-response. |
| `normalizeOpenAIRealtimeEvent` | function | Converts one OpenAI realtime event into neutral session events. |
| `OpenAIRealtimeProvider` | class | OpenAI's realtime API, over WebRTC in a browser or WebSocket on a server. |
| `OpenAIRealtimeProviderOptions` | interface | Options for the OpenAI realtime provider. |
| `RealtimeAgentVoiceOptions` | interface | Voice settings for `createRealtimeAgent()`. |
| `RealtimeAnalyticsExport` | interface | A conversation summarised for analytics: durations, counts, and metrics, without transcripts. |
| `RealtimeAudioElementLike` | interface | The subset of an `HTMLAudioElement` the WebRTC transport needs to play the model's audio. |
| `RealtimeAudioFormat` | interface | An audio encoding and sample rate. |
| `RealtimeAudioOptions` | interface | Audio settings for the session, input and output. |
| `RealtimeClientEvent` | type | A raw event sent to the provider, in the provider's own wire format. |
| `RealtimeClock` | interface | Time as the session sees it, injectable so tests control reconnect delays and latency. |
| `RealtimeConnectOptions` | interface | Browser connection options for the WebRTC transport. |
| `RealtimeConversation` | interface | A realtime conversation as a record: what was said, what tools ran, and how it performed. |
| `RealtimeConversationErrorItem` | interface | An error recorded in the conversation, so an export shows where a session went wrong. |
| `RealtimeConversationExportFormat` | type | How a conversation can be exported: the record as JSON, the provider's events, a readable transcript, or analytics. |
| `RealtimeConversationOptions` | interface | What the session keeps in its conversation record. |
| `RealtimeError` | class | An error from a realtime session or transport. |
| `RealtimeErrorCategory` | type | Why a realtime session failed. |
| `RealtimeErrorOptions` | interface | Options for constructing a `RealtimeError`. |
| `RealtimeEvent` | type | Everything a realtime session reports, as a discriminated union on `type`. |
| `RealtimeIdFactory` | type | Creates unique ids, with an optional prefix. |
| `RealtimeInterruptionOptions` | interface | How the session handles the user speaking over the model. |
| `RealtimeLatencyMetrics` | interface | Latency of the moments a user notices in a spoken exchange, in milliseconds. |
| `RealtimeMeterLike` | interface | The part of an OpenTelemetry meter the session creates instruments from. |
| `RealtimeMetricInstrumentLike` | interface | The part of an OpenTelemetry counter or histogram the session records to. |
| `RealtimeModality` | type | What a session exchanges with the model: spoken audio, text, or both. |
| `RealtimeProviderName` | type | Which realtime provider a session talks to. |
| `RealtimeReconnectOptions` | interface | How a session recovers from a dropped connection. |
| `RealtimeSchemaResult` | interface | The result of validating a tool's arguments with a schema's `safeParse`. |
| `RealtimeSecurityOptions` | interface | Limits and privacy controls for a session. |
| `RealtimeServerEvent` | type | A raw event received from the provider, in the provider's own wire format. |
| `RealtimeSessionConfig` | interface | Everything a realtime session needs: the model, the transport, tools, and every policy around them. |
| `RealtimeSessionEvents` | interface | Session events by name, with the payload each listener receives. |
| `RealtimeSessionState` | type | Lifecycle of a realtime session, including the reconnecting state a transport's own states do not have. |
| `RealtimeSpanLike` | interface | The part of an OpenTelemetry span the session writes to. |
| `RealtimeTelemetryOptions` | interface | Where a session reports spans, metrics, and events. |
| `RealtimeTokenUsage` | interface | Token usage a provider reported, handed to `estimateCost`. |
| `RealtimeTool` | interface | A tool a realtime model can call mid-conversation. |
| `RealtimeToolCache` | interface | Where cached tool results live. |
| `RealtimeToolCall` | interface | A tool call as the session hands it to the tool executor. |
| `RealtimeToolContext` | interface | What a tool's `execute` receives besides its arguments. |
| `RealtimeToolExecutionOptions` | interface | How a session executes the tools a model calls. |
| `RealtimeToolResult` | interface | The outcome of executing one tool call. |
| `RealtimeToolSchema` | interface | Validates a realtime tool's arguments. |
| `RealtimeTracerLike` | interface | The part of an OpenTelemetry tracer the session uses. |
| `RealtimeTransport` | interface | Moves audio and events between a session and a provider. |
| `RealtimeTransportAudioEvent` | interface | A piece of model audio arriving from the provider: bytes over WebSocket, or a media stream over WebRTC. |
| `RealtimeTransportConnectedEvent` | interface | Emitted once a transport has an open connection to the provider. |
| `RealtimeTransportDataEvent` | interface | A provider event arriving over the transport's data channel. |
| `RealtimeTransportDisconnectedEvent` | interface | Emitted when a transport's connection closes, cleanly or not. |
| `RealtimeTransportEvents` | interface | Events a transport emits, keyed by name, with the payload each carries. |
| `RealtimeTransportKind` | type | How audio and events travel: browser WebRTC, a server WebSocket, the in-memory mock, or a custom transport. |
| `RealtimeTransportProvider` | interface | Creates transports for one realtime provider. |
| `RealtimeTransportState` | type | Lifecycle of a transport connection, from construction to a clean or failed close. |
| `RealtimeTurnDetectionOptions` | type | How the provider decides the user finished speaking: silence-based, meaning-based, or `null` to leave turn-taking to the application. |
| `TextMessageItem` | interface | A text message in the conversation, typed rather than spoken. |
| `ToolCallItem` | interface | The model asking to call a tool. |
| `ToolResultItem` | interface | What a tool returned to the model. |
| `toRealtimeError` | function | Wraps any error as a `RealtimeError`, inferring the category from its name and message. |
| `TypedEventEmitter` | class | A small typed event emitter, with no dependency on Node's `events`. |
| `UserSpeechItem` | interface | Something the user said, as transcribed by the provider. |

### `nexus-ai-pro/realtime/conversation`

| Export | Kind | Summary |
| --- | --- | --- |
| `createConversationMetrics` | function | Conversation metrics with every counter at zero. |
| `createRealtimeConversation` | function | Creates an empty, active conversation record. |
| `CreateRealtimeConversationOptions` | interface | Options for `createRealtimeConversation()`. |
| `exportRealtimeConversation` | function | Exports a record as JSON, the provider's raw events, a readable transcript, or analytics without transcripts. |
| `RealtimeConversationReducerOptions` | interface | Options for `reduceRealtimeConversation()`. |
| `reduceRealtimeConversation` | function | Applies one realtime event to a conversation record and returns the new record. |
| `snapshotRealtimeConversation` | function | A deep copy of the record. |
| `withConversationMetrics` | function | Returns a copy of the record with some metrics replaced. |

### `nexus-ai-pro/realtime/mock`

| Export | Kind | Summary |
| --- | --- | --- |
| `MockRealtimeTransport` | class | Deterministic transport for unit tests, demos, and session state-machine simulation. |
| `MockRealtimeTransportOptions` | interface | Options for the mock transport. |
| `MockRealtimeTransportStep` | type | One scripted step of the mock transport: a provider event, audio, an error, or a disconnect. |

### `nexus-ai-pro/realtime/openai-server`

| Export | Kind | Summary |
| --- | --- | --- |
| `createOpenAIRealtimeCall` | function | Exchanges a browser's SDP offer with OpenAI and returns the SDP answer. |
| `createOpenAIRealtimeClientSecret` | function | Mints an ephemeral client secret for a browser session. |
| `createOpenAIRealtimeSessionEndpoint` | function | Returns a function that exchanges an SDP offer, ready to put behind your own HTTP route. |
| `FormDataLike` | interface | The part of `FormData` the SDP exchange needs. |
| `OpenAIRealtimeClientSecret` | interface | A short-lived client secret a browser can connect with. |
| `OpenAIRealtimeServerFetch` | type | The part of `fetch` the server helpers use. |
| `OpenAIRealtimeServerFetchResponse` | interface | The part of a `fetch` response the server helpers read. |
| `OpenAIRealtimeServerOptions` | interface | Server-side options for creating OpenAI realtime sessions, where the API key lives. |

### `nexus-ai-pro/realtime/openai-webrtc`

| Export | Kind | Summary |
| --- | --- | --- |
| `OpenAIEphemeralCredential` | interface | A short-lived client secret for connecting from a browser. |
| `OpenAIWebRTCSessionMode` | type | How the browser's offer reaches OpenAI. |
| `OpenAIWebRTCTokenProvider` | type | Fetches an ephemeral token for a session, typically from your own server. |
| `OpenAIWebRTCTransport` | class | Framework-independent OpenAI Realtime WebRTC transport using structural, injectable platform APIs. |
| `OpenAIWebRTCTransportOptions` | interface | Options for the browser WebRTC transport: how the session is negotiated, the microphone, and the platform APIs it runs on. |
| `RealtimeAbortControllerLike` | interface | The subset of `AbortController` the transport uses, for platforms without the global. |
| `RealtimeDataChannelLike` | interface | The subset of `RTCDataChannel` the transport sends and receives realtime events on. |
| `RealtimeFetchInitLike` | interface | The subset of `fetch` options the transport sends. |
| `RealtimeFetchLike` | type | The subset of `fetch` the transport uses to exchange SDP and fetch tokens. |
| `RealtimeFetchResponseLike` | interface | The subset of a `fetch` response the transport reads. |
| `RealtimeMediaDevicesLike` | interface | The subset of `navigator.mediaDevices` the transport uses to open the microphone. |
| `RealtimeMediaStreamLike` | interface | The subset of `MediaStream` the transport uses. |
| `RealtimeMediaTrackLike` | interface | The subset of `MediaStreamTrack` the transport uses. |
| `RealtimePeerConnectionFactory` | type | Creates a peer connection. |
| `RealtimePeerConnectionLike` | interface | The subset of `RTCPeerConnection` the transport uses. |
| `RealtimeSessionDescriptionLike` | interface | The subset of `RTCSessionDescription` the transport uses: an SDP offer or answer. |

### `nexus-ai-pro/realtime/openai-websocket`

| Export | Kind | Summary |
| --- | --- | --- |
| `OpenAIEphemeralTokenProvider` | type | Fetches a short-lived token for a session, instead of using a long-lived API key. |
| `OpenAIWebSocketFactory` | type | Opens a WebSocket. |
| `OpenAIWebSocketFactoryOptions` | interface | What a WebSocket factory receives besides the URL. |
| `OpenAIWebSocketTransport` | class | OpenAI Realtime WebSocket transport. |
| `OpenAIWebSocketTransportOptions` | interface | Options for the server-side WebSocket transport. |
| `RealtimeWebSocketLike` | interface | The subset of a `WebSocket` the transport uses. |

### `nexus-ai-pro/realtime/session`

| Export | Kind | Summary |
| --- | --- | --- |
| `createRealtimeSession` | function | Creates a realtime session from its configuration. |
| `RealtimeSession` | class | A realtime voice conversation: connects a transport, runs tools, handles barge-in, reconnects, and keeps a record of everything said. |

### `nexus-ai-pro/realtime/tools`

| Export | Kind | Summary |
| --- | --- | --- |
| `DefineRealtimeToolOptions` | interface | Options for `defineTool()` with a schema whose type the tool's input is inferred from. |
| `defineTool` | function | Defines a realtime tool, checking it has a name and a description. |
| `RealtimeToolExecutor` | class | Runs realtime tool calls: validates input, asks for confirmation when required, limits concurrency and duration, and runs each call id at most once. |
| `RealtimeToolExecutorHooks` | interface | Callbacks as tool calls progress. |
| `RealtimeToolExecutorOptions` | interface | Options for a realtime tool executor. |
| `toOpenAIRealtimeTools` | function | Converts tools to OpenAI realtime tool definitions. |
<!-- reference:end -->
