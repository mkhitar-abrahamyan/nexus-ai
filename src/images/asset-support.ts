import { createHash } from 'node:crypto';

import type {
  AssetBytesLocation,
  AssetChecksum,
  AssetDescriptor,
  AssetInput,
  AssetProvenance,
} from '../types/images.js';

/**
 * Contract, errors, and validation shared by every `AssetStore` implementation.
 *
 * Extracted when the filesystem and S3 stores arrived. Each store differs only in where the bytes
 * land; re-implementing the tenant, provenance, expiry, and checksum rules per backend is exactly
 * how two stores end up disagreeing about what a valid asset is. `images/assets` re-exports all of
 * it, so existing imports are unchanged.
 */

/** An asset input whose payload is already available locally as bytes. */
export interface ByteAssetInput extends Omit<AssetInput, 'location'> {
  location: AssetBytesLocation;
}

/** A retrieved asset descriptor whose byte payload is available to the caller. */
export interface ByteAssetDescriptor extends Omit<AssetDescriptor, 'location'> {
  location: AssetBytesLocation;
}

export interface AssetPutOptions {
  /** Tenant that owns the asset. This value is required for every later access. */
  tenantId: string;
  provenance: AssetProvenance;
  width?: number;
  height?: number;
  /** Relative retention period. Mutually exclusive with `expiresAt`. */
  ttlSeconds?: number;
  /** Absolute retention deadline. Mutually exclusive with `ttlSeconds`. */
  expiresAt?: Date | string;
}

export interface AssetStat {
  assetId: string;
  tenantId: string;
  /** Metadata-only descriptor. Its location points back to this store, not to the byte payload. */
  descriptor: AssetDescriptor;
  createdAt: string;
  expiresAt?: string;
}

export interface AssetSignOptions {
  /** Requested signed-URL lifetime. Enforcement is delegated to the configured signer. */
  expiresInSeconds?: number;
}

export interface AssetSignerContext extends AssetStat {
  now: string;
  expiresInSeconds?: number;
}

export type AssetSigner = (context: AssetSignerContext) => string | URL | Promise<string | URL>;

export type AssetStoreResult<T> = T | Promise<T>;

/**
 * Provider-neutral asset persistence contract.
 *
 * A store must treat a missing asset and an asset owned by another tenant identically. Implementations
 * may complete synchronously or asynchronously so the same contract can cover memory and remote stores.
 */
export interface AssetStore {
  put(input: ByteAssetInput, options: AssetPutOptions): AssetStoreResult<AssetStat>;
  get(assetId: string, tenantId: string): AssetStoreResult<ByteAssetDescriptor | undefined>;
  stat(assetId: string, tenantId: string): AssetStoreResult<AssetStat | undefined>;
  delete(assetId: string, tenantId: string): AssetStoreResult<true | undefined>;
  sign(assetId: string, tenantId: string, options?: AssetSignOptions): AssetStoreResult<string | undefined>;
  purgeExpired(): AssetStoreResult<number>;
}

export interface MemoryAssetStoreOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxAssetBytes?: number;
  defaultTtlSeconds?: number;
  createAssetId?: () => string;
  now?: () => Date;
  signer?: AssetSigner;
}

export interface MemoryAssetStoreSnapshot {
  entries: number;
  totalBytes: number;
  maxEntries: number;
  maxTotalBytes: number;
  maxAssetBytes: number;
}

export class AssetStoreError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AssetStoreError';
  }
}

export class AssetStoreValidationError extends AssetStoreError {
  constructor(message: string, cause?: unknown) {
    super(message, 'ASSET_STORE_VALIDATION_ERROR', cause);
    this.name = 'AssetStoreValidationError';
  }
}

export type AssetCapacityConstraint = 'maxEntries' | 'maxTotalBytes' | 'maxAssetBytes';

export class AssetStoreCapacityError extends AssetStoreError {
  constructor(
    public readonly constraint: AssetCapacityConstraint,
    public readonly maximum: number,
    public readonly current: number,
    public readonly requested: number,
  ) {
    super(
      `Asset store capacity ${constraint} exceeded (maximum ${maximum}, current ${current}, requested ${requested})`,
      'ASSET_STORE_CAPACITY_EXCEEDED',
    );
    this.name = 'AssetStoreCapacityError';
  }
}

export class AssetStoreSigningError extends AssetStoreError {
  constructor(message: string, cause?: unknown) {
    super(message, 'ASSET_STORE_SIGNING_ERROR', cause);
    this.name = 'AssetStoreSigningError';
  }
}

export function validateByteInput(input: ByteAssetInput): ByteAssetInput {
  if (!input || typeof input !== 'object') throw new AssetStoreValidationError('Asset input is required');
  if (input.location?.kind !== 'bytes' || !(input.location.data instanceof Uint8Array)) {
    throw new AssetStoreValidationError('Asset input location must contain Uint8Array bytes');
  }

  const normalized: ByteAssetInput = {
    location: input.location,
    mimeType: nonEmptyString(input.mimeType, 'mimeType'),
  };
  if (input.filename !== undefined) normalized.filename = nonEmptyString(input.filename, 'filename');
  if (input.checksum !== undefined) normalized.checksum = cloneChecksum(input.checksum);
  if (input.metadata !== undefined) normalized.metadata = { ...input.metadata };
  return normalized;
}

export function createStoredDescriptor(
  assetId: string,
  input: ByteAssetInput,
  provenance: AssetProvenance,
  checksum: AssetChecksum,
  byteLength: number,
  width: number | undefined,
  height: number | undefined,
): AssetDescriptor {
  return {
    location: { kind: 'stored', assetId, uri: `memory://asset/${encodeURIComponent(assetId)}` },
    mimeType: input.mimeType,
    checksum,
    byteLength,
    provenance,
    ...(input.filename === undefined ? {} : { filename: input.filename }),
    ...(input.metadata === undefined ? {} : { metadata: { ...input.metadata } }),
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

export function cloneDescriptor(descriptor: AssetDescriptor): AssetDescriptor {
  return {
    ...descriptor,
    location: { ...descriptor.location },
    checksum: descriptor.checksum ? cloneChecksum(descriptor.checksum) : undefined,
    metadata: descriptor.metadata ? { ...descriptor.metadata } : undefined,
    provenance: cloneProvenance(descriptor.provenance),
  };
}

export function cloneAndValidateProvenance(provenance: AssetProvenance): AssetProvenance {
  if (!provenance || typeof provenance !== 'object') {
    throw new AssetStoreValidationError('provenance is required');
  }
  const provider = nonEmptyString(provenance.provider, 'provenance.provider');
  const requestId = nonEmptyString(provenance.requestId, 'provenance.requestId');
  if (provenance.operation !== 'generate' && provenance.operation !== 'edit') {
    throw new AssetStoreValidationError('provenance.operation must be "generate" or "edit"');
  }
  if (provenance.model !== undefined) nonEmptyString(provenance.model, 'provenance.model');
  if (provenance.parentAssetIds) {
    provenance.parentAssetIds.forEach((parentAssetId, index) => {
      nonEmptyString(parentAssetId, `provenance.parentAssetIds[${index}]`);
    });
  }

  return cloneProvenance({ ...provenance, provider, requestId });
}

export function cloneProvenance(provenance: AssetProvenance): AssetProvenance {
  return {
    ...provenance,
    parentAssetIds: provenance.parentAssetIds ? [...provenance.parentAssetIds] : undefined,
    metadata: provenance.metadata ? { ...provenance.metadata } : undefined,
  };
}

export function cloneChecksum(checksum: AssetChecksum): AssetChecksum {
  if (!checksum || typeof checksum !== 'object') throw new AssetStoreValidationError('checksum must be an object');
  return {
    algorithm: nonEmptyString(checksum.algorithm, 'checksum.algorithm'),
    value: nonEmptyString(checksum.value, 'checksum.value'),
  };
}

export function sha256Checksum(bytes: Uint8Array, supplied?: AssetChecksum): AssetChecksum {
  const value = createHash('sha256').update(bytes).digest('hex');
  if (supplied && supplied.algorithm.toLowerCase().replaceAll('-', '') === 'sha256') {
    if (supplied.value.toLowerCase() !== value) {
      throw new AssetStoreValidationError('Supplied SHA-256 checksum does not match the asset bytes');
    }
  }
  return { algorithm: 'sha256', value };
}

export function resolveExpiration(
  options: AssetPutOptions,
  defaultTtlSeconds: number | undefined,
  nowMs: number,
): number | undefined {
  if (options.ttlSeconds !== undefined && options.expiresAt !== undefined) {
    throw new AssetStoreValidationError('ttlSeconds and expiresAt are mutually exclusive');
  }
  if (options.expiresAt !== undefined) {
    const expiresAtMs = new Date(options.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs) {
      throw new AssetStoreValidationError('expiresAt must be a valid future date');
    }
    return expiresAtMs;
  }

  const ttlSeconds = optionalPositiveNumber(options.ttlSeconds, 'ttlSeconds') ?? defaultTtlSeconds;
  if (ttlSeconds === undefined) return undefined;
  const expiresAtMs = nowMs + ttlSeconds * 1_000;
  if (!Number.isSafeInteger(expiresAtMs)) throw new AssetStoreValidationError('Asset expiration exceeds Date limits');
  return expiresAtMs;
}

export function capacityOption(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new AssetStoreValidationError(`${name} must be a non-negative safe integer`);
  }
  return normalized;
}

export function optionalPositiveNumber(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new AssetStoreValidationError(`${name} must be a positive finite number`);
  }
  return value;
}

export function optionalDimension(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new AssetStoreValidationError(`${name} must be a positive integer`);
  }
  return value;
}

export function nonEmptyString(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AssetStoreValidationError(`${name} must not be empty`);
  return value.trim();
}
