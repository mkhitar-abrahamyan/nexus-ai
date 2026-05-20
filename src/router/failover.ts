import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse, NexusStream } from '../types/response.js';
import type { BaseProvider } from '../providers/base.js';
import type { RouteDecision } from './types.js';
import type { RetryConfig } from '../types/config.js';
import {
  NexusProviderError,
  createAbortProviderError,
  createTimeoutProviderError,
  categorizeProviderError,
  type NexusProviderErrorCategory,
} from '../providers/errors.js';

export interface ExecutionOptions {
  timeoutMs?: number;
  retry?: RetryConfig;
  onAttemptSuccess?: (providerName: string, latencyMs: number) => void;
  onAttemptFailure?: (providerName: string, error: unknown) => void;
}

export class FailoverExecutor {
  async complete(
    request: CompletionRequest,
    decision: RouteDecision,
    providers: Map<string, BaseProvider>,
    options: ExecutionOptions = {},
  ): Promise<NexusResponse> {
    const attempts = [{ providerName: decision.providerName, model: decision.model }, ...decision.fallbacks];
    const errors: string[] = [];
    const retry = this.mergeRetry(options.retry, request.retry);

    for (const attempt of attempts) {
      const provider = providers.get(attempt.providerName);
      if (!provider) continue;

      for (let retryIndex = 0; retryIndex <= retry.maxRetries; retryIndex += 1) {
        try {
          this.throwIfAborted(request.signal, attempt.providerName, attempt.model);
          const started = Date.now();
          const response = await this.withTimeout(
            provider.complete({ ...request, model: attempt.model }),
            request.timeoutMs || options.timeoutMs,
            request.signal,
            attempt.providerName,
            attempt.model,
          );
          options.onAttemptSuccess?.(attempt.providerName, Date.now() - started);
          response.meta.routingDecision = {
            reason: decision.reason,
            fallbacksConsidered: attempts.length - 1,
          };
          if (retryIndex > 0) {
            response.meta.guardrailsApplied.push(`provider-retry-${retryIndex}`);
          }
          return response;
        } catch (err) {
          options.onAttemptFailure?.(attempt.providerName, err);
          if (err instanceof NexusProviderError && err.category === 'abort') {
            throw err;
          }
          const message = `${attempt.providerName}/${attempt.model}: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(message);

          if (!this.shouldRetry(err, retry, retryIndex)) {
            break;
          }

          await this.delay(this.retryDelay(retry, retryIndex), request.signal);
        }
      }
    }

    throw new Error(`All routing attempts failed: ${errors.join(' | ')}`);
  }

  stream(
    request: CompletionRequest,
    decision: RouteDecision,
    providers: Map<string, BaseProvider>,
    options: ExecutionOptions = {},
  ): NexusStream {
    const self = this;
    const controller = this.createLinkedAbortController(request.signal);
    return {
      [Symbol.asyncIterator]() {
        const attempts = [{ providerName: decision.providerName, model: decision.model }, ...decision.fallbacks];
        return self.streamAttempts({ ...request, signal: controller.signal }, attempts, providers, options);
      },
      abort() {
        controller.abort();
      },
    };
  }

  private async *streamAttempts(
    request: CompletionRequest,
    attempts: Array<{ providerName: string; model: string }>,
    providers: Map<string, BaseProvider>,
    options: ExecutionOptions,
  ): AsyncGenerator<import('../types/response.js').StreamChunk> {
    const retry = this.mergeRetry(options.retry, request.retry);
    const errors: string[] = [];

    for (const attempt of attempts) {
      const provider = providers.get(attempt.providerName);
      if (!provider) continue;

      for (let retryIndex = 0; retryIndex <= retry.maxRetries; retryIndex += 1) {
        const started = Date.now();
        let emitted = false;
        try {
          this.throwIfAborted(request.signal, attempt.providerName, attempt.model);
          for await (const chunk of provider.stream({ ...request, model: attempt.model })) {
            if (chunk.type === 'error') throw new Error(chunk.error || 'stream error');
            emitted = emitted || chunk.type === 'text' || chunk.type === 'tool_call';
            yield chunk;
          }
          options.onAttemptSuccess?.(attempt.providerName, Date.now() - started);
          return;
        } catch (error) {
          options.onAttemptFailure?.(attempt.providerName, error);
          errors.push(`${attempt.providerName}/${attempt.model}: ${error instanceof Error ? error.message : String(error)}`);
          if (emitted || !this.shouldRetry(error, retry, retryIndex)) {
            break;
          }
          await this.delay(this.retryDelay(retry, retryIndex), request.signal);
        }
      }
    }

    yield { type: 'error', error: `All streaming attempts failed: ${errors.join(' | ')}` };
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
    providerName: string,
    model: string,
  ): Promise<T> {
    if ((!timeoutMs || timeoutMs <= 0) && !signal) return promise;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      if (timeoutMs && timeoutMs > 0) {
        timeout = setTimeout(() => reject(createTimeoutProviderError(providerName, model, timeoutMs)), timeoutMs);
      }
      if (signal) {
        abortListener = () => reject(createAbortProviderError(providerName, model, signal.reason));
        if (signal.aborted) abortListener();
        else signal.addEventListener('abort', abortListener, { once: true });
      }
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
    }
  }

  private mergeRetry(global?: RetryConfig, request?: CompletionRequest['retry']): Required<RetryConfig> {
    return {
      enabled: request?.enabled ?? global?.enabled ?? false,
      maxRetries: request?.maxRetries ?? global?.maxRetries ?? 1,
      baseDelayMs: request?.baseDelayMs ?? global?.baseDelayMs ?? 250,
      maxDelayMs: request?.maxDelayMs ?? global?.maxDelayMs ?? 2000,
      backoff: request?.backoff ?? global?.backoff ?? 'exponential',
      retryOn: global?.retryOn || ['timeout', 'rate-limit', 'server-error', 'network'],
    };
  }

  private shouldRetry(error: unknown, retry: Required<RetryConfig>, retryIndex: number): boolean {
    if (!retry.enabled || retryIndex >= retry.maxRetries) return false;
    if (error instanceof NexusProviderError && !error.retryable) return false;
    const category = this.categorizeError(error);
    return retry.retryOn.includes(category as Required<RetryConfig>['retryOn'][number]);
  }

  private categorizeError(error: unknown): NexusProviderErrorCategory {
    if (error instanceof NexusProviderError) return error.category;
    return categorizeProviderError(error);
  }

  private retryDelay(retry: Required<RetryConfig>, retryIndex: number): number {
    const multiplier = retry.backoff === 'exponential' ? 2 ** retryIndex : 1;
    return Math.min(retry.baseDelayMs * multiplier, retry.maxDelayMs);
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(createAbortProviderError('router', 'retry-delay', signal.reason));
    if (ms <= 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);
      const abort = () => {
        clearTimeout(timeout);
        cleanup();
        reject(createAbortProviderError('router', 'retry-delay', signal?.reason));
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private throwIfAborted(signal: AbortSignal | undefined, providerName: string, model: string): void {
    if (signal?.aborted) {
      throw createAbortProviderError(providerName, model, signal.reason);
    }
  }

  private createLinkedAbortController(signal?: AbortSignal): AbortController {
    const controller = new AbortController();
    if (!signal) return controller;

    if (signal.aborted) {
      controller.abort(signal.reason);
    } else {
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }

    return controller;
  }
}
