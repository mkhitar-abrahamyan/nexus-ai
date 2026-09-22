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
