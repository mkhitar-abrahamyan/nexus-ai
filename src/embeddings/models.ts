import type { CostEstimate } from '../types/planning.js';
import type {
  EmbeddingModelCapabilities,
  EmbeddingModelRegistryConfig,
  EmbeddingsProvider,
} from '../types/embeddings.js';
import type { ResponseCost, TokenUsage } from '../types/response.js';
import { DEFAULT_CURRENCY, formatCost } from '../optimizer/cost.js';

/**
 * Default provenance for bundled embedding entries.
 *
 * Bundled dimensions and prices are defaults, not financial truth. Override them through
 * `embeddings.models.registry` when exact numbers matter.
 */
export const EMBEDDING_REGISTRY_PROVENANCE = {
  verifiedAt: '2026-08-31',
  source: 'provider documentation',
} as const;

function embeddingModel(capabilities: EmbeddingModelCapabilities): EmbeddingModelCapabilities {
  return capabilities;
}

/**
 * Embedding models known to the runtime.
 *
 * Deliberately separate from `KNOWN_MODELS`: completion routing scores models on context window,
 * output price, and tool support, none of which an embedding model has. Mixing the two would make
 * every completion route consider models that cannot answer a chat request.
 */
export const KNOWN_EMBEDDING_MODELS: Record<string, EmbeddingModelCapabilities> = {
  'text-embedding-3-small': embeddingModel({
    provider: 'openai',
    family: 'text-embedding-3',
    dimensions: 1536,
    supportedDimensions: true,
    maxInputTokens: 8191,
    maxBatchSize: 2048,
    costPer1kInput: 0.00002,
    inputTypes: [],
    status: 'stable',
  }),
  'text-embedding-3-large': embeddingModel({
    provider: 'openai',
    family: 'text-embedding-3',
    dimensions: 3072,
    supportedDimensions: true,
    maxInputTokens: 8191,
    maxBatchSize: 2048,
    costPer1kInput: 0.00013,
    inputTypes: [],
    status: 'stable',
  }),
  'text-embedding-ada-002': embeddingModel({
    provider: 'openai',
    family: 'ada',
    dimensions: 1536,
    maxInputTokens: 8191,
    maxBatchSize: 2048,
    costPer1kInput: 0.0001,
    inputTypes: [],
    status: 'deprecated',
    notes: 'Superseded by text-embedding-3-small at a fifth of the price.',
  }),
  'gemini-embedding-001': embeddingModel({
    provider: 'google',
    family: 'gemini-embedding',
    dimensions: 3072,
    supportedDimensions: [128, 256, 512, 768, 1536, 3072],
    maxInputTokens: 2048,
    maxBatchSize: 100,
    costPer1kInput: 0.00015,
    inputTypes: ['document', 'query', 'classification', 'clustering'],
    status: 'stable',
  }),
  'text-embedding-004': embeddingModel({
    provider: 'google',
    family: 'text-embedding',
    dimensions: 768,
    maxInputTokens: 2048,
    maxBatchSize: 100,
    costPer1kInput: 0,
    inputTypes: ['document', 'query', 'classification', 'clustering'],
    status: 'stable',
    notes: 'Not separately priced on the free tier; set a price through embeddings.models.registry when billed.',
  }),
  'embed-v4.0': embeddingModel({
    provider: 'cohere',
    family: 'embed-v4',
    dimensions: 1536,
    supportedDimensions: [256, 512, 1024, 1536],
    maxInputTokens: 128000,
    maxBatchSize: 96,
    costPer1kInput: 0.00012,
    normalized: true,
    inputTypes: ['document', 'query', 'classification', 'clustering'],
    status: 'stable',
  }),
  'embed-english-v3.0': embeddingModel({
    provider: 'cohere',
    family: 'embed-v3',
    dimensions: 1024,
    maxInputTokens: 512,
    maxBatchSize: 96,
    costPer1kInput: 0.0001,
    normalized: true,
    inputTypes: ['document', 'query', 'classification', 'clustering'],
    status: 'stable',
  }),
  'embed-multilingual-v3.0': embeddingModel({
    provider: 'cohere',
    family: 'embed-v3',
    dimensions: 1024,
    maxInputTokens: 512,
    maxBatchSize: 96,
    costPer1kInput: 0.0001,
    normalized: true,
    inputTypes: ['document', 'query', 'classification', 'clustering'],
    status: 'stable',
  }),
  'mistral-embed': embeddingModel({
    provider: 'mistral',
    family: 'mistral-embed',
    dimensions: 1024,
    maxInputTokens: 8000,
    maxBatchSize: 128,
    costPer1kInput: 0.0001,
    inputTypes: [],
    status: 'stable',
  }),
  'nomic-embed-text': embeddingModel({
    provider: 'ollama',
    family: 'nomic-embed',
    dimensions: 768,
    maxInputTokens: 8192,
    maxBatchSize: 64,
    costPer1kInput: 0,
    inputTypes: [],
    status: 'stable',
    notes: 'Runs locally through Ollama, so no per-token charge applies.',
  }),
  'mxbai-embed-large': embeddingModel({
    provider: 'ollama',
    family: 'mxbai-embed',
    dimensions: 1024,
    maxInputTokens: 512,
    maxBatchSize: 64,
    costPer1kInput: 0,
    inputTypes: [],
    status: 'stable',
    notes: 'Runs locally through Ollama, so no per-token charge applies.',
  }),
};

/**
 * Stable names that resolve to a concrete embedding model.
 *
 * An alias is the durable API: changing which model `embed-quality` points at is a registry
 * change, but the vectors it produced are not interchangeable, so a stored index must be rebuilt
 * whenever the target moves. Pin the concrete model when that matters.
 */
export const EMBEDDING_MODEL_ALIASES: Record<string, string> = {
  auto: 'text-embedding-3-small',
  'embed-fast': 'text-embedding-3-small',
  'embed-quality': 'text-embedding-3-large',
  'embed-multilingual': 'embed-multilingual-v3.0',
  'embed-local': 'nomic-embed-text',
};

export interface ResolvedEmbeddingModel {
  requestedModel: string;
  model: string;
  providerName: string | null;
  capabilities?: EmbeddingModelCapabilities;
}

export function getEmbeddingModelRegistry(
  config?: EmbeddingModelRegistryConfig,
): Record<string, EmbeddingModelCapabilities> {
  return {
    ...(config?.includeDefaults === false ? {} : KNOWN_EMBEDDING_MODELS),
    ...(config?.registry || {}),
  };
}

export function getEmbeddingModelAliases(config?: EmbeddingModelRegistryConfig): Record<string, string> {
  return {
    ...EMBEDDING_MODEL_ALIASES,
    ...(config?.aliases || {}),
  };
}

/**
 * Resolves an alias and looks up embedding model capabilities.
 *
 * Runs on every `embed()` call, so it reads the bundled and application maps directly instead of
 * merging them into a new object first.
 */
export function resolveEmbeddingModel(model: string, config?: EmbeddingModelRegistryConfig): ResolvedEmbeddingModel {
  const resolved = config?.aliases?.[model] || EMBEDDING_MODEL_ALIASES[model] || model;
  const normalized = resolved.includes('/') ? resolved.slice(resolved.indexOf('/') + 1) : resolved;
  const custom = config?.registry;
  const bundled = config?.includeDefaults === false ? undefined : KNOWN_EMBEDDING_MODELS;
  const capabilities =
    custom?.[resolved] || custom?.[normalized] || bundled?.[resolved] || bundled?.[normalized] || undefined;

  return {
    requestedModel: model,
    model: resolved,
    providerName: capabilities?.provider || (resolved.includes('/') ? resolved.slice(0, resolved.indexOf('/')) : null),
    capabilities,
  };
}

export function listEmbeddingModels(config?: EmbeddingModelRegistryConfig): string[] {
  return Object.keys(getEmbeddingModelRegistry(config)).sort();
}

export function listEmbeddingModelsForProvider(providerName: string, config?: EmbeddingModelRegistryConfig): string[] {
  return Object.entries(getEmbeddingModelRegistry(config))
    .filter(([, capabilities]) => capabilities.provider === providerName)
    .map(([model]) => model)
    .sort();
}

export function getEmbeddingModelCapabilities(
  model: string,
  config?: EmbeddingModelRegistryConfig,
): EmbeddingModelCapabilities | undefined {
  return resolveEmbeddingModel(model, config).capabilities;
}

export interface EmbeddingCostEstimateInput {
  model: string;
  inputTokens: number;
  config?: EmbeddingModelRegistryConfig;
}

/**
 * Prices embedding input tokens.
 *
 * Embeddings bill on input only, so the shared `CostEstimate` shape is filled with a zero output
 * line rather than a different structure that callers would have to special-case.
 */
export function estimateEmbeddingCost(input: EmbeddingCostEstimateInput): CostEstimate {
  const resolved = resolveEmbeddingModel(input.model, input.config);
  const inputCost = resolved.capabilities ? (input.inputTokens / 1000) * resolved.capabilities.costPer1kInput : 0;

  return {
    model: resolved.model,
    inputTokens: input.inputTokens,
    outputTokens: 0,
    inputCost,
    outputCost: 0,
    totalCost: inputCost,
    currency: DEFAULT_CURRENCY,
    formatted: formatCost(inputCost),
  };
}

export function priceEmbeddingUsage(
  model: string,
  usage: TokenUsage,
  config?: EmbeddingModelRegistryConfig,
): ResponseCost {
  const estimate = estimateEmbeddingCost({ model, inputTokens: usage.inputTokens, config });
  return {
    amount: estimate.totalCost,
    currency: estimate.currency || DEFAULT_CURRENCY,
    basis: 'estimated',
    input: estimate.inputCost,
    output: 0,
  };
}

/**
 * Vector size a model produces, honoring a requested truncation.
 *
 * Returns `undefined` when the model is unknown, so a caller can fall back to the size the
 * provider actually returned rather than asserting one.
 */
export function embeddingDimensions(
  capabilities: EmbeddingModelCapabilities | undefined,
  requested?: number,
): number | undefined {
  if (requested !== undefined) return requested;
  return capabilities?.dimensions;
}

/**
 * Largest batch the model and adapter both accept.
 *
 * The smaller of the two wins, and an undeclared limit means no limit, so an application-registered
 * model is never split more finely than it needs to be.
 */
export function resolveMaxBatchSize(
  capabilities: EmbeddingModelCapabilities | undefined,
  provider: EmbeddingsProvider,
): number {
  const limits = [capabilities?.maxBatchSize, provider.info.capabilities.maxBatchSize].filter(
    (value): value is number => typeof value === 'number' && value > 0,
  );
  return limits.length ? Math.min(...limits) : Number.POSITIVE_INFINITY;
}
