import type { RealtimeError } from './errors.js';

/**
 * Which realtime provider a session talks to. `openai` is built in; any other string names a custom
 * provider.
 */
export type RealtimeProviderName = 'openai' | (string & {});
/**
 * How audio and events travel: browser WebRTC, a server WebSocket, the in-memory mock, or a custom
 * transport.
 */
export type RealtimeTransportKind = 'webrtc' | 'websocket' | 'mock' | (string & {});
/** Lifecycle of a transport connection, from construction to a clean or failed close. */
export type RealtimeTransportState = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'failed';
/**
 * Lifecycle of a realtime session, including the reconnecting state a transport's own states do not
 * have.
 */
export type RealtimeSessionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnecting'
  | 'disconnected'
  | 'failed';
/** What a session exchanges with the model: spoken audio, text, or both. */
export type RealtimeModality = 'audio' | 'text';
/** A raw event sent to the provider, in the provider's own wire format. */
export type RealtimeClientEvent = {
  /** The event type, such as `session.update`. */
  type: string;
  /** The event's id, which the provider echoes in errors about it. */
  event_id?: string;
  [key: string]: unknown;
};
/** A raw event received from the provider, in the provider's own wire format. */
export type RealtimeServerEvent = {
  /** The event type, such as `session.update`. */
  type: string;
  /** The event's id, which the provider echoes in errors about it. */
  event_id?: string;
  [key: string]: unknown;
};

/** Emitted once a transport has an open connection to the provider. */
export interface RealtimeTransportConnectedEvent {
  /** The provider's session id, when the handshake reported one. */
  sessionId?: string;
  /** Which transport connected. */
  transport: RealtimeTransportKind;
  /** Epoch milliseconds when the connection opened. */
  timestamp: number;
  /** The provider's handshake payload, unmodified. */
  raw?: unknown;
}

/** Emitted when a transport's connection closes, cleanly or not. */
export interface RealtimeTransportDisconnectedEvent {
  /** Which transport disconnected. */
  transport: RealtimeTransportKind;
  /** Epoch milliseconds when the connection closed. */
  timestamp: number;
  /** WebSocket or provider close code, when there was one. */
  code?: number;
  /** Human-readable close reason, when the provider gave one. */
  reason?: string;
  /**
   * True when the application asked to disconnect, so the session does not treat it as a failure.
   */
  expected?: boolean;
  /**
   * True when reconnecting is likely to succeed, which is what the session's reconnect policy acts
   * on.
   */
  retryable?: boolean;
  /** The provider's close payload, unmodified. */
  raw?: unknown;
}

/**
 * A piece of model audio arriving from the provider: bytes over WebSocket, or a media stream over
 * WebRTC.
 */
export interface RealtimeTransportAudioEvent {
  /** Encoded audio bytes, for transports that deliver audio as data. */
  data?: ArrayBuffer;
  /** The remote `MediaStream`, for WebRTC, where audio arrives as a stream rather than bytes. */
  stream?: unknown;
  /** The remote `MediaStreamTrack`, for WebRTC. */
  track?: unknown;
  /** MIME type of `data`, such as `audio/pcm`. */
  mimeType?: string;
  /** Sample rate of `data` in hertz. */
  sampleRate?: number;
  /** The model response this audio belongs to. */
  responseId?: string;
  /** The conversation item this audio belongs to. */
  itemId?: string;
  /** The provider event the audio came from, unmodified. */
  raw?: unknown;
}

/** A provider event arriving over the transport's data channel. */
export interface RealtimeTransportDataEvent {
  /** The event, parsed from the wire. */
  event: RealtimeServerEvent;
  /** The raw message before parsing. */
  raw?: unknown;
}

/** Events a transport emits, keyed by name, with the payload each carries. */
export interface RealtimeTransportEvents {
  /** The connection opened. */
  connected: RealtimeTransportConnectedEvent;
  /** The connection closed. */
  disconnected: RealtimeTransportDisconnectedEvent;
  /** Model audio arrived. */
  audio: RealtimeTransportAudioEvent;
  /** A provider event arrived. */
  data: RealtimeTransportDataEvent;
  /** The transport failed; the error says whether the failure is retryable or fatal. */
  error: RealtimeError;
}

/**
 * Moves audio and events between a session and a provider. The session owns the conversation; a
 * transport only carries it, which is what lets WebRTC, WebSocket, and the mock be swapped.
 */
export interface RealtimeTransport {
  /** Which kind of transport this is. */
  readonly kind: RealtimeTransportKind;
  /** Current connection state, for transports that track it. */
  readonly state?: RealtimeTransportState;
  /** Opens the connection and configures the provider session. */
  connect(config: RealtimeSessionConfig): Promise<void>;
  /** Sends a chunk of microphone audio. Transports that stream a media track may ignore it. */
  sendAudio(chunk: ArrayBuffer): void;
  /** Sends a raw provider event. */
  sendEvent(event: RealtimeClientEvent): void;
  /** Stops the model speaking now, for barge-in or a manual interruption. */
  interrupt(): void;
  /** Closes the connection. Resolves once it is closed. */
  disconnect(): Promise<void>;
  /** Subscribes to a transport event. Returns a function that unsubscribes. */
  on<Event extends keyof RealtimeTransportEvents>(
    event: Event,
    listener: (payload: RealtimeTransportEvents[Event]) => void,
  ): () => void;
}

/** Latency of the moments a user notices in a spoken exchange, in milliseconds. */
export interface RealtimeLatencyMetrics {
  /** Time from the start of `connect()` to an open connection. */
  connectionSetupMs: number;
  /** From the end of the user's speech to the model starting a response, for the latest turn. */
  speechEndToResponseCreatedMs?: number;
  /**
   * From the end of the user's speech to the first audio the user hears, for the latest turn: the
   * latency a caller actually feels.
   */
  speechEndToFirstAudioMs?: number;
  /** How long the latest tool call took to execute. */
  toolCallDurationMs?: number;
  /** From a tool result being sent back to the first audio of the answer that used it. */
  toolResultToFirstAudioMs?: number;
  /** Duration of the latest turn from the user starting to speak to the model finishing. */
  totalTurnDurationMs?: number;
}

/** Running totals for a whole conversation, alongside the latest turn's latency. */
export interface ConversationMetrics extends RealtimeLatencyMetrics {
  /** Completed exchanges between the user and the model. */
  turns: number;
  /** Tool calls the model made. */
  toolCalls: number;
  /** Times the user spoke over the model, or the application cut it off. */
  interruptions: number;
  /** Times the transport reconnected after a drop. */
  reconnects: number;
  /** Errors reported during the conversation, including recovered ones. */
  errors: number;
  /** Total user audio received, in milliseconds. */
  inputAudioDurationMs: number;
  /** Total model audio sent, in milliseconds. */
  outputAudioDurationMs: number;
  /** Input tokens the provider reported. */
  inputTokens?: number;
  /** Output tokens the provider reported. */
  outputTokens?: number;
  /** Cost from `telemetry.estimateCost`, when configured. A local estimate, not a provider bill. */
  estimatedCost?: number;
}

/** Fields every item in a conversation record shares. */
export interface ConversationItemBase {
  /** This package's id for the item, stable across exports. */
  id: string;
  /** ISO-8601 time the item was created. */
  createdAt: string;
  /** The provider's own id for the item, for matching against provider logs. */
  providerItemId?: string;
  /** The provider event the item was built from, when raw events are retained. */
  raw?: unknown;
  /** Application data attached to the item. */
  metadata?: Record<string, unknown>;
}

/** Something the user said, as transcribed by the provider. */
export interface UserSpeechItem extends ConversationItemBase {
  /** Discriminates this item in `ConversationItem`. */
  type: 'user_speech';
  /** The transcription of what the user said. Empty when transcripts are not captured. */
  transcript: string;
  /** ISO-8601 time the user started speaking. */
  startedAt: string;
  /** ISO-8601 time the user stopped speaking. */
  endedAt?: string;
  /** Length of the user's audio in milliseconds. */
  audioDurationMs?: number;
}

/** Something the model said aloud. */
export interface AssistantSpeechItem extends ConversationItemBase {
  /** Discriminates this item in `ConversationItem`. */
  type: 'assistant_speech';
  /** Transcript of the model's speech. Empty when transcripts are not captured. */
  transcript: string;
  /** The model response this speech belongs to. */
  responseId?: string;
  /** ISO-8601 time the first audio arrived. */
  startedAt: string;
  /** ISO-8601 time the response finished or was cut off. */
  endedAt?: string;
  /** From the end of the user's speech to this response's first audio. */
  firstAudioLatencyMs?: number;
  /** True when the user or the application cut the response off. */
  interrupted?: boolean;
  /**
   * How much of the audio the user actually heard before an interruption, in milliseconds. The
   * transcript past this point was never spoken aloud.
   */
  heardAudioMs?: number;
}

/** A text message in the conversation, typed rather than spoken. */
export interface TextMessageItem extends ConversationItemBase {
  /** Discriminates this item in `ConversationItem`. */
  type: 'text_message';
  /** Who wrote it. */
  role: 'user' | 'assistant' | 'system';
  /** The message text. */
  text: string;
  /** The model response this message belongs to, for assistant messages. */
  responseId?: string;
}

/** The model asking to call a tool. */
export interface ToolCallItem extends ConversationItemBase {
  /** Discriminates this item in `ConversationItem`. */
  type: 'tool_call';
  /** The provider's id for the call, which its result must carry back. */
  callId: string;
  /** The tool's name. */
  name: string;
  /** Arguments the model supplied, parsed from JSON. */
  arguments: Record<string, unknown>;
  /** Where the call is: waiting to run, waiting for a person to confirm, running, or settled. */
  status: 'pending' | 'awaiting_confirmation' | 'running' | 'completed' | 'failed' | 'rejected';
  /** True when the tool needed a person's confirmation before running. */
  requiresConfirmation?: boolean;
  /** How long the tool took to execute, once it has. */
  durationMs?: number;
  /** Why the call failed or was rejected. */
  error?: string;
}

/** What a tool returned to the model. */
export interface ToolResultItem extends ConversationItemBase {
  /** Discriminates this item in `ConversationItem`. */
  type: 'tool_result';
  /** The call this result answers. */
  callId: string;
  /** The tool's name. */
  name: string;
  /** The value returned to the model, when the tool succeeded. */
  result?: unknown;
  /** Why the tool failed, when it did. */
  error?: string;
  /** How long the tool took, in milliseconds. */
  durationMs: number;
}

/** The model being cut off mid-response. */
export interface InterruptionItem extends ConversationItemBase {
  /** Discriminates this item in `ConversationItem`. */
  type: 'interruption';
  /** The response that was cut off. */
  responseId?: string;
  /** The item that was cut off. */
  itemId?: string;
  /** How far into the response's audio the cut happened, in milliseconds. */
  audioEndMs?: number;
  /** `barge_in` when the user started speaking, `manual` when the application interrupted. */
  reason: 'barge_in' | 'manual';
}

/** An error recorded in the conversation, so an export shows where a session went wrong. */
export interface RealtimeConversationErrorItem extends ConversationItemBase {
  /** Discriminates this item in `ConversationItem`. */
  type: 'error';
  /** The provider's or this package's error code. */
  code?: string;
  /** What went wrong. */
  message: string;
  /** Whether the session could continue or reconnect after it. */
  retryable: boolean;
}

/**
 * One entry in a conversation record: speech, text, a tool call or result, an interruption, or an
 * error.
 */
export type ConversationItem =
  | UserSpeechItem
  | AssistantSpeechItem
  | TextMessageItem
  | ToolCallItem
  | ToolResultItem
  | InterruptionItem
  | RealtimeConversationErrorItem;

/**
 * A realtime conversation as a record: what was said, what tools ran, and how it performed. What
 * exports, analytics, and evaluation read.
 */
export interface RealtimeConversation {
  /** This package's id for the conversation. */
  id: string;
  /** The provider the conversation ran on. */
  provider: RealtimeProviderName;
  /** The model the conversation ran on. */
  model: string;
  /** ISO-8601 time the session started. */
  startedAt: string;
  /** ISO-8601 time the session ended. */
  endedAt?: string;
  /** `active` while the session runs, then `completed` or `failed`. */
  status: 'active' | 'completed' | 'failed';
  /** Every item, in the order it happened. */
  items: ConversationItem[];
  /** Running totals and latest-turn latency. */
  metrics: ConversationMetrics;
  /** Application data attached to the conversation. */
  metadata?: Record<string, unknown>;
}

/** A tool call as the session hands it to the tool executor. */
export interface RealtimeToolCall {
  /** The provider's id for the call. */
  callId: string;
  /** The tool's name. */
  name: string;
  /** Arguments parsed from the model's JSON. */
  arguments: Record<string, unknown>;
  /** The arguments exactly as the model sent them, kept when parsing fails. */
  rawArguments?: string;
  /**
   * Why the arguments could not be parsed or validated. The tool is not run with arguments it could
   * not read.
   */
  argumentError?: string;
  /** The conversation item the call belongs to. */
  itemId?: string;
  /** The model response the call belongs to. */
  responseId?: string;
  /**
   * Identifies this call across retries, so a tool that charges or books can refuse to do it twice.
   */
  idempotencyKey: string;
  /** The provider event the call came from. */
  raw?: unknown;
}

/** The outcome of executing one tool call. */
export interface RealtimeToolResult {
  /** The call this result answers. */
  call: RealtimeToolCall;
  /** True when the tool returned a value rather than failing. */
  ok: boolean;
  /** The value returned to the model. */
  result?: unknown;
  /** Why the call failed. */
  error?: string;
  /** Total execution time across attempts, in milliseconds. */
  durationMs: number;
  /** Attempts made. Above 1 only for tools marked `safe`, the only ones retried. */
  attempts: number;
}

/**
 * Everything a realtime session reports, as a discriminated union on `type`. Subscribe to one kind
 * through `RealtimeSessionEvents`.
 */
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

/** Session events by name, with the payload each listener receives. */
export interface RealtimeSessionEvents {
  /** The session connected. */
  'session.connected': Extract<RealtimeEvent, { type: 'session.connected' }>;
  /** The transport dropped and the session is reconnecting. */
  'session.reconnecting': Extract<RealtimeEvent, { type: 'session.reconnecting' }>;
  /** The session disconnected. */
  'session.disconnected': Extract<RealtimeEvent, { type: 'session.disconnected' }>;
  /** The user started speaking. */
  'speech.started': Extract<RealtimeEvent, { type: 'speech.started' }>;
  /** The user stopped speaking. */
  'speech.stopped': Extract<RealtimeEvent, { type: 'speech.stopped' }>;
  /** Part of the user's transcript arrived. */
  'user.transcript.delta': Extract<RealtimeEvent, { type: 'user.transcript.delta' }>;
  /** The user's transcript for a turn is complete. */
  'user.transcript.completed': Extract<RealtimeEvent, { type: 'user.transcript.completed' }>;
  /** Part of the model's audio arrived. */
  'assistant.audio.delta': Extract<RealtimeEvent, { type: 'assistant.audio.delta' }>;
  /** A WebRTC media track for the model's audio is available. */
  'assistant.audio.track': Extract<RealtimeEvent, { type: 'assistant.audio.track' }>;
  /** Part of the model's spoken transcript arrived. */
  'assistant.transcript.delta': Extract<RealtimeEvent, { type: 'assistant.transcript.delta' }>;
  /** The model's spoken transcript for a response is complete. */
  'assistant.transcript.completed': Extract<RealtimeEvent, { type: 'assistant.transcript.completed' }>;
  /** Part of a text message arrived. */
  'message.text.delta': Extract<RealtimeEvent, { type: 'message.text.delta' }>;
  /** A text message is complete. */
  'message.text.completed': Extract<RealtimeEvent, { type: 'message.text.completed' }>;
  /** The model started a response. */
  'assistant.response.created': Extract<RealtimeEvent, { type: 'assistant.response.created' }>;
  /** The model finished a response. */
  'assistant.response.completed': Extract<RealtimeEvent, { type: 'assistant.response.completed' }>;
  /** A response was cancelled, usually by an interruption. */
  'assistant.response.cancelled': Extract<RealtimeEvent, { type: 'assistant.response.cancelled' }>;
  /** A tool call started executing. */
  'tool.call.started': Extract<RealtimeEvent, { type: 'tool.call.started' }>;
  /** A tool call is waiting for a person to confirm it. */
  'tool.confirmation.required': Extract<RealtimeEvent, { type: 'tool.confirmation.required' }>;
  /** A tool call finished. */
  'tool.call.completed': Extract<RealtimeEvent, { type: 'tool.call.completed' }>;
  /** The model was cut off. */
  interruption: Extract<RealtimeEvent, { type: 'interruption' }>;
  /** Something failed; the error says whether it was fatal. */
  error: RealtimeError;
  /** The conversation record changed. */
  'conversation.updated': RealtimeConversation;
  /** Metrics were updated. */
  metrics: ConversationMetrics;
  /** Every raw provider event, for logging or for features this package does not model. */
  'raw.event': RealtimeServerEvent;
  /** The session's lifecycle state changed. */
  state: RealtimeSessionState;
}

/** The result of validating a tool's arguments with a schema's `safeParse`. */
export interface RealtimeSchemaResult<T> {
  /** Whether the arguments were valid. */
  success: boolean;
  /** The parsed arguments, when valid. */
  data?: T;
  /** Why validation failed. */
  error?: unknown;
}

/**
 * Validates a realtime tool's arguments. Structural, so a Zod schema, a Valibot schema, or a
 * hand-written validator all fit without this package depending on any of them.
 */
export interface RealtimeToolSchema<T> {
  /** Returns the parsed value, or throws when the input is invalid. */
  parse?(input: unknown): T;
  /** Returns a success flag and the parsed value or the error, without throwing. */
  safeParse?(input: unknown): RealtimeSchemaResult<T>;
  /** Validates asynchronously; returns the value or throws. */
  validate?(input: unknown): T | Promise<T>;
}

/** The argument type a schema produces, or a plain record when it cannot be inferred. */
export type InferRealtimeSchema<Schema> = Schema extends { parse(input: unknown): infer Output }
  ? Output
  : Schema extends { safeParse(input: unknown): RealtimeSchemaResult<infer Output> }
    ? Output
    : Record<string, unknown>;

/** What a tool's `execute` receives besides its arguments. */
export interface RealtimeToolContext {
  /** The session the call came from. */
  sessionId: string;
  /** The provider's id for the call. */
  callId: string;
  /** Stable across retries of this call, for a tool whose side effect must happen once. */
  idempotencyKey: string;
  /** This attempt's number, starting at 1. */
  attempt: number;
  /** Aborted when the session disconnects, the call times out, or it is cancelled. */
  signal: AbortSignal;
}

/** A tool a realtime model can call mid-conversation. */
export interface RealtimeTool<Input = Record<string, unknown>, Output = unknown> {
  /** The name the model calls the tool by. */
  name: string;
  /** What the tool does, written for the model: it decides when to call the tool from this. */
  description: string;
  /** JSON Schema for the arguments, sent to the provider. */
  parameters?: Record<string, unknown>;
  /**
   * Validates arguments before `execute` runs; invalid arguments fail the call without running the
   * tool.
   */
  schema?: RealtimeToolSchema<Input>;
  /** Runs the tool and returns what the model should see. */
  execute(input: Input, context: RealtimeToolContext): Output | Promise<Output>;
  /**
   * Requires a person's confirmation before running: always, or decided per call from the
   * arguments.
   */
  requiresConfirmation?: boolean | ((input: Input) => boolean | Promise<boolean>);
  /**
   * Declares the tool free of side effects, which is what allows it to be retried and cached. Leave
   * unset for anything that writes, charges, or sends.
   */
  safe?: boolean;
  /** Caches results of a `safe` tool: `true` with defaults, or a TTL and a key function. */
  cache?:
    | boolean
    | {
        ttlMs?: number;
        key?: (input: Input) => string;
      };
  /** Application data attached to the tool. */
  metadata?: Record<string, unknown>;
}

/** Type-erased tool shape used by heterogeneous tool collections. */
// biome-ignore lint/suspicious/noExplicitAny: `any` is required to model an existential input type in a collection.
export type AnyRealtimeTool = RealtimeTool<any, unknown>;

/** Where cached tool results live. `get` and `set` may be synchronous or asynchronous. */
export interface RealtimeToolCache {
  /** Returns the cached value, or `undefined` for a miss. */
  get(key: string): unknown | undefined | Promise<unknown | undefined>;
  /** Stores a value, optionally for a limited time. */
  set(key: string, value: unknown, ttlMs?: number): void | Promise<void>;
}

/** How a session executes the tools a model calls. */
export interface RealtimeToolExecutionOptions {
  /** `automatic` runs calls as they arrive; `manual` leaves them for the application to run. */
  mode?: 'automatic' | 'manual';
  /** Per-attempt execution timeout, in milliseconds. */
  timeoutMs?: number;
  /** Calls executed at once when the model asks for several. */
  maxParallelCalls?: number;
  /** Retries for a failing call. Applied only to tools marked `safe`. */
  maxRetries?: number;
  /** Delay between retries, in milliseconds. */
  retryDelayMs?: number;
  /** Tools the model may call. Intersected with `security.toolAllowlist` when both are set. */
  allowedTools?: string[];
  /** Cache for results of `safe` tools that enable caching. */
  cache?: RealtimeToolCache;
  /** What a cache failure does: `ignore` runs the tool anyway, `fail` fails the call. */
  cacheFailureMode?: 'ignore' | 'fail';
  /**
   * Decides a call that needs confirmation. Resolve to true to run it; the signal aborts if the
   * session ends while waiting.
   */
  confirm?: (call: RealtimeToolCall, signal: AbortSignal) => boolean | Promise<boolean>;
}

/** How a session recovers from a dropped connection. */
export interface RealtimeReconnectOptions {
  /** Whether to reconnect at all. */
  enabled?: boolean;
  /** Attempts before giving up and reporting the session as failed. */
  maxAttempts?: number;
  /** Delay before the first attempt, in milliseconds. */
  initialDelayMs?: number;
  /** Longest delay between attempts, in milliseconds. */
  maxDelayMs?: number;
  /** Factor the delay grows by after each attempt. */
  multiplier?: number;
}

/** How the session handles the user speaking over the model. */
export interface RealtimeInterruptionOptions {
  /** Whether speaking over the model interrupts it. */
  enabled?: boolean;
  /** Cancels the model's response on the provider, so it stops generating as well as speaking. */
  cancelResponse?: boolean;
  /**
   * Truncates the model's record of its response at the point playback stopped, so the model does
   * not believe it said what the user never heard.
   */
  truncateUnheardAudio?: boolean;
  /** Stops local audio playback at once; the transport cannot reach the application's speaker. */
  stopPlayback?: () => void;
  /** How far playback has got, in milliseconds, which is where truncation cuts. */
  getPlaybackPositionMs?: () => number | undefined;
}

/**
 * How the provider decides the user finished speaking: silence-based, meaning-based, or `null` to
 * leave turn-taking to the application.
 */
export type RealtimeTurnDetectionOptions =
  | { type: 'server_vad'; threshold?: number; prefixPaddingMs?: number; silenceDurationMs?: number }
  | { type: 'semantic_vad'; eagerness?: 'low' | 'medium' | 'high' | 'auto' }
  | null;

/** An audio encoding and sample rate. */
export interface RealtimeAudioFormat {
  /** MIME type of the audio encoding. */
  type?: 'audio/pcm' | 'audio/pcmu' | 'audio/pcma' | (string & {});
  /** Sample rate in hertz. */
  rate?: number;
}

/** Audio settings for the session, input and output. */
export interface RealtimeAudioOptions {
  /** Microphone audio: its format, the transcription model, and turn detection. */
  input?: {
    format?: RealtimeAudioFormat;
    transcriptionModel?: string;
    language?: string;
    turnDetection?: RealtimeTurnDetectionOptions;
  };
  /** Model audio: its format and the voice it speaks in. */
  output?: {
    format?: RealtimeAudioFormat;
    voice?: string;
    speed?: number;
  };
}

/** The subset of an `HTMLAudioElement` the WebRTC transport needs to play the model's audio. */
export interface RealtimeAudioElementLike {
  /** Receives the remote media stream. */
  srcObject?: unknown;
  /** Whether playback starts as soon as audio arrives. */
  autoplay?: boolean;
  /** Starts playback. */
  play?: () => void | Promise<void>;
  /** Pauses playback. */
  pause?: () => void;
}

/** Browser connection options for the WebRTC transport. */
export interface RealtimeConnectOptions {
  /** Aborts connecting. */
  signal?: AbortSignal;
  /** Captures the microphone: `true` with defaults, or `getUserMedia` audio constraints. */
  microphone?: boolean | Record<string, unknown>;
  /** Where the model's audio plays. */
  audioElement?: RealtimeAudioElementLike;
  /** Receives the model's audio instead of an audio element, for custom playback. */
  remoteAudioSink?: (audio: RealtimeTransportAudioEvent) => void;
}

/** Time as the session sees it, injectable so tests control reconnect delays and latency. */
export interface RealtimeClock {
  /** Current time in epoch milliseconds. */
  now(): number;
  /** Waits, resolving early with a rejection if the signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The part of an OpenTelemetry span the session writes to. */
export interface RealtimeSpanLike {
  /** Records an attribute on the span. */
  setAttribute?(name: string, value: string | number | boolean): void;
  /** Records an error on the span. */
  recordException?(error: unknown): void;
  /** Ends the span. */
  end(): void;
}

/** The part of an OpenTelemetry tracer the session uses. */
export interface RealtimeTracerLike {
  /** Starts a span for a session or a turn. */
  startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean> }): RealtimeSpanLike;
}

/** The part of an OpenTelemetry counter or histogram the session records to. */
export interface RealtimeMetricInstrumentLike {
  /** Adds to a counter. */
  add?(value: number, attributes?: Record<string, string | number | boolean>): void;
  /** Records a histogram value. */
  record?(value: number, attributes?: Record<string, string | number | boolean>): void;
}

/** The part of an OpenTelemetry meter the session creates instruments from. */
export interface RealtimeMeterLike {
  /** Creates a counter. */
  createCounter?(name: string): RealtimeMetricInstrumentLike;
  /** Creates an up-down counter, used for active sessions. */
  createUpDownCounter?(name: string): RealtimeMetricInstrumentLike;
  /** Creates a histogram, used for latencies. */
  createHistogram?(name: string): RealtimeMetricInstrumentLike;
}

/** Token usage a provider reported, handed to `estimateCost`. */
export interface RealtimeTokenUsage {
  /** The provider that reported it. */
  provider: RealtimeProviderName;
  /** The model it was reported for. */
  model: string;
  /** Input tokens. */
  inputTokens?: number;
  /** Output tokens. */
  outputTokens?: number;
  /** The provider's usage payload, for pricing that needs more than two numbers. */
  raw: Record<string, unknown>;
}

/** Where a session reports spans, metrics, and events. */
export interface RealtimeTelemetryOptions {
  /** Receives a span per session and per turn. */
  tracer?: RealtimeTracerLike;
  /** Receives counters and latency histograms. */
  meter?: RealtimeMeterLike;
  /**
   * Includes transcripts in telemetry events. Off by default, because a trace backend is rarely
   * where spoken personal data should end up.
   */
  includeTranscripts?: boolean;
  /** Prices token usage. Without it, `estimatedCost` stays unset rather than invented. */
  estimateCost?: (usage: RealtimeTokenUsage) => number | undefined;
  /** Attributes added to every span and metric. */
  attributes?: Record<string, string | number | boolean>;
  /** Receives every event. */
  onEvent?: (event: RealtimeEvent) => void;
  /** Receives metrics whenever they change. */
  onMetrics?: (metrics: ConversationMetrics) => void;
}

/** What the session keeps in its conversation record. */
export interface RealtimeConversationOptions {
  /** Keeps transcripts in the record. `security.retainTranscripts: false` overrides this. */
  captureTranscripts?: boolean;
  /** Keeps tool calls and results in the record. */
  captureToolCalls?: boolean;
  /** Keeps raw provider events for export and debugging. */
  retainRawEvents?: boolean;
  /** Raw events kept before the oldest are dropped. Defaults to 10,000. */
  maxRawEvents?: number;
  /** Rewrites transcript text before it is recorded. */
  redactTranscript?: (text: string, role: 'user' | 'assistant') => string;
}

/** Limits and privacy controls for a session. */
export interface RealtimeSecurityOptions {
  /** Ends the session with a fatal error once it has run this long. */
  maxSessionDurationMs?: number;
  /** Ends the session with a fatal error once this much user audio has been received. */
  maxAudioDurationMs?: number;
  /** Tools the model may call, whatever else is configured. */
  toolAllowlist?: string[];
  /** `false` keeps no transcripts: none in the record, and no transcript or audio raw events. */
  retainTranscripts?: boolean;
  /**
   * Rewrites every transcript, user and model, before anything sees it: redaction of personal data
   * belongs here.
   */
  piiHook?: (text: string, role: 'user' | 'assistant') => string | Promise<string>;
}

/**
 * Everything a realtime session needs: the model, the transport, tools, and every policy around
 * them.
 */
export interface RealtimeSessionConfig {
  /** Session id. Generated when omitted. */
  id?: string;
  /** Provider name, for records and telemetry. Defaults to `openai`. */
  provider?: RealtimeProviderName;
  /** The realtime model to use. */
  model: string;
  /** How audio and events travel. */
  transport: RealtimeTransport;
  /** Output modalities: audio, text, or both. */
  modalities?: RealtimeModality[];
  /** System instructions for the model. */
  instructions?: string;
  /** Tools the model may call. */
  tools?: AnyRealtimeTool[];
  /** Whether the model may, must, or must not call tools, or which tool it must call. */
  toolChoice?: 'auto' | 'none' | 'required' | string;
  /** How tool calls are executed. */
  toolExecution?: RealtimeToolExecutionOptions;
  /** Barge-in handling: `true` for the defaults, `false` to disable, or detailed options. */
  interruption?: boolean | RealtimeInterruptionOptions;
  /** Reconnection after a dropped connection. */
  reconnect?: RealtimeReconnectOptions;
  /** Input and output audio settings. */
  audio?: RealtimeAudioOptions;
  /** What the conversation record keeps. */
  conversation?: RealtimeConversationOptions;
  /** Spans, metrics, and event callbacks. */
  telemetry?: RealtimeTelemetryOptions;
  /** Limits, allowlists, and privacy controls. */
  security?: RealtimeSecurityOptions;
  /** Browser connection options for WebRTC. */
  connection?: RealtimeConnectOptions;
  /** Application data attached to the conversation. */
  metadata?: Record<string, unknown>;
  /**
   * Provider session fields passed through as-is, for settings this package does not model. `tools`
   * and `tool_choice` are always taken from the fields above.
   */
  providerSession?: Record<string, unknown>;
  /** Ends the session when aborted. */
  signal?: AbortSignal;
  /** Replaces the system clock, for tests. */
  clock?: RealtimeClock;
  /** Creates ids for the session and its items. */
  idFactory?: (prefix?: string) => string;
}

/**
 * How a conversation can be exported: the record as JSON, the provider's events, a readable
 * transcript, or analytics.
 */
export type RealtimeConversationExportFormat = 'json' | 'openai-events' | 'text' | 'analytics';

/** A conversation summarised for analytics: durations, counts, and metrics, without transcripts. */
export interface RealtimeAnalyticsExport {
  /** The conversation's id. */
  conversationId: string;
  /** The provider it ran on. */
  provider: RealtimeProviderName;
  /** The model it ran on. */
  model: string;
  /** ISO-8601 start time. */
  startedAt: string;
  /** ISO-8601 end time. */
  endedAt?: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** Items of each type. */
  itemCounts: Record<ConversationItem['type'], number>;
  /** The conversation's metrics. */
  metrics: ConversationMetrics;
}
