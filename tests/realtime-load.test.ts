/**
 * What keeps a realtime session cheap on a long call: its record takes each event in place, a copy is
 * made only for a listener, and its raw history keeps audio's size, not the audio, and the latest
 * `maxRawEvents` events, trimmed in batches. The budgets themselves are `npm run bench:realtime`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRealtimeConversation, reduceRealtimeConversation } from '../src/realtime/conversation.js';
import { TypedEventEmitter } from '../src/realtime/events.js';
import { RealtimeSession } from '../src/realtime/session.js';
import type {
  RealtimeConversation,
  RealtimeServerEvent,
  RealtimeSessionConfig,
  RealtimeTransport,
  RealtimeTransportEvents,
} from '../src/realtime/types.js';

class Transport implements RealtimeTransport {
  readonly kind = 'websocket' as const;
  private readonly emitter = new TypedEventEmitter<RealtimeTransportEvents>();
  on<Event extends keyof RealtimeTransportEvents>(
    event: Event,
    listener: (payload: RealtimeTransportEvents[Event]) => void,
  ) {
    return this.emitter.on(event, listener);
  }
  async connect() {
    this.emitter.emit('connected', { sessionId: 'p', transport: this.kind, timestamp: 0 });
  }
  sendAudio() {}
  sendEvent() {}
  interrupt() {}
  async disconnect() {
    this.emitter.emit('disconnected', { transport: this.kind, timestamp: 0, expected: true, retryable: false });
  }
  emit(event: RealtimeServerEvent) {
    this.emitter.emit('data', { event, raw: event });
  }
}

const audio = (n: number): RealtimeServerEvent => ({
  type: 'response.output_audio.delta',
  response_id: 'r1',
  item_id: 'i1',
  delta: Buffer.alloc(960, n).toString('base64'),
});

async function connected(conversation: RealtimeSessionConfig['conversation'] = {}) {
  const transport = new Transport();
  const session = new RealtimeSession({ model: 'gpt-realtime', transport, conversation });
  await session.connect();
  transport.emit({ type: 'response.created', response: { id: 'r1' } });
  return { transport, session };
}

test('raw history keeps the size of audio, not the audio, unless asked to keep it', async () => {
  const plain = await connected();
  plain.transport.emit(audio(1));
  await plain.session.whenIdle();
  const kept = plain.session.getRawEvents().find((event) => event.type === 'response.output_audio.delta');
  assert.equal(kept?.delta, undefined, 'the audio is played, not kept');
  assert.equal(kept?.delta_bytes, 960, 'its size stands in for it');
  assert.equal(kept?.response_id, 'r1');
  assert.ok(plain.session.getMetrics().outputAudioDurationMs > 0, 'the audio was still measured');

  const keeping = await connected({ retainRawAudio: true });
  keeping.transport.emit(audio(2));
  await keeping.session.whenIdle();
  const all = keeping.session.getRawEvents().find((event) => event.type === 'response.output_audio.delta');
  assert.equal(all?.delta, Buffer.alloc(960, 2).toString('base64'), 'retainRawAudio keeps it');
});

test('raw history holds the latest maxRawEvents, however many arrive', async () => {
  const { transport, session } = await connected({ maxRawEvents: 50 });
  for (let n = 0; n < 500; n += 1) transport.emit({ type: 'rate_limits.updated', n });
  await session.whenIdle();
  const kept = session.getRawEvents();
  assert.equal(kept.length, 50);
  assert.equal(kept.at(-1)?.n, 499, 'the latest');
  assert.equal(kept[0]?.n, 450);
  const exported = session.export('openai-events') as unknown as RealtimeServerEvent[];
  assert.equal(exported.length, 50, 'the export holds the same events');
});

test('the reducer copies unless told the record is its own', () => {
  const record = createRealtimeConversation({ provider: 'openai', model: 'gpt-realtime' }) as RealtimeConversation;
  const event = { type: 'speech.started' as const, itemId: 'u1', timestamp: Date.parse('2026-10-16T12:00:00Z') };
  const copied = reduceRealtimeConversation(record, event);
  assert.notEqual(copied, record);
  assert.equal(record.items.length, 0, 'the record given is untouched');
  assert.equal(copied.items.length, 1);
  const same = reduceRealtimeConversation(record, event, { inPlace: true });
  assert.equal(same, record, 'in place, the record given is the record returned');
  assert.equal(record.items.length, 1);
});

test('a listener still gets a record of its own after every event', async () => {
  const { transport, session } = await connected({ captureTranscripts: true });
  const seen: RealtimeConversation[] = [];
  session.on('conversation.updated', (record) => seen.push(record));
  transport.emit({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  transport.emit({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: 'Hello' });
  await session.whenIdle();
  assert.ok(seen.length >= 2, 'one record per event');
  const last = seen.at(-1) as RealtimeConversation;
  last.items.length = 0;
  assert.equal(
    session.getConversation().items.filter((item) => item.type === 'user_speech').length,
    1,
    "a listener's record is a copy",
  );
});
