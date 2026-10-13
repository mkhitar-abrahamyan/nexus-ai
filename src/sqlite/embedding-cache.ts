import type { EmbeddingCacheEntry, EmbeddingCacheStore } from '../types/embeddings.js';
import type { MigrationResult, SchemaMigration } from '../utils/schema-migrations.js';
import { packVector, unpackVector } from '../utils/vector-bytes.js';
import {
  quoteSqliteTable,
  type SqliteDatabaseLike,
  type SqliteLikeClient,
  type SqliteValue,
  toSqliteClient,
} from './client.js';
import type { SqliteMigrateOptions } from './migrations.js';

const DEFAULT_TABLE = 'nexus_embedding_cache';
/** Keys bound in one statement, well under every SQLite build's parameter limit. */
const KEYS_PER_STATEMENT = 500;

/** Options for the SQLite embedding cache. */
export interface SqliteEmbeddingCacheOptions {
  /** The table. Defaults to `nexus_embedding_cache`. */
  table?: string;
  /** Replaces the system clock, for tests. */
  now?: () => number;
}

/** The versioned schema, which `migrate()` applies. */
export function sqliteEmbeddingCacheMigrations(options: { table?: string } = {}): SchemaMigration[] {
  const name = options.table ?? DEFAULT_TABLE;
  const table = quoteSqliteTable(name);
  return [
    {
      component: `embedding-cache:${name}`,
      version: 1,
      name: 'create the embedding cache table',
      statements: [
        `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, vector BLOB NOT NULL, expires_at INTEGER)`,
      ],
    },
  ];
}

/**
 * Vectors in a SQLite table, for one machine's processes, or a team's through libSQL. A vector is
 * packed float32 in a blob, and a batch of keys is read in statements of 500.
 */
export class SqliteEmbeddingCache implements EmbeddingCacheStore {
  private readonly client: SqliteLikeClient;
  private readonly table: string;
  private readonly now: () => number;

  constructor(
    database: SqliteLikeClient | SqliteDatabaseLike,
    private readonly options: SqliteEmbeddingCacheOptions = {},
  ) {
    this.client = toSqliteClient(database);
    this.table = quoteSqliteTable(options.table ?? DEFAULT_TABLE);
    this.now = options.now ?? Date.now;
  }

  /** Applies the table's pending migrations. Never runs implicitly. */
  async migrate(options: SqliteMigrateOptions = {}): Promise<MigrationResult> {
    const { applySqliteMigrations } = await import('./migrations.js');
    return applySqliteMigrations(this.client, sqliteEmbeddingCacheMigrations(this.options), options);
  }

  /** The vectors under these keys, in order, with `undefined` for each miss or expired entry. */
  async getMany(keys: readonly string[]): Promise<Array<number[] | undefined>> {
    const found = new Map<string, Uint8Array>();
    const now = this.now();
    for (let start = 0; start < keys.length; start += KEYS_PER_STATEMENT) {
      const part = keys.slice(start, start + KEYS_PER_STATEMENT);
      const rows = (await this.client.all(
        `SELECT key, vector FROM ${this.table}
         WHERE key IN (${part.map(() => '?').join(', ')}) AND (expires_at IS NULL OR expires_at > ?)`,
        [...part, now],
      )) as Array<{ key: string; vector: Uint8Array }>;
      for (const row of rows) found.set(row.key, new Uint8Array(row.vector));
    }
    return keys.map((key) => {
      const vector = found.get(key);
      return vector ? unpackVector(vector) : undefined;
    });
  }

  /** Stores vectors, each for `ttlSeconds` when given. */
  async setMany(entries: readonly EmbeddingCacheEntry[], ttlSeconds?: number): Promise<void> {
    const expiresAt = ttlSeconds === undefined ? null : this.now() + ttlSeconds * 1000;
    for (let start = 0; start < entries.length; start += KEYS_PER_STATEMENT) {
      const part = entries.slice(start, start + KEYS_PER_STATEMENT);
      const params: SqliteValue[] = part.flatMap((entry) => [entry.key, packVector(entry.vector), expiresAt]);
      await this.client.run(
        `INSERT INTO ${this.table} (key, vector, expires_at) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}
         ON CONFLICT(key) DO UPDATE SET vector = excluded.vector, expires_at = excluded.expires_at`,
        params,
      );
    }
  }

  /** Deletes expired vectors, returning how many went. */
  async purgeExpired(): Promise<number> {
    return (await this.client.run(`DELETE FROM ${this.table} WHERE expires_at <= ?`, [this.now()])).changes;
  }
}
