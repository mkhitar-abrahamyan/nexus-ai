import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse, NexusStream } from '../types/response.js';
import type { BaseProvider } from '../providers/base.js';
import type { RouteDecision } from './types.js';
import type { RetryConfig } from '../types/config.js';

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
          const started = Date.now();
          const response = await this.withTimeout(
            provider.complete({ ...request, model: attempt.model }),
            request.timeoutMs || options.timeoutMs,
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
          const category = this.categorizeError(err);
          const message = `${attempt.providerName}/${attempt.model}: ${err instanceof Error ? err.message : String(err)}`;
          errors.push(message);

          if (!retry.enabled || retryIndex >= retry.maxRetries || !retry.retryOn.includes(category)) {
            break;
          }

          await this.delay(this.retryDelay(retry, retryIndex));
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
    return {
      [Symbol.asyncIterator]() {
        const attempts = [{ providerName: decision.providerName, model: decision.model }, ...decision.fallbacks];
        return self.streamAttempts(request, attempts, providers, options);
      },
      abort() {
        // Each provider stream owns its own abort lifecycle once selected.
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
          if (emitted || !retry.enabled || retryIndex >= retry.maxRetries || !retry.retryOn.includes(this.categorizeError(error))) {
            break;
          }
          await this.delay(this.retryDelay(retry, retryIndex));
        }
      }
    }

    yield { type: 'error', error: `All streaming attempts failed: ${errors.join(' | ')}` };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) return promise;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Provider call timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
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

  private categorizeError(error: unknown): Required<RetryConfig>['retryOn'][number] {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes('timed out') || message.includes('timeout')) return 'timeout';
    if (message.includes('429') || message.includes('rate limit')) return 'rate-limit';
    if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) return 'server-error';
    if (message.includes('network') || message.includes('fetch failed') || message.includes('econnreset')) return 'network';
    return 'unknown';
  }

  private retryDelay(retry: Required<RetryConfig>, retryIndex: number): number {
    const multiplier = retry.backoff === 'exponential' ? 2 ** retryIndex : 1;
    return Math.min(retry.baseDelayMs * multiplier, retry.maxDelayMs);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
