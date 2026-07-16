import type { BaseProvider } from '../providers/base.js';
import {
  categorizeProviderError,
  createAbortProviderError,
  createTimeoutProviderError,
  NexusProviderError,
  type NexusProviderErrorCategory,
} from '../providers/errors.js';
import type { RetryConfig } from '../types/config.js';
import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../types/response.js';
import type { RouteDecision } from './types.js';

const ABORT_SETTLE_GRACE_MS = 100;

interface AttemptContext {
  signal: AbortSignal;
  cancellationError(): NexusProviderError | undefined;
  cleanup(): void;
}

interface LinkedAbortController {
  controller: AbortController;
  cleanup(): void;
}

class UnsettledProviderAttemptError extends NexusProviderError {}

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
    const timeoutMs = this.resolveTimeout(request.timeoutMs, options.timeoutMs);

    attemptsLoop: for (const attempt of attempts) {
      const provider = providers.get(attempt.providerName);
      if (!provider) continue;

      for (let retryIndex = 0; retryIndex <= retry.maxRetries; retryIndex += 1) {
        let context: AttemptContext | undefined;
        try {
          this.throwIfAborted(request.signal, attempt.providerName, attempt.model);
          context = this.createAttemptContext(request.signal, timeoutMs, attempt.providerName, attempt.model);
          const started = Date.now();
          const providerPromise = Promise.resolve(
            provider.complete({
              ...request,
              model: attempt.model,
              signal: context.signal,
            }),
          );
          const response = await this.waitForCompletion(providerPromise, context, attempt.providerName, attempt.model);
          options.onAttemptSuccess?.(attempt.providerName, Date.now() - started);
          response.meta.routingDecision = {
            reason: decision.reason,
            fallbacksConsidered: attempts.length - 1,
          };
          if (retryIndex > 0) {
            response.meta.guardrailsApplied.push(`provider-retry-${retryIndex}`);
          }
          return response;
        } catch (caught) {
          const error = caught instanceof NexusProviderError ? caught : (context?.cancellationError() ?? caught);
          options.onAttemptFailure?.(attempt.providerName, error);
          if (error instanceof NexusProviderError && error.category === 'abort') {
            throw error;
          }
          const message = `${attempt.providerName}/${attempt.model}: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(message);

          if (error instanceof UnsettledProviderAttemptError) {
            break attemptsLoop;
          }
          if (!this.shouldRetry(error, retry, retryIndex)) {
            break;
          }
        } finally {
          context?.cleanup();
        }

        await this.delay(this.retryDelay(retry, retryIndex), request.signal);
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
    const linked = this.createLinkedAbortController(request.signal);
    const abortLinked = (reason?: unknown) => {
      if (!linked.controller.signal.aborted) linked.controller.abort(reason);
      linked.cleanup();
    };
    return {
      [Symbol.asyncIterator]() {
        const iterator = (async function* () {
          const attempts = [{ providerName: decision.providerName, model: decision.model }, ...decision.fallbacks];
          try {
            yield* self.streamAttempts({ ...request, signal: linked.controller.signal }, attempts, providers, options);
          } finally {
            linked.cleanup();
          }
        })();
        return {
          next: () => iterator.next(),
          return: () => {
            abortLinked('stream consumer stopped');
            return iterator.return();
          },
          throw: (error?: unknown) => {
            abortLinked(error);
            return iterator.throw(error);
          },
        };
      },
      abort() {
        abortLinked();
      },
    };
  }

  private async *streamAttempts(
    request: CompletionRequest,
    attempts: Array<{ providerName: string; model: string }>,
    providers: Map<string, BaseProvider>,
    options: ExecutionOptions,
  ): AsyncGenerator<StreamChunk> {
    const retry = this.mergeRetry(options.retry, request.retry);
    const timeoutMs = this.resolveTimeout(request.timeoutMs, options.timeoutMs);
    const errors: string[] = [];

    attemptsLoop: for (const attempt of attempts) {
      const provider = providers.get(attempt.providerName);
      if (!provider) continue;

      for (let retryIndex = 0; retryIndex <= retry.maxRetries; retryIndex += 1) {
        const started = Date.now();
        let emitted = false;
        let completed = false;
        let stopped = false;
        let context: AttemptContext | undefined;
        let providerStream: NexusStream | undefined;
        let iterator: AsyncIterator<StreamChunk> | undefined;
        let pendingNext: Promise<IteratorResult<StreamChunk>> | undefined;
        let abortProviderStream: (() => void) | undefined;
        let attemptError: unknown;

        try {
          this.throwIfAborted(request.signal, attempt.providerName, attempt.model);
          context = this.createAttemptContext(request.signal, timeoutMs, attempt.providerName, attempt.model);
          providerStream = provider.stream({
            ...request,
            model: attempt.model,
            signal: context.signal,
          });
          abortProviderStream = () => this.abortProviderStream(providerStream);
          context.signal.addEventListener('abort', abortProviderStream, { once: true });
          iterator = providerStream[Symbol.asyncIterator]();

          while (true) {
            const cancellation = context.cancellationError();
            if (cancellation) throw cancellation;

            pendingNext = Promise.resolve(iterator.next());
            const result = await this.waitForAttempt(pendingNext, context);
            pendingNext = undefined;
            if (result.done) {
              completed = true;
              options.onAttemptSuccess?.(attempt.providerName, Date.now() - started);
              return;
            }

            const chunk = result.value;
            if (chunk.type === 'error') throw new Error(chunk.error || 'stream error');
            emitted = emitted || chunk.type === 'text' || chunk.type === 'tool_call';
            yield chunk;
          }
        } catch (caught) {
          const cancellation = context?.cancellationError();
          attemptError = caught instanceof NexusProviderError ? caught : (cancellation ?? caught);
          const settled = await this.stopProviderStream(providerStream, iterator, pendingNext);
          stopped = true;
          if (!settled) {
            attemptError = this.createUnsettledAttemptError(attemptError, attempt.providerName, attempt.model);
          }
        } finally {
          if (!completed && !stopped) {
            await this.stopProviderStream(providerStream, iterator, pendingNext);
          }
          if (context && abortProviderStream) {
            context.signal.removeEventListener('abort', abortProviderStream);
          }
          context?.cleanup();
        }

        if (attemptError === undefined) return;
        options.onAttemptFailure?.(attempt.providerName, attemptError);

        if (attemptError instanceof NexusProviderError && attemptError.category === 'abort') {
          return;
        }

        errors.push(
          `${attempt.providerName}/${attempt.model}: ${attemptError instanceof Error ? attemptError.message : String(attemptError)}`,
        );

        if (attemptError instanceof UnsettledProviderAttemptError) break attemptsLoop;
        if (emitted) break attemptsLoop;
        if (!this.shouldRetry(attemptError, retry, retryIndex)) break;

        try {
          await this.delay(this.retryDelay(retry, retryIndex), request.signal);
        } catch (error) {
          if (error instanceof NexusProviderError && error.category === 'abort') return;
          throw error;
        }
      }
    }

    yield { type: 'error', error: `All streaming attempts failed: ${errors.join(' | ')}` };
  }

  private async waitForCompletion<T>(
    providerPromise: Promise<T>,
    context: AttemptContext,
    providerName: string,
    model: string,
  ): Promise<T> {
    try {
      return await this.waitForAttempt(providerPromise, context);
    } catch (error) {
      const cancellation = context.cancellationError();
      if (!cancellation) throw error;

      if (cancellation.category === 'timeout') {
        const settled = await this.waitForSettlement(providerPromise);
        if (!settled) {
          throw this.createUnsettledAttemptError(cancellation, providerName, model);
        }
      }

      throw cancellation;
    }
  }

  private waitForAttempt<T>(promise: Promise<T>, context: AttemptContext): Promise<T> {
    const existingCancellation = context.cancellationError();
    if (existingCancellation) return Promise.reject(existingCancellation);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => {
        finish(() =>
          reject(context.cancellationError() ?? createAbortProviderError('router', 'attempt', context.signal.reason)),
        );
      };

      context.signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(context.cancellationError() ?? error)),
      );
    });
  }

  private createAttemptContext(
    parentSignal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    providerName: string,
    model: string,
  ): AttemptContext {
    const controller = new AbortController();
    let cancellation: NexusProviderError | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cancel = (error: NexusProviderError) => {
      if (controller.signal.aborted) return;
      cancellation = error;
      controller.abort(error);
    };
    const cancelFromParent = () => {
      cancel(createAbortProviderError(providerName, model, parentSignal?.reason));
    };

    if (parentSignal?.aborted) {
      cancelFromParent();
    } else {
      parentSignal?.addEventListener('abort', cancelFromParent, { once: true });
      if (timeoutMs !== undefined) {
        timeout = setTimeout(() => {
          cancel(createTimeoutProviderError(providerName, model, timeoutMs));
        }, timeoutMs);
      }
    }

    return {
      signal: controller.signal,
      cancellationError: () => cancellation,
      cleanup: () => {
        if (timeout) clearTimeout(timeout);
        parentSignal?.removeEventListener('abort', cancelFromParent);
      },
    };
  }

  private async stopProviderStream(
    stream: NexusStream | undefined,
    iterator: AsyncIterator<StreamChunk> | undefined,
    pendingNext: Promise<IteratorResult<StreamChunk>> | undefined,
  ): Promise<boolean> {
    this.abortProviderStream(stream);

    if (pendingNext && !(await this.waitForSettlement(pendingNext))) {
      return false;
    }

    if (!iterator?.return) return true;
    let closePromise: Promise<IteratorResult<StreamChunk>>;
    try {
      closePromise = Promise.resolve(iterator.return());
    } catch {
      return true;
    }
    return this.waitForSettlement(closePromise);
  }

  private abortProviderStream(stream: NexusStream | undefined): void {
    try {
      stream?.abort();
    } catch {
      // Cancellation is best effort; the linked AbortSignal remains authoritative.
    }
  }

  private waitForSettlement(promise: Promise<unknown>): Promise<boolean> {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (settled: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        resolve(settled);
      };
      const timeout = setTimeout(() => finish(false), ABORT_SETTLE_GRACE_MS);
      promise.then(
        () => finish(true),
        () => finish(true),
      );
    });
  }

  private createUnsettledAttemptError(
    error: unknown,
    providerName: string,
    model: string,
  ): UnsettledProviderAttemptError {
    const category = this.categorizeError(error);
    const message = error instanceof Error ? error.message : String(error);
    return new UnsettledProviderAttemptError({
      provider: providerName,
      model,
      category,
      retryable: false,
      message: `${message}; provider attempt did not settle after it was stopped`,
      cause: error,
    });
  }

  private resolveTimeout(
    requestTimeoutMs: number | undefined,
    globalTimeoutMs: number | undefined,
  ): number | undefined {
    const timeoutMs = requestTimeoutMs ?? globalTimeoutMs;
    return timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
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

  private createLinkedAbortController(signal?: AbortSignal): LinkedAbortController {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);

    if (signal?.aborted) {
      abort();
    } else {
      signal?.addEventListener('abort', abort, { once: true });
    }

    return {
      controller,
      cleanup: () => signal?.removeEventListener('abort', abort),
    };
  }
}
