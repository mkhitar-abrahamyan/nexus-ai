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
 * A pipeline stage, as it appears in a trace: a hook point, a built-in stage, a lifecycle stage, or
 * `customStep` for a step added with `use()`, whose own name is in `PipelineTraceStep.custom`.
 *
 * The list is closed, so a `switch` over it can be exhaustive.
 */
export type PipelineStepName =
  | PipelineHookName
  | 'authorize'
  | 'responseFormat'
  | 'contextWindow'
  | 'tokenOptimization'
  | 'inputSecurity'
  | 'routing'
  | 'capabilityNegotiation'
  | 'costBudget'
  | 'reserveBudget'
  | 'cacheLookup'
  | 'providerCall'
  | 'outputSecurity'
  | 'responseValidation'
  | 'cacheWrite'
  | 'finalOutputSecurity'
  | 'reconcileCost'
  | 'audit'
  | 'customStep';

/** One timed stage of a request. */
export interface PipelineTraceStep {
  /** The stage. */
  name: PipelineStepName;
  /** The custom step's own name, when `name` is `customStep`. */
  custom?: string;
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

/**
 * The request as it moves through the pipeline, handed to every hook. Generic over the request and
 * response, so a family other than completions can run the same hooks over its own types; both
 * default to a completion.
 */
export interface PipelineContext<Req = CompletionRequest, Res = NexusResponse> {
  /** The request, as rewritten by earlier stages. */
  request: Req;
  /** The response, once the provider has answered. */
  response?: Res;
  /** The routing decision, once made. */
  route?: RouteDecision;
  /** What context-window trimming did, when it ran. */
  contextWindow?: ContextWindowResult<Req>;
  /** What token optimization did, when it ran. */
  optimization?: OptimizationResult<Req>;
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
export type PipelineMiddleware<Req = CompletionRequest, Res = NexusResponse> = (
  context: PipelineContext<Req, Res>,
) => undefined | PipelineContext<Req, Res> | Req | Res | Promise<undefined | PipelineContext<Req, Res> | Req | Res>;

/** A custom stage appended to the pipeline. */
export interface PipelineStep<Req = CompletionRequest, Res = NexusResponse> {
  /** The stage's name, recorded in traces as `custom` on a `customStep`. */
  name: string;
  /** What it does. */
  run: PipelineMiddleware<Req, Res>;
}

/** Hooks by point; several hooks at one point run in order. */
export type PipelineHooksConfig<Req = CompletionRequest, Res = NexusResponse> = Partial<
  Record<PipelineHookName, PipelineMiddleware<Req, Res> | PipelineMiddleware<Req, Res>[]>
>;

/** Hooks and tracing around every request. */
export interface PipelineConfig<Req = CompletionRequest, Res = NexusResponse> {
  /** Turns hooks on. */
  enabled?: boolean;
  /** Records a trace of every stage. */
  trace?: boolean;
  /** Attaches the trace to `response.meta.pipeline`. */
  includeTraceInResponse?: boolean;
  /** Hooks by point. */
  hooks?: PipelineHooksConfig<Req, Res>;
  /** Custom stages. */
  steps?: PipelineStep<Req, Res>[];
}

/**
 * How a runner tells what a hook returned, for a family other than completions: a replacement
 * request, a replacement response, or anything else, which is taken as a new context.
 */
export interface PipelineShapes<Req, Res> {
  /** True when a hook's return value is a request. */
  isRequest(value: unknown): value is Req;
  /** True when a hook's return value is a response. */
  isResponse(value: unknown): value is Res;
}
