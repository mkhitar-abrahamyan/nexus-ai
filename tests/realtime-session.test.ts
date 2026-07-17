import assert from 'node:assert/strict';
import test from 'node:test';
import { TypedEventEmitter } from '../src/realtime/events.js';
import { MockRealtimeTransport } from '../src/realtime/mock.transport.js';
import { RealtimeSession } from '../src/realtime/session.js';
import type {
  ConversationMetrics,
  RealtimeClientEvent,
  RealtimeClock,
  RealtimeServerEvent,
  RealtimeSessionConfig,
  RealtimeSessionEvents,
  RealtimeTransport,
  RealtimeTransportEvents,
  RealtimeTransportState,
} from '../src/realtime/types.js';

class FakeClock implements RealtimeClock {
  nowMs = 1_000;
  readonly sleeps: number[] = [];

  now(): number {
    return this.nowMs;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    this.sleeps.push(ms);
    this.nowMs += ms;
    return Promise.resolve();
  }
}

class RecordingTransport implements RealtimeTransport {
  readonly kind = 'websocket' as const;
  state: RealtimeTransportState = 'idle';
  readonly sentEvents: RealtimeClientEvent[] = [];
  readonly sentAudio: ArrayBuffer[] = [];
  readonly configs: RealtimeSessionConfig[] = [];
  interruptCalls = 0;
  private readonly emitter = new TypedEventEmitter<RealtimeTransportEvents>();

  on<Event extends keyof RealtimeTransportEvents>(
    event: Event,
    listener: (payload: RealtimeTransportEvents[Event]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  async connect(config: RealtimeSessionConfig): Promise<void> {
    this.configs.push(config);
    this.state = 'connected';
    this.emitter.emit('connected', {
      sessionId: 'provider_recording',
      transport: this.kind,
      timestamp: config.clock?.now() ?? 0,
    });
  }

  sendAudio(chunk: ArrayBuffer): void {
    this.sentAudio.push(chunk.slice(0));
  }

  sendEvent(event: RealtimeClientEvent): void {
    this.sentEvents.push({ ...event });
  }

  interrupt(): void {
    this.interruptCalls += 1;
    this.sendEvent({ type: 'response.cancel' });
  }

  async disconnect(): Promise<void> {
    this.state = 'disconnected';
    this.emitter.emit('disconnected', {
      transport: this.kind,
      timestamp: 0,
      expected: true,
      retryable: false,
    });
  }

  emitData(event: RealtimeServerEvent): void {
    this.emitter.emit('data', { event, raw: event });
  }
}

function once<Event extends keyof RealtimeSessionEvents>(
  session: RealtimeSession,
  event: Event,
): Promise<RealtimeSessionEvents[Event]> {
  return new Promise((resolve) => session.once(event, resolve));
}

test('mock transport preserves scripted order, strict state, copies audio, and supports unsubscribe', async () => {
  const order: string[] = [];
  const sourceAudio = new Uint8Array([1, 2, 3]).buffer;
  const transport = new MockRealtimeTransport({
    autoPlay: false,
    sessionId: 'mock_session',
    now: () => 123,
    script: [
      { type: 'session.created', session: { id: 'provider_session' } },
      { type: 'audio', audio: { data: sourceAudio } },
      { type: 'input_audio_buffer.speech_started', item_id: 'user_1' },
    ],
  });
  const unsubscribe = transport.on('data', ({ event }) => order.push(event.type));
  transport.on('audio', ({ data }) => order.push(`audio:${new Uint8Array(data || new ArrayBuffer(0))[0]}`));

  assert.throws(() => transport.sendEvent({ type: 'before.connect' }), /mock realtime transport is idle/);
  await transport.connect({ model: 'gpt-realtime', transport });
  assert.equal(transport.state, 'connected');
  assert.equal(transport.advance(), true);
  assert.equal(transport.advance(), true);
  unsubscribe();
  assert.equal(transport.advance(), true);
  assert.equal(transport.advance(), false);
  assert.deepEqual(order, ['session.created', 'audio:1']);

  transport.sendAudio(sourceAudio);
  new Uint8Array(sourceAudio)[0] = 99;
  assert.deepEqual([...new Uint8Array(transport.sentAudio[0] || new ArrayBuffer(0))], [1, 2, 3]);
  transport.interrupt();
  assert.equal(transport.sentEvents.at(-1)?.type, 'response.cancel');
  await transport.disconnect();
  await transport.disconnect();
  assert.equal(transport.state, 'disconnected');
});

test('session emits raw then normalized events and maintains immutable conversation and latency metrics', async () => {
  const clock = new FakeClock();
  const transport = new MockRealtimeTransport({
    autoPlay: false,
    sessionId: 'provider_session',
    now: () => clock.now(),
  });
  const rawTypes: string[] = [];
  const normalized: string[] = [];
  const metricSnapshots: ConversationMetrics[] = [];
  const telemetryEvents: string[] = [];
  const session = new RealtimeSession({
    id: 'session_metrics',
    provider: 'openai',
    model: 'gpt-realtime',
    transport,
    clock,
    conversation: { maxRawEvents: 20 },
    security: {
      piiHook: async (text) => text.replace('secret', '[MASKED]'),
    },
    telemetry: {
      includeTranscripts: false,
      onEvent: (event) => {
        if (event.type === 'user.transcript.completed') telemetryEvents.push(event.transcript);
      },
    },
  });
  session.on('raw.event', (event) => rawTypes.push(event.type));
  session.on('user.transcript.completed', (event) => normalized.push(`${event.type}:${event.transcript}`));
  session.on('assistant.audio.delta', (event) => normalized.push(`${event.type}:${event.audio.byteLength}`));
  session.on('assistant.response.completed', (event) => normalized.push(`${event.type}:${event.responseId}`));
  session.on('metrics', (metrics) => metricSnapshots.push(metrics));
  session.on('conversation.updated', (snapshot) => {
    snapshot.metrics.turns = 999;
  });

  await session.connect();
  assert.equal(session.state, 'connected');
  assert.equal(session.sessionId, 'provider_session');
  assert.equal(transport.sentEvents[0]?.type, 'session.update');

  clock.nowMs = 1_100;
  transport.emitData({ type: 'input_audio_buffer.speech_started', item_id: 'user_1' });
  clock.nowMs = 1_300;
  transport.emitData({ type: 'input_audio_buffer.speech_stopped', item_id: 'user_1', audio_end_ms: 200 });
  transport.emitData({
    type: 'conversation.item.input_audio_transcription.completed',
    item_id: 'user_1',
    transcript: 'my secret',
  });
  clock.nowMs = 1_450;
  transport.emitData({ type: 'response.created', response: { id: 'response_1' } });
  clock.nowMs = 1_600;
  transport.emitData({
    type: 'response.output_audio_transcript.delta',
    response_id: 'response_1',
    item_id: 'assistant_1',
    delta: 'hello',
  });
  transport.emitData({
    type: 'response.output_audio.delta',
    response_id: 'response_1',
    item_id: 'assistant_1',
    delta: 'AQI=',
  });
  await session.whenIdle();
  session.markAudioPlayed(1_700);
  session.markAudioPlayed(1_800);
  clock.nowMs = 1_900;
  transport.emitData({
    type: 'response.done',
    response: {
      id: 'response_1',
      status: 'completed',
      output: [],
      usage: { input_tokens: 12, output_tokens: 7 },
    },
  });
  await session.whenIdle();

  assert.deepEqual(rawTypes, [
    'input_audio_buffer.speech_started',
    'input_audio_buffer.speech_stopped',
    'conversation.item.input_audio_transcription.completed',
    'response.created',
    'response.output_audio_transcript.delta',
    'response.output_audio.delta',
    'response.done',
  ]);
  assert.deepEqual(normalized, [
    'user.transcript.completed:my [MASKED]',
    'assistant.audio.delta:2',
    'assistant.response.completed:response_1',
  ]);
  assert.deepEqual(telemetryEvents, ['[REDACTED]']);
  assert.equal(session.getRawEvents().length, 7);
  const conversation = session.getConversation();
  assert.equal(conversation.metrics.turns, 1);
  assert.equal(conversation.metrics.inputAudioDurationMs, 200);
  assert.equal(conversation.metrics.speechEndToResponseCreatedMs, 150);
  assert.equal(conversation.metrics.speechEndToFirstAudioMs, 400);
  assert.equal(conversation.metrics.totalTurnDurationMs, 600);
  assert.equal(conversation.metrics.inputTokens, 12);
  assert.equal(conversation.metrics.outputTokens, 7);
  assert.notEqual(conversation.metrics.turns, 999);
  assert.equal(metricSnapshots.at(-1)?.turns, 1);
  const user = conversation.items.find((item) => item.type === 'user_speech');
  const assistant = conversation.items.find((item) => item.type === 'assistant_speech');
  assert.equal(user?.transcript, 'my [MASKED]');
  assert.equal(assistant?.transcript, 'hello');

  const exported = session.export('json');
  exported.metrics.turns = 500;
  assert.equal(session.getMetrics().turns, 1);
  assert.match(session.export('text'), /User: my \[MASKED\]/);
  assert.equal(session.export('openai-events').length, 7);
  await session.disconnect();
  assert.equal(session.state, 'disconnected');
  assert.equal(session.getConversation().status, 'completed');
});

test('session interruption cancels, truncates WebSocket audio, and ignores late response output', async () => {
  const clock = new FakeClock();
  const transport = new RecordingTransport();
  let stopCalls = 0;
  const interruptions: string[] = [];
  const session = new RealtimeSession({
    id: 'session_interrupt',
    model: 'gpt-realtime',
    transport,
    clock,
    interruption: {
      enabled: true,
      cancelResponse: true,
      truncateUnheardAudio: true,
      stopPlayback: () => {
        stopCalls += 1;
      },
      getPlaybackPositionMs: () => 123.6,
    },
  });
  session.on('interruption', (event) => interruptions.push(event.reason));
  await session.connect();

  transport.emitData({ type: 'response.created', response: { id: 'response_1' } });
  transport.emitData({
    type: 'response.output_audio_transcript.delta',
    response_id: 'response_1',
    item_id: 'assistant_1',
    delta: 'heard',
  });
  await session.whenIdle();
  session.interrupt('manual');
  session.interrupt('manual');

  assert.equal(stopCalls, 1);
  assert.equal(transport.interruptCalls, 1);
  assert.deepEqual(transport.sentEvents.slice(-2), [
    { type: 'response.cancel' },
    { type: 'conversation.item.truncate', item_id: 'assistant_1', content_index: 0, audio_end_ms: 124 },
  ]);
  transport.emitData({
    type: 'response.output_audio_transcript.delta',
    response_id: 'response_1',
    item_id: 'assistant_1',
    delta: ' not retained',
  });
  await session.whenIdle();
  const assistant = session.getConversation().items.find((item) => item.type === 'assistant_speech');
  assert.equal(assistant?.transcript, 'heard');
  assert.equal(assistant?.interrupted, true);
  assert.equal(assistant?.heardAudioMs, 123.6);

  transport.emitData({ type: 'response.done', response: { id: 'response_1', status: 'cancelled', output: [] } });
  transport.emitData({ type: 'response.created', response: { id: 'response_2' } });
  transport.emitData({
    type: 'response.output_audio_transcript.delta',
    response_id: 'response_2',
    item_id: 'assistant_2',
    delta: 'second response',
  });
  await session.whenIdle();
  transport.emitData({ type: 'input_audio_buffer.speech_started', item_id: 'user_2' });
  await session.whenIdle();

  assert.deepEqual(interruptions, ['manual', 'barge_in']);
  // Server VAD already cancels a response on speech_started; avoid a duplicate response.cancel.
  assert.equal(transport.interruptCalls, 1);
  assert.equal(stopCalls, 2);
  assert.equal(session.getMetrics().interruptions, 2);
  await session.disconnect();
});

test('session reconnect uses injected clock, queues outbound events, and restores the connection', async () => {
  const clock = new FakeClock();
  const transport = new MockRealtimeTransport({ autoPlay: false, now: () => clock.now() });
  const reconnectEvents: Array<{ attempt: number; delayMs: number }> = [];
  const session = new RealtimeSession({
    id: 'session_reconnect',
    model: 'gpt-realtime',
    transport,
    clock,
    reconnect: { enabled: true, maxAttempts: 3, initialDelayMs: 25, maxDelayMs: 100, multiplier: 2 },
  });
  session.on('session.reconnecting', ({ attempt, delayMs }) => reconnectEvents.push({ attempt, delayMs }));
  await session.connect();
  const reconnected = once(session, 'session.connected');

  transport.emitDisconnected({ expected: false, retryable: true, reason: 'network lost' });
  assert.equal(session.state, 'reconnecting');
  session.sendText('queued while reconnecting');
  await reconnected;

  assert.equal(session.state, 'connected');
  assert.deepEqual(clock.sleeps, [25]);
  assert.deepEqual(reconnectEvents, [{ attempt: 1, delayMs: 25 }]);
  assert.equal(transport.connectionConfigs.length, 2);
  assert.equal(session.getMetrics().reconnects, 1);
  assert.deepEqual(
    transport.sentEvents.slice(-3).map((event) => event.type),
    ['session.update', 'conversation.item.create', 'response.create'],
  );

  const audio = new Uint8Array([7, 8]).buffer;
  session.sendAudio(audio);
  new Uint8Array(audio)[0] = 0;
  assert.deepEqual([...new Uint8Array(transport.sentAudio.at(-1) || new ArrayBuffer(0))], [7, 8]);
  session.clearAudio();
  session.commitAudio(false);
  session.createResponse({ instructions: 'short' });
  session.updateSession({ instructions: 'updated' });
  assert.deepEqual(
    transport.sentEvents.slice(-4).map((event) => event.type),
    ['input_audio_buffer.clear', 'input_audio_buffer.commit', 'response.create', 'session.update'],
  );

  await session.disconnect();
  assert.throws(() => session.sendText('after disconnect'), /Cannot send event/);
});

test('session measures WebRTC output playback, active connections, and configurable cost', async () => {
  const clock = new FakeClock();
  const transport = new MockRealtimeTransport({ autoPlay: false, now: () => clock.now() });
  const activeConnectionDeltas: number[] = [];
  const session = new RealtimeSession({
    id: 'session_observability',
    model: 'gpt-realtime',
    transport,
    clock,
    telemetry: {
      meter: {
        createUpDownCounter: () => ({ add: (value) => activeConnectionDeltas.push(value) }),
      },
      estimateCost: ({ inputTokens = 0, outputTokens = 0 }) => inputTokens * 0.001 + outputTokens * 0.002,
    },
  });
  await session.connect();

  clock.nowMs = 1_100;
  transport.emitData({ type: 'input_audio_buffer.speech_started', item_id: 'user_metrics' });
  clock.nowMs = 1_300;
  transport.emitData({ type: 'input_audio_buffer.speech_stopped', item_id: 'user_metrics' });
  clock.nowMs = 1_400;
  transport.emitData({ type: 'response.created', response: { id: 'response_metrics' } });
  clock.nowMs = 1_550;
  transport.emitData({ type: 'output_audio_buffer.started', response_id: 'response_metrics' });
  clock.nowMs = 1_750;
  transport.emitData({ type: 'output_audio_buffer.stopped', response_id: 'response_metrics' });
  transport.emitData({
    type: 'response.done',
    response: {
      id: 'response_metrics',
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 5 },
    },
  });
  await session.whenIdle();

  assert.equal(session.getMetrics().speechEndToFirstAudioMs, 250);
  assert.equal(session.getMetrics().outputAudioDurationMs, 200);
  assert.equal(session.getMetrics().estimatedCost, 0.02);
  assert.deepEqual(activeConnectionDeltas, [1]);

  await session.disconnect();
  assert.deepEqual(activeConnectionDeltas, [1, -1]);
});
