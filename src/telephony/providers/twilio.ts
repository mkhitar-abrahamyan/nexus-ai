import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  CreateCallRequest,
  CreateCallResponse,
  TelephonyCallStatus,
  TelephonyMediaStreamEvent,
  TelephonyOutboundAudioMessage,
  TelephonyProvider,
  TelephonyProviderInfo,
  TelephonyResponseRequest,
  TelephonyWebhookResponse,
  TelephonyWebhookValidationRequest,
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
    },
  };

  constructor(private config: TwilioTelephonyProviderConfig = {}) {}

  async createCall(request: CreateCallRequest): Promise<CreateCallResponse> {
    const accountSid = this.requireConfig('accountSid');
    const authToken = this.requireConfig('authToken');
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

    const response = await this.fetchImpl()(`${this.baseUrl()}/Accounts/${accountSid}/Calls.json`, {
      method: 'POST',
      body,
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      signal: request.signal,
    });

    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      throw new TelephonyProviderError(`Twilio call request failed: ${response.status} ${message}`, 'twilio');
    }

    const raw = (await response.json()) as TwilioPayload;
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
