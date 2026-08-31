import type { OperationRecord, OperationStore } from '../types/operations.js';
import { isTerminalOperationStatus } from '../types/operations.js';
import { OperationSerializationError } from './errors.js';

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

  create(record: OperationRecord<TResult>): void {
    assertSerializableRecord(record);
    this.records.set(record.id, clone(record));
    if (record.idempotencyKey) this.byIdempotencyKey.set(record.idempotencyKey, record.id);
    this.evict();
  }

  read(id: string): OperationRecord<TResult> | undefined {
    const record = this.records.get(id);
    return record ? clone(record) : undefined;
  }

  update(record: OperationRecord<TResult>, expectedSequence: number): boolean {
    const current = this.records.get(record.id);
    if (!current || current.sequence !== expectedSequence) return false;
    assertSerializableRecord(record);
    this.records.set(record.id, clone(record));
    return true;
  }

  delete(id: string): boolean {
    const record = this.records.get(id);
    if (record?.idempotencyKey) this.byIdempotencyKey.delete(record.idempotencyKey);
    return this.records.delete(id);
  }

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

  findByIdempotencyKey(key: string): OperationRecord<TResult> | undefined {
    const id = this.byIdempotencyKey.get(key);
    return id ? this.read(id) : undefined;
  }

  list(): Array<OperationRecord<TResult>> {
    return [...this.records.values()].map(clone);
  }

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

const BINARY_TAGS = new Set([
  '[object ArrayBuffer]',
  '[object SharedArrayBuffer]',
  '[object Uint8Array]',
  '[object Uint8ClampedArray]',
  '[object Int8Array]',
  '[object Uint16Array]',
  '[object Int16Array]',
  '[object Uint32Array]',
  '[object Int32Array]',
  '[object Float32Array]',
  '[object Float64Array]',
  '[object BigInt64Array]',
  '[object BigUint64Array]',
  '[object DataView]',
  '[object Blob]',
  '[object File]',
  '[object ReadableStream]',
]);

/**
 * Refuses to persist a record carrying raw bytes.
 *
 * Queueing binary media is the mistake this family is most likely to invite: an image result holds
 * a `Uint8Array`, JSON-encoding it inflates the payload by a third, and most queue backends cap job
 * size well below one image. The bytes belong in an `AssetStore`, with only a reference on the
 * record. Failing loudly at the boundary is far cheaper than discovering it as a truncated job.
 */
export function assertSerializableRecord(record: OperationRecord<unknown>): void {
  const binaryPath = findBinary(record.result, 'result') ?? findBinary(record.metadata, 'metadata');
  if (binaryPath) throw new OperationSerializationError(record.id, binaryPath);
}

function findBinary(value: unknown, path: string, seen = new WeakSet<object>()): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  if (BINARY_TAGS.has(Object.prototype.toString.call(value))) return path;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return path;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findBinary(value[index], `${path}[${index}]`, seen);
      if (found) return found;
    }
    return undefined;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const found = findBinary(child, `${path}.${key}`, seen);
    if (found) return found;
  }
  return undefined;
}
