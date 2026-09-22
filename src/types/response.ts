import type { PipelineTrace } from '../pipeline/types.js';
import type { CapabilityWarning } from './capabilities.js';
import type { ContextWindowUsage } from './context-window.js';

/**
 * Token accounting for one operation.
 *
 * `inputTokens` is the billed uncached input. Cached reads and writes are reported separately
 * because they are priced differently, and `reasoningTokens` is the share of `outputTokens` the
 * provider attributes to internal reasoning rather than to visible output.
 */
export interface TokenUsage {
  /** Billed input tokens that were not served from the provider's cache. */
  inputTokens: number;
  /** Output tokens, reasoning included. */
  outputTokens: number;
  /** Input tokens read from the provider's prompt cache, priced lower. */
  cachedReadTokens?: number;
  /** Input tokens written to the provider's prompt cache, priced higher on some providers. */
  cachedWriteTokens?: number;
  /** The part of `outputTokens` spent on internal reasoning. */
  reasoningTokens?: number;
  /** Every token counted. */
  totalTokens: number;
}

/**
 * Numeric cost of one operation.
 *
 * `basis` distinguishes a local estimate from a provider-reported figure. Bundled prices are
 * defaults, not financial truth; override them through `models.registry` when exact numbers matter.
 */
export interface ResponseCost {
  /** Total cost. */
  amount: number;
  /** Currency of every amount, such as `USD`. */
  currency: string;
  /** `estimated` from registry prices, or `reported` by the provider. */
  basis: 'estimated' | 'reported';
  /** Cost of uncached input. */
  input?: number;
  /** Cost of output. */
  output?: number;
  /** Cost of cache reads. */
  cachedRead?: number;
  /** Cost of cache writes. */
  cachedWrite?: number;
}

/**
 * How a completion was produced: provider, model, timing, tokens, cost, and every policy that
 * touched it.
 */
export interface ResponseMeta {
  /** The request's id. */
  requestId: string;
  /** Provider that answered. */
  providerUsed: string;
  /** Model that answered. */
  modelUsed: string;
  /** Duration in milliseconds. */
  latencyMs: number;
  /** Input tokens, as the provider reported them. */
  tokensInput: number;
  /** Output tokens, as the provider reported them. */
  tokensOutput: number;
  /** Tokens removed by optimization before the request was sent. */
  tokensSaved: number;
  /**
   * @deprecated Use `cost.amount`, which is numeric and carries a currency. This formatted string
   * is retained for compatibility and will be removed in the next major release.
   */
  estimatedCost: string;
  /** Full token breakdown, including cached and reasoning tokens when the provider reports them. */
  usage?: TokenUsage;
  /** Numeric cost, priced per token class. */
  cost?: ResponseCost;
  /** Options the target model could not honor as written, under a non-strict capability policy. */
  capabilityWarnings?: CapabilityWarning[];
  /** True when the response came from the response cache and no provider was called. */
  cacheHit: boolean;
  /** Guardrails and techniques applied, such as redaction, trimming, or a retry. */
  guardrailsApplied: string[];
  /** Why the router chose the provider, and how many fallbacks were available. */
  routingDecision?: {
    reason: string;
    fallbacksConsidered: number;
  };
  /** What context-window trimming did to the request. */
  contextWindow?: ContextWindowUsage;
  /** Grounding check of the answer against its sources, when verification ran. */
  verification?: {
    ok: boolean;
    supportRatio: number;
    factsChecked: number;
    unsupportedFacts: string[];
  };
  /** Per-stage timings of the request pipeline, when tracing of the pipeline is on. */
  pipeline?: PipelineTrace;
  /** Whether the semantic cache answered the request, and how similar the match was. */
  semanticCache?: {
    hit: boolean;
    score: number;
    key: string;
  };
}

/** A tool call the model made. */
export interface ToolCall {
  /** The provider's id for the call, which the tool result must carry back. */
  id: string;
  /** Always `function`. */
  type: 'function';
  /** The tool's name and its arguments as JSON text, unparsed. */
  function: {
    name: string;
    arguments: string;
  };
}

/** A completion. */
export interface NexusResponse {
  /** The model's text. Empty when it only called tools. */
  content: string;
  /** Always `assistant`. */
  role: 'assistant';
  /** Tool calls the model made. */
  toolCalls?: ToolCall[];
  /**
   * Why generation stopped: a natural end, tool calls, the token limit, a content filter, or an
   * error.
   */
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  /** How the completion was produced. */
  meta: ResponseMeta;
}

// ── Streaming ──────────────────────────────────────────────────────

/**
 * One streamed event.
 *
 * `'reasoning'` carries a reasoning summary and is deliberately separate from `'text'` so existing
 * consumers that switch on `type` keep receiving only visible output.
 */
export interface StreamChunk {
  /**
   * `text` for visible output, `reasoning` for a reasoning summary, `tool_call`, `done` once
   * complete, or `error`.
   */
  type: 'text' | 'reasoning' | 'tool_call' | 'done' | 'error';
  /** Text of a `text` or `reasoning` chunk. */
  content?: string;
  /** The call, for a `tool_call` chunk. */
  toolCall?: ToolCall;
  /** Metadata, filled in on the final chunk. */
  meta?: Partial<ResponseMeta>;
  /** What went wrong, for an `error` chunk. */
  error?: string;
}

/** A streamed completion: iterate it for chunks, or abort it. */
export interface NexusStream extends AsyncIterable<StreamChunk> {
  /** Iterates the chunks as they arrive. */
  [Symbol.asyncIterator](): AsyncIterator<StreamChunk>;
  /** Stops the stream and the provider request behind it. */
  abort(): void;
}
