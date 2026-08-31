export { EmbeddingManager } from './manager.js';
export {
  EmbeddingCapabilityError,
  EmbeddingError,
  EmbeddingModelNotFoundError,
  EmbeddingProviderError,
  EmbeddingProviderNotFoundError,
  EmbeddingProviderResponseError,
  EmbeddingValidationError,
} from './errors.js';
export {
  CohereEmbeddingProvider,
  GoogleEmbeddingProvider,
  MistralEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
  type EmbeddingAdapterOptions,
  type OpenAICompatibleEmbeddingOptions,
} from './adapters.js';
export { MockEmbeddingProvider, type MockEmbeddingProviderOptions } from './mock.js';
export { createConfiguredEmbeddingProviders } from './register.js';
export {
  EMBEDDING_MODEL_ALIASES,
  EMBEDDING_REGISTRY_PROVENANCE,
  KNOWN_EMBEDDING_MODELS,
  embeddingDimensions,
  estimateEmbeddingCost,
  getEmbeddingModelAliases,
  getEmbeddingModelCapabilities,
  getEmbeddingModelRegistry,
  listEmbeddingModels,
  listEmbeddingModelsForProvider,
  priceEmbeddingUsage,
  resolveEmbeddingModel,
  resolveMaxBatchSize,
  type EmbeddingCostEstimateInput,
  type ResolvedEmbeddingModel,
} from './models.js';
export {
  createCohereEmbeddingProvider,
  createGeminiEmbeddingProvider,
  createOpenAIEmbeddingProvider,
  toEmbeddingFunction,
  type CohereEmbeddingOptions,
  type EmbeddingSource,
  type GeminiEmbeddingOptions,
  type OpenAIEmbeddingOptions,
} from './providers.js';
export type {
  Embedding,
  EmbeddingConfig,
  EmbeddingCostBudgetConfig,
  EmbeddingEncodingFormat,
  EmbeddingInput,
  EmbeddingInputType,
  EmbeddingMeta,
  EmbeddingModelCapabilities,
  EmbeddingModelRegistryConfig,
  EmbeddingProviderCallContext,
  EmbeddingProviderCapabilities,
  EmbeddingProviderInfo,
  EmbeddingProviderRequest,
  EmbeddingProviderResult,
  EmbeddingProviderUsage,
  EmbeddingRequest,
  EmbeddingResponse,
  EmbeddingTruncateMode,
  EmbeddingsProvider,
} from '../types/embeddings.js';
