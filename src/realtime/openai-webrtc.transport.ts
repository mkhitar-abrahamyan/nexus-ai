import { RealtimeError, toRealtimeError } from './errors.js';
import { TypedEventEmitter } from './events.js';
import {
  type AbortSignalLike,
  canListen,
  defaultTimerPlatform,
  type EventTargetLike,
  encodeBase64,
  eventPayload,
  isRecord,
  listen,
  onAbort,
  safeJsonParse,
  safeJsonStringify,
  type TimerPlatform,
  type TransportCleanup,
  waitForTransportOperation,
} from './transport-utils.js';
import type {
  RealtimeClientEvent,
  RealtimeServerEvent,
  RealtimeSessionConfig,
  RealtimeTransport,
  RealtimeTransportAudioEvent,
  RealtimeTransportEvents,
  RealtimeTransportState,
} from './types.js';

const DEFAULT_REALTIME_ENDPOINT = 'https://api.openai.com/v1/realtime/calls';

export interface RealtimeSessionDescriptionLike {
  type: 'offer' | 'answer';
  sdp?: string;
}

export interface RealtimeMediaTrackLike extends EventTargetLike {
  readonly kind?: string;
  readonly readyState?: string;
  stop?(): void;
}

export interface RealtimeMediaStreamLike {
  getTracks?(): RealtimeMediaTrackLike[];
  getAudioTracks?(): RealtimeMediaTrackLike[];
}

export interface RealtimeMediaDevicesLike extends EventTargetLike {
  getUserMedia(constraints: Record<string, unknown>): Promise<RealtimeMediaStreamLike>;
}

export interface RealtimeDataChannelLike extends EventTargetLike {
  readonly label?: string;
  readonly readyState: string;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(): void;
}

export interface RealtimePeerConnectionLike extends EventTargetLike {
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  readonly localDescription?: RealtimeSessionDescriptionLike | null;
  createDataChannel(label: string, options?: Record<string, unknown>): RealtimeDataChannelLike;
  addTrack(track: RealtimeMediaTrackLike, ...streams: RealtimeMediaStreamLike[]): unknown;
  createOffer(options?: Record<string, unknown>): Promise<RealtimeSessionDescriptionLike>;
  setLocalDescription(description: RealtimeSessionDescriptionLike): Promise<void>;
  setRemoteDescription(description: RealtimeSessionDescriptionLike): Promise<void>;
  close(): void;
}

export type RealtimePeerConnectionFactory = (config?: Record<string, unknown>) => RealtimePeerConnectionLike;

export interface RealtimeFetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText?: string;
  readonly headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface RealtimeFetchInitLike {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignalLike;
}

export type RealtimeFetchLike = (url: string, init?: RealtimeFetchInitLike) => Promise<RealtimeFetchResponseLike>;

export interface RealtimeAbortControllerLike {
  readonly signal: AbortSignalLike;
  abort(reason?: unknown): void;
}

export type OpenAIWebRTCSessionMode = 'unified-sdp' | 'ephemeral-token';

export interface OpenAIEphemeralCredential {
  value: string;
  expiresAt?: number;
}

export type OpenAIWebRTCTokenProvider = (
  config: RealtimeSessionConfig,
  signal?: AbortSignalLike,
) => string | OpenAIEphemeralCredential | Promise<string | OpenAIEphemeralCredential>;

export interface OpenAIWebRTCTransportOptions {
  sessionEndpoint?: string;
  sessionMode?: OpenAIWebRTCSessionMode;
  realtimeEndpoint?: string;
  ephemeralToken?: string;
  ephemeralTokenProvider?: OpenAIWebRTCTokenProvider;
  sessionEndpointHeaders?: Record<string, string>;
  peerConnectionConfig?: Record<string, unknown>;
  peerConnectionFactory?: RealtimePeerConnectionFactory;
  mediaDevices?: RealtimeMediaDevicesLike;
  mediaStream?: RealtimeMediaStreamLike;
  mediaTrack?: RealtimeMediaTrackLike;
  stopProvidedTracks?: boolean;
  fetch?: RealtimeFetchLike;
  abortControllerFactory?: () => RealtimeAbortControllerLike;
  timers?: TimerPlatform;
  now?: () => number;
  connectTimeoutMs?: number;
  iceDisconnectGraceMs?: number;
  dataChannelLabel?: string;
  dataChannelOptions?: Record<string, unknown>;
  sendAudioOverDataChannel?: boolean;
}

interface SdpAnswer {
  sdp: string;
  sessionId?: string;
  raw: unknown;
}

type WebRTCTransportEventMap = RealtimeTransportEvents & Record<string, unknown>;

/** Framework-independent OpenAI Realtime WebRTC transport using structural, injectable platform APIs. */
export class OpenAIWebRTCTransport implements RealtimeTransport {
  readonly kind = 'webrtc' as const;
  state: RealtimeTransportState = 'idle';

  private readonly emitter = new TypedEventEmitter<WebRTCTransportEventMap>();
  private readonly listenerCleanups: TransportCleanup[] = [];
  private readonly ownedTracks = new Set<RealtimeMediaTrackLike>();
  private peer?: RealtimePeerConnectionLike;
  private channel?: RealtimeDataChannelLike;
  private activeConfig?: RealtimeSessionConfig;
  private mediaDevices?: RealtimeMediaDevicesLike;
  private negotiationAbort?: RealtimeAbortControllerLike;
  private generation = 0;
  private expectedClose = false;
  private disconnectedEmitted = false;
  private iceDisconnectTimer?: unknown;

  constructor(private readonly options: OpenAIWebRTCTransportOptions = {}) {}

  on<Event extends keyof RealtimeTransportEvents>(
    event: Event,
    listener: (payload: RealtimeTransportEvents[Event]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  async connect(config: RealtimeSessionConfig): Promise<void> {
    if (this.state === 'connected') return;
    if (this.state === 'connecting' || this.state === 'disconnecting') throw this.invalidState('connect');

    this.cleanupResources();
    this.state = 'connecting';
    this.activeConfig = config;
    this.expectedClose = false;
    this.disconnectedEmitted = false;
    const generation = ++this.generation;
    const signal = config.connection?.signal || config.signal;
    let timers: TimerPlatform;
    let controller: RealtimeAbortControllerLike;
    try {
      timers = this.timers();
      controller = this.createAbortController();
    } catch (error) {
      const normalized = this.normalizeConnectionError(error);
      this.state = 'failed';
      this.emitter.emit('error', normalized);
      throw normalized;
    }
    this.negotiationAbort = controller;
    let timedOut = false;
    const timeout = timers.setTimeout(() => {
      timedOut = true;
      controller.abort('connection timeout');
    }, this.options.connectTimeoutMs ?? 15_000);
    this.listenerCleanups.push(
      onAbort(signal, () => {
        controller.abort(signal?.reason);
        if (this.state === 'connected') void this.disconnect();
      }),
    );

    try {
      if (signal?.aborted) throw this.abortError(signal.reason);
      const peer = this.createPeerConnection();
      this.peer = peer;
      this.attachPeerListeners(peer, generation);
      const channel = peer.createDataChannel(
        this.options.dataChannelLabel || 'oai-events',
        this.options.dataChannelOptions,
      );
      this.channel = channel;
      this.attachDataChannelListeners(channel, generation);
      await this.attachMicrophone(peer, config, generation);

      const offer = await peer.createOffer();
      if (!offer.sdp?.trim()) throw this.negotiationError('WebRTC offer did not contain SDP', 'invalid_offer_sdp');
      await peer.setLocalDescription(offer);
      const localSdp = peer.localDescription?.sdp || offer.sdp;
      if (!localSdp.trim())
        throw this.negotiationError('WebRTC local description did not contain SDP', 'invalid_offer_sdp');
      const answer = await this.exchangeSdp(localSdp, config, controller.signal);
      if (generation !== this.generation || this.state !== 'connecting') throw this.abortError();
      await peer.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      await this.awaitDataChannelOpen(channel, controller.signal, generation);
      if (generation !== this.generation || this.state !== 'connecting') throw this.abortError();

      timers.clearTimeout(timeout);
      this.negotiationAbort = undefined;
      this.state = 'connected';
      this.emitter.emit('connected', {
        sessionId: answer.sessionId || config.id,
        transport: this.kind,
        timestamp: this.now(),
        raw: answer.raw,
      });
    } catch (error) {
      timers.clearTimeout(timeout);
      const normalized = timedOut
        ? new RealtimeError({
            message: 'OpenAI realtime WebRTC connection timed out',
            code: 'connection_timeout',
            category: 'timeout',
            provider: 'openai',
            retryable: true,
            cause: error,
          })
        : this.normalizeConnectionError(error);
      const current = generation === this.generation;
      if (current) {
        this.state = 'failed';
        this.cleanupResources();
      }
      if (current) this.emitter.emit('error', normalized);
      throw normalized;
    }
  }

  sendAudio(chunk: ArrayBuffer): void {
    if (this.options.sendAudioOverDataChannel === false) {
      const error = new RealtimeError({
        message: 'sendAudio is disabled for this WebRTC transport; use an attached microphone media track',
        code: 'data_channel_audio_disabled',
        category: 'capability',
        provider: 'openai',
      });
      this.emitter.emit('error', error);
      throw error;
    }
    this.sendEvent({ type: 'input_audio_buffer.append', audio: encodeBase64(chunk) });
  }

  sendEvent(event: RealtimeClientEvent): void {
    const channel = this.requireOpenChannel();
    try {
      channel.send(safeJsonStringify(event));
    } catch (error) {
      const normalized = toRealtimeError(error, {
        message: 'Failed to serialize or send a realtime WebRTC event',
        code: 'data_channel_send_failed',
        category: 'protocol',
        provider: 'openai',
      });
      this.emitter.emit('error', normalized);
      throw normalized;
    }
  }

  interrupt(): void {
    this.sendEvent({ type: 'response.cancel' });
  }

  async disconnect(): Promise<void> {
    if (this.state === 'idle' || this.state === 'disconnected') {
      this.state = 'disconnected';
      return;
    }
    if (this.state === 'disconnecting') return;

    this.state = 'disconnecting';
    this.expectedClose = true;
    ++this.generation;
    this.negotiationAbort?.abort('client disconnect');
    this.cleanupResources();
    this.finishDisconnect(true);
  }

  private attachPeerListeners(peer: RealtimePeerConnectionLike, generation: number): void {
    const current = () => generation === this.generation;
    this.listenerCleanups.push(
      listen(peer, 'track', (event) => {
        if (current()) this.handleRemoteTrack(event);
      }),
      listen(peer, 'connectionstatechange', (raw) => {
        if (current()) this.handleConnectionState(peer.connectionState, raw);
      }),
      listen(peer, 'iceconnectionstatechange', (raw) => {
        if (current()) this.handleIceState(peer.iceConnectionState, raw);
      }),
      listen(peer, 'icecandidateerror', (raw) => {
        if (!current()) return;
        this.emitter.emit(
          'error',
          new RealtimeError({
            message: 'WebRTC ICE candidate negotiation failed',
            code: 'ice_candidate_error',
            category: 'network',
            provider: 'openai',
            retryable: true,
            raw: this.safeConnectionRaw(raw),
          }),
        );
      }),
    );
  }

  private attachDataChannelListeners(channel: RealtimeDataChannelLike, generation: number): void {
    const current = () => generation === this.generation;
    this.listenerCleanups.push(
      listen(channel, 'message', (message) => {
        if (current()) this.handleDataMessage(message);
      }),
      listen(channel, 'error', (raw) => {
        if (!current()) return;
        this.emitter.emit(
          'error',
          new RealtimeError({
            message: 'OpenAI realtime WebRTC data channel failed',
            code: 'data_channel_error',
            category: 'network',
            provider: 'openai',
            retryable: true,
            raw: this.safeConnectionRaw(raw),
          }),
        );
      }),
      listen(channel, 'close', (raw) => {
        if (!current()) return;
        if (!this.expectedClose && this.state === 'connected') this.finishDisconnect(false, raw, 'Data channel closed');
      }),
    );
  }

  private async attachMicrophone(
    peer: RealtimePeerConnectionLike,
    config: RealtimeSessionConfig,
    generation: number,
  ): Promise<void> {
    const requested = config.connection?.microphone;
    let stream = this.options.mediaStream;
    const track = this.options.mediaTrack;
    let owned = false;
    if (this.options.mediaDevices) this.mediaDevices = this.options.mediaDevices;

    if (!stream && !track && requested) {
      const devices = this.resolveMediaDevices();
      this.mediaDevices = devices;
      const constraints = requested === true ? { audio: true } : { audio: requested };
      try {
        stream = await devices.getUserMedia(constraints);
        owned = true;
      } catch (error) {
        throw this.mediaError(error);
      }
      if (generation !== this.generation) {
        for (const acquired of this.streamTracks(stream)) acquired.stop?.();
        throw this.abortError();
      }
    }

    if (owned && stream) {
      for (const acquired of this.streamTracks(stream)) this.ownedTracks.add(acquired);
    }
    const tracks = track ? [track] : stream ? this.audioTracks(stream) : [];
    if ((requested || stream || track) && tracks.length === 0) {
      throw new RealtimeError({
        message: 'No audio track was available for the realtime microphone',
        code: 'device_not_found',
        category: 'capability',
        provider: 'openai',
      });
    }
    for (const audioTrack of tracks) {
      peer.addTrack(audioTrack, ...(stream ? [stream] : []));
      if (owned || this.options.stopProvidedTracks) this.ownedTracks.add(audioTrack);
      if (canListen(audioTrack)) {
        this.listenerCleanups.push(
          listen(audioTrack, 'ended', (raw) => {
            if (generation !== this.generation || this.expectedClose) return;
            this.emitSyntheticData('nexus.microphone.ended', { raw });
            this.emitter.emit(
              'error',
              new RealtimeError({
                message: 'The realtime microphone track ended',
                code: 'microphone_ended',
                category: 'capability',
                provider: 'openai',
                retryable: true,
              }),
            );
          }),
        );
      }
    }

    if (this.mediaDevices && canListen(this.mediaDevices)) {
      this.listenerCleanups.push(
        listen(this.mediaDevices, 'devicechange', (raw) => {
          if (generation === this.generation) this.emitSyntheticData('nexus.audio.device_changed', { raw });
        }),
      );
    }
  }

  private async exchangeSdp(
    offerSdp: string,
    config: RealtimeSessionConfig,
    signal: AbortSignalLike,
  ): Promise<SdpAnswer> {
    const mode = this.sessionMode(config);
    if (mode === 'unified-sdp') return this.exchangeUnifiedSdp(offerSdp, config, signal);
    return this.exchangeWithEphemeralToken(offerSdp, config, signal);
  }

  private async exchangeUnifiedSdp(
    offerSdp: string,
    config: RealtimeSessionConfig,
    signal: AbortSignalLike,
  ): Promise<SdpAnswer> {
    const endpoint = this.sessionEndpoint(config);
    if (!endpoint) {
      throw new RealtimeError({
        message: 'OpenAI WebRTC unified SDP mode requires sessionEndpoint',
        code: 'missing_session_endpoint',
        category: 'configuration',
        provider: 'openai',
      });
    }
    const response = await this.request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/sdp', ...(this.options.sessionEndpointHeaders || {}) },
      body: offerSdp,
      signal,
    });
    return this.parseSdpAnswer(response);
  }

  private async exchangeWithEphemeralToken(
    offerSdp: string,
    config: RealtimeSessionConfig,
    signal: AbortSignalLike,
  ): Promise<SdpAnswer> {
    const credential = await this.resolveEphemeralToken(config, signal);
    if (!credential) {
      throw new RealtimeError({
        message: 'OpenAI WebRTC ephemeral token mode did not receive a client secret',
        code: 'missing_ephemeral_token',
        category: 'authentication',
        provider: 'openai',
      });
    }
    const endpoint = this.realtimeEndpoint(config);
    const response = await this.request(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/sdp',
      },
      body: offerSdp,
      signal,
    });
    return this.parseSdpAnswer(response);
  }

  private async resolveEphemeralToken(config: RealtimeSessionConfig, signal: AbortSignalLike): Promise<string> {
    if (this.options.ephemeralTokenProvider) {
      const value = await waitForTransportOperation(
        Promise.resolve(this.options.ephemeralTokenProvider(config, signal)),
        {
          signal,
          abortError: (reason) => (reason instanceof RealtimeError ? reason : this.abortError(reason)),
        },
      );
      return typeof value === 'string' ? value : value.value;
    }
    if (this.options.ephemeralToken) return this.options.ephemeralToken;

    const providerValue = config.providerSession?.ephemeralToken;
    if (typeof providerValue === 'string') return providerValue;
    const endpoint = this.sessionEndpoint(config);
    if (!endpoint) return '';
    const response = await this.request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.options.sessionEndpointHeaders || {}) },
      body: safeJsonStringify(this.sessionBootstrapPayload(config)),
      signal,
    });
    const body = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      throw new RealtimeError({
        message: 'Realtime session endpoint returned invalid JSON',
        code: 'invalid_session_response',
        category: 'protocol',
        provider: 'openai',
        cause: error,
      });
    }
    const token = this.tokenFromResponse(parsed);
    if (!token) {
      throw new RealtimeError({
        message: 'Realtime session endpoint response did not contain an ephemeral client secret',
        code: 'invalid_session_token',
        category: 'protocol',
        provider: 'openai',
      });
    }
    return token;
  }

  private async request(url: string, init: RealtimeFetchInitLike): Promise<RealtimeFetchResponseLike> {
    let response: RealtimeFetchResponseLike;
    try {
      response = await this.resolveFetch()(url, init);
    } catch (error) {
      if (init.signal?.aborted) {
        if (init.signal.reason instanceof RealtimeError) throw init.signal.reason;
        throw this.abortError(init.signal.reason);
      }
      throw new RealtimeError({
        message: 'Realtime session negotiation request failed',
        code: 'session_endpoint_failed',
        category: 'network',
        provider: 'openai',
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) {
      const category = response.status === 401 || response.status === 403 ? 'authentication' : 'provider';
      throw new RealtimeError({
        message: `Realtime session negotiation failed with status ${response.status}`,
        code: 'session_endpoint_rejected',
        category,
        provider: 'openai',
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return response;
  }

  private async parseSdpAnswer(response: RealtimeFetchResponseLike): Promise<SdpAnswer> {
    const body = await response.text();
    let sdp = body.trim();
    let sessionId = response.headers?.get('x-request-id') || undefined;
    let raw: unknown = body;
    if (sdp.startsWith('{')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(sdp);
      } catch (error) {
        throw this.negotiationError('Realtime session endpoint returned invalid JSON', 'invalid_sdp_response', error);
      }
      raw = parsed;
      sdp = this.sdpFromResponse(parsed) || '';
      sessionId = this.sessionIdFromResponse(parsed) || sessionId;
    }
    if (!sdp) throw this.negotiationError('Realtime session endpoint returned an empty SDP answer', 'empty_sdp_answer');
    return { sdp, sessionId, raw };
  }

  private awaitDataChannelOpen(
    channel: RealtimeDataChannelLike,
    signal: AbortSignalLike,
    generation: number,
  ): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(signal.reason instanceof RealtimeError ? signal.reason : this.abortError(signal.reason));
    }
    if (channel.readyState === 'open') return Promise.resolve();
    if (channel.readyState === 'closed' || channel.readyState === 'closing') {
      return Promise.reject(this.negotiationError('WebRTC data channel closed before opening', 'data_channel_closed'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let removeOpen: TransportCleanup = () => undefined;
      let removeClose: TransportCleanup = () => undefined;
      let removeAbort: TransportCleanup = () => undefined;
      const settle = (error?: RealtimeError) => {
        if (settled) return;
        settled = true;
        removeOpen();
        removeClose();
        removeAbort();
        if (error) reject(error);
        else resolve();
      };
      removeOpen = listen(channel, 'open', () => {
        if (generation === this.generation) settle();
      });
      if (settled) {
        removeOpen();
        return;
      }
      removeClose = listen(channel, 'close', () => {
        settle(this.negotiationError('WebRTC data channel closed before opening', 'data_channel_closed'));
      });
      if (settled) {
        removeClose();
        removeOpen();
        return;
      }
      removeAbort = onAbort(signal, () =>
        settle(signal.reason instanceof RealtimeError ? signal.reason : this.abortError(signal.reason)),
      );
    });
  }

  private handleRemoteTrack(event: unknown): void {
    const record = isRecord(event) ? event : {};
    const streams = Array.isArray(record.streams) ? record.streams : [];
    const payload: RealtimeTransportAudioEvent = {
      stream: streams[0],
      track: record.track,
      raw: event,
    };
    this.emitter.emit('audio', payload);
    try {
      const element = this.activeConfig?.connection?.audioElement;
      if (element) {
        element.srcObject = payload.stream;
        element.autoplay = true;
        const playing = element.play?.();
        if (playing && typeof playing === 'object' && 'catch' in playing) {
          void playing.catch((error: unknown) => this.emitPlaybackError(error));
        }
      }
    } catch (error) {
      this.emitPlaybackError(error);
    }
  }

  private handleDataMessage(message: unknown): void {
    const raw = eventPayload(message);
    let event: RealtimeServerEvent;
    try {
      if (typeof raw !== 'string') throw new Error('WebRTC data channel event must contain JSON text');
      event = safeJsonParse(raw) as RealtimeServerEvent;
    } catch (error) {
      this.emitter.emit(
        'error',
        toRealtimeError(error, {
          message: 'Received an invalid realtime WebRTC data-channel event',
          code: 'invalid_data_channel_event',
          category: 'protocol',
          provider: 'openai',
        }),
      );
      return;
    }
    this.emitter.emit('data', { event, raw });
  }

  private handleConnectionState(state: string | undefined, raw: unknown): void {
    this.emitSyntheticData('nexus.webrtc.connection_state_changed', { state, raw });
    if (state === 'connected') this.clearIceDisconnectTimer();
    else if (state === 'failed') {
      this.handleFatalConnectionFailure('peer_connection_failed', 'WebRTC peer connection failed', raw);
    } else if (state === 'disconnected' && !this.expectedClose) {
      this.scheduleIceDisconnect(raw);
    } else if (state === 'closed' && !this.expectedClose) {
      this.finishDisconnect(false, raw, 'Peer connection closed');
    }
  }

  private handleIceState(state: string | undefined, raw: unknown): void {
    this.emitSyntheticData('nexus.webrtc.ice_state_changed', { state, raw });
    if (state === 'connected' || state === 'completed') this.clearIceDisconnectTimer();
    else if (state === 'disconnected' && !this.expectedClose) this.scheduleIceDisconnect(raw);
    else if (state === 'failed') {
      this.handleFatalConnectionFailure('ice_failed', 'WebRTC ICE connection failed', raw);
    }
  }

  private scheduleIceDisconnect(raw: unknown): void {
    if (this.iceDisconnectTimer !== undefined || this.state !== 'connected') return;
    this.iceDisconnectTimer = this.timers().setTimeout(() => {
      this.iceDisconnectTimer = undefined;
      if (this.expectedClose || this.state !== 'connected') return;
      this.handleFatalConnectionFailure(
        'peer_connection_disconnected',
        'WebRTC peer connection did not recover after disconnecting',
        raw,
      );
    }, this.options.iceDisconnectGraceMs ?? 2_000);
  }

  private clearIceDisconnectTimer(): void {
    if (this.iceDisconnectTimer === undefined) return;
    this.timers().clearTimeout(this.iceDisconnectTimer);
    this.iceDisconnectTimer = undefined;
  }

  private handleFatalConnectionFailure(code: string, message: string, raw: unknown): void {
    const error = new RealtimeError({
      message,
      code,
      category: 'network',
      provider: 'openai',
      retryable: true,
      raw: this.safeConnectionRaw(raw),
    });
    if (this.state === 'connecting') {
      this.negotiationAbort?.abort(error);
      try {
        this.channel?.close();
        this.peer?.close();
      } catch {
        // The pending connect path will surface the original network error.
      }
      return;
    }
    if (this.state !== 'connected') return;
    this.emitter.emit('error', error);
    this.finishDisconnect(false, raw, message);
  }

  private emitSyntheticData(type: string, extra: Record<string, unknown>): void {
    const { raw, ...data } = extra;
    const event: RealtimeServerEvent = { type, ...data };
    this.emitter.emit('data', { event, raw });
  }

  private emitPlaybackError(error: unknown): void {
    this.emitter.emit(
      'error',
      toRealtimeError(error, {
        message: 'Remote realtime audio playback failed',
        code: 'audio_playback_failed',
        category: 'permission',
        provider: 'openai',
      }),
    );
  }

  private finishDisconnect(expected: boolean, raw?: unknown, reason?: string): void {
    if (this.disconnectedEmitted) return;
    this.disconnectedEmitted = true;
    this.state = expected ? 'disconnected' : 'failed';
    this.cleanupResources();
    this.emitter.emit('disconnected', {
      transport: this.kind,
      timestamp: this.now(),
      reason,
      expected,
      retryable: !expected,
      raw,
    });
  }

  private cleanupResources(): void {
    this.clearIceDisconnectTimer();
    this.negotiationAbort?.abort('transport cleanup');
    for (const cleanup of this.listenerCleanups.splice(0).reverse()) {
      try {
        cleanup();
      } catch {
        // Best effort.
      }
    }
    try {
      this.channel?.close();
    } catch {
      // Best effort.
    }
    try {
      this.peer?.close();
    } catch {
      // Best effort.
    }
    for (const track of this.ownedTracks) {
      try {
        track.stop?.();
      } catch {
        // Best effort.
      }
    }
    this.ownedTracks.clear();
    const element = this.activeConfig?.connection?.audioElement;
    try {
      element?.pause?.();
      if (element) element.srcObject = undefined;
    } catch {
      // Best effort.
    }
    this.peer = undefined;
    this.channel = undefined;
    this.mediaDevices = undefined;
    this.negotiationAbort = undefined;
    this.activeConfig = undefined;
  }

  private createPeerConnection(): RealtimePeerConnectionLike {
    if (this.options.peerConnectionFactory) {
      return this.options.peerConnectionFactory(this.options.peerConnectionConfig);
    }
    const Constructor = (
      globalThis as unknown as {
        RTCPeerConnection?: new (config?: Record<string, unknown>) => RealtimePeerConnectionLike;
      }
    ).RTCPeerConnection;
    if (!Constructor) {
      throw new RealtimeError({
        message: 'This environment does not provide RTCPeerConnection; inject peerConnectionFactory',
        code: 'unsupported_environment',
        category: 'capability',
        provider: 'openai',
      });
    }
    return new Constructor(this.options.peerConnectionConfig);
  }

  private resolveMediaDevices(): RealtimeMediaDevicesLike {
    if (this.options.mediaDevices) return this.options.mediaDevices;
    const devices = (globalThis as unknown as { navigator?: { mediaDevices?: RealtimeMediaDevicesLike } }).navigator
      ?.mediaDevices;
    if (!devices?.getUserMedia) {
      throw new RealtimeError({
        message: 'This environment does not provide microphone capture; inject mediaDevices',
        code: 'unsupported_microphone',
        category: 'capability',
        provider: 'openai',
      });
    }
    return devices;
  }

  private resolveFetch(): RealtimeFetchLike {
    if (this.options.fetch) return this.options.fetch;
    const fetchLike = (globalThis as unknown as { fetch?: RealtimeFetchLike }).fetch;
    if (!fetchLike) {
      throw new RealtimeError({
        message: 'This environment does not provide fetch; inject a fetch implementation',
        code: 'unsupported_environment',
        category: 'capability',
        provider: 'openai',
      });
    }
    return fetchLike.bind(globalThis);
  }

  private createAbortController(): RealtimeAbortControllerLike {
    if (this.options.abortControllerFactory) return this.options.abortControllerFactory();
    const Constructor = (
      globalThis as unknown as {
        AbortController?: new () => RealtimeAbortControllerLike;
      }
    ).AbortController;
    if (!Constructor) {
      throw new RealtimeError({
        message: 'This environment does not provide AbortController; inject abortControllerFactory',
        code: 'unsupported_environment',
        category: 'capability',
        provider: 'openai',
      });
    }
    return new Constructor();
  }

  private sessionMode(config: RealtimeSessionConfig): OpenAIWebRTCSessionMode {
    const configured = config.providerSession?.sessionMode;
    if (configured === 'unified-sdp' || configured === 'ephemeral-token') return configured;
    return (
      this.options.sessionMode ||
      (this.options.ephemeralToken || this.options.ephemeralTokenProvider ? 'ephemeral-token' : 'unified-sdp')
    );
  }

  private sessionEndpoint(config: RealtimeSessionConfig): string | undefined {
    const configured = config.providerSession?.sessionEndpoint;
    return typeof configured === 'string' ? configured : this.options.sessionEndpoint;
  }

  private realtimeEndpoint(config: RealtimeSessionConfig): string {
    const configured = config.providerSession?.realtimeEndpoint;
    return typeof configured === 'string' ? configured : this.options.realtimeEndpoint || DEFAULT_REALTIME_ENDPOINT;
  }

  private sessionBootstrapPayload(config: RealtimeSessionConfig): Record<string, unknown> {
    return {
      model: config.model,
      modalities: config.modalities,
      instructions: config.instructions,
      audio: config.audio,
      tools: config.tools?.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
      tool_choice: config.toolChoice,
      metadata: config.metadata,
    };
  }

  private tokenFromResponse(value: unknown): string | undefined {
    if (!isRecord(value)) return undefined;
    if (typeof value.value === 'string') return value.value;
    if (typeof value.token === 'string') return value.token;
    if (typeof value.ephemeral_token === 'string') return value.ephemeral_token;
    const secret = value.client_secret;
    return isRecord(secret) && typeof secret.value === 'string' ? secret.value : undefined;
  }

  private sdpFromResponse(value: unknown): string | undefined {
    if (!isRecord(value)) return undefined;
    if (typeof value.sdp === 'string') return value.sdp;
    const answer = value.answer;
    return isRecord(answer) && typeof answer.sdp === 'string' ? answer.sdp : undefined;
  }

  private sessionIdFromResponse(value: unknown): string | undefined {
    if (!isRecord(value)) return undefined;
    if (typeof value.session_id === 'string') return value.session_id;
    const session = value.session;
    return isRecord(session) && typeof session.id === 'string' ? session.id : undefined;
  }

  private streamTracks(stream: RealtimeMediaStreamLike): RealtimeMediaTrackLike[] {
    return stream.getTracks?.() || stream.getAudioTracks?.() || [];
  }

  private audioTracks(stream: RealtimeMediaStreamLike): RealtimeMediaTrackLike[] {
    return (
      stream.getAudioTracks?.() || this.streamTracks(stream).filter((track) => !track.kind || track.kind === 'audio')
    );
  }

  private requireOpenChannel(): RealtimeDataChannelLike {
    if (this.state !== 'connected' || !this.channel || this.channel.readyState !== 'open') {
      throw this.invalidState('send');
    }
    return this.channel;
  }

  private mediaError(error: unknown): RealtimeError {
    const record = isRecord(error) ? error : undefined;
    const name = record && typeof record.name === 'string' ? record.name : '';
    if (['NotAllowedError', 'SecurityError'].includes(name)) {
      return new RealtimeError({
        message: 'Microphone permission was denied',
        code: 'permission_denied',
        category: 'permission',
        provider: 'openai',
        cause: error,
      });
    }
    if (['NotFoundError', 'OverconstrainedError'].includes(name)) {
      return new RealtimeError({
        message: 'No compatible microphone device is available',
        code: 'device_not_found',
        category: 'capability',
        provider: 'openai',
        cause: error,
      });
    }
    if (name === 'NotReadableError') {
      return new RealtimeError({
        message: 'The microphone is unavailable or already in use',
        code: 'device_busy',
        category: 'capability',
        provider: 'openai',
        retryable: true,
        cause: error,
      });
    }
    if (name === 'AbortError') return this.abortError(error);
    return toRealtimeError(error, {
      message: 'Microphone capture failed',
      code: 'microphone_failed',
      category: 'capability',
      provider: 'openai',
    });
  }

  private normalizeConnectionError(error: unknown): RealtimeError {
    if (error instanceof RealtimeError) return error;
    return toRealtimeError(error, {
      message: 'OpenAI realtime WebRTC connection failed',
      code: 'webrtc_connection_failed',
      category: 'network',
      provider: 'openai',
      retryable: true,
    });
  }

  private safeConnectionRaw(raw: unknown): unknown {
    if (!isRecord(raw)) return undefined;
    return {
      type: typeof raw.type === 'string' ? raw.type : undefined,
      errorCode: typeof raw.errorCode === 'number' ? raw.errorCode : undefined,
      errorText: typeof raw.errorText === 'string' ? raw.errorText : undefined,
    };
  }

  private negotiationError(message: string, code: string, cause?: unknown): RealtimeError {
    return new RealtimeError({
      message,
      code,
      category: 'protocol',
      provider: 'openai',
      cause,
    });
  }

  private invalidState(action: string): RealtimeError {
    return new RealtimeError({
      message: `Cannot ${action} while OpenAI WebRTC transport is ${this.state}`,
      code: 'invalid_state',
      category: 'configuration',
      provider: 'openai',
    });
  }

  private abortError(cause?: unknown): RealtimeError {
    return new RealtimeError({
      message: 'OpenAI realtime WebRTC connection was aborted',
      code: 'aborted',
      category: 'abort',
      provider: 'openai',
      cause,
    });
  }

  private timers(): TimerPlatform {
    return this.options.timers || defaultTimerPlatform();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
