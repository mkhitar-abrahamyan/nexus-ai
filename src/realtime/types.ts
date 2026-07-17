import type { RealtimeError } from './errors.js';

export type RealtimeProviderName = 'openai' | (string & {});
export type RealtimeTransportKind = 'webrtc' | 'websocket' | 'mock' | (string & {});
export type RealtimeTransportState = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'failed';
export type RealtimeSessionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnecting'
  | 'disconnected'
  | 'failed';
export type RealtimeModality = 'audio' | 'text';
export type RealtimeClientEvent = { type: string; event_id?: string; [key: string]: unknown };
export type RealtimeServerEvent = { type: string; event_id?: string; [key: string]: unknown };

export interface RealtimeTransportConnectedEvent {
  sessionId?: string;
  transport: RealtimeTransportKind;
  timestamp: number;
  raw?: unknown;
}

export interface RealtimeTransportDisconnectedEvent {
  transport: RealtimeTransportKind;
  timestamp: number;
  code?: number;
  reason?: string;
  expected?: boolean;
  retryable?: boolean;
  raw?: unknown;
}

export interface RealtimeTransportAudioEvent {
  data?: ArrayBuffer;
  stream?: unknown;
  track?: unknown;
  mimeType?: string;
  sampleRate?: number;
  responseId?: string;
  itemId?: string;
  raw?: unknown;
}

export interface RealtimeTransportDataEvent {
  event: RealtimeServerEvent;
  raw?: unknown;
}

export interface RealtimeTransportEvents {
  connected: RealtimeTransportConnectedEvent;
  disconnected: RealtimeTransportDisconnectedEvent;
  audio: RealtimeTransportAudioEvent;
  data: RealtimeTransportDataEvent;
  error: RealtimeError;
}

export interface RealtimeTransport {
  readonly kind: RealtimeTransportKind;
  readonly state?: RealtimeTransportState;
  connect(config: RealtimeSessionConfig): Promise<void>;
  sendAudio(chunk: ArrayBuffer): void;
  sendEvent(event: RealtimeClientEvent): void;
  interrupt(): void;
  disconnect(): Promise<void>;
  on<Event extends keyof RealtimeTransportEvents>(
    event: Event,
    listener: (payload: RealtimeTransportEvents[Event]) => void,
  ): () => void;
}

export interface RealtimeLatencyMetrics {
  connectionSetupMs: number;
  speechEndToResponseCreatedMs?: number;
  speechEndToFirstAudioMs?: number;
  toolCallDurationMs?: number;
  toolResultToFirstAudioMs?: number;
  totalTurnDurationMs?: number;
}

export interface ConversationMetrics extends RealtimeLatencyMetrics {
  turns: number;
  toolCalls: number;
  interruptions: number;
  reconnects: number;
  errors: number;
  inputAudioDurationMs: number;
  outputAudioDurationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
}

export interface ConversationItemBase {
  id: string;
  createdAt: string;
  providerItemId?: string;
  raw?: unknown;
  metadata?: Record<string, unknown>;
}

export interface UserSpeechItem extends ConversationItemBase {
  type: 'user_speech';
  transcript: string;
  startedAt: string;
  endedAt?: string;
  audioDurationMs?: number;
}

export interface AssistantSpeechItem extends ConversationItemBase {
  type: 'assistant_speech';
  transcript: string;
  responseId?: string;
  startedAt: string;
  endedAt?: string;
  firstAudioLatencyMs?: number;
  interrupted?: boolean;
  heardAudioMs?: number;
}

export interface TextMessageItem extends ConversationItemBase {
  type: 'text_message';
  role: 'user' | 'assistant' | 'system';
  text: string;
  responseId?: string;
}

export interface ToolCallItem extends ConversationItemBase {
  type: 'tool_call';
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  status: 'pending' | 'awaiting_confirmation' | 'running' | 'completed' | 'failed' | 'rejected';
  requiresConfirmation?: boolean;
  durationMs?: number;
  error?: string;
}

export interface ToolResultItem extends ConversationItemBase {
  type: 'tool_result';
  callId: string;
  name: string;
  result?: unknown;
  error?: string;
  durationMs: number;
}

export interface InterruptionItem extends ConversationItemBase {
  type: 'interruption';
  responseId?: string;
  itemId?: string;
  audioEndMs?: number;
  reason: 'barge_in' | 'manual';
}

export interface RealtimeConversationErrorItem extends ConversationItemBase {
  type: 'error';
  code?: string;
  message: string;
  retryable: boolean;
}

export type ConversationItem =
  | UserSpeechItem
  | AssistantSpeechItem
  | TextMessageItem
  | ToolCallItem
  | ToolResultItem
  | InterruptionItem
  | RealtimeConversationErrorItem;

export interface RealtimeConversation {
  id: string;
  provider: RealtimeProviderName;
  model: string;
  startedAt: string;
  endedAt?: string;
  status: 'active' | 'completed' | 'failed';
  items: ConversationItem[];
  metrics: ConversationMetrics;
  metadata?: Record<string, unknown>;
}

export interface RealtimeToolCall {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
  argumentError?: string;
  itemId?: string;
  responseId?: string;
  idempotencyKey: string;
  raw?: unknown;
}

export interface RealtimeToolResult {
  call: RealtimeToolCall;
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  attempts: number;
}

export type RealtimeEvent =
  | { type: 'session.connected'; sessionId: string; timestamp: number }
  | { type: 'session.reconnecting'; attempt: number; delayMs: number; timestamp: number }
  | { type: 'session.disconnected'; reason?: string; expected: boolean; timestamp: number }
  | { type: 'speech.started'; timestamp: number; itemId?: string }
  | { type: 'speech.stopped'; timestamp: number; itemId?: string; audioEndMs?: number }
  | { type: 'user.transcript.delta'; delta: string; itemId?: string; timestamp: number }
  | { type: 'user.transcript.completed'; transcript: string; itemId?: string; timestamp: number }
  | {
      type: 'assistant.audio.delta';
      audio: ArrayBuffer;
      durationMs?: number;
      responseId?: string;
      itemId?: string;
      timestamp: number;
    }
  | {
      type: 'assistant.audio.track';
      stream?: unknown;
      track?: unknown;
      responseId?: string;
      itemId?: string;
      timestamp: number;
    }
  | {
      type: 'assistant.transcript.delta';
      delta: string;
      responseId?: string;
      itemId?: string;
      timestamp: number;
    }
  | {
      type: 'assistant.transcript.completed';
      transcript: string;
      responseId?: string;
      itemId?: string;
      timestamp: number;
    }
  | {
      type: 'message.text.delta';
      role: 'user' | 'assistant' | 'system';
      delta: string;
      responseId?: string;
      itemId?: string;
      timestamp: number;
    }
  | {
      type: 'message.text.completed';
      role: 'user' | 'assistant' | 'system';
      text: string;
      responseId?: string;
      itemId?: string;
      timestamp: number;
    }
  | { type: 'assistant.response.created'; responseId: string; timestamp: number }
  | { type: 'assistant.response.completed'; responseId: string; itemId?: string; timestamp: number }
  | { type: 'assistant.response.cancelled'; responseId: string; itemId?: string; timestamp: number }
  | { type: 'tool.call.started'; call: RealtimeToolCall; timestamp: number }
  | { type: 'tool.confirmation.required'; call: RealtimeToolCall; timestamp: number }
  | { type: 'tool.call.completed'; result: RealtimeToolResult; timestamp: number }
  | {
      type: 'interruption';
      reason: 'barge_in' | 'manual';
      responseId?: string;
      itemId?: string;
      audioEndMs?: number;
      timestamp: number;
    }
  | { type: 'error'; error: RealtimeError; timestamp: number };

export interface RealtimeSessionEvents {
  'session.connected': Extract<RealtimeEvent, { type: 'session.connected' }>;
  'session.reconnecting': Extract<RealtimeEvent, { type: 'session.reconnecting' }>;
  'session.disconnected': Extract<RealtimeEvent, { type: 'session.disconnected' }>;
  'speech.started': Extract<RealtimeEvent, { type: 'speech.started' }>;
  'speech.stopped': Extract<RealtimeEvent, { type: 'speech.stopped' }>;
  'user.transcript.delta': Extract<RealtimeEvent, { type: 'user.transcript.delta' }>;
  'user.transcript.completed': Extract<RealtimeEvent, { type: 'user.transcript.completed' }>;
  'assistant.audio.delta': Extract<RealtimeEvent, { type: 'assistant.audio.delta' }>;
  'assistant.audio.track': Extract<RealtimeEvent, { type: 'assistant.audio.track' }>;
  'assistant.transcript.delta': Extract<RealtimeEvent, { type: 'assistant.transcript.delta' }>;
  'assistant.transcript.completed': Extract<RealtimeEvent, { type: 'assistant.transcript.completed' }>;
  'message.text.delta': Extract<RealtimeEvent, { type: 'message.text.delta' }>;
  'message.text.completed': Extract<RealtimeEvent, { type: 'message.text.completed' }>;
  'assistant.response.created': Extract<RealtimeEvent, { type: 'assistant.response.created' }>;
  'assistant.response.completed': Extract<RealtimeEvent, { type: 'assistant.response.completed' }>;
  'assistant.response.cancelled': Extract<RealtimeEvent, { type: 'assistant.response.cancelled' }>;
  'tool.call.started': Extract<RealtimeEvent, { type: 'tool.call.started' }>;
  'tool.confirmation.required': Extract<RealtimeEvent, { type: 'tool.confirmation.required' }>;
  'tool.call.completed': Extract<RealtimeEvent, { type: 'tool.call.completed' }>;
  interruption: Extract<RealtimeEvent, { type: 'interruption' }>;
  error: RealtimeError;
  'conversation.updated': RealtimeConversation;
  metrics: ConversationMetrics;
  'raw.event': RealtimeServerEvent;
  state: RealtimeSessionState;
}

export interface RealtimeSchemaResult<T> {
  success: boolean;
  data?: T;
  error?: unknown;
}

export interface RealtimeToolSchema<T> {
  parse?(input: unknown): T;
  safeParse?(input: unknown): RealtimeSchemaResult<T>;
  validate?(input: unknown): T | Promise<T>;
}

export type InferRealtimeSchema<Schema> = Schema extends { parse(input: unknown): infer Output }
  ? Output
  : Schema extends { safeParse(input: unknown): RealtimeSchemaResult<infer Output> }
    ? Output
    : Record<string, unknown>;

export interface RealtimeToolContext {
  sessionId: string;
  callId: string;
  idempotencyKey: string;
  attempt: number;
  signal: AbortSignal;
}

export interface RealtimeTool<Input = Record<string, unknown>, Output = unknown> {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  schema?: RealtimeToolSchema<Input>;
  execute(input: Input, context: RealtimeToolContext): Output | Promise<Output>;
  requiresConfirmation?: boolean | ((input: Input) => boolean | Promise<boolean>);
  safe?: boolean;
  cache?:
    | boolean
    | {
        ttlMs?: number;
        key?: (input: Input) => string;
      };
  metadata?: Record<string, unknown>;
}

/** Type-erased tool shape used by heterogeneous tool collections. */
// biome-ignore lint/suspicious/noExplicitAny: `any` is required to model an existential input type in a collection.
export type AnyRealtimeTool = RealtimeTool<any, unknown>;

export interface RealtimeToolCache {
  get(key: string): unknown | undefined | Promise<unknown | undefined>;
  set(key: string, value: unknown, ttlMs?: number): void | Promise<void>;
}

export interface RealtimeToolExecutionOptions {
  mode?: 'automatic' | 'manual';
  timeoutMs?: number;
  maxParallelCalls?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  allowedTools?: string[];
  cache?: RealtimeToolCache;
  cacheFailureMode?: 'ignore' | 'fail';
  confirm?: (call: RealtimeToolCall, signal: AbortSignal) => boolean | Promise<boolean>;
}

export interface RealtimeReconnectOptions {
  enabled?: boolean;
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  multiplier?: number;
}

export interface RealtimeInterruptionOptions {
  enabled?: boolean;
  cancelResponse?: boolean;
  truncateUnheardAudio?: boolean;
  stopPlayback?: () => void;
  getPlaybackPositionMs?: () => number | undefined;
}

export type RealtimeTurnDetectionOptions =
  | { type: 'server_vad'; threshold?: number; prefixPaddingMs?: number; silenceDurationMs?: number }
  | { type: 'semantic_vad'; eagerness?: 'low' | 'medium' | 'high' | 'auto' }
  | null;

export interface RealtimeAudioFormat {
  type?: 'audio/pcm' | 'audio/pcmu' | 'audio/pcma' | (string & {});
  rate?: number;
}

export interface RealtimeAudioOptions {
  input?: {
    format?: RealtimeAudioFormat;
    transcriptionModel?: string;
    language?: string;
    turnDetection?: RealtimeTurnDetectionOptions;
  };
  output?: {
    format?: RealtimeAudioFormat;
    voice?: string;
    speed?: number;
  };
}

export interface RealtimeAudioElementLike {
  srcObject?: unknown;
  autoplay?: boolean;
  play?: () => void | Promise<void>;
  pause?: () => void;
}

export interface RealtimeConnectOptions {
  signal?: AbortSignal;
  microphone?: boolean | Record<string, unknown>;
  audioElement?: RealtimeAudioElementLike;
  remoteAudioSink?: (audio: RealtimeTransportAudioEvent) => void;
}

export interface RealtimeClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface RealtimeSpanLike {
  setAttribute?(name: string, value: string | number | boolean): void;
  recordException?(error: unknown): void;
  end(): void;
}

export interface RealtimeTracerLike {
  startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean> }): RealtimeSpanLike;
}

export interface RealtimeMetricInstrumentLike {
  add?(value: number, attributes?: Record<string, string | number | boolean>): void;
  record?(value: number, attributes?: Record<string, string | number | boolean>): void;
}

export interface RealtimeMeterLike {
  createCounter?(name: string): RealtimeMetricInstrumentLike;
  createUpDownCounter?(name: string): RealtimeMetricInstrumentLike;
  createHistogram?(name: string): RealtimeMetricInstrumentLike;
}

export interface RealtimeTokenUsage {
  provider: RealtimeProviderName;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  raw: Record<string, unknown>;
}

export interface RealtimeTelemetryOptions {
  tracer?: RealtimeTracerLike;
  meter?: RealtimeMeterLike;
  includeTranscripts?: boolean;
  estimateCost?: (usage: RealtimeTokenUsage) => number | undefined;
  attributes?: Record<string, string | number | boolean>;
  onEvent?: (event: RealtimeEvent) => void;
  onMetrics?: (metrics: ConversationMetrics) => void;
}

export interface RealtimeConversationOptions {
  captureTranscripts?: boolean;
  captureToolCalls?: boolean;
  retainRawEvents?: boolean;
  maxRawEvents?: number;
  redactTranscript?: (text: string, role: 'user' | 'assistant') => string;
}

export interface RealtimeSecurityOptions {
  maxSessionDurationMs?: number;
  maxAudioDurationMs?: number;
  toolAllowlist?: string[];
  retainTranscripts?: boolean;
  piiHook?: (text: string, role: 'user' | 'assistant') => string | Promise<string>;
}

export interface RealtimeSessionConfig {
  id?: string;
  provider?: RealtimeProviderName;
  model: string;
  transport: RealtimeTransport;
  modalities?: RealtimeModality[];
  instructions?: string;
  tools?: AnyRealtimeTool[];
  toolChoice?: 'auto' | 'none' | 'required' | string;
  toolExecution?: RealtimeToolExecutionOptions;
  interruption?: boolean | RealtimeInterruptionOptions;
  reconnect?: RealtimeReconnectOptions;
  audio?: RealtimeAudioOptions;
  conversation?: RealtimeConversationOptions;
  telemetry?: RealtimeTelemetryOptions;
  security?: RealtimeSecurityOptions;
  connection?: RealtimeConnectOptions;
  metadata?: Record<string, unknown>;
  providerSession?: Record<string, unknown>;
  signal?: AbortSignal;
  clock?: RealtimeClock;
  idFactory?: (prefix?: string) => string;
}

export type RealtimeConversationExportFormat = 'json' | 'openai-events' | 'text' | 'analytics';

export interface RealtimeAnalyticsExport {
  conversationId: string;
  provider: RealtimeProviderName;
  model: string;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  itemCounts: Record<ConversationItem['type'], number>;
  metrics: ConversationMetrics;
}
