import type { CompletionRequest } from '../../types/messages.js';
import type { AgentMiddleware, AgentMiddlewareContext, AgentModelClient } from '../create-agent.js';
import { isCancellation } from './shared.js';

/** A model to fall back to: a model name for the agent's own client, or another client. */
export type ModelFallbackTarget = string | { client: AgentModelClient; model?: string };

/** One fallback about to happen. */
export interface ModelFallbackEvent {
  /** The model that failed. */
  from: string;
  /** The model tried next. */
  to: string;
  /** What the failed call threw. */
  error: unknown;
}

/** Options for `modelFallback()`. */
export interface ModelFallbackOptions {
  /** Whether an error moves on to the next model. Defaults to every error but a cancellation. */
  fallbackOn?: (error: unknown, model: string) => boolean;
  /** Called before each fallback, for logs and metrics. */
  onFallback?: (event: ModelFallbackEvent) => void;
}

/**
 * Tries other models, in order, when the model call fails.
 *
 * The client's router already falls back between providers for one request; this is the fallback
 * it cannot make: to a client of a different kind, or once the client's own routes are exhausted. A
 * target with its own client is called through `complete()`, never streamed, and middleware after
 * this one does not wrap it.
 */
export function modelFallback(
  models: readonly ModelFallbackTarget[],
  options: ModelFallbackOptions = {},
): AgentMiddleware {
  if (models.length === 0) throw new RangeError('modelFallback() needs at least one model to fall back to');
  return {
    name: 'model-fallback',
    async wrapModelCall(request, next, context) {
      try {
        return await next(request);
      } catch (first) {
        let error = first;
        let from = request.model;
        for (const target of models) {
          if (isCancellation(error, context.signal) || !(options.fallbackOn?.(error, from) ?? true)) throw error;
          const model = typeof target === 'string' ? target : (target.model ?? request.model);
          options.onFallback?.({ from, to: model, error });
          try {
            return typeof target === 'string'
              ? await next({ ...request, model })
              : await target.client.complete({ ...request, model });
          } catch (failure) {
            error = failure;
            from = model;
          }
        }
        throw error;
      }
    },
  };
}

/** What `dynamicModel()` decides from: the step's context and the request about to be sent. */
export type DynamicModelContext = AgentMiddlewareContext & { request: CompletionRequest };

/**
 * Chooses the model for each call from the run so far.
 *
 * A cheap model for the first steps and a stronger one once the task proves hard, a model with a
 * longer context once the transcript grows, or a tenant's own model. Returning nothing keeps the
 * model the request already names.
 *
 * ```ts
 * dynamicModel(({ state }) => (state.iterations >= 4 ? 'gpt-5' : 'gpt-5-mini'))
 * ```
 */
export function dynamicModel(
  select: (context: DynamicModelContext) => string | undefined | Promise<string | undefined>,
): AgentMiddleware {
  return {
    name: 'dynamic-model',
    async beforeModel(context) {
      const model = await select(context);
      if (!model || model === context.request.model) return;
      return { ...context.request, model };
    },
  };
}
