import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRealtimeConversation,
  exportRealtimeConversation,
  reduceRealtimeConversation,
  snapshotRealtimeConversation,
  withConversationMetrics,
} from '../src/realtime/conversation.js';
import { RealtimeError } from '../src/realtime/errors.js';
import type {
  RealtimeConversation,
  RealtimeEvent,
  RealtimeServerEvent,
  RealtimeToolCall,
  RealtimeToolResult,
} from '../src/realtime/types.js';

function sequentialIds(): (prefix?: string) => string {
  let next = 0;
  return (prefix = 'id') => `${prefix}_${++next}`;
}

function apply(conversation: RealtimeConversation, events: RealtimeEvent[]): RealtimeConversation {
  const idFactory = sequentialIds();
  return events.reduce((current, event) => reduceRealtimeConversation(current, event, { idFactory }), conversation);
}

function toolCall(overrides: Partial<RealtimeToolCall> = {}): RealtimeToolCall {
  return {
    callId: 'call_1',
    name: 'lookup',
    arguments: { query: 'Armenia' },
    idempotencyKey: 'realtime:call_1',
    itemId: 'tool_item_1',
    responseId: 'response_1',
    ...overrides,
  };
}

test('conversation reducer normalizes a full voice and tool turn without mutating prior snapshots', () => {
  const initial = createRealtimeConversation({
    id: 'conversation_1',
    provider: 'openai',
    model: 'gpt-realtime',
    startedAt: new Date(1_000).toISOString(),
    metadata: { tenant: { id: 'tenant_1' } },
  });
  const call = toolCall();
  const result: RealtimeToolResult = {
    call,
    ok: true,
    result: { answer: 42 },
    durationMs: 25,
    attempts: 1,
  };
  const events: RealtimeEvent[] = [
    { type: 'session.connected', sessionId: 'session_1', timestamp: 1_000 },
    { type: 'speech.started', itemId: 'user_item_1', timestamp: 1_100 },
    { type: 'user.transcript.delta', delta: 'hello ', itemId: 'user_item_1', timestamp: 1_150 },
    { type: 'user.transcript.completed', transcript: 'hello world', itemId: 'user_item_1', timestamp: 1_300 },
    { type: 'speech.stopped', itemId: 'user_item_1', audioEndMs: 200, timestamp: 1_300 },
    { type: 'assistant.response.created', responseId: 'response_1', timestamp: 1_400 },
    {
      type: 'assistant.audio.delta',
      audio: new Uint8Array([1, 2]).buffer,
      responseId: 'response_1',
      itemId: 'assistant_item_1',
      timestamp: 1_450,
    },
    {
      type: 'assistant.transcript.delta',
      delta: 'hi ',
      responseId: 'response_1',
      itemId: 'assistant_item_1',
      timestamp: 1_460,
    },
    {
      type: 'assistant.transcript.completed',
      transcript: 'hi there',
      responseId: 'response_1',
      itemId: 'assistant_item_1',
      timestamp: 1_500,
    },
    { type: 'tool.call.started', call, timestamp: 1_510 },
    { type: 'tool.confirmation.required', call, timestamp: 1_515 },
    { type: 'tool.call.completed', result, timestamp: 1_535 },
    {
      type: 'assistant.response.completed',
      responseId: 'response_1',
      itemId: 'assistant_item_1',
      timestamp: 1_600,
    },
    { type: 'session.disconnected', reason: 'done', expected: true, timestamp: 1_700 },
  ];

  const reduced = apply(initial, events);

  assert.equal(initial.items.length, 0);
  assert.equal(initial.status, 'active');
  assert.equal(reduced.status, 'completed');
  assert.equal(reduced.endedAt, new Date(1_700).toISOString());
  assert.deepEqual(
    reduced.items.map((item) => item.type),
    ['user_speech', 'assistant_speech', 'tool_call', 'tool_result'],
  );
  const user = reduced.items.find((item) => item.type === 'user_speech');
  const assistant = reduced.items.find((item) => item.type === 'assistant_speech');
  const recordedCall = reduced.items.find((item) => item.type === 'tool_call');
  assert.equal(user?.transcript, 'hello world');
  assert.equal(user?.audioDurationMs, 200);
  assert.equal(assistant?.transcript, 'hi there');
  assert.equal(assistant?.endedAt, new Date(1_600).toISOString());
  assert.equal(recordedCall?.status, 'completed');
  assert.equal(recordedCall?.requiresConfirmation, true);
  assert.equal(recordedCall?.durationMs, 25);
  assert.deepEqual(reduced.metrics, {
    connectionSetupMs: 0,
    turns: 1,
    toolCalls: 1,
    interruptions: 0,
    reconnects: 0,
    errors: 0,
    inputAudioDurationMs: 200,
    outputAudioDurationMs: 0,
    toolCallDurationMs: 25,
  });
});

test('conversation reducer records interruption, reconnect, and terminal errors', () => {
  const conversation = createRealtimeConversation({
    id: 'conversation_2',
    provider: 'openai',
    model: 'gpt-realtime',
    startedAt: new Date(2_000).toISOString(),
  });
  const reduced = apply(conversation, [
    { type: 'assistant.response.created', responseId: 'response_2', timestamp: 2_100 },
    {
      type: 'assistant.transcript.delta',
      delta: 'partially heard',
      responseId: 'response_2',
      itemId: 'assistant_item_2',
      timestamp: 2_150,
    },
    { type: 'session.reconnecting', attempt: 1, delayMs: 10, timestamp: 2_160 },
    {
      type: 'interruption',
      reason: 'barge_in',
      responseId: 'response_2',
      itemId: 'assistant_item_2',
      audioEndMs: 375,
      timestamp: 2_200,
    },
    {
      type: 'error',
      error: new RealtimeError({
        message: 'fatal protocol error',
        code: 'bad_event',
        category: 'protocol',
        fatal: true,
      }),
      timestamp: 2_300,
    },
    { type: 'session.disconnected', expected: true, timestamp: 2_400 },
  ]);

  const assistant = reduced.items.find((item) => item.type === 'assistant_speech');
  assert.equal(assistant?.interrupted, true);
  assert.equal(assistant?.heardAudioMs, 375);
  assert.equal(reduced.metrics.interruptions, 1);
  assert.equal(reduced.metrics.reconnects, 1);
  assert.equal(reduced.metrics.errors, 1);
  assert.equal(reduced.status, 'failed');
  assert.equal(reduced.endedAt, new Date(2_300).toISOString());
  assert.match(exportRealtimeConversation(reduced, 'text') as string, /\[Assistant interrupted\]/);
  assert.match(exportRealtimeConversation(reduced, 'text') as string, /fatal protocol error/);
});

test('conversation capture and redaction options apply to deltas and completed transcripts', () => {
  const initial = createRealtimeConversation({ provider: 'openai', model: 'gpt-realtime' });
  const redacted = reduceRealtimeConversation(
    initial,
    { type: 'user.transcript.delta', delta: 'secret', itemId: 'user_1', timestamp: 3_000 },
    { redactTranscript: (text, role) => `${role}:${text.replace('secret', '[REDACTED]')}` },
  );
  const hidden = reduceRealtimeConversation(
    redacted,
    { type: 'assistant.transcript.completed', transcript: 'private', responseId: 'r', timestamp: 3_100 },
    { captureTranscripts: false },
  );

  assert.equal(redacted.items[0]?.type === 'user_speech' ? redacted.items[0].transcript : undefined, 'user:[REDACTED]');
  assert.equal(hidden.items[1]?.type === 'assistant_speech' ? hidden.items[1].transcript : undefined, '');
});

test('conversation snapshots and every export return independent nested values', () => {
  const initial = createRealtimeConversation({
    id: 'conversation_4',
    provider: 'openai',
    model: 'gpt-realtime',
    startedAt: new Date(4_000).toISOString(),
    metadata: { nested: { value: 1 } },
  });
  const conversation = apply(initial, [
    { type: 'speech.started', itemId: 'user_4', timestamp: 4_100 },
    { type: 'user.transcript.completed', transcript: 'hello', itemId: 'user_4', timestamp: 4_200 },
    { type: 'session.disconnected', expected: true, timestamp: 4_500 },
  ]);
  const withMetrics = withConversationMetrics(conversation, { estimatedCost: 0.25, outputTokens: 10 });
  const snapshot = snapshotRealtimeConversation(withMetrics);
  const json = exportRealtimeConversation(withMetrics, 'json') as RealtimeConversation;
  const raw: RealtimeServerEvent[] = [{ type: 'session.created', session: { id: 'session_4' } }];
  const rawExport = exportRealtimeConversation(withMetrics, 'openai-events', raw) as RealtimeServerEvent[];

  (snapshot.metadata?.nested as { value: number }).value = 99;
  if (json.items[0]?.type === 'user_speech') json.items[0].transcript = 'mutated';
  (rawExport[0]?.session as { id: string }).id = 'mutated';

  assert.deepEqual(withMetrics.metadata, { nested: { value: 1 } });
  assert.equal(withMetrics.items[0]?.type === 'user_speech' ? withMetrics.items[0].transcript : undefined, 'hello');
  assert.deepEqual(raw[0]?.session, { id: 'session_4' });
  assert.notEqual(withMetrics, conversation);
  assert.equal(conversation.metrics.estimatedCost, undefined);

  const analytics = exportRealtimeConversation(withMetrics, 'analytics');
  assert.deepEqual(analytics, {
    conversationId: 'conversation_4',
    provider: 'openai',
    model: 'gpt-realtime',
    startedAt: new Date(4_000).toISOString(),
    endedAt: new Date(4_500).toISOString(),
    durationMs: 500,
    itemCounts: {
      user_speech: 1,
      assistant_speech: 0,
      text_message: 0,
      tool_call: 0,
      tool_result: 0,
      interruption: 0,
      error: 0,
    },
    metrics: withMetrics.metrics,
  });
  assert.equal(exportRealtimeConversation(withMetrics, 'text'), 'User: hello');
});

test('conversation reducer is idempotent for replayed speech stops and tool results', () => {
  const initial = createRealtimeConversation({
    id: 'conversation_replay',
    provider: 'openai',
    model: 'gpt-realtime',
    startedAt: new Date(5_000).toISOString(),
  });
  const call = toolCall({ callId: 'call_replay' });
  const result: RealtimeToolResult = {
    call,
    ok: false,
    error: 'The write was rejected by the user',
    durationMs: 12,
    attempts: 0,
  };
  const repeated: RealtimeEvent[] = [
    { type: 'speech.started', itemId: 'user_replay', timestamp: 5_100 },
    { type: 'speech.stopped', itemId: 'user_replay', timestamp: 5_300 },
    { type: 'speech.stopped', itemId: 'user_replay', timestamp: 5_300 },
    { type: 'tool.call.started', call, timestamp: 5_400 },
    { type: 'tool.call.completed', result, timestamp: 5_412 },
    { type: 'tool.call.completed', result, timestamp: 5_412 },
  ];

  const reduced = apply(initial, repeated);
  assert.equal(reduced.metrics.inputAudioDurationMs, 200);
  assert.equal(reduced.items.filter((item) => item.type === 'tool_result').length, 1);
  assert.equal(reduced.items.find((item) => item.type === 'tool_call')?.status, 'rejected');
});

test('response lifecycle events do not create phantom assistant speech items', () => {
  const initial = createRealtimeConversation({
    id: 'conversation_text_response',
    provider: 'openai',
    model: 'gpt-realtime',
    startedAt: new Date(6_000).toISOString(),
  });
  const reduced = apply(initial, [
    { type: 'assistant.response.created', responseId: 'response_text', timestamp: 6_100 },
    {
      type: 'message.text.completed',
      role: 'assistant',
      text: 'Text only',
      responseId: 'response_text',
      itemId: 'text_item',
      timestamp: 6_200,
    },
    { type: 'assistant.response.completed', responseId: 'response_text', timestamp: 6_300 },
  ]);

  assert.deepEqual(
    reduced.items.map((item) => item.type),
    ['text_message'],
  );
  assert.equal(reduced.metrics.turns, 1);
});
