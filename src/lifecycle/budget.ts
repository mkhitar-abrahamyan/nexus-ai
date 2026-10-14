import { BudgetExceededError } from '../core/lifecycle.js';
import type {
  BudgetLedger,
  BudgetPeriod,
  BudgetRecoveryReport,
  BudgetReservation,
  BudgetReservationOutcome,
  BudgetReservationRecord,
  OperationDescriptor,
} from '../types/lifecycle.js';
import { randomHex } from '../utils/ids.js';
import { periodEnd, periodStart } from '../utils/periods.js';
import { type BudgetReservationChange, MemoryReservationBook } from './reservations.js';

export type { BudgetReservationChange } from './reservations.js';

/** Ten minutes: how long a recorded reservation is held without renewal before recovery may settle it. */
const DEFAULT_LEASE_MS = 10 * 60 * 1000;

/**
 * Where a ledger keeps its totals: a sum per key that resets at a given time. Two operations, so any
 * shared store can implement it. `MemoryTenantUsage` and `RedisTenantUsage` from
 * `nexus-ai-pro/server/tenancy` already do, so one Redis counts both tenant runs and model spend.
 *
 * A store that also records reservations implements the five optional methods together. A ledger
 * over it records each reservation under a lease, so one a dead process held is found and settled,
 * and moves each reservation and its total in one step, so a crash never applies one without the
 * other. Every bundled store does.
 */
export interface BudgetUsageStore {
  /** Adds to a total that resets at `resetAt`, epoch milliseconds, and resolves to the new total. */
  add(key: string, amount: number, resetAt: number): number | Promise<number>;
  /** A total, or 0. */
  total(key: string): number | Promise<number>;
  /** Records a reservation and adds what it charges to its total, together: resolves to the new total. */
  hold?(record: BudgetReservationRecord): number | Promise<number>;
  /**
   * Moves a reservation and its total, by the difference in what it charges, together, if it stands
   * where `change.from` allows. Resolves whether it moved.
   */
  settle?(id: string, change: BudgetReservationChange): boolean | Promise<boolean>;
  /** Extends a reserved reservation's lease. Resolves whether it was still reserved. */
  renew?(id: string, leasedUntil: number): boolean | Promise<boolean>;
  /** Reserved reservations whose lease lapsed by `now`, soonest lapsed first, optionally for one operation. */
  lapsed?(
    now: number,
    limit: number,
    operation?: string,
  ): BudgetReservationRecord[] | Promise<BudgetReservationRecord[]>;
  /** One reservation, while the store keeps it. */
  reservation?(id: string): BudgetReservationRecord | undefined | Promise<BudgetReservationRecord | undefined>;
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
  /**
   * How long a recorded reservation is held without `renew()` before `recover()` may settle it.
   * Defaults to 10 minutes: longer than the operations it covers take.
   */
  leaseMs?: number;
  /**
   * What a reservation whose operation's outcome is unknown costs until its operation says: `charge`
   * keeps it charged, as a provider may have billed the call; `release` gives it back. Defaults to
   * `charge`.
   */
  uncertain?: 'charge' | 'release';
  /** Replaces the clock, for tests. */
  now?: () => Date;
}

/** A ledger that can also say what a budget has spent this period, and settle what a dead process held. */
export interface BudgetLedgerWithReport extends BudgetLedger {
  /** Holds `estimate` for the operation, or rejects with `BudgetExceededError` when it does not fit. */
  reserve(operation: OperationDescriptor, estimate: number): Promise<BudgetReservation | undefined>;
  /** What a budget has spent so far this period, in US dollars, reservations included. */
  spent(key: string): Promise<number>;
  /** A recorded reservation, while the store keeps it. */
  reservation(id: string): Promise<BudgetReservationRecord | undefined>;
  /** Extends a recorded reservation's lease. Does nothing for one the store does not record. */
  renew(reservation: BudgetReservation): Promise<void>;
  /** Settles a recorded reservation by its id. Resolves `false` on a store that does not record them. */
  settle(id: string, outcome: BudgetReservationOutcome): Promise<boolean>;
  /** Settles reservations whose lease lapsed. Settles nothing on a store that does not record them. */
  recover: NonNullable<BudgetLedger['recover']>;
}

/** The statuses a reservation leaves for each outcome: a late report from its operation corrects recovery. */
const FROM = {
  settled: ['reserved', 'uncertain', 'expired'],
  released: ['reserved', 'uncertain'],
  recovered: ['reserved'],
} as const;

/**
 * A spend budget shared by every family of a client.
 *
 * Before an operation runs, its estimated cost is added to the budget's total; when that would pass
 * the limit, the addition is undone and `BudgetExceededError` stops the call. Afterwards the estimate
 * is replaced by what the call actually cost, or given back when it failed. Adding first and checking
 * the new total is what keeps concurrent calls from overshooting together, on one process or many.
 *
 * Over a store that records reservations, each is held under a lease. One whose process died is
 * found by `recover()` when its lease lapses and settled by what became of its operation: charged at
 * its cost if it finished, given back if it never started, and charged or given back by `uncertain`
 * when no one knows.
 */
export function budgetLedger(options: BudgetLedgerOptions): BudgetLedgerWithReport {
  const now = options.now ?? (() => new Date());
  const period = options.period ?? 'month';
  const store = options.store ?? new MemoryBudgetUsage(() => now().getTime());
  const records = recordsOf(store);
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  if (!(Number.isFinite(leaseMs) && leaseMs > 0)) throw new RangeError('leaseMs must be a positive number');
  const uncertain = options.uncertain ?? 'charge';
  const windows = new WeakMap<BudgetReservation, { storeKey: string; resetAt: number }>();
  const storeKeyOf = (key: string, at: Date) => `budget:${encodeURIComponent(key)}:${periodStart(period, at)}`;
  const limitOf = async (key: string) => (typeof options.limit === 'function' ? options.limit(key) : options.limit);

  /** Applies an outcome to a recorded reservation; `running` renews its lease. */
  const apply = async (record: BudgetReservationRecord, outcome: BudgetReservationOutcome): Promise<boolean> => {
    if (!records) return false;
    const at = now().getTime();
    switch (outcome.kind) {
      case 'running':
        return records.renew(record.id, at + leaseMs);
      case 'finished': {
        const cost = Math.max(0, outcome.cost);
        return records.settle(record.id, { status: 'settled', charged: cost, actual: cost, from: FROM.settled, at });
      }
      case 'never-started':
        return records.settle(record.id, { status: 'expired', charged: 0, from: FROM.recovered, at });
      case 'unknown':
        return records.settle(record.id, {
          status: 'uncertain',
          charged: uncertain === 'charge' ? record.amount : 0,
          from: FROM.recovered,
          at,
        });
    }
  };

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
      const id = records ? `rsv_${randomHex(12)}` : undefined;
      const total = records
        ? await records.hold({
            id: id as string,
            key,
            storeKey,
            resetAt,
            amount,
            charged: amount,
            operationId: operation.requestId,
            family: operation.family,
            operation: operation.operation,
            status: 'reserved',
            leasedUntil: at.getTime() + leaseMs,
            createdAt: at.getTime(),
          })
        : await store.add(storeKey, amount, resetAt);
      const before = total - amount;
      // A spent budget refuses even a call estimated at nothing, since its estimate may be missing.
      if (total > limit || before >= limit) {
        if (records) {
          await records.settle(id as string, { status: 'released', charged: 0, from: FROM.released, at: at.getTime() });
        } else await store.add(storeKey, -amount, resetAt);
        throw new BudgetExceededError(key, amount, limit - before);
      }
      const reservation: BudgetReservation = { key, amount, ...(id ? { id } : {}) };
      windows.set(reservation, { storeKey, resetAt });
      return reservation;
    },

    async reconcile(reservation: BudgetReservation, actual: number): Promise<void> {
      if (reservation.id && records) {
        const cost = Math.max(0, actual);
        await records.settle(reservation.id, {
          status: 'settled',
          charged: cost,
          actual: cost,
          from: FROM.settled,
          at: now().getTime(),
        });
        return;
      }
      const window = windows.get(reservation);
      if (!window) return;
      windows.delete(reservation);
      const delta = Math.max(0, actual) - reservation.amount;
      if (delta !== 0) await store.add(window.storeKey, delta, window.resetAt);
    },

    async release(reservation: BudgetReservation): Promise<void> {
      if (reservation.id && records) {
        await records.settle(reservation.id, {
          status: 'released',
          charged: 0,
          from: FROM.released,
          at: now().getTime(),
        });
        return;
      }
      const window = windows.get(reservation);
      if (!window) return;
      windows.delete(reservation);
      if (reservation.amount !== 0) await store.add(window.storeKey, -reservation.amount, window.resetAt);
    },

    async spent(key: string): Promise<number> {
      return store.total(storeKeyOf(key, now()));
    },

    async reservation(id: string): Promise<BudgetReservationRecord | undefined> {
      return records ? records.reservation(id) : undefined;
    },

    async renew(reservation: BudgetReservation): Promise<void> {
      if (reservation.id && records) await records.renew(reservation.id, now().getTime() + leaseMs);
    },

    async settle(id: string, outcome: BudgetReservationOutcome): Promise<boolean> {
      const record = records ? await records.reservation(id) : undefined;
      return record ? apply(record, outcome) : false;
    },

    async recover(resolve, recoverOptions = {}): Promise<BudgetRecoveryReport> {
      const report: BudgetRecoveryReport = { settled: 0, expired: 0, uncertain: 0, renewed: 0, skipped: 0 };
      if (!records) return report;
      const lapsed = await records.lapsed(now().getTime(), recoverOptions.limit ?? 100, recoverOptions.operation);
      for (const record of lapsed) {
        const outcome = await resolve(record);
        if (!outcome) {
          report.skipped += 1;
          continue;
        }
        // Another process may have settled it since it was read; then it is not counted here.
        if (!(await apply(record, outcome))) continue;
        if (outcome.kind === 'finished') report.settled += 1;
        else if (outcome.kind === 'never-started') report.expired += 1;
        else if (outcome.kind === 'unknown') report.uncertain += 1;
        else report.renewed += 1;
      }
      return report;
    },
  };
}

type ReservationMethods = Required<Pick<BudgetUsageStore, 'hold' | 'settle' | 'renew' | 'lapsed' | 'reservation'>>;

/** The store's reservation methods, bound, when it has all five; refuses a store with only some. */
function recordsOf(store: BudgetUsageStore): ReservationMethods | undefined {
  const names = ['hold', 'settle', 'renew', 'lapsed', 'reservation'] as const;
  const present = names.filter((name) => typeof store[name] === 'function');
  if (present.length === 0) return undefined;
  if (present.length < names.length) {
    const missing = names.filter((name) => !present.includes(name));
    throw new TypeError(
      `A budget store that records reservations implements all five methods; missing ${missing.join(', ')}`,
    );
  }
  return {
    hold: (record) => (store.hold as NonNullable<BudgetUsageStore['hold']>).call(store, record),
    settle: (id, change) => (store.settle as NonNullable<BudgetUsageStore['settle']>).call(store, id, change),
    renew: (id, leasedUntil) => (store.renew as NonNullable<BudgetUsageStore['renew']>).call(store, id, leasedUntil),
    lapsed: (at, limit, operation) =>
      (store.lapsed as NonNullable<BudgetUsageStore['lapsed']>).call(store, at, limit, operation),
    reservation: (id) => (store.reservation as NonNullable<BudgetUsageStore['reservation']>).call(store, id),
  };
}

/** Budget totals, and the reservations against them, in process memory. The default store, and enough for one replica. */
export class MemoryBudgetUsage implements BudgetUsageStore {
  private readonly totals = new Map<string, { value: number; resetAt: number }>();
  private readonly book: MemoryReservationBook;

  constructor(private readonly now: () => number = () => Date.now()) {
    this.book = new MemoryReservationBook((key, amount, resetAt) => this.add(key, amount, resetAt), now);
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

  /** Records a reservation and adds it to its total. */
  hold(record: BudgetReservationRecord): number {
    return this.book.hold(record);
  }

  /** Moves a reservation and its total together. */
  settle(id: string, change: BudgetReservationChange): boolean {
    return this.book.settle(id, change);
  }

  /** Extends a reserved reservation's lease. */
  renew(id: string, leasedUntil: number): boolean {
    return this.book.renew(id, leasedUntil);
  }

  /** Reserved reservations whose lease lapsed. */
  lapsed(now: number, limit: number, operation?: string): BudgetReservationRecord[] {
    return this.book.lapsed(now, limit, operation);
  }

  /** One reservation. */
  reservation(id: string): BudgetReservationRecord | undefined {
    return this.book.get(id);
  }
}
