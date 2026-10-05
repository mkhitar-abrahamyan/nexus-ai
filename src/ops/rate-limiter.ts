import type { RateLimitConfig } from '../types/config.js';
import type { RateLimitStore } from './rate-limit-adapters.js';

/**
 * The parts of a request the limiter buckets on.
 *
 * Structural rather than tied to `CompletionRequest`, so every operation family — completions,
 * embeddings, and whatever comes next — shares one limiter instance and one budget.
 */
export interface RateLimitedRequest {
  /** Model requested, for per-model limits. */
  model?: string;
  /** Caller, for per-user limits. */
  userId?: string;
  /** Tenant, for per-tenant limits. */
  tenantId?: string;
}

/** Raised when a caller exceeds its rate limit. */
export class NexusRateLimitError extends Error {
  constructor(
    /** The bucket that was full. */
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

/**
 * Rate limiting per user, per model, or globally, in memory or through a shared store, by fixed
 * windows or by GCRA.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private arrivals = new Map<string, number>();

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
    if (config.algorithm === 'gcra') {
      if (!store.gcra)
        throw new Error('This rate-limit store cannot decide GCRA; give it gcra(), or use fixed windows');
      const decided = await store.gcra(key, emissionOf(config), burstOf(config));
      if (!decided.allowed) throw new NexusRateLimitError(key, decided.retryAt);
      return;
    }
    const hit = await store.hit(key, config.windowMs);
    if (hit.count > config.maxRequests) {
      throw new NexusRateLimitError(key, hit.resetAt);
    }
  }

  /** Counts one call in memory. Throws `NexusRateLimitError` when the bucket is full. */
  check(request: RateLimitedRequest, config?: RateLimitConfig): void {
    if (!config?.enabled) return;

    const key = this.getKey(request, config);
    const now = Date.now();
    if (config.algorithm === 'gcra') {
      const decided = gcraDecide(this.arrivals.get(key), now, emissionOf(config), burstOf(config));
      if (!decided.allowed) throw new NexusRateLimitError(key, decided.retryAt);
      this.arrivals.set(key, decided.tat);
      return;
    }
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
    // The two algorithms keep separate state, so switching a config never reads the other's.
    if (config.key === 'model') return `model:${request.model}`;
    if (config.key === 'tenantId') return `tenant:${request.tenantId || 'none'}`;
    if (config.key === 'global') return 'global';
    return `user:${request.userId || 'anonymous'}`;
  }
}

/** Milliseconds between calls at the sustained rate. */
function emissionOf(config: RateLimitConfig): number {
  return config.windowMs / Math.max(1, config.maxRequests);
}

function burstOf(config: RateLimitConfig): number {
  return Math.max(1, config.burst ?? config.maxRequests);
}

/**
 * GCRA on one key's theoretical arrival time: the time the key would be idle again at the allowed
 * rate. A call is allowed when that time, after counting it, is no more than `burst` intervals ahead.
 */
export function gcraDecide(
  tat: number | undefined,
  now: number,
  emissionMs: number,
  burst: number,
): { allowed: boolean; retryAt: number; tat: number } {
  const next = Math.max(tat ?? now, now) + emissionMs;
  const allowAt = next - burst * emissionMs;
  if (allowAt > now) return { allowed: false, retryAt: allowAt, tat: tat ?? now };
  return { allowed: true, retryAt: now, tat: next };
}
