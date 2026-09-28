import {
  createHashEmbeddings,
  type EmbeddingProvider,
  type VectorDocument,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorStore,
} from '../hallucination/retrieval.js';

/** Options for the Qdrant store. */
export interface QdrantVectorStoreOptions {
  /** The Qdrant server, such as `http://localhost:6333` or a Qdrant Cloud cluster URL. */
  url: string;
  /** The collection chunks are kept in. */
  collection: string;
  /** Width of every vector. Must match the embedding function's output. */
  dimensions: number;
  /** Sent as the `api-key` header, for Qdrant Cloud or a secured server. */
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

/** Raised when Qdrant answers with an error. */
export class QdrantError extends Error {
  constructor(
    message: string,
    /** The HTTP status Qdrant answered with. */
    readonly status: number,
    /** Qdrant's response body, as text. */
    readonly body?: string,
  ) {
    super(message);
    this.name = 'QdrantError';
  }
}

interface QdrantPoint {
  id: string;
  score: number;
  payload?: { id?: string; content?: string; source?: string | null; metadata?: Record<string, unknown> | null };
}

/**
 * Retrieval chunks in a Qdrant collection, through its REST API.
 *
 * No Qdrant client is a dependency: the store speaks HTTP through `fetch`, so it runs wherever
 * `fetch` and Web Crypto do, edge runtimes included. The same contract as `MemoryVectorStore`,
 * checked by the same tests. Qdrant point ids must be UUIDs or integers, so each chunk id is mapped
 * to a stable UUID derived from it, and the original id travels in the payload.
 */
export class QdrantVectorStore implements VectorStore {
  private readonly base: string;
  private readonly embed: EmbeddingProvider;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: QdrantVectorStoreOptions) {
    if (!(Number.isInteger(options.dimensions) && options.dimensions > 0)) {
      throw new RangeError('dimensions must be a positive integer');
    }
    this.base = `${options.url.replace(/\/+$/, '')}/collections/${encodeURIComponent(options.collection)}`;
    this.embed = options.embed ?? ((texts) => createHashEmbeddings(texts, options.dimensions));
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Creates the collection with cosine distance unless it already exists, then indexes the
   * `metadata` fields you filter on. A list indexes them as keywords; a map names each field's type.
   * Never runs implicitly.
   */
  async migrate(
    options: { filterFields?: readonly string[] | Record<string, 'keyword' | 'integer' | 'float' | 'bool'> } = {},
  ): Promise<void> {
    const existing = await this.request('GET', '', undefined, { allowNotFound: true });
    if (existing === undefined) {
      await this.request('PUT', '', { vectors: { size: this.options.dimensions, distance: 'Cosine' } });
    }
    const fields: Array<readonly [string, string]> = Array.isArray(options.filterFields)
      ? options.filterFields.map((field) => [field, 'keyword'] as const)
      : Object.entries(options.filterFields ?? {});
    for (const [field, schema] of fields) {
      await this.request('PUT', '/index?wait=true', { field_name: `metadata.${field}`, field_schema: schema });
    }
  }

  /** Adds chunks, or replaces those whose id exists, embedding those without a vector in one batch. */
  async add(documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;
    const missing = documents.filter((doc) => !doc.embedding).map((doc) => doc.content);
    const generated = missing.length ? await this.embed(missing) : [];
    let generatedIndex = 0;

    const points = await Promise.all(
      documents.map(async (doc) => {
        const vector = doc.embedding ?? generated[generatedIndex++];
        this.assertWidth(vector);
        return {
          id: await pointId(doc.id),
          vector,
          payload: { id: doc.id, content: doc.content, source: doc.source ?? null, metadata: doc.metadata ?? null },
        };
      }),
    );
    await this.request('PUT', '/points?wait=true', { points });
  }

  /** The chunks most similar to a query, best first. */
  async search(query: string, options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const [vector] = await this.embed([query]);
    return this.searchVector(vector, options);
  }

  /** The chunks most similar to a vector, best first. */
  async searchVector(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    this.assertWidth(vector);
    const filter = options.filter && Object.keys(options.filter).length > 0 ? options.filter : undefined;
    const result = (await this.request('POST', '/points/search', {
      vector,
      limit: options.topK || 5,
      with_payload: true,
      score_threshold: options.minScore ?? 0,
      ...(filter
        ? {
            filter: {
              must: Object.entries(filter).map(([key, value]) => ({ key: `metadata.${key}`, match: { value } })),
            },
          }
        : {}),
    })) as QdrantPoint[];

    return result.map((point) => ({
      id: point.payload?.id ?? String(point.id),
      content: point.payload?.content ?? '',
      ...(point.payload?.source ? { source: point.payload.source } : {}),
      ...(point.payload?.metadata ? { metadata: point.payload.metadata } : {}),
      score: point.score,
    }));
  }

  /** Removes chunks by id. */
  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.request('POST', '/points/delete?wait=true', { points: await Promise.all(ids.map(pointId)) });
  }

  private assertWidth(vector: number[] | undefined): asserts vector is number[] {
    if (!vector || vector.length !== this.options.dimensions) {
      throw new RangeError(
        `A vector has ${vector?.length ?? 0} dimensions; this store was created with ${this.options.dimensions}`,
      );
    }
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    options: { allowNotFound?: boolean } = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      const response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.options.apiKey ? { 'api-key': this.options.apiKey } : {}),
          ...this.options.headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (response.status === 404 && options.allowNotFound) return undefined;
      const text = await response.text();
      if (!response.ok) {
        throw new QdrantError(`Qdrant ${method} ${path || '/'} failed with ${response.status}`, response.status, text);
      }
      return text ? (JSON.parse(text) as { result?: unknown }).result : undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A stable UUID for a chunk id, from the first 16 bytes of its SHA-256, shaped as version 5. */
async function pointId(id: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)));
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
