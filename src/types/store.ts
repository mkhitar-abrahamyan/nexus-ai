/**
 * Long-term memory: key-value state that outlives a single run or thread.
 *
 * A graph checkpoint remembers one conversation. A store remembers across them — what a user
 * prefers, what an agent learned last week, what another agent wrote down. Keys are namespaced
 * tuples rather than flat strings, so `['tenant-7', 'users', 'alice', 'preferences']` is both a
 * natural place to put something and a natural prefix to search.
 */

/** Path to a collection of items. Tuples, so a prefix search is an ordinary array comparison. */
export type StoreNamespace = readonly string[];

export interface StoreItem<V = unknown> {
  namespace: string[];
  key: string;
  value: V;
  createdAt: string;
  updatedAt: string;
  /** ISO-8601 time after which the item is gone. Absent means it is kept until deleted. */
  expiresAt?: string;
  /** Similarity to the search query, 0 to 1. Present only on results from a semantic search. */
  score?: number;
}

export interface StorePutOptions {
  /** Lifetime in milliseconds. Absent means the item does not expire. */
  ttlMs?: number;
  /**
   * Fields to embed for semantic search, as dot paths into the value. Defaults to the fields the
   * store was configured with; `false` stores the item without indexing it.
   */
  index?: readonly string[] | false;
}

export interface StoreSearchOptions {
  /** Natural-language query. Needs an index; without one, it matches text in the stored values. */
  query?: string;
  /** Exact-match conditions on value fields, as dot paths. */
  filter?: Record<string, unknown>;
  limit?: number;
  offset?: number;
}

/**
 * Turns text into vectors for semantic search.
 *
 * Injected rather than imported, so the store never depends on the embeddings runtime and stays
 * usable with any provider — or with none, in which case search falls back to matching text.
 */
export interface StoreIndexOptions {
  embed: (texts: string[]) => Promise<number[][]>;
  /** Value fields to embed, as dot paths. Defaults to every string field in the value. */
  fields?: readonly string[];
}

export interface Store {
  put<V = unknown>(namespace: StoreNamespace, key: string, value: V, options?: StorePutOptions): Promise<void> | void;
  get<V = unknown>(
    namespace: StoreNamespace,
    key: string,
  ): Promise<StoreItem<V> | undefined> | StoreItem<V> | undefined;
  delete(namespace: StoreNamespace, key: string): Promise<void> | void;
  /** Items under a namespace prefix, newest first, or ranked by similarity when a query is given. */
  search<V = unknown>(
    namespacePrefix: StoreNamespace,
    options?: StoreSearchOptions,
  ): Promise<Array<StoreItem<V>>> | Array<StoreItem<V>>;
  /** Namespaces that exist under a prefix, for browsing what an agent has remembered. */
  listNamespaces(options?: { prefix?: StoreNamespace; limit?: number }): Promise<string[][]> | string[][];
}
