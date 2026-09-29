import {
  cosineSimilarity,
  createHashEmbeddings,
  type EmbeddingProvider,
  normalizeVector,
  type VectorDocument,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorStore,
} from '../hallucination/retrieval.js';
import { assertDimensions, assertWidth, filterEntries, parseMetadata, vectorsFor } from '../rag/vector-helpers.js';
import {
  quoteSqliteTable,
  type SqliteDatabaseLike,
  type SqliteLikeClient,
  type SqliteValue,
  toSqliteClient,
} from './client.js';

/** Options for the SQLite vector store. */
export interface SqliteVectorStoreOptions {
  /** Width of every vector. Must match the embedding function's output. */
  dimensions: number;
  /** The table chunks are kept in. Defaults to `nexus_vectors`. */
  table?: string;
  /**
   * How similarity is computed. `sqlite-vec` ranks inside SQLite with the extension's
   * `vec_distance_cosine()`, so only the best rows leave the database; load the extension into the
   * handle first. `scan` needs no extension and ranks in JavaScript, reading every row that passes the
   * filter. Defaults to `scan`.
   */
  search?: 'sqlite-vec' | 'scan';
  /** Embeds chunks that arrive without a vector, and search queries. Defaults to hashed term vectors. */
  embed?: EmbeddingProvider;
}

interface VectorRow {
  id: string;
  content: string;
  source: string | null;
  metadata: string | null;
  embedding?: unknown;
  distance?: number;
}

/** The statement that creates the vector table, for a migration tool that runs SQL itself. */
export function sqliteVectorStoreMigration(options: { table?: string } = {}): string {
  const table = quoteSqliteTable(options.table ?? 'nexus_vectors');
  return `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT, metadata TEXT, embedding BLOB NOT NULL)`;
}

/**
 * Retrieval chunks in SQLite: one file, no server, the same contract as every other store.
 *
 * Vectors are stored as float32 blobs, the format sqlite-vec reads. Filters run in SQL against the
 * metadata JSON, matching type as well as value, as the memory store does. Search is exact in both
 * modes, which suits a single node's corpus; beyond a few hundred thousand chunks, use pgvector or a
 * dedicated vector database.
 */
export class SqliteVectorStore implements VectorStore {
  private readonly client: SqliteLikeClient;
  private readonly table: string;
  private readonly embed: EmbeddingProvider;

  constructor(
    database: SqliteLikeClient | SqliteDatabaseLike,
    private readonly options: SqliteVectorStoreOptions,
  ) {
    assertDimensions(options.dimensions);
    this.client = toSqliteClient(database);
    this.table = quoteSqliteTable(options.table ?? 'nexus_vectors');
    this.embed = options.embed ?? ((texts) => createHashEmbeddings(texts, options.dimensions));
  }

  /** Creates the table unless it exists. Never runs implicitly. */
  async migrate(): Promise<void> {
    await this.client.exec(sqliteVectorStoreMigration(this.options));
  }

  /** Adds chunks, or replaces those whose id exists, embedding those without a vector in one batch. */
  async add(documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const vectors = await vectorsFor(documents, this.embed, this.options.dimensions);
    for (const [index, doc] of documents.entries()) {
      await this.client.run(
        `INSERT INTO ${this.table} (id, content, source, metadata, embedding) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, source = excluded.source,
         metadata = excluded.metadata, embedding = excluded.embedding`,
        [
          doc.id,
          doc.content,
          doc.source ?? null,
          doc.metadata ? JSON.stringify(doc.metadata) : null,
          toBlob(normalizeVector(vectors[index])),
        ],
      );
    }
  }

  /** The chunks most similar to a query, best first. */
  async search(query: string, options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const [vector] = await this.embed([query]);
    return this.searchVector(vector, options);
  }

  /** The chunks most similar to a vector, best first. */
  async searchVector(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    assertWidth(vector, this.options.dimensions);
    const topK = options.topK || 5;
    const minScore = options.minScore ?? 0;
    const { where, params } = filterSql(options.filter);

    if (this.options.search === 'sqlite-vec') {
      const rows = (await this.client.all(
        `SELECT id, content, source, metadata, vec_distance_cosine(embedding, ?) AS distance FROM ${this.table}${where}
         ORDER BY distance LIMIT ?`,
        [toBlob(vector), ...params, topK],
      )) as VectorRow[];
      return rows.map((row) => result(row, 1 - Number(row.distance))).filter((found) => found.score >= minScore);
    }

    const query = normalizeVector(vector);
    const rows = (await this.client.all(
      `SELECT id, content, source, metadata, embedding FROM ${this.table}${where}`,
      params,
    )) as VectorRow[];
    return rows
      .map((row) => result(row, cosineSimilarity(query, fromBlob(row.embedding))))
      .filter((found) => found.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Removes chunks by id. */
  async delete(ids: readonly string[]): Promise<void> {
    for (let start = 0; start < ids.length; start += 500) {
      const batch = ids.slice(start, start + 500);
      await this.client.run(`DELETE FROM ${this.table} WHERE id IN (${batch.map(() => '?').join(', ')})`, batch);
    }
  }
}

function result(row: VectorRow, score: number): VectorSearchResult {
  const metadata = parseMetadata(row.metadata);
  return {
    id: row.id,
    content: row.content,
    ...(row.source ? { source: row.source } : {}),
    ...(metadata ? { metadata } : {}),
    score,
  };
}

/** A filter as SQL over the metadata JSON, matching each value's JSON type as well as the value. */
function filterSql(filter: VectorSearchOptions['filter']): { where: string; params: SqliteValue[] } {
  const clauses: string[] = [];
  const params: SqliteValue[] = [];
  for (const [key, value] of filterEntries(filter)) {
    const path = `$."${key.replace(/["\\]/g, (char) => `\\${char}`)}"`;
    if (typeof value === 'boolean') {
      clauses.push('json_type(metadata, ?) = ?');
      params.push(path, value ? 'true' : 'false');
    } else if (typeof value === 'number') {
      clauses.push("json_type(metadata, ?) IN ('integer', 'real') AND json_extract(metadata, ?) = ?");
      params.push(path, path, value);
    } else {
      clauses.push("json_type(metadata, ?) = 'text' AND json_extract(metadata, ?) = ?");
      params.push(path, path, value);
    }
  }
  return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

function toBlob(vector: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(new Float32Array(vector).buffer);
  return typeof Buffer === 'undefined' ? bytes : Buffer.from(bytes.buffer);
}

/** Reads a float32 blob as a driver returns it: a `Uint8Array`, a `Buffer`, or an `ArrayBuffer`. */
function fromBlob(value: unknown): number[] {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : (value as Uint8Array);
  // Copied, because a driver's buffer may start at an offset that is not a multiple of four.
  return Array.from(new Float32Array(bytes.slice().buffer));
}
