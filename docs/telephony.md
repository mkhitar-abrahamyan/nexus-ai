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
