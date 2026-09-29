import {
  createHashEmbeddings,
  type EmbeddingProvider,
  type VectorDocument,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorStore,
} from '../hallucination/retrieval.js';
import {
  assertDimensions,
  assertWidth,
  filterEntries,
  filterFields,
  META_PREFIX,
  parseMetadata,
  requestJson,
  vectorsFor,
} from './vector-helpers.js';

/** Options for the Chroma store. */
export interface ChromaVectorStoreOptions {
  /** The Chroma server. Defaults to `http://localhost:8000`. */
  url?: string;
  /** The collection chunks are kept in. */
  collection: string;
  /** The tenant. Defaults to `default_tenant`. */
  tenant?: string;
  /** The database. Defaults to `default_database`. */
  database?: string;
  /** Width of every vector. Must match the embedding function's output. */
  dimensions: number;
  /** Sent as the `x-chroma-token` header, for Chroma Cloud or a server with token authentication. */
  apiKey?: string;
  /** Embeds chunks that arrive without a vector, and search queries. Defaults to hashed term vectors. */
  embed?: EmbeddingProvider;
  /** Replaces the global `fetch`, for a proxy, retries, or tests. */
  fetch?: typeof globalThis.fetch;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /** Aborts a request that takes longer, in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
}

/** Raised when Chroma answers with an error. */
export class ChromaError extends Error {
  constructor(
    message: string,
    /** The HTTP status Chroma answered with. */
    readonly status: number,
    /** Chroma's response body, as text. */
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ChromaError';
  }
}

interface ChromaQueryResult {
  ids: string[][];
  documents?: Array<Array<string | null>>;
  metadatas?: Array<Array<Record<string, unknown> | null>>;
  distances?: number[][];
}

/**
 * Retrieval chunks in a Chroma collection, through its v2 REST API.
 *
 * No Chroma client is a dependency. The collection uses cosine distance, and a result's score is one
 * minus that distance, so scores mean the same as in every other store. Top-level string, number, and
 * boolean metadata fields are copied under `meta_` names for filtering; the whole metadata travels as
 * JSON, so nested values come back too.
 */
export class ChromaVectorStore implements VectorStore {
  private readonly base: string;
  private readonly embed: EmbeddingProvider;
  private collectionId: Promise<string> | undefined;

  constructor(private readonly options: ChromaVectorStoreOptions) {
    assertDimensions(options.dimensions);
    const tenant = encodeURIComponent(options.tenant ?? 'default_tenant');
    const database = encodeURIComponent(options.database ?? 'default_database');
    this.base = `${(options.url ?? 'http://localhost:8000').replace(/\/+$/, '')}/api/v2/tenants/${tenant}/databases/${database}`;
    this.embed = options.embed ?? ((texts) => createHashEmbeddings(texts, options.dimensions));
  }

  /** Creates the collection with cosine distance unless it exists. Never runs implicitly. */
  async migrate(): Promise<void> {
    const created = (await this.request('POST', '/collections', {
      name: this.options.collection,
      get_or_create: true,
      metadata: { 'hnsw:space': 'cosine' },
    })) as { id: string };
    this.collectionId = Promise.resolve(created.id);
  }

  /** Adds chunks, or replaces those whose id exists, embedding those without a vector in one batch. */
  async add(documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const embeddings = await vectorsFor(documents, this.embed, this.options.dimensions);
    await this.records('/upsert', {
      ids: documents.map((doc) => doc.id),
      embeddings,
      documents: documents.map((doc) => doc.content),
      metadatas: documents.map((doc) => ({
        ...filterFields(doc.metadata),
        ...(doc.source ? { source: doc.source } : {}),
        metadata: JSON.stringify(doc.metadata ?? null),
      })),
    });
  }

  /** The chunks most similar to a query, best first. */
  async search(query: string, options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const [vector] = await this.embed([query]);
    return this.searchVector(vector, options);
  }

  /** The chunks most similar to a vector, best first. */
  async searchVector(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    assertWidth(vector, this.options.dimensions);
    const filters = filterEntries(options.filter).map(([key, value]) => ({ [`${META_PREFIX}${key}`]: { $eq: value } }));
    const result = (await this.records('/query', {
      query_embeddings: [vector],
      n_results: options.topK || 5,
      include: ['documents', 'metadatas', 'distances'],
      ...(filters.length === 1 ? { where: filters[0] } : filters.length > 1 ? { where: { $and: filters } } : {}),
    })) as ChromaQueryResult;
    const minScore = options.minScore ?? 0;
    const results: VectorSearchResult[] = [];
    for (const [index, id] of (result.ids[0] ?? []).entries()) {
      const score = 1 - (result.distances?.[0]?.[index] ?? 1);
      if (score < minScore) continue;
      const stored = result.metadatas?.[0]?.[index] ?? {};
      const metadata = parseMetadata(stored.metadata);
      results.push({
        id,
        content: result.documents?.[0]?.[index] ?? '',
        ...(typeof stored.source === 'string' ? { source: stored.source } : {}),
        ...(metadata ? { metadata } : {}),
        score,
      });
    }
    return results;
  }

  /** Removes chunks by id. */
  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.records('/delete', { ids });
  }

  private async records(path: string, body: unknown): Promise<unknown> {
    this.collectionId ??= this.request('GET', `/collections/${encodeURIComponent(this.options.collection)}`).then(
      (collection) => (collection as { id: string }).id,
      (error: unknown) => {
        this.collectionId = undefined;
        throw error;
      },
    );
    return this.request('POST', `/collections/${await this.collectionId}${path}`, body);
  }

  private request(method: string, path: string, body?: unknown): Promise<unknown> {
    return requestJson({
      fetch: this.options.fetch ?? globalThis.fetch,
      url: `${this.base}${path}`,
      method,
      headers: { ...(this.options.apiKey ? { 'x-chroma-token': this.options.apiKey } : {}), ...this.options.headers },
      body,
      timeoutMs: this.options.timeoutMs ?? 30_000,
      error: (message, status, text) => new ChromaError(`Chroma ${message}`, status, text),
    });
  }
}
