import {
  createHashEmbeddings,
  type EmbeddingProvider,
  type VectorDocument,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorStore,
} from '../hallucination/retrieval.js';
import type { MigrationResult, SchemaMigration } from '../utils/schema-migrations.js';
import { fromJson, type PostgresLikeClient, quoteDerived, quoteTable } from './client.js';
import type { PostgresMigrateOptions } from './migrations.js';
import { SqlParams, textArray } from './sql.js';

/** Options for the pgvector store. */
export interface PostgresVectorStoreOptions {
  /** Width of every vector. Must match the embedding function's output. */
  dimensions: number;
  /** Embeds chunks that arrive without a vector, and search queries. Defaults to hashed term vectors. */
  embed?: EmbeddingProvider;
  /** Table name, optionally schema-qualified. Defaults to `nexus_vectors`. */
  table?: string;
  /**
   * The approximate index created by `migrate()`. `hnsw` (the default) answers a search without
   * scanning every row, at the cost of slower writes; `none` scans exactly, which suits a few
   * thousand chunks.
   */
  index?: 'hnsw' | 'none';
}

const DEFAULT_TABLE = 'nexus_vectors';

/**
 * The versioned schema, which `migrate()` and `nexus db migrate` apply. Version 1 is the 2.0 schema.
 */
export function vectorStoreMigrations(options: Omit<PostgresVectorStoreOptions, 'embed'>): SchemaMigration[] {
  return [
    {
      component: `vectors:${options.table ?? DEFAULT_TABLE}`,
      version: 1,
      name: 'create the vectors table',
      statements: vectorStoreMigration(options),
    },
  ];
}

/** The schema, as statements: the pgvector extension, the table, and its index. */
export function vectorStoreMigration(options: Omit<PostgresVectorStoreOptions, 'embed'>): string[] {
  const dimensions = options.dimensions;
  if (!(Number.isInteger(dimensions) && dimensions > 0)) throw new RangeError('dimensions must be a positive integer');
  const name = options.table ?? DEFAULT_TABLE;
  const table = quoteTable(name);
  return [
    'CREATE EXTENSION IF NOT EXISTS vector',
    `CREATE TABLE IF NOT EXISTS ${table} (
  id text PRIMARY KEY,
  content text NOT NULL,
  source text,
  metadata jsonb,
  embedding vector(${dimensions}) NOT NULL
)`,
    ...(options.index === 'none'
      ? []
      : [
          `CREATE INDEX IF NOT EXISTS ${quoteDerived(name, 'embedding')} ON ${table} USING hnsw (embedding vector_cosine_ops)`,
        ]),
  ];
}

interface VectorRow {
  id: string;
  content: string;
  source: string | null;
  metadata: unknown;
  score: number | string;
}

/**
 * Retrieval chunks in Postgres with pgvector, ranked by cosine similarity in the database.
 *
 * The same contract as `MemoryVectorStore`, checked by the same tests. Only the nearest chunks leave
 * the database, so a search costs the same whether the table holds a thousand chunks or ten million.
 * Adding a chunk whose id exists replaces it, and a metadata filter runs in SQL.
 */
export class PostgresVectorStore implements VectorStore {
  private readonly table: string;
  private readonly embed: EmbeddingProvider;

  constructor(
    private readonly client: PostgresLikeClient,
    private readonly options: PostgresVectorStoreOptions,
  ) {
    if (!(Number.isInteger(options.dimensions) && options.dimensions > 0)) {
      throw new RangeError('dimensions must be a positive integer');
    }
    this.table = quoteTable(options.table ?? DEFAULT_TABLE);
    this.embed = options.embed ?? ((texts) => createHashEmbeddings(texts, options.dimensions));
  }

  /**
   * Applies this store's pending migrations, recorded in `nexus_schema_migrations`, under a lock.
   * Never runs implicitly. Safe on a database an older release created: what exists is kept.
   */
  async migrate(options: PostgresMigrateOptions = {}): Promise<MigrationResult> {
    // Loaded when called, so an application that migrates elsewhere never imports the runner.
    const { applyPostgresMigrations } = await import('./migrations.js');
    return applyPostgresMigrations(this.client, vectorStoreMigrations(this.options), options);
  }

  /** Adds chunks, or replaces those whose id exists, embedding those without a vector in one batch. */
  async add(documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const missing = documents.filter((doc) => !doc.embedding).map((doc) => doc.content);
    const generated = missing.length ? await this.embed(missing) : [];
    let generatedIndex = 0;

    const params = new SqlParams();
    const rows = documents.map((doc) => {
      const embedding = doc.embedding ?? generated[generatedIndex++];
      this.assertWidth(embedding);
      return `(${params.add(doc.id)}, ${params.add(doc.content)}, ${params.add(doc.source ?? null)}, ${params.add(
        doc.metadata === undefined ? null : JSON.stringify(doc.metadata),
      )}::jsonb, ${params.add(JSON.stringify(embedding))}::vector)`;
    });
    await this.client.query(
      `INSERT INTO ${this.table} (id, content, source, metadata, embedding) VALUES ${rows.join(', ')}
       ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, source = EXCLUDED.source,
         metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding`,
      params.values,
    );
  }

  /** The chunks most similar to a query, best first. */
  async search(query: string, options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const [vector] = await this.embed([query]);
    return this.searchVector(vector, options);
  }

  /** The chunks most similar to a vector, best first. */
  async searchVector(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    this.assertWidth(vector);
    const params = new SqlParams();
    const query = params.add(JSON.stringify(vector));
    const conditions: string[] = [];
    if (options.filter && Object.keys(options.filter).length > 0) {
      conditions.push(`metadata @> ${params.add(JSON.stringify(options.filter))}::jsonb`);
    }
    const minScore = options.minScore ?? 0;
    conditions.push(`1 - (embedding <=> ${query}::vector) >= ${params.add(minScore)}`);
    const limit = params.add(options.topK || 5);

    const { rows } = await this.client.query(
      `SELECT id, content, source, metadata::text AS metadata, 1 - (embedding <=> ${query}::vector) AS score
       FROM ${this.table} WHERE ${conditions.join(' AND ')}
       ORDER BY embedding <=> ${query}::vector LIMIT ${limit}`,
      params.values,
    );
    return (rows as VectorRow[]).map((row) => ({
      id: row.id,
      content: row.content,
      ...(row.source === null ? {} : { source: row.source }),
      ...(row.metadata === null ? {} : { metadata: fromJson<Record<string, unknown>>(row.metadata) }),
      score: Number(row.score),
    }));
  }

  /** Removes chunks by id. */
  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.query(`DELETE FROM ${this.table} WHERE id = ANY($1::text[])`, [textArray(ids)]);
  }

  /** Chunks stored. */
  async size(): Promise<number> {
    const { rows } = await this.client.query(`SELECT count(*)::int AS count FROM ${this.table}`);
    return Number((rows[0] as { count: number | string } | undefined)?.count ?? 0);
  }

  private assertWidth(vector: number[] | undefined): asserts vector is number[] {
    if (!vector || vector.length !== this.options.dimensions) {
      throw new RangeError(
        `A vector has ${vector?.length ?? 0} dimensions; this store was created with ${this.options.dimensions}`,
      );
    }
  }
}
