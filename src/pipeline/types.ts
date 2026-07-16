import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import type { RouteDecision } from '../router/types.js';
import type { ContextWindowResult } from '../types/context-window.js';
import type { OptimizationResult } from '../types/optimizer.js';
import type { SecurityFinding } from '../types/security.js';

export type PipelineHookName = 'beforeInput' | 'afterSecurity' | 'beforeProvider' | 'afterProvider' | 'beforeReturn';

export type PipelineStepName =
  | PipelineHookName
  | 'responseFormat'
  | 'contextWindow'
  | 'tokenOptimization'
  | 'inputSecurity'
  | 'routing'
  | 'costBudget'
  | 'cacheLookup'
  | 'providerCall'
  | 'outputSecurity'
  | 'responseValidation'
  | 'cacheWrite'
  | 'auditLog'
  | string;

export interface PipelineTraceStep {
  name: PipelineStepName;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  ok: boolean;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface PipelineTrace {
  requestId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  steps: PipelineTraceStep[];
}

export interface PipelineContext {
  request: CompletionRequest;
  response?: NexusResponse;
  route?: RouteDecision;
  contextWindow?: ContextWindowResult<CompletionRequest>;
  optimization?: OptimizationResult<CompletionRequest>;
  securityFindings: SecurityFinding[];
  guardrailsApplied: string[];
  metadata: Record<string, unknown>;
  trace: PipelineTrace;
}

export type PipelineMiddleware = (
  context: PipelineContext,
) =>
  | undefined
  | PipelineContext
  | CompletionRequest
  | NexusResponse
  | Promise<undefined | PipelineContext | CompletionRequest | NexusResponse>;

export interface PipelineStep {
  name: PipelineStepName;
  run: PipelineMiddleware;
}

export type PipelineHooksConfig = Partial<Record<PipelineHookName, PipelineMiddleware | PipelineMiddleware[]>>;

export interface PipelineConfig {
  enabled?: boolean;
  trace?: boolean;
  includeTraceInResponse?: boolean;
  hooks?: PipelineHooksConfig;
  steps?: PipelineStep[];
}
