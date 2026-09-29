import {
  createHashEmbeddings,
  type EmbeddingProvider,
  type VectorDocument,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorStore,
} from '../hallucination/retrieval.js';
import { assertDimensions, assertWidth, filterEntries, parseMetadata, vectorsFor } from './vector-helpers.js';

/**
 * A Redis client that sends raw commands — what RediSearch's `FT.*` commands need. ioredis provides
 * `call()`; node-redis provides `sendCommand()`. Either works.
 */
export type RedisVectorLikeClient =
  | {
      /** Sends a command with its arguments, as ioredis does. */
      call(command: string, ...args: Array<string | Buffer>): Promise<unknown>;
    }
  | {
      /** Sends a command as one array, as node-redis does. */
      sendCommand(args: Array<string | Buffer>): Promise<unknown>;
    };

/** Options for the Redis store. */
export interface RedisVectorStoreOptions {
  /** Width of every vector. Must match the embedding function's output. */
  dimensions: number;
  /** The RediSearch index. Defaults to `nexus:vectors`. */
  index?: string;
  /** The prefix of each chunk's hash key. Defaults to `nexus:vector:`. */
  prefix?: string;
  /**
   * Metadata fields a search can filter on. RediSearch filters only on fields declared in the index,
   * so these are indexed as tags, and a filter on any other field is refused.
   */
  filterFields?: readonly string[];
  /** `HNSW` for approximate search that scales, or `FLAT` for exact search. Defaults to `HNSW`. */
  algorithm?: 'HNSW' | 'FLAT';
  /** Embeds chunks that arrive without a vector, and search queries. Defaults to hashed term vectors. */
  embed?: EmbeddingProvider;
}

/**
 * Retrieval chunks in Redis, searched by RediSearch's vector index (Redis Stack, Redis 8, or Redis
 * Cloud).
 *
 * No Redis package is a dependency: the store sends commands through the client you pass. Each chunk
 * is a hash holding its text, source, metadata as JSON, and its vector as float32 bytes. Declared
 * filter fields are copied into tag fields with their type, so a filter matches `3` and `"3"` as the
 * memory store does — as different values.
 */
export class RedisVectorStore implements VectorStore {
  private readonly send: (args: Array<string | Buffer>) => Promise<unknown>;
  private readonly index: string;
  private readonly prefix: string;
  private readonly fields: Set<string>;
  private readonly embed: EmbeddingProvider;

  constructor(
    client: RedisVectorLikeClient,
    private readonly options: RedisVectorStoreOptions,
  ) {
    assertDimensions(options.dimensions);
    this.send =
      'sendCommand' in client
        ? (args) => client.sendCommand(args)
        : (args) => client.call(args[0] as string, ...args.slice(1));
    this.index = options.index ?? 'nexus:vectors';
    this.prefix = options.prefix ?? 'nexus:vector:';
    this.fields = new Set(options.filterFields ?? []);
    for (const field of this.fields) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) throw new RangeError(`"${field}" cannot be a filter field`);
    }
    this.embed = options.embed ?? ((texts) => createHashEmbeddings(texts, options.dimensions));
  }

  /** Creates the index unless it exists. Never runs implicitly. */
  async migrate(): Promise<void> {
    const algorithm = this.options.algorithm ?? 'HNSW';
    try {
      await this.send([
        'FT.CREATE',
        this.index,
        'ON',
        'HASH',
        'PREFIX',
        '1',
        this.prefix,
        'SCHEMA',
        'embedding',
        'VECTOR',
        algorithm,
        '6',
        'TYPE',
        'FLOAT32',
        'DIM',
        String(this.options.dimensions),
        'DISTANCE_METRIC',
        'COSINE',
        ...[...this.fields].flatMap((field) => [`f_${field}`, 'TAG', 'CASESENSITIVE']),
      ]);
    } catch (error) {
      if (!/already exists/i.test(String((error as Error)?.message ?? error))) throw error;
    }
  }

  /** Adds chunks, or replaces those whose id exists, embedding those without a vector in one batch. */
  async add(documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const vectors = await vectorsFor(documents, this.embed, this.options.dimensions);
    await Promise.all(
      documents.map(async (doc, index) => {
        const key = this.prefix + doc.id;
        // Replacing, not merging: a tag field the new version lacks must not survive from the old one.
        await this.send(['DEL', key]);
        await this.send([
          'HSET',
          key,
          'id',
          doc.id,
          'content',
          doc.content,
          'source',
          doc.source ?? '',
          'metadata',
          JSON.stringify(doc.metadata ?? null),
          'embedding',
          toBytes(vectors[index]),
          ...[...this.fields].flatMap((field) => {
            const value = doc.metadata?.[field];
            return isFilterValue(value) ? [`f_${field}`, tagValue(value)] : [];
          }),
        ]);
      }),
    );
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
    const clauses = filterEntries(options.filter).map(([field, value]) => {
      if (!this.fields.has(field)) {
        throw new RangeError(`"${field}" is not a filter field of this store; add it to filterFields and migrate`);
      }
      return `@f_${field}:{${escapeTag(tagValue(value))}}`;
    });
    const reply = (await this.send([
      'FT.SEARCH',
      this.index,
      `${clauses.length ? `(${clauses.join(' ')})` : '*'}=>[KNN ${topK} @embedding $vector AS distance]`,
      'PARAMS',
      '2',
      'vector',
      toBytes(vector),
      'SORTBY',
      'distance',
      'ASC',
      'RETURN',
      '5',
      'id',
      'content',
      'source',
      'metadata',
      'distance',
      'LIMIT',
      '0',
      String(topK),
      'DIALECT',
      '2',
    ])) as unknown[];

    const minScore = options.minScore ?? 0;
    const results: VectorSearchResult[] = [];
    for (let index = 1; index + 1 < reply.length; index += 2) {
      const values = reply[index + 1] as unknown[];
      const hash: Record<string, string> = {};
      for (let field = 0; field + 1 < values.length; field += 2)
        hash[String(values[field])] = String(values[field + 1]);
      const score = 1 - Number(hash.distance);
      if (score < minScore) continue;
      const metadata = parseMetadata(hash.metadata);
      results.push({
        id: hash.id ?? String(reply[index]).slice(this.prefix.length),
        content: hash.content ?? '',
        ...(hash.source ? { source: hash.source } : {}),
        ...(metadata ? { metadata } : {}),
        score,
      });
    }
    return results;
  }

  /** Removes chunks by id. */
  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.send(['DEL', ...ids.map((id) => this.prefix + id)]);
  }
}

function toBytes(vector: readonly number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function isFilterValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
  );
}

/** A filter value tagged with its type, so a number and the same digits as a string stay distinct. */
function tagValue(value: string | number | boolean): string {
  return `${typeof value === 'string' ? 's' : typeof value === 'number' ? 'n' : 'b'}:${value}`;
}

/** Escapes a tag value for a RediSearch query: every character that is not a letter or digit. */
function escapeTag(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, (char) => `\\${char}`);
}
