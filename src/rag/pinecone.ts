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

/** Options for the Pinecone store. */
export interface PineconeVectorStoreOptions {
  /** The index's host, as the Pinecone console shows it, such as `https://docs-abc123.svc.aped-4627-b74a.pinecone.io`. */
  host: string;
  /** The Pinecone API key. */
  apiKey: string;
  /** The namespace chunks are kept in. Defaults to the index's default namespace. */
  namespace?: string;
  /** Width of every vector. Must match the index and the embedding function. */
  dimensions: number;
  /** Embeds chunks that arrive without a vector, and search queries. Defaults to hashed term vectors. */
  embed?: EmbeddingProvider;
  /** The `X-Pinecone-API-Version` header. Defaults to `2025-04`. */
  apiVersion?: string;
  /** Vectors sent per upsert request. Defaults to 100, well under Pinecone's request limits. */
  batchSize?: number;
  /** Replaces the global `fetch`, for a proxy, retries, or tests. */
  fetch?: typeof globalThis.fetch;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /** Aborts a request that takes longer, in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
}

/** Raised when Pinecone answers with an error. */
export class PineconeError extends Error {
  constructor(
    message: string,
    /** The HTTP status Pinecone answered with. */
    readonly status: number,
    /** Pinecone's response body, as text. */
    readonly body?: string,
  ) {
    super(message);
    this.name = 'PineconeError';
  }
}

interface PineconeMatch {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * Retrieval chunks in a Pinecone index, through its data-plane REST API.
 *
 * No Pinecone client is a dependency. Create the index with the cosine metric and the store's width;
 * chunk ids are Pinecone ids as they are. Each chunk's text, source, and metadata travel in the
 * vector's metadata, and its top-level string, number, and boolean metadata fields are copied under
 * `meta_` names, which is what a search filter matches on.
 */
export class PineconeVectorStore implements VectorStore {
  private readonly base: string;
  private readonly embed: EmbeddingProvider;

  constructor(private readonly options: PineconeVectorStoreOptions) {
    assertDimensions(options.dimensions);
    this.base = options.host.startsWith('http') ? options.host : `https://${options.host}`;
    this.base = this.base.replace(/\/+$/, '');
    this.embed = options.embed ?? ((texts) => createHashEmbeddings(texts, options.dimensions));
  }

  /** Adds chunks, or replaces those whose id exists, embedding those without a vector in one batch. */
  async add(documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const vectors = await vectorsFor(documents, this.embed, this.options.dimensions);
    const records = documents.map((doc, index) => ({
      id: doc.id,
      values: vectors[index],
      metadata: {
        ...filterFields(doc.metadata),
        content: doc.content,
        ...(doc.source ? { source: doc.source } : {}),
        ...(doc.metadata ? { metadata: JSON.stringify(doc.metadata) } : {}),
      },
    }));
    const size = this.options.batchSize ?? 100;
    for (let start = 0; start < records.length; start += size) {
      await this.request('/vectors/upsert', { vectors: records.slice(start, start + size), ...this.namespace() });
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
    const filters = filterEntries(options.filter).map(([key, value]) => ({ [`${META_PREFIX}${key}`]: { $eq: value } }));
    const result = (await this.request('/query', {
      vector,
      topK: options.topK || 5,
      includeMetadata: true,
      ...this.namespace(),
      ...(filters.length === 1 ? { filter: filters[0] } : filters.length > 1 ? { filter: { $and: filters } } : {}),
    })) as { matches?: PineconeMatch[] };
    const minScore = options.minScore ?? 0;
    return (result.matches ?? [])
      .filter((match) => match.score >= minScore)
      .map((match) => {
        const metadata = parseMetadata(match.metadata?.metadata);
        return {
          id: match.id,
          content: String(match.metadata?.content ?? ''),
          ...(typeof match.metadata?.source === 'string' ? { source: match.metadata.source } : {}),
          ...(metadata ? { metadata } : {}),
          score: match.score,
        };
      });
  }

  /** Removes chunks by id. */
  async delete(ids: readonly string[]): Promise<void> {
    const size = 1000;
    for (let start = 0; start < ids.length; start += size) {
      await this.request('/vectors/delete', { ids: ids.slice(start, start + size), ...this.namespace() });
    }
  }

  private namespace() {
    return this.options.namespace ? { namespace: this.options.namespace } : {};
  }

  private request(path: string, body: unknown): Promise<unknown> {
    return requestJson({
      fetch: this.options.fetch ?? globalThis.fetch,
      url: `${this.base}${path}`,
      method: 'POST',
      headers: {
        'Api-Key': this.options.apiKey,
        'X-Pinecone-API-Version': this.options.apiVersion ?? '2025-04',
        ...this.options.headers,
      },
      body,
      timeoutMs: this.options.timeoutMs ?? 30_000,
      error: (message, status, text) => new PineconeError(`Pinecone ${message}`, status, text),
    });
  }
}
