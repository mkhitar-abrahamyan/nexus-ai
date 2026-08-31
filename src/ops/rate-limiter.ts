import type { RateLimitConfig } from '../types/config.js';

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
  constructor(public key: string) {
    super(`NexusAI rate limit exceeded for ${key}`);
    this.name = 'NexusRateLimitError';
  }
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

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
      throw new NexusRateLimitError(key);
    }
  }

  private getKey(request: RateLimitedRequest, config: RateLimitConfig): string {
    if (config.key === 'model') return `model:${request.model}`;
    if (config.key === 'global') return 'global';
    return `user:${request.userId || 'anonymous'}`;
  }
}
