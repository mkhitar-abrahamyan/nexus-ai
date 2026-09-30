import { MemoryRateLimitStore, type RateLimitStore } from '../ops/rate-limit-adapters.js';
import type { Principal, TenantGate } from '../types/server.js';
import { TenantLimitError } from './errors.js';

export { type TenantLimit, TenantLimitError } from './errors.js';
export type { TenantGate } from '../types/server.js';

/** A calendar period in UTC, or a fixed window in milliseconds. */
export type BudgetPeriod = 'hour' | 'day' | 'week' | 'month' | { windowMs: number };

/** What one tenant may do. Every limit is optional; one that is not set is not enforced. */
export interface TenantLimits {
  /** Runs the tenant may have accepted and unfinished at once, queued ones included. */
  maxActiveRuns?: number;
  /** Runs the tenant may start per window, such as `{ runs: 100, windowMs: 60_000 }`. */
  rate?: { runs: number; windowMs: number };
  /**
   * What the tenant may spend per period, in US dollars, from what its runs record through
   * `recordCost()`. A tenant at its budget gets no new runs until the period resets. `stopRuns`
   * also cancels runs in flight the moment the budget is spent.
   */
  budget?: { usd: number; period?: BudgetPeriod; stopRuns?: boolean };
}

/** Options for `tenantLimits()`. */
export interface TenantLimitsOptions {
  /** Limits for any tenant without its own, and for requests without a tenant. */
  default?: TenantLimits;
  /**
   * Limits per tenant id, or a function that looks them up — from a plan, a database, or a header.
   * Returning nothing applies `default`. A function is called once per admitted run, so cache
   * anything slow.
   */
  tenants?:
    | Record<string, TenantLimits>
    | ((tenantId: string | undefined) => TenantLimits | undefined | Promise<TenantLimits | undefined>);
  /** Where active runs and spending are counted. Defaults to memory; `RedisTenantUsage` shares them. */
  usage?: TenantUsageStore;
  /** Where rate windows are counted. Defaults to memory; `RedisRateLimitStore` shares them. */
  rates?: RateLimitStore;
  /**
   * How long a run's active slot lasts if its release never comes, as when its worker dies, in
   * milliseconds. Set it above the longest run. Defaults to an hour.
   */
  slotTtlMs?: number;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/**
 * Where tenant usage is counted: active-run slots that lapse on their own, and spending totals that
 * reset each period. Five operations, so any shared store can implement it.
 */
export interface TenantUsageStore {
  /** Takes a slot for `member` under `key` unless `max` are held, and resolves true when it did. Holding one already counts as taken. */
  acquire(key: string, member: string, max: number, ttlMs: number): Promise<boolean> | boolean;
  /** Frees a slot. Freeing one that is not held does nothing. */
  release(key: string, member: string): Promise<void> | void;
  /** Slots held under a key. */
  count(key: string): Promise<number> | number;
  /** Adds to a total that resets at `resetAt`, epoch milliseconds, and resolves to the new total. */
  add(key: string, amount: number, resetAt: number): Promise<number> | number;
  /** A total, or 0. */
  total(key: string): Promise<number> | number;
}

/** One tenant's limits and what it has used, from `GET /usage` or `report()`. */
export interface TenantUsage {
  /** The tenant, or nothing for requests without one. */
  tenantId?: string;
  /** The limits that apply to it. */
  limits: TenantLimits;
  /** Runs accepted and unfinished now. */
  activeRuns: number;
  /** Spending in the current period. */
  spend: { usd: number; period: BudgetPeriod; resetsAt: string };
}

/** The gate `tenantLimits()` returns: the server's `TenantGate`, plus reports for people. */
export interface TenantLimiter extends TenantGate {
  /** A tenant's limits and usage. */
  usage(tenantId?: string): Promise<TenantUsage>;
  /** Usage for these tenants, or for every tenant named in `tenants` when it is a record. */
  report(tenantIds?: readonly string[]): Promise<TenantUsage[]>;
}

/**
 * Per-tenant limits the agent server enforces: active runs, runs per window, and spending per
 * period. Give the result to `createAgentServer({ tenants })`.
 *
 * A run is admitted when it is accepted: the budget is checked, the rate window counts it, and it
 * takes an active slot, in that order. A refusal is a `429` with `Retry-After` when the wait is known.
 * The slot is released when the run ends, on whichever worker ran it; the rate and budget counters
 * move on their own. Point `usage` and `rates` at Redis and every replica enforces one set of limits.
 */
export function tenantLimits(options: TenantLimitsOptions): TenantLimiter {
  const usageStore = options.usage ?? new MemoryTenantUsage();
  const rates = options.rates ?? new MemoryRateLimitStore();
  const now = options.now ?? (() => new Date());
  const slotTtlMs = options.slotTtlMs ?? 3_600_000;

  const limitsOf = async (tenantId: string | undefined): Promise<TenantLimits | undefined> => {
    const tenants = options.tenants;
    const own =
      typeof tenants === 'function'
        ? await tenants(tenantId)
        : tenantId !== undefined
          ? tenants?.[tenantId]
          : undefined;
    return own ?? options.default;
  };
  const label = (tenantId: string | undefined) => encodeURIComponent(tenantId ?? '');
  const spendKey = (tenantId: string | undefined, period: BudgetPeriod, at: Date) =>
    `spend:${label(tenantId)}:${periodStart(period, at)}`;

  const usage = async (tenantId?: string): Promise<TenantUsage> => {
    const limits = (await limitsOf(tenantId)) ?? {};
    const period = limits.budget?.period ?? 'month';
    const at = now();
    return {
      ...(tenantId === undefined ? {} : { tenantId }),
      limits,
      activeRuns: await usageStore.count(`active:${label(tenantId)}`),
      spend: {
        usd: await usageStore.total(spendKey(tenantId, period, at)),
        period,
        resetsAt: new Date(periodEnd(period, at)).toISOString(),
      },
    };
  };

  return {
    async admit(run: { runId: string; assistant: string; principal?: Principal }): Promise<void> {
      const tenantId = run.principal?.tenantId;
      const limits = await limitsOf(tenantId);
      if (!limits) return;
      const at = now();
      const name = tenantId === undefined ? 'Requests without a tenant have' : `Tenant "${tenantId}" has`;

      if (limits.budget) {
        const period = limits.budget.period ?? 'month';
        const spent = await usageStore.total(spendKey(tenantId, period, at));
        if (spent >= limits.budget.usd) {
          throw new TenantLimitError(
            'budget',
            tenantId,
            `${name} spent its $${limits.budget.usd} budget for this ${describePeriod(period)}`,
            (periodEnd(period, at) - at.getTime()) / 1000,
          );
        }
      }
      if (limits.rate) {
        const hit = await rates.hit(`tenant:${label(tenantId)}`, limits.rate.windowMs);
        if (hit.count > limits.rate.runs) {
          throw new TenantLimitError(
            'rate',
            tenantId,
            `${name} started ${limits.rate.runs} runs in ${limits.rate.windowMs / 1000}s, its limit`,
            (hit.resetAt - at.getTime()) / 1000,
          );
        }
      }
      if (limits.maxActiveRuns !== undefined) {
        const taken = await usageStore.acquire(`active:${label(tenantId)}`, run.runId, limits.maxActiveRuns, slotTtlMs);
        if (!taken) {
          throw new TenantLimitError(
            'concurrency',
            tenantId,
            `${name} ${limits.maxActiveRuns} runs in flight, its limit`,
            1,
          );
        }
      }
    },

    async release(run: { runId: string; tenantId?: string }): Promise<void> {
      await usageStore.release(`active:${label(run.tenantId)}`, run.runId);
    },

    async spend(run: { runId: string; tenantId?: string }, usd: number): Promise<boolean> {
      const limits = (await limitsOf(run.tenantId)) ?? {};
      const period = limits.budget?.period ?? 'month';
      const at = now();
      const total = await usageStore.add(spendKey(run.tenantId, period, at), usd, periodEnd(period, at));
      return !(limits.budget?.stopRuns && total >= limits.budget.usd);
    },

    usage,

    async report(tenantIds?: readonly string[]): Promise<TenantUsage[]> {
      const ids =
        tenantIds ?? (typeof options.tenants === 'object' && options.tenants ? Object.keys(options.tenants) : []);
      return Promise.all(ids.map((id) => usage(id)));
    },
  };
}

/** Tenant usage in process memory. The default, and enough for one replica. */
export class MemoryTenantUsage implements TenantUsageStore {
  private readonly slots = new Map<string, Map<string, number>>();
  private readonly totals = new Map<string, { value: number; resetAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Takes a slot unless `max` are held. */
  acquire(key: string, member: string, max: number, ttlMs: number): boolean {
    const slots = this.live(key);
    if (slots.has(member)) return true;
    if (slots.size >= max) return false;
    slots.set(member, this.now() + ttlMs);
    this.slots.set(key, slots);
    return true;
  }

  /** Frees a slot. */
  release(key: string, member: string): void {
    this.slots.get(key)?.delete(member);
  }

  /** Slots held under a key. */
  count(key: string): number {
    return this.live(key).size;
  }

  /** Adds to a total that resets at `resetAt`. */
  add(key: string, amount: number, resetAt: number): number {
    const current = this.totals.get(key);
    const value = (current && current.resetAt > this.now() ? current.value : 0) + amount;
    this.totals.set(key, { value, resetAt });
    return value;
  }

  /** A total, or 0 once it has reset. */
  total(key: string): number {
    const current = this.totals.get(key);
    return current && current.resetAt > this.now() ? current.value : 0;
  }

  private live(key: string): Map<string, number> {
    const slots = this.slots.get(key) ?? new Map<string, number>();
    const at = this.now();
    for (const [member, expiresAt] of slots) if (expiresAt <= at) slots.delete(member);
    return slots;
  }
}

/**
 * The Redis commands the tenant usage store needs. `eval` runs each step as one atomic script, so
 * two replicas admitting runs for one tenant at the same moment cannot both take its last slot.
 */
export interface RedisTenantUsageLikeClient {
  /** Runs a Lua script, ioredis style: the script, the number of keys, then keys and arguments. */
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/** Options for `RedisTenantUsage`. */
export interface RedisTenantUsageOptions {
  /** Prefix for every key. Defaults to `nexus-ai-pro:tenants:`. */
  prefix?: string;
}

const ACQUIRE = `-- nexus:acquire
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZSCORE', KEYS[1], ARGV[3]) then return 1 end
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
return 1`;
const RELEASE = `-- nexus:release
return redis.call('ZREM', KEYS[1], ARGV[1])`;
const COUNT = `-- nexus:count
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
return redis.call('ZCARD', KEYS[1])`;
const ADD = `-- nexus:add
local total = redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
return total`;
const TOTAL = `-- nexus:total
return redis.call('GET', KEYS[1]) or '0'`;

/**
 * Tenant usage in Redis, shared by every replica: active slots in sorted sets scored by when they
 * lapse, and spending in counters that expire when their period ends.
 */
export class RedisTenantUsage implements TenantUsageStore {
  private readonly prefix: string;

  constructor(
    private readonly client: RedisTenantUsageLikeClient,
    options: RedisTenantUsageOptions = {},
  ) {
    this.prefix = options.prefix ?? 'nexus-ai-pro:tenants:';
  }

  /** Takes a slot unless `max` are held, atomically. */
  async acquire(key: string, member: string, max: number, ttlMs: number): Promise<boolean> {
    const now = Date.now();
    const result = await this.client.eval(
      ACQUIRE,
      1,
      this.prefix + key,
      String(now),
      String(max),
      member,
      String(now + ttlMs),
      String(ttlMs),
    );
    return Number(result) === 1;
  }

  /** Frees a slot. */
  async release(key: string, member: string): Promise<void> {
    await this.client.eval(RELEASE, 1, this.prefix + key, member);
  }

  /** Slots held under a key, dropping lapsed ones first. */
  async count(key: string): Promise<number> {
    return Number(await this.client.eval(COUNT, 1, this.prefix + key, String(Date.now())));
  }

  /** Adds to a total that expires at `resetAt`. */
  async add(key: string, amount: number, resetAt: number): Promise<number> {
    return Number(await this.client.eval(ADD, 1, this.prefix + key, String(amount), String(resetAt)));
  }

  /** A total, or 0. */
  async total(key: string): Promise<number> {
    return Number(await this.client.eval(TOTAL, 1, this.prefix + key));
  }
}

/** The start of the period `at` falls in, as epoch milliseconds, in UTC. */
function periodStart(period: BudgetPeriod, at: Date): number {
  if (typeof period === 'object') return Math.floor(at.getTime() / period.windowMs) * period.windowMs;
  const date = new Date(at.getTime());
  if (period === 'hour')
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours());
  if (period === 'day') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (period === 'week') {
    // Weeks start on Monday.
    const day = (date.getUTCDay() + 6) % 7;
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day);
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** When the period `at` falls in ends, as epoch milliseconds. */
function periodEnd(period: BudgetPeriod, at: Date): number {
  const start = periodStart(period, at);
  if (typeof period === 'object') return start + period.windowMs;
  if (period === 'hour') return start + 3_600_000;
  if (period === 'day') return start + 86_400_000;
  if (period === 'week') return start + 7 * 86_400_000;
  const date = new Date(start);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function describePeriod(period: BudgetPeriod): string {
  return typeof period === 'object' ? `${period.windowMs / 1000}s window` : period;
}
