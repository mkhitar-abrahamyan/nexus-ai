import { MemoryRateLimitStore, type RateLimitStore } from '../ops/rate-limit-adapters.js';
import type { Principal, TenantGate } from '../types/server.js';
import { TenantLimitError } from './errors.js';
import type { BudgetPeriod, BudgetReservationRecord } from '../types/lifecycle.js';
import { type BudgetReservationChange, MemoryReservationBook } from '../lifecycle/reservations.js';
import { describePeriod, periodEnd, periodStart } from '../utils/periods.js';

export { type TenantLimit, TenantLimitError } from './errors.js';
export type { TenantGate } from '../types/server.js';

export type { BudgetPeriod } from '../types/lifecycle.js';

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
  /** Replaces the system clock, for tests. The default usage and rate stores keep time by it too. */
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
  const now = options.now ?? (() => new Date());
  // The default stores keep time by the same clock, so a replaced clock moves every window together.
  const clock = () => now().getTime();
  const usageStore = options.usage ?? new MemoryTenantUsage(clock);
  const rates = options.rates ?? new MemoryRateLimitStore(clock);
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

/**
 * Tenant usage in process memory, and the budget reservations against its totals. The default, and
 * enough for one replica.
 */
export class MemoryTenantUsage implements TenantUsageStore {
  private readonly slots = new Map<string, Map<string, number>>();
  private readonly totals = new Map<string, { value: number; resetAt: number }>();
  private readonly book: MemoryReservationBook;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.book = new MemoryReservationBook((key, amount, resetAt) => this.add(key, amount, resetAt), now);
  }

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

  /** Records a budget reservation and adds it to its total. */
  hold(record: BudgetReservationRecord): number {
    return this.book.hold(record);
  }

  /** Moves a budget reservation and its total together. */
  settle(id: string, change: BudgetReservationChange): boolean {
    return this.book.settle(id, change);
  }

  /** Extends a reserved budget reservation's lease. */
  renew(id: string, leasedUntil: number): boolean {
    return this.book.renew(id, leasedUntil);
  }

  /** Reserved budget reservations whose lease lapsed. */
  lapsed(now: number, limit: number, operation?: string): BudgetReservationRecord[] {
    return this.book.lapsed(now, limit, operation);
  }

  /** One budget reservation. */
  reservation(id: string): BudgetReservationRecord | undefined {
    return this.book.get(id);
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

// A reservation's record shares its total's Cluster slot, so one script moves both. An index of
// reservations by when their lease lapses sits in a slot of its own, beside a pointer from each
// reservation to its total; it is only ever a hint, checked against the record before it is used.
const HOLD = `-- nexus:reservation-hold
redis.call('HSET', KEYS[2], 'record', ARGV[1])
redis.call('HSET', KEYS[2], 'status', 'reserved')
redis.call('HSET', KEYS[2], 'charged', ARGV[2])
redis.call('HSET', KEYS[2], 'resetAt', ARGV[3])
redis.call('HSET', KEYS[2], 'leasedUntil', ARGV[5])
redis.call('HSET', KEYS[2], 'operation', ARGV[6])
redis.call('PEXPIREAT', KEYS[2], ARGV[4])
local total = redis.call('INCRBYFLOAT', KEYS[1], ARGV[2])
redis.call('PEXPIREAT', KEYS[1], ARGV[3])
return total`;
const SETTLE = `-- nexus:reservation-settle
local current = redis.call('HGET', KEYS[2], 'status')
if not current then return {0, ''} end
local operation = redis.call('HGET', KEYS[2], 'operation') or ''
local allowed = false
for status in string.gmatch(ARGV[5], '[^,]+') do
  if status == current then allowed = true end
end
if not allowed then return {0, operation} end
local delta = tonumber(ARGV[2]) - tonumber(redis.call('HGET', KEYS[2], 'charged'))
local resetAt = tonumber(redis.call('HGET', KEYS[2], 'resetAt'))
redis.call('HSET', KEYS[2], 'status', ARGV[1])
redis.call('HSET', KEYS[2], 'charged', ARGV[2])
redis.call('HSET', KEYS[2], 'settledAt', ARGV[3])
if ARGV[4] ~= '' then redis.call('HSET', KEYS[2], 'actual', ARGV[4]) end
local keep = resetAt + 86400000
if ARGV[1] ~= 'uncertain' and tonumber(ARGV[6]) < keep then keep = tonumber(ARGV[6]) end
redis.call('PEXPIREAT', KEYS[2], string.format('%d', keep))
if delta ~= 0 and resetAt > tonumber(ARGV[3]) then
  redis.call('INCRBYFLOAT', KEYS[1], string.format('%.17g', delta))
  redis.call('PEXPIREAT', KEYS[1], string.format('%d', resetAt))
end
return {1, operation}`;
const RENEW = `-- nexus:reservation-renew
if redis.call('HGET', KEYS[1], 'status') ~= 'reserved' then return 0 end
redis.call('HSET', KEYS[1], 'leasedUntil', ARGV[1])
return 1`;
const READ = `-- nexus:reservation-read
return redis.call('HGETALL', KEYS[1])`;
const INDEX = `-- nexus:reservation-index
redis.call('SET', KEYS[1], ARGV[1])
redis.call('PEXPIREAT', KEYS[1], ARGV[4])
for i = 2, #KEYS do redis.call('ZADD', KEYS[i], ARGV[2], ARGV[3]) end
return 1`;
const UNINDEX = `-- nexus:reservation-unindex
for i = 1, #KEYS do redis.call('ZREM', KEYS[i], ARGV[1]) end
return 1`;
const DUE = `-- nexus:reservation-due
return redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])`;
const POINTERS = `-- nexus:reservation-pointers
local totals = {}
for i = 1, #KEYS do totals[i] = redis.call('GET', KEYS[i]) or '' end
return totals`;
/** How long a reservation is kept past its period, for a late report from its operation: a day. */
const RESERVATION_RETENTION_MS = 86_400_000;
/** How long a settled reservation is kept, for a late report from its operation: an hour. */
const SETTLED_RETENTION_MS = 3_600_000;

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

  /** Records a budget reservation and adds it to its total, in one script. */
  async hold(record: BudgetReservationRecord): Promise<number> {
    const total = this.prefix + record.storeKey;
    // The index first: a reservation it names but that was never written is dropped when read.
    await this.index(record, total, record.leasedUntil);
    return Number(
      await this.client.eval(
        HOLD,
        2,
        total,
        recordKey(total, record.id),
        JSON.stringify(record),
        String(record.charged),
        String(record.resetAt),
        String(record.resetAt + RESERVATION_RETENTION_MS),
        String(record.leasedUntil),
        record.operation ?? '',
      ),
    );
  }

  /** Moves a budget reservation and its total together, in one script, if it stands where `change.from` allows. */
  async settle(id: string, change: BudgetReservationChange): Promise<boolean> {
    const total = await this.totalOf(id);
    if (!total) return false;
    const [moved, operation] = (await this.client.eval(
      SETTLE,
      2,
      total,
      recordKey(total, id),
      change.status,
      String(change.charged),
      String(change.at),
      change.actual === undefined ? '' : String(change.actual),
      change.from.join(','),
      String(change.at + SETTLED_RETENTION_MS),
    )) as [unknown, unknown];
    if (Number(moved) !== 1) return false;
    await this.unindex(id, String(operation ?? ''));
    return true;
  }

  /** Extends a reserved budget reservation's lease. */
  async renew(id: string, leasedUntil: number): Promise<boolean> {
    const total = await this.totalOf(id);
    if (!total) return false;
    if (Number(await this.client.eval(RENEW, 1, recordKey(total, id), String(leasedUntil))) !== 1) return false;
    const record = await this.read(total, id);
    if (record) await this.index(record, total, leasedUntil);
    return true;
  }

  /** Reserved budget reservations whose lease lapsed by `now`, soonest lapsed first. */
  async lapsed(now: number, limit: number, operation?: string): Promise<BudgetReservationRecord[]> {
    const due = this.registry(operation === undefined ? 'due' : `due:${encodeURIComponent(operation)}`);
    const ids = ((await this.client.eval(DUE, 1, due, String(now), String(limit))) ?? []) as string[];
    if (ids.length === 0) return [];
    const totals = (await this.client.eval(
      POINTERS,
      ids.length,
      ...ids.map((id) => this.registry(`id:${id}`)),
    )) as string[];
    const lapsed: BudgetReservationRecord[] = [];
    for (const [index, id] of ids.entries()) {
      const total = totals[index];
      const record = total ? await this.read(total, id) : undefined;
      // A hint the record no longer bears out: written before a crash, or settled since.
      if (record?.status !== 'reserved') {
        await this.unindex(id, record?.operation ?? operation ?? '');
        continue;
      }
      if (record.leasedUntil <= now) lapsed.push(record);
    }
    return lapsed;
  }

  /** One budget reservation, while it is kept. */
  async reservation(id: string): Promise<BudgetReservationRecord | undefined> {
    const total = await this.totalOf(id);
    return total ? this.read(total, id) : undefined;
  }

  private registry(name: string): string {
    return `${this.prefix}{reservations}:${name}`;
  }

  private async index(record: BudgetReservationRecord, total: string, leasedUntil: number): Promise<void> {
    const byOperation =
      record.operation === undefined ? [] : [this.registry(`due:${encodeURIComponent(record.operation)}`)];
    await this.client.eval(
      INDEX,
      2 + byOperation.length,
      this.registry(`id:${record.id}`),
      this.registry('due'),
      ...byOperation,
      total,
      String(leasedUntil),
      record.id,
      String(record.resetAt + RESERVATION_RETENTION_MS),
    );
  }

  private async unindex(id: string, operation: string): Promise<void> {
    const byOperation = operation ? [this.registry(`due:${encodeURIComponent(operation)}`)] : [];
    await this.client.eval(UNINDEX, 1 + byOperation.length, this.registry('due'), ...byOperation, id);
  }

  private async totalOf(id: string): Promise<string | undefined> {
    const [total] = (await this.client.eval(POINTERS, 1, this.registry(`id:${id}`))) as string[];
    return total || undefined;
  }

  /** A record as it was held, with what has changed since laid over it. */
  private async read(total: string, id: string): Promise<BudgetReservationRecord | undefined> {
    const pairs = ((await this.client.eval(READ, 1, recordKey(total, id))) ?? []) as string[];
    const fields = new Map<string, string>();
    for (let index = 0; index + 1 < pairs.length; index += 2)
      fields.set(String(pairs[index]), String(pairs[index + 1]));
    const held = fields.get('record');
    if (!held) return undefined;
    const record = JSON.parse(held) as BudgetReservationRecord;
    const number = (field: string) => (fields.has(field) ? Number(fields.get(field)) : undefined);
    return {
      ...record,
      status: (fields.get('status') ?? record.status) as BudgetReservationRecord['status'],
      charged: number('charged') ?? record.charged,
      leasedUntil: number('leasedUntil') ?? record.leasedUntil,
      ...(fields.has('actual') ? { actual: number('actual') as number } : {}),
      ...(fields.has('settledAt') ? { settledAt: number('settledAt') as number } : {}),
    };
  }
}

/**
 * A reservation's key, in its total's Cluster slot: a key without a hash tag hashes whole, so the
 * total wrapped in braces lands where the total does; a total with a tag already lends it.
 */
function recordKey(total: string, id: string): string {
  const open = total.indexOf('{');
  const tagged = open >= 0 && total.indexOf('}', open + 1) > open + 1;
  return `${tagged ? total : `{${total}}`}:reservation:${id}`;
}
