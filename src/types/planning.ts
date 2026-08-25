import type { RouteDecision } from '../router/types.js';
import type { ContextWindowUsage } from './context-window.js';
import type { TokenUsageSnapshot } from './optimizer.js';
import type { SecurityFinding } from './security.js';

export interface CostEstimate {
  model: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  /** Tokens served from a provider prompt cache, priced at the cached-read rate. */
  cachedReadTokens?: number;
  /** Tokens written into a provider prompt cache, priced at the cache-write rate. */
  cachedWriteTokens?: number;
  cachedReadCost?: number;
  cachedWriteCost?: number;
  totalCost: number;
  currency?: string;
  formatted: string;
}

export interface NexusPlan {
  requestModel: string;
  providerName: string;
  model: string;
  route: RouteDecision;
  contextWindow?: ContextWindowUsage;
  tokenUsage: TokenUsageSnapshot;
  estimatedCost: CostEstimate;
  maxContextTokens?: number;
  fitsContext: boolean;
  cacheEligible: boolean;
  wouldBlock: boolean;
  securityFindings: SecurityFinding[];
  warnings: string[];
  guardrailsApplied: string[];
}
