import type { RagChunk } from '../hallucination/rag.js';
import type { VectorSearchResult } from '../hallucination/retrieval.js';
import type { RetrieveOptions, SparseRetriever } from '../rag/retrievers.js';
import type { MigrationResult, SchemaMigration } from '../utils/schema-migrations.js';
import { fromJson, type PostgresLikeClient, quoteDerived, quoteTable } from './client.js';
import type { PostgresMigrateOptions } from './migrations.js';
import { SqlParams, textArray } from './sql.js';

/** Options for `PostgresKeywordIndex`. */
export interface PostgresKeywordIndexOptions {
  /** Table name, optionally schema-qualified. Defaults to `nexus_keywords`. */
  table?: string;
  /**
   * Searches the table of a `PostgresVectorStore` instead of keeping chunks of its own. `migrate()`
   * adds a generated search column and its index to that table, the store's writes keep it current,
   * and `add()` and `delete()` leave writing to the store. One copy of every chunk, and keyword and
   * vector search can never disagree about what exists.
   */
  shared?: boolean;
  /** The text search configuration: `english`, `simple`, `german`, and so on. Defaults to `english`. */
  language?: string;
  /**
   * `any` (the default) finds chunks with any of the query's terms, ranked by how many and how close,
   * as keyword search for retrieval should. `all` needs every term, read as a web search query, with
   * quoted phrases and `-` for exclusion.
   */
  match?: 'any' | 'all';
}

const DEFAULT_TABLE = 'nexus_keywords';

function languageOf(options: PostgresKeywordIndexOptions): string {
  const language = options.language ?? 'english';
  if (!/^[a-z_]{1,63}$/.test(language)) throw new RangeError(`"${language}" is not a text search configuration name`);
  return language;
}

/**
 * The versioned schema, which `migrate()` applies. Version 1 creates the table with a generated
 * `tsvector` column and a GIN index, or, `shared`, adds the column and the index to a vector table.
 */
export function keywordIndexMigrations(options: PostgresKeywordIndexOptions = {}): SchemaMigration[] {
  const name = options.table ?? DEFAULT_TABLE;
  const table = quoteTable(name);
  const generated = `fts tsvector GENERATED ALWAYS AS (to_tsvector('${languageOf(options)}'::regconfig, content)) STORED`;
  return [
    {
      component: `keywords:${name}`,
      version: 1,
      name: options.shared ? 'add full-text search to a vector table' : 'create the keyword table',
      statements: [
        options.shared
          ? `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${generated}`
          : `CREATE TABLE IF NOT EXISTS ${table} (
  id text PRIMARY KEY,
  content text NOT NULL,
  source text,
  metadata jsonb,
  ${generated}
)`,
        `CREATE INDEX IF NOT EXISTS ${quoteDerived(name, 'fts')} ON ${table} USING gin (fts)`,
      ],
    },
  ];
}

interface KeywordRow {
  id: string;
  content: string;
  source: string | null;
  metadata: unknown;
  score: number | string;
}

/**
 * Keyword search in Postgres, with its full-text search: stemmed terms, a GIN index, and
 * `ts_rank_cd` ranking, so only the best matches leave the database however large the table.
 *
 * A `SparseRetriever`, so `hybridRetriever()` fuses it with `PostgresVectorStore`. With `shared`, it
 * searches the vector store's own table, and the hybrid search runs over one copy of the data. A
 * metadata filter runs in SQL, with the same meaning as the vector store's.
 *
 * ```ts
 * const vectors = new PostgresVectorStore(client, { dimensions: 1536, embed });
 * const keywords = new PostgresKeywordIndex(client, { table: 'nexus_vectors', shared: true });
 * await vectors.migrate();
 * await keywords.migrate();
 * const retriever = hybridRetriever([vectorRetriever(vectors), keywords]);
 * ```
 */
export class PostgresKeywordIndex implements SparseRetriever {
  private readonly table: string;
  private readonly language: string;

  constructor(
    private readonly client: PostgresLikeClient,
    private readonly options: PostgresKeywordIndexOptions = {},
  ) {
    this.table = quoteTable(options.table ?? DEFAULT_TABLE);
    this.language = languageOf(options);
  }

  /**
   * Applies this index's pending migrations, recorded in `nexus_schema_migrations`, under a lock.
   * Never runs implicitly. With `shared`, run the vector store's `migrate()` first.
   */
  async migrate(options: PostgresMigrateOptions = {}): Promise<MigrationResult> {
    const { applyPostgresMigrations } = await import('./migrations.js');
    return applyPostgresMigrations(this.client, keywordIndexMigrations(this.options), options);
  }

  /** Adds chunks, or replaces those whose id exists. With `shared`, does nothing: the vector store writes. */
  async add(chunks: readonly RagChunk[]): Promise<void> {
    if (this.options.shared || chunks.length === 0) return;
    const params = new SqlParams();
    const rows = chunks.map(
      (chunk) =>
        `(${params.add(chunk.id)}, ${params.add(chunk.content)}, ${params.add(chunk.source ?? null)}, ${params.add(
          chunk.metadata === undefined ? null : JSON.stringify(chunk.metadata),
        )}::jsonb)`,
    );
    await this.client.query(
      `INSERT INTO ${this.table} (id, content, source, metadata) VALUES ${rows.join(', ')}
       ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, source = EXCLUDED.source, metadata = EXCLUDED.metadata`,
      params.values,
    );
  }

  /** Removes chunks by id. With `shared`, does nothing: the vector store deletes. */
  async delete(ids: readonly string[]): Promise<void> {
    if (this.options.shared || ids.length === 0) return;
    await this.client.query(`DELETE FROM ${this.table} WHERE id = ANY($1::text[])`, [textArray(ids)]);
  }

  /** The chunks that best match a query's terms, best first, scored from 0 to 1. */
  async retrieve(query: string, options: RetrieveOptions = {}): Promise<VectorSearchResult[]> {
    options.signal?.throwIfAborted();
    const params = new SqlParams();
    const text = params.add(query);
    const language = `'${this.language}'::regconfig`;
    // `plainto_tsquery` joins the terms with AND; joining them with OR instead ranks partial matches
    // rather than dropping them. Its output is only quoted lexemes and operators, so the rewrite is safe.
    const tsquery =
      this.options.match === 'all'
        ? `websearch_to_tsquery(${language}, ${text})`
        : `NULLIF(replace(plainto_tsquery(${language}, ${text})::text, ' & ', ' | '), '')::tsquery`;
    const conditions = ['fts @@ q.query'];
    if (options.filter && Object.keys(options.filter).length > 0) {
      conditions.push(`metadata @> ${params.add(JSON.stringify(options.filter))}::jsonb`);
    }
    const limit = params.add(options.topK ?? 5);
    const { rows } = await this.client.query(
      `SELECT id, content, source, metadata::text AS metadata, ts_rank_cd(fts, q.query, 32) AS score
       FROM ${this.table}, (SELECT ${tsquery} AS query) AS q
       WHERE ${conditions.join(' AND ')}
       ORDER BY score DESC, id LIMIT ${limit}`,
      params.values,
    );
    return (rows as KeywordRow[]).map((row) => ({
      id: row.id,
      content: row.content,
      ...(row.source === null ? {} : { source: row.source }),
      ...(row.metadata === null ? {} : { metadata: fromJson<Record<string, unknown>>(row.metadata) }),
      score: Number(row.score),
    }));
  }

  /** Chunks held. */
  async size(): Promise<number> {
    const { rows } = await this.client.query(`SELECT count(*)::int AS count FROM ${this.table}`);
    return Number((rows[0] as { count: number | string } | undefined)?.count ?? 0);
  }
}
