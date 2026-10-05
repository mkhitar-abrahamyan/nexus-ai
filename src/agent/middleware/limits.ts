import type { AgentMiddleware } from '../create-agent.js';
import { modelCallsInTurn } from './shared.js';

/** Options for `modelCallLimit()`. Set `run`, `thread`, or both. */
export interface ModelCallLimitOptions {
  /** Model calls in one run: from a user message to the answer, a resumed approval included. */
  run?: number;
  /**
   * Model calls over a thread's whole life, every run on it included. Counted in the agent's store
   * when it has one, so every process shares the count and it survives a restart; otherwise in this
   * process. A budget, not a lock: two runs on one thread at the same moment may each pass it once.
   */
  thread?: number;
  /**
   * What happens at a limit: `end` answers with `message` and stops with `stopReason: 'stopped'`,
   * without calling the model; `error` fails the run with a `ModelCallLimitError`. Defaults to `end`.
   */
  onLimit?: 'end' | 'error';
  /** The answer a run ends with under `end`. Defaults to a sentence naming the limit. */
  message?: string;
}

/** Thrown by `modelCallLimit()` under `onLimit: 'error'`. */
export class ModelCallLimitError extends Error {
  /** Always `MODEL_CALL_LIMIT`. */
  readonly code = 'MODEL_CALL_LIMIT';

  constructor(
    /** Which limit was reached. */
    readonly scope: 'run' | 'thread',
    /** The limit. */
    readonly limit: number,
  ) {
    super(`The agent reached its limit of ${limit} model calls per ${scope}`);
    this.name = 'ModelCallLimitError';
  }
}

const NAMESPACE = ['nexus', 'agent', 'model-calls'];

/**
 * Caps the model calls of a run, of a thread, or both.
 *
 * `maxIterations` stops one run that keeps calling tools; this is a budget an application sets per
 * run and per conversation, so a thread a user keeps coming back to cannot spend without bound. The
 * run count is read from the transcript, so it survives a restart. A run that reaches a limit ends
 * with an answer rather than an error, unless you ask for one.
 */
export function modelCallLimit(options: ModelCallLimitOptions): AgentMiddleware {
  if (options.run === undefined && options.thread === undefined) {
    throw new RangeError('modelCallLimit() needs a run limit, a thread limit, or both');
  }
  const local = new Map<string, number>();
  return {
    name: 'model-call-limit',
    async wrapModelCall(request, next, context) {
      let reached: ['run' | 'thread', number] | undefined;
      if (options.run !== undefined && modelCallsInTurn(context.state.messages) >= options.run) {
        reached = ['run', options.run];
      }
      let used = 0;
      if (!reached && options.thread !== undefined) {
        used = context.store
          ? ((await context.store.get<number>(NAMESPACE, context.threadId))?.value ?? 0)
          : (local.get(context.threadId) ?? 0);
        if (used >= options.thread) reached = ['thread', options.thread];
      }
      if (reached) {
        const [scope, limit] = reached;
        if (options.onLimit === 'error') throw new ModelCallLimitError(scope, limit);
        return context.stop(
          options.message ?? `I stopped here: this ${scope} reached its limit of ${limit} model calls.`,
        );
      }
      if (options.thread !== undefined) {
        if (context.store) await context.store.put(NAMESPACE, context.threadId, used + 1);
        else {
          local.set(context.threadId, used + 1);
          if (local.size > 10_000) local.delete(local.keys().next().value as string);
        }
      }
      return next(request);
    },
  };
}
