import { createRealtimeId, type RealtimeIdFactory } from './id.js';
import type {
  AssistantSpeechItem,
  ConversationItem,
  ConversationMetrics,
  RealtimeAnalyticsExport,
  RealtimeConversation,
  RealtimeConversationExportFormat,
  RealtimeConversationOptions,
  RealtimeEvent,
  RealtimeProviderName,
  RealtimeServerEvent,
  ToolCallItem,
  UserSpeechItem,
} from './types.js';

export interface CreateRealtimeConversationOptions {
  id?: string;
  provider: RealtimeProviderName;
  model: string;
  startedAt?: string;
  metadata?: Record<string, unknown>;
  idFactory?: RealtimeIdFactory;
}

export interface RealtimeConversationReducerOptions extends RealtimeConversationOptions {
  idFactory?: RealtimeIdFactory;
}

export function createConversationMetrics(): ConversationMetrics {
  return {
    connectionSetupMs: 0,
    turns: 0,
    toolCalls: 0,
    interruptions: 0,
    reconnects: 0,
    errors: 0,
    inputAudioDurationMs: 0,
    outputAudioDurationMs: 0,
  };
}

export function createRealtimeConversation(options: CreateRealtimeConversationOptions): RealtimeConversation {
  const idFactory = options.idFactory || createRealtimeId;
  return {
    id: options.id || idFactory('conv'),
    provider: options.provider,
    model: options.model,
    startedAt: options.startedAt || new Date().toISOString(),
    status: 'active',
    items: [],
    metrics: createConversationMetrics(),
    metadata: options.metadata ? cloneValue(options.metadata) : undefined,
  };
}

export function reduceRealtimeConversation(
  conversation: RealtimeConversation,
  event: RealtimeEvent,
  options: RealtimeConversationReducerOptions = {},
): RealtimeConversation {
  const next = snapshotRealtimeConversation(conversation);
  const idFactory = options.idFactory || createRealtimeId;
  const timestamp = iso(event.timestamp);

  switch (event.type) {
    case 'session.connected':
      next.status = 'active';
      break;
    case 'session.reconnecting':
      next.metrics.reconnects += 1;
      break;
    case 'session.disconnected':
      if (next.status !== 'failed') next.status = event.expected ? 'completed' : 'failed';
      next.endedAt ||= timestamp;
      break;
    case 'speech.started': {
      const previous = findLast(next.items, (item): item is UserSpeechItem => item.type === 'user_speech');
      if (!previous || previous.endedAt) {
        next.items.push({
          id: idFactory('item'),
          providerItemId: event.itemId,
          type: 'user_speech',
          transcript: '',
          createdAt: timestamp,
          startedAt: timestamp,
        });
      }
      break;
    }
    case 'speech.stopped': {
      const item = ensureUserSpeech(next, event.itemId, timestamp, idFactory);
      item.endedAt ||= timestamp;
      if (item.audioDurationMs === undefined) {
        item.audioDurationMs = Math.max(0, event.timestamp - Date.parse(item.startedAt));
        next.metrics.inputAudioDurationMs += item.audioDurationMs;
      }
      break;
    }
    case 'user.transcript.delta': {
      if (options.captureTranscripts === false) break;
      const item = ensureUserSpeech(next, event.itemId, timestamp, idFactory);
      item.transcript += redact(event.delta, 'user', options);
      break;
    }
    case 'user.transcript.completed': {
      const item = ensureUserSpeech(next, event.itemId, timestamp, idFactory, true);
      item.transcript = options.captureTranscripts === false ? '' : redact(event.transcript, 'user', options);
      item.endedAt ||= timestamp;
      break;
    }
    case 'assistant.audio.delta': {
      ensureAssistantSpeech(next, event.responseId, event.itemId, timestamp, idFactory);
      next.metrics.outputAudioDurationMs += Math.max(0, event.durationMs || 0);
      break;
    }
    case 'assistant.audio.track': {
      if (event.responseId || event.itemId) {
        ensureAssistantSpeech(next, event.responseId, event.itemId, timestamp, idFactory);
      }
      break;
    }
    case 'assistant.transcript.delta': {
      if (options.captureTranscripts === false) break;
      const item = ensureAssistantSpeech(next, event.responseId, event.itemId, timestamp, idFactory);
      item.transcript += redact(event.delta, 'assistant', options);
      break;
    }
    case 'assistant.transcript.completed': {
      const item = ensureAssistantSpeech(next, event.responseId, event.itemId, timestamp, idFactory);
      item.transcript = options.captureTranscripts === false ? '' : redact(event.transcript, 'assistant', options);
      break;
    }
    case 'message.text.delta': {
      if (options.captureTranscripts === false) break;
      const item = ensureTextMessage(next, event.role, event.responseId, event.itemId, timestamp, idFactory);
      item.text += redact(event.delta, event.role === 'assistant' ? 'assistant' : 'user', options);
      break;
    }
    case 'message.text.completed': {
      const item = ensureTextMessage(next, event.role, event.responseId, event.itemId, timestamp, idFactory);
      item.text =
        options.captureTranscripts === false
          ? ''
          : redact(event.text, event.role === 'assistant' ? 'assistant' : 'user', options);
      break;
    }
    case 'assistant.response.created':
      break;
    case 'assistant.response.completed': {
      const item = findAssistantSpeech(next, event.responseId, event.itemId);
      if (item) item.endedAt = timestamp;
      next.metrics.turns += 1;
      break;
    }
    case 'assistant.response.cancelled': {
      const item = findAssistantSpeech(next, event.responseId, event.itemId);
      if (item) {
        item.endedAt = timestamp;
        item.interrupted = true;
      }
      break;
    }
    case 'tool.call.started': {
      if (options.captureToolCalls === false) break;
      const existing = findToolCall(next.items, event.call.callId);
      if (existing) {
        existing.status = existing.status === 'completed' ? 'completed' : 'running';
      } else {
        next.items.push({
          id: idFactory('item'),
          providerItemId: event.call.itemId,
          type: 'tool_call',
          callId: event.call.callId,
          name: event.call.name,
          arguments: cloneValue(event.call.arguments),
          status: 'running',
          createdAt: timestamp,
          raw: event.call.raw,
        });
        next.metrics.toolCalls += 1;
      }
      break;
    }
    case 'tool.confirmation.required': {
      if (options.captureToolCalls === false) break;
      const item = findToolCall(next.items, event.call.callId);
      if (item) {
        item.status = 'awaiting_confirmation';
        item.requiresConfirmation = true;
      }
      break;
    }
    case 'tool.call.completed': {
      if (options.captureToolCalls === false) break;
      const { result } = event;
      const item = findToolCall(next.items, result.call.callId);
      if (item) {
        item.status = result.ok ? 'completed' : /\brejected\b/i.test(result.error || '') ? 'rejected' : 'failed';
        item.durationMs = result.durationMs;
        item.error = result.error;
      }
      const existingResult = findLast(
        next.items,
        (value): value is Extract<ConversationItem, { type: 'tool_result' }> =>
          value.type === 'tool_result' && value.callId === result.call.callId,
      );
      if (existingResult) {
        existingResult.result = result.ok ? cloneValue(result.result) : undefined;
        existingResult.error = result.error;
        existingResult.durationMs = result.durationMs;
      } else {
        next.items.push({
          id: idFactory('item'),
          providerItemId: result.call.itemId,
          type: 'tool_result',
          callId: result.call.callId,
          name: result.call.name,
          result: result.ok ? cloneValue(result.result) : undefined,
          error: result.error,
          durationMs: result.durationMs,
          createdAt: timestamp,
        });
      }
      next.metrics.toolCallDurationMs = result.durationMs;
      break;
    }
    case 'interruption': {
      const assistant = findLast(
        next.items,
        (item): item is AssistantSpeechItem =>
          item.type === 'assistant_speech' && (!event.responseId || item.responseId === event.responseId),
      );
      if (assistant) {
        assistant.interrupted = true;
        assistant.heardAudioMs = event.audioEndMs;
        assistant.endedAt = timestamp;
      }
      next.items.push({
        id: idFactory('item'),
        providerItemId: event.itemId,
        type: 'interruption',
        responseId: event.responseId,
        itemId: event.itemId,
        audioEndMs: event.audioEndMs,
        reason: event.reason,
        createdAt: timestamp,
      });
      next.metrics.interruptions += 1;
      break;
    }
    case 'error':
      next.items.push({
        id: idFactory('item'),
        type: 'error',
        code: event.error.code,
        message: event.error.message,
        retryable: event.error.retryable,
        createdAt: timestamp,
      });
      next.metrics.errors += 1;
      if (event.error.fatal) {
        next.status = 'failed';
        next.endedAt = timestamp;
      }
      break;
  }

  return next;
}

export function withConversationMetrics(
  conversation: RealtimeConversation,
  metrics: Partial<ConversationMetrics>,
): RealtimeConversation {
  const next = snapshotRealtimeConversation(conversation);
  next.metrics = { ...next.metrics, ...metrics };
  return next;
}

export function snapshotRealtimeConversation(conversation: RealtimeConversation): RealtimeConversation {
  return cloneValue(conversation);
}

export function exportRealtimeConversation(
  conversation: RealtimeConversation,
  format: RealtimeConversationExportFormat,
  rawEvents: RealtimeServerEvent[] = [],
): RealtimeConversation | RealtimeServerEvent[] | string | RealtimeAnalyticsExport {
  if (format === 'json') return snapshotRealtimeConversation(conversation);
  if (format === 'openai-events') return cloneValue(rawEvents);
  if (format === 'text') return exportText(conversation);
  return exportAnalytics(conversation);
}

function exportText(conversation: RealtimeConversation): string {
  const lines: string[] = [];
  for (const item of conversation.items) {
    if (item.type === 'user_speech' && item.transcript) lines.push(`User: ${item.transcript}`);
    if (item.type === 'assistant_speech' && item.transcript) lines.push(`Assistant: ${item.transcript}`);
    if (item.type === 'text_message' && item.text) lines.push(`${capitalize(item.role)}: ${item.text}`);
    if (item.type === 'tool_call') lines.push(`Tool call (${item.name}): ${JSON.stringify(item.arguments)}`);
    if (item.type === 'tool_result') {
      lines.push(`Tool result (${item.name}): ${item.error || safeStringify(item.result)}`);
    }
    if (item.type === 'interruption') lines.push('[Assistant interrupted]');
    if (item.type === 'error') lines.push(`[Error${item.code ? ` ${item.code}` : ''}: ${item.message}]`);
  }
  return lines.join('\n');
}

function exportAnalytics(conversation: RealtimeConversation): RealtimeAnalyticsExport {
  const itemCounts = {
    user_speech: 0,
    assistant_speech: 0,
    text_message: 0,
    tool_call: 0,
    tool_result: 0,
    interruption: 0,
    error: 0,
  } satisfies Record<ConversationItem['type'], number>;
  for (const item of conversation.items) itemCounts[item.type] += 1;
  const endedAt = conversation.endedAt || new Date().toISOString();
  return {
    conversationId: conversation.id,
    provider: conversation.provider,
    model: conversation.model,
    startedAt: conversation.startedAt,
    endedAt: conversation.endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(conversation.startedAt)),
    itemCounts,
    metrics: cloneValue(conversation.metrics),
  };
}

function ensureUserSpeech(
  conversation: RealtimeConversation,
  providerItemId: string | undefined,
  timestamp: string,
  idFactory: RealtimeIdFactory,
  includeEnded = false,
): UserSpeechItem {
  const existing = findLast(
    conversation.items,
    (item): item is UserSpeechItem =>
      item.type === 'user_speech' &&
      (providerItemId ? item.providerItemId === providerItemId : includeEnded || !item.endedAt),
  );
  if (existing) return existing;
  const item: UserSpeechItem = {
    id: idFactory('item'),
    providerItemId,
    type: 'user_speech',
    transcript: '',
    createdAt: timestamp,
    startedAt: timestamp,
  };
  conversation.items.push(item);
  return item;
}

function ensureAssistantSpeech(
  conversation: RealtimeConversation,
  responseId: string | undefined,
  providerItemId: string | undefined,
  timestamp: string,
  idFactory: RealtimeIdFactory,
): AssistantSpeechItem {
  const existing = findAssistantSpeech(conversation, responseId, providerItemId);
  if (existing) {
    existing.providerItemId ||= providerItemId;
    existing.responseId ||= responseId;
    return existing;
  }
  const item: AssistantSpeechItem = {
    id: idFactory('item'),
    providerItemId,
    type: 'assistant_speech',
    transcript: '',
    responseId,
    createdAt: timestamp,
    startedAt: timestamp,
  };
  conversation.items.push(item);
  return item;
}

function findAssistantSpeech(
  conversation: RealtimeConversation,
  responseId: string | undefined,
  providerItemId: string | undefined,
): AssistantSpeechItem | undefined {
  return findLast(
    conversation.items,
    (item): item is AssistantSpeechItem =>
      item.type === 'assistant_speech' &&
      (providerItemId
        ? item.providerItemId === providerItemId ||
          (!item.providerItemId && Boolean(responseId) && item.responseId === responseId)
        : responseId
          ? item.responseId === responseId
          : !item.endedAt),
  );
}

function findToolCall(items: ConversationItem[], callId: string): ToolCallItem | undefined {
  return findLast(items, (item): item is ToolCallItem => item.type === 'tool_call' && item.callId === callId);
}

function ensureTextMessage(
  conversation: RealtimeConversation,
  role: 'user' | 'assistant' | 'system',
  responseId: string | undefined,
  providerItemId: string | undefined,
  timestamp: string,
  idFactory: RealtimeIdFactory,
) {
  const existing = findLast(
    conversation.items,
    (item): item is Extract<ConversationItem, { type: 'text_message' }> =>
      item.type === 'text_message' &&
      item.role === role &&
      (providerItemId
        ? item.providerItemId === providerItemId ||
          (!item.providerItemId && Boolean(responseId) && item.responseId === responseId)
        : responseId
          ? item.responseId === responseId
          : true),
  );
  if (existing) return existing;
  const item: Extract<ConversationItem, { type: 'text_message' }> = {
    id: idFactory('item'),
    providerItemId,
    type: 'text_message',
    role,
    text: '',
    responseId,
    createdAt: timestamp,
  };
  conversation.items.push(item);
  return item;
}

function findLast<T extends ConversationItem>(
  items: ConversationItem[],
  predicate: (item: ConversationItem) => item is T,
): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && predicate(item)) return item;
  }
  return undefined;
}

function redact(text: string, role: 'user' | 'assistant', options: RealtimeConversationReducerOptions): string {
  return options.redactTranscript ? options.redactTranscript(text, role) : text;
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function cloneValue<T>(value: T): T {
  if (value instanceof ArrayBuffer) return value.slice(0) as T;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) output[key] = cloneValue(item);
    return output as T;
  }
  return value;
}
