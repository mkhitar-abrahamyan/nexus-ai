import type { CacheTtl, ReasoningEffort } from './providers.js';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Marks a message or tool definition as the end of a cacheable prefix.
 *
 * `true` uses the request-level TTL. An object overrides the TTL for this breakpoint only.
 */
export type CacheHint = boolean | { ttl?: CacheTtl };

// ── Content Parts ──────────────────────────────────────────────────

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  source:
    | { path: string }
    | { url: string }
    | { buffer: Buffer; mimeType?: string }
    | { base64: string; mimeType?: string };
}

export interface AudioContent {
  type: 'audio';
  source:
    | { path: string }
    | { buffer: Buffer; format?: string }
    | { stream: NodeJS.ReadableStream; format?: string; sampleRate?: number }
    | { transcript: string };
}

export interface VideoContent {
  type: 'video';
  source: {
    path: string;
    frameExtractionMode?: 'keyframes' | 'uniform' | 'all';
    maxFrames?: number;
    includeAudio?: boolean;
  };
}

export type ContentPart = TextContent | ImageContent | AudioContent | VideoContent;

// ── Tool Definitions ───────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
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

export interface ToolCallResult {
  toolCallId: string;
  name: string;
  result: unknown;
}

// ── Messages ───────────────────────────────────────────────────────

export interface Message {
  role: MessageRole;
  content: string | ContentPart[];
  name?: string;
  toolCallId?: string;
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
  effort?: ReasoningEffort;
  maxTokens?: number;
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
  mode?: 'off' | 'auto' | 'explicit';
  ttl?: CacheTtl;
  /**
   * Caps how many breakpoints are sent. Defaults to the provider's declared maximum, and the
   * last breakpoints in message order win when there are more marks than slots.
   */
  maxBreakpoints?: number;
}

// ── Request ────────────────────────────────────────────────────────

export interface CompletionRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  logitBias?: Record<string, number>;
  timeoutMs?: number;
  maxEstimatedCost?: number;
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
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    backoff?: 'fixed' | 'exponential';
  };
  responseFormat?: {
    type: 'json' | 'json_schema';
    schema?: Record<string, unknown>;
  };
  stop?: string | string[];
  stream?: boolean;
  signal?: AbortSignal;
  userId?: string;
  metadata?: Record<string, unknown>;
}
