export type TelephonyCallDirection = 'inbound' | 'outbound';

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

export type TelephonyHttpMethod = 'GET' | 'POST';
export type TelephonyStreamMode = 'unidirectional' | 'bidirectional';
export type TelephonyStreamTrack = 'inbound' | 'outbound' | 'both';
export type TelephonyAudioEncoding = 'audio/x-mulaw' | 'audio/l16' | 'audio/opus' | string;

export interface TelephonyProviderInfo {
  name: string;
  isLocal?: boolean;
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

export interface TelephonyStreamConfig {
  url: string;
  mode?: TelephonyStreamMode;
  name?: string;
  track?: TelephonyStreamTrack;
  statusCallbackUrl?: string;
  statusCallbackMethod?: TelephonyHttpMethod;
  parameters?: Record<string, string | number | boolean>;
}

export interface TelephonyGatherConfig {
  input?: Array<'speech' | 'dtmf'>;
  actionUrl?: string;
  method?: TelephonyHttpMethod;
  timeoutSeconds?: number;
  speechTimeout?: 'auto' | number;
  language?: string;
  finishOnKey?: string;
  numDigits?: number;
  prompts?: string[];
}

export interface TelephonyResponseRequest {
  provider?: string;
  callId?: string;
  from?: string;
  to?: string;
  say?: string | string[];
  playUrl?: string | string[];
  gather?: TelephonyGatherConfig;
  stream?: TelephonyStreamConfig;
  redirectUrl?: string;
  redirectMethod?: TelephonyHttpMethod;
  pauseSeconds?: number;
  hangup?: boolean;
  metadata?: Record<string, unknown>;
}

export interface TelephonyWebhookResponse {
  providerUsed: string;
  contentType: string;
  body: string;
  raw?: unknown;
}

export interface CreateCallRequest {
  provider?: string;
  to: string;
  from: string;
  webhookUrl?: string;
  webhookMethod?: TelephonyHttpMethod;
  twiml?: string;
  applicationSid?: string;
  statusCallbackUrl?: string;
  statusCallbackMethod?: TelephonyHttpMethod;
  mediaStreamUrl?: string;
  record?: boolean;
  timeoutSeconds?: number;
  machineDetection?: 'enable' | 'detect-message-end';
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface CreateCallResponse {
  callId: string;
  providerUsed: string;
  status: TelephonyCallStatus;
  direction: 'outbound';
  to: string;
  from: string;
  raw?: unknown;
}

export interface GetCallRequest {
  provider?: string;
  callId: string;
  signal?: AbortSignal;
}

export interface EndCallRequest {
  provider?: string;
  callId: string;
  /** Provider-side end state. `completed` hangs up; `canceled` drops a call that has not been answered. */
  status?: 'completed' | 'canceled';
  signal?: AbortSignal;
}

/**
 * A call as the provider currently reports it. `durationSeconds` is the field billing should meter on;
 * it is only populated once the provider considers the call finished.
 */
export interface TelephonyCallDetails {
  callId: string;
  providerUsed: string;
  status: TelephonyCallStatus;
  direction?: TelephonyCallDirection;
  from?: string;
  to?: string;
  durationSeconds?: number;
  startedAt?: string;
  endedAt?: string;
  price?: number;
  priceUnit?: string;
  raw?: unknown;
}

/**
 * A parsed provider status webhook. Apps that meter usage should prefer this over media-stream
 * lifecycle events, because it is the provider's authoritative record of how long the call ran.
 */
export interface TelephonyStatusCallback {
  providerUsed: string;
  callId: string;
  status: TelephonyCallStatus;
  direction?: TelephonyCallDirection;
  from?: string;
  to?: string;
  durationSeconds?: number;
  endedReason?: string;
  raw?: unknown;
}

export interface TelephonyPhoneNumber {
  /** Provider-side identifier used to update the number (Twilio: the IncomingPhoneNumber SID). */
  id: string;
  providerUsed: string;
  phoneNumber: string;
  friendlyName?: string;
  voiceUrl?: string;
  voiceMethod?: TelephonyHttpMethod;
  statusCallbackUrl?: string;
  statusCallbackMethod?: TelephonyHttpMethod;
  /** Where the provider currently posts inbound SMS for this number. */
  smsUrl?: string;
  smsMethod?: TelephonyHttpMethod;
  smsFallbackUrl?: string;
  smsFallbackMethod?: TelephonyHttpMethod;
  capabilities?: {
    voice?: boolean;
    sms?: boolean;
    mms?: boolean;
  };
  raw?: unknown;
}

export interface ListPhoneNumbersRequest {
  provider?: string;
  /** Filter to an exact number in E.164 form. */
  phoneNumber?: string;
  pageSize?: number;
  signal?: AbortSignal;
}

export interface UpdatePhoneNumberRequest {
  provider?: string;
  /** Provider-side identifier from {@link TelephonyPhoneNumber.id}. */
  id: string;
  friendlyName?: string;
  voiceUrl?: string;
  voiceMethod?: TelephonyHttpMethod;
  /**
   * Where the provider posts call status events.
   *
   * This covers the voice leg only. Message delivery receipts are requested per message when
   * sending, rather than being configured on the number.
   */
  statusCallbackUrl?: string;
  statusCallbackMethod?: TelephonyHttpMethod;
  /** Where the provider posts inbound SMS sent to this number. */
  smsUrl?: string;
  smsMethod?: TelephonyHttpMethod;
  /** Used by the provider when {@link smsUrl} errors or times out. */
  smsFallbackUrl?: string;
  smsFallbackMethod?: TelephonyHttpMethod;
  signal?: AbortSignal;
}

export interface TelephonyWebhookValidationRequest {
  provider?: string;
  url: string;
  method?: TelephonyHttpMethod;
  headers?: Record<string, string | string[] | undefined>;
  body?: string | URLSearchParams | Record<string, string | number | boolean | undefined>;
  params?: Record<string, string | number | boolean | undefined>;
  authToken?: string;
  metadata?: Record<string, unknown>;
}

export interface TelephonyConnectedEvent {
  event: 'connected';
  providerUsed: string;
  raw?: unknown;
}

export interface TelephonyStartEvent {
  event: 'start';
  providerUsed: string;
  streamId: string;
  callId?: string;
  accountId?: string;
  tracks?: TelephonyStreamTrack[];
  mediaFormat?: {
    encoding?: TelephonyAudioEncoding;
    sampleRate?: number;
    channels?: number;
  };
  parameters?: Record<string, string>;
  raw?: unknown;
}

export interface TelephonyMediaEvent {
  event: 'media';
  providerUsed: string;
  streamId: string;
  callId?: string;
  track?: TelephonyStreamTrack;
  payload: string;
  sequenceNumber?: number;
  chunk?: number;
  timestampMs?: number;
  raw?: unknown;
}

export interface TelephonyDtmfEvent {
  event: 'dtmf';
  providerUsed: string;
  streamId: string;
  callId?: string;
  digit: string;
  raw?: unknown;
}

export interface TelephonyMarkEvent {
  event: 'mark';
  providerUsed: string;
  streamId: string;
  callId?: string;
  name: string;
  raw?: unknown;
}

export interface TelephonyStopEvent {
  event: 'stop';
  providerUsed: string;
  streamId: string;
  callId?: string;
  accountId?: string;
  raw?: unknown;
}

export type TelephonyMediaStreamEvent =
  | TelephonyConnectedEvent
  | TelephonyStartEvent
  | TelephonyMediaEvent
  | TelephonyDtmfEvent
  | TelephonyMarkEvent
  | TelephonyStopEvent;

export interface TelephonyOutboundAudioMessage {
  event: 'media' | 'mark' | 'clear';
  streamId: string;
  body: string;
}

export interface TelephonyProvider {
  readonly info: TelephonyProviderInfo;
  createCall?(request: CreateCallRequest): Promise<CreateCallResponse>;
  createWebhookResponse?(request: TelephonyResponseRequest): Promise<TelephonyWebhookResponse>;
  validateWebhook?(request: TelephonyWebhookValidationRequest): Promise<boolean> | boolean;
  parseMediaStreamEvent?(message: string | Record<string, unknown>): TelephonyMediaStreamEvent | undefined;
  formatAudioMessage?(
    streamId: string,
    payload: string,
    options?: { event?: 'media' | 'mark' | 'clear'; markName?: string },
  ): TelephonyOutboundAudioMessage;
  getCall?(request: GetCallRequest): Promise<TelephonyCallDetails>;
  endCall?(request: EndCallRequest): Promise<TelephonyCallDetails>;
  parseStatusCallback?(
    body: string | URLSearchParams | Record<string, string | number | boolean | undefined>,
  ): TelephonyStatusCallback | undefined;
  listPhoneNumbers?(request?: ListPhoneNumbersRequest): Promise<TelephonyPhoneNumber[]>;
  updatePhoneNumber?(request: UpdatePhoneNumberRequest): Promise<TelephonyPhoneNumber>;
}

export interface TelephonyConfig {
  defaultProvider?: string;
  providers?: Record<string, TelephonyProvider>;
}
