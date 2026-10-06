import type { RagChunk } from '../hallucination/rag.js';
import type { VectorSearchResult } from '../hallucination/retrieval.js';
import { linkSignals } from '../utils/signals.js';
import type { RetrieveOptions, SparseRetriever } from './retrievers.js';

/** Options for the Elasticsearch keyword index. */
export interface ElasticsearchKeywordIndexOptions {
  /** The cluster, such as `http://localhost:9200`, an Elastic Cloud endpoint, or an OpenSearch domain. */
  url: string;
  /** The index chunks are kept in. */
  index: string;
  /** Sent as `Authorization: ApiKey <key>`. */
  apiKey?: string;
  /** Sent as basic authentication, for a cluster with users instead of API keys. */
  username?: string;
  /** The password for `username`. */
  password?: string;
  /** The analyzer `migrate()` gives the `content` field, such as `english`. Defaults to the cluster's standard one. */
  analyzer?: string;
  /**
   * When a write becomes searchable. `wait_for` (the default) returns once a search would see it, as
   * the vector stores do; `false` returns sooner and leaves it to the index's refresh interval.
   */
  refresh?: 'wait_for' | boolean;
  /** Replaces the global `fetch`, for a proxy, retries, signed requests, or tests. */
  fetch?: typeof globalThis.fetch;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /** Aborts a request that takes longer, in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
}

/** Raised when the cluster answers with an error. */
export class ElasticsearchError extends Error {
  constructor(
    message: string,
    /** The HTTP status the cluster answered with. */
    readonly status: number,
    /** The cluster's response body, as text. */
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ElasticsearchError';
  }
}

interface Hit {
  _id: string;
  _score: number | null;
  _source?: { id?: string; content?: string; source?: string | null; metadata?: Record<string, unknown> | null };
}

/**
 * Keyword search in Elasticsearch or OpenSearch, through their REST API.
 *
 * No client library is a dependency: the index speaks HTTP through `fetch`, as the vector stores do,
 * so it runs wherever `fetch` does. Scores are the engine's own BM25, ranked in the cluster, so only
 * the best matches come back. A `SparseRetriever`, so `hybridRetriever()` fuses it with any vector
 * store. A metadata filter is an exact match on top-level fields, as in the vector stores.
 */
export class ElasticsearchKeywordIndex implements SparseRetriever {
  private readonly base: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: ElasticsearchKeywordIndexOptions) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(options.index)) {
      throw new RangeError(
        `"${options.index}" is not a valid index name: use lowercase letters, digits, ".", "_", and "-"`,
      );
    }
    this.base = options.url.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  /**
   * Creates the index unless it exists: `content` as analyzed text, `id` and `source` as keywords,
   * and every string under `metadata` as a keyword, so a filter matches it exactly. Never runs
   * implicitly.
   */
  async migrate(): Promise<void> {
    const existing = await this.request('HEAD', `/${this.options.index}`, undefined, { allowNotFound: true });
    if (existing !== undefined) return;
    await this.request('PUT', `/${this.options.index}`, {
      mappings: {
        dynamic_templates: [
          {
            metadata_strings: { path_match: 'metadata.*', match_mapping_type: 'string', mapping: { type: 'keyword' } },
          },
        ],
        properties: {
          id: { type: 'keyword' },
          content: { type: 'text', ...(this.options.analyzer ? { analyzer: this.options.analyzer } : {}) },
          source: { type: 'keyword' },
          metadata: { type: 'object', dynamic: true },
        },
      },
    });
  }

  /** Adds chunks, or replaces those whose id exists, in one bulk request. */
  async add(chunks: readonly RagChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    const lines = chunks.flatMap((chunk) => [
      { index: { _index: this.options.index, _id: chunk.id } },
      { id: chunk.id, content: chunk.content, source: chunk.source ?? null, metadata: chunk.metadata ?? null },
    ]);
    await this.bulk(lines);
  }

  /** Removes chunks by id. An id that is not held is ignored. */
  async delete(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.bulk(ids.map((id) => ({ delete: { _index: this.options.index, _id: id } })));
  }

  /** The chunks that best match a query's terms, best first, scored by the engine's BM25. */
  async retrieve(query: string, options: RetrieveOptions = {}): Promise<VectorSearchResult[]> {
    const filter = Object.entries(options.filter ?? {});
    const clauses: unknown[] = [];
    for (const [key, value] of filter) {
      if (value === null) clauses.push({ bool: { must_not: { exists: { field: `metadata.${key}` } } } });
      else if (['string', 'number', 'boolean'].includes(typeof value))
        clauses.push({ term: { [`metadata.${key}`]: value } });
      // An object or a list never equals a stored value exactly, so nothing can match.
      else return [];
    }
    const result = (await this.request(
      'POST',
      `/${this.options.index}/_search`,
      {
        size: options.topK ?? 5,
        query: { bool: { must: [{ match: { content: { query, operator: 'or' } } }], filter: clauses } },
        _source: ['id', 'content', 'source', 'metadata'],
      },
      { signal: options.signal },
    )) as { hits?: { hits?: Hit[] } };
    return (result.hits?.hits ?? []).map((hit) => ({
      id: hit._source?.id ?? hit._id,
      content: hit._source?.content ?? '',
      ...(hit._source?.source ? { source: hit._source.source } : {}),
      ...(hit._source?.metadata ? { metadata: hit._source.metadata } : {}),
      score: hit._score ?? 0,
    }));
  }

  /** Chunks held. */
  async size(): Promise<number> {
    const result = (await this.request('GET', `/${this.options.index}/_count`)) as { count?: number };
    return result.count ?? 0;
  }

  private async bulk(lines: unknown[]): Promise<void> {
    const refresh = this.options.refresh ?? 'wait_for';
    const result = (await this.request(
      'POST',
      `/_bulk${refresh === false ? '' : `?refresh=${refresh === true ? 'true' : 'wait_for'}`}`,
      `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    )) as { errors?: boolean; items?: Array<Record<string, { status?: number; error?: { reason?: string } }>> };
    if (!result.errors) return;
    // A delete of a chunk that is not there answers 404 inside the bulk; that is not an error here.
    const failed = (result.items ?? [])
      .map((item) => Object.entries(item)[0])
      .map((entry) => (entry?.[1]?.error && !(entry[0] === 'delete' && entry[1].status === 404) ? entry[1] : undefined))
      .find((outcome) => outcome !== undefined);
    if (failed)
      throw new ElasticsearchError(
        `A bulk write failed: ${failed.error?.reason ?? 'unknown reason'}`,
        failed.status ?? 500,
      );
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    options: { allowNotFound?: boolean; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    const linked = linkSignals([timeout, options.signal]);
    const ndjson = typeof body === 'string';
    const authorization = this.options.apiKey
      ? `ApiKey ${this.options.apiKey}`
      : this.options.username !== undefined
        ? `Basic ${btoa(`${this.options.username}:${this.options.password ?? ''}`)}`
        : undefined;
    try {
      const response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': ndjson ? 'application/x-ndjson' : 'application/json' }),
          ...(authorization ? { authorization } : {}),
          ...this.options.headers,
        },
        ...(body === undefined ? {} : { body: ndjson ? body : JSON.stringify(body) }),
        signal: linked.signal,
      });
      if (response.status === 404 && options.allowNotFound) return undefined;
      const text = method === 'HEAD' ? '' : await response.text();
      if (!response.ok) {
        throw new ElasticsearchError(
          `Elasticsearch ${method} ${path} failed with ${response.status}`,
          response.status,
          text,
        );
      }
      return text ? JSON.parse(text) : {};
    } finally {
      linked.dispose();
    }
  }
}
