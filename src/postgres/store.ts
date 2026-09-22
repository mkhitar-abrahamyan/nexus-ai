import { cosine, textOf } from '../store/helpers.js';
import type {
  Store,
  StoreIndexOptions,
  StoreItem,
  StoreNamespace,
  StorePutOptions,
  StoreSearchOptions,
} from '../types/store.js';
import { fromJson, type PostgresLikeClient, quoteDerived, quoteTable, runStatements } from './client.js';
import { jsonFieldEquals, likePrefix, SqlParams } from './sql.js';

/** Options for the Postgres store. */
export interface PostgresStoreOptions {
  /** Table name, optionally schema-qualified. Defaults to `nexus_store`. */
  table?: string;
  /** Enables semantic search by embedding indexed fields on write. */
  index?: StoreIndexOptions;
  /**
   * Stores embeddings as a pgvector column of this many dimensions and ranks in the database. The
   * extension must be installed. Without it, embeddings are kept as JSON and ranked in process,
   * which works on any Postgres and suits namespaces of a few thousand items.
   */
  vectorDimensions?: number;
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

const DEFAULT_TABLE = 'nexus_store';
/** Separates namespace parts in the prefix key. Not a character a namespace part is expected to hold. */
const SEPARATOR = '\u001f';

/** The schema, as statements. With `vectorDimensions`, pgvector's extension is created too. */
export function storeMigration(options: Pick<PostgresStoreOptions, 'table' | 'vectorDimensions'> = {}): string[] {
  const name = options.table ?? DEFAULT_TABLE;
  const table = quoteTable(name);
  const dimensions = options.vectorDimensions;
  if (dimensions !== undefined && !(Number.isInteger(dimensions) && dimensions > 0)) {
    throw new RangeError('vectorDimensions must be a positive integer');
  }
  return [
    ...(dimensions ? ['CREATE EXTENSION IF NOT EXISTS vector'] : []),
    `CREATE TABLE IF NOT EXISTS ${table} (
  ns_key text COLLATE "C" NOT NULL,
  key text NOT NULL,
  namespace jsonb NOT NULL,
  value jsonb NOT NULL,
  created_at text COLLATE "C" NOT NULL,
  updated_at text COLLATE "C" NOT NULL,
  expires_at text COLLATE "C",
  embedding ${dimensions ? `vector(${dimensions})` : 'jsonb'},
  PRIMARY KEY (ns_key, key)
)`,
    `CREATE INDEX IF NOT EXISTS ${quoteDerived(name, 'recent')} ON ${table} (ns_key, updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ${quoteDerived(name, 'expiry')} ON ${table} (expires_at) WHERE expires_at IS NOT NULL`,
  ];
}

interface StoreRow {
  namespace: unknown;
  key: string;
  value: unknown;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  embedding?: unknown;
  score?: number | string | null;
}

/**
 * Long-term memory in Postgres, with pgvector when it is available.
 *
 * The same contract as `MemoryStore` and `RedisStore`, checked by the same tests. Namespace prefixes
 * are matched on a `C`-collated key, so `['tenant-7']` never matches `['tenant-70']` and an index
 * serves the match. Expired items are hidden from every read at once; `sweep()` deletes them, for a
 * retention job.
 */
export class PostgresStore implements Store {
  private readonly table: string;
  private readonly now: () => Date;

  constructor(
    private readonly client: PostgresLikeClient,
    private readonly options: PostgresStoreOptions = {},
  ) {
    this.table = quoteTable(options.table ?? DEFAULT_TABLE);
    this.now = options.now ?? (() => new Date());
  }

  /** Creates the table, indexes, and pgvector extension if configured. Never runs implicitly. */
  async migrate(): Promise<void> {
    await runStatements(this.client, storeMigration(this.options));
  }

  /** Stores an item, keeping its original `createdAt` when it replaces one. */
  async put<V>(namespace: StoreNamespace, key: string, value: V, options: StorePutOptions = {}): Promise<void> {
    if (!key.trim()) throw new RangeError('A store key must not be empty');
    const timestamp = this.now().toISOString();
    const vector = await this.embed(value, options.index);
    const expiresAt = options.ttlMs === undefined ? null : new Date(this.now().getTime() + options.ttlMs).toISOString();

    await this.client.query(
      `INSERT INTO ${this.table} (ns_key, key, namespace, value, created_at, updated_at, expires_at, embedding)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $5, $6, $7${this.options.vectorDimensions ? '::vector' : '::jsonb'})
       ON CONFLICT (ns_key, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at,
         expires_at = EXCLUDED.expires_at, embedding = EXCLUDED.embedding`,
      [
        namespaceKey(namespace),
        key,
        JSON.stringify([...namespace]),
        JSON.stringify(value ?? null),
        timestamp,
        expiresAt,
        vector ? JSON.stringify(vector) : null,
      ],
    );
  }

  /** Reads an item, or `undefined` when it does not exist or has expired. */
  async get<V>(namespace: StoreNamespace, key: string): Promise<StoreItem<V> | undefined> {
    const { rows } = await this.client.query(
      `SELECT namespace::text AS namespace, key, value::text AS value, created_at, updated_at, expires_at FROM ${this.table}
       WHERE ns_key = $1 AND key = $2 AND (expires_at IS NULL OR expires_at > $3)`,
      [namespaceKey(namespace), key, this.now().toISOString()],
    );
    return rows[0] ? (toItem(rows[0] as StoreRow) as StoreItem<V>) : undefined;
  }

  /** Deletes an item. */
  async delete(namespace: StoreNamespace, key: string): Promise<void> {
    await this.client.query(`DELETE FROM ${this.table} WHERE ns_key = $1 AND key = $2`, [namespaceKey(namespace), key]);
  }

  /**
   * Items under a namespace prefix, newest first, or ranked by similarity when a query is given.
   * Defaults to 20.
   */
  async search<V>(namespacePrefix: StoreNamespace, options: StoreSearchOptions = {}): Promise<Array<StoreItem<V>>> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    const params = new SqlParams();
    const where = [
      `ns_key LIKE ${params.add(likePrefix(namespaceKey(namespacePrefix)))} ESCAPE '\\'`,
      `(expires_at IS NULL OR expires_at > ${params.add(this.now().toISOString())})`,
      ...Object.entries(options.filter ?? {}).map(([path, expected]) =>
        jsonFieldEquals('value', path, expected, params, { anyOf: true }),
      ),
    ];
    const columns = 'namespace::text AS namespace, key, value::text AS value, created_at, updated_at, expires_at';

    if (options.query && this.options.index) {
      const [queryVector] = await this.options.index.embed([options.query]);
      if (this.options.vectorDimensions && queryVector) {
        const vector = params.add(JSON.stringify(queryVector));
        const { rows } = await this.client.query(
          `SELECT ${columns}, CASE WHEN embedding IS NULL THEN 0 ELSE 1 - (embedding <=> ${vector}::vector) END AS score
           FROM ${this.table} WHERE ${where.join(' AND ')}
           ORDER BY embedding <=> ${vector}::vector NULLS LAST, updated_at DESC
           LIMIT ${params.add(limit)} OFFSET ${params.add(offset)}`,
          params.values,
        );
        return rows.map((row) => toItem(row as StoreRow, Number((row as StoreRow).score ?? 0)) as StoreItem<V>);
      }

      // Without pgvector the ranking happens here, over every candidate under the prefix.
      const { rows } = await this.client.query(
        `SELECT ${columns}, embedding::text AS embedding FROM ${this.table} WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`,
        params.values,
      );
      return rows
        .map((row) => {
          const embedding = (row as StoreRow).embedding;
          const vector = embedding == null ? undefined : fromJson<number[]>(embedding);
          return toItem(row as StoreRow, vector && queryVector ? cosine(vector, queryVector) : 0);
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(offset, offset + limit) as Array<StoreItem<V>>;
    }

    if (options.query) {
      // Without an index a query matches text in the stored value, as the other stores do.
      where.push(`strpos(lower(value::text), lower(${params.add(options.query)})) > 0`);
    }
    const { rows } = await this.client.query(
      `SELECT ${columns} FROM ${this.table} WHERE ${where.join(' AND ')}
       ORDER BY updated_at DESC, ns_key, key
       LIMIT ${params.add(limit)} OFFSET ${params.add(offset)}`,
      params.values,
    );
    return rows.map((row) => toItem(row as StoreRow) as StoreItem<V>);
  }

  /** Namespaces under a prefix. Defaults to 100. */
  async listNamespaces(options: { prefix?: StoreNamespace; limit?: number } = {}): Promise<string[][]> {
    const { rows } = await this.client.query(
      `SELECT ns_key, min(namespace::text) AS namespace FROM ${this.table}
       WHERE ns_key LIKE $1 ESCAPE '\\' AND (expires_at IS NULL OR expires_at > $2)
       GROUP BY ns_key ORDER BY ns_key LIMIT $3`,
      [likePrefix(namespaceKey(options.prefix ?? [])), this.now().toISOString(), options.limit ?? 100],
    );
    return rows.map((row) => fromJson<string[]>((row as { namespace: unknown }).namespace));
  }

  /** Deletes expired items, returning how many went. Reads already hide them. */
  async sweep(): Promise<number> {
    const result = await this.client.query(`DELETE FROM ${this.table} WHERE expires_at <= $1`, [
      this.now().toISOString(),
    ]);
    return result.rowCount ?? 0;
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

function toItem(row: StoreRow, score?: number): StoreItem {
  return {
    namespace: fromJson<string[]>(row.namespace),
    key: row.key,
    value: fromJson(row.value),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(score === undefined ? {} : { score }),
  };
}
