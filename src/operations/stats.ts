import type {
  OperationRecord,
  OperationStatus,
  OperationStore,
  OperationStoreFilter,
  OperationStoreStats,
} from '../types/operations.js';
import { isTerminalOperationStatus } from '../types/operations.js';

/**
 * Queue counting shared by every operation store, kept apart from the stores themselves so a store
 * that uses it — Redis, say — does not also carry the in-memory one.
 */

/** Whether a record is queued and no worker holds a live lease on it. */
export function isUnheldQueued(record: OperationRecord<unknown>, now: string): boolean {
  return record.status === 'queued' && (!record.lease || record.lease.expiresAt <= now);
}

/** Whether a record passes a store filter. */
export function matchesFilter(record: OperationRecord<unknown>, filter?: OperationStoreFilter): boolean {
  return !filter?.kindPrefix || (record.kind ?? '').startsWith(filter.kindPrefix);
}

/** Counts records by status, the oldest queued one, and lapsed leases. */
export function countRecords(
  records: Iterable<OperationRecord<unknown>>,
  now: string,
  filter?: OperationStoreFilter,
): OperationStoreStats {
  const byStatus: Partial<Record<OperationStatus, number>> = {};
  let oldestQueuedAt: string | undefined;
  let lapsedLeases = 0;
  for (const record of records) {
    if (isTerminalOperationStatus(record.status) || !matchesFilter(record, filter)) continue;
    byStatus[record.status] = (byStatus[record.status] ?? 0) + 1;
    if (record.status === 'queued' && (!oldestQueuedAt || record.createdAt < oldestQueuedAt)) {
      oldestQueuedAt = record.createdAt;
    }
    if (record.status === 'running' && (!record.lease || record.lease.expiresAt <= now)) lapsedLeases += 1;
  }
  return { byStatus, ...(oldestQueuedAt ? { oldestQueuedAt } : {}), lapsedLeases };
}

/**
 * Counts what an operation store holds: records by status, the oldest queued one, and running
 * records whose lease has lapsed. Uses the store's own `stats()` when it has one, and counts
 * `list()` otherwise. A store with neither reports nothing.
 */
export async function operationStats(
  store: Pick<OperationStore<unknown>, 'stats' | 'list'>,
  options: OperationStoreFilter & { now?: Date } = {},
): Promise<OperationStoreStats> {
  const now = (options.now ?? new Date()).toISOString();
  const filter = options.kindPrefix ? { kindPrefix: options.kindPrefix } : undefined;
  if (store.stats) return store.stats(now, filter);
  if (store.list) return countRecords(await store.list(), now, filter);
  return { byStatus: {}, lapsedLeases: 0 };
}
