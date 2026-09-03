import { randomUUID } from 'node:crypto';

import type { AssetDescriptor } from '../types/images.js';
import {
  AssetStoreCapacityError,
  AssetStoreSigningError,
  AssetStoreValidationError,
  capacityOption,
  cloneDescriptor,
  createStoredDescriptor,
  cloneAndValidateProvenance,
  nonEmptyString,
  optionalDimension,
  optionalPositiveNumber,
  resolveExpiration,
  sha256Checksum,
  validateByteInput,
  type AssetPutOptions,
  type AssetSigner,
  type AssetSignOptions,
  type AssetStat,
  type AssetStore,
  type ByteAssetDescriptor,
  type ByteAssetInput,
  type MemoryAssetStoreOptions,
  type MemoryAssetStoreSnapshot,
} from './asset-support.js';

/**
 * The shared contract, errors, and validation live in `asset-support.ts` and are re-exported here so
 * every existing `images/assets` import keeps resolving.
 */
export {
  AssetStoreCapacityError,
  AssetStoreError,
  AssetStoreSigningError,
  AssetStoreValidationError,
} from './asset-support.js';
export type {
  AssetCapacityConstraint,
  AssetPutOptions,
  AssetSigner,
  AssetSignerContext,
  AssetSignOptions,
  AssetStat,
  AssetStore,
  AssetStoreResult,
  ByteAssetDescriptor,
  ByteAssetInput,
  MemoryAssetStoreOptions,
  MemoryAssetStoreSnapshot,
} from './asset-support.js';

const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ASSET_BYTES = 10 * 1024 * 1024;

interface MemoryAssetEntry {
  assetId: string;
  tenantId: string;
  bytes: Uint8Array;
  descriptor: AssetDescriptor;
  createdAtMs: number;
  expiresAtMs?: number;
}

/**
 * Process-local, bounded asset storage. Capacity exhaustion rejects the write; live entries are never
 * silently evicted. Expired entries are purged before capacity and access decisions.
 */
export class MemoryAssetStore implements AssetStore {
  private readonly entries = new Map<string, MemoryAssetEntry>();
  private readonly maxEntries: number;
  private readonly maxTotalBytes: number;
  private readonly maxAssetBytes: number;
  private readonly defaultTtlSeconds?: number;
  private readonly createAssetId: () => string;
  private readonly clock: () => Date;
  private readonly signer?: AssetSigner;
  private totalBytes = 0;

  constructor(options: MemoryAssetStoreOptions = {}) {
    this.maxEntries = capacityOption(options.maxEntries, DEFAULT_MAX_ENTRIES, 'maxEntries');
    this.maxTotalBytes = capacityOption(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 'maxTotalBytes');
    this.maxAssetBytes = capacityOption(options.maxAssetBytes, DEFAULT_MAX_ASSET_BYTES, 'maxAssetBytes');
    this.defaultTtlSeconds = optionalPositiveNumber(options.defaultTtlSeconds, 'defaultTtlSeconds');
    this.createAssetId = options.createAssetId ?? randomUUID;
    this.clock = options.now ?? (() => new Date());
    this.signer = options.signer;
  }

  put(input: ByteAssetInput, options: AssetPutOptions): AssetStat {
    const nowMs = this.nowMs();
    this.purgeExpiredAt(nowMs);

    const normalizedInput = validateByteInput(input);
    const tenantId = nonEmptyString(options?.tenantId, 'tenantId');
    const provenance = cloneAndValidateProvenance(options?.provenance);
    const width = optionalDimension(options?.width, 'width');
    const height = optionalDimension(options?.height, 'height');
    const expiresAtMs = resolveExpiration(options, this.defaultTtlSeconds, nowMs);
    const bytes = new Uint8Array(normalizedInput.location.data);

    this.assertCapacity(bytes.byteLength);
    const checksum = sha256Checksum(bytes, normalizedInput.checksum);

    const assetId = nonEmptyString(this.createAssetId(), 'createAssetId() result');
    if (this.entries.has(assetId)) {
      throw new AssetStoreValidationError(`createAssetId() returned an existing asset ID: "${assetId}"`);
    }

    const descriptor = createStoredDescriptor(
      assetId,
      normalizedInput,
      provenance,
      checksum,
      bytes.byteLength,
      width,
      height,
    );
    const entry: MemoryAssetEntry = {
      assetId,
      tenantId,
      bytes,
      descriptor,
      createdAtMs: nowMs,
      expiresAtMs,
    };

    this.entries.set(assetId, entry);
    this.totalBytes += bytes.byteLength;
    return statFromEntry(entry);
  }

  get(assetId: string, tenantId: string): ByteAssetDescriptor | undefined {
    const entry = this.ownedEntry(assetId, tenantId);
    if (!entry) return undefined;

    const descriptor = cloneDescriptor(entry.descriptor);
    return {
      ...descriptor,
      location: { kind: 'bytes', data: new Uint8Array(entry.bytes) },
    };
  }

  stat(assetId: string, tenantId: string): AssetStat | undefined {
    const entry = this.ownedEntry(assetId, tenantId);
    return entry ? statFromEntry(entry) : undefined;
  }

  delete(assetId: string, tenantId: string): true | undefined {
    const entry = this.ownedEntry(assetId, tenantId);
    if (!entry) return undefined;

    this.removeEntry(entry);
    return true;
  }

  async sign(assetId: string, tenantId: string, options: AssetSignOptions = {}): Promise<string | undefined> {
    if (!this.signer) throw new AssetStoreSigningError('Asset signing requires a configured signer');
    const expiresInSeconds = optionalPositiveNumber(options.expiresInSeconds, 'expiresInSeconds');
    const entry = this.ownedEntry(assetId, tenantId);
    if (!entry) return undefined;

    try {
      const value = await this.signer({
        ...statFromEntry(entry),
        now: new Date(this.nowMs()).toISOString(),
        ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
      });
      return httpUrl(value);
    } catch (error) {
      if (error instanceof AssetStoreSigningError) throw error;
      throw new AssetStoreSigningError(`Failed to sign asset "${entry.assetId}"`, error);
    }
  }

  purgeExpired(): number {
    return this.purgeExpiredAt(this.nowMs());
  }

  snapshot(): MemoryAssetStoreSnapshot {
    this.purgeExpired();
    return {
      entries: this.entries.size,
      totalBytes: this.totalBytes,
      maxEntries: this.maxEntries,
      maxTotalBytes: this.maxTotalBytes,
      maxAssetBytes: this.maxAssetBytes,
    };
  }

  private assertCapacity(byteLength: number): void {
    if (byteLength > this.maxAssetBytes) {
      throw new AssetStoreCapacityError('maxAssetBytes', this.maxAssetBytes, 0, byteLength);
    }
    if (this.entries.size >= this.maxEntries) {
      throw new AssetStoreCapacityError('maxEntries', this.maxEntries, this.entries.size, 1);
    }
    if (this.totalBytes + byteLength > this.maxTotalBytes) {
      throw new AssetStoreCapacityError('maxTotalBytes', this.maxTotalBytes, this.totalBytes, byteLength);
    }
  }

  private ownedEntry(assetId: string, tenantId: string): MemoryAssetEntry | undefined {
    const normalizedAssetId = nonEmptyString(assetId, 'assetId');
    const normalizedTenantId = nonEmptyString(tenantId, 'tenantId');
    this.purgeExpiredAt(this.nowMs());
    const entry = this.entries.get(normalizedAssetId);
    return entry?.tenantId === normalizedTenantId ? entry : undefined;
  }

  private purgeExpiredAt(nowMs: number): number {
    let removed = 0;
    for (const entry of this.entries.values()) {
      if (entry.expiresAtMs !== undefined && entry.expiresAtMs <= nowMs) {
        this.removeEntry(entry);
        removed += 1;
      }
    }
    return removed;
  }

  private removeEntry(entry: MemoryAssetEntry): void {
    if (!this.entries.delete(entry.assetId)) return;
    this.totalBytes -= entry.bytes.byteLength;
  }

  private nowMs(): number {
    const value = this.clock();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new AssetStoreValidationError('now() must return a valid Date');
    }
    return value.getTime();
  }
}

function statFromEntry(entry: MemoryAssetEntry): AssetStat {
  return {
    assetId: entry.assetId,
    tenantId: entry.tenantId,
    descriptor: cloneDescriptor(entry.descriptor),
    createdAt: new Date(entry.createdAtMs).toISOString(),
    ...(entry.expiresAtMs === undefined ? {} : { expiresAt: new Date(entry.expiresAtMs).toISOString() }),
  };
}

function httpUrl(value: string | URL): string {
  const candidate = value instanceof URL ? value.href : value;
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new AssetStoreSigningError('Signer must return an absolute HTTP(S) URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (error) {
    throw new AssetStoreSigningError('Signer must return an absolute HTTP(S) URL', error);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new AssetStoreSigningError('Signer must return an absolute HTTP(S) URL');
  }
  return candidate;
}
