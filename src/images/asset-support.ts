import { createSha256, sha256Hex } from '../utils/sha256.js';
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
  /**
   * The asset's bytes. A store only accepts content it can hold, not a URL or another store's
   * reference.
   */
  location: AssetBytesLocation;
}

/** A retrieved asset descriptor whose byte payload is available to the caller. */
export interface ByteAssetDescriptor extends Omit<AssetDescriptor, 'location'> {
  /** The asset's bytes. */
  location: AssetBytesLocation;
}

/** How an asset is stored: who owns it, where it came from, and how long it is kept. */
export interface AssetPutOptions {
  /** Tenant that owns the asset. This value is required for every later access. */
  tenantId: string;
  /** Where the asset came from. */
  provenance: AssetProvenance;
  /** Width in pixels, when known. */
  width?: number;
  /** Height in pixels, when known. */
  height?: number;
  /** Relative retention period. Mutually exclusive with `expiresAt`. */
  ttlSeconds?: number;
  /** Absolute retention deadline. Mutually exclusive with `ttlSeconds`. */
  expiresAt?: Date | string;
}

/** What a store knows about an asset without reading its bytes. */
export interface AssetStat {
  /** The store's id for the asset. */
  assetId: string;
  /** The tenant that owns it. */
  tenantId: string;
  /** Metadata-only descriptor. Its location points back to this store, not to the byte payload. */
  descriptor: AssetDescriptor;
  /** ISO-8601 time it was stored. */
  createdAt: string;
  /** ISO-8601 time it expires, when it does. */
  expiresAt?: string;
}

/** Options for a signed URL. */
export interface AssetSignOptions {
  /** Requested signed-URL lifetime. Enforcement is delegated to the configured signer. */
  expiresInSeconds?: number;
}

/** What a signer receives: the asset, the time, and the lifetime asked for. */
export interface AssetSignerContext extends AssetStat {
  /** The current time, ISO-8601. */
  now: string;
  /** Lifetime requested for the URL, in seconds. */
  expiresInSeconds?: number;
}

/**
 * Turns an asset into a URL a client can fetch, such as a presigned S3 URL or a route on your own
 * server.
 */
export type AssetSigner = (context: AssetSignerContext) => string | URL | Promise<string | URL>;

/** Bytes as they arrive: a web stream, or any async iterable of chunks, such as a Node.js stream. */
export type AssetByteSource = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;

/** An asset whose bytes arrive as a stream, for content too large to hold in memory at once. */
export interface StreamAssetInput extends Omit<AssetInput, 'location'> {
  /** The bytes. Read once. */
  stream: AssetByteSource;
}

/** A range of an asset's bytes, both ends inclusive, as an HTTP `Range` header has them. */
export interface AssetByteRange {
  /** The first byte. Defaults to 0. */
  start?: number;
  /** The last byte. Defaults to the asset's last. */
  end?: number;
}

/** How an asset is read as a stream. */
export interface AssetStreamOptions {
  /** Only these bytes, for a resumed download or a seek. */
  range?: AssetByteRange;
}

/** An asset read as a stream: what the store knows of it, and its bytes, or the range asked for. */
export interface StreamAssetDescriptor {
  /** Metadata-only descriptor. Its location points back to the store. */
  descriptor: AssetDescriptor;
  /** The bytes. */
  stream: ReadableStream<Uint8Array>;
  /** The bytes the stream holds, both ends inclusive. Empty when `end` is below `start`. */
  range: { start: number; end: number };
}

/** A value a store method returns, synchronously or asynchronously. */
export type AssetStoreResult<T> = T | Promise<T>;

/**
 * Provider-neutral asset persistence contract.
 *
 * A store must treat a missing asset and an asset owned by another tenant identically. Implementations
 * may complete synchronously or asynchronously so the same contract can cover memory and remote stores.
 */
export interface AssetStore {
  /** Stores an asset. Throws `AssetStoreCapacityError` when it would not fit. */
  put(input: ByteAssetInput, options: AssetPutOptions): AssetStoreResult<AssetStat>;
  /**
   * Reads an asset with its bytes, or `undefined` when it does not exist, has expired, or belongs
   * to another tenant.
   */
  get(assetId: string, tenantId: string): AssetStoreResult<ByteAssetDescriptor | undefined>;
  /** Describes an asset without reading its bytes. */
  stat(assetId: string, tenantId: string): AssetStoreResult<AssetStat | undefined>;
  /** Deletes an asset. Resolves `true` when it existed. */
  delete(assetId: string, tenantId: string): AssetStoreResult<true | undefined>;
  /**
   * Returns a URL for the asset from the configured signer, or `undefined` when the asset does not
   * exist.
   */
  sign(assetId: string, tenantId: string, options?: AssetSignOptions): AssetStoreResult<string | undefined>;
  /** Deletes expired assets, returning how many went. */
  purgeExpired(): AssetStoreResult<number>;
  /**
   * Stores an asset whose bytes arrive as a stream, never holding them all at once, and checks its
   * size limit and checksum as they flow. Optional: `putAssetStream()` falls back to `put()`.
   */
  putStream?(input: StreamAssetInput, options: AssetPutOptions): Promise<AssetStat>;
  /**
   * Reads an asset, or a range of it, as a stream, or `undefined` as `get()` would. Optional:
   * `readAssetStream()` falls back to `get()`.
   */
  getStream?(
    assetId: string,
    tenantId: string,
    options?: AssetStreamOptions,
  ): Promise<StreamAssetDescriptor | undefined>;
}

/** Limits and behaviour for the in-process asset store. */
export interface MemoryAssetStoreOptions {
  /** Most assets held at once. Defaults to 1,000. */
  maxEntries?: number;
  /** Most bytes held in total. Defaults to 64 MiB. */
  maxTotalBytes?: number;
  /** Largest single asset accepted. Defaults to 10 MiB. */
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
  /** Produces URLs for `sign()`. Without one, signing is refused. */
  signer?: AssetSigner;
}

/** What the in-process store currently holds, against its limits. */
export interface MemoryAssetStoreSnapshot {
  /** Assets held. */
  entries: number;
  /** Bytes held. */
  totalBytes: number;
  /** Most assets allowed. */
  maxEntries: number;
  /** Most bytes allowed. */
  maxTotalBytes: number;
  /** Largest single asset allowed. */
  maxAssetBytes: number;
}

/** Base class for asset store failures. */
export class AssetStoreError extends Error {
  constructor(
    message: string,
    /** Stable code for the failure. */
    public readonly code: string,
    /** The underlying error, when there was one. */
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AssetStoreError';
  }
}

/** Raised when an asset or its options are invalid. */
export class AssetStoreValidationError extends AssetStoreError {
  constructor(message: string, cause?: unknown) {
    super(message, 'ASSET_STORE_VALIDATION_ERROR', cause);
    this.name = 'AssetStoreValidationError';
  }
}

/** Which store limit a request ran into. */
export type AssetCapacityConstraint = 'maxEntries' | 'maxTotalBytes' | 'maxAssetBytes';

/**
 * Raised when an asset would exceed a store limit. Carries the limit, what is held, and what was
 * asked for.
 */
export class AssetStoreCapacityError extends AssetStoreError {
  constructor(
    /** The limit that was hit. */
    public readonly constraint: AssetCapacityConstraint,
    /** The limit's value. */
    public readonly maximum: number,
    /** What the store holds now. */
    public readonly current: number,
    /** What the asset would add. */
    public readonly requested: number,
  ) {
    super(
      `Asset store capacity ${constraint} exceeded (maximum ${maximum}, current ${current}, requested ${requested})`,
      'ASSET_STORE_CAPACITY_EXCEEDED',
    );
    this.name = 'AssetStoreCapacityError';
  }
}

/** Raised when a signed URL cannot be produced. */
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
  input: Pick<AssetInput, 'mimeType' | 'filename' | 'metadata'>,
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
  if (provenance.operation !== 'generate' && provenance.operation !== 'edit' && provenance.operation !== 'upload') {
    throw new AssetStoreValidationError('provenance.operation must be "generate", "edit", or "upload"');
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
  const value = sha256Hex(bytes);
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

// ── Streams ───────────────────────────────────────────────────────

/** How much a store that cannot stream reads into memory for `putAssetStream()`. 64 MiB. */
export const DEFAULT_BUFFERED_ASSET_BYTES = 64 * 1024 * 1024;

/** Options for `putAssetStream()`: how the asset is stored, and how much a store that cannot stream may buffer. */
export interface PutAssetStreamOptions extends AssetPutOptions {
  /** Most bytes read into memory for a store without `putStream()`. Defaults to 64 MiB. */
  maxBufferedBytes?: number;
}

/**
 * Stores a streamed asset in any store: through `putStream()` when the store has it, and otherwise by
 * reading the stream into memory, up to `maxBufferedBytes`, and calling `put()`.
 */
export async function putAssetStream(
  store: AssetStore,
  input: StreamAssetInput,
  options: PutAssetStreamOptions,
): Promise<AssetStat> {
  if (store.putStream) return store.putStream(input, options);
  const normalized = validateStreamInput(input);
  const { maxBufferedBytes = DEFAULT_BUFFERED_ASSET_BYTES, ...putOptions } = options;
  const data = await collectBytes(normalized.stream, maxBufferedBytes, 'maxAssetBytes');
  const { stream: _stream, ...rest } = normalized;
  return store.put({ ...rest, location: { kind: 'bytes', data } }, putOptions);
}

/**
 * Reads any store's asset, or a range of it, as a stream: through `getStream()` when the store has
 * it, and otherwise from `get()`.
 */
export async function readAssetStream(
  store: AssetStore,
  assetId: string,
  tenantId: string,
  options: AssetStreamOptions = {},
): Promise<StreamAssetDescriptor | undefined> {
  if (store.getStream) return store.getStream(assetId, tenantId, options);
  const [asset, stat] = await Promise.all([store.get(assetId, tenantId), store.stat(assetId, tenantId)]);
  if (!asset || !stat) return undefined;
  return bytesAsStream(stat.descriptor, asset.location.data, options.range);
}

/** Held bytes as a stream of the range asked for, under the store's descriptor. */
export function bytesAsStream(
  descriptor: AssetDescriptor,
  data: Uint8Array,
  range?: AssetByteRange,
): StreamAssetDescriptor {
  const bounds = resolveRange(range, data.byteLength);
  return { descriptor, stream: streamOf(data.subarray(bounds.start, bounds.end + 1)), range: bounds };
}

/** Checks a streamed asset's input as `validateByteInput()` checks bytes. */
export function validateStreamInput(input: StreamAssetInput): StreamAssetInput {
  if (!input || typeof input !== 'object') throw new AssetStoreValidationError('Asset input is required');
  const stream = input.stream as unknown;
  const readable = stream instanceof ReadableStream;
  const iterable = !!stream && typeof (stream as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
  if (!readable && !iterable) {
    throw new AssetStoreValidationError('A streamed asset needs a ReadableStream or an async iterable of bytes');
  }
  const normalized: StreamAssetInput = { stream: input.stream, mimeType: nonEmptyString(input.mimeType, 'mimeType') };
  if (input.filename !== undefined) normalized.filename = nonEmptyString(input.filename, 'filename');
  if (input.checksum !== undefined) normalized.checksum = cloneChecksum(input.checksum);
  if (input.metadata !== undefined) normalized.metadata = { ...input.metadata };
  return normalized;
}

/** Each chunk of a byte source, in order, whatever the source is. */
export async function* chunksOf(source: AssetByteSource): AsyncGenerator<Uint8Array> {
  if (source instanceof ReadableStream) {
    const reader = source.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield toBytes(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  for await (const chunk of source as AsyncIterable<Uint8Array>) yield toBytes(chunk);
}

/**
 * What a store learns as a stream flows past: its size and its SHA-256. `chunks()` passes each chunk
 * on, and fails with `AssetStoreCapacityError` the moment the size passes `maxBytes`.
 */
export class AssetMeter {
  /** Bytes seen so far. */
  byteLength = 0;
  private readonly hash = createSha256();

  constructor(private readonly maxBytes: number | undefined) {}

  /** The source's chunks, counted, hashed, and checked against the limit. */
  async *chunks(source: AssetByteSource): AsyncGenerator<Uint8Array> {
    for await (const chunk of chunksOf(source)) {
      this.byteLength += chunk.byteLength;
      if (this.maxBytes !== undefined && this.byteLength > this.maxBytes) {
        throw new AssetStoreCapacityError('maxAssetBytes', this.maxBytes, 0, this.byteLength);
      }
      this.hash.update(chunk);
      yield chunk;
    }
  }

  /** The checksum of everything seen, checked against one the caller supplied. */
  checksum(supplied?: AssetChecksum): AssetChecksum {
    const value = this.hash.digest();
    if (
      supplied &&
      supplied.algorithm.toLowerCase().replaceAll('-', '') === 'sha256' &&
      supplied.value.toLowerCase() !== value
    ) {
      throw new AssetStoreValidationError('Supplied SHA-256 checksum does not match the asset bytes');
    }
    return { algorithm: 'sha256', value };
  }
}

/** A generator as a web stream, read only as fast as its reader asks. */
export function streamFrom(chunks: AsyncIterator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await chunks.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await chunks.return?.(reason);
    },
  });
}

/** Bytes as a web stream, in chunks of 64 KiB. */
export function streamOf(data: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(data.subarray(offset, offset + 65_536));
      offset += 65_536;
    },
  });
}

/** Reads a whole stream into one array, refusing more than `maxBytes`. */
export async function collectBytes(
  source: AssetByteSource,
  maxBytes: number,
  constraint: AssetCapacityConstraint,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of chunksOf(source)) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new AssetStoreCapacityError(constraint, maxBytes, 0, total);
    parts.push(chunk);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.byteLength;
  }
  return data;
}

/**
 * A requested range against an asset of `byteLength` bytes. An end past the asset is cut to its last
 * byte, as HTTP does; a start past it, or an end before the start, is refused.
 */
export function resolveRange(range: AssetByteRange | undefined, byteLength: number): { start: number; end: number } {
  const start = range?.start ?? 0;
  const end = Math.min(range?.end ?? byteLength - 1, byteLength - 1);
  if (!Number.isSafeInteger(start) || start < 0 || (range?.end !== undefined && !Number.isSafeInteger(range.end))) {
    throw new AssetStoreValidationError('A byte range is whole, non-negative byte positions');
  }
  if (byteLength === 0 && start === 0 && range?.end === undefined) return { start: 0, end: -1 };
  if (start >= byteLength || end < start) {
    throw new AssetStoreValidationError(
      `The range ${start}-${range?.end ?? ''} is outside the asset's ${byteLength} bytes`,
    );
  }
  return { start, end };
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
  throw new AssetStoreValidationError('A streamed asset yields bytes');
}
