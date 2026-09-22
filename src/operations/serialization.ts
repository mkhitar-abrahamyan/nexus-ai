import type { OperationRecord } from '../types/operations.js';
import { OperationSerializationError } from './errors.js';

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
