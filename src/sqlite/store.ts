import { cosine, matches, textOf } from '../store/helpers.js';
import type {
  Store,
  StoreIndexOptions,
  StoreItem,
  StoreNamespace,
  StorePutOptions,
  StoreSearchOptions,
} from '../types/store.js';
import { quoteSqliteTable, type SqliteDatabaseLike, type SqliteLikeClient, toSqliteClient } from './client.js';

/** Options for the SQLite store. */
export interface SqliteStoreOptions {
  /** Table name. Defaults to `nexus_store`. */
  table?: string;
  /** Enables semantic search by embedding indexed fields on write. */
  index?: StoreIndexOptions;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

const DEFAULT_TABLE = 'nexus_store';
/** Separates namespace parts in the prefix key. Not a character a namespace part is expected to hold. */
const SEPARATOR = '\u001f';

/** The schema, as statements. */
export function sqliteStoreMigration(options: Pick<SqliteStoreOptions, 'table'> = {}): string[] {
  const name = options.table ?? DEFAULT_TABLE;
  const table = quoteSqliteTable(name);
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
  ns_key TEXT NOT NULL,
  key TEXT NOT NULL,
  namespace TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT,
  embedding TEXT,
  PRIMARY KEY (ns_key, key)
)`,
    `CREATE INDEX IF NOT EXISTS "${name}_recent" ON ${table} (ns_key, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS "${name}_expiry" ON ${table} (expires_at) WHERE expires_at IS NOT NULL`,
  ];
}

interface StoreRow {
  namespace: string;
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  embedding?: string | null;
}

/**
 * Long-term memory in SQLite, for one machine that needs memory to survive a restart.
 *
 * The same contract as `MemoryStore`, `RedisStore`, and `PostgresStore`, checked by the same tests.
 * The namespace prefix and expiry are matched in SQL; filters, text queries, and semantic ranking
 * run in the process over the candidates under the prefix, with the same helpers the in-memory store
 * uses, so every store answers a search identically.
 */
export class SqliteStore implements Store {
  private readonly client: SqliteLikeClient;
  private readonly table: string;
  private readonly now: () => Date;

  constructor(
    database: SqliteLikeClient | SqliteDatabaseLike,
    private readonly options: SqliteStoreOptions = {},
  ) {
    this.client = toSqliteClient(database);
    this.table = quoteSqliteTable(options.table ?? DEFAULT_TABLE);
    this.now = options.now ?? (() => new Date());
  }

  /** Creates the table and indexes if they do not exist. Never runs implicitly. */
  async migrate(): Promise<void> {
    for (const statement of sqliteStoreMigration(this.options)) await this.client.exec(statement);
  }

  /** Stores an item, keeping its original `createdAt` when it replaces one. */
  async put<V>(namespace: StoreNamespace, key: string, value: V, options: StorePutOptions = {}): Promise<void> {
    if (!key.trim()) throw new RangeError('A store key must not be empty');
    const timestamp = this.now().toISOString();
    const vector = await this.embed(value, options.index);
    const expiresAt = options.ttlMs === undefined ? null : new Date(this.now().getTime() + options.ttlMs).toISOString();
    await this.client.run(
      `INSERT INTO ${this.table} (ns_key, key, namespace, value, created_at, updated_at, expires_at, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (ns_key, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
         expires_at = excluded.expires_at, embedding = excluded.embedding`,
      [
        namespaceKey(namespace),
        key,
        JSON.stringify([...namespace]),
        JSON.stringify(value ?? null),
        timestamp,
        timestamp,
        expiresAt,
        vector ? JSON.stringify(vector) : null,
      ],
    );
  }

  /** Reads an item, or `undefined` when it does not exist or has expired. */
  async get<V>(namespace: StoreNamespace, key: string): Promise<StoreItem<V> | undefined> {
    const [row] = (await this.client.all(
      `SELECT namespace, key, value, created_at, updated_at, expires_at FROM ${this.table}
       WHERE ns_key = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)`,
      [namespaceKey(namespace), key, this.now().toISOString()],
    )) as StoreRow[];
    return row ? (toItem(row) as StoreItem<V>) : undefined;
  }

  /** Deletes an item. */
  async delete(namespace: StoreNamespace, key: string): Promise<void> {
    await this.client.run(`DELETE FROM ${this.table} WHERE ns_key = ? AND key = ?`, [namespaceKey(namespace), key]);
  }

  /**
   * Items under a namespace prefix, newest first, or ranked by similarity when a query is given.
   * Defaults to 20.
   */
  async search<V>(namespacePrefix: StoreNamespace, options: StoreSearchOptions = {}): Promise<Array<StoreItem<V>>> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const semantic = Boolean(options.query && this.options.index);
    // Without a filter or a query, SQL can page directly; otherwise candidates are narrowed here.
    const pageInSql = !options.filter && !options.query;
    const prefix = namespaceKey(namespacePrefix);
    const rows = (await this.client.all(
      `SELECT namespace, key, value, created_at, updated_at, expires_at${semantic ? ', embedding' : ''}
       FROM ${this.table}
       WHERE substr(ns_key, 1, length(?)) = ? AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY updated_at DESC, ns_key, key${pageInSql ? ' LIMIT ? OFFSET ?' : ''}`,
      [prefix, prefix, this.now().toISOString(), ...(pageInSql ? [limit, offset] : [])],
    )) as StoreRow[];

    let candidates = rows
      .map((row) => ({ row, item: toItem(row) }))
      .filter(({ item }) => matches(item.value, options.filter));
    if (pageInSql) return candidates.map(({ item }) => item as StoreItem<V>);

    if (semantic && options.query && this.options.index) {
      const [queryVector] = await this.options.index.embed([options.query]);
      return candidates
        .map(({ row, item }) => {
          const vector = row.embedding ? (JSON.parse(row.embedding) as number[]) : undefined;
          return { ...item, score: vector && queryVector ? cosine(vector, queryVector) : 0 };
        })
        .sort((a, b) => b.score - a.score)
        .slice(offset, offset + limit) as Array<StoreItem<V>>;
    }
    if (options.query) {
      const needle = options.query.toLowerCase();
      candidates = candidates.filter(({ row }) => row.value.toLowerCase().includes(needle));
    }
    return candidates.slice(offset, offset + limit).map(({ item }) => item as StoreItem<V>);
  }

  /** Namespaces under a prefix. Defaults to 100. */
  async listNamespaces(options: { prefix?: StoreNamespace; limit?: number } = {}): Promise<string[][]> {
    const prefix = namespaceKey(options.prefix ?? []);
    const rows = (await this.client.all(
      `SELECT ns_key, min(namespace) AS namespace FROM ${this.table}
       WHERE substr(ns_key, 1, length(?)) = ? AND (expires_at IS NULL OR expires_at > ?)
       GROUP BY ns_key ORDER BY ns_key LIMIT ?`,
      [prefix, prefix, this.now().toISOString(), options.limit ?? 100],
    )) as Array<{ namespace: string }>;
    return rows.map((row) => JSON.parse(row.namespace) as string[]);
  }

  /** Deletes expired items, returning how many went. Reads already hide them. */
  async sweep(): Promise<number> {
    return (await this.client.run(`DELETE FROM ${this.table} WHERE expires_at <= ?`, [this.now().toISOString()]))
      .changes;
  }

  private async embed(value: unknown, index: StorePutOptions['index']): Promise<number[] | undefined> {
    if (index === false || !this.options.index) return undefined;
    const text = textOf(value, index ?? this.options.index.fields);
    if (!text) return undefined;
    const [vector] = await this.options.index.embed([text]);
    return vector;
  }
}

/**
 * The key a namespace is matched by. Every part ends with the separator, so a prefix of whole parts
 * is a text prefix and a partial part never is.
 */
function namespaceKey(namespace: StoreNamespace): string {
  return namespace.map((part) => `${part}${SEPARATOR}`).join('');
}

function toItem(row: StoreRow): StoreItem {
  return {
    namespace: JSON.parse(row.namespace) as string[],
    key: row.key,
    value: JSON.parse(row.value),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  };
}
