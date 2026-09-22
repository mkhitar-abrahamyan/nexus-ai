/** Whether a call came in to one of your numbers or was placed by your application. */
export type TelephonyCallDirection = 'inbound' | 'outbound';

/** Where a call is in its lifecycle, normalized across providers. */
export type TelephonyCallStatus =
  | 'queued'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'busy'
  | 'failed'
  | 'no-answer'
  | 'canceled'
  | 'unknown';

/** HTTP method a provider uses to call your webhook. */
export type TelephonyHttpMethod = 'GET' | 'POST';
/**
 * Whether a media stream only sends caller audio to you, or also carries audio back to the caller.
 */
export type TelephonyStreamMode = 'unidirectional' | 'bidirectional';
/** Which side of the call a media stream carries: the caller, your application, or both. */
export type TelephonyStreamTrack = 'inbound' | 'outbound' | 'both';
/** How a media stream encodes audio. Twilio streams 8 kHz mu-law. */
export type TelephonyAudioEncoding = 'audio/x-mulaw' | 'audio/l16' | 'audio/opus' | string;

/** What a telephony provider supports, so an application can check before relying on a feature. */
export interface TelephonyProviderInfo {
  /** The provider's registered name, such as `twilio`. */
  name: string;
  /** True for a provider that runs locally, such as a test double. */
  isLocal?: boolean;
  /** Features the provider implements. */
  supports?: {
    inbound?: boolean;
    outbound?: boolean;
    mediaStreams?: boolean;
    bidirectionalStreams?: boolean;
    webhookValidation?: boolean;
    callControl?: boolean;
    phoneNumbers?: boolean;
  };
}

/** Opens a live media stream of the call's audio to a WebSocket you run. */
export interface TelephonyStreamConfig {
  /** WebSocket URL the provider connects to. Must be `wss://` for Twilio. */
  url: string;
  /** `bidirectional` lets you send audio back into the call, which a voice agent needs. */
  mode?: TelephonyStreamMode;
  /** Name for the stream, reported back in its events. */
  name?: string;
  /** Which side of the call to stream. Bidirectional streams always carry the caller. */
  track?: TelephonyStreamTrack;
  /** Where the provider reports the stream's start and stop. */
  statusCallbackUrl?: string;
  /** HTTP method for `statusCallbackUrl`. */
  statusCallbackMethod?: TelephonyHttpMethod;
  /** Custom parameters delivered to your WebSocket in the stream's `start` event. */
  parameters?: Record<string, string | number | boolean>;
}

/** Collects spoken input or keypad digits from the caller. */
export interface TelephonyGatherConfig {
  /** What to listen for: speech, keypad digits, or both. */
  input?: Array<'speech' | 'dtmf'>;
  /** Where the provider posts what it collected. */
  actionUrl?: string;
  /** HTTP method for `actionUrl`. */
  method?: TelephonyHttpMethod;
  /** Seconds to wait for the caller to start. */
  timeoutSeconds?: number;
  /** Seconds of silence that end speech input, or `auto` to let the provider decide. */
  speechTimeout?: 'auto' | number;
  /** Language of the expected speech, as a BCP-47 tag. */
  language?: string;
  /** Keypad key that ends digit input early. */
  finishOnKey?: string;
  /** Digits to collect before posting. */
  numDigits?: number;
  /** Text spoken to the caller while listening. */
  prompts?: string[];
}

/**
 * What to answer a provider's call webhook with: speech, audio, input collection, a media stream, a
 * redirect, or a hangup. Rendered into the provider's markup, such as TwiML.
 */
export interface TelephonyResponseRequest {
  /** Provider to render for. Defaults to the configured default. */
  provider?: string;
  /** The call being answered, for records. */
  callId?: string;
  /** Caller number, for records. */
  from?: string;
  /** Called number, for records. */
  to?: string;
  /** Text spoken to the caller, one element per sentence or paragraph. */
  say?: string | string[];
  /** Audio files played to the caller, in order. */
  playUrl?: string | string[];
  /** Collects speech or digits after speaking. */
  gather?: TelephonyGatherConfig;
  /** Streams the call's audio to a WebSocket, for a realtime voice agent. */
  stream?: TelephonyStreamConfig;
  /** Hands the call to another webhook. */
  redirectUrl?: string;
  /** HTTP method for `redirectUrl`. */
  redirectMethod?: TelephonyHttpMethod;
  /** Silence inserted before the rest of the response, in seconds. */
  pauseSeconds?: number;
  /** Ends the call after everything else. */
  hangup?: boolean;
  /** Application data, not sent to the provider. */
  metadata?: Record<string, unknown>;
}

/** A rendered webhook response, ready to return from your HTTP handler. */
export interface TelephonyWebhookResponse {
  /** Provider the response was rendered for. */
  providerUsed: string;
  /** Content type to send, such as `text/xml` for TwiML. */
  contentType: string;
  /** The response body. */
  body: string;
  /** The provider-specific structure the body was rendered from. */
  raw?: unknown;
}

/** Places an outbound call. */
export interface CreateCallRequest {
  /** Provider to place the call through. Defaults to the configured default. */
  provider?: string;
  /** Number to call, in E.164 form. */
  to: string;
  /** Your number the call comes from, in E.164 form. */
  from: string;
  /** Webhook the provider asks for instructions once the call is answered. */
  webhookUrl?: string;
  /** HTTP method for `webhookUrl`. */
  webhookMethod?: TelephonyHttpMethod;
  /** Instructions inline instead of a webhook, in the provider's markup. */
  twiml?: string;
  /** A provider application that handles the call instead of a webhook. */
  applicationSid?: string;
  /** Where the provider reports status changes. */
  statusCallbackUrl?: string;
  /** HTTP method for `statusCallbackUrl`. */
  statusCallbackMethod?: TelephonyHttpMethod;
  /** Streams the call's audio to this WebSocket as soon as it connects. */
  mediaStreamUrl?: string;
  /** Records the call on the provider's side. */
  record?: boolean;
  /** Seconds to let the call ring before giving up. */
  timeoutSeconds?: number;
  /** Answering-machine detection: detect a machine, or wait for the end of its greeting. */
  machineDetection?: 'enable' | 'detect-message-end';
  /** Application data, not sent to the provider. */
  metadata?: Record<string, unknown>;
  /** Aborts the request to place the call. The call may already be ringing. */
  signal?: AbortSignal;
}

/** A placed outbound call. */
export interface CreateCallResponse {
  /** The provider's id for the call. */
  callId: string;
  /** Provider that placed it. */
  providerUsed: string;
  /** Status when the request returned, usually `queued`. */
  status: TelephonyCallStatus;
  /** Always `outbound`. */
  direction: 'outbound';
  /** Number called. */
  to: string;
  /** Number called from. */
  from: string;
  /** The provider's response, unmodified. */
  raw?: unknown;
}

/** Looks up one call. */
export interface GetCallRequest {
  /** Provider the call belongs to. */
  provider?: string;
  /** The provider's id for the call. */
  callId: string;
  /** Aborts the lookup. */
  signal?: AbortSignal;
}

/** Ends a call. */
export interface EndCallRequest {
  /** Provider the call belongs to. */
  provider?: string;
  /** The provider's id for the call. */
  callId: string;
  /** Provider-side end state. `completed` hangs up; `canceled` drops a call that has not been answered. */
  status?: 'completed' | 'canceled';
  /** Aborts the request. */
  signal?: AbortSignal;
}

/**
 * A call as the provider currently reports it. `durationSeconds` is the field billing should meter on;
 * it is only populated once the provider considers the call finished.
 */
export interface TelephonyCallDetails {
  /** The provider's id for the call. */
  callId: string;
  /** Provider the call belongs to. */
  providerUsed: string;
  /** Current status. */
  status: TelephonyCallStatus;
  /** Inbound or outbound. */
  direction?: TelephonyCallDirection;
  /** Caller number. */
  from?: string;
  /** Called number. */
  to?: string;
  /** Call length in seconds, once it has ended. */
  durationSeconds?: number;
  /** ISO-8601 time the call was answered. */
  startedAt?: string;
  /** ISO-8601 time the call ended. */
  endedAt?: string;
  /** What the provider charged, as it reported it. */
  price?: number;
  /** Currency of `price`. */
  priceUnit?: string;
  /** The provider's record, unmodified. */
  raw?: unknown;
}

/**
 * A parsed provider status webhook. Apps that meter usage should prefer this over media-stream
 * lifecycle events, because it is the provider's authoritative record of how long the call ran.
 */
export interface TelephonyStatusCallback {
  /** Provider that sent the callback. */
  providerUsed: string;
  /** The provider's id for the call. */
  callId: string;
  /** The status the call moved to. */
  status: TelephonyCallStatus;
  /** Inbound or outbound. */
  direction?: TelephonyCallDirection;
  /** Caller number. */
  from?: string;
  /** Called number. */
  to?: string;
  /** Call length in seconds, when the call has ended. */
  durationSeconds?: number;
  /** Why the call ended, when the provider says. */
  endedReason?: string;
  /** The callback payload, unmodified. */
  raw?: unknown;
}

/** A phone number you own at a provider, with where it sends calls and messages. */
export interface TelephonyPhoneNumber {
  /** Provider-side identifier used to update the number (Twilio: the IncomingPhoneNumber SID). */
  id: string;
  /** Provider the number is at. */
  providerUsed: string;
  /** The number, in E.164 form. */
  phoneNumber: string;
  /** Label shown in the provider's console. */
  friendlyName?: string;
  /** Webhook the provider calls for inbound calls. */
  voiceUrl?: string;
  /** HTTP method for `voiceUrl`. */
  voiceMethod?: TelephonyHttpMethod;
  /** Where the provider reports call status for this number. */
  statusCallbackUrl?: string;
  /** HTTP method for `statusCallbackUrl`. */
  statusCallbackMethod?: TelephonyHttpMethod;
  /** Where the provider currently posts inbound SMS for this number. */
  smsUrl?: string;
  /** HTTP method for `smsUrl`. */
  smsMethod?: TelephonyHttpMethod;
  /** Used when `smsUrl` errors or times out. */
  smsFallbackUrl?: string;
  /** HTTP method for `smsFallbackUrl`. */
  smsFallbackMethod?: TelephonyHttpMethod;
  /** What the number can do: voice, SMS, MMS. */
  capabilities?: {
    voice?: boolean;
    sms?: boolean;
    mms?: boolean;
  };
  /** The provider's record, unmodified. */
  raw?: unknown;
}

/** Lists the phone numbers you own. */
export interface ListPhoneNumbersRequest {
  /** Provider to list. Defaults to the configured default. */
  provider?: string;
  /** Filter to an exact number in E.164 form. */
  phoneNumber?: string;
  /** Numbers per page. */
  pageSize?: number;
  /** Aborts the request. */
  signal?: AbortSignal;
}

/** Changes where a number sends calls, status updates, and messages. */
export interface UpdatePhoneNumberRequest {
  /** Provider the number is at. */
  provider?: string;
  /** Provider-side identifier from {@link TelephonyPhoneNumber.id}. */
  id: string;
  /** New console label. */
  friendlyName?: string;
  /** New webhook for inbound calls: how to point a number at your agent. */
  voiceUrl?: string;
  /** HTTP method for `voiceUrl`. */
  voiceMethod?: TelephonyHttpMethod;
  /**
   * Where the provider posts call status events.
   *
   * This covers the voice leg only. Message delivery receipts are requested per message when
   * sending, rather than being configured on the number.
   */
  statusCallbackUrl?: string;
  /** HTTP method for `statusCallbackUrl`. */
  statusCallbackMethod?: TelephonyHttpMethod;
  /** Where the provider posts inbound SMS sent to this number. */
  smsUrl?: string;
  /** HTTP method for `smsUrl`. */
  smsMethod?: TelephonyHttpMethod;
  /** Used by the provider when {@link smsUrl} errors or times out. */
  smsFallbackUrl?: string;
  /** HTTP method for `smsFallbackUrl`. */
  smsFallbackMethod?: TelephonyHttpMethod;
  /** Aborts the request. */
  signal?: AbortSignal;
}

/**
 * Checks that a webhook request really came from the provider. Twilio signs every request; skipping
 * this check lets anyone drive your call flow.
 */
export interface TelephonyWebhookValidationRequest {
  /** Provider that should have signed it. */
  provider?: string;
  /** The full public URL the provider called, exactly as configured, including the query string. */
  url: string;
  /** HTTP method of the request. */
  method?: TelephonyHttpMethod;
  /** Request headers, including the signature header. */
  headers?: Record<string, string | string[] | undefined>;
  /** The request body, raw or parsed. */
  body?: string | URLSearchParams | Record<string, string | number | boolean | undefined>;
  /** Query parameters, when the body was not the signed payload. */
  params?: Record<string, string | number | boolean | undefined>;
  /** Signing secret. Defaults to the provider's configured auth token. */
  authToken?: string;
  /** Application data, not used for validation. */
  metadata?: Record<string, unknown>;
}

/** The first message on a media stream WebSocket. */
export interface TelephonyConnectedEvent {
  /** Discriminates this event in `TelephonyMediaStreamEvent`. */
  event: 'connected';
  /** Provider that sent it. */
  providerUsed: string;
  /** The message, unmodified. */
  raw?: unknown;
}

/** Metadata for a media stream, sent once before any audio. */
export interface TelephonyStartEvent {
  /** Discriminates this event in `TelephonyMediaStreamEvent`. */
  event: 'start';
  /** Provider that sent it. */
  providerUsed: string;
  /** Identifies the stream; every later event and every message you send carries it. */
  streamId: string;
  /** The call the stream belongs to. */
  callId?: string;
  /** The provider account the call belongs to. */
  accountId?: string;
  /** Which sides of the call the stream carries. */
  tracks?: TelephonyStreamTrack[];
  /** Encoding, sample rate, and channels of the audio. */
  mediaFormat?: {
    encoding?: TelephonyAudioEncoding;
    sampleRate?: number;
    channels?: number;
  };
  /** The custom parameters set in `TelephonyStreamConfig.parameters`. */
  parameters?: Record<string, string>;
  /** The message, unmodified. */
  raw?: unknown;
}

/** A chunk of call audio. */
export interface TelephonyMediaEvent {
  /** Discriminates this event in `TelephonyMediaStreamEvent`. */
  event: 'media';
  /** Provider that sent it. */
  providerUsed: string;
  /** The stream it belongs to. */
  streamId: string;
  /** The call it belongs to. */
  callId?: string;
  /** Which side of the call the audio is from. */
  track?: TelephonyStreamTrack;
  /** Base64-encoded audio in the stream's encoding. */
  payload: string;
  /** Order of this message on the stream, for detecting gaps. */
  sequenceNumber?: number;
  /** Order of this chunk within the track. */
  chunk?: number;
  /** Milliseconds from the start of the stream. */
  timestampMs?: number;
  /** The message, unmodified. */
  raw?: unknown;
}

/** A keypad digit the caller pressed during a stream. */
export interface TelephonyDtmfEvent {
  /** Discriminates this event in `TelephonyMediaStreamEvent`. */
  event: 'dtmf';
  /** Provider that sent it. */
  providerUsed: string;
  /** The stream it belongs to. */
  streamId: string;
  /** The call it belongs to. */
  callId?: string;
  /** The digit pressed. */
  digit: string;
  /** The message, unmodified. */
  raw?: unknown;
}

/** Confirms that audio you sent has finished playing, so you know what the caller has heard. */
export interface TelephonyMarkEvent {
  /** Discriminates this event in `TelephonyMediaStreamEvent`. */
  event: 'mark';
  /** Provider that sent it. */
  providerUsed: string;
  /** The stream it belongs to. */
  streamId: string;
  /** The call it belongs to. */
  callId?: string;
  /** The name you gave the mark when sending it. */
  name: string;
  /** The message, unmodified. */
  raw?: unknown;
}

/** The last message on a media stream, sent when the stream or the call ends. */
export interface TelephonyStopEvent {
  /** Discriminates this event in `TelephonyMediaStreamEvent`. */
  event: 'stop';
  /** Provider that sent it. */
  providerUsed: string;
  /** The stream that ended. */
  streamId: string;
  /** The call it belonged to. */
  callId?: string;
  /** The provider account the call belongs to. */
  accountId?: string;
  /** The message, unmodified. */
  raw?: unknown;
}

/** Any message a provider sends on a media stream WebSocket, discriminated on `event`. */
export type TelephonyMediaStreamEvent =
  | TelephonyConnectedEvent
  | TelephonyStartEvent
  | TelephonyMediaEvent
  | TelephonyDtmfEvent
  | TelephonyMarkEvent
  | TelephonyStopEvent;

/**
 * A message to send down a media stream WebSocket: audio for the caller, a mark to be told when it
 * has played, or `clear` to stop audio already queued.
 */
export interface TelephonyOutboundAudioMessage {
  /** What the message does. */
  event: 'media' | 'mark' | 'clear';
  /** The stream to send on. */
  streamId: string;
  /** The serialized message, ready to send on the socket. */
  body: string;
}

/**
 * A telephony provider: places and ends calls, renders webhook responses, validates webhook
 * signatures, and speaks the media stream protocol. Each method is optional, and `info.supports`
 * says which exist.
 */
export interface TelephonyProvider {
  /** What the provider is and what it supports. */
  readonly info: TelephonyProviderInfo;
  /** Places an outbound call. */
  createCall?(request: CreateCallRequest): Promise<CreateCallResponse>;
  /** Renders a webhook response in the provider's markup. */
  createWebhookResponse?(request: TelephonyResponseRequest): Promise<TelephonyWebhookResponse>;
  /** Checks a webhook request's signature. */
  validateWebhook?(request: TelephonyWebhookValidationRequest): Promise<boolean> | boolean;
  /** Parses a media stream message, or returns `undefined` for one it does not recognize. */
  parseMediaStreamEvent?(message: string | Record<string, unknown>): TelephonyMediaStreamEvent | undefined;
  /** Builds a media stream message: audio, a mark, or a clear. */
  formatAudioMessage?(
    streamId: string,
    payload: string,
    options?: { event?: 'media' | 'mark' | 'clear'; markName?: string },
  ): TelephonyOutboundAudioMessage;
  /** Looks up one call. */
  getCall?(request: GetCallRequest): Promise<TelephonyCallDetails>;
  /** Ends a call. */
  endCall?(request: EndCallRequest): Promise<TelephonyCallDetails>;
  /** Parses a status callback, or returns `undefined` for a body it does not recognize. */
  parseStatusCallback?(
    body: string | URLSearchParams | Record<string, string | number | boolean | undefined>,
  ): TelephonyStatusCallback | undefined;
  /** Lists the phone numbers you own. */
  listPhoneNumbers?(request?: ListPhoneNumbersRequest): Promise<TelephonyPhoneNumber[]>;
  /** Changes where a number sends calls and messages. */
  updatePhoneNumber?(request: UpdatePhoneNumberRequest): Promise<TelephonyPhoneNumber>;
}

/** Telephony providers available to a client. */
export interface TelephonyConfig {
  /** Provider used when a request names none. */
  defaultProvider?: string;
  /** Providers by name. */
  providers?: Record<string, TelephonyProvider>;
}
