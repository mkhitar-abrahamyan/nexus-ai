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

export interface EmbeddingRequest {
  /** One text or a batch. A batch larger than the model's limit is split automatically. */
  input: EmbeddingInput;
  /** Embedding model or alias. Falls back to the configured default. */
  model?: string;
  /** Registered embedding provider to use. Falls back to the provider that owns the model. */
  provider?: string;
  inputType?: EmbeddingInputType;
  /**
   * Truncate the vector to this many dimensions, on models that support it. Refused when the model
   * declares a fixed size, so a silently mis-sized vector never reaches a vector store.
   */
  dimensions?: number;
  encodingFormat?: EmbeddingEncodingFormat;
  /** Scale each vector to unit length locally when the provider does not already return one. */
  normalize?: boolean;
  truncate?: EmbeddingTruncateMode;
  /** Opaque end-user identifier forwarded to providers that accept one for abuse monitoring. */
  user?: string;
  /** Identity used for rate-limit bucketing and audit events. */
  userId?: string;
  requestId?: string;
  idempotencyKey?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  retry?: RetryConfig;
  /** Overrides the configured cache for this call only. */
  cache?: boolean;
  /** Overrides the configured batch concurrency for this call only. */
  concurrency?: number;
  metadata?: Record<string, unknown>;
  /**
   * Fields merged into the provider request body verbatim.
   *
   * The escape hatch for a provider feature the neutral contract does not model yet. Values are
   * passed through untouched and are never validated.
   */
  providerOptions?: Record<string, unknown>;
}

export interface Embedding {
  /** Position of the source text in the request input. */
  index: number;
  values: number[];
  dimensions: number;
  /** True when the provider reported that the source text was cut to fit the model's limit. */
  truncated?: boolean;
}

export interface EmbeddingMeta {
  requestId: string;
  providerUsed: string;
  modelUsed: string;
  dimensions: number;
  /** Number of vectors returned. */
  count: number;
  latencyMs: number;
  /** Provider calls made, which is more than one when the input was split. */
  batches: number;
  usage: TokenUsage;
  cost: ResponseCost;
  /** True when every input was served from cache and no provider call was made. */
  cacheHit: boolean;
  /** Inputs served from cache when only part of the batch was. */
  cachedInputs?: number;
  /** Duplicate inputs answered from a single provider call. */
  deduplicatedInputs?: number;
  retries?: number;
  routingDecision?: {
    reason: string;
    fallbacksConsidered: number;
  };
}

export interface EmbeddingResponse {
  embeddings: Embedding[];
  /** The vectors alone, in input order. `vectors[0]` is the answer for a single-string call. */
  vectors: number[][];
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
  input: string[];
  model: string;
  inputType?: EmbeddingInputType;
  dimensions?: number;
  encodingFormat?: EmbeddingEncodingFormat;
  truncate?: EmbeddingTruncateMode;
  user?: string;
  providerOptions?: Record<string, unknown>;
}

export interface EmbeddingProviderUsage {
  inputTokens?: number;
  totalTokens?: number;
}

export interface EmbeddingProviderResult {
  /** One vector per input, in the same order. */
  vectors: number[][];
  usage?: EmbeddingProviderUsage;
  /** Concrete model the provider actually used, when it differs from the requested name. */
  model?: string;
  truncated?: boolean;
  raw?: unknown;
}

/**
 * What an adapter can do.
 *
 * An omitted field means unknown, not unsupported, so an adapter is never restricted by a
 * capability it simply did not declare.
 */
export interface EmbeddingProviderCapabilities {
  models?: readonly string[];
  /** Largest number of inputs accepted in one call. */
  maxBatchSize?: number;
  maxInputTokens?: number;
  /** `true` for any size up to the model default, or the exact sizes the provider accepts. */
  dimensions?: boolean | readonly number[];
  inputTypes?: readonly EmbeddingInputType[];
  encodingFormats?: readonly EmbeddingEncodingFormat[];
  truncate?: boolean;
  /** True when the provider already returns unit-length vectors. */
  normalized?: boolean;
}

export interface EmbeddingProviderInfo {
  name: string;
  isLocal?: boolean;
  version?: string;
  /** Model used when the request names none. */
  defaultModel?: string;
  capabilities: EmbeddingProviderCapabilities;
}

export interface EmbeddingProviderCallContext {
  requestId: string;
  signal: AbortSignal;
  /** 1 for the first try; higher on a retry. */
  attempt: number;
  /** Index of this batch within the request, starting at 0. */
  batchIndex: number;
  deadline?: number;
  idempotencyKey?: string;
  traceContext?: Record<string, string>;
}

/**
 * An embeddings adapter.
 *
 * Distinct from the `EmbeddingProvider` function type used by `MemoryVectorStore` and the semantic
 * cache, which stays supported; `toEmbeddingFunction()` converts this contract into that one.
 */
export interface EmbeddingsProvider {
  readonly info: EmbeddingProviderInfo;
  embed(request: EmbeddingProviderRequest, context: EmbeddingProviderCallContext): Promise<EmbeddingProviderResult>;
}

// ── Registry ───────────────────────────────────────────────────────

export interface EmbeddingModelCapabilities {
  provider: string;
  family?: string;
  /** Native vector size. */
  dimensions: number;
  /** Sizes the model can be truncated to, or `true` for any size up to `dimensions`. */
  supportedDimensions?: readonly number[] | true;
  maxInputTokens: number;
  maxBatchSize?: number;
  costPer1kInput: number;
  /** True when the model already returns unit-length vectors. */
  normalized?: boolean;
  inputTypes?: readonly EmbeddingInputType[];
  status?: ModelStatus;
  /** ISO date this entry was last checked against provider documentation. */
  verifiedAt?: string;
  source?: string;
  notes?: string;
}

export interface EmbeddingModelRegistryConfig {
  aliases?: Record<string, string>;
  registry?: Record<string, EmbeddingModelCapabilities>;
  includeDefaults?: boolean;
}

export interface EmbeddingCostBudgetConfig {
  enabled?: boolean;
  maxEstimatedCost?: number;
  onExceeded?: 'error' | 'warn';
}

export interface EmbeddingConfig {
  /** Adapters registered at construction, keyed by the name requests refer to. */
  providers?: Record<string, EmbeddingsProvider>;
  defaultProvider?: string;
  defaultModel?: string;
  /** Tried in order when the primary attempt fails with a retryable error. */
  fallback?: Array<{ provider?: string; model?: string }>;
  models?: EmbeddingModelRegistryConfig;
  /** Per-input result caching. Off unless enabled. */
  cache?: CacheConfig;
  rateLimit?: RateLimitConfig;
  retry?: RetryConfig;
  costBudget?: EmbeddingCostBudgetConfig;
  /** Provider calls run in parallel when the input is split. Defaults to 4. */
  concurrency?: number;
  /** Answer repeated identical inputs from one provider call. Defaults to true. */
  deduplicate?: boolean;
  timeoutMs?: number;
  /**
   * Register adapters for OpenAI, Google, Cohere, Mistral, and Ollama from the provider
   * credentials already in `providers`. Defaults to true, so a configured chat provider makes
   * `embed()` work with no extra setup.
   */
  autoRegisterProviders?: boolean;
}
