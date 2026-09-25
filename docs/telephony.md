# Telephony

<!-- covers: ./telephony ./telephony/realtime-bridge ./telephony/twilio -->

Phone calls from `nexus-ai-pro/telephony`: outbound calls, webhook responses, call control, phone numbers, and media streams, with a Twilio adapter on `nexus-ai-pro/telephony/twilio` and a bridge on `nexus-ai-pro/telephony/realtime-bridge` that connects a call to a realtime voice session.

## Phone Number Telephony

Phone-number support is optional and separate from the voice layer. Use `voice` for audio transcription/TTS, and use `telephony` when calls, webhooks, TwiML, or media-stream events are involved.

```ts
import { TelephonyManager } from 'nexus-ai-pro/telephony';
import { TwilioTelephonyProvider } from 'nexus-ai-pro/telephony/twilio';
```

Configure only the provider you need:

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  telephony: {
    defaultProvider: 'twilio',
    providers: {
      twilio: new TwilioTelephonyProvider({
        accountSid: process.env.TWILIO_ACCOUNT_SID!,
        authToken: process.env.TWILIO_AUTH_TOKEN!,
      }),
    },
  },
});
```

Generate a Twilio webhook response for an inbound phone number:

```ts
const response = await ai.createTelephonyResponse({
  say: 'Thanks for calling. Connecting you now.',
  stream: {
    url: 'wss://voice.example.com/twilio',
    mode: 'bidirectional',
    parameters: { tenant: 'acme' },
  },
});

return new Response(response.body, {
  headers: { 'content-type': response.contentType },
});
```

Start an outbound call with either a webhook, inline TwiML, an application SID, or a media-stream URL:

```ts
const call = await ai.createCall({
  to: '+15551230000',
  from: '+15557650000',
  mediaStreamUrl: 'wss://voice.example.com/twilio',
});
```

For smaller apps, skip Twilio entirely and register your own `TelephonyProvider`.

### Phone Agents: Bridging a Call to a Realtime Session

A phone agent needs the telephony media stream and a realtime session joined together. The bridge owns
that audio path — caller audio in, assistant audio out, barge-in, playback marks, and stream lifecycle —
while session configuration, tools, and authorization stay in application code.

```ts
import { createTelephonyRealtimeBridge, twilioRealtimeAudioOptions } from 'nexus-ai-pro/telephony/realtime-bridge';
import { OpenAIWebSocketTransport } from 'nexus-ai-pro/realtime/openai-websocket';
import { createRealtimeSession } from 'nexus-ai-pro/realtime/session';

// One socket per call, from your WebSocket server.
function handleCallSocket(socket: AppWebSocket) {
  const session = createRealtimeSession({
    provider: 'openai',
    model: 'gpt-realtime',
    transport: new OpenAIWebSocketTransport({ apiKey: process.env.OPENAI_API_KEY!, webSocketFactory }),
    modalities: ['audio'],
    instructions: 'You are a scheduling assistant.',
    tools: [checkAvailability, createBooking],
    // Telephony audio is 8 kHz G.711 mu-law; this passes it through untranscoded.
    audio: twilioRealtimeAudioOptions({ output: { voice: 'alloy' } }),
  });

  const bridge = createTelephonyRealtimeBridge({
    session,
    telephony,
    send: (message) => socket.send(message.body),
    onStart: (event) => logger.info(`call ${event.callId} started for ${event.parameters?.tenant}`),
    onStop: () => persistTranscript(session.export('json')),
    onError: (error) => logger.error(error),
  });

  socket.on('message', (raw) => bridge.handleMessage(String(raw)));
  socket.on('close', () => bridge.close());
}
```

The bridge feeds only inbound caller audio to the model, so an echoed outbound track never loops back.
On caller speech it clears audio already queued at the provider and cancels the in-flight response, which
is what stops the assistant talking over an interruption. Custom `<Parameter>` values from the stream
instruction are exposed as `bridge.parameters` for tenant and worker routing.

Pass `bargeIn: false` to keep queued audio playing, `autoConnect: false` to connect the session yourself,
and `await bridge.flush()` when you need outstanding sends to settle.

### Call Control and Usage Metering

Meter billable time from the provider's own record rather than from stream lifecycle events, which do not
account for ring time or provider-side teardown:

```ts
// From your status webhook.
const status = ai.parseTelephonyStatusCallback('twilio', requestBody);
if (status?.status === 'completed') {
  await usage.recordCallMinutes({ callId: status.callId, seconds: status.durationSeconds ?? 0 });
}

// Or read it directly, and hang up from a tool.
const details = await ai.getCall({ callId });
await ai.endCall({ callId });
```

### Pointing a Number at Your Webhook

```ts
const [number] = await ai.listPhoneNumbers({ phoneNumber: '+15557650000' });
await ai.updatePhoneNumber({
  id: number.id,
  voiceUrl: 'https://api.example.com/voice/incoming',
  statusCallbackUrl: 'https://api.example.com/voice/status',
});
```

## Validating webhooks

A provider signs every webhook request, and skipping the check lets anyone drive your call flow.
`ai.validateTelephonyWebhook()` takes a `TelephonyWebhookValidationRequest`: the full public `url`
the provider called, exactly as configured and with its query string, the method, the headers with
the signature, the body raw or parsed, query `params` when the body was not what was signed, and an
`authToken` to use instead of the configured one.

```ts
const valid = await ai.validateTelephonyWebhook({
  url: 'https://api.example.com/voice/incoming',
  headers: Object.fromEntries(request.headers),
  body: await request.text(),
});
if (!valid) return new Response('Forbidden', { status: 403 });
```

## Webhook responses

`TelephonyResponseRequest` describes the answer to a call webhook, rendered into the provider's
markup: `say` text, `playUrl` audio, a `TelephonyGatherConfig` to collect speech or keypad digits —
what to listen for, where to post it, timeouts, language, the key that finishes input, how many
digits, and prompts spoken while listening — a `TelephonyStreamConfig` to open a media stream, a
redirect, a pause, and a hangup. A stream config has the WebSocket `url`, a `TelephonyStreamMode` —
`unidirectional` sends the caller's audio to you, `bidirectional` also carries audio back — a name,
a `TelephonyStreamTrack` (`inbound`, `outbound`, or `both`), a status callback with its
`TelephonyHttpMethod`, and custom `parameters` delivered in the stream's start event.

The answer comes back as a `TelephonyWebhookResponse`: the provider, the content type, and the body
to return. `createVoiceTwiML()` renders TwiML directly, without a client, escaping every value.

## Calls

`CreateCallRequest` places a call: `to` and `from` in E.164 form, and one way to handle it — a
`webhookUrl`, inline `twiml`, an `applicationSid`, or a `mediaStreamUrl` — with a status callback,
recording, a ring timeout, answering-machine detection, and a signal. `CreateCallResponse` returns
the call id and its first `TelephonyCallStatus`, usually `queued`; the statuses run through
`ringing`, `in-progress`, and `completed`, or end in `busy`, `failed`, `no-answer`, or `canceled`.

`GetCallRequest` and `EndCallRequest` name a call by id; ending one takes `completed` to hang up or
`canceled` to drop a call that has not been answered. Both return `TelephonyCallDetails`: status,
`TelephonyCallDirection` (`inbound` or `outbound`), numbers, times, and `durationSeconds` and the
price once the call has ended. `ai.parseTelephonyStatusCallback()` turns a status webhook into a
`TelephonyStatusCallback` with the same fields and why the call ended.

## Phone numbers

`ListPhoneNumbersRequest` filters to one number and sets a page size. Each `TelephonyPhoneNumber`
has the provider-side `id` used to update it, the number, its label, where it sends inbound calls,
status events, and SMS, and whether it can do voice, SMS, and MMS. `UpdatePhoneNumberRequest`
changes any of those, which is how a number is pointed at your agent.

## Media streams

A media stream WebSocket carries `TelephonyMediaStreamEvent` values, discriminated on `event`, and
`ai.parseTelephonyMediaEvent()` normalizes each provider's messages into them:

- `TelephonyConnectedEvent` opens the socket.
- `TelephonyStartEvent` arrives once, before any audio: the stream and call ids, the tracks, the
  media format with its `TelephonyAudioEncoding` — Twilio streams 8 kHz mu-law — and your custom
  parameters.
- `TelephonyMediaEvent` is a chunk of base64 audio with its track, sequence number, and timestamp.
- `TelephonyDtmfEvent` is a key the caller pressed.
- `TelephonyMarkEvent` confirms that audio you sent has finished playing, so you know what the
  caller has heard.
- `TelephonyStopEvent` ends the stream.

`ai.formatTelephonyAudioMessage()` builds what you send back as a `TelephonyOutboundAudioMessage`:
audio, a named mark, or `clear` to drop audio already queued. Its `body` is ready to send on the
socket.

## Providers

A `TelephonyProvider` is `info` and optional methods: create and end calls, render webhook
responses, validate signatures, parse and format stream messages, read calls and status callbacks,
and list and update numbers. `TelephonyProviderInfo.supports` says which exist. `TelephonyConfig` is
the client's `telephony` option: a default provider and the providers by name. `TelephonyManager`
routes each request to the named or default provider, and works without a client.

`TwilioTelephonyProvider` implements all of it. `TwilioTelephonyProviderConfig` takes the account
SID and auth token — the token also validates webhooks — a REST base URL, and a `fetch`.

A provider that fails, or no provider for an operation, raises `TelephonyProviderError`, naming the
provider and carrying the cause; a provider that lacks the operation raises
`TelephonyCapabilityError`.

## The realtime bridge in detail

`TelephonyRealtimeBridgeOptions` takes the realtime `session`, the `telephony` manager
that parses and formats stream messages, the provider name (`twilio` by default), and `send`, awaited
so messages keep their order. `autoConnect` connects the session on the start event, `bargeIn`
cancels speech on interruption, and `autoDisconnect` ends the session when the stream stops — all on
by default — with `onStart`, `onStop`, `onDtmf`, and `onError` hooks; errors are reported, never
thrown at the socket. The `TelephonyRealtimeBridge` it returns exposes the `callId`, `streamId`, and
`parameters` once the stream starts, whether it has `closed`, `handleMessage()`, `flush()`, and
`close()`. `twilioRealtimeAudioOptions()` sets both audio directions to 8 kHz mu-law, so audio passes
through without transcoding.

## Limitations

- Twilio is the only bundled provider; others implement `TelephonyProvider`.
- SMS is not sent or received here; the number settings only point SMS webhooks somewhere.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/telephony`

| Export | Kind | Summary |
| --- | --- | --- |
| `CreateCallRequest` | interface | Places an outbound call. |
| `CreateCallResponse` | interface | A placed outbound call. |
| `createVoiceTwiML` | function | Builds a TwiML voice response: say or gather, play, pause, stream, redirect, and hang up, as the request asks. |
| `EndCallRequest` | interface | Ends a call. |
| `GetCallRequest` | interface | Looks up one call. |
| `ListPhoneNumbersRequest` | interface | Lists the phone numbers you own. |
| `TelephonyAudioEncoding` | type | How a media stream encodes audio. |
| `TelephonyCallDetails` | interface | A call as the provider currently reports it. |
| `TelephonyCallDirection` | type | Whether a call came in to one of your numbers or was placed by your application. |
| `TelephonyCallStatus` | type | Where a call is in its lifecycle, normalized across providers. |
| `TelephonyCapabilityError` | class | Raised when a provider does not support an operation. |
| `TelephonyConfig` | interface | Telephony providers available to a client. |
| `TelephonyConnectedEvent` | interface | The first message on a media stream WebSocket. |
| `TelephonyDtmfEvent` | interface | A keypad digit the caller pressed during a stream. |
| `TelephonyGatherConfig` | interface | Collects spoken input or keypad digits from the caller. |
| `TelephonyHttpMethod` | type | HTTP method a provider uses to call your webhook. |
| `TelephonyManager` | class | Routes telephony operations to registered providers: the one a request names, the configured default, or the first that supports the operation. |
| `TelephonyMarkEvent` | interface | Confirms that audio you sent has finished playing, so you know what the caller has heard. |
| `TelephonyMediaEvent` | interface | A chunk of call audio. |
| `TelephonyMediaStreamEvent` | type | Any message a provider sends on a media stream WebSocket, discriminated on `event`. |
| `TelephonyOutboundAudioMessage` | interface | A message to send down a media stream WebSocket: audio for the caller, a mark to be told when it has played, or `clear` to stop audio already queued. |
| `TelephonyPhoneNumber` | interface | A phone number you own at a provider, with where it sends calls and messages. |
| `TelephonyProvider` | interface | A telephony provider: places and ends calls, renders webhook responses, validates webhook signatures, and speaks the media stream protocol. |
| `TelephonyProviderError` | class | Raised when a telephony provider fails, or none is registered for an operation. |
| `TelephonyProviderInfo` | interface | What a telephony provider supports, so an application can check before relying on a feature. |
| `TelephonyResponseRequest` | interface | What to answer a provider's call webhook with: speech, audio, input collection, a media stream, a redirect, or a hangup. |
| `TelephonyStartEvent` | interface | Metadata for a media stream, sent once before any audio. |
| `TelephonyStatusCallback` | interface | A parsed provider status webhook. |
| `TelephonyStopEvent` | interface | The last message on a media stream, sent when the stream or the call ends. |
| `TelephonyStreamConfig` | interface | Opens a live media stream of the call's audio to a WebSocket you run. |
| `TelephonyStreamMode` | type | Whether a media stream only sends caller audio to you, or also carries audio back to the caller. |
| `TelephonyStreamTrack` | type | Which side of the call a media stream carries: the caller, your application, or both. |
| `TelephonyWebhookResponse` | interface | A rendered webhook response, ready to return from your HTTP handler. |
| `TelephonyWebhookValidationRequest` | interface | Checks that a webhook request really came from the provider. |
| `UpdatePhoneNumberRequest` | interface | Changes where a number sends calls, status updates, and messages. |

### `nexus-ai-pro/telephony/realtime-bridge`

| Export | Kind | Summary |
| --- | --- | --- |
| `createTelephonyRealtimeBridge` | function | Connects a provider media stream to a realtime session: caller audio in, assistant audio out, barge-in, playback marks, and stream lifecycle. |
| `TelephonyRealtimeBridge` | interface | A phone call connected to a realtime voice session: caller audio goes to the model, and the model's audio goes back to the caller. |
| `TelephonyRealtimeBridgeOptions` | interface | Options for `createTelephonyRealtimeBridge()`. |
| `twilioRealtimeAudioOptions` | function | Audio settings that match what Twilio Media Streams actually send and accept: 8 kHz G.711 µ-law. |

### `nexus-ai-pro/telephony/twilio`

| Export | Kind | Summary |
| --- | --- | --- |
| `TwilioTelephonyProvider` | class | Twilio Programmable Voice: outbound calls, TwiML webhooks, call control, phone numbers, and bidirectional Media Streams. |
| `TwilioTelephonyProviderConfig` | interface | Options for the Twilio telephony provider. |
<!-- reference:end -->
