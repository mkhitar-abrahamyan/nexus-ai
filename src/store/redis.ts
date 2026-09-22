import type {
  Store,
  StoreIndexOptions,
  StoreItem,
  StoreNamespace,
  StorePutOptions,
  StoreSearchOptions,
} from '../types/store.js';
import { cosine, matches, textOf } from './helpers.js';

/**
 * The subset of a Redis client this store uses.
 *
 * Structural, as with the operation store and the rate-limit store, so `ioredis`, `node-redis`, an
 * Upstash client, or a fake in a test all work without this package depending on any of them.
 */
export interface RedisStoreLikeClient {
  /** Reads a key. */
  get(key: string): Promise<string | null>;
  /** Writes a key, with `PX` and a TTL in milliseconds when the item expires. */
  set(key: string, value: string, mode?: string, ttl?: number): Promise<unknown>;
  /** Deletes keys. */
  del(key: string | string[]): Promise<unknown>;
  /** Adds to a set. */
  sadd(key: string, member: string): Promise<unknown>;
  /** Removes from a set. */
  srem(key: string, member: string): Promise<unknown>;
  /** Reads a set. */
  smembers(key: string): Promise<string[]>;
}

/** Options for the Redis store. */
export interface RedisStoreOptions {
  /** Key prefix, so one Redis instance can hold several stores. Defaults to `nexus:store`. */
  prefix?: string;
  /** Embeds items for semantic search. Without it, search matches text in the stored values. */
  index?: StoreIndexOptions;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

interface StoredRecord extends StoreItem {
  vector?: number[];
}

/**
 * Long-term memory in Redis, so several processes share what an agent remembers.
 *
 * Expiry is Redis's own TTL, so an expired item costs nothing to skip. A namespace index is kept in
 * a set per namespace, which is what makes prefix search and `listNamespaces()` possible without
 * scanning the keyspace.
 */
export class RedisStore implements Store {
  private readonly prefix: string;
  private readonly now: () => Date;

  constructor(
    private readonly client: RedisStoreLikeClient,
    private readonly options: RedisStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'nexus:store';
    this.now = options.now ?? (() => new Date());
  }

  /** Stores an item, keeping its original `createdAt` when it replaces one. */
  async put<V>(namespace: StoreNamespace, key: string, value: V, options: StorePutOptions = {}): Promise<void> {
    if (!key.trim()) throw new RangeError('A store key must not be empty');
    const id = this.itemKey(namespace, key);
    const existing = await this.read(id);
    const timestamp = this.now().toISOString();
    const vector = await this.embed(value, options.index);

    const record: StoredRecord = {
      namespace: [...namespace],
      key,
      value,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(options.ttlMs === undefined
        ? {}
        : { expiresAt: new Date(this.now().getTime() + options.ttlMs).toISOString() }),
      ...(vector ? { vector } : {}),
    };

    const serialized = JSON.stringify(record);
    if (options.ttlMs === undefined) await this.client.set(id, serialized);
    else await this.client.set(id, serialized, 'PX', Math.max(1, Math.round(options.ttlMs)));

    await this.client.sadd(this.namespaceKey(namespace), key);
    await this.client.sadd(this.indexKey(), namespace.join('\u0000'));
  }

  /** Reads an item, or `undefined` when it does not exist or Redis has expired it. */
  async get<V>(namespace: StoreNamespace, key: string): Promise<StoreItem<V> | undefined> {
    const record = await this.read(this.itemKey(namespace, key));
    if (!record) {
      // Redis dropped the value when its TTL elapsed; keep the namespace set from growing stale.
      await this.client.srem(this.namespaceKey(namespace), key);
      return undefined;
    }
    return strip(record) as StoreItem<V>;
  }

  /** Deletes an item. */
  async delete(namespace: StoreNamespace, key: string): Promise<void> {
    await this.client.del(this.itemKey(namespace, key));
    await this.client.srem(this.namespaceKey(namespace), key);
  }

  /**
   * Items under a namespace prefix, newest first, or ranked by similarity when a query is given.
   * Defaults to 20.
   */
  async search<V>(namespacePrefix: StoreNamespace, options: StoreSearchOptions = {}): Promise<Array<StoreItem<V>>> {
    const namespaces = await this.namespacesUnder(namespacePrefix);
    const records: StoredRecord[] = [];
    for (const namespace of namespaces) {
      for (const key of await this.client.smembers(this.namespaceKey(namespace))) {
        const record = await this.read(this.itemKey(namespace, key));
        if (record && matches(record.value, options.filter)) records.push(record);
      }
    }

    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    let ranked = records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    if (options.query && this.options.index) {
      const [queryVector] = await this.options.index.embed([options.query]);
      ranked = records
        .map((record) => ({ ...record, score: record.vector && queryVector ? cosine(record.vector, queryVector) : 0 }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    } else if (options.query) {
      const needle = options.query.toLowerCase();
      ranked = ranked.filter((record) => JSON.stringify(record.value).toLowerCase().includes(needle));
    }

    return ranked.slice(offset, offset + limit).map((record) => strip(record) as StoreItem<V>);
  }

  /** Namespaces under a prefix. Defaults to 100. */
  async listNamespaces(options: { prefix?: StoreNamespace; limit?: number } = {}): Promise<string[][]> {
    const namespaces = await this.namespacesUnder(options.prefix ?? []);
    return namespaces.slice(0, options.limit ?? 100);
  }

  private async namespacesUnder(prefix: StoreNamespace): Promise<string[][]> {
    const all = await this.client.smembers(this.indexKey());
    return all
      .map((entry) => entry.split('\u0000'))
      .filter((namespace) => prefix.every((part, index) => namespace[index] === part));
  }

  private async read(id: string): Promise<StoredRecord | undefined> {
    const raw = await this.client.get(id);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as StoredRecord;
    } catch {
      // A value another writer mangled is treated as absent rather than crashing a read path.
      return undefined;
    }
  }

  private async embed(value: unknown, index: StorePutOptions['index']): Promise<number[] | undefined> {
    if (index === false || !this.options.index) return undefined;
    const text = textOf(value, index ?? this.options.index.fields);
    if (!text) return undefined;
    const [vector] = await this.options.index.embed([text]);
    return vector;
  }

  private itemKey(namespace: StoreNamespace, key: string): string {
    return `${this.prefix}:item:${[...namespace, key].join(':')}`;
  }

  private namespaceKey(namespace: StoreNamespace): string {
    return `${this.prefix}:ns:${namespace.join(':')}`;
  }

  private indexKey(): string {
    return `${this.prefix}:namespaces`;
  }
}

function strip(record: StoredRecord): StoreItem {
  const { vector, ...rest } = record;
  return rest;
}
