import type { CacheConfig, RateLimitConfig, RetryConfig } from './config.js';
import type { ModelStatus } from './providers.js';
import type { ResponseCost, TokenUsage } from './response.js';

/**
 * What the vector will be used for.
 *
 * Several providers return a different vector for the same text depending on whether it is being
 * stored or searched with, and retrieval quality drops when the two are mixed. Providers that make
 * no such distinction ignore this field.
 */
export type EmbeddingInputType = 'document' | 'query' | 'classification' | 'clustering';

/** Wire encoding requested from the provider. Both forms are decoded to `number[]`. */
export type EmbeddingEncodingFormat = 'float' | 'base64';

/** How an input longer than the model's limit is handled. */
export type EmbeddingTruncateMode = 'none' | 'start' | 'end';

/** One or many texts. The single-string form exists so the smallest call stays a one-liner. */
export type EmbeddingInput = string | readonly string[];

/**
 * A request to `ai.embed()`: texts in, vectors out, with routing, batching, caching, and budgets
 * handled for you.
 */
export interface EmbeddingRequest {
  /** One text or a batch. A batch larger than the model's limit is split automatically. */
  input: EmbeddingInput;
  /** Embedding model or alias. Falls back to the configured default. */
  model?: string;
  /** Registered embedding provider to use. Falls back to the provider that owns the model. */
  provider?: string;
  /**
   * What the vectors will be used for. Store documents with `document` and search with `query` on
   * providers that distinguish them.
   */
  inputType?: EmbeddingInputType;
  /**
   * Truncate the vector to this many dimensions, on models that support it. Refused when the model
   * declares a fixed size, so a silently mis-sized vector never reaches a vector store.
   */
  dimensions?: number;
  /**
   * Wire encoding to request. `base64` is smaller on the wire; the result is decoded to numbers
   * either way.
   */
  encodingFormat?: EmbeddingEncodingFormat;
  /** Scale each vector to unit length locally when the provider does not already return one. */
  normalize?: boolean;
  /**
   * What to do with an input longer than the model accepts: refuse it, or cut from the start or the
   * end.
   */
  truncate?: EmbeddingTruncateMode;
  /** Opaque end-user identifier forwarded to providers that accept one for abuse monitoring. */
  user?: string;
  /** Identity used for rate-limit bucketing and audit events. */
  userId?: string;
  /** Identifies the request in records and traces. Generated when omitted. */
  requestId?: string;
  /** Replays an accepted request instead of paying for it twice. */
  idempotencyKey?: string;
  /** Aborts the request and any batches still running. */
  signal?: AbortSignal;
  /** Timeout per provider call, in milliseconds. */
  timeoutMs?: number;
  /** Retries for this call, overriding the configured policy. */
  retry?: RetryConfig;
  /** Overrides the configured cache for this call only. */
  cache?: boolean;
  /** Overrides the configured batch concurrency for this call only. */
  concurrency?: number;
  /** Application data carried through to records and audit events. */
  metadata?: Record<string, unknown>;
  /**
   * Fields merged into the provider request body verbatim.
   *
   * The escape hatch for a provider feature the neutral contract does not model yet. Values are
   * passed through untouched and are never validated.
   */
  providerOptions?: Record<string, unknown>;
}

/** One vector. */
export interface Embedding {
  /** Position of the source text in the request input. */
  index: number;
  /** The vector's components. */
  values: number[];
  /** Its length. */
  dimensions: number;
  /** True when the provider reported that the source text was cut to fit the model's limit. */
  truncated?: boolean;
}

/** How an embedding request ran. */
export interface EmbeddingMeta {
  /** The request's id. */
  requestId: string;
  /** Provider that served it. */
  providerUsed: string;
  /** Model that served it. */
  modelUsed: string;
  /** Length of every vector returned. */
  dimensions: number;
  /** Number of vectors returned. */
  count: number;
  /** Duration in milliseconds. */
  latencyMs: number;
  /** Provider calls made, which is more than one when the input was split. */
  batches: number;
  /** Tokens consumed. */
  usage: TokenUsage;
  /** What it cost, from the model's price. */
  cost: ResponseCost;
  /** True when every input was served from cache and no provider call was made. */
  cacheHit: boolean;
  /** Inputs served from cache when only part of the batch was. */
  cachedInputs?: number;
  /** Duplicate inputs answered from a single provider call. */
  deduplicatedInputs?: number;
  /** Retries across all batches. */
  retries?: number;
  /** Why the router chose the provider, and how many fallbacks were available. */
  routingDecision?: {
    reason: string;
    fallbacksConsidered: number;
  };
}

/** The result of `ai.embed()`. */
export interface EmbeddingResponse {
  /** Each vector with its position and size. */
  embeddings: Embedding[];
  /** The vectors alone, in input order. `vectors[0]` is the answer for a single-string call. */
  vectors: number[][];
  /** How the request ran. */
  meta: EmbeddingMeta;
  /** Raw provider payload of the last batch, when the provider supplies one. */
  raw?: unknown;
}

// ── Provider contract ──────────────────────────────────────────────

/**
 * Request handed to an adapter.
 *
 * Aliases, batching, deduplication, and caching are already resolved: `input` is a concrete batch
 * within the model's limits and `model` is a concrete provider model name.
 */
export interface EmbeddingProviderRequest {
  /** A concrete batch of texts, already within the model's limits. */
  input: string[];
  /** The provider's own model name. */
  model: string;
  /** What the vectors will be used for. */
  inputType?: EmbeddingInputType;
  /** Vector size to return, on models that can shorten theirs. */
  dimensions?: number;
  /** Wire encoding to request. */
  encodingFormat?: EmbeddingEncodingFormat;
  /** What to do with an input that is too long. */
  truncate?: EmbeddingTruncateMode;
  /** End-user identifier, for providers that monitor abuse. */
  user?: string;
  /** Fields merged into the provider request body verbatim. */
  providerOptions?: Record<string, unknown>;
}

/** Token usage an adapter reports. */
export interface EmbeddingProviderUsage {
  /** Input tokens. */
  inputTokens?: number;
  /** Total tokens, when the provider reports it separately. */
  totalTokens?: number;
}

/** What an adapter returns for one batch. */
export interface EmbeddingProviderResult {
  /** One vector per input, in the same order. */
  vectors: number[][];
  /** Token usage, when the provider reports it. */
  usage?: EmbeddingProviderUsage;
  /** Concrete model the provider actually used, when it differs from the requested name. */
  model?: string;
  /** True when the provider cut any input to fit. */
  truncated?: boolean;
  /** The provider's response, unmodified. */
  raw?: unknown;
}

/**
 * What an adapter can do.
 *
 * An omitted field means unknown, not unsupported, so an adapter is never restricted by a
 * capability it simply did not declare.
 */
export interface EmbeddingProviderCapabilities {
  /** Models the adapter serves. */
  models?: readonly string[];
  /** Largest number of inputs accepted in one call. */
  maxBatchSize?: number;
  /** Longest input the adapter accepts, in tokens. */
  maxInputTokens?: number;
  /** `true` for any size up to the model default, or the exact sizes the provider accepts. */
  dimensions?: boolean | readonly number[];
  /** Input types the provider distinguishes. */
  inputTypes?: readonly EmbeddingInputType[];
  /** Wire encodings it supports. */
  encodingFormats?: readonly EmbeddingEncodingFormat[];
  /** Whether it can truncate long inputs itself. */
  truncate?: boolean;
  /** True when the provider already returns unit-length vectors. */
  normalized?: boolean;
}

/** Identifies an embeddings adapter and what it supports. */
export interface EmbeddingProviderInfo {
  /** The adapter's registered name. */
  name: string;
  /** True for an adapter that runs locally, such as Ollama. */
  isLocal?: boolean;
  /** The adapter's version. */
  version?: string;
  /** Model used when the request names none. */
  defaultModel?: string;
  /** What it supports. */
  capabilities: EmbeddingProviderCapabilities;
}

/** What an adapter receives with every batch besides the request. */
export interface EmbeddingProviderCallContext {
  /** The request's id. */
  requestId: string;
  /** Aborted when the request is cancelled or times out. */
  signal: AbortSignal;
  /** 1 for the first try; higher on a retry. */
  attempt: number;
  /** Index of this batch within the request, starting at 0. */
  batchIndex: number;
  /** Epoch milliseconds by which the call must finish. */
  deadline?: number;
  /** Passed to providers that deduplicate requests themselves. */
  idempotencyKey?: string;
  /** Trace propagation headers, for providers that accept them. */
  traceContext?: Record<string, string>;
}

/**
 * An embeddings adapter.
 *
 * Distinct from the `EmbeddingProvider` function type used by `MemoryVectorStore` and the semantic
 * cache, which stays supported; `toEmbeddingFunction()` converts this contract into that one.
 */
export interface EmbeddingsProvider {
  /** What the adapter is and what it supports. */
  readonly info: EmbeddingProviderInfo;
  /** Embeds one batch. */
  embed(request: EmbeddingProviderRequest, context: EmbeddingProviderCallContext): Promise<EmbeddingProviderResult>;
}

// ── Registry ───────────────────────────────────────────────────────

/** What the registry knows about an embedding model. */
export interface EmbeddingModelCapabilities {
  /** Provider that serves it. */
  provider: string;
  /** Model family, for grouping versions. */
  family?: string;
  /** Native vector size. */
  dimensions: number;
  /** Sizes the model can be truncated to, or `true` for any size up to `dimensions`. */
  supportedDimensions?: readonly number[] | true;
  /** Longest input it accepts, in tokens. */
  maxInputTokens: number;
  /** Most inputs per call. */
  maxBatchSize?: number;
  /** Price per 1,000 input tokens, in US dollars. */
  costPer1kInput: number;
  /** True when the model already returns unit-length vectors. */
  normalized?: boolean;
  /** Input types the model distinguishes. */
  inputTypes?: readonly EmbeddingInputType[];
  /** Lifecycle status: `stable`, `preview`, `latest`, or `deprecated`. */
  status?: ModelStatus;
  /** ISO date this entry was last checked against provider documentation. */
  verifiedAt?: string;
  /** Where the entry's details were checked. */
  source?: string;
  /** Anything else worth knowing about the model. */
  notes?: string;
}

/** Embedding models and aliases that extend or replace the bundled registry. */
export interface EmbeddingModelRegistryConfig {
  /** Alias names mapped to concrete models. */
  aliases?: Record<string, string>;
  /** Model entries, by name. */
  registry?: Record<string, EmbeddingModelCapabilities>;
  /** Keeps the bundled entries beside yours. Defaults to true. */
  includeDefaults?: boolean;
}

/** Refuses or flags an embedding request whose estimated cost exceeds a limit. */
export interface EmbeddingCostBudgetConfig {
  /** Turns the budget check on. */
  enabled?: boolean;
  /** Most a request may cost, in US dollars. */
  maxEstimatedCost?: number;
  /** `error` refuses the request; `warn` sends it and reports the overrun. */
  onExceeded?: 'error' | 'warn';
}

/** Configuration for `ai.embed()`. */
export interface EmbeddingConfig {
  /** Adapters registered at construction, keyed by the name requests refer to. */
  providers?: Record<string, EmbeddingsProvider>;
  /** Adapter used when a request names neither a provider nor a model it owns. */
  defaultProvider?: string;
  /** Model used when a request names none. */
  defaultModel?: string;
  /** Tried in order when the primary attempt fails with a retryable error. */
  fallback?: Array<{ provider?: string; model?: string }>;
  /** Embedding models and aliases beyond the bundled ones. */
  models?: EmbeddingModelRegistryConfig;
  /** Per-input result caching. Off unless enabled. */
  cache?: CacheConfig;
  /** Rate limiting for embedding calls. */
  rateLimit?: RateLimitConfig;
  /** Retries for failed embedding calls. */
  retry?: RetryConfig;
  /** Cost budget checked before each request. */
  costBudget?: EmbeddingCostBudgetConfig;
  /** Provider calls run in parallel when the input is split. Defaults to 4. */
  concurrency?: number;
  /** Answer repeated identical inputs from one provider call. Defaults to true. */
  deduplicate?: boolean;
  /** Timeout per provider call, in milliseconds. */
  timeoutMs?: number;
  /**
   * Register adapters for OpenAI, Google, Cohere, Mistral, and Ollama from the provider
   * credentials already in `providers`. Defaults to true, so a configured chat provider makes
   * `embed()` work with no extra setup.
   */
  autoRegisterProviders?: boolean;
}
