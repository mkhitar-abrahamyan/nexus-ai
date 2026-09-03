import type { RateLimitConfig } from '../types/config.js';
import type { RateLimitStore } from './rate-limit-adapters.js';

/**
 * The parts of a request the limiter buckets on.
 *
 * Structural rather than tied to `CompletionRequest`, so every operation family — completions,
 * embeddings, and whatever comes next — shares one limiter instance and one budget.
 */
export interface RateLimitedRequest {
  model?: string;
  userId?: string;
}

export class NexusRateLimitError extends Error {
  constructor(
    public key: string,
    /** Epoch milliseconds when the window resets, when the store reported one. */
    public readonly resetAt?: number,
  ) {
    super(`NexusAI rate limit exceeded for ${key}`);
    this.name = 'NexusRateLimitError';
  }

  /** Seconds a caller should wait, suitable for a `Retry-After` header. */
  get retryAfterSeconds(): number | undefined {
    if (this.resetAt === undefined) return undefined;
    return Math.max(0, Math.ceil((this.resetAt - Date.now()) / 1000));
  }
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  /**
   * Counts one call against a distributed store.
   *
   * Separate from `check()` rather than replacing it: a store is asynchronous, and making the
   * common in-memory path await a promise would add a microtask to every request that does not use
   * one. Callers pick the path by whether `config.store` is set.
   */
  async checkAsync(request: RateLimitedRequest, config?: RateLimitConfig): Promise<void> {
    if (!config?.enabled) return;

    const store: RateLimitStore | undefined = config.store;
    if (!store) {
      this.check(request, config);
      return;
    }

    const key = this.getKey(request, config);
    const hit = await store.hit(key, config.windowMs);
    if (hit.count > config.maxRequests) {
      throw new NexusRateLimitError(key, hit.resetAt);
    }
  }

  check(request: RateLimitedRequest, config?: RateLimitConfig): void {
    if (!config?.enabled) return;

    const key = this.getKey(request, config);
    const now = Date.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + config.windowMs });
      return;
    }

    bucket.count += 1;
    if (bucket.count > config.maxRequests) {
      throw new NexusRateLimitError(key, bucket.resetAt);
    }
  }

  private getKey(request: RateLimitedRequest, config: RateLimitConfig): string {
    if (config.key === 'model') return `model:${request.model}`;
    if (config.key === 'global') return 'global';
    return `user:${request.userId || 'anonymous'}`;
  }
}
