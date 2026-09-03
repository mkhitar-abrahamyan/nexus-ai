import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AssetDescriptor } from '../types/images.js';
import {
  AssetStoreCapacityError,
  AssetStoreSigningError,
  AssetStoreValidationError,
  cloneAndValidateProvenance,
  cloneDescriptor,
  createStoredDescriptor,
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
} from './asset-support.js';

interface StoredRecord {
  assetId: string;
  tenantId: string;
  descriptor: AssetDescriptor;
  createdAt: string;
  expiresAt?: string;
}

export interface FilesystemAssetStoreOptions {
  /** Directory the store owns. Created on first write if missing. */
  directory: string;
  maxAssetBytes?: number;
  defaultTtlSeconds?: number;
  createAssetId?: () => string;
  now?: () => Date;
  signer?: AssetSigner;
}

/**
 * Asset persistence on local disk.
 *
 * Each asset is two files: the bytes, and a JSON sidecar holding the descriptor, tenant, and
 * expiry. Metadata is deliberately not kept in one index file — a single index is a write-contention
 * point and a corruption blast radius, whereas per-asset sidecars let two processes write different
 * assets concurrently and lose at most one record if a write is interrupted.
 *
 * Suitable for a single host or a shared volume. It does not coordinate deletes across processes,
 * so a purge running in two places may both attempt the same removal; that is idempotent here.
 */
export class FilesystemAssetStore implements AssetStore {
  private readonly directory: string;
  private readonly maxAssetBytes?: number;
  private readonly defaultTtlSeconds?: number;
  private readonly createAssetId: () => string;
  private readonly clock: () => Date;
  private readonly signer?: AssetSigner;

  constructor(options: FilesystemAssetStoreOptions) {
    this.directory = nonEmptyString(options?.directory, 'directory');
    this.maxAssetBytes = optionalPositiveNumber(options.maxAssetBytes, 'maxAssetBytes');
    this.defaultTtlSeconds = optionalPositiveNumber(options.defaultTtlSeconds, 'defaultTtlSeconds');
    this.createAssetId = options.createAssetId ?? randomUUID;
    this.clock = options.now ?? (() => new Date());
    this.signer = options.signer;
  }

  async put(input: ByteAssetInput, options: AssetPutOptions): Promise<AssetStat> {
    const nowMs = this.clock().getTime();
    const normalized = validateByteInput(input);
    const tenantId = nonEmptyString(options?.tenantId, 'tenantId');
    const provenance = cloneAndValidateProvenance(options?.provenance);
    const width = optionalDimension(options?.width, 'width');
    const height = optionalDimension(options?.height, 'height');
    const expiresAtMs = resolveExpiration(options, this.defaultTtlSeconds, nowMs);
    const bytes = new Uint8Array(normalized.location.data);

    if (this.maxAssetBytes !== undefined && bytes.byteLength > this.maxAssetBytes) {
      throw new AssetStoreCapacityError('maxAssetBytes', this.maxAssetBytes, 0, bytes.byteLength);
    }

    const checksum = sha256Checksum(bytes, normalized.checksum);
    const assetId = nonEmptyString(this.createAssetId(), 'createAssetId() result');
    assertSafeAssetId(assetId);

    const descriptor = createStoredDescriptor(
      assetId,
      normalized,
      provenance,
      checksum,
      bytes.byteLength,
      width,
      height,
    );
    descriptor.location = { kind: 'stored', assetId, uri: `file://${this.assetPath(assetId)}` };

    const record: StoredRecord = {
      assetId,
      tenantId,
      descriptor,
      createdAt: new Date(nowMs).toISOString(),
      ...(expiresAtMs === undefined ? {} : { expiresAt: new Date(expiresAtMs).toISOString() }),
    };

    await mkdir(this.directory, { recursive: true });
    // Bytes first: a sidecar with no payload would be a record pointing at nothing, while payload
    // with no sidecar is invisible and cleaned up by purge.
    await writeFile(this.assetPath(assetId), bytes);
    await writeFile(this.recordPath(assetId), JSON.stringify(record), 'utf8');

    return toStat(record);
  }

  async get(assetId: string, tenantId: string): Promise<ByteAssetDescriptor | undefined> {
    const record = await this.ownedRecord(assetId, tenantId);
    if (!record) return undefined;

    let data: Uint8Array;
    try {
      data = new Uint8Array(await readFile(this.assetPath(record.assetId)));
    } catch {
      return undefined;
    }
    return { ...cloneDescriptor(record.descriptor), location: { kind: 'bytes', data } };
  }

  async stat(assetId: string, tenantId: string): Promise<AssetStat | undefined> {
    const record = await this.ownedRecord(assetId, tenantId);
    return record ? toStat(record) : undefined;
  }

  async delete(assetId: string, tenantId: string): Promise<true | undefined> {
    const record = await this.ownedRecord(assetId, tenantId);
    if (!record) return undefined;
    await this.removeFiles(record.assetId);
    return true;
  }

  async sign(assetId: string, tenantId: string, options: AssetSignOptions = {}): Promise<string | undefined> {
    if (!this.signer) throw new AssetStoreSigningError('Asset signing requires a configured signer');
    const expiresInSeconds = optionalPositiveNumber(options.expiresInSeconds, 'expiresInSeconds');
    const record = await this.ownedRecord(assetId, tenantId);
    if (!record) return undefined;

    try {
      const value = await this.signer({
        ...toStat(record),
        now: this.clock().toISOString(),
        ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
      });
      return String(value);
    } catch (error) {
      if (error instanceof AssetStoreSigningError) throw error;
      throw new AssetStoreSigningError(`Failed to sign asset "${record.assetId}"`, error);
    }
  }

  async purgeExpired(): Promise<number> {
    let removed = 0;
    const now = this.clock().getTime();
    let files: string[];
    try {
      files = await readdir(this.directory);
    } catch {
      return 0;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const assetId = file.slice(0, -'.json'.length);
      const record = await this.readRecord(assetId);
      if (!record?.expiresAt) continue;
      if (new Date(record.expiresAt).getTime() <= now) {
        await this.removeFiles(assetId);
        removed += 1;
      }
    }
    return removed;
  }

  private async ownedRecord(assetId: string, tenantId: string): Promise<StoredRecord | undefined> {
    const normalizedAssetId = nonEmptyString(assetId, 'assetId');
    const normalizedTenantId = nonEmptyString(tenantId, 'tenantId');
    assertSafeAssetId(normalizedAssetId);

    const record = await this.readRecord(normalizedAssetId);
    if (!record) return undefined;
    // A missing asset and one owned by another tenant must be indistinguishable.
    if (record.tenantId !== normalizedTenantId) return undefined;
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= this.clock().getTime()) {
      await this.removeFiles(normalizedAssetId);
      return undefined;
    }
    return record;
  }

  private async readRecord(assetId: string): Promise<StoredRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.recordPath(assetId), 'utf8')) as StoredRecord;
    } catch {
      return undefined;
    }
  }

  private async removeFiles(assetId: string): Promise<void> {
    await rm(this.assetPath(assetId), { force: true });
    await rm(this.recordPath(assetId), { force: true });
  }

  private assetPath(assetId: string): string {
    return path.join(this.directory, `${assetId}.bin`);
  }

  private recordPath(assetId: string): string {
    return path.join(this.directory, `${assetId}.json`);
  }
}

/**
 * The S3 operations the store needs.
 *
 * Structural rather than importing the AWS SDK, so this package stays dependency-free and the same
 * contract covers S3, R2, MinIO, or a test double.
 */
export interface S3LikeClient {
  putObject(input: {
    bucket: string;
    key: string;
    body: Uint8Array;
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<void>;
  getObject(input: { bucket: string; key: string }): Promise<{ body: Uint8Array; metadata?: Record<string, string> }>;
  headObject?(input: { bucket: string; key: string }): Promise<{ metadata?: Record<string, string> } | undefined>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
  listObjects(input: { bucket: string; prefix: string }): Promise<Array<{ key: string }>>;
  getSignedUrl?(input: { bucket: string; key: string; expiresInSeconds?: number }): Promise<string>;
}

export interface S3AssetStoreOptions {
  client: S3LikeClient;
  bucket: string;
  /** Key prefix owned by this store. Defaults to `nexus-assets/`. */
  prefix?: string;
  maxAssetBytes?: number;
  defaultTtlSeconds?: number;
  createAssetId?: () => string;
  now?: () => Date;
  /** Overrides the client's own signer. */
  signer?: AssetSigner;
}

/**
 * Asset persistence on any S3-compatible object store.
 *
 * Bytes and a JSON sidecar are two objects under the same key prefix, mirroring the filesystem
 * store, so retention and tenant rules behave identically across both.
 *
 * `purgeExpired()` lists and deletes lapsed sidecars, which costs a LIST per call. On a large bucket
 * prefer the provider's own lifecycle rules and treat this as the fallback for stores that have
 * none; the method is exact but not cheap, and that trade is deliberate rather than hidden.
 */
export class S3AssetStore implements AssetStore {
  private readonly prefix: string;
  private readonly maxAssetBytes?: number;
  private readonly defaultTtlSeconds?: number;
  private readonly createAssetId: () => string;
  private readonly clock: () => Date;
  private readonly signer?: AssetSigner;

  constructor(private readonly options: S3AssetStoreOptions) {
    if (!options?.client) throw new AssetStoreValidationError('An S3-compatible client is required');
    nonEmptyString(options.bucket, 'bucket');
    this.prefix = (options.prefix ?? 'nexus-assets/').replace(/^\/+/, '');
    this.maxAssetBytes = optionalPositiveNumber(options.maxAssetBytes, 'maxAssetBytes');
    this.defaultTtlSeconds = optionalPositiveNumber(options.defaultTtlSeconds, 'defaultTtlSeconds');
    this.createAssetId = options.createAssetId ?? randomUUID;
    this.clock = options.now ?? (() => new Date());
    this.signer = options.signer;
  }

  async put(input: ByteAssetInput, options: AssetPutOptions): Promise<AssetStat> {
    const nowMs = this.clock().getTime();
    const normalized = validateByteInput(input);
    const tenantId = nonEmptyString(options?.tenantId, 'tenantId');
    const provenance = cloneAndValidateProvenance(options?.provenance);
    const width = optionalDimension(options?.width, 'width');
    const height = optionalDimension(options?.height, 'height');
    const expiresAtMs = resolveExpiration(options, this.defaultTtlSeconds, nowMs);
    const bytes = new Uint8Array(normalized.location.data);

    if (this.maxAssetBytes !== undefined && bytes.byteLength > this.maxAssetBytes) {
      throw new AssetStoreCapacityError('maxAssetBytes', this.maxAssetBytes, 0, bytes.byteLength);
    }

    const checksum = sha256Checksum(bytes, normalized.checksum);
    const assetId = nonEmptyString(this.createAssetId(), 'createAssetId() result');
    assertSafeAssetId(assetId);

    const descriptor = createStoredDescriptor(
      assetId,
      normalized,
      provenance,
      checksum,
      bytes.byteLength,
      width,
      height,
    );
    descriptor.location = {
      kind: 'stored',
      assetId,
      uri: `s3://${this.options.bucket}/${this.objectKey(assetId)}`,
    };

    const record: StoredRecord = {
      assetId,
      tenantId,
      descriptor,
      createdAt: new Date(nowMs).toISOString(),
      ...(expiresAtMs === undefined ? {} : { expiresAt: new Date(expiresAtMs).toISOString() }),
    };

    await this.options.client.putObject({
      bucket: this.options.bucket,
      key: this.objectKey(assetId),
      body: bytes,
      contentType: normalized.mimeType,
      // The tenant is duplicated onto object metadata so a bucket policy or lifecycle rule can act
      // on it without parsing the sidecar.
      metadata: { tenant: tenantId, checksum: checksum.value },
    });
    await this.options.client.putObject({
      bucket: this.options.bucket,
      key: this.recordKey(assetId),
      body: new TextEncoder().encode(JSON.stringify(record)),
      contentType: 'application/json',
    });

    return toStat(record);
  }

  async get(assetId: string, tenantId: string): Promise<ByteAssetDescriptor | undefined> {
    const record = await this.ownedRecord(assetId, tenantId);
    if (!record) return undefined;

    try {
      const object = await this.options.client.getObject({
        bucket: this.options.bucket,
        key: this.objectKey(record.assetId),
      });
      return {
        ...cloneDescriptor(record.descriptor),
        location: { kind: 'bytes', data: new Uint8Array(object.body) },
      };
    } catch {
      return undefined;
    }
  }

  async stat(assetId: string, tenantId: string): Promise<AssetStat | undefined> {
    const record = await this.ownedRecord(assetId, tenantId);
    return record ? toStat(record) : undefined;
  }

  async delete(assetId: string, tenantId: string): Promise<true | undefined> {
    const record = await this.ownedRecord(assetId, tenantId);
    if (!record) return undefined;
    await this.removeObjects(record.assetId);
    return true;
  }

  async sign(assetId: string, tenantId: string, options: AssetSignOptions = {}): Promise<string | undefined> {
    const expiresInSeconds = optionalPositiveNumber(options.expiresInSeconds, 'expiresInSeconds');
    const record = await this.ownedRecord(assetId, tenantId);
    if (!record) return undefined;

    try {
      if (this.signer) {
        const value = await this.signer({
          ...toStat(record),
          now: this.clock().toISOString(),
          ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }),
        });
        return String(value);
      }
      if (this.options.client.getSignedUrl) {
        return await this.options.client.getSignedUrl({
          bucket: this.options.bucket,
          key: this.objectKey(record.assetId),
          expiresInSeconds,
        });
      }
    } catch (error) {
      if (error instanceof AssetStoreSigningError) throw error;
      throw new AssetStoreSigningError(`Failed to sign asset "${record.assetId}"`, error);
    }

    throw new AssetStoreSigningError('Asset signing requires a signer or a client that can presign');
  }

  async purgeExpired(): Promise<number> {
    const now = this.clock().getTime();
    const objects = await this.options.client.listObjects({
      bucket: this.options.bucket,
      prefix: `${this.prefix}records/`,
    });

    let removed = 0;
    for (const object of objects) {
      const assetId = object.key.slice(`${this.prefix}records/`.length).replace(/\.json$/, '');
      if (!assetId) continue;
      const record = await this.readRecord(assetId);
      if (!record?.expiresAt) continue;
      if (new Date(record.expiresAt).getTime() <= now) {
        await this.removeObjects(assetId);
        removed += 1;
      }
    }
    return removed;
  }

  private async ownedRecord(assetId: string, tenantId: string): Promise<StoredRecord | undefined> {
    const normalizedAssetId = nonEmptyString(assetId, 'assetId');
    const normalizedTenantId = nonEmptyString(tenantId, 'tenantId');
    assertSafeAssetId(normalizedAssetId);

    const record = await this.readRecord(normalizedAssetId);
    if (!record) return undefined;
    if (record.tenantId !== normalizedTenantId) return undefined;
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= this.clock().getTime()) {
      await this.removeObjects(normalizedAssetId);
      return undefined;
    }
    return record;
  }

  private async readRecord(assetId: string): Promise<StoredRecord | undefined> {
    try {
      const object = await this.options.client.getObject({
        bucket: this.options.bucket,
        key: this.recordKey(assetId),
      });
      return JSON.parse(new TextDecoder().decode(object.body)) as StoredRecord;
    } catch {
      return undefined;
    }
  }

  private async removeObjects(assetId: string): Promise<void> {
    await this.options.client.deleteObject({ bucket: this.options.bucket, key: this.objectKey(assetId) });
    await this.options.client.deleteObject({ bucket: this.options.bucket, key: this.recordKey(assetId) });
  }

  private objectKey(assetId: string): string {
    return `${this.prefix}objects/${assetId}`;
  }

  private recordKey(assetId: string): string {
    return `${this.prefix}records/${assetId}.json`;
  }
}

function toStat(record: StoredRecord): AssetStat {
  return {
    assetId: record.assetId,
    tenantId: record.tenantId,
    descriptor: cloneDescriptor(record.descriptor),
    createdAt: record.createdAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
  };
}

/**
 * Rejects an asset id that could escape the store's own directory or key prefix.
 *
 * The id reaches a filesystem path and an object key, so a caller-supplied `createAssetId` that
 * returned `../../etc/passwd` would otherwise read and write outside the store.
 */
function assertSafeAssetId(assetId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(assetId) || assetId === '.' || assetId === '..') {
    throw new AssetStoreValidationError(
      `assetId must contain only letters, digits, dot, underscore, or hyphen: received "${assetId}"`,
    );
  }
}
