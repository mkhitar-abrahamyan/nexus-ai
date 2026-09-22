import type { RouteDecision } from '../router/types.js';
import type { ContextWindowUsage } from './context-window.js';
import type { TokenUsageSnapshot } from './optimizer.js';
import type { SecurityFinding } from './security.js';

/** What a request is estimated to cost, before it is sent. */
export interface CostEstimate {
  /** Model the estimate is for. */
  model: string;
  /** Estimated input tokens. */
  inputTokens: number;
  /** Estimated output tokens. */
  outputTokens: number;
  /** Cost of the input. */
  inputCost: number;
  /** Cost of the output. */
  outputCost: number;
  /** Tokens served from a provider prompt cache, priced at the cached-read rate. */
  cachedReadTokens?: number;
  /** Tokens written into a provider prompt cache, priced at the cache-write rate. */
  cachedWriteTokens?: number;
  /** Cost of cached reads. */
  cachedReadCost?: number;
  /** Cost of cache writes. */
  cachedWriteCost?: number;
  /** Total estimated cost. */
  totalCost: number;
  /** Currency of every amount. */
  currency?: string;
  /** The total as display text. */
  formatted: string;
}

/**
 * What `ai.plan()` says a request would do, without sending it: the route, the tokens, the cost,
 * and whether guardrails would block it.
 */
export interface NexusPlan {
  /** The model the request asked for. */
  requestModel: string;
  /** Provider it would go to. */
  providerName: string;
  /** Model it would use. */
  model: string;
  /** The full routing decision, fallbacks included. */
  route: RouteDecision;
  /** What context-window trimming would do. */
  contextWindow?: ContextWindowUsage;
  /** Tokens before and after optimization. */
  tokenUsage: TokenUsageSnapshot;
  /** Estimated cost. */
  estimatedCost: CostEstimate;
  /** The chosen model's context window. */
  maxContextTokens?: number;
  /** Whether the request fits that window. */
  fitsContext: boolean;
  /** Whether the response cache could answer it. */
  cacheEligible: boolean;
  /** Whether input guardrails would block it. */
  wouldBlock: boolean;
  /** What input guardrails found. */
  securityFindings: SecurityFinding[];
  /** Anything the caller should know before sending it. */
  warnings: string[];
  /** Guardrails and techniques that would apply. */
  guardrailsApplied: string[];
}
