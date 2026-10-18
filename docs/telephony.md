# Telephony

<!-- covers: ./telephony ./telephony/realtime-bridge ./telephony/twilio ./telephony/telnyx -->

Phone calls and text messages, from `nexus-ai-pro/telephony`: place and answer calls, transfer
them, put them in conferences, record them and keep the recordings under a retention policy, send
and receive messages, manage phone numbers, and handle media streams. Two providers ship, each on
its own protocol: Twilio, on `nexus-ai-pro/telephony/twilio`, answered with markup, and Telnyx, on
`nexus-ai-pro/telephony/telnyx`, controlled by command. To put a voice agent on a call,
`nexus-ai-pro/telephony/realtime-bridge` connects the call to a realtime session, on either.
A SIP trunk can also send calls to OpenAI directly, with no media stream to relay: see
[Phone calls over SIP](realtime.md#phone-calls-over-sip).

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

### One answer on either provider

Twilio answers a call webhook with TwiML; Telnyx answers it with commands sent to the call, and the
webhook returns nothing. `ai.telephony.answer()` takes an `AnswerCallRequest`, the call's id and a
`TelephonyResponseRequest`, and does the right thing on each: it renders the markup on Twilio, and
runs the commands on Telnyx. Return what it resolves to from the webhook, whichever provider called:

```ts
const reply = await ai.telephony.answer({
  provider,                       // 'twilio' or 'telnyx'
  callId,
  say: 'Connecting you to the assistant.',
  stream: { url: 'wss://voice.example.com/media', mode: 'bidirectional' },
});
return new Response(reply.body, { headers: { 'content-type': reply.contentType } });
```

`ai.telephony` is the client's `TelephonyManager`, for everything the client's own methods leave out:
answering, transfer, conferences, recordings, and messages.

### Transfer and conferences

`transferCall()` takes a `TransferCallRequest` and moves a call to a number or a `sip:` address: the
caller leaves your application for whoever answers. It resolves to a `TelephonyTransfer`.
`joinConference()` takes a `JoinConferenceRequest`, a conference's name and how the call joins it,
as a `TelephonyConferenceConfig`: whether the conference starts when it joins and ends when it
leaves, whether it is muted, and whether a tone plays. Every call that joins the same name meets in
the same conference, created by the first; it resolves to a `TelephonyConferenceJoin`. On Twilio both
replace the live call's TwiML with a `<Dial>`; on Telnyx both are commands.

A webhook answer can dial as well: `dial`, a `TelephonyDialConfig`, connects the caller to a number,
a SIP address, or a conference, with the number shown and how long it rings.

```ts
// A tool the agent calls when the caller asks for a person.
await ai.telephony.transferCall({ provider, callId, to: '+15551230000' });
// Or bring a supervisor into the call.
await ai.telephony.joinConference({ provider, callId, name: `call-${callId}`, endOnExit: true });
```

### Recordings, kept on your terms

`startRecording()` takes a `StartRecordingRequest` (the call, one channel or one per side, and where
Twilio reports the recording) and resolves to a `TelephonyRecordingStarted`; `stopRecording()` takes
a `StopRecordingRequest`. The provider then reports the finished recording to your webhook:
`parseRecordingCallback()` turns that into a `TelephonyRecording`, with where its audio is and how
long it runs. `downloadRecording()` takes a `DownloadRecordingRequest` and fetches its audio as a
`TelephonyRecordingAudio`, and `deleteRecording()` a `DeleteRecordingRequest`.

`recordingKeeper()` does all of that under a retention policy. Given the telephony client, an
`AssetStore` (in memory, on disk, or an S3 bucket), and a `RecordingRetention` in days or seconds, the
`RecordingKeeper` it returns keeps each recording a callback reports: it fetches the audio, stores it
to expire when the policy says, and deletes the provider's copy, so the recording is kept in one
place, for as long as you decided. `sweep()` removes what has expired. A callback the provider retries
keeps its recording once; a recording that fails to keep is kept on the retry.

```ts
import { recordingKeeper } from 'nexus-ai-pro/telephony';

const recordings = recordingKeeper({
  telephony: ai.telephony,
  store: new S3AssetStore({ client, bucket: 'call-recordings' }),
  retention: { days: 30 },
  tenantId: (recording) => tenantOfCall(recording.callId),
});
// The recording webhook:
const kept = await recordings.handle(provider, await request.text());
// Every night:
await recordings.sweep();
```

Each `KeptRecording` names its asset, its tenant, when it expires, and whether the provider's copy
was deleted. `RecordingKeeperOptions` also takes `deleteFromProvider: false`, and `claim` and
`release` backed by a shared store, for replicas that take the same callback.

### Messages

`sendMessage()` sends an SMS, or an MMS with `mediaUrls`, from a `SendMessageRequest`, and resolves to
a `TelephonyMessage`: its id, its numbers, its text and media, how many segments it was billed as,
and its `TelephonyMessageStatus`. A message is its own operation family in the client's lifecycle,
`messaging`, so a budget or a rate limit holds messages apart from calls; one with neither text nor
media is refused before it counts. `parseMessageWebhook()` turns a provider's messaging webhook into
a `TelephonyMessage`: a message `received` by one of your numbers, or a change in one sent's delivery,
from `queued` through `sent` to `delivered`, `undelivered`, or `failed`.

```ts
await ai.telephony.sendMessage({ provider, to: caller, from: ourNumber, body: 'Your table is booked for 7 pm.' });
const message = ai.telephony.parseMessageWebhook(provider, await request.text());
if (message?.direction === 'inbound' && /^stop$/i.test(message.body ?? '')) await unsubscribe(message.from);
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

A provider signs every webhook request. Skip the check and anyone can drive your call flow.

```ts
const valid = await ai.validateTelephonyWebhook({
  url: 'https://api.example.com/voice/incoming',
  headers: Object.fromEntries(request.headers),
  body: await request.text(),
});
if (!valid) return new Response('Forbidden', { status: 403 });
```

`ai.validateTelephonyWebhook()` takes a `TelephonyWebhookValidationRequest`:

| Field | What to pass |
| --- | --- |
| `url` | The full public URL the provider called, exactly as configured, with its query string. |
| method, `headers` | The request's, including the signature header. |
| `body` | The body, raw or parsed. |
| `params` | Query parameters, when the body was not what was signed. |
| `authToken` | A token to use instead of the configured one. |
| `publicKey` | For Telnyx, a public key to verify with instead of the configured one. |

Twilio signs with an HMAC of the URL and parameters, under the auth token. Telnyx signs the timestamp
and the raw body with Ed25519, under your account's key pair: the provider verifies it against the
public key with Web Crypto, and refuses a webhook more than five minutes old. Pass Telnyx's body
exactly as it arrived.

## Webhook responses

`TelephonyResponseRequest` describes how to answer a call webhook. It is rendered into the provider's
markup. Combine any of these:

| Field | What the caller gets |
| --- | --- |
| `say` | Spoken text. |
| `playUrl` | Audio played from a URL. |
| `gather` | A `TelephonyGatherConfig` that collects speech or keypad digits: what to listen for, where to post it, timeouts, language, the key that ends input, how many digits, and prompts spoken while listening. |
| `stream` | A `TelephonyStreamConfig` that opens a media stream, below. |
| `dial` | A `TelephonyDialConfig` that connects the caller to a number, a SIP address, or a conference. |
| redirect, pause, hangup | Call flow. |

A `TelephonyStreamConfig` has:

- the WebSocket `url`;
- a `TelephonyStreamMode`: `unidirectional` sends the caller's audio to you, and `bidirectional` also
  carries your audio back;
- a `TelephonyStreamTrack`: `inbound`, `outbound`, or `both`;
- a name, and a status callback with its `TelephonyHttpMethod`;
- custom `parameters`, delivered in the stream's start event.

The answer comes back as a `TelephonyWebhookResponse`: the provider, the content type, and the body to
return. `createVoiceTwiML()` renders TwiML directly, without a client, escaping every value.

## Calls

`CreateCallRequest` places a call. Give `to` and `from` in E.164 form, and one way to handle the call:

| Field | Handles the call with |
| --- | --- |
| `webhookUrl` | Your webhook, asked what to do. |
| `twiml` | Inline TwiML. |
| `applicationSid` | A Twilio application. |
| `mediaStreamUrl` | A media stream to your WebSocket. |

Optional fields add a status callback, recording, a ring timeout, answering-machine detection, and a
signal. `CreateCallResponse` returns the call id and its first status.

A `TelephonyCallStatus` is usually `queued` first, then `ringing`, `in-progress`, and `completed`. A
call can also end `busy`, `failed`, `no-answer`, or `canceled`.

`GetCallRequest` and `EndCallRequest` name a call by id. Ending takes `completed` to hang up, or
`canceled` to drop a call that has not been answered. Both return `TelephonyCallDetails`:

- the status, and the `TelephonyCallDirection` (`inbound` or `outbound`);
- the numbers and times;
- `durationSeconds` and the price, once the call has ended.

`ai.parseTelephonyStatusCallback()` turns a status webhook into a `TelephonyStatusCallback`, with the
same fields and why the call ended.

## Phone numbers

`ListPhoneNumbersRequest` filters to one number and sets a page size. Each `TelephonyPhoneNumber` has:

- the provider-side `id`, used to update it;
- the number and its label;
- where it sends inbound calls, status events, and SMS;
- whether it can do voice, SMS, and MMS.

`UpdatePhoneNumberRequest` changes any of those. That is how you point a number at your agent.

## Media streams

A media stream carries `TelephonyMediaStreamEvent` values, told apart by `event`.
`ai.parseTelephonyMediaEvent()` turns each provider's messages into them:

| Event | Meaning |
| --- | --- |
| `TelephonyConnectedEvent` | The socket opened. |
| `TelephonyStartEvent` | Arrives once, before any audio: the stream and call ids, the tracks, the media format and its `TelephonyAudioEncoding`, and your custom parameters. Twilio streams 8 kHz mu-law. |
| `TelephonyMediaEvent` | A chunk of base64 audio, with its track, sequence number, and timestamp. |
| `TelephonyDtmfEvent` | The caller pressed a key. |
| `TelephonyMarkEvent` | Audio you sent has finished playing, so you know what the caller heard. |
| `TelephonyStopEvent` | The stream ended. |

`ai.formatTelephonyAudioMessage()` builds what you send back, as a `TelephonyOutboundAudioMessage`:
audio, a named mark, or `clear` to drop audio already queued. Its `body` is ready to send on the socket.

## Providers

A `TelephonyProvider` has an `info` and optional methods: create and end calls, render webhook
responses, validate signatures, parse and format stream messages, read calls and status callbacks, and
list and update numbers. `TelephonyProviderInfo.supports` says which methods exist.

`TelephonyConfig` is the client's `telephony` option: a default provider, and providers by name.
`TelephonyManager` routes each request to the named or default provider. It also works without a
client.

The calls that reach the provider's API — creating, reading, and ending calls, and listing and
updating numbers — run through the client's [lifecycle](./lifecycle.md). Each is authorized,
audited, and counted, and each provider method receives the call's `ProviderCallContext` as its
second argument. Rendering a webhook response and parsing a message are local, so they do not.

`TwilioTelephonyProvider` implements all of it. `TwilioTelephonyProviderConfig` takes the account SID
and auth token (the token also validates webhooks), a REST base URL, and a `fetch`.

`TelnyxTelephonyProvider` implements all of it too, on Telnyx's Call Control API. Its
`TelnyxTelephonyProviderConfig` takes the API key, the Call Control application calls are placed
through, the messaging profile messages are sent through, the public key webhooks are verified with,
the voice and language it speaks in, a base URL, a `fetch`, and a clock. It runs on any runtime with
`fetch` and Web Crypto. `TelephonyProviderInfo.supports` says, for each provider, whether it
transfers, conferences, records, and messages.

Two errors cover failures. `TelephonyProviderError` means a provider failed, or none was configured
for the operation; it names the provider and carries the cause. `TelephonyCapabilityError` means the
provider lacks the operation.

## The realtime bridge in detail

`TelephonyRealtimeBridgeOptions`:

| Option | Default | What it does |
| --- | --- | --- |
| `session` | — | The realtime session. |
| `telephony` | — | The manager that parses and formats stream messages. |
| provider | `twilio` | Which provider's messages these are. |
| `send` | — | Sends a message on the socket. Awaited, so messages keep their order. |
| `autoConnect` | on | Connects the session on the start event. |
| `bargeIn` | on | Cancels the assistant's speech when the caller talks. |
| `autoDisconnect` | on | Ends the session when the stream stops. |
| `onStart`, `onStop`, `onDtmf`, `onError` | — | Hooks. Errors are reported here, never thrown at the socket. |

The returned `TelephonyRealtimeBridge` exposes the `callId`, `streamId`, and `parameters` once the
stream starts, whether it has `closed`, and `handleMessage()`, `flush()`, and `close()`.

`twilioRealtimeAudioOptions()` sets both audio directions to 8 kHz mu-law, so audio passes through
without transcoding. Telnyx streams the same audio, so `telnyxRealtimeAudioOptions()` is the same
setting, under its name; pass `provider: 'telnyx'` to the bridge and it reads Telnyx's messages.

## Proof

In the test suite, one phone agent runs on both providers against stand-ins for their APIs. A call
comes in and is answered the same way on each, recorded, and streamed through the bridge to a
realtime session: the caller's audio reaches the model, the model's reaches the caller, and the agent
texts a receipt, as a `messaging` operation, and transfers the call. Its recording is then kept in
memory, on disk, and in an S3 bucket, deleted at the provider, and kept once when the callback comes
again; the day before its 30 days end it is there, and the day after a sweep removes it.

## Limitations

- Twilio and Telnyx are the bundled providers; another implements `TelephonyProvider`.
- On Telnyx, a gather collects keypad digits, not speech, and there is no redirect to another webhook.
  A stream carries no custom parameters, so they ride in its URL, which your socket server reads.
- On Telnyx, a number's calls go to its Call Control application and its messages to its messaging
  profile, so updating a number's `voiceUrl` or `smsUrl` changes them for every number that shares
  them.
- Two calls joining a Telnyx conference that does not exist yet at the same moment may make two.
- The recording keeper remembers what it kept in its process by default; replicas that take the same
  callback need a shared `claim`.
- Calls and messages are verified against stand-ins for the providers' APIs. The weekly live workflow
  lists each provider's phone numbers, where the repository's secrets are set; it places no call and
  sends no message, which would cost money.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/telephony`

| Export | Kind | Summary |
| --- | --- | --- |
| `AnswerCallRequest` | interface | Answers a call by its id: what to say, play, collect, stream, or dial, as commands on the call. |
| `CreateCallRequest` | interface | Places an outbound call. |
| `CreateCallResponse` | interface | A placed outbound call. |
| `createVoiceTwiML` | function | Builds a TwiML voice response: say or gather, play, pause, stream, dial, redirect, and hang up, as the request asks. |
| `DeleteRecordingRequest` | interface | Deletes a recording at the provider, once it is kept elsewhere. |
| `DownloadRecordingRequest` | interface | Fetches a recording's audio from the provider. |
| `EndCallRequest` | interface | Ends a call. |
| `GetCallRequest` | interface | Looks up one call. |
| `JoinConferenceRequest` | interface | Puts a call into a conference. |
| `KeptRecording` | interface | A recording kept. |
| `ListPhoneNumbersRequest` | interface | Lists the phone numbers you own. |
| `recordingKeeper` | function | Keeps call recordings in an asset store under a retention policy. |
| `RecordingKeeper` | interface | Call recordings kept under a retention policy, from `recordingKeeper()`. |
| `RecordingKeeperOptions` | interface | Options for `recordingKeeper()`. |
| `RecordingRetention` | interface | How long a recording is kept. |
| `SendMessageRequest` | interface | Sends a text message, with media for MMS. |
| `StartRecordingRequest` | interface | Starts recording a call. |
| `StopRecordingRequest` | interface | Stops a call's recording. |
| `TelephonyAudioEncoding` | type | How a media stream encodes audio. |
| `TelephonyCallDetails` | interface | A call as the provider currently reports it. |
| `TelephonyCallDirection` | type | Whether a call came in to one of your numbers or was placed by your application. |
| `TelephonyCallStatus` | type | Where a call is in its lifecycle, normalized across providers. |
| `TelephonyCapabilityError` | class | Raised when a provider does not support an operation. |
| `TelephonyConferenceConfig` | interface | A conference a call joins, created by the first call to join it. |
| `TelephonyConferenceJoin` | interface | A call in a conference. |
| `TelephonyConfig` | interface | Telephony providers available to a client. |
| `TelephonyConnectedEvent` | interface | The first message on a media stream WebSocket. |
| `TelephonyDialConfig` | interface | Connects the caller to someone else: a number, a SIP address, or a conference. |
| `TelephonyDtmfEvent` | interface | A keypad digit the caller pressed during a stream. |
| `TelephonyGatherConfig` | interface | Collects spoken input or keypad digits from the caller. |
| `TelephonyHttpMethod` | type | HTTP method a provider uses to call your webhook. |
| `TelephonyManager` | class | Routes telephony operations to registered providers: the one a request names, the configured default, or the first that supports the operation. |
| `TelephonyMarkEvent` | interface | Confirms that audio you sent has finished playing, so you know what the caller has heard. |
| `TelephonyMediaEvent` | interface | A chunk of call audio. |
| `TelephonyMediaStreamEvent` | type | Any message a provider sends on a media stream WebSocket, discriminated on `event`. |
| `TelephonyMessage` | interface | A text message: one sent, one received, or a change in one's delivery. |
| `TelephonyMessageStatus` | type | Where a text message is in its delivery, normalized across providers. |
| `TelephonyOutboundAudioMessage` | interface | A message to send down a media stream WebSocket: audio for the caller, a mark to be told when it has played, or `clear` to stop audio already queued. |
| `TelephonyPhoneNumber` | interface | A phone number you own at a provider, with where it sends calls and messages. |
| `TelephonyProvider` | interface | A telephony provider: places and ends calls, renders webhook responses, validates webhook signatures, and speaks the media stream protocol. |
| `TelephonyProviderError` | class | Raised when a telephony provider fails, or none is registered for an operation. |
| `TelephonyProviderInfo` | interface | What a telephony provider supports, so an application can check before relying on a feature. |
| `TelephonyRecording` | interface | A finished recording, as the provider reports it: where its audio can be fetched from. |
| `TelephonyRecordingAudio` | interface | A recording's audio. |
| `TelephonyRecordingStarted` | interface | A recording started. |
| `TelephonyResponseRequest` | interface | What to answer a provider's call webhook with: speech, audio, input collection, a media stream, a dial, a redirect, or a hangup. |
| `TelephonyStartEvent` | interface | Metadata for a media stream, sent once before any audio. |
| `TelephonyStatusCallback` | interface | A parsed provider status webhook. |
| `TelephonyStopEvent` | interface | The last message on a media stream, sent when the stream or the call ends. |
| `TelephonyStreamConfig` | interface | Opens a live media stream of the call's audio to a WebSocket you run. |
| `TelephonyStreamMode` | type | Whether a media stream only sends caller audio to you, or also carries audio back to the caller. |
| `TelephonyStreamTrack` | type | Which side of the call a media stream carries: the caller, your application, or both. |
| `TelephonyTransfer` | interface | A call transferred. |
| `TelephonyWebhookResponse` | interface | A rendered webhook response, ready to return from your HTTP handler. |
| `TelephonyWebhookValidationRequest` | interface | Checks that a webhook request really came from the provider. |
| `TransferCallRequest` | interface | Moves a call to another number or SIP address. |
| `UpdatePhoneNumberRequest` | interface | Changes where a number sends calls, status updates, and messages. |

### `nexus-ai-pro/telephony/realtime-bridge`

| Export | Kind | Summary |
| --- | --- | --- |
| `createTelephonyRealtimeBridge` | function | Connects a provider media stream to a realtime session: caller audio in, assistant audio out, barge-in, playback marks, and stream lifecycle. |
| `TelephonyRealtimeBridge` | interface | A phone call connected to a realtime voice session: caller audio goes to the model, and the model's audio goes back to the caller. |
| `TelephonyRealtimeBridgeOptions` | interface | Options for `createTelephonyRealtimeBridge()`. |
| `telnyxRealtimeAudioOptions` | function | Audio settings that match what Telnyx media streams send and accept: 8 kHz G.711 µ-law, as Twilio's do. |
| `twilioRealtimeAudioOptions` | function | Audio settings that match what Twilio Media Streams actually send and accept: 8 kHz G.711 µ-law. |

### `nexus-ai-pro/telephony/telnyx`

| Export | Kind | Summary |
| --- | --- | --- |
| `TelnyxTelephonyProvider` | class | Telnyx Call Control and Messaging: outbound calls, calls answered by command, transfer, conferences, recordings, phone numbers, bidirectional media streams, and SMS and MMS. |
| `TelnyxTelephonyProviderConfig` | interface | Options for the Telnyx telephony provider. |

### `nexus-ai-pro/telephony/twilio`

| Export | Kind | Summary |
| --- | --- | --- |
| `TwilioTelephonyProvider` | class | Twilio Programmable Voice and Messaging: outbound calls, TwiML webhooks, call control, transfer, conferences, recordings, phone numbers, bidirectional Media Streams, and SMS and MMS. |
| `TwilioTelephonyProviderConfig` | interface | Options for the Twilio telephony provider. |
<!-- reference:end -->
