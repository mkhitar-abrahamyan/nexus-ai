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
  searchLimit,
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
 * No Pinecone client is a dependency. `PineconeVectorStore.create()` creates the index, with the cosine
 * metric and the store's width, or give the store the host of one made so; chunk ids are Pinecone ids
 * as they are. Each chunk's text, source, and metadata travel in the
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

  /**
   * A store over the named index, created first, as `ensurePineconeIndex()` does, when it does not exist.
   *
   * ```ts
   * const store = await PineconeVectorStore.create({ apiKey, name: 'docs', dimensions: 1536, embed });
   * ```
   */
  static async create(options: PineconeCreateOptions): Promise<PineconeVectorStore> {
    const { name, cloud, region, deletionProtection, tags, readyTimeoutMs, pollMs, controlUrl, ...store } = options;
    const index = await ensurePineconeIndex({
      apiKey: store.apiKey,
      name,
      dimensions: store.dimensions,
      ...(cloud !== undefined ? { cloud } : {}),
      ...(region !== undefined ? { region } : {}),
      ...(deletionProtection !== undefined ? { deletionProtection } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(readyTimeoutMs !== undefined ? { readyTimeoutMs } : {}),
      ...(pollMs !== undefined ? { pollMs } : {}),
      ...(controlUrl !== undefined ? { controlUrl } : {}),
      ...(store.apiVersion !== undefined ? { apiVersion: store.apiVersion } : {}),
      ...(store.fetch !== undefined ? { fetch: store.fetch } : {}),
      ...(store.headers !== undefined ? { headers: store.headers } : {}),
      ...(store.timeoutMs !== undefined ? { timeoutMs: store.timeoutMs } : {}),
    });
    return new PineconeVectorStore({ ...store, host: index.host });
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
      topK: searchLimit(options.topK),
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

/** Options for `ensurePineconeIndex()`: the index, and how to reach Pinecone's control plane. */
export interface PineconeIndexOptions {
  /** The Pinecone API key. */
  apiKey: string;
  /** The index's name: 1 to 45 lowercase letters, digits, and hyphens, beginning and ending with a letter or digit. */
  name: string;
  /** Width of every vector. An index that exists must have it. */
  dimensions: number;
  /** Where a new serverless index runs. Defaults to `aws`. */
  cloud?: 'aws' | 'gcp' | 'azure';
  /** The cloud's region for a new index. Defaults to `us-east-1`. */
  region?: string;
  /** Protects a new index from deletion. Defaults to false. */
  deletionProtection?: boolean;
  /** Tags on a new index. */
  tags?: Readonly<Record<string, string>>;
  /** How long to wait for the index to be ready, in milliseconds. Defaults to 5 minutes. */
  readyTimeoutMs?: number;
  /** How often to ask whether it is ready, in milliseconds. Defaults to 2 seconds. */
  pollMs?: number;
  /** The control plane's URL. Defaults to `https://api.pinecone.io`. */
  controlUrl?: string;
  /** The `X-Pinecone-API-Version` header. Defaults to `2025-04`. */
  apiVersion?: string;
  /** Replaces the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /** Aborts a request that takes longer, in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
}

/** An index ready to take vectors. */
export interface PineconeIndex {
  /** Its name. */
  name: string;
  /** Its data-plane host, which `PineconeVectorStore` takes. */
  host: string;
  /** Whether this call created it, rather than finding it. */
  created: boolean;
}

/** What `PineconeVectorStore.create()` takes: the store's options, its host aside, and the index's. */
export type PineconeCreateOptions = Omit<PineconeVectorStoreOptions, 'host'> &
  Pick<
    PineconeIndexOptions,
    'name' | 'cloud' | 'region' | 'deletionProtection' | 'tags' | 'readyTimeoutMs' | 'pollMs' | 'controlUrl'
  >;

interface PineconeIndexModel {
  name?: string;
  dimension?: number;
  metric?: string;
  host?: string;
  status?: { ready?: boolean; state?: string };
}

/**
 * Creates a serverless index with the cosine metric and the store's width, unless one of that name
 * exists, and waits until it is ready. An index that exists is used when its width and metric are the
 * store's, and refused otherwise; one created by another process at the same moment is used as found.
 *
 * ```ts
 * const { host } = await ensurePineconeIndex({ apiKey, name: 'docs', dimensions: 1536, region: 'eu-west-1' });
 * ```
 */
export async function ensurePineconeIndex(options: PineconeIndexOptions): Promise<PineconeIndex> {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?$/.test(options.name)) {
    throw new TypeError(
      `"${options.name}" is not an index name: 1 to 45 lowercase letters, digits, and hyphens, beginning and ending with a letter or digit`,
    );
  }
  assertDimensions(options.dimensions);
  const control = (options.controlUrl ?? 'https://api.pinecone.io').replace(/\/+$/, '');
  const path = `/indexes/${options.name}`;
  const call = (method: string, url: string, body?: unknown, missing = false) =>
    requestJson({
      fetch: options.fetch ?? globalThis.fetch,
      url: `${control}${url}`,
      method,
      headers: {
        'Api-Key': options.apiKey,
        'X-Pinecone-API-Version': options.apiVersion ?? '2025-04',
        ...options.headers,
      },
      ...(body === undefined ? {} : { body }),
      timeoutMs: options.timeoutMs ?? 30_000,
      ...(missing ? { notFound: undefined } : {}),
      error: (message, status, text) => new PineconeError(`Pinecone ${message}`, status, text),
    }) as Promise<PineconeIndexModel | undefined>;

  let created = false;
  let index = await call('GET', path, undefined, true);
  if (!index) {
    try {
      index = await call('POST', '/indexes', {
        name: options.name,
        dimension: options.dimensions,
        metric: 'cosine',
        spec: { serverless: { cloud: options.cloud ?? 'aws', region: options.region ?? 'us-east-1' } },
        deletion_protection: options.deletionProtection ? 'enabled' : 'disabled',
        ...(options.tags ? { tags: options.tags } : {}),
      });
      created = true;
    } catch (error) {
      // Another process created it first: it is read, and checked, as one found.
      if (!(error instanceof PineconeError) || error.status !== 409) throw error;
      index = await call('GET', path);
    }
  }
  if (index?.dimension !== options.dimensions || index.metric !== 'cosine') {
    throw new PineconeError(
      `The index "${options.name}" is ${index?.dimension} wide with the ${index?.metric} metric; the store needs ${options.dimensions} and cosine`,
      409,
    );
  }
  const deadline = Date.now() + (options.readyTimeoutMs ?? 300_000);
  while (!index?.status?.ready) {
    const state = index?.status?.state;
    if (state === 'InitializationFailed' || state === 'Terminating') {
      throw new PineconeError(`The index "${options.name}" is ${state}`, 409);
    }
    if (Date.now() >= deadline) {
      throw new PineconeError(
        `The index "${options.name}" was not ready within ${options.readyTimeoutMs ?? 300_000} ms`,
        504,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 2_000));
    index = await call('GET', path);
  }
  if (!index.host) throw new PineconeError(`The index "${options.name}" names no host`, 502);
  return { name: options.name, host: `https://${index.host.replace(/^https?:\/\//, '')}`, created };
}
