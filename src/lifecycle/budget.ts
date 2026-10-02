import { BudgetExceededError } from '../core/lifecycle.js';
import type { BudgetLedger, BudgetPeriod, BudgetReservation, OperationDescriptor } from '../types/lifecycle.js';
import { periodEnd, periodStart } from '../utils/periods.js';

/**
 * Where a ledger keeps its totals: a sum per key that resets at a given time. Two operations, so any
 * shared store can implement it. `MemoryTenantUsage` and `RedisTenantUsage` from
 * `nexus-ai-pro/server/tenancy` already do, so one Redis counts both tenant runs and model spend.
 */
export interface BudgetUsageStore {
  /** Adds to a total that resets at `resetAt`, epoch milliseconds, and resolves to the new total. */
  add(key: string, amount: number, resetAt: number): number | Promise<number>;
  /** A total, or 0. */
  total(key: string): number | Promise<number>;
}

/** Options for `budgetLedger()`. */
export interface BudgetLedgerOptions {
  /**
   * US dollars each budget may spend per period: one number for every budget, or a function that
   * returns each budget's own. A budget whose limit is `undefined` is not tracked.
   */
  limit: number | ((key: string) => number | undefined | Promise<number | undefined>);
  /** How long a budget lasts before it resets. Defaults to `month`, in UTC. */
  period?: BudgetPeriod;
  /**
   * Which budget an operation draws on. Defaults to its tenant, and to `default` for operations
   * without one. Return `undefined` to leave an operation untracked.
   */
  key?: (operation: OperationDescriptor) => string | undefined;
  /** Where totals are kept. Defaults to process memory, which is enough for one replica. */
  store?: BudgetUsageStore;
  /** Replaces the clock, for tests. */
  now?: () => Date;
}

/** A ledger that can also say what a budget has spent this period. */
export interface BudgetLedgerWithReport extends BudgetLedger {
  /** What a budget has spent so far this period, in US dollars, reservations included. */
  spent(key: string): Promise<number>;
}

/**
 * A spend budget shared by every family of a client.
 *
 * Before an operation runs, its estimated cost is added to the budget's total; when that would pass
 * the limit, the addition is undone and `BudgetExceededError` stops the call. Afterwards the estimate
 * is replaced by what the call actually cost, or given back when it failed. Adding first and checking
 * the new total is what keeps concurrent calls from overshooting together, on one process or many.
 */
export function budgetLedger(options: BudgetLedgerOptions): BudgetLedgerWithReport {
  const now = options.now ?? (() => new Date());
  const period = options.period ?? 'month';
  const store = options.store ?? new MemoryBudgetUsage(() => now().getTime());
  const windows = new WeakMap<BudgetReservation, { storeKey: string; resetAt: number }>();
  const storeKeyOf = (key: string, at: Date) => `budget:${encodeURIComponent(key)}:${periodStart(period, at)}`;
  const limitOf = async (key: string) => (typeof options.limit === 'function' ? options.limit(key) : options.limit);

  return {
    async reserve(operation: OperationDescriptor, estimate: number): Promise<BudgetReservation | undefined> {
      const key = options.key ? options.key(operation) : (operation.tenantId ?? 'default');
      if (key === undefined) return undefined;
      const limit = await limitOf(key);
      if (limit === undefined) return undefined;
      const at = now();
      const storeKey = storeKeyOf(key, at);
      const resetAt = periodEnd(period, at);
      const amount = Math.max(0, estimate);
      const total = await store.add(storeKey, amount, resetAt);
      const before = total - amount;
      // A spent budget refuses even a call estimated at nothing, since its estimate may be missing.
      if (total > limit || before >= limit) {
        await store.add(storeKey, -amount, resetAt);
        throw new BudgetExceededError(key, amount, limit - before);
      }
      const reservation: BudgetReservation = { key, amount };
      windows.set(reservation, { storeKey, resetAt });
      return reservation;
    },

    async reconcile(reservation: BudgetReservation, actual: number): Promise<void> {
      const window = windows.get(reservation);
      if (!window) return;
      windows.delete(reservation);
      const delta = Math.max(0, actual) - reservation.amount;
      if (delta !== 0) await store.add(window.storeKey, delta, window.resetAt);
    },

    async release(reservation: BudgetReservation): Promise<void> {
      const window = windows.get(reservation);
      if (!window) return;
      windows.delete(reservation);
      if (reservation.amount !== 0) await store.add(window.storeKey, -reservation.amount, window.resetAt);
    },

    async spent(key: string): Promise<number> {
      return store.total(storeKeyOf(key, now()));
    },
  };
}

/** Budget totals in process memory. The default store, and enough for one replica. */
export class MemoryBudgetUsage implements BudgetUsageStore {
  private readonly totals = new Map<string, { value: number; resetAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

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
}
