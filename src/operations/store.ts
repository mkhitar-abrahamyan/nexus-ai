import type { OperationRecord, OperationStore } from '../types/operations.js';
import { isTerminalOperationStatus } from '../types/operations.js';
import { assertSerializableRecord } from './serialization.js';

export { assertSerializableRecord };

/** Options for the in-memory operation store. */
export interface MemoryOperationStoreOptions {
  /** Oldest terminal records are evicted past this count. Defaults to 1000. */
  maxRecords?: number;
}

/**
 * In-process operation storage.
 *
 * The default, and the right choice for a single process that wants leases, retries, and recovery
 * semantics without a Redis dependency. It does not survive a restart; use `RedisOperationStore`
 * when it must.
 */
export class MemoryOperationStore<TResult = unknown> implements OperationStore<TResult> {
  private readonly records = new Map<string, OperationRecord<TResult>>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly maxRecords: number;

  constructor(options: MemoryOperationStoreOptions = {}) {
    this.maxRecords = options.maxRecords ?? 1000;
  }

  /** Stores a new record. Refuses records carrying raw bytes. */
  create(record: OperationRecord<TResult>): void {
    assertSerializableRecord(record);
    this.records.set(record.id, clone(record));
    if (record.idempotencyKey) this.byIdempotencyKey.set(record.idempotencyKey, record.id);
    this.evict();
  }

  /** Reads a record. */
  read(id: string): OperationRecord<TResult> | undefined {
    const record = this.records.get(id);
    return record ? clone(record) : undefined;
  }

  /**
   * Writes a record when its stored sequence still equals `expectedSequence`. Returns false when
   * another writer got there first.
   */
  update(record: OperationRecord<TResult>, expectedSequence: number): boolean {
    const current = this.records.get(record.id);
    if (!current || current.sequence !== expectedSequence) return false;
    assertSerializableRecord(record);
    this.records.set(record.id, clone(record));
    return true;
  }

  /** Deletes a record. Returns true when it existed. */
  delete(id: string): boolean {
    const record = this.records.get(id);
    if (record?.idempotencyKey) this.byIdempotencyKey.delete(record.idempotencyKey);
    return this.records.delete(id);
  }

  /**
   * Records whose lease has expired, or running records without one, up to `limit`, for another
   * worker to take over.
   */
  claimExpired(now: string, limit: number): Array<OperationRecord<TResult>> {
    const expired: Array<OperationRecord<TResult>> = [];
    for (const record of this.records.values()) {
      if (expired.length >= limit) break;
      if (isTerminalOperationStatus(record.status)) continue;
      if (record.lease && record.lease.expiresAt > now) continue;
      if (record.status === 'running' || record.lease) expired.push(clone(record));
    }
    return expired;
  }

  /** Finds the record that claimed an idempotency key. */
  findByIdempotencyKey(key: string): OperationRecord<TResult> | undefined {
    const id = this.byIdempotencyKey.get(key);
    return id ? this.read(id) : undefined;
  }

  /** Every record. */
  list(): Array<OperationRecord<TResult>> {
    return [...this.records.values()].map(clone);
  }

  /** Removes every record. */
  clear(): void {
    this.records.clear();
    this.byIdempotencyKey.clear();
  }

  private evict(): void {
    if (this.records.size <= this.maxRecords) return;
    for (const [id, record] of this.records) {
      if (this.records.size <= this.maxRecords) break;
      if (!isTerminalOperationStatus(record.status)) continue;
      if (record.idempotencyKey) this.byIdempotencyKey.delete(record.idempotencyKey);
      this.records.delete(id);
    }
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
