/**
 * Telnyx, on its own call-control protocol: calls are answered, spoken to, streamed, transferred,
 * conferenced, and recorded by commands, not by markup a webhook returns. Webhooks are JSON, signed
 * with Ed25519. Media streams carry 8 kHz G.711 µ-law, as Twilio's do, so a realtime bridge runs on
 * either. Messaging sends and receives SMS and MMS. Portable: it needs `fetch` and Web Crypto only.
 */
import type { ProviderCallContext } from '../../types/lifecycle.js';
import type {
  AnswerCallRequest,
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
  TelephonyCallDirection,
  TelephonyCallStatus,
  TelephonyConferenceJoin,
  TelephonyMediaStreamEvent,
  TelephonyMessage,
  TelephonyMessageStatus,
  TelephonyOutboundAudioMessage,
  TelephonyPhoneNumber,
  TelephonyProvider,
  TelephonyProviderInfo,
  TelephonyRecording,
  TelephonyRecordingAudio,
  TelephonyRecordingStarted,
  TelephonyStatusCallback,
  TelephonyStreamConfig,
  TelephonyTransfer,
  TelephonyWebhookResponse,
  TelephonyWebhookValidationRequest,
  TransferCallRequest,
  UpdatePhoneNumberRequest,
} from '../../types/telephony.js';
import { decodeBase64 } from '../../utils/base64.js';
import { TelephonyProviderError } from '../errors.js';

/** Options for the Telnyx telephony provider. */
export interface TelnyxTelephonyProviderConfig {
  /** Telnyx API key, sent as a bearer token. Keep it on a server. */
  apiKey?: string;
  /** The Call Control application outbound calls are placed through. */
  connectionId?: string;
  /** The messaging profile messages are sent through, when the sending number has none. */
  messagingProfileId?: string;
  /** Your account's webhook public key, in base64, which verifies a webhook's Ed25519 signature. */
  publicKey?: string;
  /** How old a signed webhook may be, in seconds. Defaults to 300. */
  webhookToleranceSeconds?: number;
  /** The voice the call speaks in. Defaults to `female`. */
  voice?: string;
  /** The language the call speaks in. Defaults to `en-US`. */
  language?: string;
  /** API base URL. Defaults to `https://api.telnyx.com/v2`. */
  baseUrl?: string;
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
  /** Replaces the system clock, in milliseconds, for tests. */
  now?: () => number;
}

type Payload = Record<string, unknown>;

/**
 * Telnyx Call Control and Messaging: outbound calls, calls answered by command, transfer,
 * conferences, recordings, phone numbers, bidirectional media streams, and SMS and MMS.
 *
 * Its webhooks are not answered with markup: `answerCall()` runs a `TelephonyResponseRequest` as
 * the call's commands, and the webhook returns nothing. `TelephonyManager.answer()` does the right
 * thing on either provider.
 */
export class TelnyxTelephonyProvider implements TelephonyProvider {
  /** Always `telnyx`, with every telephony capability. */
  readonly info: TelephonyProviderInfo = {
    name: 'telnyx',
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

  constructor(private readonly config: TelnyxTelephonyProviderConfig = {}) {}

  /** Places an outbound call through the configured Call Control application. */
  async createCall(request: CreateCallRequest, context?: ProviderCallContext): Promise<CreateCallResponse> {
    if (request.twiml || request.applicationSid) {
      throw new TelephonyProviderError('Telnyx calls take webhookUrl or mediaStreamUrl, not TwiML', 'telnyx');
    }
    const connection = this.config.connectionId;
    if (!connection) throw new TelephonyProviderError('Telnyx calls require connectionId', 'telnyx');
    const data = await this.request('/calls', {
      context,
      method: 'POST',
      body: {
        connection_id: connection,
        to: request.to,
        from: request.from,
        ...(request.webhookUrl ? { webhook_url: request.webhookUrl } : {}),
        ...(request.webhookMethod ? { webhook_url_method: request.webhookMethod } : {}),
        ...(request.timeoutSeconds !== undefined ? { timeout_secs: request.timeoutSeconds } : {}),
        ...(request.machineDetection
          ? { answering_machine_detection: request.machineDetection === 'enable' ? 'detect' : 'greeting_end' }
          : {}),
        ...(request.record ? { record: 'record-from-answer', record_format: 'mp3', record_channels: 'dual' } : {}),
        ...(request.mediaStreamUrl ? streamParameters({ url: request.mediaStreamUrl, mode: 'bidirectional' }) : {}),
      },
      signal: request.signal,
      errorPrefix: 'Telnyx call request failed',
    });
    return {
      callId: stringValue(data.call_control_id) ?? '',
      providerUsed: 'telnyx',
      status: 'queued',
      direction: 'outbound',
      to: request.to,
      from: request.from,
      raw: data,
    };
  }

  /**
   * Answers a call, then speaks, collects digits, plays audio, dials, or hangs up, as the request
   * asks, each as a command on the call. Resolves to the empty response the webhook returns.
   * Telnyx gathers keypad digits, not speech, and has no redirect to another webhook.
   */
  async answerCall(request: AnswerCallRequest, context?: ProviderCallContext): Promise<TelephonyWebhookResponse> {
    if (request.redirectUrl) {
      throw new TelephonyProviderError('Telnyx calls are controlled by command, not redirected to a webhook', 'telnyx');
    }
    if (request.gather?.input && !request.gather.input.includes('dtmf')) {
      throw new TelephonyProviderError('Telnyx gathers keypad digits, not speech', 'telnyx');
    }
    const sent: Array<{ action: string; body: Payload }> = [];
    const run = async (action: string, body: Payload) => {
      sent.push({ action, body });
      await this.command(request.callId, action, body, request.signal, context);
    };
    const voice = {
      voice: this.config.voice ?? 'female',
      language: request.gather?.language ?? this.config.language ?? 'en-US',
    };
    await run('answer', request.stream ? streamParameters(request.stream) : {});
    const say = typeof request.say === 'string' ? [request.say] : (request.say ?? []);
    if (say.length) await run('speak', { payload: say.join(' '), ...voice });
    for (const url of typeof request.playUrl === 'string' ? [request.playUrl] : (request.playUrl ?? [])) {
      await run('playback_start', { audio_url: url });
    }
    if (request.gather) {
      const gather = request.gather;
      const digits = {
        ...(gather.numDigits !== undefined ? { minimum_digits: 1, maximum_digits: gather.numDigits } : {}),
        ...(gather.timeoutSeconds !== undefined ? { timeout_millis: gather.timeoutSeconds * 1_000 } : {}),
        ...(gather.finishOnKey ? { terminating_digit: gather.finishOnKey } : {}),
      };
      if (gather.prompts?.length)
        await run('gather_using_speak', { payload: gather.prompts.join(' '), ...voice, ...digits });
      else await run('gather', digits);
    }
    if (request.dial?.conference) {
      await this.joinConference({
        callId: request.callId,
        ...request.dial.conference,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      sent.push({ action: 'conference', body: { name: request.dial.conference.name } });
    } else if (request.dial?.to) {
      await run('transfer', {
        to: request.dial.to,
        ...(request.dial.callerId ? { from: request.dial.callerId } : {}),
        ...(request.dial.timeoutSeconds !== undefined ? { timeout_secs: request.dial.timeoutSeconds } : {}),
      });
    }
    if (request.hangup) await run('hangup', {});
    return { providerUsed: 'telnyx', contentType: 'application/json', body: '{}', raw: sent };
  }

  /**
   * Checks a webhook's Ed25519 signature, from `telnyx-signature-ed25519` over the timestamp and the
   * raw body, against your account's public key. A webhook older than the tolerance is refused.
   */
  async validateWebhook(request: TelephonyWebhookValidationRequest): Promise<boolean> {
    const key = request.publicKey ?? this.config.publicKey;
    if (!key) throw new TelephonyProviderError('Telnyx webhook validation requires publicKey', 'telnyx');
    const signature = header(request.headers, 'telnyx-signature-ed25519');
    const timestamp = header(request.headers, 'telnyx-timestamp');
    if (!signature || !timestamp) return false;
    const seconds = Number(timestamp);
    const now = (this.config.now?.() ?? Date.now()) / 1_000;
    if (!Number.isFinite(seconds) || Math.abs(now - seconds) > (this.config.webhookToleranceSeconds ?? 300)) {
      return false;
    }
    const body =
      typeof request.body === 'string'
        ? request.body
        : request.body instanceof URLSearchParams
          ? request.body.toString()
          : JSON.stringify(request.body ?? {});
    const subtle = (globalThis as { crypto?: { subtle?: Ed25519Subtle } }).crypto?.subtle;
    if (!subtle) throw new TelephonyProviderError('This environment does not provide Web Crypto', 'telnyx');
    try {
      const imported = await subtle.importKey('raw', toBuffer(decodeBase64(key)), { name: 'Ed25519' }, false, [
        'verify',
      ]);
      return await subtle.verify(
        { name: 'Ed25519' },
        imported,
        toBuffer(decodeBase64(signature)),
        toBuffer(new TextEncoder().encode(`${timestamp}|${body}`)),
      );
    } catch {
      return false;
    }
  }

  /** Reads a call's details. Telnyx says whether the call is alive, and for how long it ran. */
  async getCall(request: GetCallRequest, context?: ProviderCallContext): Promise<TelephonyCallDetails> {
    const data = await this.request(`/calls/${encodeURIComponent(request.callId)}`, {
      context,
      method: 'GET',
      signal: request.signal,
      errorPrefix: 'Telnyx call lookup failed',
    });
    return {
      callId: stringValue(data.call_control_id) ?? request.callId,
      providerUsed: 'telnyx',
      status: data.is_alive === true ? 'in-progress' : 'completed',
      durationSeconds: numberValue(data.call_duration),
      raw: data,
    };
  }

  /** Hangs a call up. */
  async endCall(request: EndCallRequest, context?: ProviderCallContext): Promise<TelephonyCallDetails> {
    const raw = await this.command(request.callId, 'hangup', {}, request.signal, context);
    return {
      callId: request.callId,
      providerUsed: 'telnyx',
      status: request.status === 'canceled' ? 'canceled' : 'completed',
      raw,
    };
  }

  /** Parses a call webhook (`call.initiated`, `call.answered`, `call.bridged`, `call.hangup`) as a status. */
  parseStatusCallback(
    body: string | URLSearchParams | Record<string, string | number | boolean | undefined>,
  ): TelephonyStatusCallback | undefined {
    const event = webhookEvent(body);
    if (!event) return undefined;
    const { type, payload } = event;
    const direction = callDirection(stringValue(payload.direction));
    let status: TelephonyCallStatus | undefined;
    if (type === 'call.initiated') status = direction === 'outbound' ? 'queued' : 'ringing';
    else if (type === 'call.answered' || type === 'call.bridged') status = 'in-progress';
    else if (type === 'call.hangup') status = hangupStatus(stringValue(payload.hangup_cause));
    if (!status) return undefined;
    const started = Date.parse(stringValue(payload.start_time) ?? '');
    const ended = Date.parse(stringValue(payload.end_time) ?? '');
    return {
      providerUsed: 'telnyx',
      callId: stringValue(payload.call_control_id) ?? '',
      status,
      ...(direction ? { direction } : {}),
      from: stringValue(payload.from),
      to: stringValue(payload.to),
      ...(type === 'call.hangup' && Number.isFinite(started) && Number.isFinite(ended)
        ? { durationSeconds: Math.max(0, Math.round((ended - started) / 1_000)) }
        : {}),
      ...(type === 'call.hangup' && payload.hangup_cause ? { endedReason: String(payload.hangup_cause) } : {}),
      raw: event.raw,
    };
  }

  /** Lists your phone numbers. */
  async listPhoneNumbers(
    request: ListPhoneNumbersRequest = {},
    context?: ProviderCallContext,
  ): Promise<TelephonyPhoneNumber[]> {
    const query = new URLSearchParams();
    if (request.phoneNumber) query.set('filter[phone_number]', request.phoneNumber);
    if (request.pageSize !== undefined) query.set('page[size]', String(request.pageSize));
    const list = await this.request(`/phone_numbers${query.size ? `?${query.toString()}` : ''}`, {
      context,
      method: 'GET',
      signal: request.signal,
      errorPrefix: 'Telnyx phone number lookup failed',
      list: true,
    });
    return (Array.isArray(list) ? list : []).map((entry) => this.toPhoneNumber(objectValue(entry)));
  }

  /**
   * Changes where a number sends calls and messages. On Telnyx a number's calls go to its Call
   * Control application and its messages to its messaging profile, so `voiceUrl` changes that
   * application's webhook and `smsUrl` that profile's: for every number that shares them.
   */
  async updatePhoneNumber(
    request: UpdatePhoneNumberRequest,
    context?: ProviderCallContext,
  ): Promise<TelephonyPhoneNumber> {
    const id = encodeURIComponent(request.id);
    let number = await this.request(`/phone_numbers/${id}`, {
      context,
      method: 'GET',
      signal: request.signal,
      errorPrefix: 'Telnyx phone number lookup failed',
    });
    if (request.friendlyName !== undefined) {
      number = await this.request(`/phone_numbers/${id}`, {
        context,
        method: 'PATCH',
        body: { customer_reference: request.friendlyName },
        signal: request.signal,
        errorPrefix: 'Telnyx phone number update failed',
      });
    }
    const voice = request.voiceUrl ?? request.statusCallbackUrl;
    if (voice !== undefined) {
      const connection = stringValue(number.connection_id);
      if (!connection) throw new TelephonyProviderError('This Telnyx number has no Call Control application', 'telnyx');
      await this.request(`/call_control_applications/${encodeURIComponent(connection)}`, {
        context,
        method: 'PATCH',
        body: { webhook_event_url: voice },
        signal: request.signal,
        errorPrefix: 'Telnyx application update failed',
      });
    }
    if (request.smsUrl !== undefined || request.smsFallbackUrl !== undefined) {
      const profile = stringValue(number.messaging_profile_id);
      if (!profile) throw new TelephonyProviderError('This Telnyx number has no messaging profile', 'telnyx');
      await this.request(`/messaging_profiles/${encodeURIComponent(profile)}`, {
        context,
        method: 'PATCH',
        body: {
          ...(request.smsUrl !== undefined ? { webhook_url: request.smsUrl } : {}),
          ...(request.smsFallbackUrl !== undefined ? { webhook_failover_url: request.smsFallbackUrl } : {}),
        },
        signal: request.signal,
        errorPrefix: 'Telnyx messaging profile update failed',
      });
    }
    return {
      ...this.toPhoneNumber(number),
      ...(voice !== undefined ? { voiceUrl: voice } : {}),
      ...(request.smsUrl !== undefined ? { smsUrl: request.smsUrl } : {}),
    };
  }

  /** Parses a media stream message into a neutral event. Returns `undefined` for one it does not model. */
  parseMediaStreamEvent(message: string | Record<string, unknown>): TelephonyMediaStreamEvent | undefined {
    const data = typeof message === 'string' ? (JSON.parse(message) as Payload) : message;
    const event = stringValue(data.event);
    const streamId = stringValue(data.stream_id) ?? '';
    if (event === 'connected') return { event: 'connected', providerUsed: 'telnyx', raw: data };
    if (event === 'start') {
      const start = objectValue(data.start);
      const format = objectValue(start.media_format);
      return {
        event: 'start',
        providerUsed: 'telnyx',
        streamId,
        callId: stringValue(start.call_control_id),
        accountId: stringValue(start.user_id),
        tracks: ['inbound'],
        mediaFormat: {
          encoding: normalizeEncoding(stringValue(format.encoding)),
          sampleRate: numberValue(format.sample_rate),
          channels: numberValue(format.channels),
        },
        raw: data,
      };
    }
    if (event === 'media') {
      const media = objectValue(data.media);
      return {
        event: 'media',
        providerUsed: 'telnyx',
        streamId,
        track: stringValue(media.track) === 'outbound' ? 'outbound' : 'inbound',
        payload: stringValue(media.payload) ?? '',
        sequenceNumber: numberValue(data.sequence_number),
        chunk: numberValue(media.chunk),
        timestampMs: numberValue(media.timestamp),
        raw: data,
      };
    }
    if (event === 'dtmf') {
      return {
        event: 'dtmf',
        providerUsed: 'telnyx',
        streamId,
        digit: stringValue(objectValue(data.dtmf).digit) ?? '',
        raw: data,
      };
    }
    if (event === 'mark') {
      return {
        event: 'mark',
        providerUsed: 'telnyx',
        streamId,
        name: stringValue(objectValue(data.mark).name) ?? '',
        raw: data,
      };
    }
    if (event === 'stop') {
      const stop = objectValue(data.stop);
      return {
        event: 'stop',
        providerUsed: 'telnyx',
        streamId,
        callId: stringValue(stop.call_control_id),
        accountId: stringValue(stop.user_id),
        raw: data,
      };
    }
    return undefined;
  }

  /** Formats a media stream message: audio, a mark, or a clear. The socket names the stream. */
  formatAudioMessage(
    streamId: string,
    payload: string,
    options: { event?: 'media' | 'mark' | 'clear'; markName?: string } = {},
  ): TelephonyOutboundAudioMessage {
    const event = options.event ?? 'media';
    const body =
      event === 'media'
        ? JSON.stringify({ event: 'media', media: { payload } })
        : event === 'mark'
          ? JSON.stringify({ event: 'mark', mark: { name: options.markName ?? payload } })
          : JSON.stringify({ event: 'clear' });
    return { event, streamId, body };
  }

  /** Moves a call to another number or SIP address. */
  async transferCall(request: TransferCallRequest, context?: ProviderCallContext): Promise<TelephonyTransfer> {
    const raw = await this.command(
      request.callId,
      'transfer',
      {
        to: request.to,
        ...(request.from ? { from: request.from } : {}),
        ...(request.timeoutSeconds !== undefined ? { timeout_secs: request.timeoutSeconds } : {}),
      },
      request.signal,
      context,
    );
    return { callId: request.callId, providerUsed: 'telnyx', to: request.to, raw };
  }

  /**
   * Puts a call into the conference of that name: joins it while it runs, or creates it with this
   * call when none does. Two calls joining a conference that does not exist yet at the same moment
   * may make two.
   */
  async joinConference(
    request: JoinConferenceRequest,
    context?: ProviderCallContext,
  ): Promise<TelephonyConferenceJoin> {
    const query = new URLSearchParams({ 'filter[name]': request.name });
    const found = await this.request(`/conferences?${query.toString()}`, {
      context,
      method: 'GET',
      signal: request.signal,
      errorPrefix: 'Telnyx conference lookup failed',
      list: true,
    });
    const running = (Array.isArray(found) ? found : [])
      .map(objectValue)
      .find((conference) => stringValue(conference.status) !== 'completed');
    const beep = request.beep === undefined ? {} : { beep_enabled: request.beep ? 'always' : 'never' };
    if (running) {
      const conferenceId = stringValue(running.id) ?? '';
      const raw = await this.request(`/conferences/${encodeURIComponent(conferenceId)}/actions/join`, {
        context,
        method: 'POST',
        body: {
          call_control_id: request.callId,
          ...(request.startOnEnter !== undefined ? { start_conference_on_enter: request.startOnEnter } : {}),
          ...(request.endOnExit !== undefined ? { end_conference_on_exit: request.endOnExit } : {}),
          ...(request.muted !== undefined ? { mute: request.muted } : {}),
          ...beep,
        },
        signal: request.signal,
        errorPrefix: 'Telnyx conference join failed',
      });
      return { callId: request.callId, conference: request.name, conferenceId, providerUsed: 'telnyx', raw };
    }
    const created = await this.request('/conferences', {
      context,
      method: 'POST',
      body: {
        call_control_id: request.callId,
        name: request.name,
        start_conference_on_create: request.startOnEnter ?? true,
        ...beep,
      },
      signal: request.signal,
      errorPrefix: 'Telnyx conference creation failed',
    });
    return {
      callId: request.callId,
      conference: request.name,
      conferenceId: stringValue(created.id),
      providerUsed: 'telnyx',
      raw: created,
    };
  }

  /** Starts recording a call, as MP3. Telnyx reports it with a `call.recording.saved` webhook. */
  async startRecording(
    request: StartRecordingRequest,
    context?: ProviderCallContext,
  ): Promise<TelephonyRecordingStarted> {
    const raw = await this.command(
      request.callId,
      'record_start',
      { format: 'mp3', channels: request.channels === 'single' ? 'single' : 'dual' },
      request.signal,
      context,
    );
    return { callId: request.callId, providerUsed: 'telnyx', raw };
  }

  /** Stops recording a call. */
  async stopRecording(request: StopRecordingRequest, context?: ProviderCallContext): Promise<void> {
    await this.command(request.callId, 'record_stop', {}, request.signal, context);
  }

  /** Parses a `call.recording.saved` webhook. */
  parseRecordingCallback(body: string | URLSearchParams | Record<string, unknown>): TelephonyRecording | undefined {
    const event = webhookEvent(body);
    if (event?.type !== 'call.recording.saved') return undefined;
    const { payload } = event;
    const urls = objectValue(payload.recording_urls);
    const url = stringValue(urls.mp3) ?? stringValue(urls.wav);
    if (!url) return undefined;
    const started = Date.parse(stringValue(payload.recording_started_at) ?? '');
    const ended = Date.parse(stringValue(payload.recording_ended_at) ?? '');
    return {
      recordingId:
        stringValue(payload.recording_id) ?? stringValue(event.raw.data && objectValue(event.raw.data).id) ?? '',
      callId: stringValue(payload.call_control_id) ?? '',
      providerUsed: 'telnyx',
      url,
      format: stringValue(urls.mp3) ? 'mp3' : 'wav',
      ...(Number.isFinite(started) && Number.isFinite(ended)
        ? { durationSeconds: Math.max(0, Math.round((ended - started) / 1_000)) }
        : {}),
      channels: stringValue(payload.channels) === 'single' ? 1 : 2,
      raw: event.raw,
    };
  }

  /**
   * Fetches a recording's audio. Telnyx's links are presigned and expire after ten minutes: an
   * expired one is renewed through the recording's own record.
   */
  async downloadRecording(
    request: DownloadRecordingRequest,
    context?: ProviderCallContext,
  ): Promise<TelephonyRecordingAudio> {
    const mimeType = request.recording.format === 'wav' ? 'audio/wav' : 'audio/mpeg';
    let response = await this.fetchImpl()(request.recording.url, { method: 'GET', signal: request.signal });
    if (!response.ok && request.recording.recordingId) {
      const record = await this.request(`/recordings/${encodeURIComponent(request.recording.recordingId)}`, {
        context,
        method: 'GET',
        signal: request.signal,
        errorPrefix: 'Telnyx recording lookup failed',
      });
      const urls = objectValue(record.download_urls);
      const renewed = request.recording.format === 'wav' ? stringValue(urls.wav) : stringValue(urls.mp3);
      if (renewed) response = await this.fetchImpl()(renewed, { method: 'GET', signal: request.signal });
    }
    if (!response.ok)
      throw new TelephonyProviderError(`Telnyx recording download failed: ${response.status}`, 'telnyx');
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mimeType: response.headers.get('content-type') || mimeType,
    };
  }

  /** Deletes a recording at Telnyx. */
  async deleteRecording(request: DeleteRecordingRequest, context?: ProviderCallContext): Promise<void> {
    await this.request(`/recordings/${encodeURIComponent(request.recordingId)}`, {
      context,
      method: 'DELETE',
      signal: request.signal,
      errorPrefix: 'Telnyx recording delete failed',
    });
  }

  /** Sends an SMS, or an MMS with `mediaUrls`. */
  async sendMessage(request: SendMessageRequest, context?: ProviderCallContext): Promise<TelephonyMessage> {
    if (!request.body && !request.mediaUrls?.length) {
      throw new TelephonyProviderError('A message needs a body, media, or both', 'telnyx');
    }
    const data = await this.request('/messages', {
      context,
      method: 'POST',
      body: {
        from: request.from,
        to: request.to,
        ...(request.body ? { text: request.body } : {}),
        ...(request.mediaUrls?.length ? { media_urls: request.mediaUrls } : {}),
        ...(request.statusCallbackUrl ? { webhook_url: request.statusCallbackUrl } : {}),
        ...(this.config.messagingProfileId ? { messaging_profile_id: this.config.messagingProfileId } : {}),
      },
      signal: request.signal,
      errorPrefix: 'Telnyx message request failed',
    });
    return this.toMessage(data, 'outbound', request);
  }

  /** Parses a messaging webhook: `message.received`, or `message.sent` and `message.finalized`. */
  parseMessageWebhook(body: string | URLSearchParams | Record<string, unknown>): TelephonyMessage | undefined {
    const event = webhookEvent(body);
    if (!event?.type.startsWith('message.')) return undefined;
    return this.toMessage(event.payload, event.type === 'message.received' ? 'inbound' : 'outbound');
  }

  private toMessage(data: Payload, direction: 'inbound' | 'outbound', sent?: SendMessageRequest): TelephonyMessage {
    const recipient = objectValue(Array.isArray(data.to) ? data.to[0] : data.to);
    const media = (Array.isArray(data.media) ? data.media : [])
      .map((item) => stringValue(objectValue(item).url))
      .filter((url): url is string => Boolean(url));
    const errors = Array.isArray(data.errors) ? data.errors.map(objectValue) : [];
    const text = stringValue(data.text) ?? sent?.body;
    return {
      messageId: stringValue(data.id) ?? '',
      providerUsed: 'telnyx',
      direction,
      from: stringValue(objectValue(data.from).phone_number) ?? sent?.from,
      to: stringValue(recipient.phone_number) ?? sent?.to,
      ...(text !== undefined ? { body: text } : {}),
      ...(media.length ? { mediaUrls: media } : sent?.mediaUrls?.length ? { mediaUrls: sent.mediaUrls } : {}),
      status: direction === 'inbound' ? 'received' : messageStatus(stringValue(recipient.status)),
      segments: numberValue(data.parts),
      ...(errors[0]?.code !== undefined ? { errorCode: String(errors[0].code) } : {}),
      raw: data,
    };
  }

  private toPhoneNumber(raw: Payload): TelephonyPhoneNumber {
    return {
      id: stringValue(raw.id) ?? '',
      providerUsed: 'telnyx',
      phoneNumber: stringValue(raw.phone_number) ?? '',
      friendlyName: stringValue(raw.customer_reference),
      capabilities: {
        voice: Boolean(raw.connection_id),
        sms: Boolean(raw.messaging_profile_id),
        mms: Boolean(raw.messaging_profile_id),
      },
      raw,
    };
  }

  private command(
    callId: string,
    action: string,
    body: Payload,
    signal?: AbortSignal,
    context?: ProviderCallContext,
  ): Promise<Payload> {
    return this.request(`/calls/${encodeURIComponent(callId)}/actions/${action}`, {
      context,
      method: 'POST',
      body,
      signal,
      errorPrefix: `Telnyx ${action.replace(/_/g, ' ')} failed`,
    });
  }

  private async request(
    path: string,
    options: {
      context?: ProviderCallContext;
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      body?: Payload;
      signal?: AbortSignal;
      errorPrefix: string;
      list: true;
    },
  ): Promise<unknown[]>;
  private async request(
    path: string,
    options: {
      context?: ProviderCallContext;
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      body?: Payload;
      signal?: AbortSignal;
      errorPrefix: string;
    },
  ): Promise<Payload>;
  private async request(
    path: string,
    options: {
      context?: ProviderCallContext;
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      body?: Payload;
      signal?: AbortSignal;
      errorPrefix: string;
      list?: boolean;
    },
  ): Promise<Payload | unknown[]> {
    // A credential resolved for the call's tenant replaces the configured key.
    const credential = await options.context?.credential?.(this.info.name);
    const apiKey = credential?.apiKey ?? this.config.apiKey;
    if (!apiKey) throw new TelephonyProviderError('Telnyx requests require apiKey', 'telnyx');
    const response = await this.fetchImpl()(
      `${(this.config.baseUrl ?? 'https://api.telnyx.com/v2').replace(/\/$/, '')}${path}`,
      {
        method: options.method,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: 'application/json',
          ...(options.body ? { 'content-type': 'application/json' } : {}),
          ...credential?.headers,
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    if (!response.ok) {
      const message = await response.text().catch(() => response.statusText);
      throw new TelephonyProviderError(`${options.errorPrefix}: ${response.status} ${message}`, 'telnyx');
    }
    if (response.status === 204) return options.list ? [] : {};
    const parsed = objectValue(await response.json().catch(() => ({})));
    if (options.list) return Array.isArray(parsed.data) ? parsed.data : [];
    return objectValue(parsed.data);
  }

  private fetchImpl(): typeof fetch {
    const impl = this.config.fetch ?? globalThis.fetch;
    if (!impl) throw new TelephonyProviderError('This environment does not provide fetch', 'telnyx');
    return impl;
  }
}

/** The part of Web Crypto's `crypto.subtle` that verifies Ed25519 signatures. */
interface Ed25519Subtle {
  importKey(
    format: 'raw',
    key: ArrayBuffer,
    algorithm: { name: 'Ed25519' },
    extractable: boolean,
    usages: ['verify'],
  ): Promise<unknown>;
  verify(algorithm: { name: 'Ed25519' }, key: unknown, signature: ArrayBuffer, data: ArrayBuffer): Promise<boolean>;
}

/** The answer and streaming parameters for a media stream. */
function streamParameters(stream: TelephonyStreamConfig): Payload {
  // Telnyx carries no custom parameters on a stream, so they ride in its URL.
  const url = new URL(stream.url);
  for (const [name, value] of Object.entries(stream.parameters ?? {})) url.searchParams.set(name, String(value));
  return {
    stream_url: url.toString(),
    stream_track:
      stream.track === 'outbound' ? 'outbound_track' : stream.track === 'both' ? 'both_tracks' : 'inbound_track',
    ...(stream.mode === 'bidirectional'
      ? { stream_bidirectional_mode: 'rtp', stream_bidirectional_codec: 'PCMU' }
      : {}),
  };
}

/** A webhook's event: its type, its payload, and the whole body. */
function webhookEvent(
  body: string | URLSearchParams | Record<string, unknown>,
): { type: string; payload: Payload; raw: Payload } | undefined {
  let raw: Payload;
  try {
    raw = typeof body === 'string' ? objectValue(JSON.parse(body)) : body instanceof URLSearchParams ? {} : body;
  } catch {
    return undefined;
  }
  const data = objectValue(raw.data);
  const type = stringValue(data.event_type);
  if (!type) return undefined;
  return { type, payload: objectValue(data.payload), raw };
}

function hangupStatus(cause: string | undefined): TelephonyCallStatus {
  switch (cause) {
    case 'user_busy':
      return 'busy';
    case 'timeout':
    case 'no_answer':
      return 'no-answer';
    case 'originator_cancel':
      return 'canceled';
    case 'call_rejected':
    case 'unallocated_number':
      return 'failed';
    default:
      return 'completed';
  }
}

function callDirection(direction: string | undefined): TelephonyCallDirection | undefined {
  if (direction === 'incoming' || direction === 'inbound') return 'inbound';
  if (direction === 'outgoing' || direction === 'outbound') return 'outbound';
  return undefined;
}

function messageStatus(status: string | undefined): TelephonyMessageStatus {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'sending':
      return 'sending';
    case 'sent':
    case 'delivery_unconfirmed':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'delivery_failed':
      return 'undelivered';
    case 'sending_failed':
      return 'failed';
    default:
      return 'unknown';
  }
}

function normalizeEncoding(encoding: string | undefined): string | undefined {
  if (encoding === 'PCMU') return 'audio/x-mulaw';
  if (encoding === 'L16') return 'audio/l16';
  if (encoding === 'OPUS') return 'audio/opus';
  return encoding;
}

function header(headers: TelephonyWebhookValidationRequest['headers'] = {}, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : typeof value === 'number' ? String(value) : undefined;
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function objectValue(value: unknown): Payload {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : {};
}
