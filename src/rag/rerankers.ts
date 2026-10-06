/**
 * Rerankers: hosted rerank APIs, a self-hosted inference server, and any cross-encoder you run in
 * process. Each is a `Reranker`, so `rerankRetriever()` takes any of them, and none needs an SDK.
 */
import type { VectorSearchResult } from '../hallucination/retrieval.js';
import { linkSignals } from '../utils/signals.js';
import type { Reranker } from './retrievers.js';

/** Raised when a rerank API answers with an error. */
export class RerankerError extends Error {
  constructor(
    message: string,
    /** The HTTP status the API answered with. */
    readonly status: number,
    /** The API's response body, as text. */
    readonly body?: string,
  ) {
    super(message);
    this.name = 'RerankerError';
  }
}

/** What every HTTP reranker takes. */
export interface RerankerHttpOptions {
  /** Replaces the global `fetch`, for a proxy, retries, or tests. */
  fetch?: typeof globalThis.fetch;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /** Aborts a request that takes longer, in milliseconds. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Characters of each chunk sent. Defaults to 4,000. */
  maxChunkCharacters?: number;
}

/** Options for a hosted rerank API. */
export interface HostedRerankerOptions extends RerankerHttpOptions {
  /** The API key. */
  apiKey: string;
  /** The rerank model, such as `rerank-v3.5`. */
  model: string;
  /** Replaces the API's endpoint, for a regional or proxied one. */
  url?: string;
}

/** Options for `httpReranker()`: any rerank API, described by its request and its response. */
export interface HttpRerankerOptions extends RerankerHttpOptions {
  /** The endpoint. */
  url: string;
  /** The request body for a query and its passages. */
  body: (query: string, passages: string[]) => unknown;
  /** Reads the response: each passage's index and score. Passages it leaves out score 0. */
  scores: (response: unknown) => ReadonlyArray<{ index: number; score: number }>;
}

/**
 * A reranker over any HTTP rerank API: you describe the request body and how to read the scores,
 * and it handles the rest — truncation, the timeout, cancellation, errors, and scores put back in
 * the order of the chunks.
 */
export function httpReranker(options: HttpRerankerOptions): Reranker {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const limit = options.maxChunkCharacters ?? 4_000;
  return async (query, chunks, signal) => {
    if (chunks.length === 0) return [];
    const passages = chunks.map((chunk) => chunk.content.slice(0, limit));
    const linked = linkSignals([AbortSignal.timeout(options.timeoutMs ?? 30_000), signal]);
    try {
      const response = await fetchImpl(options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...options.headers },
        body: JSON.stringify(options.body(query, passages)),
        signal: linked.signal,
      });
      const text = await response.text();
      if (!response.ok) throw new RerankerError(`The rerank API answered ${response.status}`, response.status, text);
      const scores = new Array<number>(chunks.length).fill(0);
      for (const { index, score } of options.scores(JSON.parse(text))) {
        if (Number.isInteger(index) && index >= 0 && index < scores.length) scores[index] = Number(score);
      }
      return scores;
    } finally {
      linked.dispose();
    }
  };
}

const bearer = (options: HostedRerankerOptions) => ({ authorization: `Bearer ${options.apiKey}`, ...options.headers });
type Scored = { index: number; relevance_score: number };
const readScored = (list: unknown) =>
  ((list ?? []) as Scored[]).map((item) => ({ index: item.index, score: item.relevance_score }));

/** Cohere's rerank API (`/v2/rerank`), such as `rerank-v3.5`. */
export function cohereReranker(options: HostedRerankerOptions): Reranker {
  return httpReranker({
    ...options,
    url: options.url ?? 'https://api.cohere.com/v2/rerank',
    headers: bearer(options),
    body: (query, documents) => ({ model: options.model, query, documents, top_n: documents.length }),
    scores: (response) => readScored((response as { results?: unknown }).results),
  });
}

/** Voyage AI's rerank API (`/v1/rerank`), such as `rerank-2`. */
export function voyageReranker(options: HostedRerankerOptions): Reranker {
  return httpReranker({
    ...options,
    url: options.url ?? 'https://api.voyageai.com/v1/rerank',
    headers: bearer(options),
    body: (query, documents) => ({ model: options.model, query, documents, top_k: documents.length }),
    scores: (response) => readScored((response as { data?: unknown }).data),
  });
}

/** Jina AI's rerank API (`/v1/rerank`), such as `jina-reranker-v2-base-multilingual`. */
export function jinaReranker(options: HostedRerankerOptions): Reranker {
  return httpReranker({
    ...options,
    url: options.url ?? 'https://api.jina.ai/v1/rerank',
    headers: bearer(options),
    body: (query, documents) => ({ model: options.model, query, documents, top_n: documents.length }),
    scores: (response) => readScored((response as { results?: unknown }).results),
  });
}

/** Options for `teiReranker()`. */
export interface TeiRerankerOptions extends RerankerHttpOptions {
  /** The server, such as `http://localhost:8080`. */
  url: string;
}

/**
 * A cross-encoder served by Hugging Face's text-embeddings-inference, on your own machine or
 * cluster: `docker run ... --model-id BAAI/bge-reranker-base`, then `teiReranker({ url })`. The
 * scores are the model's own, from 0 to 1.
 */
export function teiReranker(options: TeiRerankerOptions): Reranker {
  return httpReranker({
    ...options,
    url: `${options.url.replace(/\/+$/, '')}/rerank`,
    body: (query, texts) => ({ query, texts, raw_scores: false, truncate: true }),
    scores: (response) => response as Array<{ index: number; score: number }>,
  });
}

/**
 * A cross-encoder run in process: one score per (query, passage) pair, higher meaning more relevant.
 * A model from an ONNX runtime or a transformers library fits it in a few lines, so the package
 * depends on neither.
 */
export interface CrossEncoder {
  /** Scores each pair, in order. */
  score(
    pairs: ReadonlyArray<readonly [query: string, passage: string]>,
  ): Promise<readonly number[]> | readonly number[];
}

/** Options for `crossEncoderReranker()`. */
export interface CrossEncoderRerankerOptions {
  /** Pairs scored in one call. Defaults to 32. */
  batchSize?: number;
  /** Characters of each chunk scored. Defaults to 2,000. */
  maxChunkCharacters?: number;
  /** Maps raw logits to 0–1 with a sigmoid, for a model that returns logits. Defaults to false. */
  sigmoid?: boolean;
}

/**
 * A reranker over a cross-encoder you run in process: no network call, no per-query price, and the
 * passages never leave the machine. Pairs are scored in batches, and the run's signal is checked
 * between batches.
 */
export function crossEncoderReranker(model: CrossEncoder, options: CrossEncoderRerankerOptions = {}): Reranker {
  const batchSize = Math.max(1, options.batchSize ?? 32);
  const limit = options.maxChunkCharacters ?? 2_000;
  return async (query: string, chunks: readonly VectorSearchResult[], signal?: AbortSignal) => {
    const pairs = chunks.map((chunk) => [query, chunk.content.slice(0, limit)] as const);
    const scores: number[] = [];
    for (let start = 0; start < pairs.length; start += batchSize) {
      signal?.throwIfAborted();
      const batch = pairs.slice(start, start + batchSize);
      const result = await model.score(batch);
      if (result.length !== batch.length) {
        throw new RangeError(`The cross-encoder returned ${result.length} scores for ${batch.length} pairs`);
      }
      for (const raw of result) scores.push(options.sigmoid ? 1 / (1 + Math.exp(-raw)) : raw);
    }
    return scores;
  };
}
