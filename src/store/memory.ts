import type {
  Store,
  StoreIndexOptions,
  StoreItem,
  StoreNamespace,
  StorePutOptions,
  StoreSearchOptions,
} from '../types/store.js';
import { cosine, matches, textOf } from './helpers.js';

export { cosine, matches, readPath, textOf } from './helpers.js';

/** Options for the in-memory store. */
export interface MemoryStoreOptions {
  /** Enables semantic search by embedding indexed fields on write. */
  index?: StoreIndexOptions;
  /** Items kept before the least recently written one is dropped. Defaults to 10,000. */
  maxItems?: number;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

interface StoredItem extends StoreItem {
  vector?: number[];
}

/**
 * In-process long-term memory.
 *
 * Enough for a single process, for tests, and for development; `RedisStore` and `PostgresStore`
 * carry the same contract across processes. Bounded like the graph's memory checkpointer, because a
 * store that only grows is a leak with a friendly name.
 */
export class MemoryStore implements Store {
  private readonly items = new Map<string, StoredItem>();
  private readonly maxItems: number;
  private readonly now: () => Date;

  constructor(private readonly options: MemoryStoreOptions = {}) {
    this.maxItems = options.maxItems ?? 10_000;
    this.now = options.now ?? (() => new Date());
    if (!(this.maxItems >= 1)) throw new RangeError('maxItems must be at least 1');
  }

  /** Stores an item, keeping its original `createdAt` when it replaces one. */
  async put<V>(namespace: StoreNamespace, key: string, value: V, options: StorePutOptions = {}): Promise<void> {
    assertKey(key);
    const id = idOf(namespace, key);
    const timestamp = this.now().toISOString();
    const existing = this.items.get(id);
    const vector = await this.embed(value, options.index);

    this.items.delete(id);
    this.items.set(id, {
      namespace: [...namespace],
      key,
      value,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...(options.ttlMs === undefined
        ? {}
        : { expiresAt: new Date(this.now().getTime() + options.ttlMs).toISOString() }),
      ...(vector ? { vector } : {}),
    });

    this.sweep();
    while (this.items.size > this.maxItems) {
      const oldest = this.items.keys().next().value as string;
      this.items.delete(oldest);
    }
  }

  /** Reads an item, or `undefined` when it does not exist or has expired. */
  get<V>(namespace: StoreNamespace, key: string): StoreItem<V> | undefined {
    const item = this.items.get(idOf(namespace, key));
    if (!item || this.expired(item)) return undefined;
    return strip(item) as StoreItem<V>;
  }

  /** Deletes an item. */
  delete(namespace: StoreNamespace, key: string): void {
    this.items.delete(idOf(namespace, key));
  }

  /**
   * Items under a namespace prefix, newest first, or ranked by similarity when a query is given.
   * Defaults to 20.
   */
  async search<V>(namespacePrefix: StoreNamespace, options: StoreSearchOptions = {}): Promise<Array<StoreItem<V>>> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const candidates = [...this.items.values()].filter(
      (item) =>
        !this.expired(item) && startsWith(item.namespace, namespacePrefix) && matches(item.value, options.filter),
    );

    let ranked: StoredItem[];
    if (options.query && this.options.index) {
      const [queryVector] = await this.options.index.embed([options.query]);
      ranked = candidates
        .map((item) => ({ ...item, score: item.vector && queryVector ? cosine(item.vector, queryVector) : 0 }))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    } else if (options.query) {
      // Without an index, a query is a substring match. Useful, and honest about what it is.
      const needle = options.query.toLowerCase();
      ranked = candidates.filter((item) => JSON.stringify(item.value).toLowerCase().includes(needle)).reverse();
    } else {
      ranked = candidates.reverse();
    }

    return ranked.slice(offset, offset + limit).map((item) => strip(item) as StoreItem<V>);
  }

  /** Namespaces under a prefix. Defaults to 100. */
  listNamespaces(options: { prefix?: StoreNamespace; limit?: number } = {}): string[][] {
    const seen = new Set<string>();
    const namespaces: string[][] = [];
    for (const item of this.items.values()) {
      if (this.expired(item) || !startsWith(item.namespace, options.prefix ?? [])) continue;
      const id = item.namespace.join('\u0000');
      if (seen.has(id)) continue;
      seen.add(id);
      namespaces.push([...item.namespace]);
      if (namespaces.length >= (options.limit ?? 100)) break;
    }
    return namespaces;
  }

  /** Items currently held, expired ones excluded. */
  size(): number {
    this.sweep();
    return this.items.size;
  }

  private async embed(value: unknown, index: StorePutOptions['index']): Promise<number[] | undefined> {
    if (index === false || !this.options.index) return undefined;
    const fields = index ?? this.options.index.fields;
    const text = textOf(value, fields);
    if (!text) return undefined;
    const [vector] = await this.options.index.embed([text]);
    return vector;
  }

  private expired(item: StoredItem): boolean {
    return item.expiresAt !== undefined && Date.parse(item.expiresAt) <= this.now().getTime();
  }

  private sweep(): void {
    for (const [id, item] of this.items) if (this.expired(item)) this.items.delete(id);
  }
}

function idOf(namespace: StoreNamespace, key: string): string {
  return [...namespace, key].join('\u0000');
}

function assertKey(key: string): void {
  if (!key.trim()) throw new RangeError('A store key must not be empty');
}

function strip(item: StoredItem): StoreItem {
  const { vector, ...rest } = item;
  return rest;
}

function startsWith(namespace: readonly string[], prefix: StoreNamespace): boolean {
  return prefix.every((part, index) => namespace[index] === part);
}
