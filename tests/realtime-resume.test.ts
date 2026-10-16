/**
 * Realtime conversations that outlive their process, proved: a session writes its conversation
 * record after each committed turn; its process is killed mid-conversation; another process resumes
 * the conversation on a new transport, and the provider is given what was said and what the tool
 * returned before anything new, so the model answers with it. The provider's echoes of what it was
 * given are not recorded twice, the conversation goes on under its own id, and its record keeps
 * growing in the store. On the memory and SQLite stores.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MemoryRealtimeConversationStore, storeRealtimeConversations } from '../src/realtime/conversation.js';
import { TypedEventEmitter } from '../src/realtime/events.js';
import { RealtimeSession } from '../src/realtime/session.js';
import type {
  RealtimeClientEvent,
  RealtimeConversationStore,
  RealtimeServerEvent,
  RealtimeTransport,
  RealtimeTransportEvents,
  RealtimeTransportState,
} from '../src/realtime/types.js';
import { SqliteStore } from '../src/sqlite/store.js';

class Transport implements RealtimeTransport {
  readonly kind = 'websocket' as const;
  state: RealtimeTransportState = 'idle';
  readonly sent: RealtimeClientEvent[] = [];
  private readonly emitter = new TypedEventEmitter<RealtimeTransportEvents>();

  on<Event extends keyof RealtimeTransportEvents>(
    event: Event,
    listener: (payload: RealtimeTransportEvents[Event]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }
  async connect(): Promise<void> {
    this.state = 'connected';
    this.emitter.emit('connected', { sessionId: 'provider', transport: this.kind, timestamp: 0 });
  }
  sendAudio(): void {}
  sendEvent(event: RealtimeClientEvent): void {
    this.sent.push(event);
  }
  interrupt(): void {}
  async disconnect(): Promise<void> {
    this.state = 'disconnected';
    this.emitter.emit('disconnected', { transport: this.kind, timestamp: 0, expected: true, retryable: false });
  }
  emit(event: RealtimeServerEvent): void {
    this.emitter.emit('data', { event, raw: event });
  }
  /** The person says something, and the model answers aloud. */
  exchange(turn: number, said: string, answer: string): void {
    this.emit({ type: 'input_audio_buffer.speech_started', item_id: `user_${turn}` });
    this.emit({ type: 'input_audio_buffer.speech_stopped', item_id: `user_${turn}` });
    this.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: `user_${turn}`,
      transcript: said,
    });
    this.emit({ type: 'response.created', response: { id: `response_${turn}` } });
    this.emit({
      type: 'response.output_audio_transcript.done',
      response_id: `response_${turn}`,
      item_id: `assistant_${turn}`,
      transcript: answer,
    });
    this.emit({
      type: 'response.done',
      response: {
        id: `response_${turn}`,
        status: 'completed',
        output: [],
        usage: { input_tokens: 5, output_tokens: 5 },
      },
    });
  }
}

async function stores(): Promise<Array<[string, RealtimeConversationStore]>> {
  const sqlite = new SqliteStore(new DatabaseSync(':memory:'));
  await sqlite.migrate();
  return [
    ['memory', new MemoryRealtimeConversationStore()],
    ['sqlite', storeRealtimeConversations(sqlite)],
  ];
}

const created = (transport: Transport) =>
  transport.sent
    .filter((event) => event.type === 'conversation.item.create')
    .map((event) => {
      const item = event.item as { type: string; role?: string; content?: Array<{ text: string }>; output?: string };
      return item.type === 'message'
        ? `${item.role}: ${item.content?.[0]?.text}`
        : `${item.type}: ${item.output ?? ''}`;
    });

test('proof: a conversation whose process is killed is resumed elsewhere, and the model is told what was said', async () => {
  for (const [name, conversationStore] of await stores()) {
    const first = new Transport();
    const original = new RealtimeSession({
      model: 'gpt-realtime',
      transport: first,
      conversationStore,
      conversation: { captureTranscripts: true },
      metadata: { caller: 'ana' },
    });
    await original.connect();
    first.exchange(1, 'My order number is 42', 'Order 42 ships on Monday');
    await original.whenIdle();
    // The process dies here: the session is never disconnected, and its socket is gone.
    const conversationId = original.getConversation().id;
    const kept = await conversationStore.get(conversationId);
    assert.equal(kept?.items.filter((item) => item.type === 'user_speech').length, 1, `${name}: the turn is kept`);

    // Another process resumes it by id, on a new transport.
    const second = new Transport();
    const resumed = new RealtimeSession({
      model: 'gpt-realtime',
      transport: second,
      conversationStore,
      conversation: { captureTranscripts: true },
      resume: conversationId,
    });
    await resumed.connect();
    assert.equal(resumed.id, conversationId, `${name}: the conversation goes on under its own id`);
    assert.equal(second.sent[0]?.type, 'session.update', name);
    assert.deepEqual(
      created(second),
      ['user: My order number is 42', 'assistant: Order 42 ships on Monday'],
      `${name}: the provider is told what was said, before anything new`,
    );

    // The provider echoes what it was given; the record does not take it twice.
    for (const event of second.sent.filter((sent) => sent.type === 'conversation.item.create')) {
      second.emit({ type: 'conversation.item.created', item: event.item });
    }
    second.exchange(2, 'When will it arrive?', 'Tuesday, the day after it ships');
    await resumed.whenIdle();
    const conversation = resumed.getConversation();
    assert.deepEqual(
      conversation.items
        .filter((item) => item.type === 'user_speech' || item.type === 'assistant_speech')
        .map((item) => (item as { transcript: string }).transcript),
      ['My order number is 42', 'Order 42 ships on Monday', 'When will it arrive?', 'Tuesday, the day after it ships'],
      `${name}: one conversation, in order, with nothing twice`,
    );
    assert.equal(
      conversation.items.filter((item) => item.type === 'text_message').length,
      0,
      `${name}: the echoes of what the provider was given are not recorded`,
    );
    assert.equal(conversation.status, 'active', name);
    assert.deepEqual(conversation.metadata, { caller: 'ana' }, `${name}: its metadata carried on`);
    assert.equal(conversation.metrics.inputTokens, 10, `${name}: its usage carried on and grew`);
    const stored = await conversationStore.get(conversationId);
    assert.equal(stored?.items.filter((item) => item.type === 'user_speech').length, 2, `${name}: the store grew`);
    await resumed.disconnect();
  }
});

test('a resumed conversation gives the provider its tool calls and results, and only its latest items when asked', async () => {
  const conversationStore = new MemoryRealtimeConversationStore();
  const transport = new Transport();
  const session = new RealtimeSession({
    model: 'gpt-realtime',
    transport,
    resume: {
      id: 'conv_tools',
      provider: 'openai',
      model: 'gpt-realtime',
      startedAt: '2026-10-16T09:00:00.000Z',
      endedAt: '2026-10-16T09:05:00.000Z',
      status: 'failed',
      metrics: { turns: 1 } as never,
      items: [
        {
          id: 'i1',
          createdAt: '2026-10-16T09:00:01.000Z',
          type: 'text_message',
          role: 'user',
          text: 'Where is order 42?',
        },
        {
          id: 'i2',
          createdAt: '2026-10-16T09:00:02.000Z',
          type: 'tool_call',
          callId: 'call_1',
          name: 'track_order',
          arguments: { order: 42 },
          status: 'completed',
        },
        {
          id: 'i3',
          createdAt: '2026-10-16T09:00:03.000Z',
          type: 'tool_result',
          callId: 'call_1',
          name: 'track_order',
          result: { status: 'shipped' },
          durationMs: 40,
        },
        { id: 'i4', createdAt: '2026-10-16T09:00:04.000Z', type: 'interruption', reason: 'barge_in' },
      ],
    },
    conversationStore,
    conversation: { replayItems: 2 },
  });
  await session.connect();
  assert.deepEqual(
    created(transport),
    ['function_call: ', 'function_call_output: {"status":"shipped"}'],
    'the latest two',
  );
  assert.equal(session.getConversation().status, 'active', 'a resumed conversation is active again');
  assert.equal(session.getConversation().endedAt, undefined);
  await session.disconnect();

  const lost = new RealtimeSession({ model: 'gpt-realtime', transport: new Transport(), resume: 'conv_nowhere' });
  await assert.rejects(
    lost.connect(),
    /No conversation conv_nowhere is kept to resume: the session has no conversationStore/,
  );
});
