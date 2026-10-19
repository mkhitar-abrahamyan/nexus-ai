import type { ProviderCallContext } from './lifecycle.js';
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
    /** Moves a call to another number or SIP address. */
    transfer?: boolean;
    /** Puts calls into conferences. */
    conference?: boolean;
    /** Records calls and hands the recording over. */
    recording?: boolean;
    /** Sends and receives text messages. */
    messaging?: boolean;
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

/** A conference a call joins, created by the first call to join it. */
export interface TelephonyConferenceConfig {
  /** The conference's name: every call that joins the same name meets in it. */
  name: string;
  /** Starts the conference when this call joins. Defaults to true. */
  startOnEnter?: boolean;
  /** Ends the conference for everyone when this call leaves. Defaults to false. */
  endOnExit?: boolean;
  /** Joins without being heard. */
  muted?: boolean;
  /** Plays a tone as calls join and leave. Defaults to the provider's own. */
  beep?: boolean;
}

/** Connects the caller to someone else: a number, a SIP address, or a conference. */
export interface TelephonyDialConfig {
  /** A number in E.164 form, or a `sip:` address. */
  to?: string;
  /** A conference to join instead. */
  conference?: TelephonyConferenceConfig;
  /** The number shown to the one called. Defaults to the call's own. */
  callerId?: string;
  /** Seconds to let the one called ring. */
  timeoutSeconds?: number;
}

/**
 * What to answer a provider's call webhook with: speech, audio, input collection, a media stream, a
 * dial, a redirect, or a hangup. Rendered into the provider's markup, such as TwiML, or run as its
 * commands, on a provider that controls calls by command.
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
  /** Connects the caller to a number, a SIP address, or a conference. */
  dial?: TelephonyDialConfig;
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
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
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
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
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
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
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
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
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
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
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
  /**
   * For a provider that signs with a key pair, such as Telnyx: the public key to verify with,
   * instead of the configured one.
   */
  publicKey?: string;
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

/** Answers a call by its id: what to say, play, collect, stream, or dial, as commands on the call. */
export interface AnswerCallRequest extends TelephonyResponseRequest {
  /** The provider's id for the call. */
  callId: string;
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
  /** Aborts the commands not yet sent. */
  signal?: AbortSignal;
}

/** Moves a call to another number or SIP address. The call leaves your application. */
export interface TransferCallRequest {
  /** Provider the call belongs to. */
  provider?: string;
  /** The provider's id for the call. */
  callId: string;
  /** A number in E.164 form, or a `sip:` address. */
  to: string;
  /** The number shown to the one called. Defaults to the call's own. */
  from?: string;
  /** Seconds to let the one called ring. */
  timeoutSeconds?: number;
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
  /** Aborts the request. */
  signal?: AbortSignal;
}

/** A call transferred. */
export interface TelephonyTransfer {
  /** The provider's id for the call. */
  callId: string;
  /** Provider the call belongs to. */
  providerUsed: string;
  /** Where it went. */
  to: string;
  /** The provider's response, unmodified. */
  raw?: unknown;
}

/** Puts a call into a conference. */
export interface JoinConferenceRequest extends TelephonyConferenceConfig {
  /** Provider the call belongs to. */
  provider?: string;
  /** The provider's id for the call. */
  callId: string;
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
  /** Aborts the request. */
  signal?: AbortSignal;
}

/** A call in a conference. */
export interface TelephonyConferenceJoin {
  /** The provider's id for the call. */
  callId: string;
  /** The conference's name. */
  conference: string;
  /** The provider's id for the conference, when it has one. */
  conferenceId?: string;
  /** Provider the call belongs to. */
  providerUsed: string;
  /** The provider's response, unmodified. */
  raw?: unknown;
}

/** Starts recording a call. */
export interface StartRecordingRequest {
  /** Provider the call belongs to. */
  provider?: string;
  /** The provider's id for the call. */
  callId: string;
  /** One channel for the whole call, or one per side. Defaults to `dual`. */
  channels?: 'single' | 'dual';
  /** Where the provider reports the recording once it is ready, when it reports per request. */
  statusCallbackUrl?: string;
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
  /** Aborts the request. */
  signal?: AbortSignal;
}

/** Stops a call's recording. */
export interface StopRecordingRequest {
  /** Provider the call belongs to. */
  provider?: string;
  /** The provider's id for the call. */
  callId: string;
  /** The recording to stop, on a provider that names them. Defaults to the call's current one. */
  recordingId?: string;
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
  /** Aborts the request. */
  signal?: AbortSignal;
}

/** A recording started. */
export interface TelephonyRecordingStarted {
  /** The provider's id for the call. */
  callId: string;
  /** Provider the call belongs to. */
  providerUsed: string;
  /** The provider's id for the recording, when it gives one at once. */
  recordingId?: string;
  /** The provider's response, unmodified. */
  raw?: unknown;
}

/** A finished recording, as the provider reports it: where its audio can be fetched from. */
export interface TelephonyRecording {
  /** The provider's id for the recording. */
  recordingId: string;
  /** The call it recorded. */
  callId: string;
  /** Provider that made it. */
  providerUsed: string;
  /** Where its audio is, at the provider. */
  url: string;
  /** The audio's format. */
  format?: 'mp3' | 'wav';
  /** How long it is, in seconds. */
  durationSeconds?: number;
  /** One channel, or one per side. */
  channels?: number;
  /** The callback payload, unmodified. */
  raw?: unknown;
}

/** Fetches a recording's audio from the provider. */
export interface DownloadRecordingRequest {
  /** Provider that made it. */
  provider?: string;
  /** The recording, as `parseRecordingCallback()` reported it. */
  recording: TelephonyRecording;
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
  /** Aborts the download. */
  signal?: AbortSignal;
}

/** A recording's audio. */
export interface TelephonyRecordingAudio {
  /** The audio's bytes. */
  bytes: Uint8Array;
  /** Its MIME type, such as `audio/mpeg`. */
  mimeType: string;
}

/** Deletes a recording at the provider, once it is kept elsewhere. */
export interface DeleteRecordingRequest {
  /** Provider that made it. */
  provider?: string;
  /** The provider's id for the recording. */
  recordingId: string;
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
  /** Aborts the request. */
  signal?: AbortSignal;
}

/** Where a text message is in its delivery, normalized across providers. */
export type TelephonyMessageStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'undelivered'
  | 'failed'
  | 'received'
  | 'unknown';

/** Sends a text message, with media for MMS. */
export interface SendMessageRequest {
  /** Provider to send it through. Defaults to the configured default. */
  provider?: string;
  /** Number to send to, in E.164 form. */
  to: string;
  /** Your number it comes from, in E.164 form. */
  from: string;
  /** The text. A message needs text, media, or both. */
  body?: string;
  /** Media sent with it, as public URLs, for MMS. */
  mediaUrls?: string[];
  /** Where the provider reports its delivery. */
  statusCallbackUrl?: string;
  /** Application data, not sent to the provider. */
  metadata?: Record<string, unknown>;
  /** The tenant it is for: its credentials, regions, and budget apply. */
  tenantId?: string;
  /** Aborts the request. */
  signal?: AbortSignal;
}

/** A text message: one sent, one received, or a change in one's delivery. */
export interface TelephonyMessage {
  /** The provider's id for the message. */
  messageId: string;
  /** Provider that carried it. */
  providerUsed: string;
  /** Sent by your application, or received by one of your numbers. */
  direction: 'inbound' | 'outbound';
  /** The number it came from. */
  from?: string;
  /** The number it went to. */
  to?: string;
  /** Its text. */
  body?: string;
  /** Its media, as URLs at the provider. */
  mediaUrls?: string[];
  /** Where it is in its delivery. */
  status: TelephonyMessageStatus;
  /** How many segments it was billed as, when the provider says. */
  segments?: number;
  /** Why it failed, when the provider says. */
  errorCode?: string;
  /** The provider's record, unmodified. */
  raw?: unknown;
}

/**
 * A telephony provider: places and ends calls, renders webhook responses, validates webhook
 * signatures, and speaks the media stream protocol. Each method is optional, and `info.supports`
 * says which exist.
 */
export interface TelephonyProvider {
  /** What the provider is and what it supports. */
  readonly info: TelephonyProviderInfo;
  /** Places an outbound call. `context` carries the operation's id, signal, deadline, and trace headers. */
  createCall?(request: CreateCallRequest, context?: ProviderCallContext): Promise<CreateCallResponse>;
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
  getCall?(request: GetCallRequest, context?: ProviderCallContext): Promise<TelephonyCallDetails>;
  /** Ends a call. */
  endCall?(request: EndCallRequest, context?: ProviderCallContext): Promise<TelephonyCallDetails>;
  /** Parses a status callback, or returns `undefined` for a body it does not recognize. */
  parseStatusCallback?(
    body: string | URLSearchParams | Record<string, string | number | boolean | undefined>,
  ): TelephonyStatusCallback | undefined;
  /** Lists the phone numbers you own. */
  listPhoneNumbers?(request?: ListPhoneNumbersRequest, context?: ProviderCallContext): Promise<TelephonyPhoneNumber[]>;
  /** Changes where a number sends calls and messages. */
  updatePhoneNumber?(request: UpdatePhoneNumberRequest, context?: ProviderCallContext): Promise<TelephonyPhoneNumber>;
  /**
   * Answers a call by command, for a provider whose webhooks are not answered with markup. Resolves
   * to the response the webhook itself returns, which then carries nothing.
   */
  answerCall?(request: AnswerCallRequest, context?: ProviderCallContext): Promise<TelephonyWebhookResponse>;
  /** Moves a call to another number or SIP address. */
  transferCall?(request: TransferCallRequest, context?: ProviderCallContext): Promise<TelephonyTransfer>;
  /** Puts a call into a conference. */
  joinConference?(request: JoinConferenceRequest, context?: ProviderCallContext): Promise<TelephonyConferenceJoin>;
  /** Starts recording a call. */
  startRecording?(request: StartRecordingRequest, context?: ProviderCallContext): Promise<TelephonyRecordingStarted>;
  /** Stops recording a call. */
  stopRecording?(request: StopRecordingRequest, context?: ProviderCallContext): Promise<void>;
  /** Parses a finished recording's callback, or returns `undefined` for a body that is not one. */
  parseRecordingCallback?(body: string | URLSearchParams | Record<string, unknown>): TelephonyRecording | undefined;
  /** Fetches a recording's audio. */
  downloadRecording?(
    request: DownloadRecordingRequest,
    context?: ProviderCallContext,
  ): Promise<TelephonyRecordingAudio>;
  /** Deletes a recording at the provider. */
  deleteRecording?(request: DeleteRecordingRequest, context?: ProviderCallContext): Promise<void>;
  /** Sends a text message. */
  sendMessage?(request: SendMessageRequest, context?: ProviderCallContext): Promise<TelephonyMessage>;
  /**
   * Parses a messaging webhook: a message received, or a change in one sent's delivery. Returns
   * `undefined` for a body that is neither.
   */
  parseMessageWebhook?(body: string | URLSearchParams | Record<string, unknown>): TelephonyMessage | undefined;
}

/** Telephony providers available to a client. */
export interface TelephonyConfig {
  /** Provider used when a request names none. */
  defaultProvider?: string;
  /** Providers by name. */
  providers?: Record<string, TelephonyProvider>;
}
