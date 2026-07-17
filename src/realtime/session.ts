import {
  createRealtimeConversation,
  exportRealtimeConversation,
  reduceRealtimeConversation,
  snapshotRealtimeConversation,
} from './conversation.js';
import { RealtimeError, toRealtimeError } from './errors.js';
import { TypedEventEmitter } from './events.js';
import { createRealtimeId } from './id.js';
import {
  createOpenAISessionUpdate,
  createOpenAIToolResultEvents,
  normalizeOpenAIRealtimeEvent,
} from './openai-events.js';
import { RealtimeToolExecutor } from './tools.js';
import type {
  ConversationMetrics,
  RealtimeAnalyticsExport,
  RealtimeAudioFormat,
  RealtimeClientEvent,
  RealtimeClock,
  RealtimeConnectOptions,
  RealtimeConversation,
  RealtimeConversationExportFormat,
  RealtimeEvent,
  RealtimeInterruptionOptions,
  RealtimeServerEvent,
  RealtimeSessionConfig,
  RealtimeSessionEvents,
  RealtimeSessionState,
  RealtimeSpanLike,
  RealtimeToolCall,
  RealtimeToolResult,
  RealtimeTransportAudioEvent,
  RealtimeTransportConnectedEvent,
  RealtimeTransportDisconnectedEvent,
} from './types.js';

interface PendingConfirmation {
  resolve: (approved: boolean) => void;
  signal: AbortSignal;
  timeout?: ReturnType<typeof setTimeout>;
  abort?: () => void;
}

export class RealtimeSession {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  private readonly emitter = new TypedEventEmitter<RealtimeSessionEvents>();
  private readonly clock: RealtimeClock;
  private readonly controller = new AbortController();
  private readonly transportUnsubscribers: Array<() => void> = [];
  private readonly rawEvents: RealtimeServerEvent[] = [];
  private readonly pendingCalls = new Map<string, RealtimeToolCall>();
  private readonly pendingConfirmations = new Map<string, PendingConfirmation>();
  private readonly seenToolCalls = new Set<string>();
  private readonly interruptedResponses = new Set<string>();
  private readonly outbox: RealtimeClientEvent[] = [];
  private readonly toolExecutor: RealtimeToolExecutor;
  private connectPromise?: Promise<void>;
  private reconnectPromise?: Promise<void>;
  private eventQueue: Promise<void> = Promise.resolve();
  private conversation: RealtimeConversation;
  private sessionState: RealtimeSessionState = 'idle';
  private providerSessionId?: string;
  private activeConnection?: RealtimeConnectOptions;
  private pendingConnectedEvent?: RealtimeTransportConnectedEvent;
  private hasConnected = false;
  private manualDisconnect = false;
  private connectionStartedAt = 0;
  private speechEndedAt?: number;
  private turnStartedAt?: number;
  private toolResultAt?: number;
  private firstAudioRecorded = false;
  private activeResponseId?: string;
  private activeItemId?: string;
  private outputPlaybackStartedAt?: number;
  private sessionTimeout?: ReturnType<typeof setTimeout>;
  private audioLimitTriggered = false;
  private activeConnectionCounted = false;
  private connectionSpan?: RealtimeSpanLike;

  constructor(private readonly config: RealtimeSessionConfig) {
    this.id = config.id || (config.idFactory || createRealtimeId)('session');
    this.provider = config.provider || 'openai';
    this.model = config.model;
    this.clock = config.clock || defaultClock;
    this.conversation = createRealtimeConversation({
      id: this.id,
      provider: this.provider,
      model: this.model,
      startedAt: new Date(this.clock.now()).toISOString(),
      metadata: config.metadata,
      idFactory: config.idFactory,
    });
    const allowedTools = intersectAllowlists(config.toolExecution?.allowedTools, config.security?.toolAllowlist);
    this.toolExecutor = new RealtimeToolExecutor(config.tools || [], {
      ...config.toolExecution,
      allowedTools,
      sessionId: this.id,
      signal: this.controller.signal,
      clock: this.clock,
      idFactory: config.idFactory,
      confirm: config.toolExecution?.confirm || ((call, signal) => this.awaitConfirmation(call, signal)),
      onConfirmationRequired: (call) => {
        this.applyEvent({ type: 'tool.confirmation.required', call, timestamp: this.clock.now() });
      },
      onCompleted: (result) => {
        void this.handleToolResult(result);
      },
    });
    this.bindTransport();
    this.bindAbortSignal(config.signal);
  }

  get state(): RealtimeSessionState {
    return this.sessionState;
  }

  get sessionId(): string {
    return this.providerSessionId || this.id;
  }

  on<Event extends keyof RealtimeSessionEvents>(
    event: Event,
    listener: (payload: RealtimeSessionEvents[Event]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  once<Event extends keyof RealtimeSessionEvents>(
    event: Event,
    listener: (payload: RealtimeSessionEvents[Event]) => void,
  ): () => void {
    return this.emitter.once(event, listener);
  }

  getConversation(): RealtimeConversation {
    return snapshotRealtimeConversation(this.conversation);
  }

  getMetrics(): ConversationMetrics {
    return { ...this.conversation.metrics };
  }

  getRawEvents(): RealtimeServerEvent[] {
    return this.rawEvents.map((event) => ({ ...event }));
  }

  /** Waits until all provider events already received by the session have been normalized. */
  async whenIdle(): Promise<void> {
    await this.eventQueue;
  }

  export(format: 'json'): RealtimeConversation;
  export(format: 'openai-events'): RealtimeServerEvent[];
  export(format: 'text'): string;
  export(format: 'analytics'): RealtimeAnalyticsExport;
  export(
    format: RealtimeConversationExportFormat,
  ): RealtimeConversation | RealtimeServerEvent[] | string | RealtimeAnalyticsExport {
    return exportRealtimeConversation(this.conversation, format, this.rawEvents);
  }

  async connect(options: RealtimeConnectOptions = {}): Promise<void> {
    if (this.sessionState === 'connected') return;
    if (this.connectPromise) return this.connectPromise;
    if (this.controller.signal.aborted) throw abortError(this.controller.signal);
    if (this.sessionState === 'disconnected') {
      throw new RealtimeError({
        message: 'A disconnected realtime session cannot be connected again; create a new session',
        code: 'session_closed',
        category: 'configuration',
      });
    }

    this.manualDisconnect = false;
    this.setState('connecting');
    this.connectionStartedAt = this.clock.now();
    this.connectionSpan = this.runTelemetry(() =>
      this.config.telemetry?.tracer?.startSpan('nexus.realtime.connect', {
        attributes: this.telemetryAttributes(),
      }),
    );
    const mergedConfig = this.effectiveSessionConfig({
      ...this.config,
      connection: { ...this.config.connection, ...options },
      signal: options.signal || this.config.signal || this.controller.signal,
    });
    this.activeConnection = mergedConfig.connection;
    this.bindAbortSignal(options.signal);

    this.connectPromise = (async () => {
      try {
        await this.config.transport.connect(mergedConfig);
        if (this.manualDisconnect || this.controller.signal.aborted) throw abortError(this.controller.signal);
        this.config.transport.sendEvent(createOpenAISessionUpdate(mergedConfig));
        this.completeConnection(this.pendingConnectedEvent);
        this.flushOutbox();
        this.startSessionLimit();
        this.runTelemetry(() => this.connectionSpan?.end());
      } catch (error) {
        const normalized = toRealtimeError(error, {
          code: 'realtime_connect_failed',
          category: this.controller.signal.aborted ? 'abort' : 'network',
          provider: this.provider,
          retryable: !this.controller.signal.aborted,
          fatal: true,
        });
        this.runTelemetry(() => {
          this.connectionSpan?.recordException?.(normalized);
          this.connectionSpan?.end();
        });
        if (!this.manualDisconnect) {
          this.runTelemetry(() =>
            this.config.telemetry?.meter
              ?.createCounter?.('nexus.realtime.connection_failures')
              .add?.(1, this.telemetryAttributes()),
          );
          this.setState('failed');
          this.applyEvent({ type: 'error', error: normalized, timestamp: this.clock.now() });
        }
        throw normalized;
      } finally {
        this.connectPromise = undefined;
        this.connectionSpan = undefined;
      }
    })();
    return this.connectPromise;
  }

  async disconnect(): Promise<void> {
    if (this.sessionState === 'disconnected') return;
    this.manualDisconnect = true;
    this.setState('disconnecting');
    if (!this.controller.signal.aborted) this.controller.abort(new Error('Realtime session disconnected'));
    if (this.sessionTimeout) clearTimeout(this.sessionTimeout);
    this.resolveAllConfirmations(false);
    try {
      await this.config.transport.disconnect();
    } finally {
      this.finishDisconnect('client disconnect', true);
      for (const unsubscribe of this.transportUnsubscribers.splice(0)) unsubscribe();
    }
  }

  sendEvent(event: RealtimeClientEvent): void {
    this.sendProviderEvent(event);
  }

  sendAudio(chunk: ArrayBuffer): void {
    this.assertConnected('send audio');
    this.config.transport.sendAudio(chunk);
  }

  sendText(text: string, createResponse = true): void {
    if (!text.trim()) throw new Error('Realtime text input must not be empty');
    this.sendProviderEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text }],
      },
    });
    if (createResponse) this.createResponse();
  }

  commitAudio(createResponse = true): void {
    this.sendProviderEvent({ type: 'input_audio_buffer.commit' });
    if (createResponse) this.createResponse();
  }

  clearAudio(): void {
    this.sendProviderEvent({ type: 'input_audio_buffer.clear' });
  }

  createResponse(response?: Record<string, unknown>): void {
    this.sendProviderEvent(response ? { type: 'response.create', response } : { type: 'response.create' });
  }

  updateSession(session: Record<string, unknown>): void {
    this.sendProviderEvent({ type: 'session.update', session });
  }

  interrupt(reason: 'barge_in' | 'manual' = 'manual'): void {
    this.performInterruption(reason, true);
  }

  private performInterruption(reason: 'barge_in' | 'manual', cancelProvider: boolean): void {
    if (this.sessionState !== 'connected') return;
    if (!this.activeResponseId || this.interruptedResponses.has(this.activeResponseId)) return;
    const options = this.interruptionOptions();
    options.stopPlayback?.();
    if (cancelProvider && options.cancelResponse) this.config.transport.interrupt();
    const audioEndMs = options.getPlaybackPositionMs?.();
    if (
      options.truncateUnheardAudio &&
      this.config.transport.kind === 'websocket' &&
      this.activeItemId &&
      audioEndMs !== undefined
    ) {
      this.config.transport.sendEvent({
        type: 'conversation.item.truncate',
        item_id: this.activeItemId,
        content_index: 0,
        audio_end_ms: Math.max(0, Math.round(audioEndMs)),
      });
    }
    this.rememberInterruptedResponse(this.activeResponseId);
    this.applyEvent({
      type: 'interruption',
      reason,
      responseId: this.activeResponseId,
      itemId: this.activeItemId,
      audioEndMs,
      timestamp: this.clock.now(),
    });
  }

  markAudioPlayed(at = this.clock.now()): void {
    if (this.firstAudioRecorded) return;
    this.firstAudioRecorded = true;
    if (this.speechEndedAt !== undefined) {
      this.conversation.metrics.speechEndToFirstAudioMs = Math.max(0, at - this.speechEndedAt);
    }
    if (this.toolResultAt !== undefined) {
      this.conversation.metrics.toolResultToFirstAudioMs = Math.max(0, at - this.toolResultAt);
    }
    const latency = this.conversation.metrics.speechEndToFirstAudioMs;
    if (latency !== undefined) {
      this.runTelemetry(() =>
        this.config.telemetry?.meter
          ?.createHistogram?.('nexus.realtime.first_audio_latency_ms')
          .record?.(latency, this.telemetryAttributes()),
      );
    }
    this.emitMetrics();
  }

  confirmTool(callId: string, approved: boolean): boolean {
    const pending = this.pendingConfirmations.get(callId);
    if (!pending) return false;
    this.cleanupConfirmation(callId, pending);
    pending.resolve(approved);
    return true;
  }

  async executeTool(callId: string): Promise<RealtimeToolResult> {
    const call = this.pendingCalls.get(callId);
    if (!call) throw new Error(`Realtime tool call "${callId}" is not pending`);
    return this.toolExecutor.execute(call);
  }

  async submitToolResult(callId: string, result: unknown, error?: string): Promise<RealtimeToolResult> {
    const call = this.pendingCalls.get(callId);
    if (!call) throw new Error(`Realtime tool call "${callId}" is not pending`);
    const normalized: RealtimeToolResult = {
      call,
      ok: error === undefined,
      result: error === undefined ? result : undefined,
      error,
      durationMs: 0,
      attempts: 0,
    };
    await this.handleToolResult(normalized);
    return normalized;
  }

  private bindTransport(): void {
    this.transportUnsubscribers.push(
      this.config.transport.on('connected', (event) => {
        this.pendingConnectedEvent = event;
      }),
      this.config.transport.on('data', ({ event }) => this.handleRawEvent(event)),
      this.config.transport.on('audio', (event) => this.handleTransportAudio(event)),
      this.config.transport.on('error', (error) => {
        if (this.manualDisconnect && error.category === 'abort') return;
        this.applyEvent({ type: 'error', error, timestamp: this.clock.now() });
      }),
      this.config.transport.on('disconnected', (event) => this.handleTransportDisconnected(event)),
    );
  }

  private bindAbortSignal(signal?: AbortSignal): void {
    if (!signal || signal === this.controller.signal) return;
    const abort = () => {
      if (!this.controller.signal.aborted) this.controller.abort(signal.reason);
      void this.disconnect();
    };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }

  private completeConnection(event?: RealtimeTransportConnectedEvent): void {
    if (event?.sessionId) this.providerSessionId = event.sessionId;
    this.pendingConnectedEvent = undefined;
    const firstConnection = !this.hasConnected;
    this.hasConnected = true;
    this.setState('connected');
    const connected: RealtimeEvent = {
      type: 'session.connected',
      sessionId: this.providerSessionId || this.id,
      timestamp: this.clock.now(),
    };
    this.conversation.metrics.connectionSetupMs = Math.max(0, connected.timestamp - this.connectionStartedAt);
    this.applyEvent(connected);
    if (firstConnection) {
      this.runTelemetry(() =>
        this.config.telemetry?.meter?.createCounter?.('nexus.realtime.sessions').add?.(1, this.telemetryAttributes()),
      );
    }
    if (!this.activeConnectionCounted) {
      this.runTelemetry(() =>
        this.config.telemetry?.meter
          ?.createUpDownCounter?.('nexus.realtime.active_connections')
          .add?.(1, this.telemetryAttributes()),
      );
      this.activeConnectionCounted = true;
    }
  }

  private handleRawEvent(raw: RealtimeServerEvent): void {
    const timestamp = this.clock.now();
    this.emitRaw(raw);
    this.retainRawEvent(raw);
    const events = normalizeOpenAIRealtimeEvent(raw, timestamp, this.config.idFactory);
    this.eventQueue = this.eventQueue
      .then(async () => {
        this.updateUsage(raw);
        this.observeOutputBuffer(raw, timestamp);
        for (const event of events) await this.processProviderEvent(await this.applyPiiHook(event));
      })
      .catch((error) => {
        this.applyEvent({
          type: 'error',
          error: toRealtimeError(error, {
            code: 'event_processing_failed',
            category: 'protocol',
            provider: this.provider,
          }),
          timestamp: this.clock.now(),
        });
      });
  }

  private async processProviderEvent(event: RealtimeEvent): Promise<void> {
    if (this.manualDisconnect && this.sessionState === 'disconnected') return;
    if (event.type === 'session.connected') {
      this.providerSessionId = event.sessionId;
      return;
    }
    const measuredEvent = this.withAudioDuration(event);
    if (this.isLateInterruptedEvent(measuredEvent)) return;
    if (measuredEvent.type === 'speech.started' && this.interruptionOptions().enabled && this.activeResponseId) {
      // Server VAD has already cancelled the response; the client owns playback/truncation state.
      this.performInterruption('barge_in', false);
    }
    if (measuredEvent.type === 'tool.call.started') {
      this.handleToolCall(measuredEvent.call);
      return;
    }
    this.applyEvent(measuredEvent);
  }

  private async applyPiiHook(event: RealtimeEvent): Promise<RealtimeEvent> {
    const hook = this.config.security?.piiHook;
    if (!hook) return event;
    if (event.type === 'user.transcript.delta') {
      return { ...event, delta: await hook(event.delta, 'user') };
    }
    if (event.type === 'user.transcript.completed') {
      return { ...event, transcript: await hook(event.transcript, 'user') };
    }
    if (event.type === 'assistant.transcript.delta') {
      return { ...event, delta: await hook(event.delta, 'assistant') };
    }
    if (event.type === 'assistant.transcript.completed') {
      return { ...event, transcript: await hook(event.transcript, 'assistant') };
    }
    if (event.type === 'message.text.delta') {
      return {
        ...event,
        delta: await hook(event.delta, event.role === 'assistant' ? 'assistant' : 'user'),
      };
    }
    if (event.type === 'message.text.completed') {
      return {
        ...event,
        text: await hook(event.text, event.role === 'assistant' ? 'assistant' : 'user'),
      };
    }
    return event;
  }

  private handleTransportAudio(event: RealtimeTransportAudioEvent): void {
    this.activeConnection?.remoteAudioSink?.(event);
    const normalized: RealtimeEvent = event.data
      ? {
          type: 'assistant.audio.delta',
          audio: event.data,
          durationMs: audioDurationMs(event.data, {
            type: event.mimeType,
            rate: event.sampleRate,
          }),
          responseId: event.responseId || this.activeResponseId,
          itemId: event.itemId || this.activeItemId,
          timestamp: this.clock.now(),
        }
      : {
          type: 'assistant.audio.track',
          stream: event.stream,
          track: event.track,
          responseId: event.responseId || this.activeResponseId,
          itemId: event.itemId || this.activeItemId,
          timestamp: this.clock.now(),
        };
    if (!this.isLateInterruptedEvent(normalized)) this.applyEvent(normalized);
  }

  private handleToolCall(call: RealtimeToolCall): void {
    if (this.seenToolCalls.has(call.callId)) return;
    this.seenToolCalls.add(call.callId);
    this.pendingCalls.set(call.callId, call);
    this.applyEvent({ type: 'tool.call.started', call, timestamp: this.clock.now() });
    if ((this.config.toolExecution?.mode || 'automatic') === 'automatic') {
      void this.toolExecutor.execute(call);
    }
  }

  private async handleToolResult(result: RealtimeToolResult): Promise<void> {
    if (!this.pendingCalls.has(result.call.callId)) return;
    this.pendingCalls.delete(result.call.callId);
    this.toolResultAt = this.clock.now();
    this.applyEvent({ type: 'tool.call.completed', result, timestamp: this.toolResultAt });
    if (
      this.controller.signal.aborted ||
      this.sessionState === 'disconnecting' ||
      this.sessionState === 'disconnected'
    ) {
      return;
    }
    try {
      for (const event of createOpenAIToolResultEvents(result)) this.sendProviderEvent(event);
    } catch (error) {
      this.applyEvent({
        type: 'error',
        error: toRealtimeError(error, {
          message: 'Failed to return a realtime tool result to the provider',
          code: 'tool_result_send_failed',
          category: 'network',
          provider: this.provider,
          retryable: true,
        }),
        timestamp: this.clock.now(),
      });
    }
  }

  private handleTransportDisconnected(event: RealtimeTransportDisconnectedEvent): void {
    this.recordInactiveConnection();
    if (this.manualDisconnect || event.expected) {
      this.finishDisconnect(event.reason, true);
      return;
    }
    if (!this.hasConnected) return;
    const reconnect = this.config.reconnect;
    if (reconnect?.enabled && event.retryable !== false) {
      void this.reconnect();
      return;
    }
    this.finishDisconnect(event.reason, false);
  }

  private reconnect(): Promise<void> {
    if (this.reconnectPromise) return this.reconnectPromise;
    const options = this.config.reconnect || {};
    const maxAttempts = Math.max(1, options.maxAttempts || 3);
    const initialDelayMs = Math.max(0, options.initialDelayMs ?? 500);
    const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 8_000);
    const multiplier = Math.max(1, options.multiplier || 2);
    this.setState('reconnecting');

    this.reconnectPromise = (async () => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const delayMs = Math.min(maxDelayMs, initialDelayMs * multiplier ** (attempt - 1));
        this.applyEvent({ type: 'session.reconnecting', attempt, delayMs, timestamp: this.clock.now() });
        try {
          await this.clock.sleep(delayMs, this.controller.signal);
          if (this.manualDisconnect || this.controller.signal.aborted) return;
          this.connectionStartedAt = this.clock.now();
          const reconnectConfig = this.effectiveSessionConfig({
            ...this.config,
            connection: { ...this.activeConnection, signal: this.controller.signal },
            signal: this.controller.signal,
          });
          await this.config.transport.connect(reconnectConfig);
          if (this.manualDisconnect || this.controller.signal.aborted) return;
          this.config.transport.sendEvent(createOpenAISessionUpdate(reconnectConfig));
          this.completeConnection(this.pendingConnectedEvent);
          this.flushOutbox();
          return;
        } catch (error) {
          lastError = error;
          if (error instanceof RealtimeError && !error.retryable && error.category !== 'abort') break;
          if (this.controller.signal.aborted) break;
        }
      }
      if (this.manualDisconnect || this.controller.signal.aborted) return;
      const error = toRealtimeError(lastError, {
        message: `Realtime reconnect failed after ${maxAttempts} attempts`,
        code: 'reconnect_exhausted',
        category: this.controller.signal.aborted ? 'abort' : 'network',
        provider: this.provider,
        retryable: false,
        fatal: true,
      });
      this.setState('failed');
      this.applyEvent({ type: 'error', error, timestamp: this.clock.now() });
      this.finishDisconnect(error.message, false);
    })().finally(() => {
      this.reconnectPromise = undefined;
    });
    return this.reconnectPromise;
  }

  private applyEvent(event: RealtimeEvent): void {
    if (event.type === 'assistant.response.created') {
      this.activeResponseId = event.responseId;
      this.activeItemId = undefined;
      this.firstAudioRecorded = false;
      if (this.speechEndedAt !== undefined) {
        this.conversation.metrics.speechEndToResponseCreatedMs = Math.max(0, event.timestamp - this.speechEndedAt);
      }
    }
    const assistantItemId = getAssistantItemId(event);
    if (assistantItemId) this.activeItemId = assistantItemId;
    if (event.type === 'speech.stopped') {
      this.speechEndedAt = event.timestamp;
      this.turnStartedAt ??= event.timestamp;
      this.firstAudioRecorded = false;
      this.toolResultAt = undefined;
    }
    if (event.type === 'assistant.response.completed' || event.type === 'assistant.response.cancelled') {
      if (this.turnStartedAt !== undefined) {
        this.conversation.metrics.totalTurnDurationMs = Math.max(0, event.timestamp - this.turnStartedAt);
      }
      if (event.type === 'assistant.response.completed') this.interruptedResponses.delete(event.responseId);
      this.activeResponseId = undefined;
      this.activeItemId = undefined;
      this.turnStartedAt = undefined;
    }

    this.conversation = reduceRealtimeConversation(this.conversation, event, {
      ...this.config.conversation,
      captureTranscripts:
        this.config.security?.retainTranscripts === false ? false : this.config.conversation?.captureTranscripts,
      idFactory: this.config.idFactory,
    });
    this.emitNormalized(event);
    this.runTelemetry(() => this.config.telemetry?.onEvent?.(this.telemetryEvent(event)));
    this.emitConversation();
    this.emitMetrics();
    this.recordMetricEvent(event);
    this.enforceAudioLimit();
  }

  private finishDisconnect(reason: string | undefined, expected: boolean): void {
    if (this.sessionState === 'disconnected') return;
    this.finishOutputPlayback(this.clock.now());
    this.recordInactiveConnection();
    this.setState('disconnected');
    this.applyEvent({ type: 'session.disconnected', reason, expected, timestamp: this.clock.now() });
  }

  private awaitConfirmation(call: RealtimeToolCall, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timeoutMs = Math.max(1, this.config.toolExecution?.timeoutMs ?? 8_000);
      const pending: PendingConfirmation = { resolve, signal };
      pending.abort = () => {
        this.cleanupConfirmation(call.callId, pending);
        resolve(false);
      };
      pending.timeout = setTimeout(pending.abort, timeoutMs);
      signal.addEventListener('abort', pending.abort, { once: true });
      this.pendingConfirmations.set(call.callId, pending);
    });
  }

  private cleanupConfirmation(callId: string, pending: PendingConfirmation): void {
    if (pending.timeout) clearTimeout(pending.timeout);
    pending.signal.removeEventListener('abort', pending.abort || (() => {}));
    this.pendingConfirmations.delete(callId);
  }

  private resolveAllConfirmations(approved: boolean): void {
    for (const [callId, pending] of this.pendingConfirmations) {
      this.cleanupConfirmation(callId, pending);
      pending.resolve(approved);
    }
  }

  private sendProviderEvent(event: RealtimeClientEvent): void {
    if (this.sessionState === 'reconnecting' || this.sessionState === 'connecting') {
      this.outbox.push(event);
      return;
    }
    this.assertConnected(`send event "${event.type}"`);
    this.config.transport.sendEvent(event);
  }

  private flushOutbox(): void {
    while (this.outbox.length && this.sessionState === 'connected') {
      const event = this.outbox.shift();
      if (event) this.config.transport.sendEvent(event);
    }
  }

  private assertConnected(action: string): void {
    if (this.sessionState !== 'connected') {
      throw new RealtimeError({
        message: `Cannot ${action} while realtime session is ${this.sessionState}`,
        code: 'invalid_session_state',
        category: 'configuration',
      });
    }
  }

  private setState(state: RealtimeSessionState): void {
    if (this.sessionState === state) return;
    this.sessionState = state;
    this.emitter.emit('state', state);
  }

  private interruptionOptions(): Required<
    Pick<RealtimeInterruptionOptions, 'enabled' | 'cancelResponse' | 'truncateUnheardAudio'>
  > &
    Pick<RealtimeInterruptionOptions, 'stopPlayback' | 'getPlaybackPositionMs'> {
    const value = this.config.interruption;
    if (value === false || value === undefined) {
      return { enabled: false, cancelResponse: true, truncateUnheardAudio: true };
    }
    if (value === true) return { enabled: true, cancelResponse: true, truncateUnheardAudio: true };
    return {
      enabled: value.enabled ?? true,
      cancelResponse: value.cancelResponse ?? true,
      truncateUnheardAudio: value.truncateUnheardAudio ?? true,
      stopPlayback: value.stopPlayback,
      getPlaybackPositionMs: value.getPlaybackPositionMs,
    };
  }

  private effectiveSessionConfig(config: RealtimeSessionConfig): RealtimeSessionConfig {
    const allowedTools = intersectAllowlists(config.toolExecution?.allowedTools, config.security?.toolAllowlist);
    return {
      ...config,
      tools: allowedTools ? config.tools?.filter((tool) => allowedTools.includes(tool.name)) : config.tools,
      toolExecution: { ...config.toolExecution, allowedTools },
    };
  }

  private withAudioDuration(event: RealtimeEvent): RealtimeEvent {
    if (event.type !== 'assistant.audio.delta' || event.durationMs !== undefined) return event;
    return {
      ...event,
      durationMs: audioDurationMs(event.audio, this.config.audio?.output?.format),
    };
  }

  private observeOutputBuffer(raw: RealtimeServerEvent, timestamp: number): void {
    if (raw.type === 'output_audio_buffer.started') {
      const responseId = typeof raw.response_id === 'string' ? raw.response_id : undefined;
      if (responseId) this.activeResponseId = responseId;
      this.outputPlaybackStartedAt ??= timestamp;
      this.markAudioPlayed(timestamp);
      return;
    }
    if (raw.type === 'output_audio_buffer.stopped' || raw.type === 'output_audio_buffer.cleared') {
      this.finishOutputPlayback(timestamp);
    }
  }

  private finishOutputPlayback(timestamp: number): void {
    if (this.outputPlaybackStartedAt === undefined) return;
    this.conversation.metrics.outputAudioDurationMs += Math.max(0, timestamp - this.outputPlaybackStartedAt);
    this.outputPlaybackStartedAt = undefined;
    this.emitMetrics();
  }

  private rememberInterruptedResponse(responseId: string): void {
    this.interruptedResponses.add(responseId);
    while (this.interruptedResponses.size > 100) {
      const oldest = this.interruptedResponses.values().next().value;
      if (typeof oldest !== 'string') break;
      this.interruptedResponses.delete(oldest);
    }
  }

  private recordInactiveConnection(): void {
    if (!this.activeConnectionCounted) return;
    this.runTelemetry(() =>
      this.config.telemetry?.meter
        ?.createUpDownCounter?.('nexus.realtime.active_connections')
        .add?.(-1, this.telemetryAttributes()),
    );
    this.activeConnectionCounted = false;
  }

  private isLateInterruptedEvent(event: RealtimeEvent): boolean {
    if (
      event.type !== 'assistant.audio.delta' &&
      event.type !== 'assistant.transcript.delta' &&
      event.type !== 'assistant.transcript.completed' &&
      !(event.type === 'message.text.delta' && event.role === 'assistant') &&
      !(event.type === 'message.text.completed' && event.role === 'assistant')
    ) {
      return false;
    }
    const responseId = event.responseId || this.activeResponseId;
    return Boolean(responseId && this.interruptedResponses.has(responseId));
  }

  private retainRawEvent(event: RealtimeServerEvent): void {
    if (this.config.conversation?.retainRawEvents === false) return;
    if (this.config.security?.retainTranscripts === false && /transcript|audio/.test(event.type)) return;
    this.rawEvents.push({ ...event });
    const maximum = Math.max(0, this.config.conversation?.maxRawEvents ?? 10_000);
    if (this.rawEvents.length > maximum) this.rawEvents.splice(0, this.rawEvents.length - maximum);
  }

  private emitRaw(event: RealtimeServerEvent): void {
    this.emitter.emit('raw.event', event);
  }

  private emitNormalized(event: RealtimeEvent): void {
    if (event.type === 'error') {
      this.emitter.emit('error', event.error);
      return;
    }
    const emitter = this.emitter as unknown as { emit(name: string, payload: unknown): void };
    emitter.emit(event.type, event);
  }

  private emitConversation(): void {
    this.emitter.emit('conversation.updated', snapshotRealtimeConversation(this.conversation));
  }

  private emitMetrics(): void {
    const metrics = { ...this.conversation.metrics };
    this.emitter.emit('metrics', metrics);
    this.runTelemetry(() => this.config.telemetry?.onMetrics?.(metrics));
  }

  private telemetryEvent(event: RealtimeEvent): RealtimeEvent {
    if (this.config.telemetry?.includeTranscripts === true) return event;
    if (event.type === 'user.transcript.delta') return { ...event, delta: '[REDACTED]' };
    if (event.type === 'user.transcript.completed') return { ...event, transcript: '[REDACTED]' };
    if (event.type === 'assistant.transcript.delta') return { ...event, delta: '[REDACTED]' };
    if (event.type === 'assistant.transcript.completed') return { ...event, transcript: '[REDACTED]' };
    if (event.type === 'message.text.delta') return { ...event, delta: '[REDACTED]' };
    if (event.type === 'message.text.completed') return { ...event, text: '[REDACTED]' };
    return event;
  }

  private telemetryAttributes(): Record<string, string | number | boolean> {
    return {
      provider: this.provider,
      model: this.model,
      transport: this.config.transport.kind,
      sessionId: this.id,
      ...this.config.telemetry?.attributes,
    };
  }

  private recordMetricEvent(event: RealtimeEvent): void {
    this.runTelemetry(() => {
      const meter = this.config.telemetry?.meter;
      if (!meter) return;
      if (event.type === 'error') meter.createCounter?.('nexus.realtime.errors').add?.(1, this.telemetryAttributes());
      if (event.type === 'interruption') {
        meter.createCounter?.('nexus.realtime.interruptions').add?.(1, this.telemetryAttributes());
      }
      if (event.type === 'session.reconnecting') {
        meter.createCounter?.('nexus.realtime.reconnects').add?.(1, this.telemetryAttributes());
      }
      if (event.type === 'tool.call.completed') {
        meter
          .createHistogram?.('nexus.realtime.tool_duration_ms')
          .record?.(event.result.durationMs, this.telemetryAttributes());
      }
    });
  }

  private runTelemetry<T>(callback: () => T): T | undefined {
    try {
      return callback();
    } catch {
      return undefined;
    }
  }

  private updateUsage(raw: RealtimeServerEvent): void {
    if (raw.type !== 'response.done') return;
    const response = asRecord(raw.response);
    const usage = asRecord(response?.usage);
    if (!usage) return;
    const input = finiteNumber(usage.input_tokens) ?? finiteNumber(usage.total_input_tokens);
    const output = finiteNumber(usage.output_tokens) ?? finiteNumber(usage.total_output_tokens);
    if (input !== undefined) this.conversation.metrics.inputTokens = input;
    if (output !== undefined) this.conversation.metrics.outputTokens = output;
    try {
      const estimated = this.config.telemetry?.estimateCost?.({
        provider: this.provider,
        model: this.model,
        inputTokens: input,
        outputTokens: output,
        raw: usage,
      });
      if (estimated !== undefined && Number.isFinite(estimated) && estimated >= 0) {
        this.conversation.metrics.estimatedCost = estimated;
      }
    } catch {
      // Telemetry callbacks must not disrupt the realtime event loop.
    }
  }

  private startSessionLimit(): void {
    const maximum = this.config.security?.maxSessionDurationMs;
    if (!maximum || maximum <= 0 || this.sessionTimeout) return;
    this.sessionTimeout = setTimeout(() => {
      const error = new RealtimeError({
        message: `Realtime session exceeded maximum duration of ${maximum}ms`,
        code: 'max_session_duration',
        category: 'configuration',
        fatal: true,
      });
      this.applyEvent({ type: 'error', error, timestamp: this.clock.now() });
      void this.disconnect();
    }, maximum);
  }

  private enforceAudioLimit(): void {
    const maximum = this.config.security?.maxAudioDurationMs;
    if (this.audioLimitTriggered || !maximum || this.conversation.metrics.inputAudioDurationMs <= maximum) {
      return;
    }
    this.audioLimitTriggered = true;
    const error = new RealtimeError({
      message: `Realtime input audio exceeded maximum duration of ${maximum}ms`,
      code: 'max_audio_duration',
      category: 'configuration',
      fatal: true,
    });
    this.applyEvent({ type: 'error', error, timestamp: this.clock.now() });
    void this.disconnect();
  }
}

export function createRealtimeSession(config: RealtimeSessionConfig): RealtimeSession {
  return new RealtimeSession(config);
}

const defaultClock: RealtimeClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        reject(abortError(signal));
      };
      const timeout = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', abort, { once: true });
    });
  },
};

function abortError(signal?: AbortSignal): RealtimeError {
  return new RealtimeError({
    message: signal?.reason instanceof Error ? signal.reason.message : 'Realtime session was aborted',
    code: 'realtime_aborted',
    category: 'abort',
    cause: signal?.reason,
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function intersectAllowlists(
  executionAllowlist: string[] | undefined,
  securityAllowlist: string[] | undefined,
): string[] | undefined {
  if (!executionAllowlist && !securityAllowlist) return undefined;
  if (!executionAllowlist) return [...new Set(securityAllowlist)];
  if (!securityAllowlist) return [...new Set(executionAllowlist)];
  const secure = new Set(securityAllowlist);
  return [...new Set(executionAllowlist)].filter((name) => secure.has(name));
}

function getAssistantItemId(event: RealtimeEvent): string | undefined {
  if (
    event.type === 'assistant.audio.delta' ||
    event.type === 'assistant.audio.track' ||
    event.type === 'assistant.transcript.delta' ||
    event.type === 'assistant.transcript.completed' ||
    event.type === 'assistant.response.completed' ||
    event.type === 'assistant.response.cancelled'
  ) {
    return event.itemId;
  }
  if ((event.type === 'message.text.delta' || event.type === 'message.text.completed') && event.role === 'assistant') {
    return event.itemId;
  }
  return undefined;
}

function audioDurationMs(audio: ArrayBuffer, format?: RealtimeAudioFormat): number | undefined {
  const rate = format?.rate ?? 24_000;
  if (!Number.isFinite(rate) || rate <= 0) return undefined;
  const type = format?.type || 'audio/pcm';
  const bytesPerSample = type === 'audio/pcmu' || type === 'audio/pcma' ? 1 : type === 'audio/pcm' ? 2 : undefined;
  return bytesPerSample ? (audio.byteLength / bytesPerSample / rate) * 1_000 : undefined;
}
