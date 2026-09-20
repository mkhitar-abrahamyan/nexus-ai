import type {
  Store,
  StoreIndexOptions,
  StoreItem,
  StoreNamespace,
  StorePutOptions,
  StoreSearchOptions,
} from '../types/store.js';

export interface MemoryStoreOptions {
  /** Enables semantic search by embedding indexed fields on write. */
  index?: StoreIndexOptions;
  /** Items kept before the least recently written one is dropped. Defaults to 10,000. */
  maxItems?: number;
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

  get<V>(namespace: StoreNamespace, key: string): StoreItem<V> | undefined {
    const item = this.items.get(idOf(namespace, key));
    if (!item || this.expired(item)) return undefined;
    return strip(item) as StoreItem<V>;
  }

  delete(namespace: StoreNamespace, key: string): void {
    this.items.delete(idOf(namespace, key));
  }

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

/** Exact match on dot-path fields, so a filter reads like the shape of the value it selects. */
export function matches(value: unknown, filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([path, expected]) => {
    const actual = readPath(value, path);
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  });
}

export function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

/** The text an item is indexed by: chosen fields, or every string in the value. */
export function textOf(value: unknown, fields: readonly string[] | undefined): string {
  if (fields?.length) {
    return fields
      .map((field) => readPath(value, field))
      .filter((part): part is string => typeof part === 'string')
      .join('\n')
      .trim();
  }
  if (typeof value === 'string') return value.trim();
  const parts: string[] = [];
  const walk = (current: unknown): void => {
    if (typeof current === 'string') parts.push(current);
    else if (Array.isArray(current)) for (const entry of current) walk(entry);
    else if (current && typeof current === 'object') for (const entry of Object.values(current)) walk(entry);
  };
  walk(value);
  return parts.join('\n').trim();
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const x = a[index] as number;
    const y = b[index] as number;
    dot += x * y;
    left += x * x;
    right += y * y;
  }
  const magnitude = Math.sqrt(left) * Math.sqrt(right);
  return magnitude === 0 ? 0 : dot / magnitude;
}
