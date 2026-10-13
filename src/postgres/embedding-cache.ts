import type { EmbeddingCacheEntry, EmbeddingCacheStore } from '../types/embeddings.js';
import { decodeBase64, encodeBase64 } from '../utils/base64.js';
import type { MigrationResult, SchemaMigration } from '../utils/schema-migrations.js';
import { packVector, unpackVector } from '../utils/vector-bytes.js';
import { type PostgresLikeClient, quoteDerived, quoteTable } from './client.js';
import type { PostgresMigrateOptions } from './migrations.js';

const DEFAULT_TABLE = 'nexus_embedding_cache';

/** Options for the Postgres embedding cache. */
export interface PostgresEmbeddingCacheOptions {
  /** The table, optionally schema-qualified. Defaults to `nexus_embedding_cache`. */
  table?: string;
}

/** The versioned schema, which `migrate()` and `nexus db migrate` apply. */
export function embeddingCacheMigrations(options: PostgresEmbeddingCacheOptions = {}): SchemaMigration[] {
  const name = options.table ?? DEFAULT_TABLE;
  const table = quoteTable(name);
  return [
    {
      component: `embedding-cache:${name}`,
      version: 1,
      name: 'create the embedding cache table',
      statements: [
        `CREATE TABLE IF NOT EXISTS ${table} (key text PRIMARY KEY, vector bytea NOT NULL, expires_at timestamptz)`,
        `CREATE INDEX IF NOT EXISTS ${quoteDerived(name, 'expires')} ON ${table} (expires_at) WHERE expires_at IS NOT NULL`,
      ],
    },
  ];
}

/**
 * Vectors in a Postgres table, shared by every process that reaches the database. A batch is one
 * `SELECT` and one upsert, and a vector is packed float32: 6 KB for 1,536 dimensions.
 */
export class PostgresEmbeddingCache implements EmbeddingCacheStore {
  private readonly table: string;

  constructor(
    private readonly client: PostgresLikeClient,
    private readonly options: PostgresEmbeddingCacheOptions = {},
  ) {
    this.table = quoteTable(options.table ?? DEFAULT_TABLE);
  }

  /** Applies the table's pending migrations. Never runs implicitly. */
  async migrate(options: PostgresMigrateOptions = {}): Promise<MigrationResult> {
    const { applyPostgresMigrations } = await import('./migrations.js');
    return applyPostgresMigrations(this.client, embeddingCacheMigrations(this.options), options);
  }

  /** The vectors under these keys, in order, with `undefined` for each miss or expired entry. */
  async getMany(keys: readonly string[]): Promise<Array<number[] | undefined>> {
    if (keys.length === 0) return [];
    const { rows } = await this.client.query(
      `SELECT key, encode(vector, 'base64') AS vector FROM ${this.table}
       WHERE key = ANY($1::text[]) AND (expires_at IS NULL OR expires_at > now())`,
      [keys],
    );
    const found = new Map(
      (rows as Array<{ key: string; vector: string }>).map((row) => [row.key, row.vector.replace(/\s+/g, '')]),
    );
    return keys.map((key) => {
      const vector = found.get(key);
      return vector === undefined ? undefined : unpackVector(decodeBase64(vector));
    });
  }

  /** Stores vectors, each for `ttlSeconds` when given. */
  async setMany(entries: readonly EmbeddingCacheEntry[], ttlSeconds?: number): Promise<void> {
    if (entries.length === 0) return;
    // The last write of a key wins, so a key twice in one batch is never two rows in one statement.
    const latest = new Map(entries.map((entry) => [entry.key, entry.vector]));
    await this.client.query(
      `INSERT INTO ${this.table} (key, vector, expires_at)
       SELECT entry.key, decode(entry.vector, 'base64'),
         CASE WHEN $3::float8 IS NULL THEN NULL ELSE now() + $3::float8 * interval '1 second' END
       FROM unnest($1::text[], $2::text[]) AS entry(key, vector)
       ON CONFLICT (key) DO UPDATE SET vector = EXCLUDED.vector, expires_at = EXCLUDED.expires_at`,
      [[...latest.keys()], [...latest.values()].map((vector) => encodeBase64(packVector(vector))), ttlSeconds ?? null],
    );
  }

  /** Deletes expired vectors, returning how many went. */
  async purgeExpired(): Promise<number> {
    const result = await this.client.query(`DELETE FROM ${this.table} WHERE expires_at <= now()`);
    return result.rowCount ?? 0;
  }
}
