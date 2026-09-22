import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import type { RouteDecision } from '../router/types.js';
import type { ContextWindowResult } from '../types/context-window.js';
import type { OptimizationResult } from '../types/optimizer.js';
import type { SecurityFinding } from '../types/security.js';

/**
 * Points in a request's pipeline where application hooks run: before input processing, after
 * security, around the provider call, and before the response returns.
 */
export type PipelineHookName = 'beforeInput' | 'afterSecurity' | 'beforeProvider' | 'afterProvider' | 'beforeReturn';

/**
 * A pipeline stage, as it appears in a trace: a hook point, one of the built-in stages, or a custom
 * step's name.
 */
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

/** One timed stage of a request. */
export interface PipelineTraceStep {
  /** The stage. */
  name: PipelineStepName;
  /** ISO-8601 start time. */
  startedAt: string;
  /** ISO-8601 end time. */
  endedAt: string;
  /** Duration in milliseconds. */
  durationMs: number;
  /** False when the stage threw. */
  ok: boolean;
  /** Stage-specific details. */
  metadata?: Record<string, unknown>;
  /** Why the stage failed, when it did. */
  error?: string;
}

/** Every stage a request went through, with timings. */
export interface PipelineTrace {
  /** The request's id. */
  requestId?: string;
  /** ISO-8601 start time. */
  startedAt: string;
  /** ISO-8601 end time. */
  endedAt?: string;
  /** Total duration in milliseconds. */
  durationMs?: number;
  /** Stages, in the order they ran. */
  steps: PipelineTraceStep[];
}

/** The request as it moves through the pipeline, handed to every hook. */
export interface PipelineContext {
  /** The request, as rewritten by earlier stages. */
  request: CompletionRequest;
  /** The response, once the provider has answered. */
  response?: NexusResponse;
  /** The routing decision, once made. */
  route?: RouteDecision;
  /** What context-window trimming did, when it ran. */
  contextWindow?: ContextWindowResult<CompletionRequest>;
  /** What token optimization did, when it ran. */
  optimization?: OptimizationResult<CompletionRequest>;
  /** Security findings so far. */
  securityFindings: SecurityFinding[];
  /** Guardrails and techniques applied so far. */
  guardrailsApplied: string[];
  /** Scratch space shared between hooks. */
  metadata: Record<string, unknown>;
  /** Timings recorded so far. */
  trace: PipelineTrace;
}

/**
 * A hook: inspects the context, and may return a new context, a replacement request, a replacement
 * response, or nothing to leave it unchanged.
 */
export type PipelineMiddleware = (
  context: PipelineContext,
) =>
  | undefined
  | PipelineContext
  | CompletionRequest
  | NexusResponse
  | Promise<undefined | PipelineContext | CompletionRequest | NexusResponse>;

/** A custom stage appended to the pipeline. */
export interface PipelineStep {
  /** The stage's name, as it appears in traces. */
  name: PipelineStepName;
  /** What it does. */
  run: PipelineMiddleware;
}

/** Hooks by point; several hooks at one point run in order. */
export type PipelineHooksConfig = Partial<Record<PipelineHookName, PipelineMiddleware | PipelineMiddleware[]>>;

/** Hooks and tracing around every request. */
export interface PipelineConfig {
  /** Turns hooks on. */
  enabled?: boolean;
  /** Records a trace of every stage. */
  trace?: boolean;
  /** Attaches the trace to `response.meta.pipeline`. */
  includeTraceInResponse?: boolean;
  /** Hooks by point. */
  hooks?: PipelineHooksConfig;
  /** Custom stages. */
  steps?: PipelineStep[];
}
