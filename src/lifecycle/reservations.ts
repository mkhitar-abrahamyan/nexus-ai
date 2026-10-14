import type { BudgetReservationRecord, BudgetReservationStatus } from '../types/lifecycle.js';

/** How long a settled reservation is kept for a late report from its operation: an hour. */
const SETTLED_RETENTION_MS = 60 * 60 * 1000;

/**
 * A change to one recorded reservation: where it moves, what it charges once there, and the
 * statuses it may move from. A store applies the status and the difference in what it charges to its
 * total together, or not at all.
 */
export interface BudgetReservationChange {
  /** Where it moves. */
  status: Exclude<BudgetReservationStatus, 'reserved'>;
  /** What it adds to its total once moved. */
  charged: number;
  /** The statuses it may move from. From any other, the change is refused. */
  from: readonly BudgetReservationStatus[];
  /** When, epoch milliseconds. */
  at: number;
  /** What its operation cost, when settled. */
  actual?: number;
}

/**
 * Reservations in process memory, beside the totals of the store that holds them: what
 * `MemoryBudgetUsage` and `MemoryTenantUsage` keep them in. Each change and its total move together,
 * since nothing runs between them on one thread.
 */
export class MemoryReservationBook {
  private readonly records = new Map<string, BudgetReservationRecord>();
  private prunedAt = 0;

  constructor(
    private readonly add: (key: string, amount: number, resetAt: number) => number,
    private readonly now: () => number,
  ) {}

  /** Records a reservation and adds what it charges to its total. */
  hold(record: BudgetReservationRecord): number {
    this.prune();
    if (this.records.has(record.id)) throw new Error(`Budget reservation "${record.id}" already exists`);
    this.records.set(record.id, { ...record });
    return this.add(record.storeKey, record.charged, record.resetAt);
  }

  /** Moves a reservation, and its total by what it charges differently, if it stands where `from` allows. */
  settle(id: string, change: BudgetReservationChange): boolean {
    const record = this.records.get(id);
    if (!record || !change.from.includes(record.status)) return false;
    const delta = change.charged - record.charged;
    record.status = change.status;
    record.charged = change.charged;
    record.settledAt = change.at;
    if (change.actual !== undefined) record.actual = change.actual;
    // A period that has ended has reset its total; nothing it held is charged any longer.
    if (delta !== 0 && record.resetAt > change.at) this.add(record.storeKey, delta, record.resetAt);
    return true;
  }

  /** Extends a reserved reservation's lease. */
  renew(id: string, leasedUntil: number): boolean {
    const record = this.records.get(id);
    if (record?.status !== 'reserved') return false;
    record.leasedUntil = leasedUntil;
    return true;
  }

  /** Reserved reservations whose lease lapsed by `now`, soonest lapsed first. */
  lapsed(now: number, limit: number, operation?: string): BudgetReservationRecord[] {
    const lapsed: BudgetReservationRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status !== 'reserved' || record.leasedUntil > now) continue;
      if (operation !== undefined && record.operation !== operation) continue;
      lapsed.push({ ...record });
    }
    return lapsed.sort((a, b) => a.leasedUntil - b.leasedUntil).slice(0, limit);
  }

  /** One reservation. */
  get(id: string): BudgetReservationRecord | undefined {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  /**
   * Forgets what no report can change any more, at most once a minute: anything whose period has
   * ended, and a settled, released, or expired reservation after an hour. An uncertain one is kept
   * for its period, until its operation says what it cost.
   */
  private prune(): void {
    const now = this.now();
    if (now - this.prunedAt < 60_000) return;
    this.prunedAt = now;
    for (const [id, record] of this.records) {
      if (record.status === 'reserved') continue;
      const settledLongAgo = record.status !== 'uncertain' && (record.settledAt ?? 0) + SETTLED_RETENTION_MS <= now;
      if (record.resetAt <= now || settledLongAgo) this.records.delete(id);
    }
  }
}
