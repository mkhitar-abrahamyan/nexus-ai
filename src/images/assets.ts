import { createHash, randomUUID } from 'node:crypto';

import type {
  AssetBytesLocation,
  AssetChecksum,
  AssetDescriptor,
  AssetInput,
  AssetProvenance,
} from '../types/images.js';

const DEFAULT_MAX_ENTRIES = 1_000;
const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_ASSET_BYTES = 10 * 1024 * 1024;

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

function validateByteInput(input: ByteAssetInput): ByteAssetInput {
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

function createStoredDescriptor(
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

function statFromEntry(entry: MemoryAssetEntry): AssetStat {
  return {
    assetId: entry.assetId,
    tenantId: entry.tenantId,
    descriptor: cloneDescriptor(entry.descriptor),
    createdAt: new Date(entry.createdAtMs).toISOString(),
    ...(entry.expiresAtMs === undefined ? {} : { expiresAt: new Date(entry.expiresAtMs).toISOString() }),
  };
}

function cloneDescriptor(descriptor: AssetDescriptor): AssetDescriptor {
  return {
    ...descriptor,
    location: { ...descriptor.location },
    checksum: descriptor.checksum ? cloneChecksum(descriptor.checksum) : undefined,
    metadata: descriptor.metadata ? { ...descriptor.metadata } : undefined,
    provenance: cloneProvenance(descriptor.provenance),
  };
}

function cloneAndValidateProvenance(provenance: AssetProvenance): AssetProvenance {
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

function cloneProvenance(provenance: AssetProvenance): AssetProvenance {
  return {
    ...provenance,
    parentAssetIds: provenance.parentAssetIds ? [...provenance.parentAssetIds] : undefined,
    metadata: provenance.metadata ? { ...provenance.metadata } : undefined,
  };
}

function cloneChecksum(checksum: AssetChecksum): AssetChecksum {
  if (!checksum || typeof checksum !== 'object') throw new AssetStoreValidationError('checksum must be an object');
  return {
    algorithm: nonEmptyString(checksum.algorithm, 'checksum.algorithm'),
    value: nonEmptyString(checksum.value, 'checksum.value'),
  };
}

function sha256Checksum(bytes: Uint8Array, supplied?: AssetChecksum): AssetChecksum {
  const value = createHash('sha256').update(bytes).digest('hex');
  if (supplied && supplied.algorithm.toLowerCase().replaceAll('-', '') === 'sha256') {
    if (supplied.value.toLowerCase() !== value) {
      throw new AssetStoreValidationError('Supplied SHA-256 checksum does not match the asset bytes');
    }
  }
  return { algorithm: 'sha256', value };
}

function resolveExpiration(
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

function capacityOption(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new AssetStoreValidationError(`${name} must be a non-negative safe integer`);
  }
  return normalized;
}

function optionalPositiveNumber(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) {
    throw new AssetStoreValidationError(`${name} must be a positive finite number`);
  }
  return value;
}

function optionalDimension(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new AssetStoreValidationError(`${name} must be a positive integer`);
  }
  return value;
}

function nonEmptyString(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new AssetStoreValidationError(`${name} must not be empty`);
  return value.trim();
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
