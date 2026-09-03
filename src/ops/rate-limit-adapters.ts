export interface RateLimitHit {
  /** Calls counted in the current window, including this one. */
  count: number;
  /** Epoch milliseconds when the window resets. */
  resetAt: number;
}

/**
 * Where rate-limit counters live.
 *
 * Kept separate from `RateLimiter` so the limiter's policy — which key, which window, what counts
 * as over budget — stays in one place while the counter can move to Redis without touching it.
 */
export interface RateLimitStore {
  /** Counts one call against `key` and returns the resulting window state. */
  hit(key: string, windowMs: number): Promise<RateLimitHit> | RateLimitHit;
  reset?(key: string): Promise<void> | void;
}

/** Process-local counters. The default, and equivalent to the limiter's built-in behavior. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, RateLimitHit>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  hit(key: string, windowMs: number): RateLimitHit {
    const now = this.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      const fresh = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, fresh);
      return fresh;
    }

    bucket.count += 1;
    return bucket;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }
}

/**
 * The Redis commands the rate-limit store needs.
 *
 * Structural rather than tied to one client, so `ioredis`, `node-redis`, or a proxy all satisfy it.
 */
export interface RedisRateLimitLikeClient {
  incr(key: string): Promise<number> | number;
  pexpire(key: string, milliseconds: number): Promise<unknown> | unknown;
  pttl(key: string): Promise<number> | number;
  del?(key: string): Promise<unknown> | unknown;
  /** Optional atomic primitive. Strongly preferred; see the class note. */
  eval?(script: string, numKeys: number, ...args: string[]): Promise<unknown> | unknown;
}

const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  return {count, tonumber(ARGV[1])}
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`;

export interface RedisRateLimitStoreOptions {
  prefix?: string;
  /** Disables the Lua path even when the client exposes `eval`. */
  useEval?: boolean;
}

/**
 * Redis-backed counters, so one budget covers every process behind a load balancer.
 *
 * An in-memory limiter multiplies the real limit by the number of workers, which is the bug this
 * exists to remove. Prefer a client exposing `eval`: the increment and the expiry then happen in
 * one round trip and one atomic step. Without it the store falls back to INCR followed by a
 * separate PEXPIRE, which leaves a window where a crash between the two calls could leave a key
 * without a TTL — the fallback re-arms the expiry whenever it sees one missing, so the bucket
 * recovers rather than blocking the key forever.
 */
export class RedisRateLimitStore implements RateLimitStore {
  private readonly prefix: string;
  private readonly useEval: boolean;

  constructor(
    private readonly client: RedisRateLimitLikeClient,
    options: RedisRateLimitStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'nexus-ai-pro:ratelimit:';
    this.useEval = options.useEval !== false && typeof client.eval === 'function';
  }

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const namespaced = this.prefix + key;

    if (this.useEval && this.client.eval) {
      const raw = (await this.client.eval(HIT_SCRIPT, 1, namespaced, String(windowMs))) as [
        number | string,
        number | string,
      ];
      const count = Number(raw?.[0] ?? 0);
      const ttl = Number(raw?.[1] ?? windowMs);
      return { count, resetAt: Date.now() + Math.max(0, ttl) };
    }

    const count = Number(await this.client.incr(namespaced));
    if (count === 1) {
      await this.client.pexpire(namespaced, windowMs);
      return { count, resetAt: Date.now() + windowMs };
    }

    const ttl = Number(await this.client.pttl(namespaced));
    if (ttl < 0) {
      await this.client.pexpire(namespaced, windowMs);
      return { count, resetAt: Date.now() + windowMs };
    }
    return { count, resetAt: Date.now() + ttl };
  }

  async reset(key: string): Promise<void> {
    await this.client.del?.(this.prefix + key);
  }
}
