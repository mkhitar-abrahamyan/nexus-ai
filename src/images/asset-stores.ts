import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rm, stat as statFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import type { AssetChecksum, AssetDescriptor } from '../types/images.js';
import {
  AssetMeter,
  type AssetStreamOptions,
  bytesAsStream,
  collectBytes,
  DEFAULT_BUFFERED_ASSET_BYTES,
  resolveRange,
  type StreamAssetDescriptor,
  type StreamAssetInput,
  streamFrom,
  validateStreamInput,
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

/** Options for a store that keeps assets as files on local disk. */
export interface FilesystemAssetStoreOptions {
  /** Directory the store owns. Created on first write if missing. */
  directory: string;
  /** Largest single asset accepted, in bytes. */
  maxAssetBytes?: number;
  /**
   * Lifetime for assets stored without their own, in seconds. Without it, assets are kept until
   * deleted.
   */
  defaultTtlSeconds?: number;
  /** Creates asset ids. Defaults to random ids. */
  createAssetId?: () => string;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
  /**
   * Produces URLs for `sign()`, such as a route on your own server. Without one, signing throws.
   */
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
    this.createAssetId = options.createAssetId ?? (() => globalThis.crypto.randomUUID());
    this.clock = options.now ?? (() => new Date());
    this.signer = options.signer;
  }

  /** Writes an asset and its metadata to disk. */
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

  /**
   * Reads an asset with its bytes, or `undefined` when it does not exist, has expired, or belongs
   * to another tenant.
   */
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

  /**
   * Writes a streamed asset to disk a chunk at a time, as fast as the disk takes it, never holding
   * the whole asset. The size limit and checksum are checked as the bytes flow, and an asset that
   * fails either leaves no file behind.
   */
  async putStream(input: StreamAssetInput, options: AssetPutOptions): Promise<AssetStat> {
    const nowMs = this.clock().getTime();
    const normalized = validateStreamInput(input);
    const tenantId = nonEmptyString(options?.tenantId, 'tenantId');
    const provenance = cloneAndValidateProvenance(options?.provenance);
    const width = optionalDimension(options?.width, 'width');
    const height = optionalDimension(options?.height, 'height');
    const expiresAtMs = resolveExpiration(options, this.defaultTtlSeconds, nowMs);
    const assetId = nonEmptyString(this.createAssetId(), 'createAssetId() result');
    assertSafeAssetId(assetId);

    await mkdir(this.directory, { recursive: true });
    const meter = new AssetMeter(this.maxAssetBytes);
    const file = await open(this.assetPath(assetId), 'w');
    let checksum: AssetChecksum;
    try {
      for await (const chunk of meter.chunks(normalized.stream)) await file.write(chunk);
      await file.close();
      checksum = meter.checksum(normalized.checksum);
    } catch (error) {
      await file.close().catch(() => undefined);
      await rm(this.assetPath(assetId), { force: true });
      throw error;
    }

    const descriptor = createStoredDescriptor(
      assetId,
      normalized,
      provenance,
      checksum,
      meter.byteLength,
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
    await writeFile(this.recordPath(assetId), JSON.stringify(record), 'utf8');
    return toStat(record);
  }

  /** Reads an asset, or a range of it, from disk as a stream, or `undefined` as `get()` would. */
  async getStream(
    assetId: string,
    tenantId: string,
    options: AssetStreamOptions = {},
  ): Promise<StreamAssetDescriptor | undefined> {
    const record = await this.ownedRecord(assetId, tenantId);
    if (!record) return undefined;
    let size: number;
    try {
      size = (await statFile(this.assetPath(record.assetId))).size;
    } catch {
      return undefined;
    }
    const range = resolveRange(options.range, size);
    const stream =
      range.end < range.start
        ? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() })
        : (Readable.toWeb(
            createReadStream(this.assetPath(record.assetId), { start: range.start, end: range.end }),
          ) as ReadableStream<Uint8Array>);
    return { descriptor: cloneDescriptor(record.descriptor), stream, range };
  }

  /** Describes an asset without reading its bytes. */
  async stat(assetId: string, tenantId: string): Promise<AssetStat | undefined> {
    const record = await this.ownedRecord(assetId, tenantId);
    return record ? toStat(record) : undefined;
  }

  /** Deletes an asset. Resolves `true` when it existed. */
  async delete(assetId: string, tenantId: string): Promise<true | undefined> {
    const record = await this.ownedRecord(assetId, tenantId);
    if (!record) return undefined;
    await this.removeFiles(record.assetId);
    return true;
  }

  /** Returns a URL from the configured signer. Throws when no signer is configured. */
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

  /** Deletes expired assets, returning how many went. */
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
  /** Writes an object. */
  putObject(input: {
    bucket: string;
    key: string;
    body: Uint8Array;
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<void>;
  /** Reads an object and its metadata. */
  getObject(input: { bucket: string; key: string }): Promise<{ body: Uint8Array; metadata?: Record<string, string> }>;
  /** Reads an object's metadata without its body. */
  headObject?(input: { bucket: string; key: string }): Promise<{ metadata?: Record<string, string> } | undefined>;
  /** Deletes an object. */
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
  /** Lists objects under a prefix. */
  listObjects(input: { bucket: string; prefix: string }): Promise<Array<{ key: string }>>;
  /** Produces a presigned URL for an object. */
  getSignedUrl?(input: { bucket: string; key: string; expiresInSeconds?: number }): Promise<string>;
  /**
   * Writes an object from a stream, as a multipart upload does, for content too large to buffer.
   * With `@aws-sdk/lib-storage`, an `Upload` over the body. Optional: without it, a streamed asset is
   * buffered within `maxAssetBytes` and written with `putObject()`.
   */
  putObjectStream?(input: {
    bucket: string;
    key: string;
    body: ReadableStream<Uint8Array>;
    contentType?: string;
    metadata?: Record<string, string>;
  }): Promise<void>;
  /**
   * Reads an object, or the range of it, both ends inclusive, as a stream. Optional: without it, the
   * object is read whole with `getObject()`.
   */
  getObjectStream?(input: {
    bucket: string;
    key: string;
    range?: { start: number; end: number };
  }): Promise<{ body: ReadableStream<Uint8Array> }>;
}

/** Options for a store that keeps assets in an S3-compatible bucket. */
export interface S3AssetStoreOptions {
  /** The S3 client, through the structural interface above, so no AWS SDK becomes a dependency. */
  client: S3LikeClient;
  /** The bucket the store writes to. */
  bucket: string;
  /** Key prefix owned by this store. Defaults to `nexus-assets/`. */
  prefix?: string;
  /** Largest single asset accepted, in bytes. */
  maxAssetBytes?: number;
  /**
   * Lifetime for assets stored without their own, in seconds. Without it, assets are kept until
   * deleted.
   */
  defaultTtlSeconds?: number;
  /** Creates asset ids. Defaults to random ids. */
  createAssetId?: () => string;
  /** Replaces the system clock, for tests. */
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
    this.createAssetId = options.createAssetId ?? (() => globalThis.crypto.randomUUID());
    this.clock = options.now ?? (() => new Date());
    this.signer = options.signer;
  }

  /** Writes an asset and its metadata to the bucket. */
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

  /**
   * Reads an asset with its bytes, or `undefined` when it does not exist, has expired, or belongs
   * to another tenant.
   */
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

  /**
   * Stores a streamed asset. With a client that has `putObjectStream()`, the bytes flow straight to the
   * bucket, checked against the size limit and hashed on the way; the object's metadata then carries
   * the tenant, since the checksum is known only at the end, and the sidecar carries both. Without
   * one, the stream is read into memory within `maxAssetBytes` (64 MiB when unset) and stored by `put()`.
   */
  async putStream(input: StreamAssetInput, options: AssetPutOptions): Promise<AssetStat> {
    const client = this.options.client;
    if (!client.putObjectStream) {
      const normalized = validateStreamInput(input);
      const limit = this.maxAssetBytes ?? DEFAULT_BUFFERED_ASSET_BYTES;
      const data = await collectBytes(normalized.stream, limit, 'maxAssetBytes');
      const { stream: _stream, ...rest } = normalized;
      return this.put({ ...rest, location: { kind: 'bytes', data } }, options);
    }
    const nowMs = this.clock().getTime();
    const normalized = validateStreamInput(input);
    const tenantId = nonEmptyString(options?.tenantId, 'tenantId');
    const provenance = cloneAndValidateProvenance(options?.provenance);
    const width = optionalDimension(options?.width, 'width');
    const height = optionalDimension(options?.height, 'height');
    const expiresAtMs = resolveExpiration(options, this.defaultTtlSeconds, nowMs);
    const assetId = nonEmptyString(this.createAssetId(), 'createAssetId() result');
    assertSafeAssetId(assetId);

    const meter = new AssetMeter(this.maxAssetBytes);
    const key = this.objectKey(assetId);
    let checksum: AssetChecksum;
    try {
      await client.putObjectStream({
        bucket: this.options.bucket,
        key,
        body: streamFrom(meter.chunks(normalized.stream)),
        contentType: normalized.mimeType,
        metadata: { tenant: tenantId },
      });
      checksum = meter.checksum(normalized.checksum);
    } catch (error) {
      await client.deleteObject({ bucket: this.options.bucket, key }).catch(() => undefined);
      throw error;
    }

    const descriptor = createStoredDescriptor(
      assetId,
      normalized,
      provenance,
      checksum,
      meter.byteLength,
      width,
      height,
    );
    descriptor.location = { kind: 'stored', assetId, uri: `s3://${this.options.bucket}/${key}` };
    const record: StoredRecord = {
      assetId,
      tenantId,
      descriptor,
      createdAt: new Date(nowMs).toISOString(),
      ...(expiresAtMs === undefined ? {} : { expiresAt: new Date(expiresAtMs).toISOString() }),
    };
    await client.putObject({
      bucket: this.options.bucket,
      key: this.recordKey(assetId),
      body: new TextEncoder().encode(JSON.stringify(record)),
      contentType: 'application/json',
    });
    return toStat(record);
  }

  /**
   * Reads an asset, or a range of it, as a stream: straight from the bucket with a client that has
   * `getObjectStream()`, otherwise from `getObject()`.
   */
  async getStream(
    assetId: string,
    tenantId: string,
    options: AssetStreamOptions = {},
  ): Promise<StreamAssetDescriptor | undefined> {
    const record = await this.ownedRecord(assetId, tenantId);
    if (!record) return undefined;
    const descriptor = cloneDescriptor(record.descriptor);
    const client = this.options.client;
    const key = this.objectKey(record.assetId);
    try {
      if (client.getObjectStream && descriptor.byteLength !== undefined) {
        const range = resolveRange(options.range, descriptor.byteLength);
        if (range.end < range.start) {
          return { descriptor, stream: new ReadableStream({ start: (controller) => controller.close() }), range };
        }
        const object = await client.getObjectStream({ bucket: this.options.bucket, key, range });
        return { descriptor, stream: object.body, range };
      }
      const object = await client.getObject({ bucket: this.options.bucket, key });
      return bytesAsStream(descriptor, new Uint8Array(object.body), options.range);
    } catch (error) {
      if (error instanceof AssetStoreValidationError) throw error;
      return undefined;
    }
  }

  /** Describes an asset without reading its bytes. */
  async stat(assetId: string, tenantId: string): Promise<AssetStat | undefined> {
    const record = await this.ownedRecord(assetId, tenantId);
    return record ? toStat(record) : undefined;
  }

  /** Deletes an asset. Resolves `true` when it existed. */
  async delete(assetId: string, tenantId: string): Promise<true | undefined> {
    const record = await this.ownedRecord(assetId, tenantId);
    if (!record) return undefined;
    await this.removeObjects(record.assetId);
    return true;
  }

  /** Returns a presigned URL from the configured signer or the client's own. */
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

  /** Deletes expired assets, returning how many went. */
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
