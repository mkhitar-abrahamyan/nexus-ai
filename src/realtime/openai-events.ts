import { RealtimeError } from './errors.js';
import { createRealtimeId, type RealtimeIdFactory } from './id.js';
import { decodeBase64, isRecord } from './transport-utils.js';
import { toOpenAIRealtimeTools } from './tools.js';
import type {
  RealtimeClientEvent,
  RealtimeEvent,
  RealtimeInterruptionOptions,
  RealtimeServerEvent,
  RealtimeSessionConfig,
  RealtimeToolCall,
  RealtimeToolResult,
} from './types.js';

export function createOpenAISessionUpdate(config: RealtimeSessionConfig): RealtimeClientEvent {
  const interruption = normalizeInterruption(config.interruption);
  const input = config.audio?.input;
  const output = config.audio?.output;
  const turnDetection = input?.turnDetection;
  const audio =
    input || output
      ? {
          ...(input
            ? {
                input: {
                  ...(input.format ? { format: input.format } : {}),
                  ...(input.transcriptionModel
                    ? {
                        transcription: {
                          model: input.transcriptionModel,
                          ...(input.language ? { language: input.language } : {}),
                        },
                      }
                    : {}),
                  ...(turnDetection !== undefined
                    ? {
                        turn_detection:
                          turnDetection === null
                            ? null
                            : turnDetection.type === 'server_vad'
                              ? {
                                  type: 'server_vad',
                                  threshold: turnDetection.threshold,
                                  prefix_padding_ms: turnDetection.prefixPaddingMs,
                                  silence_duration_ms: turnDetection.silenceDurationMs,
                                  create_response: true,
                                  interrupt_response: interruption.enabled && interruption.cancelResponse,
                                }
                              : {
                                  type: 'semantic_vad',
                                  eagerness: turnDetection.eagerness,
                                  create_response: true,
                                  interrupt_response: interruption.enabled && interruption.cancelResponse,
                                },
                      }
                    : {}),
                },
              }
            : {}),
          ...(output
            ? {
                output: {
                  ...(output.format ? { format: output.format } : {}),
                  ...(output.voice ? { voice: output.voice } : {}),
                  ...(output.speed === undefined ? {} : { speed: output.speed }),
                },
              }
            : {}),
        }
      : undefined;

  const providerSession = { ...config.providerSession };
  delete providerSession.tools;
  delete providerSession.tool_choice;

  return {
    type: 'session.update',
    session: compact({
      ...providerSession,
      type: 'realtime',
      model: config.model,
      ...(config.modalities ? { output_modalities: config.modalities } : {}),
      ...(config.instructions === undefined ? {} : { instructions: config.instructions }),
      tools: config.tools?.length ? toOpenAIRealtimeTools(config.tools) : undefined,
      tool_choice: config.tools?.length ? config.toolChoice || 'auto' : undefined,
      ...(audio === undefined ? {} : { audio }),
    }),
  };
}

export function createOpenAIToolResultEvents(result: RealtimeToolResult): RealtimeClientEvent[] {
  const output = result.ok ? result.result : { error: result.error || 'Tool execution failed' };
  return [
    {
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: result.call.callId,
        output: safeJson(output),
      },
    },
    { type: 'response.create' },
  ];
}

export function normalizeOpenAIRealtimeEvent(
  raw: RealtimeServerEvent,
  timestamp = Date.now(),
  idFactory: RealtimeIdFactory = createRealtimeId,
): RealtimeEvent[] {
  const type = raw.type;
  if (type === 'session.created') {
    const session = record(raw.session);
    return [{ type: 'session.connected', sessionId: string(session?.id) || idFactory('session'), timestamp }];
  }
  if (type === 'input_audio_buffer.speech_started') {
    return [{ type: 'speech.started', itemId: string(raw.item_id), timestamp }];
  }
  if (type === 'input_audio_buffer.speech_stopped') {
    return [
      {
        type: 'speech.stopped',
        itemId: string(raw.item_id),
        audioEndMs: number(raw.audio_end_ms),
        timestamp,
      },
    ];
  }
  if (type === 'conversation.item.input_audio_transcription.delta') {
    return [{ type: 'user.transcript.delta', delta: string(raw.delta) || '', itemId: string(raw.item_id), timestamp }];
  }
  if (
    type === 'conversation.item.input_audio_transcription.completed' ||
    type === 'conversation.item.input_audio_transcription.done'
  ) {
    return [
      {
        type: 'user.transcript.completed',
        transcript: string(raw.transcript) || '',
        itemId: string(raw.item_id),
        timestamp,
      },
    ];
  }
  if (type === 'response.created') {
    const response = record(raw.response);
    const responseId = string(response?.id) || string(raw.response_id) || idFactory('resp');
    return [{ type: 'assistant.response.created', responseId, timestamp }];
  }
  if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
    try {
      return [
        {
          type: 'assistant.audio.delta',
          audio: decodeBase64(string(raw.delta) || ''),
          responseId: string(raw.response_id),
          itemId: string(raw.item_id),
          timestamp,
        },
      ];
    } catch (error) {
      return [
        {
          type: 'error',
          error: new RealtimeError({
            message: error instanceof Error ? error.message : String(error),
            code: 'invalid_audio_delta',
            category: 'protocol',
            provider: 'openai',
            raw,
          }),
          timestamp,
        },
      ];
    }
  }
  if (type === 'response.output_audio_transcript.delta' || type === 'response.audio_transcript.delta') {
    return [
      {
        type: 'assistant.transcript.delta',
        delta: string(raw.delta) || '',
        responseId: string(raw.response_id),
        itemId: string(raw.item_id),
        timestamp,
      },
    ];
  }
  if (type === 'response.output_audio_transcript.done' || type === 'response.audio_transcript.done') {
    return [
      {
        type: 'assistant.transcript.completed',
        transcript: string(raw.transcript) || string(raw.text) || '',
        responseId: string(raw.response_id),
        itemId: string(raw.item_id),
        timestamp,
      },
    ];
  }
  if (type === 'response.output_text.delta') {
    return [
      {
        type: 'message.text.delta',
        role: 'assistant',
        delta: string(raw.delta) || '',
        responseId: string(raw.response_id),
        itemId: string(raw.item_id),
        timestamp,
      },
    ];
  }
  if (type === 'response.output_text.done') {
    return [
      {
        type: 'message.text.completed',
        role: 'assistant',
        text: string(raw.text) || '',
        responseId: string(raw.response_id),
        itemId: string(raw.item_id),
        timestamp,
      },
    ];
  }
  if (type === 'response.function_call_arguments.done') {
    const call = parseToolCall(raw, idFactory);
    return call ? [{ type: 'tool.call.started', call, timestamp }] : [];
  }
  if (type === 'response.output_item.done') {
    const item = record(raw.item);
    if (item?.type === 'function_call') {
      const call = parseToolCall({ ...raw, ...item }, idFactory);
      return call ? [{ type: 'tool.call.started', call, timestamp }] : [];
    }
    if (item?.type === 'message') return normalizeMessageItem(item, raw, timestamp);
    return [];
  }
  if (type === 'conversation.item.created' || type === 'conversation.item.done') {
    const item = record(raw.item);
    if (item?.type === 'message') return normalizeMessageItem(item, raw, timestamp);
    return [];
  }
  if (type === 'response.done') return normalizeResponseDone(raw, timestamp, idFactory);
  if (type === 'response.cancelled' || type === 'response.canceled') {
    return [
      {
        type: 'assistant.response.cancelled',
        responseId: string(raw.response_id) || idFactory('resp'),
        itemId: string(raw.item_id),
        timestamp,
      },
    ];
  }
  if (type === 'error') return [{ type: 'error', error: openAIError(raw), timestamp }];
  return [];
}

function normalizeResponseDone(
  raw: RealtimeServerEvent,
  timestamp: number,
  idFactory: RealtimeIdFactory,
): RealtimeEvent[] {
  const response = record(raw.response);
  const responseId = string(response?.id) || string(raw.response_id) || idFactory('resp');
  const status = string(response?.status) || 'completed';
  const events: RealtimeEvent[] = [];
  const output = Array.isArray(response?.output) ? response.output : [];
  for (const value of output) {
    const item = record(value);
    if (item?.type !== 'function_call') continue;
    const call = parseToolCall(
      { type: 'response.function_call_arguments.done', ...item, response_id: responseId },
      idFactory,
    );
    if (call) events.push({ type: 'tool.call.started', call, timestamp });
  }
  if (status === 'cancelled' || status === 'canceled') {
    events.push({ type: 'assistant.response.cancelled', responseId, timestamp });
  } else if (status === 'failed') {
    const details = record(response?.status_details);
    events.push({
      type: 'error',
      error: new RealtimeError({
        message: string(details?.error) || string(details?.reason) || 'OpenAI Realtime response failed',
        code: string(details?.type) || 'response_failed',
        category: 'provider',
        provider: 'openai',
        retryable: false,
        raw,
      }),
      timestamp,
    });
  } else {
    events.push({ type: 'assistant.response.completed', responseId, timestamp });
  }
  return events;
}

function normalizeMessageItem(
  item: Record<string, unknown>,
  raw: RealtimeServerEvent,
  timestamp: number,
): RealtimeEvent[] {
  const role = string(item.role);
  const content = Array.isArray(item.content) ? item.content : [];
  const parts = content
    .map((value) => record(value))
    .filter((value): value is Record<string, unknown> => Boolean(value));
  const text = parts.map((value) => string(value.text) || '').join('');
  const transcript = parts.map((value) => string(value.transcript) || '').join('');
  if (text && (role === 'user' || role === 'assistant' || role === 'system')) {
    return [
      {
        type: 'message.text.completed',
        role,
        text,
        itemId: string(item.id),
        responseId: string(raw.response_id),
        timestamp,
      },
    ];
  }
  if (!transcript) return [];
  if (role === 'user') {
    return [{ type: 'user.transcript.completed', transcript, itemId: string(item.id), timestamp }];
  }
  if (role === 'assistant') {
    return [
      {
        type: 'assistant.transcript.completed',
        transcript,
        itemId: string(item.id),
        responseId: string(raw.response_id),
        timestamp,
      },
    ];
  }
  return [];
}

function parseToolCall(raw: Record<string, unknown>, idFactory: RealtimeIdFactory): RealtimeToolCall | undefined {
  const name = string(raw.name);
  const callId = string(raw.call_id) || string(raw.callId);
  if (!name || !callId) return undefined;
  const rawArguments = string(raw.arguments) || '{}';
  let args: Record<string, unknown> = {};
  let argumentError: string | undefined;
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (isRecord(parsed)) args = parsed;
    else argumentError = `Realtime tool "${name}" arguments must be a JSON object`;
  } catch (error) {
    argumentError = `Realtime tool "${name}" received malformed JSON arguments: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  return {
    callId,
    name,
    arguments: args,
    rawArguments,
    argumentError,
    itemId: string(raw.item_id) || string(raw.id),
    responseId: string(raw.response_id),
    idempotencyKey: `realtime:${callId || idFactory('call')}`,
    raw,
  };
}

function openAIError(raw: RealtimeServerEvent): RealtimeError {
  const value = record(raw.error) || raw;
  const code = string(value.code);
  const status = number(value.status);
  return new RealtimeError({
    message: string(value.message) || 'OpenAI Realtime API error',
    code,
    category:
      status === 401 || status === 403
        ? 'authentication'
        : status === 429
          ? 'rate-limit'
          : code?.includes('session')
            ? 'provider'
            : 'protocol',
    provider: 'openai',
    status,
    eventId: string(raw.event_id),
    retryable: status === 429 || (status !== undefined && status >= 500),
    raw,
  });
}

function normalizeInterruption(
  value: RealtimeSessionConfig['interruption'],
): Required<Pick<RealtimeInterruptionOptions, 'enabled' | 'cancelResponse' | 'truncateUnheardAudio'>> {
  if (value === false) return { enabled: false, cancelResponse: false, truncateUnheardAudio: false };
  if (value === true || value === undefined) {
    return { enabled: value === true, cancelResponse: true, truncateUnheardAudio: true };
  }
  return {
    enabled: value.enabled ?? true,
    cancelResponse: value.cancelResponse ?? true,
    truncateUnheardAudio: value.truncateUnheardAudio ?? true,
  };
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    if (isRecord(entry)) result[key] = compact(entry);
    else result[key] = entry;
  }
  return result;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return JSON.stringify({ error: 'Tool result could not be serialized' });
  }
}
