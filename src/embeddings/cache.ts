import type { EmbeddingCacheEntry, EmbeddingCacheStore, EmbeddingInputType } from '../types/embeddings.js';
import { decodeBase64, encodeBase64 } from '../utils/base64.js';
import { type RedisRawClient, redisSender } from '../utils/redis-command.js';
import { sha256Hex } from '../utils/sha256.js';
import { packVector, unpackVector } from '../utils/vector-bytes.js';

export { packVector, unpackVector } from '../utils/vector-bytes.js';

export type { EmbeddingCacheEntry, EmbeddingCacheStore } from '../types/embeddings.js';

/** What a cached vector depends on besides its input: the same text under another model is another vector. */
export interface EmbeddingCacheContext {
  /** The provider that embedded it. */
  provider: string;
  /** The concrete model. */
  model: string;
  /** The input type it was embedded as. */
  inputType?: EmbeddingInputType;
  /** The size it was shortened to. */
  dimensions?: number;
  /** Whether it was scaled to unit length. */
  normalize?: boolean;
  /** How a long input was cut. */
  truncate?: string;
}

/**
 * The cache key for an input embedded under a context: a SHA-256 in hex, so the text itself never
 * becomes a key in a shared store.
 */
export function embeddingCacheKey(context: EmbeddingCacheContext, input: string): string {
  // The context's fields in name order, the unset ones left out, so equal contexts give equal keys.
  const fields = Object.entries(context)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return sha256Hex(`${JSON.stringify(Object.fromEntries(fields))}\u0000${input}`);
}

/** Limits for the in-process embedding cache. */
export interface MemoryEmbeddingCacheOptions {
  /** Most vectors held; the least recently used goes first. Defaults to 10,000. */
  maxEntries?: number;
  /** Replaces the system clock, for tests. */
  now?: () => number;
}

/**
 * Vectors in process memory, packed as float32, the least recently used evicted first. As the near
 * tier of `tieredEmbeddingCache()`, it answers repeated texts without a round trip.
 */
export class MemoryEmbeddingCache implements EmbeddingCacheStore {
  private readonly entries = new Map<string, { vector: Float32Array; expiresAt?: number }>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: MemoryEmbeddingCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
    if (!(Number.isSafeInteger(this.maxEntries) && this.maxEntries > 0)) {
      throw new RangeError('maxEntries must be a positive integer');
    }
    this.now = options.now ?? Date.now;
  }

  /** Vectors held now. */
  get size(): number {
    return this.entries.size;
  }

  /** The vectors under these keys, in order, with `undefined` for each miss or expired entry. */
  async getMany(keys: readonly string[]): Promise<Array<number[] | undefined>> {
    const now = this.now();
    return keys.map((key) => {
      const entry = this.entries.get(key);
      if (!entry) return undefined;
      this.entries.delete(key);
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) return undefined;
      this.entries.set(key, entry);
      return Array.from(entry.vector);
    });
  }

  /** Stores vectors, evicting the least recently used past `maxEntries`. */
  async setMany(entries: readonly EmbeddingCacheEntry[], ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds === undefined ? undefined : this.now() + ttlSeconds * 1000;
    for (const { key, vector } of entries) {
      this.entries.delete(key);
      this.entries.set(key, { vector: Float32Array.from(vector), ...(expiresAt === undefined ? {} : { expiresAt }) });
    }
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(key);
    }
  }

  /** Removes every vector. */
  clear(): void {
    this.entries.clear();
  }
}

/** A Redis client that sends raw commands: ioredis, with `call()`, or node-redis, with `sendCommand()`. */
export type RedisEmbeddingCacheClient = RedisRawClient;

/** Options for the Redis embedding cache. */
export interface RedisEmbeddingCacheOptions {
  /** Placed before every key, so the cache owns a part of the keyspace. Defaults to `nexus:embedding:`. */
  prefix?: string;
  /**
   * Reads and writes a batch as one `MGET` and one script, which is one round trip. Defaults to
   * `true`. Set `false` on Redis Cluster, whose multi-key commands need every key in one slot: each
   * key then travels as its own command, sent all at once.
   */
  multiKey?: boolean;
}

/** Sets every key with the same lifetime: `ARGV[1]` is the lifetime, and `ARGV[i + 1]` the value of `KEYS[i]`. */
const SET_ALL_EXPIRING = "for i = 1, #KEYS do redis.call('SET', KEYS[i], ARGV[i + 1], 'EX', ARGV[1]) end return #KEYS";

/**
 * Vectors in Redis, shared by every process that reaches it. A batch is one `MGET` and one write, and
 * a vector is packed float32 in base64: about 8 KB for 1,536 dimensions, against about 30 KB as JSON.
 */
export class RedisEmbeddingCache implements EmbeddingCacheStore {
  private readonly send: (args: string[]) => Promise<unknown>;
  private readonly prefix: string;
  private readonly multiKey: boolean;

  constructor(client: RedisEmbeddingCacheClient, options: RedisEmbeddingCacheOptions = {}) {
    this.send = redisSender(client);
    this.prefix = options.prefix ?? 'nexus:embedding:';
    this.multiKey = options.multiKey ?? true;
  }

  /** The vectors under these keys, in order, with `undefined` for each miss. */
  async getMany(keys: readonly string[]): Promise<Array<number[] | undefined>> {
    if (keys.length === 0) return [];
    const replies = this.multiKey
      ? ((await this.send(['MGET', ...keys.map((key) => this.prefix + key)])) as unknown[])
      : await Promise.all(keys.map((key) => this.send(['GET', this.prefix + key])));
    return replies.map((reply) => (reply == null ? undefined : unpackVector(decodeBase64(String(reply)))));
  }

  /** Stores vectors, each for `ttlSeconds` when given. */
  async setMany(entries: readonly EmbeddingCacheEntry[], ttlSeconds?: number): Promise<void> {
    if (entries.length === 0) return;
    const keys = entries.map((entry) => this.prefix + entry.key);
    const values = entries.map((entry) => encodeBase64(packVector(entry.vector)));
    const expiry = ttlSeconds === undefined ? [] : ['EX', String(Math.max(1, Math.ceil(ttlSeconds)))];
    if (!this.multiKey) {
      await Promise.all(keys.map((key, index) => this.send(['SET', key, values[index] as string, ...expiry])));
    } else if (ttlSeconds === undefined) {
      await this.send(['MSET', ...keys.flatMap((key, index) => [key, values[index] as string])]);
    } else {
      await this.send(['EVAL', SET_ALL_EXPIRING, String(keys.length), ...keys, expiry[1] as string, ...values]);
    }
  }
}

/**
 * Two caches as one: the near one, usually `MemoryEmbeddingCache`, answers first, and the far one,
 * usually shared, answers the rest in one call. A far hit is copied near, and a write goes to both.
 */
export function tieredEmbeddingCache(near: EmbeddingCacheStore, far: EmbeddingCacheStore): EmbeddingCacheStore {
  return {
    async getMany(keys) {
      const found = await near.getMany(keys);
      const missing = keys.filter((_, index) => found[index] === undefined);
      if (missing.length === 0) return found;
      const fetched = await far.getMany(missing);
      const copies: EmbeddingCacheEntry[] = [];
      let next = 0;
      for (const [index, key] of keys.entries()) {
        if (found[index] !== undefined) continue;
        const vector = fetched[next++];
        found[index] = vector;
        if (vector) copies.push({ key, vector });
      }
      if (copies.length) await near.setMany(copies);
      return found;
    },
    async setMany(entries, ttlSeconds) {
      await Promise.all([near.setMany(entries, ttlSeconds), far.setMany(entries, ttlSeconds)]);
    },
  };
}
