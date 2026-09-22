import type { CacheTtl, ReasoningEffort } from './providers.js';

/** Who a message is from: instructions, the user, the model, or a tool result. */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Marks a message or tool definition as the end of a cacheable prefix.
 *
 * `true` uses the request-level TTL. An object overrides the TTL for this breakpoint only.
 */
export type CacheHint = boolean | { ttl?: CacheTtl };

// ── Content Parts ──────────────────────────────────────────────────

/** A text part of a message. */
export interface TextContent {
  /** Discriminates this part in `ContentPart`. */
  type: 'text';
  /** The text. */
  text: string;
}

/** An image part of a message, for vision-capable models. */
export interface ImageContent {
  /** Discriminates this part in `ContentPart`. */
  type: 'image';
  /** Where the image comes from: a file path, a URL, a buffer, or base64 text. */
  source:
    | { path: string }
    | { url: string }
    | { buffer: Buffer; mimeType?: string }
    | { base64: string; mimeType?: string };
}

/**
 * An audio part of a message, for audio-capable models, or a transcript standing in for the audio.
 */
export interface AudioContent {
  /** Discriminates this part in `ContentPart`. */
  type: 'audio';
  /** Where the audio comes from: a file path, a buffer, a stream, or a transcript. */
  source:
    | { path: string }
    | { buffer: Buffer; format?: string }
    | { stream: NodeJS.ReadableStream; format?: string; sampleRate?: number }
    | { transcript: string };
}

/**
 * A video part of a message. No bundled provider sends video yet: the part is validated and counted
 * against the context window, and its frame options are for a custom provider that handles video.
 */
export interface VideoContent {
  /** Discriminates this part in `ContentPart`. */
  type: 'video';
  /** The video file and how frames should be taken from it. */
  source: {
    path: string;
    frameExtractionMode?: 'keyframes' | 'uniform' | 'all';
    maxFrames?: number;
    includeAudio?: boolean;
  };
}

/** One part of a multimodal message. */
export type ContentPart = TextContent | ImageContent | AudioContent | VideoContent;

// ── Tool Definitions ───────────────────────────────────────────────

/** A tool the model may call. */
export interface ToolDefinition {
  /** The name the model calls the tool by. */
  name: string;
  /** What the tool does, written for the model: it decides when to call the tool from this. */
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
  /** Runs the tool, for the agent loop and executors that call tools automatically. */
  execute?: (args: Record<string, unknown>) => Promise<unknown>;
  /**
   * Ends a cacheable prefix after this tool. Only honored when the request sets
   * `cache.mode: 'explicit'` and the provider accepts caller-placed breakpoints.
   */
  cache?: CacheHint;
}

/**
 * How the model may use tools.
 *
 * `'auto'` lets the model decide, `'none'` forbids tool calls, `'required'` forces at least one,
 * and `{ name }` forces one specific tool.
 */
export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

/** What a tool returned, correlated with the call that asked for it. */
export interface ToolCallResult {
  /** The id of the call this answers. */
  toolCallId: string;
  /** The tool's name. */
  name: string;
  /** The value returned. */
  result: unknown;
}

// ── Messages ───────────────────────────────────────────────────────

/** One message in a conversation. */
export interface Message {
  /** Who the message is from. */
  role: MessageRole;
  /** Text, or an array of text, image, audio, and video parts. */
  content: string | ContentPart[];
  /** Participant name, for providers that distinguish several users or tools. */
  name?: string;
  /** For a `tool` message, the id of the call it answers. */
  toolCallId?: string;
  /**
   * For an `assistant` message, the tool calls the model made. `arguments` is the model's JSON,
   * unparsed.
   */
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  /**
   * Ends a cacheable prefix after this message. Only honored when the request sets
   * `cache.mode: 'explicit'` and the provider accepts caller-placed breakpoints.
   */
  cache?: CacheHint;
}

// ── Reasoning ──────────────────────────────────────────────────────

/**
 * Requested reasoning behavior.
 *
 * Leave it unset for the model's own default. `effort` is the portable control; `maxTokens` maps to
 * providers that budget thinking in tokens, and `summary` asks for streamed reasoning summaries,
 * which arrive as `StreamChunk` entries of type `'reasoning'`.
 */
export interface ReasoningConfig {
  /** Portable reasoning effort, mapped to each provider's own control. */
  effort?: ReasoningEffort;
  /** Thinking budget in tokens, for providers that budget reasoning that way. */
  maxTokens?: number;
  /** Whether to stream reasoning summaries, and how detailed. */
  summary?: 'none' | 'auto' | 'detailed';
}

// ── Prompt caching ─────────────────────────────────────────────────

/**
 * Provider-side prompt caching.
 *
 * `'auto'` (the default) leaves provider-managed caching alone and reports whatever the provider
 * says it reused. `'explicit'` sends caller-placed breakpoints from `Message.cache` and
 * `ToolDefinition.cache` to providers that accept them. `'off'` suppresses caller-placed
 * breakpoints; it cannot disable a provider's automatic caching.
 */
export interface PromptCacheConfig {
  /**
   * `auto` leaves provider caching alone, `explicit` sends caller-placed breakpoints, `off`
   * suppresses them.
   */
  mode?: 'off' | 'auto' | 'explicit';
  /** Cache lifetime for breakpoints that do not set their own. */
  ttl?: CacheTtl;
  /**
   * Caps how many breakpoints are sent. Defaults to the provider's declared maximum, and the
   * last breakpoints in message order win when there are more marks than slots.
   */
  maxBreakpoints?: number;
}

// ── Request ────────────────────────────────────────────────────────

/** A completion request: the model, the conversation, and every control over how it is answered. */
export interface CompletionRequest {
  /** Model name, alias, or `auto` to let the router choose. */
  model: string;
  /** The conversation so far. */
  messages: Message[];
  /** Tools the model may call. */
  tools?: ToolDefinition[];
  /** Sampling temperature. */
  temperature?: number;
  /** Output token limit. */
  maxTokens?: number;
  /** Nucleus sampling cutoff. */
  topP?: number;
  /** Top-k sampling cutoff, for providers that expose it. */
  topK?: number;
  /** Penalizes tokens by how often they have appeared. */
  frequencyPenalty?: number;
  /** Penalizes tokens that have appeared at all. */
  presencePenalty?: number;
  /** Seed for more reproducible sampling, for providers that support it. */
  seed?: number;
  /** Adjusts the likelihood of specific tokens, by token id. */
  logitBias?: Record<string, number>;
  /** Timeout per provider attempt, in milliseconds, overriding the client's. */
  timeoutMs?: number;
  /** Refuses or flags this request when its estimated cost exceeds this many US dollars. */
  maxEstimatedCost?: number;
  /** Output tokens assumed for the cost estimate when `maxTokens` is unset. */
  estimatedOutputTokens?: number;
  /** Controls whether and how the model may call tools. */
  toolChoice?: ToolChoice;
  /** Set false to force one tool call at a time on providers that support the switch. */
  parallelToolCalls?: boolean;
  /** Requested reasoning effort, thinking budget, and summary verbosity. */
  reasoning?: ReasoningConfig;
  /** Provider-side prompt caching controls. */
  cache?: PromptCacheConfig;
  /**
   * Overrides the configured capability policy for this request. `'strict'` fails on an option the
   * model cannot honor, `'warn'` drops it and records a warning, and `'off'` sends the request
   * unchanged so a newer provider feature is never blocked by stale registry data.
   */
  capabilityPolicy?: 'strict' | 'warn' | 'off';
  /** Retries for this request, overriding the client's policy. */
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    backoff?: 'fixed' | 'exponential';
  };
  /** Requires JSON output, optionally matching a schema. */
  responseFormat?: {
    type: 'json' | 'json_schema';
    schema?: Record<string, unknown>;
  };
  /** Sequences that end generation. */
  stop?: string | string[];
  /**
   * Informational only: whether a response streams is decided by calling `stream()` or
   * `complete()`.
   */
  stream?: boolean;
  /** Aborts the request, including retries and fallbacks still to run. */
  signal?: AbortSignal;
  /** End user the request is for, for rate limits, audit, and cache scoping. */
  userId?: string;
  /** Application data carried through hooks, traces, and audit events. */
  metadata?: Record<string, unknown>;
}
