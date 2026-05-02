import type {
  PipelineConfig,
  PipelineContext,
  PipelineHookName,
  PipelineMiddleware,
  PipelineStep,
  PipelineStepName,
} from './types.js';

export class PipelineRunner {
  private steps: PipelineStep[] = [];

  constructor(private config: PipelineConfig = {}) {
    for (const step of config.steps || []) {
      this.use(step);
    }
  }

  use(step: PipelineStep): this {
    this.steps.push(step);
    return this;
  }

  async runHook(name: PipelineHookName, context: PipelineContext): Promise<PipelineContext> {
    if (this.config.enabled === false) return context;

    const handlers = this.handlersForHook(name);
    let next = context;
    for (const handler of handlers) {
      next = await this.runMiddleware(name, handler, next);
    }
    return next;
  }

  async runCustomSteps(context: PipelineContext): Promise<PipelineContext> {
    if (this.config.enabled === false) return context;

    let next = context;
    for (const step of this.steps) {
      next = await this.runMiddleware(step.name, step.run, next);
    }
    return next;
  }

  async trace<T>(
    context: PipelineContext,
    name: PipelineStepName,
    fn: () => T | Promise<T>,
    metadata?: Record<string, unknown>,
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

  finish(context: PipelineContext): PipelineContext {
    const ended = Date.now();
    context.trace.endedAt = new Date(ended).toISOString();
    context.trace.durationMs = ended - Date.parse(context.trace.startedAt);
    return context;
  }

  private async runMiddleware(
    name: PipelineStepName,
    handler: PipelineMiddleware,
    context: PipelineContext,
  ): Promise<PipelineContext> {
    return this.trace(context, name, async () => {
      const result = await handler(context);
      if (!result) return context;
      if ('messages' in result && 'model' in result) {
        context.request = result;
        return context;
      }
      if ('content' in result && 'role' in result && 'meta' in result) {
        context.response = result;
        return context;
      }
      return result as PipelineContext;
    });
  }

  private handlersForHook(name: PipelineHookName): PipelineMiddleware[] {
    const hook = this.config.hooks?.[name];
    if (!hook) return [];
    return Array.isArray(hook) ? hook : [hook];
  }
}

export function createPipelineContext(request: import('../types/messages.js').CompletionRequest): PipelineContext {
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
