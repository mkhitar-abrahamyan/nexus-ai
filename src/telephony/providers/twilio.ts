import type { ProviderCallContext } from '../../types/lifecycle.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CreateCallRequest,
  CreateCallResponse,
  DeleteRecordingRequest,
  DownloadRecordingRequest,
  EndCallRequest,
  GetCallRequest,
  JoinConferenceRequest,
  ListPhoneNumbersRequest,
  SendMessageRequest,
  StartRecordingRequest,
  StopRecordingRequest,
  TelephonyCallDetails,
  TelephonyConferenceJoin,
  TelephonyMessage,
  TelephonyMessageStatus,
  TelephonyRecording,
  TelephonyRecordingAudio,
  TelephonyRecordingStarted,
  TelephonyTransfer,
  TransferCallRequest,
  TelephonyCallDirection,
  TelephonyCallStatus,
  TelephonyHttpMethod,
  TelephonyMediaStreamEvent,
  TelephonyOutboundAudioMessage,
  TelephonyPhoneNumber,
  TelephonyProvider,
  TelephonyProviderInfo,
  TelephonyResponseRequest,
  TelephonyStatusCallback,
  TelephonyWebhookResponse,
  TelephonyWebhookValidationRequest,
  UpdatePhoneNumberRequest,
  TelephonyGatherResult,
} from '../../types/telephony.js';
import { TelephonyProviderError } from '../errors.js';
import { createVoiceTwiML } from '../twiml.js';

/** Options for the Twilio telephony provider. */
export interface TwilioTelephonyProviderConfig {
  /** Twilio account SID. Required for REST calls. */
  accountSid?: string;
  /** Twilio auth token, used for REST calls and webhook validation. */
  authToken?: string;
  /** REST API base URL. Defaults to `https://api.twilio.com/2010-04-01`. */
  baseUrl?: string;
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
}

type TwilioPayload = Record<string, unknown>;

/**
 * Twilio Programmable Voice and Messaging: outbound calls, TwiML webhooks, call control, transfer,
 * conferences, recordings, phone numbers, bidirectional Media Streams, and SMS and MMS.
 */
export class TwilioTelephonyProvider implements TelephonyProvider {
  /** Always `twilio`, with every telephony capability. */
  readonly info: TelephonyProviderInfo = {
    name: 'twilio',
    isLocal: false,
    supports: {
      inbound: true,
      outbound: true,
      mediaStreams: true,
      bidirectionalStreams: true,
      webhookValidation: true,
      callControl: true,
      phoneNumbers: true,
      transfer: true,
      conference: true,
      recording: true,
      messaging: true,
    },
  };

  constructor(private config: TwilioTelephonyProviderConfig = {}) {}

  /** Places an outbound call. */
  async createCall(request: CreateCallRequest, context?: ProviderCallContext): Promise<CreateCallResponse> {
    const body = new URLSearchParams();

    body.set('To', request.to);
    body.set('From', request.from);
    if (request.webhookUrl) body.set('Url', request.webhookUrl);
    if (request.webhookMethod) body.set('Method', request.webhookMethod);
    if (request.twiml) body.set('Twiml', request.twiml);
    if (!request.webhookUrl && !request.twiml && request.mediaStreamUrl) {
      body.set(
        'Twiml',
        createVoiceTwiML({
          stream: { url: request.mediaStreamUrl, mode: 'bidirectional' },
        }),
      );
    }
    if (request.applicationSid) body.set('ApplicationSid', request.applicationSid);
    if (request.statusCallbackUrl) body.set('StatusCallback', request.statusCallbackUrl);
    if (request.statusCallbackMethod) body.set('StatusCallbackMethod', request.statusCallbackMethod);
    if (request.record !== undefined) body.set('Record', String(request.record));
    if (request.timeoutSeconds !== undefined) body.set('Timeout', String(request.timeoutSeconds));
    if (request.machineDetection) body.set('MachineDetection', this.machineDetection(request.machineDetection));

    if (!body.has('Url') && !body.has('Twiml') && !body.has('ApplicationSid')) {
      throw new TelephonyProviderError(
        'Twilio calls require webhookUrl, twiml, mediaStreamUrl, or applicationSid',
        'twilio',
      );
    }

    const raw = await this.request('/Calls.json', {
      context,
      method: 'POST',
      body,
      signal: request.signal,
      errorPrefix: 'Twilio call request failed',
    });

    return {
      callId: stringValue(raw.sid) || '',
      providerUsed: 'twilio',
      status: normalizeStatus(stringValue(raw.status)),
      direction: 'outbound',
      to: stringValue(raw.to) || request.to,
      from: stringValue(raw.from) || request.from,
      raw,
    };
  }

  /** Builds a TwiML webhook response. */
  async createWebhookResponse(request: TelephonyResponseRequest): Promise<TelephonyWebhookResponse> {
    const body = createVoiceTwiML(request);
    return {
      providerUsed: 'twilio',
      contentType: 'text/xml',
      body,
      raw: request,
    };
  }

  /**
   * Validates a webhook's `X-Twilio-Signature`, using the request's token or the configured one.
   */
  validateWebhook(request: TelephonyWebhookValidationRequest): boolean {
    const token = request.authToken || this.config.authToken;
    if (!token) throw new TelephonyProviderError('Twilio webhook validation requires authToken', 'twilio');

    const signature = header(request.headers, 'x-twilio-signature');
    if (!signature || !request.url) return false;

    const params = collectParams(request);
    const payload =
      request.url +
      Object.keys(params)
        .sort()
        .map((key) => `${key}${params[key]}`)
        .join('');
    const expected = createHmac('sha1', token).update(payload).digest('base64');
    return safeEqual(signature, expected);
  }

  /** Reads a call's details. */
  async getCall(request: GetCallRequest, context?: ProviderCallContext): Promise<TelephonyCallDetails> {
    const raw = await this.request(`/Calls/${encodeURIComponent(request.callId)}.json`, {
      context,
      method: 'GET',
      signal: request.signal,
      errorPrefix: 'Twilio call lookup failed',
    });
    return this.toCallDetails(raw, request.callId);
  }

  /** Ends a call in progress. */
  async endCall(request: EndCallRequest, context?: ProviderCallContext): Promise<TelephonyCallDetails> {
    const body = new URLSearchParams();
    body.set('Status', request.status || 'completed');

    const raw = await this.request(`/Calls/${encodeURIComponent(request.callId)}.json`, {
      context,
      method: 'POST',
      body,
      signal: request.signal,
      errorPrefix: 'Twilio call hangup failed',
    });
    return this.toCallDetails(raw, request.callId);
  }

  /** Parses a status callback into neutral call details. */
  parseStatusCallback(
    body: string | URLSearchParams | Record<string, string | number | boolean | undefined>,
  ): TelephonyStatusCallback | undefined {
    const params = toParamRecord(body);
    const callId = params.CallSid || params.callSid || params.sid;
    if (!callId) return undefined;

    // Twilio sends CallDuration on completed-call callbacks and Duration on recording callbacks.
    const durationSeconds = numberValue(params.CallDuration ?? params.Duration ?? params.duration);

    return {
      providerUsed: 'twilio',
      callId,
      status: normalizeStatus(params.CallStatus || params.status),
      direction: normalizeDirection(params.Direction || params.direction),
      from: params.From || params.from,
      to: params.To || params.to,
      durationSeconds,
      // Twilio only sets SipResponseCode/ErrorCode when a call failed to complete normally.
      endedReason: params.ErrorCode || params.SipResponseCode || undefined,
      raw: params,
    };
  }

  /** Parses what a `<Gather>` posted to its action: `SpeechResult` with its `Confidence`, and `Digits`. */
  parseGatherResult(body: string | URLSearchParams | Record<string, unknown>): TelephonyGatherResult | undefined {
    const params = toParamRecord(
      body as string | URLSearchParams | Record<string, string | number | boolean | undefined>,
    );
    const callId = params.CallSid;
    if (!callId || (params.SpeechResult === undefined && params.Digits === undefined)) return undefined;
    const confidence = numberValue(params.Confidence);
    return {
      providerUsed: 'twilio',
      callId,
      ...(params.SpeechResult !== undefined ? { speech: params.SpeechResult } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(params.Digits !== undefined ? { digits: params.Digits } : {}),
      final: true,
      raw: params,
    };
  }

  /** Lists the account's phone numbers. */
  async listPhoneNumbers(
    request: ListPhoneNumbersRequest = {},
    context?: ProviderCallContext,
  ): Promise<TelephonyPhoneNumber[]> {
    const query = new URLSearchParams();
    if (request.phoneNumber) query.set('PhoneNumber', request.phoneNumber);
    if (request.pageSize !== undefined) query.set('PageSize', String(request.pageSize));
    const suffix = query.size ? `?${query.toString()}` : '';

    const raw = await this.request(`/IncomingPhoneNumbers.json${suffix}`, {
      context,
      method: 'GET',
      signal: request.signal,
      errorPrefix: 'Twilio phone number lookup failed',
    });

    const list = raw.incoming_phone_numbers;
    if (!Array.isArray(list)) return [];
    return list.map((entry) => this.toPhoneNumber(objectValue(entry)));
  }

  /** Changes where a phone number sends its calls and status callbacks. */
  async updatePhoneNumber(
    request: UpdatePhoneNumberRequest,
    context?: ProviderCallContext,
  ): Promise<TelephonyPhoneNumber> {
    const body = new URLSearchParams();
    if (request.friendlyName !== undefined) body.set('FriendlyName', request.friendlyName);
    if (request.voiceUrl !== undefined) body.set('VoiceUrl', request.voiceUrl);
    if (request.voiceMethod !== undefined) body.set('VoiceMethod', request.voiceMethod);
    if (request.statusCallbackUrl !== undefined) body.set('StatusCallback', request.statusCallbackUrl);
    if (request.statusCallbackMethod !== undefined) body.set('StatusCallbackMethod', request.statusCallbackMethod);
    if (request.smsUrl !== undefined) body.set('SmsUrl', request.smsUrl);
    if (request.smsMethod !== undefined) body.set('SmsMethod', request.smsMethod);
    if (request.smsFallbackUrl !== undefined) body.set('SmsFallbackUrl', request.smsFallbackUrl);
    if (request.smsFallbackMethod !== undefined) body.set('SmsFallbackMethod', request.smsFallbackMethod);

    if (!body.size) {
      throw new TelephonyProviderError('Twilio phone number update requires at least one field to change', 'twilio');
    }

    const raw = await this.request(`/IncomingPhoneNumbers/${encodeURIComponent(request.id)}.json`, {
      context,
      method: 'POST',
      body,
      signal: request.signal,
      errorPrefix: 'Twilio phone number update failed',
    });
    return this.toPhoneNumber(raw);
  }

  /**
   * Parses a Media Streams message into a neutral event. Returns `undefined` for events it does not
   * model.
   */
  parseMediaStreamEvent(message: string | Record<string, unknown>): TelephonyMediaStreamEvent | undefined {
    const data = typeof message === 'string' ? (JSON.parse(message) as TwilioPayload) : message;
    const event = stringValue(data.event);
    const streamSid = stringValue(data.streamSid) || stringValue(data.stream_id) || '';

    if (event === 'connected') {
      return { event: 'connected', providerUsed: 'twilio', raw: data };
    }

    if (event === 'start') {
      const start = objectValue(data.start);
      const mediaFormat = objectValue(start.mediaFormat);
      return {
        event: 'start',
        providerUsed: 'twilio',
        streamId: streamSid || stringValue(start.streamSid) || '',
        callId: stringValue(start.callSid),
        accountId: stringValue(start.accountSid),
        tracks: Array.isArray(start.tracks) ? start.tracks.map(String).map(normalizeTrack) : undefined,
        mediaFormat: {
          encoding: stringValue(mediaFormat.encoding),
          sampleRate: numberValue(mediaFormat.sampleRate),
          channels: numberValue(mediaFormat.channels),
        },
        parameters: stringRecord(start.customParameters),
        raw: data,
      };
    }

    if (event === 'media') {
      const media = objectValue(data.media);
      return {
        event: 'media',
        providerUsed: 'twilio',
        streamId: streamSid,
        track: normalizeTrack(stringValue(media.track)),
        payload: stringValue(media.payload) || '',
        sequenceNumber: numberValue(data.sequenceNumber),
        chunk: numberValue(media.chunk),
        timestampMs: numberValue(media.timestamp),
        raw: data,
      };
    }

    if (event === 'dtmf') {
      const dtmf = objectValue(data.dtmf);
      return {
        event: 'dtmf',
        providerUsed: 'twilio',
        streamId: streamSid,
        digit: stringValue(dtmf.digit) || '',
        raw: data,
      };
    }

    if (event === 'mark') {
      const mark = objectValue(data.mark);
      return {
        event: 'mark',
        providerUsed: 'twilio',
        streamId: streamSid,
        name: stringValue(mark.name) || '',
        raw: data,
      };
    }

    if (event === 'stop') {
      const stop = objectValue(data.stop);
      return {
        event: 'stop',
        providerUsed: 'twilio',
        streamId: streamSid || stringValue(stop.streamSid) || '',
        callId: stringValue(stop.callSid),
        accountId: stringValue(stop.accountSid),
        raw: data,
      };
    }

    return undefined;
  }

  /** Formats a Media Streams message: audio, a mark, or a clear. */
  formatAudioMessage(
    streamId: string,
    payload: string,
    options: { event?: 'media' | 'mark' | 'clear'; markName?: string } = {},
  ): TelephonyOutboundAudioMessage {
    const event = options.event || 'media';
    const body =
      event === 'media'
        ? JSON.stringify({ event: 'media', streamSid: streamId, media: { payload } })
        : event === 'mark'
          ? JSON.stringify({ event: 'mark', streamSid: streamId, mark: { name: options.markName || payload } })
          : JSON.stringify({ event: 'clear', streamSid: streamId });

    return { event, streamId, body };
  }

  /** Moves a live call to another number or SIP address, with `<Dial>` TwiML. */
  async transferCall(request: TransferCallRequest, context?: ProviderCallContext): Promise<TelephonyTransfer> {
    const raw = await this.redirect(
      request.callId,
      createVoiceTwiML({
        dial: {
          to: request.to,
          ...(request.from ? { callerId: request.from } : {}),
          ...(request.timeoutSeconds !== undefined ? { timeoutSeconds: request.timeoutSeconds } : {}),
        },
      }),
      request.signal,
      'Twilio call transfer failed',
      context,
    );
    return { callId: request.callId, providerUsed: 'twilio', to: request.to, raw };
  }

  /** Puts a live call into a conference, with `<Dial><Conference>` TwiML. Twilio names conferences. */
  async joinConference(
    request: JoinConferenceRequest,
    context?: ProviderCallContext,
  ): Promise<TelephonyConferenceJoin> {
    const { provider: _provider, callId, signal, ...conference } = request;
    const raw = await this.redirect(
      callId,
      createVoiceTwiML({ dial: { conference } }),
      signal,
      'Twilio conference join failed',
      context,
    );
    return { callId, conference: request.name, providerUsed: 'twilio', raw };
  }

  /** Starts recording a call, reporting the recording to `statusCallbackUrl` once it is ready. */
  async startRecording(
    request: StartRecordingRequest,
    context?: ProviderCallContext,
  ): Promise<TelephonyRecordingStarted> {
    const body = new URLSearchParams();
    body.set('RecordingChannels', request.channels === 'single' ? 'mono' : 'dual');
    if (request.statusCallbackUrl) {
      body.set('RecordingStatusCallback', request.statusCallbackUrl);
      body.set('RecordingStatusCallbackEvent', 'completed');
    }
    const raw = await this.request(`/Calls/${encodeURIComponent(request.callId)}/Recordings.json`, {
      context,
      method: 'POST',
      body,
      signal: request.signal,
      errorPrefix: 'Twilio recording start failed',
    });
    return { callId: request.callId, providerUsed: 'twilio', recordingId: stringValue(raw.sid), raw };
  }

  /** Stops a call's recording: the one named, or the call's current one. */
  async stopRecording(request: StopRecordingRequest, context?: ProviderCallContext): Promise<void> {
    const body = new URLSearchParams();
    body.set('Status', 'stopped');
    const recording = encodeURIComponent(request.recordingId ?? 'Twilio.CURRENT');
    await this.request(`/Calls/${encodeURIComponent(request.callId)}/Recordings/${recording}.json`, {
      context,
      method: 'POST',
      body,
      signal: request.signal,
      errorPrefix: 'Twilio recording stop failed',
    });
  }

  /** Parses a recording status callback for a finished recording, as MP3. */
  parseRecordingCallback(body: string | URLSearchParams | Record<string, unknown>): TelephonyRecording | undefined {
    const params = toParamRecord(body as Parameters<typeof toParamRecord>[0]);
    const recordingId = params.RecordingSid;
    const url = params.RecordingUrl;
    if (!recordingId || !url || (params.RecordingStatus && params.RecordingStatus !== 'completed')) return undefined;
    return {
      recordingId,
      callId: params.CallSid ?? '',
      providerUsed: 'twilio',
      url: `${url}.mp3`,
      format: 'mp3',
      durationSeconds: numberValue(params.RecordingDuration),
      channels: numberValue(params.RecordingChannels),
      raw: params,
    };
  }

  /** Fetches a recording's audio, with the account's credentials. */
  async downloadRecording(
    request: DownloadRecordingRequest,
    context?: ProviderCallContext,
  ): Promise<TelephonyRecordingAudio> {
    const response = await this.fetchImpl()(request.recording.url, {
      method: 'GET',
      headers: (await this.account(context)).headers,
      signal: request.signal,
    });
    if (!response.ok) {
      throw new TelephonyProviderError(`Twilio recording download failed: ${response.status}`, 'twilio');
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType:
        response.headers.get('content-type') || (request.recording.format === 'wav' ? 'audio/wav' : 'audio/mpeg'),
    };
  }

  /** Deletes a recording at Twilio. */
  async deleteRecording(request: DeleteRecordingRequest, context?: ProviderCallContext): Promise<void> {
    await this.request(`/Recordings/${encodeURIComponent(request.recordingId)}.json`, {
      context,
      method: 'DELETE',
      signal: request.signal,
      errorPrefix: 'Twilio recording delete failed',
    });
  }

  /** Sends an SMS, or an MMS with `mediaUrls`. */
  async sendMessage(request: SendMessageRequest, context?: ProviderCallContext): Promise<TelephonyMessage> {
    if (!request.body && !request.mediaUrls?.length) {
      throw new TelephonyProviderError('A message needs a body, media, or both', 'twilio');
    }
    const body = new URLSearchParams();
    body.set('To', request.to);
    body.set('From', request.from);
    if (request.body) body.set('Body', request.body);
    for (const url of request.mediaUrls ?? []) body.append('MediaUrl', url);
    if (request.statusCallbackUrl) body.set('StatusCallback', request.statusCallbackUrl);
    const raw = await this.request('/Messages.json', {
      context,
      method: 'POST',
      body,
      signal: request.signal,
      errorPrefix: 'Twilio message request failed',
    });
    return {
      messageId: stringValue(raw.sid) ?? '',
      providerUsed: 'twilio',
      direction: 'outbound',
      from: stringValue(raw.from) ?? request.from,
      to: stringValue(raw.to) ?? request.to,
      ...(request.body ? { body: request.body } : {}),
      ...(request.mediaUrls?.length ? { mediaUrls: request.mediaUrls } : {}),
      status: messageStatus(stringValue(raw.status)),
      segments: numberValue(raw.num_segments),
      ...(raw.error_code ? { errorCode: String(raw.error_code) } : {}),
      raw,
    };
  }

  /** Parses an inbound message webhook, or a message status callback. */
  parseMessageWebhook(body: string | URLSearchParams | Record<string, unknown>): TelephonyMessage | undefined {
    const params = toParamRecord(body as Parameters<typeof toParamRecord>[0]);
    const messageId = params.MessageSid || params.SmsSid;
    if (!messageId) return undefined;
    const status = messageStatus(params.MessageStatus || params.SmsStatus);
    const media = Array.from(
      { length: numberValue(params.NumMedia) ?? 0 },
      (_, index) => params[`MediaUrl${index}`],
    ).filter((url): url is string => Boolean(url));
    return {
      messageId,
      providerUsed: 'twilio',
      direction: status === 'received' ? 'inbound' : 'outbound',
      from: params.From,
      to: params.To,
      ...(params.Body !== undefined ? { body: params.Body } : {}),
      ...(media.length ? { mediaUrls: media } : {}),
      status,
      segments: numberValue(params.NumSegments),
      ...(params.ErrorCode ? { errorCode: params.ErrorCode } : {}),
      raw: params,
    };
  }

  /** Replaces a live call's instructions with TwiML. */
  private redirect(
    callId: string,
    twiml: string,
    signal: AbortSignal | undefined,
    errorPrefix: string,
    context?: ProviderCallContext,
  ) {
    const body = new URLSearchParams();
    body.set('Twiml', twiml);
    return this.request(`/Calls/${encodeURIComponent(callId)}.json`, {
      context,
      method: 'POST',
      body,
      signal,
      errorPrefix,
    });
  }

  /**
   * The account a call acts as, and its headers: the tenant's, when a credential is resolved for it,
   * as `<accountSid>:<authToken>` of its subaccount or an auth token for the configured account.
   */
  private async account(
    context?: ProviderCallContext,
  ): Promise<{ accountSid: string; headers: Record<string, string> }> {
    const credential = await context?.credential?.(this.info.name);
    const [sid, token] = credential?.apiKey?.includes(':')
      ? (credential.apiKey.split(':', 2) as [string, string])
      : [undefined, credential?.apiKey];
    const accountSid = sid ?? this.requireConfig('accountSid');
    const authToken = token ?? this.requireConfig('authToken');
    return {
      accountSid,
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        ...credential?.headers,
      },
    };
  }

  private async request(
    path: string,
    options: {
      context?: ProviderCallContext;
      method: 'GET' | 'POST' | 'DELETE';
      body?: URLSearchParams;
      signal?: AbortSignal;
      errorPrefix: string;
    },
  ): Promise<TwilioPayload> {
    const { accountSid, headers } = await this.account(options.context);

    const response = await this.fetchImpl()(`${this.baseUrl()}/Accounts/${accountSid}${path}`, {
      method: options.method,
      body: options.body,
      headers: {
        ...headers,
        ...(options.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      signal: options.signal,
    });

    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      throw new TelephonyProviderError(`${options.errorPrefix}: ${response.status} ${message}`, 'twilio');
    }

    if (response.status === 204) return {};
    return (await response.json()) as TwilioPayload;
  }

  private toCallDetails(raw: TwilioPayload, fallbackCallId: string): TelephonyCallDetails {
    return {
      callId: stringValue(raw.sid) || fallbackCallId,
      providerUsed: 'twilio',
      status: normalizeStatus(stringValue(raw.status)),
      direction: normalizeDirection(stringValue(raw.direction)),
      from: stringValue(raw.from),
      to: stringValue(raw.to),
      durationSeconds: numberValue(raw.duration),
      startedAt: stringValue(raw.start_time),
      endedAt: stringValue(raw.end_time),
      price: numberValue(raw.price),
      priceUnit: stringValue(raw.price_unit),
      raw,
    };
  }

  private toPhoneNumber(raw: TwilioPayload): TelephonyPhoneNumber {
    const capabilities = objectValue(raw.capabilities);
    return {
      id: stringValue(raw.sid) || '',
      providerUsed: 'twilio',
      phoneNumber: stringValue(raw.phone_number) || '',
      friendlyName: stringValue(raw.friendly_name),
      voiceUrl: stringValue(raw.voice_url),
      voiceMethod: normalizeHttpMethod(stringValue(raw.voice_method)),
      statusCallbackUrl: stringValue(raw.status_callback),
      statusCallbackMethod: normalizeHttpMethod(stringValue(raw.status_callback_method)),
      smsUrl: stringValue(raw.sms_url),
      smsMethod: normalizeHttpMethod(stringValue(raw.sms_method)),
      smsFallbackUrl: stringValue(raw.sms_fallback_url),
      smsFallbackMethod: normalizeHttpMethod(stringValue(raw.sms_fallback_method)),
      capabilities: {
        voice: capabilities.voice === true,
        sms: capabilities.sms === true,
        mms: capabilities.mms === true,
      },
      raw,
    };
  }

  private requireConfig(key: 'accountSid' | 'authToken'): string {
    const value = this.config[key];
    if (!value) throw new TelephonyProviderError(`Twilio ${key} is required for outbound calls`, 'twilio');
    return value;
  }

  private fetchImpl(): typeof fetch {
    return this.config.fetch || fetch;
  }

  private baseUrl(): string {
    return (this.config.baseUrl || 'https://api.twilio.com/2010-04-01').replace(/\/$/, '');
  }

  private machineDetection(value: NonNullable<CreateCallRequest['machineDetection']>): string {
    return value === 'detect-message-end' ? 'DetectMessageEnd' : 'Enable';
  }
}

function collectParams(request: TelephonyWebhookValidationRequest): Record<string, string> {
  const params: Record<string, string> = {};

  if (request.params) {
    for (const [key, value] of Object.entries(request.params)) {
      if (value !== undefined) params[key] = String(value);
    }
  }

  if (request.body instanceof URLSearchParams) {
    for (const [key, value] of request.body.entries()) params[key] = value;
  } else if (typeof request.body === 'string') {
    for (const [key, value] of new URLSearchParams(request.body).entries()) params[key] = value;
  } else if (request.body && typeof request.body === 'object') {
    for (const [key, value] of Object.entries(request.body)) {
      if (value !== undefined) params[key] = String(value);
    }
  }

  return params;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function header(headers: TelephonyWebhookValidationRequest['headers'] = {}, name: string): string | undefined {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = found?.[1];
  if (Array.isArray(value)) return value[0];
  return value;
}

function normalizeStatus(status: string | undefined): TelephonyCallStatus {
  if (
    status === 'queued' ||
    status === 'ringing' ||
    status === 'in-progress' ||
    status === 'completed' ||
    status === 'busy' ||
    status === 'failed' ||
    status === 'no-answer' ||
    status === 'canceled'
  ) {
    return status;
  }
  return 'unknown';
}

function normalizeDirection(direction: string | undefined): TelephonyCallDirection | undefined {
  if (!direction) return undefined;
  // Twilio reports outbound calls as `outbound-api` or `outbound-dial` depending on how they started.
  return direction.startsWith('outbound') ? 'outbound' : 'inbound';
}

function normalizeHttpMethod(method: string | undefined): TelephonyHttpMethod | undefined {
  if (!method) return undefined;
  return method.toUpperCase() === 'GET' ? 'GET' : 'POST';
}

function toParamRecord(
  body: string | URLSearchParams | Record<string, string | number | boolean | undefined>,
): Record<string, string> {
  const params: Record<string, string> = {};

  if (body instanceof URLSearchParams) {
    for (const [key, value] of body.entries()) params[key] = value;
  } else if (typeof body === 'string') {
    for (const [key, value] of new URLSearchParams(body).entries()) params[key] = value;
  } else if (body && typeof body === 'object') {
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) params[key] = String(value);
    }
  }

  return params;
}

function normalizeTrack(track: string | undefined): 'inbound' | 'outbound' | 'both' {
  if (track === 'outbound' || track === 'outbound_track') return 'outbound';
  if (track === 'both' || track === 'both_tracks') return 'both';
  return 'inbound';
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const object = objectValue(value);
  const entries = Object.entries(object);
  if (!entries.length) return undefined;
  return Object.fromEntries(entries.map(([key, entry]) => [key, String(entry)]));
}

function messageStatus(status: string | undefined): TelephonyMessageStatus {
  switch (status) {
    case 'accepted':
    case 'scheduled':
    case 'queued':
      return 'queued';
    case 'sending':
      return 'sending';
    case 'sent':
      return 'sent';
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'undelivered':
      return 'undelivered';
    case 'failed':
    case 'canceled':
      return 'failed';
    case 'received':
    case 'receiving':
      return 'received';
    default:
      return 'unknown';
  }
}
