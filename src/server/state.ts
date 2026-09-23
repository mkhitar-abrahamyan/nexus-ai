import type { ServerStateStore } from '../types/server.js';

/** Threads, runs, and cron jobs in process memory. The default, and enough for one replica. */
export class MemoryServerStore implements ServerStateStore {
  private readonly items = new Map<string, Map<string, { value: unknown; at: number }>>();
  private sequence = 0;

  /** Reads a record. */
  get<V>(namespace: readonly string[], key: string): V | undefined {
    return this.items.get(namespace.join('\u0000'))?.get(key)?.value as V | undefined;
  }

  /** Writes a record. */
  put<V>(namespace: readonly string[], key: string, value: V): void {
    const id = namespace.join('\u0000');
    const bucket = this.items.get(id) ?? new Map<string, { value: unknown; at: number }>();
    this.sequence += 1;
    bucket.set(key, { value, at: this.sequence });
    this.items.set(id, bucket);
  }

  /** Removes a record. */
  delete(namespace: readonly string[], key: string): void {
    this.items.get(namespace.join('\u0000'))?.delete(key);
  }

  /** Records under a namespace, newest written first. Defaults to 50. */
  list<V>(namespace: readonly string[], options: { limit?: number } = {}): V[] {
    const bucket = this.items.get(namespace.join('\u0000'));
    return [...(bucket?.values() ?? [])]
      .sort((a, b) => b.at - a.at)
      .slice(0, options.limit ?? 50)
      .map((entry) => entry.value as V);
  }
}

/** The part of a long-term `Store` the server state adapter uses. */
export interface StoreLike {
  /** Stores an item. */
  put(namespace: readonly string[], key: string, value: unknown): Promise<void> | void;
  /** Reads an item. */
  get(
    namespace: readonly string[],
    key: string,
  ): Promise<{ value: unknown } | undefined> | { value: unknown } | undefined;
  /** Deletes an item. */
  delete(namespace: readonly string[], key: string): Promise<void> | void;
  /** Items under a namespace prefix, newest first. */
  search(
    namespacePrefix: readonly string[],
    options?: { limit?: number },
  ): Promise<Array<{ value: unknown }>> | Array<{ value: unknown }>;
}

/**
 * Server state on top of a long-term store, so threads and runs live wherever memory already does.
 *
 * `MemoryStore`, `RedisStore`, and `PostgresStore` all satisfy `StoreLike`, which is what lets a
 * second replica see the first replica's threads without the server growing its own adapters.
 */
export function fromStore(store: StoreLike): ServerStateStore {
  return {
    async get<V>(namespace: readonly string[], key: string): Promise<V | undefined> {
      return (await store.get(namespace, key))?.value as V | undefined;
    },
    async put<V>(namespace: readonly string[], key: string, value: V): Promise<void> {
      await store.put(namespace, key, value);
    },
    async delete(namespace: readonly string[], key: string): Promise<void> {
      await store.delete(namespace, key);
    },
    async list<V>(namespace: readonly string[], options: { limit?: number } = {}): Promise<V[]> {
      return (await store.search(namespace, options)).map((item) => item.value as V);
    },
  };
}
