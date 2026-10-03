import { gcraDecide } from './rate-limiter.js';

export { gcraDecide };

/** A rate-limit window after counting one call. */
export interface RateLimitHit {
  /** Calls counted in the current window, including this one. */
  count: number;
  /** Epoch milliseconds when the window resets. */
  resetAt: number;
}

/** The verdict on one call under GCRA. */
export interface RateLimitDecision {
  /** Whether the call may go. */
  allowed: boolean;
  /** Epoch milliseconds from which a refused call would be allowed. */
  retryAt: number;
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
  /** Resets a key's window. */
  reset?(key: string): Promise<void> | void;
  /**
   * Decides one call under GCRA: one call per `emissionMs` on average, with up to `burst` at once,
   * atomically. Needed for `algorithm: 'gcra'`; both bundled stores have it.
   */
  gcra?(key: string, emissionMs: number, burst: number): Promise<RateLimitDecision> | RateLimitDecision;
}

/** Process-local counters. The default, and equivalent to the limiter's built-in behavior. */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, RateLimitHit>();
  private readonly arrivals = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Counts one call, starting a new window when the last has ended. */
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

  /** Decides one call under GCRA. */
  gcra(key: string, emissionMs: number, burst: number): RateLimitDecision {
    const decided = gcraDecide(this.arrivals.get(key), this.now(), emissionMs, burst);
    if (decided.allowed) this.arrivals.set(key, decided.tat);
    return { allowed: decided.allowed, retryAt: decided.retryAt };
  }

  /** Resets a key's window. */
  reset(key: string): void {
    this.buckets.delete(key);
    this.arrivals.delete(key);
  }

  /** Resets every window. */
  clear(): void {
    this.buckets.clear();
    this.arrivals.clear();
  }
}

/**
 * The Redis commands the rate-limit store needs.
 *
 * Structural rather than tied to one client, so `ioredis`, `node-redis`, or a proxy all satisfy it.
 */
export interface RedisRateLimitLikeClient {
  /** Increments a key. */
  incr(key: string): Promise<number> | number;
  /** Sets a key's expiry in milliseconds. */
  pexpire(key: string, milliseconds: number): Promise<unknown> | unknown;
  /** Reads a key's remaining lifetime in milliseconds. */
  pttl(key: string): Promise<number> | number;
  /** Deletes a key, for `reset()`. */
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

// GCRA in one atomic step, on the server's clock so every worker agrees on the time. Returns
// {allowed, wait in ms}.
const GCRA_SCRIPT = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local emission = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local tat = tonumber(redis.call('GET', KEYS[1]) or now)
if tat < now then tat = now end
local next = tat + emission
local allowAt = next - burst * emission
if allowAt > now then return {0, allowAt - now} end
redis.call('SET', KEYS[1], next, 'PX', math.max(1, math.ceil(next - now)))
return {1, 0}
`;

/** Options for the Redis rate-limit store. */
export interface RedisRateLimitStoreOptions {
  /** Key prefix. Defaults to `nexus-ai-pro:ratelimit:`. */
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
    private readonly options: RedisRateLimitStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'nexus-ai-pro:ratelimit:';
    this.useEval = options.useEval !== false && typeof client.eval === 'function';
  }

  /** Counts one call, in one atomic step when the client has `eval`. */
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

  /**
   * Decides one call under GCRA, atomically, on Redis's own clock. Needs a client with `eval`: the
   * read and the write cannot be split without letting two workers both take the last slot.
   */
  async gcra(key: string, emissionMs: number, burst: number): Promise<RateLimitDecision> {
    if (!this.client.eval || this.options.useEval === false) {
      throw new Error('GCRA rate limiting through Redis needs a client with eval');
    }
    const raw = (await this.client.eval(
      GCRA_SCRIPT,
      1,
      `${this.prefix}gcra:${key}`,
      String(emissionMs),
      String(burst),
    )) as [number | string, number | string];
    const allowed = Number(raw?.[0]) === 1;
    return { allowed, retryAt: Date.now() + Math.max(0, Number(raw?.[1] ?? 0)) };
  }

  /** Resets a key's window. Does nothing when the client has no `del`. */
  async reset(key: string): Promise<void> {
    await this.client.del?.(this.prefix + key);
  }
}
