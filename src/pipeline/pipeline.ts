import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import type {
  PipelineConfig,
  PipelineContext,
  PipelineHookName,
  PipelineMiddleware,
  PipelineShapes,
  PipelineStep,
  PipelineStepName,
} from './types.js';

/** How a completion's request and response are told apart from a context a hook returns. */
const COMPLETION_SHAPES: PipelineShapes<CompletionRequest, NexusResponse> = {
  isRequest: (value): value is CompletionRequest =>
    typeof value === 'object' && value !== null && 'messages' in value && 'model' in value,
  isResponse: (value): value is NexusResponse =>
    typeof value === 'object' && value !== null && 'content' in value && 'role' in value && 'meta' in value,
};

/**
 * Runs the request pipeline's hooks and custom steps, and times each stage into the request's
 * trace. Generic over the request and response; without `shapes` it runs a completion's.
 */
export class PipelineRunner<Req = CompletionRequest, Res = NexusResponse> {
  private steps: PipelineStep<Req, Res>[] = [];
  private readonly shapes: PipelineShapes<Req, Res>;

  constructor(
    private config: PipelineConfig<Req, Res> = {},
    shapes?: PipelineShapes<Req, Res>,
  ) {
    this.shapes = shapes ?? (COMPLETION_SHAPES as unknown as PipelineShapes<Req, Res>);
    for (const step of config.steps || []) {
      this.use(step);
    }
  }

  /** Adds a custom step, run after the built-in stages. Returns the runner, for chaining. */
  use(step: PipelineStep<Req, Res>): this {
    this.steps.push(step);
    return this;
  }

  /** Runs every handler registered for a hook, in order. */
  async runHook(name: PipelineHookName, context: PipelineContext<Req, Res>): Promise<PipelineContext<Req, Res>> {
    if (this.config.enabled === false) return context;

    const handlers = this.handlersForHook(name);
    let next = context;
    for (const handler of handlers) {
      next = await this.runMiddleware(name, handler, next);
    }
    return next;
  }

  /** Runs the custom steps, in order. */
  async runCustomSteps(context: PipelineContext<Req, Res>): Promise<PipelineContext<Req, Res>> {
    if (this.config.enabled === false) return context;

    let next = context;
    for (const step of this.steps) {
      next = await this.runMiddleware('customStep', step.run, next, step.name);
    }
    return next;
  }

  /**
   * Runs one stage and records its timing, unless tracing is off. `custom` names a custom step,
   * recorded with `name` set to `customStep`.
   */
  async trace<T>(
    context: PipelineContext<Req, Res>,
    name: PipelineStepName,
    fn: () => T | Promise<T>,
    metadata?: Record<string, unknown>,
    custom?: string,
  ): Promise<T> {
    if (this.config.trace === false) {
      return await fn();
    }

    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    try {
      const result = await fn();
      const ended = Date.now();
      context.trace.steps.push({
        name,
        ...(custom !== undefined ? { custom } : {}),
        startedAt,
        endedAt: new Date(ended).toISOString(),
        durationMs: ended - started,
        ok: true,
        metadata,
      });
      return result;
    } catch (error) {
      const ended = Date.now();
      context.trace.steps.push({
        name,
        ...(custom !== undefined ? { custom } : {}),
        startedAt,
        endedAt: new Date(ended).toISOString(),
        durationMs: ended - started,
        ok: false,
        metadata,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /** Stamps the trace's end time and duration. */
  finish(context: PipelineContext<Req, Res>): PipelineContext<Req, Res> {
    const ended = Date.now();
    context.trace.endedAt = new Date(ended).toISOString();
    context.trace.durationMs = ended - Date.parse(context.trace.startedAt);
    return context;
  }

  private async runMiddleware(
    name: PipelineStepName,
    handler: PipelineMiddleware<Req, Res>,
    context: PipelineContext<Req, Res>,
    custom?: string,
  ): Promise<PipelineContext<Req, Res>> {
    return this.trace(
      context,
      name,
      async () => {
        const result = await handler(context);
        if (!result) return context;
        if (this.shapes.isRequest(result)) {
          context.request = result;
          return context;
        }
        if (this.shapes.isResponse(result)) {
          context.response = result;
          return context;
        }
        return result as PipelineContext<Req, Res>;
      },
      undefined,
      custom,
    );
  }

  private handlersForHook(name: PipelineHookName): PipelineMiddleware<Req, Res>[] {
    const hook = this.config.hooks?.[name];
    if (!hook) return [];
    return Array.isArray(hook) ? hook : [hook];
  }
}

/** A fresh pipeline context for a request. */
export function createPipelineContext<Req = CompletionRequest, Res = NexusResponse>(
  request: Req,
): PipelineContext<Req, Res> {
  return {
    request,
    securityFindings: [],
    guardrailsApplied: [],
    metadata: {},
    trace: {
      startedAt: new Date().toISOString(),
      steps: [],
    },
  };
}
