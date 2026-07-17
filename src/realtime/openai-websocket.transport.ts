import { RealtimeError, toRealtimeError } from './errors.js';
import { TypedEventEmitter } from './events.js';
import {
  type AbortSignalLike,
  defaultTimerPlatform,
  defaultUtf8Codec,
  type EventTargetLike,
  encodeBase64,
  eventPayload,
  isRecord,
  listen,
  onAbort,
  PortableAbortController,
  safeJsonParse,
  safeJsonStringify,
  type TimerPlatform,
  type TransportCleanup,
  type Utf8Codec,
  waitForTransportOperation,
} from './transport-utils.js';
import type {
  RealtimeClientEvent,
  RealtimeServerEvent,
  RealtimeSessionConfig,
  RealtimeTransport,
  RealtimeTransportEvents,
  RealtimeTransportState,
} from './types.js';

const DEFAULT_URL = 'wss://api.openai.com/v1/realtime';
const DEFAULT_MAX_AUDIO_BYTES = 15 * 1024 * 1024;

export interface RealtimeWebSocketLike extends EventTargetLike {
  readonly readyState: number;
  binaryType?: string;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface OpenAIWebSocketFactoryOptions {
  headers: Record<string, string>;
  protocols?: string[];
}

export type OpenAIWebSocketFactory = (url: string, options: OpenAIWebSocketFactoryOptions) => RealtimeWebSocketLike;

export type OpenAIEphemeralTokenProvider = (
  config: RealtimeSessionConfig,
  signal?: AbortSignalLike,
) => string | Promise<string>;

export interface OpenAIWebSocketTransportOptions {
  url?: string;
  apiKey?: string;
  ephemeralToken?: string;
  ephemeralTokenProvider?: OpenAIEphemeralTokenProvider;
  headers?: Record<string, string>;
  protocols?: string[];
  webSocketFactory?: OpenAIWebSocketFactory;
  connectTimeoutMs?: number;
  disconnectTimeoutMs?: number;
  maxAudioChunkBytes?: number;
  codec?: Utf8Codec;
  timers?: TimerPlatform;
  now?: () => number;
}

type WebSocketTransportEventMap = RealtimeTransportEvents & Record<string, unknown>;

/** OpenAI Realtime WebSocket transport. Inject a factory such as `ws` for server-side authenticated use. */
export class OpenAIWebSocketTransport implements RealtimeTransport {
  readonly kind = 'websocket' as const;
  state: RealtimeTransportState = 'idle';

  private readonly emitter = new TypedEventEmitter<WebSocketTransportEventMap>();
  private readonly cleanups: TransportCleanup[] = [];
  private socket?: RealtimeWebSocketLike;
  private generation = 0;
  private expectedClose = false;
  private disconnectEmitted = false;
  private connectAbort?: PortableAbortController;

  constructor(private readonly options: OpenAIWebSocketTransportOptions = {}) {}

  on<Event extends keyof RealtimeTransportEvents>(
    event: Event,
    listener: (payload: RealtimeTransportEvents[Event]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  async connect(config: RealtimeSessionConfig): Promise<void> {
    if (this.state === 'connected') return;
    if (this.state === 'connecting' || this.state === 'disconnecting') throw this.invalidState('connect');

    this.cleanupListeners();
    this.state = 'connecting';
    this.expectedClose = false;
    this.disconnectEmitted = false;
    const generation = ++this.generation;
    const externalSignal = config.connection?.signal || config.signal;
    const controller = new PortableAbortController();
    this.connectAbort = controller;
    const signal = controller.signal;
    this.cleanups.push(
      onAbort(externalSignal, () => {
        controller.abort(externalSignal?.reason);
        if (this.state === 'connected') void this.disconnect();
      }),
    );

    try {
      if (signal?.aborted) throw this.abortError(signal.reason);
      const token = await waitForTransportOperation(this.resolveToken(config, signal), {
        signal,
        timers: this.timers(),
        timeoutMs: this.options.connectTimeoutMs ?? 10_000,
        abortError: (reason) => this.abortError(reason),
        timeoutError: () =>
          new RealtimeError({
            message: 'OpenAI realtime WebSocket credential resolution timed out',
            code: 'connection_timeout',
            category: 'timeout',
            provider: 'openai',
            retryable: true,
          }),
      });
      if (generation !== this.generation || this.state !== 'connecting') throw this.abortError();
      const usingGlobalFactory = !this.options.webSocketFactory;
      if (usingGlobalFactory && (!token || this.options.apiKey)) {
        throw new RealtimeError({
          message:
            'The global WebSocket adapter requires an ephemeral token; use an injected factory for server API keys',
          code: 'unsafe_browser_auth',
          category: 'authentication',
          provider: 'openai',
        });
      }

      const headers = {
        'openai-beta': 'realtime=v1',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(this.options.headers || {}),
      };
      const protocols = usingGlobalFactory ? this.browserProtocols(token as string) : this.options.protocols;
      const socket = this.createSocket(this.url(config.model), { headers, protocols });
      this.socket = socket;
      socket.binaryType = 'arraybuffer';
      await this.awaitOpen(socket, config, signal, generation);
    } catch (error) {
      const current = generation === this.generation;
      if (current) {
        this.state = 'failed';
        this.cleanupListeners();
        this.closeSocket(4000, 'connection failed');
        this.socket = undefined;
        this.connectAbort = undefined;
      }
      const normalized = toRealtimeError(error, {
        message: error instanceof RealtimeError ? error.message : 'OpenAI realtime WebSocket connection failed',
        code: error instanceof RealtimeError ? error.code : 'websocket_connection_failed',
        category: error instanceof RealtimeError ? error.category : 'network',
        provider: 'openai',
        retryable: error instanceof RealtimeError ? error.retryable : true,
      });
      if (current) this.emitter.emit('error', normalized);
      throw normalized;
    }
  }

  sendAudio(chunk: ArrayBuffer): void {
    const limit = this.options.maxAudioChunkBytes ?? DEFAULT_MAX_AUDIO_BYTES;
    if (chunk.byteLength > limit) {
      const error = new RealtimeError({
        message: `Realtime audio chunk exceeds the ${limit} byte limit`,
        code: 'audio_too_large',
        category: 'configuration',
        provider: 'openai',
      });
      this.emitter.emit('error', error);
      throw error;
    }
    this.sendEvent({ type: 'input_audio_buffer.append', audio: encodeBase64(chunk) });
  }

  sendEvent(event: RealtimeClientEvent): void {
    const socket = this.requireOpenSocket();
    try {
      socket.send(safeJsonStringify(event));
    } catch (error) {
      const normalized = toRealtimeError(error, {
        message: 'Failed to serialize or send a realtime WebSocket event',
        code: 'websocket_send_failed',
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
    this.connectAbort?.abort('client disconnect');
    const socket = this.socket;
    if (!socket) {
      this.finishDisconnect(undefined, true);
      return;
    }

    if (socket.readyState === 2 || socket.readyState === 3) {
      this.finishDisconnect(undefined, true);
      return;
    }

    const timers = this.timers();
    await new Promise<void>((resolve) => {
      let settled = false;
      let removeClose: TransportCleanup = () => undefined;
      let timeout: unknown;
      const done = () => {
        if (settled) return;
        settled = true;
        removeClose();
        if (timeout !== undefined) timers.clearTimeout(timeout);
        resolve();
      };
      removeClose = listen(socket, 'close', done);
      if (settled) {
        removeClose();
        return;
      }
      const handle = timers.setTimeout(done, this.options.disconnectTimeoutMs ?? 1_000);
      if (settled) timers.clearTimeout(handle);
      else timeout = handle;
      try {
        socket.close(1000, 'client disconnect');
      } catch {
        done();
      }
    });
    this.finishDisconnect(undefined, true);
  }

  private awaitOpen(
    socket: RealtimeWebSocketLike,
    config: RealtimeSessionConfig,
    signal: AbortSignalLike,
    generation: number,
  ): Promise<void> {
    const timers = this.timers();
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: unknown;
      let removeAbort: TransportCleanup = () => undefined;
      const settle = (error?: RealtimeError) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) timers.clearTimeout(timeout);
        removeAbort();
        if (error) reject(error);
        else resolve();
      };
      const current = () => generation === this.generation;
      const onOpen = (raw: unknown) => {
        if (!current()) return;
        this.state = 'connected';
        this.emitter.emit('connected', {
          sessionId: config.id,
          transport: this.kind,
          timestamp: this.now(),
          raw,
        });
        settle();
      };
      const onMessage = (raw: unknown) => {
        if (current()) this.handleMessage(raw);
      };
      const onError = (raw: unknown) => {
        if (!current()) return;
        const error = new RealtimeError({
          message: 'OpenAI realtime WebSocket reported a network error',
          code: 'websocket_error',
          category: 'network',
          provider: 'openai',
          retryable: true,
          raw: this.safeRawError(raw),
        });
        if (this.state === 'connecting') settle(error);
        else this.emitter.emit('error', error);
      };
      const onClose = (raw: unknown) => {
        if (!current() && !this.expectedClose) return;
        const close = this.closeDetails(raw);
        const expected = this.expectedClose;
        if (this.state === 'connecting') {
          settle(
            new RealtimeError({
              message: `OpenAI realtime WebSocket closed before opening${close.reason ? `: ${close.reason}` : ''}`,
              code: 'websocket_closed_during_connect',
              category: 'network',
              provider: 'openai',
              retryable: !expected,
            }),
          );
          return;
        }
        this.finishDisconnect(raw, expected, close.code, close.reason);
      };

      this.cleanups.push(
        listen(socket, 'open', onOpen),
        listen(socket, 'message', onMessage),
        listen(socket, 'error', onError),
        listen(socket, 'close', onClose),
      );
      removeAbort = onAbort(signal, () => {
        this.expectedClose = true;
        settle(this.abortError(signal?.reason));
        this.closeSocket(1000, 'aborted');
      });
      this.cleanups.push(removeAbort);
      if (socket.readyState === 1 && !settled) onOpen(undefined);
      if (!settled) {
        const handle = timers.setTimeout(() => {
          this.expectedClose = true;
          settle(
            new RealtimeError({
              message: 'OpenAI realtime WebSocket connection timed out',
              code: 'connection_timeout',
              category: 'timeout',
              provider: 'openai',
              retryable: true,
            }),
          );
          this.closeSocket(4000, 'connection timeout');
        }, this.options.connectTimeoutMs ?? 10_000);
        if (settled) timers.clearTimeout(handle);
        else timeout = handle;
      }
    });
  }

  private handleMessage(message: unknown): void {
    const raw = eventPayload(message);
    let event: RealtimeServerEvent;
    try {
      const codec = this.options.codec || defaultUtf8Codec();
      const text =
        typeof raw === 'string'
          ? raw
          : raw instanceof ArrayBuffer || raw instanceof Uint8Array
            ? codec.decode(raw)
            : undefined;
      if (text === undefined) throw new Error('Unsupported WebSocket message payload');
      event = safeJsonParse(text) as RealtimeServerEvent;
    } catch (error) {
      this.emitter.emit(
        'error',
        toRealtimeError(error, {
          message: 'Received an invalid realtime WebSocket event',
          code: 'invalid_websocket_event',
          category: 'protocol',
          provider: 'openai',
        }),
      );
      return;
    }
    this.emitter.emit('data', { event, raw });
  }

  private requireOpenSocket(): RealtimeWebSocketLike {
    if (this.state !== 'connected' || !this.socket || this.socket.readyState !== 1) throw this.invalidState('send');
    return this.socket;
  }

  private async resolveToken(config: RealtimeSessionConfig, signal?: AbortSignalLike): Promise<string | undefined> {
    if (this.options.ephemeralTokenProvider) return this.options.ephemeralTokenProvider(config, signal);
    if (this.options.ephemeralToken) return this.options.ephemeralToken;
    return this.options.apiKey;
  }

  private createSocket(url: string, options: OpenAIWebSocketFactoryOptions): RealtimeWebSocketLike {
    if (this.options.webSocketFactory) return this.options.webSocketFactory(url, options);
    const Constructor = (
      globalThis as unknown as {
        WebSocket?: new (url: string, protocols?: string | string[]) => RealtimeWebSocketLike;
      }
    ).WebSocket;
    if (!Constructor) {
      throw new RealtimeError({
        message: 'This environment does not provide WebSocket; inject webSocketFactory',
        code: 'unsupported_environment',
        category: 'capability',
        provider: 'openai',
      });
    }
    return new Constructor(url, options.protocols);
  }

  private browserProtocols(token: string): string[] {
    return [
      'realtime',
      `openai-insecure-api-key.${token}`,
      'openai-beta.realtime-v1',
      ...(this.options.protocols || []),
    ];
  }

  private url(model: string): string {
    const base = this.options.url || DEFAULT_URL;
    if (/[?&]model=/.test(base)) return base;
    return `${base}${base.includes('?') ? '&' : '?'}model=${encodeURIComponent(model)}`;
  }

  private closeDetails(raw: unknown): { code?: number; reason?: string } {
    if (typeof raw === 'number') return { code: raw };
    if (!isRecord(raw)) return {};
    return {
      code: typeof raw.code === 'number' ? raw.code : undefined,
      reason: typeof raw.reason === 'string' ? raw.reason : undefined,
    };
  }

  private safeRawError(raw: unknown): unknown {
    if (!isRecord(raw)) return undefined;
    return {
      type: typeof raw.type === 'string' ? raw.type : undefined,
      message: typeof raw.message === 'string' ? raw.message : undefined,
    };
  }

  private finishDisconnect(raw: unknown, expected: boolean, code?: number, reason?: string): void {
    if (this.disconnectEmitted) return;
    this.disconnectEmitted = true;
    this.state = expected ? 'disconnected' : 'failed';
    this.emitter.emit('disconnected', {
      transport: this.kind,
      timestamp: this.now(),
      code,
      reason,
      expected,
      retryable: !expected,
      raw,
    });
    this.cleanupListeners();
    this.socket = undefined;
    this.connectAbort = undefined;
  }

  private closeSocket(code: number, reason: string): void {
    try {
      this.socket?.close(code, reason);
    } catch {
      // Best effort.
    }
  }

  private cleanupListeners(): void {
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
  }

  private invalidState(action: string): RealtimeError {
    return new RealtimeError({
      message: `Cannot ${action} while OpenAI WebSocket transport is ${this.state}`,
      code: 'invalid_state',
      category: 'configuration',
      provider: 'openai',
    });
  }

  private abortError(cause?: unknown): RealtimeError {
    return new RealtimeError({
      message: 'OpenAI realtime WebSocket connection was aborted',
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
