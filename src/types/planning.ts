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
  totalCost: number;
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
