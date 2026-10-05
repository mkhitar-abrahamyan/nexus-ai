import type { NexusResponse } from '../../types/response.js';
import { isSensitiveCapability } from '../capabilities.js';
import type { AgentMiddleware, AgentToolCall, AgentToolResult } from '../create-agent.js';
import { backoffDelay, isCancellation, type RetryBackoff, sleep } from './shared.js';

/** One retry about to happen. */
export interface RetryEvent {
  /** The attempt that failed, from 1. */
  attempt: number;
  /** How long until the next attempt, in milliseconds. */
  delayMs: number;
  /** The error a model call threw, when it threw. */
  error?: unknown;
  /** The failed tool call's result, for a tool retry. */
  result?: AgentToolResult;
  /** The tool's name, for a tool retry. */
  tool?: string;
}

/** Options for `modelRetry()`. */
export interface ModelRetryOptions {
  /** Attempts in all, the first included. Defaults to 3. */
  attempts?: number;
  /** How long to wait between attempts. */
  backoff?: RetryBackoff;
  /**
   * Whether an error is worth another attempt. Defaults to every error not marked
   * `retryable: false`, such as a provider's authentication error, and never a cancellation.
   */
  retryOn?: (error: unknown, attempt: number) => boolean;
  /** Whether a response that did arrive is tried again, such as an empty one. Defaults to never. */
  retryResponse?: (response: NexusResponse, attempt: number) => boolean;
  /** Called before each new attempt, for logs and metrics. */
  onRetry?: (event: RetryEvent) => void;
}

/**
 * Tries a failed model call again, with exponential backoff.
 *
 * The client already retries one provider request; this retries the agent's step as a whole, after
 * the client gave up, and can retry a response that arrived but is unusable. A streamed call that
 * fails halfway streams again from the start. Waits stop when the run is cancelled.
 */
export function modelRetry(options: ModelRetryOptions = {}): AgentMiddleware {
  const attempts = Math.max(1, options.attempts ?? 3);
  const retryOn = options.retryOn ?? ((error) => (error as { retryable?: unknown })?.retryable !== false);
  return {
    name: 'model-retry',
    async wrapModelCall(request, next, context) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          const response = await next(request);
          if (attempt < attempts && options.retryResponse?.(response, attempt)) {
            const delayMs = backoffDelay(attempt, options.backoff);
            options.onRetry?.({ attempt, delayMs });
            await sleep(delayMs, context.signal);
            continue;
          }
          return response;
        } catch (error) {
          if (attempt >= attempts || isCancellation(error, context.signal) || !retryOn(error, attempt)) throw error;
          const delayMs = backoffDelay(attempt, options.backoff);
          options.onRetry?.({ attempt, delayMs, error });
          await sleep(delayMs, context.signal);
        }
      }
    },
  };
}

/** Options for `toolRetry()`. */
export interface ToolRetryOptions {
  /** Attempts in all, the first included. Defaults to 3. */
  attempts?: number;
  /** How long to wait between attempts. */
  backoff?: RetryBackoff;
  /**
   * Which calls may run again: tool names, `'all'`, or a function of the call. Defaults to calls
   * that are safe to repeat, whose tool declares capabilities and none of them writes, runs a
   * command or code, reaches the network, or is the application's own. A call that may already have
   * changed something is retried only when you say so.
   */
  tools?: readonly string[] | 'all' | ((call: AgentToolCall) => boolean);
  /** Whether a result is a failure worth another attempt. Defaults to any result with `ok: false`. */
  retryOn?: (result: AgentToolResult, call: AgentToolCall, attempt: number) => boolean;
  /** Called before each new attempt, for logs and metrics. */
  onRetry?: (event: RetryEvent) => void;
}

/**
 * Runs a failed tool call again, with exponential backoff.
 *
 * By default only a call that cannot have changed anything is repeated: retrying a payment or a
 * write that timed out after it landed would do it twice. Name the tools that are idempotent to
 * retry those too.
 */
export function toolRetry(options: ToolRetryOptions = {}): AgentMiddleware {
  const attempts = Math.max(1, options.attempts ?? 3);
  const retryOn = options.retryOn ?? ((result) => !result.ok);
  const eligible = (call: AgentToolCall): boolean => {
    const tools = options.tools;
    if (tools === 'all') return true;
    if (typeof tools === 'function') return tools(call);
    if (tools) return tools.includes(call.name);
    return call.capabilities !== undefined && !call.capabilities.some(isSensitiveCapability);
  };
  return {
    name: 'tool-retry',
    async wrapToolCall(call, next, context) {
      if (!eligible(call)) return next();
      for (let attempt = 1; ; attempt += 1) {
        const result = await next();
        if (attempt >= attempts || context.signal.aborted || !retryOn(result, call, attempt)) return result;
        const delayMs = backoffDelay(attempt, options.backoff);
        options.onRetry?.({ attempt, delayMs, result, tool: call.name });
        await sleep(delayMs, context.signal);
      }
    },
  };
}
