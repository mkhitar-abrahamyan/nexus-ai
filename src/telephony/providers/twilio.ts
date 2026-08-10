import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CreateCallRequest,
  CreateCallResponse,
  EndCallRequest,
  GetCallRequest,
  ListPhoneNumbersRequest,
  TelephonyCallDetails,
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
} from '../../types/telephony.js';
import { TelephonyProviderError } from '../errors.js';
import { createVoiceTwiML } from '../twiml.js';

export interface TwilioTelephonyProviderConfig {
  accountSid?: string;
  authToken?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

type TwilioPayload = Record<string, unknown>;

export class TwilioTelephonyProvider implements TelephonyProvider {
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
    },
  };

  constructor(private config: TwilioTelephonyProviderConfig = {}) {}

  async createCall(request: CreateCallRequest): Promise<CreateCallResponse> {
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

  async createWebhookResponse(request: TelephonyResponseRequest): Promise<TelephonyWebhookResponse> {
    const body = createVoiceTwiML(request);
    return {
      providerUsed: 'twilio',
      contentType: 'text/xml',
      body,
      raw: request,
    };
  }

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

  async getCall(request: GetCallRequest): Promise<TelephonyCallDetails> {
    const raw = await this.request(`/Calls/${encodeURIComponent(request.callId)}.json`, {
      method: 'GET',
      signal: request.signal,
      errorPrefix: 'Twilio call lookup failed',
    });
    return this.toCallDetails(raw, request.callId);
  }

  async endCall(request: EndCallRequest): Promise<TelephonyCallDetails> {
    const body = new URLSearchParams();
    body.set('Status', request.status || 'completed');

    const raw = await this.request(`/Calls/${encodeURIComponent(request.callId)}.json`, {
      method: 'POST',
      body,
      signal: request.signal,
      errorPrefix: 'Twilio call hangup failed',
    });
    return this.toCallDetails(raw, request.callId);
  }

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

  async listPhoneNumbers(request: ListPhoneNumbersRequest = {}): Promise<TelephonyPhoneNumber[]> {
    const query = new URLSearchParams();
    if (request.phoneNumber) query.set('PhoneNumber', request.phoneNumber);
    if (request.pageSize !== undefined) query.set('PageSize', String(request.pageSize));
    const suffix = query.size ? `?${query.toString()}` : '';

    const raw = await this.request(`/IncomingPhoneNumbers.json${suffix}`, {
      method: 'GET',
      signal: request.signal,
      errorPrefix: 'Twilio phone number lookup failed',
    });

    const list = raw.incoming_phone_numbers;
    if (!Array.isArray(list)) return [];
    return list.map((entry) => this.toPhoneNumber(objectValue(entry)));
  }

  async updatePhoneNumber(request: UpdatePhoneNumberRequest): Promise<TelephonyPhoneNumber> {
    const body = new URLSearchParams();
    if (request.friendlyName !== undefined) body.set('FriendlyName', request.friendlyName);
    if (request.voiceUrl !== undefined) body.set('VoiceUrl', request.voiceUrl);
    if (request.voiceMethod !== undefined) body.set('VoiceMethod', request.voiceMethod);
    if (request.statusCallbackUrl !== undefined) body.set('StatusCallback', request.statusCallbackUrl);
    if (request.statusCallbackMethod !== undefined) body.set('StatusCallbackMethod', request.statusCallbackMethod);

    if (!body.size) {
      throw new TelephonyProviderError('Twilio phone number update requires at least one field to change', 'twilio');
    }

    const raw = await this.request(`/IncomingPhoneNumbers/${encodeURIComponent(request.id)}.json`, {
      method: 'POST',
      body,
      signal: request.signal,
      errorPrefix: 'Twilio phone number update failed',
    });
    return this.toPhoneNumber(raw);
  }

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

  private async request(
    path: string,
    options: { method: 'GET' | 'POST'; body?: URLSearchParams; signal?: AbortSignal; errorPrefix: string },
  ): Promise<TwilioPayload> {
    const accountSid = this.requireConfig('accountSid');
    const authToken = this.requireConfig('authToken');

    const response = await this.fetchImpl()(`${this.baseUrl()}/Accounts/${accountSid}${path}`, {
      method: options.method,
      body: options.body,
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        ...(options.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      signal: options.signal,
    });

    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      throw new TelephonyProviderError(`${options.errorPrefix}: ${response.status} ${message}`, 'twilio');
    }

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
