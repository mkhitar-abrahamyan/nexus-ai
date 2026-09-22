import { RealtimeError } from './errors.js';
import { TypedEventEmitter } from './events.js';
import { copyArrayBuffer } from './transport-utils.js';
import type {
  RealtimeClientEvent,
  RealtimeServerEvent,
  RealtimeSessionConfig,
  RealtimeTransport,
  RealtimeTransportAudioEvent,
  RealtimeTransportDisconnectedEvent,
  RealtimeTransportEvents,
  RealtimeTransportState,
} from './types.js';

/** One scripted step of the mock transport: a provider event, audio, an error, or a disconnect. */
export type MockRealtimeTransportStep =
  | { type: 'data'; event: RealtimeServerEvent; raw?: unknown }
  | { type: 'audio'; audio: RealtimeTransportAudioEvent }
  | { type: 'error'; error: RealtimeError | Error | string }
  | { type: 'disconnect'; event?: Partial<RealtimeTransportDisconnectedEvent> };

/** Options for the mock transport. */
export interface MockRealtimeTransportOptions {
  /** Steps played back after connecting. A bare event is treated as a `data` step. */
  script?: Array<MockRealtimeTransportStep | RealtimeServerEvent>;
  /**
   * Plays the script as soon as the transport connects. Defaults to true; `false` leaves it to
   * `advance()` and `flush()`.
   */
  autoPlay?: boolean;
  /** Session id reported when connected. */
  sessionId?: string;
  /** Replaces the system clock. */
  now?: () => number;
  /** Throws when used in the wrong state, as a real transport does. Defaults to true. */
  strictState?: boolean;
}

type MockTransportEventMap = RealtimeTransportEvents & Record<string, unknown>;

/** Deterministic transport for unit tests, demos, and session state-machine simulation. */
export class MockRealtimeTransport implements RealtimeTransport {
  /** Always `mock`. */
  readonly kind = 'mock' as const;
  /** Current connection state. */
  state: RealtimeTransportState = 'idle';
  /** Every event sent, for assertions. */
  readonly sentEvents: RealtimeClientEvent[] = [];
  /** Every audio chunk sent, for assertions. */
  readonly sentAudio: ArrayBuffer[] = [];
  /** Every configuration `connect()` received. */
  readonly connectionConfigs: RealtimeSessionConfig[] = [];

  private readonly emitter = new TypedEventEmitter<MockTransportEventMap>();
  private readonly queue: MockRealtimeTransportStep[] = [];
  private readonly options: MockRealtimeTransportOptions;

  constructor(
    scriptOrOptions: Array<MockRealtimeTransportStep | RealtimeServerEvent> | MockRealtimeTransportOptions = {},
  ) {
    this.options = Array.isArray(scriptOrOptions) ? { script: scriptOrOptions } : scriptOrOptions;
    for (const step of this.options.script || []) this.enqueue(step);
  }

  /** Subscribes to a transport event. Returns a function that unsubscribes. */
  on<Event extends keyof RealtimeTransportEvents>(
    event: Event,
    listener: (payload: RealtimeTransportEvents[Event]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  /** Connects immediately and, unless `autoPlay` is off, plays the script. */
  async connect(config: RealtimeSessionConfig): Promise<void> {
    if (this.state === 'connected') return;
    if (this.state === 'connecting' || this.state === 'disconnecting') {
      throw this.invalidState('connect');
    }

    this.state = 'connecting';
    this.connectionConfigs.push(config);
    const signal = config.connection?.signal || config.signal;
    if (signal?.aborted) {
      this.state = 'failed';
      throw new RealtimeError({
        message: 'Mock realtime connection was aborted',
        code: 'aborted',
        category: 'abort',
        provider: config.provider,
        cause: signal.reason,
      });
    }

    this.state = 'connected';
    this.emitter.emit('connected', {
      sessionId: this.options.sessionId || config.id,
      transport: this.kind,
      timestamp: this.now(),
    });

    if (this.options.autoPlay !== false) this.flush();
  }

  /** Records an audio chunk. */
  sendAudio(chunk: ArrayBuffer): void {
    this.assertConnected('send audio');
    this.sentAudio.push(copyArrayBuffer(chunk));
  }

  /** Records an event. */
  sendEvent(event: RealtimeClientEvent): void {
    this.assertConnected('send an event');
    this.sentEvents.push({ ...event });
  }

  /** Records a `response.cancel` event. */
  interrupt(): void {
    this.sendEvent({ type: 'response.cancel' });
  }

  /** Disconnects cleanly. */
  async disconnect(): Promise<void> {
    if (this.state === 'idle' || this.state === 'disconnected') {
      this.state = 'disconnected';
      return;
    }
    if (this.state === 'disconnecting') return;

    this.state = 'disconnecting';
    this.state = 'disconnected';
    this.emitter.emit('disconnected', {
      transport: this.kind,
      timestamp: this.now(),
      expected: true,
      retryable: false,
    });
  }

  /** Adds a step to the script. Returns the transport, for chaining. */
  enqueue(step: MockRealtimeTransportStep | RealtimeServerEvent): this {
    const mockError = step.type === 'error' && 'error' in step ? step.error : undefined;
    const controlStep =
      (step.type === 'data' && 'event' in step) ||
      (step.type === 'audio' && 'audio' in step && typeof step.audio === 'object') ||
      (step.type === 'error' &&
        (typeof mockError === 'string' || mockError instanceof Error || mockError instanceof RealtimeError)) ||
      step.type === 'disconnect';
    if (controlStep) {
      this.queue.push(step as MockRealtimeTransportStep);
    } else {
      this.queue.push({ type: 'data', event: step as RealtimeServerEvent });
    }
    return this;
  }

  /** Emits the next scripted step. Returns false when the script is exhausted. */
  advance(): boolean {
    const step = this.queue.shift();
    if (!step) return false;
    this.emitStep(step);
    return true;
  }

  /** Emits every currently queued step synchronously and in insertion order. */
  flush(): void {
    while (this.state === 'connected' && this.advance()) {
      // Intentionally empty.
    }
  }

  /** Emits a provider event now. */
  emitData(event: RealtimeServerEvent, raw?: unknown): void {
    this.assertConnected('emit data');
    this.emitter.emit('data', { event, raw: raw ?? event });
  }

  /** Emits model audio now. */
  emitAudio(audio: RealtimeTransportAudioEvent): void {
    this.assertConnected('emit audio');
    this.emitter.emit('audio', {
      ...audio,
      data: audio.data ? copyArrayBuffer(audio.data) : undefined,
    });
  }

  /** Emits a transport error now. */
  emitError(error: RealtimeError | Error | string): void {
    const normalized =
      error instanceof RealtimeError
        ? error
        : new RealtimeError({
            message: error instanceof Error ? error.message : error,
            category: 'provider',
            provider: 'mock',
            cause: error instanceof Error ? error : undefined,
          });
    this.emitter.emit('error', normalized);
  }

  /** Simulates a dropped connection, retryable unless marked expected. */
  emitDisconnected(event: Partial<RealtimeTransportDisconnectedEvent> = {}): void {
    this.state = event.expected === false ? 'failed' : 'disconnected';
    this.emitter.emit('disconnected', {
      transport: this.kind,
      timestamp: this.now(),
      expected: false,
      retryable: event.expected !== true,
      ...event,
    });
  }

  /** Clears the recorded events, audio, and configurations. */
  clearRecords(): void {
    this.sentEvents.length = 0;
    this.sentAudio.length = 0;
    this.connectionConfigs.length = 0;
  }

  private emitStep(step: MockRealtimeTransportStep): void {
    if (step.type === 'data') this.emitData(step.event, step.raw);
    else if (step.type === 'audio') this.emitAudio(step.audio);
    else if (step.type === 'error') this.emitError(step.error);
    else this.emitDisconnected(step.event);
  }

  private assertConnected(action: string): void {
    if (this.options.strictState === false || this.state === 'connected') return;
    throw this.invalidState(action);
  }

  private invalidState(action: string): RealtimeError {
    return new RealtimeError({
      message: `Cannot ${action} while mock realtime transport is ${this.state}`,
      code: 'invalid_state',
      category: 'configuration',
      provider: 'mock',
    });
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
