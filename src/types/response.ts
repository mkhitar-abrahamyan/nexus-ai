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
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
}

/**
 * Numeric cost of one operation.
 *
 * `basis` distinguishes a local estimate from a provider-reported figure. Bundled prices are
 * defaults, not financial truth; override them through `models.registry` when exact numbers matter.
 */
export interface ResponseCost {
  amount: number;
  currency: string;
  basis: 'estimated' | 'reported';
  input?: number;
  output?: number;
  cachedRead?: number;
  cachedWrite?: number;
}

export interface ResponseMeta {
  requestId: string;
  providerUsed: string;
  modelUsed: string;
  latencyMs: number;
  tokensInput: number;
  tokensOutput: number;
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
  cacheHit: boolean;
  guardrailsApplied: string[];
  routingDecision?: {
    reason: string;
    fallbacksConsidered: number;
  };
  contextWindow?: ContextWindowUsage;
  verification?: {
    ok: boolean;
    supportRatio: number;
    factsChecked: number;
    unsupportedFacts: string[];
  };
  pipeline?: PipelineTrace;
  semanticCache?: {
    hit: boolean;
    score: number;
    key: string;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface NexusResponse {
  content: string;
  role: 'assistant';
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
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
  type: 'text' | 'reasoning' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  meta?: Partial<ResponseMeta>;
  error?: string;
}

export interface NexusStream extends AsyncIterable<StreamChunk> {
  [Symbol.asyncIterator](): AsyncIterator<StreamChunk>;
  abort(): void;
}
