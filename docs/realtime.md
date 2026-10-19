# Realtime voice agents

<!-- covers: ./realtime ./realtime/session ./realtime/tools ./realtime/conversation ./realtime/openai-webrtc ./realtime/openai-websocket ./realtime/gemini-live ./realtime/openai-sip ./realtime/openai-server ./realtime/mock -->

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
`realtime/gemini-live`, `realtime/openai-sip`, `realtime/openai-server`, and `realtime/mock`. The deterministic mock is suitable for tests and demos;
see [`examples/realtime-scheduling.ts`](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/examples/realtime-scheduling.ts).

## Sessions in detail

`createRealtimeSession()` builds a `RealtimeSession` from a `RealtimeSessionConfig`. Most fields are
optional; the ones you will set first are the provider, the model, and the transport.

| Field | What it sets |
| --- | --- |
| `provider` | A `RealtimeProviderName`. Defaults to `openai`. |
| `lifecycle` | `ai.lifecycle`, to run the session and each of its turns as operations of a client. See [On the client's lifecycle](#on-the-clients-lifecycle). |
| `tenantId`, `userId`, `principal`, `traceContext` | Who the session's operations are for, and the trace they belong to. The tenant and user default to the principal's. |
| `conversationStore`, `resume` | Where the record is kept after each committed turn, and a conversation to carry on. See [Conversations that outlive their process](#conversations-that-outlive-their-process). |
| `video` | `RealtimeVideoOptions`: how often `sendVideoFrame()` sends a frame, and in what format. See [Video and images](#video-and-images). |
| `model` | The realtime model, such as `gpt-realtime`. |
| `transport` | How the session connects: WebRTC, WebSocket, or the mock. |
| `modalities` | Each a `RealtimeModality`: `audio`, `text`, or both. |
| `instructions`, `tools`, `toolChoice`, `toolExecution` | What the model is told, and which tools it may call and how. |
| `audio` | `RealtimeAudioOptions`, below. |
| `interruption`, `reconnect`, `security`, `conversation`, `telemetry` | The option groups below. |
| `connection` | Browser options for `connect()`. |
| `providerSession` | Provider fields passed through as they are. |
| `signal`, `clock`, `idFactory` | Ends the session; replace time and ids in tests. |

The option groups:

| Group | What it controls |
| --- | --- |
| `RealtimeAudioOptions` | Input and output audio. Formats are a `RealtimeAudioFormat` (encoding and sample rate). Turn-taking is `RealtimeTurnDetectionOptions`: `server_vad` waits for silence, `semantic_vad` judges meaning, and `null` leaves it to you. |
| `RealtimeInterruptionOptions` | What barge-in does: `enabled`, `cancelResponse`, `truncateUnheardAudio`, a `stopPlayback` hook, and `getPlaybackPositionMs` for where to cut. |
| `RealtimeReconnectOptions` | `maxAttempts`, and a backoff from `initialDelayMs` growing by `multiplier` up to `maxDelayMs`. |
| `RealtimeSecurityOptions` | Hard limits: `maxSessionDurationMs` and `maxAudioDurationMs` end the session. Also a `toolAllowlist`, `retainTranscripts`, and a `piiHook` that rewrites every transcript first. |
| `RealtimeConversationOptions` | What the record keeps: transcripts, tool calls, raw events (10,000 by default), and a `redactTranscript` hook. Raw audio events keep the size of their audio, `delta_bytes`, not the audio, unless `retainRawAudio`. `replayItems` caps what a resumed session gives the provider back. |
| `RealtimeTelemetryOptions` | Tracing and metrics without a dependency, so OpenTelemetry plugs in. See the next table. |
| `RealtimeConnectOptions` | What `connect()` takes in a browser: a signal, the microphone, and where audio plays. |

Telemetry and browser playback go through small structural types:

| Type | Role |
| --- | --- |
| `RealtimeTracerLike`, `RealtimeSpanLike` | A tracer and its spans, such as OpenTelemetry's. |
| `RealtimeMeterLike`, `RealtimeMetricInstrumentLike` | A meter and its instruments. |
| `RealtimeTokenUsage` | What `estimateCost` receives: provider, model, token counts, and the raw payload. |
| `RealtimeAudioElementLike` | Anything that plays audio like an `<audio>` element. Or give a `remoteAudioSink`. |

### Session state and methods

A session moves through `RealtimeSessionState`: `idle`, `connecting`, `connected`, `reconnecting`,
`disconnecting`, `disconnected`, and `failed`.

| Method | What it does |
| --- | --- |
| `connect()`, `disconnect()` | Opens and closes the session. |
| `sendText()` | Sends a user message as text. |
| `sendImage()`, `sendVideoFrame()` | Adds an image to the conversation, or streams a frame of video. See [Video and images](#video-and-images). |
| `sendAudio()`, `commitAudio()`, `clearAudio()` | Streams audio by hand, then ends or discards the turn. |
| `createResponse()` | Asks the model to respond now. |
| `updateSession()` | Changes instructions, tools, or audio mid-session. |
| `sendEvent()` | Sends a raw `RealtimeClientEvent`. |
| `interrupt()` | Stops the current response. |
| `markAudioPlayed()` | Reports that audio reached the speaker, for accurate latency. |
| `confirmTool()` | Approves or refuses a tool call that needs confirmation. |
| `executeTool()`, `submitToolResult()` | Runs tools yourself in `manual` mode. |
| `getConversation()`, `getMetrics()` | The record and its metrics so far. |
| `getRawEvents()` | Each provider event as a `RealtimeServerEvent`. |
| `whenIdle()` | Resolves when nothing is in flight. |
| `export()` | The record in one of four formats. |

Events arrive through `on()`. Each is a `RealtimeEvent`, and `RealtimeSessionEvents` maps each event
name to its payload. `TypedEventEmitter` is the small emitter underneath; it does not depend on Node's
`events`.

Tests replace time and ids through `RealtimeClock` and `RealtimeIdFactory`. `createRealtimeId()` makes
ids like `<prefix>_<uuid>`, and works where `crypto.randomUUID` is missing.

## Agents and providers

`createRealtimeAgent()` is the friendlier entry point. It takes `CreateRealtimeAgentOptions`, which is
a session configuration with the provider and voice kept separate. `RealtimeAgentVoiceOptions` holds
the voice side: the transport kind, interruption, turn detection, the voice, and audio settings.

A provider creates transports. `OpenAIRealtimeProvider` is a `RealtimeTransportProvider`: a name and a
`createTransport()`. `OpenAIRealtimeProviderOptions` sets the default transport (`webrtc`), the
`sessionEndpoint` for WebRTC, the `apiKey` for server WebSockets, and options for each transport.

`GeminiLiveProvider` is the other bundled provider: Gemini Live, behind the same session, tools,
and conversation record. Its options are those of every `GeminiLiveTransport` it creates
(`GeminiLiveProviderOptions`), and its sessions are recorded as the `google` provider's. One agent
definition runs on either:

```ts
import { createRealtimeAgent, GeminiLiveProvider, OpenAIRealtimeProvider } from 'nexus-ai-pro/realtime';

const definition = { instructions: 'You track orders.', tools: [trackOrder], voice: { interruption: true } };

const onOpenAI = createRealtimeAgent({ ...definition, provider: new OpenAIRealtimeProvider(), model: 'gpt-realtime' });
const onGemini = createRealtimeAgent({
  ...definition,
  provider: new GeminiLiveProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  model: 'gemini-live-2.5-flash-preview',
});
```

In the test suite, one agent definition holds the same conversation on both, each over its own wire
protocol: the person asks where an order is, the model calls the tool, the tool runs once, and the
model answers. The two records match item for item, with the same usage.

Three functions are the building blocks of a custom OpenAI transport:

| Function | What it does |
| --- | --- |
| `createOpenAISessionUpdate()` | Builds OpenAI's `session.update` event from a configuration. |
| `createOpenAIToolResultEvents()` | Builds the events that return a tool result and let the model continue. |
| `normalizeOpenAIRealtimeEvent()` | Turns one OpenAI event into neutral session events. |

## Transports

A `RealtimeTransport` is the connection under a session. It has a `kind`, a `state`, and methods to
connect, send audio and events, interrupt, disconnect, and subscribe with `on()`. A transport whose
provider takes video as realtime input also has `sendVideo()`.

| Type | Meaning |
| --- | --- |
| `RealtimeTransportKind` | `webrtc`, `websocket`, `mock`, or your own. |
| `RealtimeTransportState` | From `idle` to `disconnected` or `failed`. |
| `RealtimeTransportEvents` | What a transport emits, below. |
| `RealtimeTransportConnectedEvent` | The connection is up. |
| `RealtimeTransportDataEvent` | One event from the provider. |
| `RealtimeTransportAudioEvent` | A chunk of model audio. |
| `RealtimeTransportDisconnectedEvent` | The connection closed, and why. |

### Browser WebRTC

`OpenAIWebRTCTransport` takes `OpenAIWebRTCTransportOptions`. Its `OpenAIWebRTCSessionMode` picks how
it authenticates:

- `unified-sdp` sends the browser's offer to your `sessionEndpoint`, which holds the API key. This is
  the default and the safest.
- `ephemeral-token` connects to OpenAI directly with an `OpenAIEphemeralCredential`, given as a value or
  fetched by an `OpenAIWebRTCTokenProvider`.

The other options cover your endpoint's headers, the peer connection (settings, or a
`RealtimePeerConnectionFactory`), the microphone or your own stream or track, a `fetch`, timers, and
timeouts: 15 seconds to connect, and a grace period after an ICE disconnect. You can also name the
data channel and decide whether `sendAudio()` may use it. A session that sends no microphone still
hears the model: the offer asks to receive audio, unless the session's `modalities` are text only.

Every browser API is used through a structural type, so the transport runs without a DOM shim and is
unit-tested without a browser. It also runs in a real one: `npm run test:browser:realtime` drives a
session over WebRTC in headless Chromium, against a second peer connection in the page that plays the
provider. The offer, the answer, ICE, DTLS, and the data channel are real; Chromium's fake microphone
is sent up, a tone comes back as the model's voice and plays, a tool call is answered, and a session
with no microphone still hears the model. That run found two defects the structural tests could not:
the answer's last line lost its line break, which Chromium refuses, and a session without a
microphone offered no audio to receive.

| Browser API | Structural type |
| --- | --- |
| `RTCPeerConnection` | `RealtimePeerConnectionLike` |
| `RTCDataChannel` | `RealtimeDataChannelLike` |
| `RTCSessionDescription` | `RealtimeSessionDescriptionLike` |
| `navigator.mediaDevices` | `RealtimeMediaDevicesLike` |
| `MediaStream`, `MediaStreamTrack` | `RealtimeMediaStreamLike`, `RealtimeMediaTrackLike` |
| `fetch` | `RealtimeFetchLike`, with `RealtimeFetchInitLike` and `RealtimeFetchResponseLike` |
| `AbortController` | `RealtimeAbortControllerLike` |

### Server WebSocket

`OpenAIWebSocketTransport` takes `OpenAIWebSocketTransportOptions`. It authenticates with an `apiKey`,
an ephemeral token, or an `OpenAIEphemeralTokenProvider`. You supply the socket through an
`OpenAIWebSocketFactory`: it receives `OpenAIWebSocketFactoryOptions` (headers and protocols) and
returns a `RealtimeWebSocketLike`. The remaining options set the URL, headers, subprotocols, timeouts
(10 seconds to connect, 1 to disconnect), the largest audio chunk (15 MiB), a text codec, timers, and
a clock. `callId` attaches the transport to a call OpenAI is already carrying, such as an accepted
SIP call, instead of starting a session on a model.

### Gemini Live

`GeminiLiveTransport`, from `nexus-ai-pro/realtime/gemini-live`, speaks Gemini's Live API over a
WebSocket and translates, both ways, between it and the events the session speaks. Its
`GeminiLiveTransportOptions` authenticate with an `apiKey`, sent in the URL, or an ephemeral token,
given as `ephemeralToken` or fetched by `ephemeralTokenProvider`, sent to the constrained endpoint.
A key is refused in a browser. Because the key travels in the URL rather than a header, the runtime's
own `WebSocket` (Node 22 and later) is enough on a server; `webSocketFactory` replaces it. The other
options set the URL, extra `setup` fields, timeouts (10 seconds to connect, 1 to disconnect), the
largest audio chunk (15 MiB), a text codec, timers, and a clock.

What the session sends becomes Gemini's, and what Gemini sends becomes the session's:

| The session | Gemini Live |
| --- | --- |
| Its configuration: model, instructions, tools, voice, language, modalities, turn detection | The `setup` message, once, at connect. Tool schemas lose `additionalProperties` and `$schema`, which Gemini does not take. |
| Microphone audio, and committing it | `realtimeInput` audio, at the input format's rate (16 kHz by default), and the end of the audio stream. |
| A message, an image, a tool call or result given back on resume | A `clientContent` turn. |
| A request for a response | The end of the person's turn. |
| A tool's result | A `toolResponse`, by the call's id and name. Gemini goes on by itself after it, so the request for a response that follows is dropped. |
| Speech transcribed, the model's audio, text, and transcript | The same events the session reads from OpenAI. |
| A `toolCall` | A finished response that calls the tools. |
| A turn's end, with its usage | A finished response, with its tokens. |
| An interruption | The person's speech starting, then the response cancelled, so the session sees the barge-in. |

Gemini's transcription of the person trails their speech. Words that arrive while the model answers
join the turn it is answering, and that turn's transcript completes when the model's turn does; only
Gemini's own interruption starts a new turn before then, so late words never read as the person
speaking over the model. Gemini does not echo what it is given; the transport does, so the record
keeps typed messages as it does on OpenAI. A tool call Gemini cancels, because the person spoke over it, is not answered.
`sessionResumption`, on by default, asks Gemini for resumption handles: a socket that drops
reconnects with the latest resumable one, and Gemini carries the conversation on where it left it.
Gemini's warning that it will close the socket arrives as a raw `session.go_away` event.

### Server helpers

`nexus-ai-pro/realtime/openai-server` keeps the API key on your server.

| Function | What it does |
| --- | --- |
| `createOpenAIRealtimeCall()` | Exchanges a browser's SDP offer for OpenAI's answer. |
| `createOpenAIRealtimeSessionEndpoint()` | Wraps that as a handler for your route. |
| `createOpenAIRealtimeClientSecret()` | Mints an `OpenAIRealtimeClientSecret` for a browser: a token, its expiry, and OpenAI's response. |
| `acceptOpenAIRealtimeCall()` | Answers a call OpenAI carries with the session that will run it. |
| `rejectOpenAIRealtimeCall()` | Declines it, with a SIP status: 603 by default. |
| `referOpenAIRealtimeCall()` | Transfers an accepted call to another number or SIP address. |
| `hangupOpenAIRealtimeCall()` | Ends it. |
| `verifyOpenAIWebhook()` | Checks a webhook delivery's signature and returns its `OpenAIWebhookEvent`. |

Controlling a call takes `OpenAIRealtimeCallOptions`: the key, the base URL, the safety identifier,
and a `fetch`. `verifyOpenAIWebhook()` takes the delivery's `OpenAIWebhookHeaders`, a `Headers`
object or a plain record, and its raw body, with your endpoint's signing secret. It refuses a
delivery that is unsigned, signed with another secret, altered, or older than
`OpenAIWebhookVerifyOptions.toleranceSeconds` (300), with a `RealtimeError` of code
`invalid_webhook_signature`. It runs on Web Crypto, so anywhere.

They share `OpenAIRealtimeServerOptions`: the key, the model, session settings, a base URL, a
`safetyIdentifier` for the end user, a `fetch`, and a `formDataFactory` for runtimes without
`FormData`. With `credentials`, the resolver the client's lifecycle uses, such as
`tenantCredentials()`, and a `tenantId`, the session an SDP exchange makes and the client secret a
browser connects with are minted with that tenant's key, read for `provider` (`openai`); a tenant the
resolver refuses is refused before anything is sent, and the key is cleaned from every error. The
endpoint `createOpenAIRealtimeSessionEndpoint()` returns takes the tenant per call, as its third
argument, such as the one your route authenticated. Controlling a call OpenAI carries always uses
`apiKey`, the key of the project that received the call. The injected `fetch` is an `OpenAIRealtimeServerFetch` returning an
`OpenAIRealtimeServerFetchResponse`, and the form data a `FormDataLike`.

### The mock

`MockRealtimeTransport` plays a script, for tests and demos. Each step is a `MockRealtimeTransportStep`:
a provider event, audio, an error, or a disconnect. `MockRealtimeTransportOptions` sets the script,
`autoPlay`, a session id, a clock, and `strictState`. Drive it by hand with `enqueue()`, `advance()`,
`flush()`, and the `emit` methods.

## Phone calls over SIP

`answerOpenAISipCalls()`, from `nexus-ai-pro/realtime/openai-sip`, answers phone calls with a
realtime agent. Point a SIP trunk at OpenAI, and OpenAI's `realtime.call.incoming` webhook at the
handler of the `OpenAISipCalls` it returns. For each verified delivery, `answer()` decides from the `OpenAISipCall` (who is
calling, what they called, and every SIP header) and returns an `OpenAISipAnswer`:
- a session's configuration (`OpenAISipSessionConfig`): the call is accepted with it, and a session
  attaches to the call over a WebSocket and runs it, with its tools, conversation record, and
  lifecycle. Its id is the call's;
- `false`, which declines the call with SIP 603, or `{ reject }` with another status, such as 486
  when busy.

```ts
import { answerOpenAISipCalls } from 'nexus-ai-pro/realtime/openai-sip';
import WebSocket from 'ws';

const calls = answerOpenAISipCalls({
  apiKey: process.env.OPENAI_API_KEY!,
  webhookSecret: process.env.OPENAI_WEBHOOK_SECRET!,
  webSocketFactory: (url, { headers }) => new WebSocket(url, { headers }),
  answer: async (call) => {
    const account = await accounts.byPhone(call.from);
    if (!account) return { reject: 486 };
    return { model: 'gpt-realtime', instructions: account.greeting, tools: [bookTable], lifecycle: ai.lifecycle, tenantId: account.id };
  },
  onSession: (session, call) => session.on('error', (error) => log.warn({ callId: call.callId, error })),
});

// Your route, with the body exactly as it arrived:
const { status, body } = await calls.handle({ headers: request.headers, body: rawBody });
```

`handle()` takes an `OpenAISipWebhookRequest` and returns an `OpenAISipWebhookResponse` to reply
with: 200 once the call is accepted or declined, 401 for a delivery your secret did not sign, and
500 when answering failed, so OpenAI delivers it again. Each delivery is claimed by its webhook id
before it is acted on, so a retry or a duplicate answers its call once; a failed one is released, so
its retry is acted on. The claims are remembered in the process, the last 10,000; give `claim` and
`release` backed by a shared store when several replicas take the webhook. The session connects after
the reply; `onSession()` receives it, and `onError()` what fails after. Other verified events go to
`onEvent()`.

An `OpenAISipCall` also transfers the call with `refer()` and ends it with `hangup()`. `sessions`
holds the calls in progress by id, and `close()` hangs each up, for shutdown. `OpenAISipHeader` is one
SIP header, and `OpenAISipOptions` the whole configuration.

In the test suite, a signed delivery of an incoming call is accepted with the agent's session, chosen
from the caller's number. The session attaches by the call's id and books a table through its tool
when the caller asks, and the call is hung up. Forged, altered, and stale deliveries answer nothing. A
retry after a failed accept answers the call, and a duplicate, on the same replica or another, does
not answer it twice.

## Video and images

`sendImage()` adds an image to the conversation as the person's: a photo, a screenshot, a page. It
takes a `RealtimeImageInput` (bytes, a `data:` URL, or base64) with `RealtimeImageOptions`: the `mimeType` (`image/jpeg` by
default), `text` sent in the same message, and `createResponse`, true by default when there is text.

`sendVideoFrame()` streams one frame of video, from a camera or a shared screen. On a provider that
takes video as realtime input, such as Gemini Live, the frame goes there; otherwise it goes into the
conversation as an image. `RealtimeVideoOptions` spaces frames out: one sooner than `minIntervalMs`
after the last one sent is dropped (1,000 by default, about what the models take), and the method
returns whether the frame was sent.

```ts
const session = createRealtimeAgent({
  provider: new GeminiLiveProvider({ apiKey }),
  model: 'gemini-live-2.5-flash-preview',
  video: { minIntervalMs: 1000 },
});
await session.connect();
camera.onFrame((jpeg) => session.sendVideoFrame(jpeg));
session.sendImage(receiptPng, { mimeType: 'image/png', text: 'What is the total on this receipt?' });
```

## Tools in detail

A `RealtimeTool` is what the model can call.

| Field | Meaning |
| --- | --- |
| `name`, `description` | What the model sees. |
| `parameters` or `schema` | JSON Schema, or a `RealtimeToolSchema` with `parse`, `safeParse` (returning a `RealtimeSchemaResult`), or `validate`. |
| `execute()` | Your implementation. |
| `requiresConfirmation` | A flag, or a function of the input, that makes a person approve the call first. |
| `safe` | The call has no side effects, so it may be retried and cached. |
| `cache`, `metadata` | Caching for safe tools, and application data. |

`defineTool()` checks a tool and, with `DefineRealtimeToolOptions`, infers the input type from its
schema through `InferRealtimeSchema`. `AnyRealtimeTool` is the type-erased shape a mixed list holds.
`toOpenAIRealtimeTools()` converts tools to OpenAI's definitions.

A call flows through three types:

| Type | Contents |
| --- | --- |
| `RealtimeToolContext` | What `execute()` receives: the session id, the call id, an idempotency key stable across retries, the attempt, and a signal. |
| `RealtimeToolCall` | The call as the executor sees it: id, name, parsed arguments, and the raw arguments and parse error when parsing failed. A call that failed to parse is not run. |
| `RealtimeToolResult` | The outcome: the call, whether it succeeded, the result or error, the duration, and the attempts. |

The session's `toolExecution` is a `RealtimeToolExecutionOptions`:

| Option | Meaning |
| --- | --- |
| mode | `automatic` runs tools as the model calls them; `manual` leaves it to you. |
| timeout, parallel calls | A per-attempt timeout, and how many calls run at once. |
| retries | How often, and how long to wait, for `safe` tools only. |
| allowed tools | Intersected with the security allowlist. |
| cache | A `RealtimeToolCache` (`get`, and `set` with a lifetime), and what a cache failure does. |
| confirm | A function that approves calls needing confirmation. |

`RealtimeToolExecutor` is the executor on its own. It takes `RealtimeToolExecutorOptions` — the session
id, a signal, a clock, an id factory — and `RealtimeToolExecutorHooks` for a call starting, needing
confirmation, and completing. Its methods are `register()`, `has()`, `list()`, `execute()`, and
`clearCompleted()`. Each call id runs at most once.

## The conversation record

A `RealtimeConversation` is everything that happened in a session: its id, provider, model, start and
end, a status (`active`, `completed`, or `failed`), the items in order, metrics, and metadata.

`ConversationMetrics` counts turns, tool calls, interruptions, reconnects, errors, audio durations,
tokens, and the estimated cost. `RealtimeLatencyMetrics` times the latest turn: connection setup,
speech end to response, speech end to first audio, tool duration, tool result to first audio, and the
whole turn.

Each item is a `ConversationItem`. They share `ConversationItemBase` — an id, a time, the provider's
item id, the raw event, and metadata — and each is one of these:

| Item | What happened |
| --- | --- |
| `UserSpeechItem` | The user spoke. |
| `AssistantSpeechItem` | The assistant spoke. |
| `TextMessageItem` | A text message, either way. |
| `ToolCallItem`, `ToolResultItem` | A tool was called, and returned. |
| `InterruptionItem` | The user interrupted. |
| `RealtimeConversationErrorItem` | Something failed. |

`nexus-ai-pro/realtime/conversation` holds the record's logic as pure functions. A server uses them to
rebuild a record from stored events:

| Function | What it does |
| --- | --- |
| `createRealtimeConversation()` | Starts a record, from `CreateRealtimeConversationOptions`. |
| `reduceRealtimeConversation()` | Applies one event, with `RealtimeConversationReducerOptions`, to a copy of the record; with `inPlace`, to the record given, for its one owner. |
| `createConversationMetrics()`, `withConversationMetrics()` | Start and update the metrics. |
| `snapshotRealtimeConversation()` | An immutable copy. |
| `exportRealtimeConversation()` | Writes it in a `RealtimeConversationExportFormat`: `json`, `openai-events`, `text`, or `analytics`. |

The `analytics` format is a `RealtimeAnalyticsExport`: durations, item counts, and metrics, without
transcripts.

### On the client's lifecycle

Given `ai.lifecycle`, a session runs through the same lifecycle as every other family. Its
operations carry the session's `tenantId` and `userId` (the principal's by default) and its
`traceContext`:
- the session itself is one operation, `realtime.session`, admitted when it first connects;
- each model turn is one more, `realtime.turn`, admitted as the turn starts: rate-limited,
  authorized, and holding the turns' average cost so far against the budget;
- when the turn finishes, its operation is charged what the turn cost, from `estimateCost`;
- a session's usage and estimated cost are the sum of its turns'.

A turn the lifecycle refuses, because the budget cannot cover it, the rate limit is reached, or
authorization says no, is cancelled before the model runs it. The session then ends with a
`RealtimeError` of code `lifecycle_refused`. A connection that succeeds or fails is reported to the
client's provider health and circuit breaker, as a completion's attempts are.

In the test suite, through a real client: with a five-cent budget and two cents a turn, the first two
turns run, and the third is cancelled as it starts and ends the session. The budget then holds four
cents, and every operation names the session's tenant and user.

## Conversations that outlive their process

Give a session a `conversationStore`, a `RealtimeConversationStore`, and it writes its record after
each committed turn: a finished response, a transcribed utterance, a typed message, and a tool's
result. `MemoryRealtimeConversationStore` keeps records in the process, and
`storeRealtimeConversations()` in any long-term `Store`: the memory, Redis, Postgres, or SQLite store.

Another process carries the conversation on with `resume`: its record, or its id in the store. The
new session takes the conversation's id, items, metrics, and metadata, active again. On connecting,
it gives the provider what was said and what the tools returned, before anything new, so the model
answers with it. `replayRealtimeConversation()` builds those items: speech as text from its
transcript, typed messages, tool calls, and their results, the latest `replayItems` of them. Each
carries an id that begins with `REALTIME_REPLAY_PREFIX`, so the provider's echoes are not recorded
twice. A new transport carries the conversation; the socket and the audio that was in flight are not
recovered.

```ts
import { createRealtimeSession, storeRealtimeConversations } from 'nexus-ai-pro/realtime';

const conversationStore = storeRealtimeConversations(redisStore);
// In the process that takes over, by the id the first one stored:
const session = createRealtimeSession({ model: 'gpt-realtime', transport, conversationStore, resume: conversationId });
await session.connect();
```

In the test suite, a session's process is killed mid-conversation on the memory and SQLite stores.
Another process resumes it by id: the provider is first told what the person said and what the model
answered, and the conversation goes on under its own id, with nothing recorded twice.

## Turn latency and session load

What the library adds to a call is held to a budget, as its size and runtime are.
`npm run bench:realtime` runs sessions over an in-memory transport that delivers a provider's
messages for a spoken turn, each message in a macrotask of its own, as a socket does: the caller's
speech and its transcript, the response, 25 frames of 20 ms audio with its transcript, and the
turn's end. It measures:
- **Added latency**: from a message's arrival to the session's event for it. Held under 5 ms at p99
  for one call, and under 20 ms, one audio frame, with 250 calls at real time.
- **A long call**: 550 turns in one session. A late turn must cost what an early one does, within
  twice, so work that grows with the conversation is caught on any machine.
- **Calls at real time**: 250 sessions, each sent its messages at a call's own pace. The process must
  keep up: event-loop delay under 50 ms at p99, and finished within 100 ms of the calls' length.
- **Throughput and memory**: 1,000 sessions of ten turns, as a ratio to a calibration loop, so a
  budget recorded on one machine holds on a slower one, and the heap each live session holds.
- **Retention**: 1,000 sessions that end leave the heap within 8 MB of where it started.

The budgets are in `realtime-budget.json`, and the release gate runs the check. On the machine that
recorded them, under Node 22:

| Measure | Measured |
| --- | --- |
| A spoken turn, one call | 0.57 ms of the session's time, at p50 |
| Added to a message | 2 µs at p50, 10 µs at p99 |
| 250 calls at real time | 15% of a core: about 1,700 calls per core; event-loop delay 19 ms at p99 |
| A live session | 44 KB, with transcripts and raw events |
| Over WebRTC in Chromium, `sendText()` to the response starting | 0.4 ms at p50, under 1 ms at p95, on loopback |

Writing the method down found what it measures. Before it, a session copied its whole record twice
for every event, once to apply it and once to announce it, so a turn cost 39 ms by the 500th and 250
calls took half a core. It also kept every audio frame it had played, about 13 MB for a 3-minute
call. Now the session applies events to its own record in place, copies it only for a
`conversation.updated` listener, and keeps an audio event's size in place of its audio.

## Errors

Every failure is a `RealtimeError`. It carries a message, the provider's code, the HTTP status, the
provider event that reported it, the cause, and the raw payload. Two flags say what to do: whether a
retry could succeed, and whether the error ends the session.

Its `RealtimeErrorCategory` is one of `authentication`, `permission`, `configuration`, `capability`,
`network`, `timeout`, `rate-limit`, `provider`, `protocol`, `tool`, `confirmation`, `abort`, or
`unknown`. `RealtimeErrorOptions` constructs one, and `toRealtimeError()` wraps any error, inferring
its category.

## Limitations

- OpenAI and Gemini Live are the bundled providers. Another provider implements
  `RealtimeTransportProvider`.
- Gemini Live and SIP calls are verified in the test suite against scripted versions of their
  protocols. The weekly live workflow also runs a Gemini Live session that calls a tool, and OpenAI's
  SIP call control, where the repository's secrets are set; a live call over a SIP trunk is not run.
- Gemini Live is configured once, at connect: `updateSession()` changes nothing there, and neither
  `clearAudio()` nor truncating unheard audio has a counterpart. Gemini stops its own response when
  the person speaks.
- On a provider without video input, each frame becomes an image in the conversation, and so part of
  the model's context: space frames out further there.
- Images and frames are not kept in the conversation record, and a resumed conversation does not give
  them back.
- A resumed conversation gives the provider its transcripts as text, not its audio, so the model
  hears what was said as written, not how it was said.
- A turn is charged from `estimateCost`: a session without one is admitted and rate-limited turn by
  turn, but charges nothing to the budget.

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
| `GeminiLiveProvider` | class | Gemini Live as a realtime provider, behind the same session, tools, and conversation record as OpenAI's. |
| `GeminiLiveProviderOptions` | interface | Options for `GeminiLiveProvider`: those of every transport it creates. |
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
| `RealtimeConversationStore` | interface | Where conversation records are kept, so a session resumes in another process. |
| `RealtimeError` | class | An error from a realtime session or transport. |
| `RealtimeErrorCategory` | type | Why a realtime session failed. |
| `RealtimeErrorOptions` | interface | Options for constructing a `RealtimeError`. |
| `RealtimeEvent` | type | Everything a realtime session reports, as a discriminated union on `type`. |
| `RealtimeIdFactory` | type | Creates unique ids, with an optional prefix. |
| `RealtimeImageInput` | type | An image for the session: its bytes, a `data:` URL, or base64 with `mimeType`. |
| `RealtimeImageOptions` | interface | How `RealtimeSession.sendImage()` adds an image. |
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
| `RealtimeVideoOptions` | interface | How a session streams video. |
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
| `MemoryRealtimeConversationStore` | class | Conversation records in this process. |
| `REALTIME_REPLAY_PREFIX` | constant | The prefix of the item ids a resumed session gives the provider, so their echoes are not recorded twice. |
| `RealtimeConversationReducerOptions` | interface | Options for `reduceRealtimeConversation()`. |
| `reduceRealtimeConversation` | function | Applies one realtime event to a conversation record and returns the new record. |
| `replayRealtimeConversation` | function | A conversation's items as the provider's `conversation.item.create` events, oldest first: what a resumed session gives a new provider session, so the model knows what was said and what the tools returned. |
| `snapshotRealtimeConversation` | function | A deep copy of the record. |
| `storeRealtimeConversations` | function | Conversation records in any long-term `Store`: the memory, Redis, Postgres, or SQLite store. |
| `withConversationMetrics` | function | Returns a copy of the record with some metrics replaced. |

### `nexus-ai-pro/realtime/gemini-live`

| Export | Kind | Summary |
| --- | --- | --- |
| `GeminiLiveTransport` | class | Gemini Live over a WebSocket, behind the realtime session. |
| `GeminiLiveTransportOptions` | interface | Options for the Gemini Live transport. |

### `nexus-ai-pro/realtime/mock`

| Export | Kind | Summary |
| --- | --- | --- |
| `MockRealtimeTransport` | class | Deterministic transport for unit tests, demos, and session state-machine simulation. |
| `MockRealtimeTransportOptions` | interface | Options for the mock transport. |
| `MockRealtimeTransportStep` | type | One scripted step of the mock transport: a provider event, audio, an error, or a disconnect. |

### `nexus-ai-pro/realtime/openai-server`

| Export | Kind | Summary |
| --- | --- | --- |
| `acceptOpenAIRealtimeCall` | function | Answers a call OpenAI is carrying, such as an incoming SIP call, with the session that will run it: its model, instructions, tools, and audio, as `createOpenAISessionUpdate()` builds them. |
| `createOpenAIRealtimeCall` | function | Exchanges a browser's SDP offer with OpenAI and returns the SDP answer. |
| `createOpenAIRealtimeClientSecret` | function | Mints an ephemeral client secret for a browser session. |
| `createOpenAIRealtimeSessionEndpoint` | function | Returns a function that exchanges an SDP offer, ready to put behind your own HTTP route. |
| `FormDataLike` | interface | The part of `FormData` the SDP exchange needs. |
| `hangupOpenAIRealtimeCall` | function | Ends a call. |
| `OpenAIRealtimeCallOptions` | type | What controlling a call OpenAI carries needs: the key, and how to reach OpenAI. |
| `OpenAIRealtimeClientSecret` | interface | A short-lived client secret a browser can connect with. |
| `OpenAIRealtimeServerFetch` | type | The part of `fetch` the server helpers use. |
| `OpenAIRealtimeServerFetchResponse` | interface | The part of a `fetch` response the server helpers read. |
| `OpenAIRealtimeServerOptions` | interface | Server-side options for creating OpenAI realtime sessions, where the API key lives. |
| `OpenAIWebhookEvent` | interface | One event OpenAI delivered to your webhook. |
| `OpenAIWebhookHeaders` | type | Headers as a `Headers` object or a plain record, such as Node's `request.headers`. |
| `OpenAIWebhookVerifyOptions` | interface | How `verifyOpenAIWebhook()` checks a delivery. |
| `referOpenAIRealtimeCall` | function | Transfers an accepted call to another number or SIP address, such as `tel:+14155550123`. |
| `rejectOpenAIRealtimeCall` | function | Declines a call, with a SIP status: 603 (decline) by default, or 486 (busy), say. |
| `verifyOpenAIWebhook` | function | Checks a webhook delivery's signature against your endpoint's signing secret (`whsec_...`) and returns its event. |

### `nexus-ai-pro/realtime/openai-sip`

| Export | Kind | Summary |
| --- | --- | --- |
| `answerOpenAISipCalls` | function | Answers phone calls with a realtime agent, over OpenAI's SIP interface. |
| `OpenAISipAnswer` | type | How to answer a call: with the session that runs it, or not at all, with a SIP status. |
| `OpenAISipCall` | interface | An incoming phone call, and what can be done with it once it is answered. |
| `OpenAISipCalls` | interface | Phone calls answered by a realtime agent, from `answerOpenAISipCalls()`. |
| `OpenAISipHeader` | interface | One SIP header of a call, as it arrived. |
| `OpenAISipOptions` | interface | Options for `answerOpenAISipCalls()`. |
| `OpenAISipSessionConfig` | type | The session that answers a call: a session's configuration, less the transport the call provides. |
| `OpenAISipWebhookRequest` | interface | A webhook delivery, as your HTTP server received it. |
| `OpenAISipWebhookResponse` | interface | What to reply to a webhook delivery. |

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
