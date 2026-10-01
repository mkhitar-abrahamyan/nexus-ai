export { NexusAI } from './core/nexus.js';
export {
  createNexus,
  normalizeCreateNexusConfig,
  type CreateNexusOptions,
  type CreateNexusProvider,
} from './core/create-nexus.js';
export {
  NexusConfigBuilder,
  createNexusConfig,
  defineNexusConfig,
} from './core/config-builder.js';
export { collectStream, mapStream, createTextStream } from './core/streaming.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/next'; the 2.0 root drops it. */
  createNexusRouteHandler,
} from './next/route-handler.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  getModelRegistry,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  getModelAliases,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  getAliasMetadata,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  resolveModel,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  resolveModelAlias,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  listKnownModels,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  listModelsForProvider,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  getModelCapabilities,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  describeModel,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  checkRegistryFreshness,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  assertRegistryFreshness,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  type ModelProvenance,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  type RegistryFreshness,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  type ResolvedModel,
} from './models/registry.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/capabilities'; the 2.0 root drops it. */
  negotiateCompletionRequest,
  NexusCapabilityError,
  /** @deprecated Import from 'nexus-ai-pro/capabilities'; the 2.0 root drops it. */
  type NegotiateOptions,
  /** @deprecated Import from 'nexus-ai-pro/capabilities'; the 2.0 root drops it. */
  type NegotiationResult,
} from './capabilities/negotiate.js';
export {
  buildMeta,
  buildUsage,
  costAmount,
  ensureUsageAndCost,
  priceUsage,
  type BuildMetaOptions,
  type PriceUsageOptions,
  type UsageInput,
} from './core/usage.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/cache/memory-cache'; the 2.0 root drops it. */
  MemoryCache,
  /** @deprecated Import from 'nexus-ai-pro/cache/memory-cache'; the 2.0 root drops it. */
  createCacheKey,
} from './cache/memory-cache.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/cache/adapters'; the 2.0 root drops it. */
  MemoryCacheAdapter,
  /** @deprecated Import from 'nexus-ai-pro/cache/adapters'; the 2.0 root drops it. */
  RedisCacheAdapter,
  /** @deprecated Import from 'nexus-ai-pro/cache/adapters'; the 2.0 root drops it. */
  SQLiteCacheAdapter,
  /** @deprecated Import from 'nexus-ai-pro/cache/adapters'; the 2.0 root drops it. */
  type CacheAdapter,
  /** @deprecated Import from 'nexus-ai-pro/cache/adapters'; the 2.0 root drops it. */
  type RedisLikeClient,
  /** @deprecated Import from 'nexus-ai-pro/cache/adapters'; the 2.0 root drops it. */
  type SQLiteLikeDatabase,
} from './cache/adapters.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/cache/semantic-cache'; the 2.0 root drops it. */
  SemanticCache,
  /** @deprecated Import from 'nexus-ai-pro/cache/semantic-cache'; the 2.0 root drops it. */
  type SemanticCacheOptions,
} from './cache/semantic-cache.js';
export { ResponseFormatError } from './core/response-format.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/context'; the 2.0 root drops it. */
  ContextWindowManager,
  /** @deprecated Import from 'nexus-ai-pro/context'; the 2.0 root drops it. */
  type ContextWindowRuntime,
} from './context/index.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceManager,
  /** @deprecated Import from 'nexus-ai-pro/voice/session'; the 2.0 root drops it. */
  VoiceSession,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceProviderError,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceCapabilityError,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  type VoiceCompletionClient,
  /** @deprecated Import from 'nexus-ai-pro/voice/session'; the 2.0 root drops it. */
  type VoiceSessionCompletionClient,
  /** @deprecated Import from 'nexus-ai-pro/voice/session'; the 2.0 root drops it. */
  type VoiceSessionRuntime,
} from './voice/index.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationRunner,
} from './operations/runner.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  LocalOperationHandle,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  describeOperationError,
} from './operations/handle.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  MemoryOperationStore,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  assertSerializableRecord,
} from './operations/store.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/operations/adapters'; the 2.0 root drops it. */
  BullMQOperationDispatcher,
  /** @deprecated Import from 'nexus-ai-pro/operations/adapters'; the 2.0 root drops it. */
  RedisOperationStore,
  /** @deprecated Import from 'nexus-ai-pro/operations/adapters'; the 2.0 root drops it. */
  type BullMQLikeOperationQueue,
  /** @deprecated Import from 'nexus-ai-pro/operations/adapters'; the 2.0 root drops it. */
  type RedisOperationLikeClient,
} from './operations/adapters.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/operations/webhooks'; the 2.0 root drops it. */
  OPERATION_WEBHOOK_SIGNATURE_HEADER,
  /** @deprecated Import from 'nexus-ai-pro/operations/webhooks'; the 2.0 root drops it. */
  deliverOperationWebhook,
  /** @deprecated Import from 'nexus-ai-pro/operations/webhooks'; the 2.0 root drops it. */
  signOperationWebhook,
  /** @deprecated Import from 'nexus-ai-pro/operations/webhooks'; the 2.0 root drops it. */
  verifyOperationWebhook,
} from './operations/webhooks.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  TERMINAL_OPERATION_STATUSES,
} from './types/operations.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  allowedTransitions,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  assertTransition,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  canTransition,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  isClaimable,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  isSettled,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  isTerminalOperationStatus,
} from './operations/state-machine.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationCancelledError,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationConflictError,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationDuplicateError,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationError,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationExpiredError,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationLeaseLostError,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationNotFoundError,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationReleasedError,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationSerializationError,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationTransitionError,
} from './operations/errors.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchManager,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  type BatchManagerRuntime,
} from './batch/manager.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchCapabilityError,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchError,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchProviderError,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchProviderNotFoundError,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchProviderResponseError,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchValidationError,
} from './batch/errors.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  TERMINAL_BATCH_STATUSES,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  isTerminalBatchStatus,
} from './types/batch.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageManager,
} from './images/manager.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageCapabilityError,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageError,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageOperationCancelledError,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageProviderError,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageProviderNotFoundError,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageProviderResponseError,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageSafetyError,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageValidationError,
} from './images/errors.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyManager,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyProviderError,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyCapabilityError,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  createVoiceTwiML,
} from './telephony/index.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  hardenPrompt,
} from './security/prompt-hardening.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  RateLimiter,
  NexusRateLimitError,
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  type RateLimitedRequest,
} from './ops/rate-limiter.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  AuditLogger,
} from './ops/audit-logger.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  FamilyTelemetry,
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  type FamilyCallDescriptor,
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  type FamilyRuntime,
} from './ops/family-telemetry.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  MetricsCollector,
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  InMemoryMetrics,
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  OpenTelemetryMetricsSink,
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  type MetricsConfig,
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  type MetricsSink,
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  type OpenTelemetryLikeMeter,
} from './ops/metrics.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  ProviderHealthMonitor,
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  type HealthConfig,
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  type ProviderHealthSnapshot,
} from './ops/health.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/ops/circuit-breaker'; the 2.0 root drops it. */
  CircuitBreaker,
  /** @deprecated Import from 'nexus-ai-pro/ops/circuit-breaker'; the 2.0 root drops it. */
  type CircuitBreakerConfig,
  /** @deprecated Import from 'nexus-ai-pro/ops/circuit-breaker'; the 2.0 root drops it. */
  type CircuitSnapshot,
  /** @deprecated Import from 'nexus-ai-pro/ops/circuit-breaker'; the 2.0 root drops it. */
  type CircuitState,
  /** @deprecated Import from 'nexus-ai-pro/ops/circuit-breaker'; the 2.0 root drops it. */
  type CircuitStateChange,
  /** @deprecated Import from 'nexus-ai-pro/ops/circuit-breaker'; the 2.0 root drops it. */
  type CircuitStateStore,
  /** @deprecated Import from 'nexus-ai-pro/ops/circuit-breaker'; the 2.0 root drops it. */
  type SharedCircuitState,
} from './ops/circuit-breaker.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/ops/rate-limit-adapters'; the 2.0 root drops it. */
  MemoryRateLimitStore,
  /** @deprecated Import from 'nexus-ai-pro/ops/rate-limit-adapters'; the 2.0 root drops it. */
  RedisRateLimitStore,
  /** @deprecated Import from 'nexus-ai-pro/ops/rate-limit-adapters'; the 2.0 root drops it. */
  type RateLimitHit,
  /** @deprecated Import from 'nexus-ai-pro/ops/rate-limit-adapters'; the 2.0 root drops it. */
  type RateLimitStore,
  /** @deprecated Import from 'nexus-ai-pro/ops/rate-limit-adapters'; the 2.0 root drops it. */
  type RedisRateLimitLikeClient,
  /** @deprecated Import from 'nexus-ai-pro/ops/rate-limit-adapters'; the 2.0 root drops it. */
  type RedisRateLimitStoreOptions,
} from './ops/rate-limit-adapters.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/pipeline'; the 2.0 root drops it. */
  PipelineRunner,
  /** @deprecated Import from 'nexus-ai-pro/pipeline'; the 2.0 root drops it. */
  createPipelineContext,
} from './pipeline/pipeline.js';
export type {
  /** @deprecated Import from 'nexus-ai-pro/pipeline'; the 2.0 root drops it. */
  PipelineConfig,
  /** @deprecated Import from 'nexus-ai-pro/pipeline'; the 2.0 root drops it. */
  PipelineContext,
  /** @deprecated Import from 'nexus-ai-pro/pipeline'; the 2.0 root drops it. */
  PipelineHookName,
  /** @deprecated Import from 'nexus-ai-pro/pipeline'; the 2.0 root drops it. */
  PipelineHooksConfig,
  /** @deprecated Import from 'nexus-ai-pro/pipeline'; the 2.0 root drops it. */
  PipelineMiddleware,
  /** @deprecated Import from 'nexus-ai-pro/pipeline'; the 2.0 root drops it. */
  PipelineStep,
  /** @deprecated Import from 'nexus-ai-pro/pipeline'; the 2.0 root drops it. */
  PipelineStepName,
  /** @deprecated Import from 'nexus-ai-pro/pipeline'; the 2.0 root drops it. */
  PipelineTrace,
  /** @deprecated Import from 'nexus-ai-pro/pipeline'; the 2.0 root drops it. */
  PipelineTraceStep,
} from './pipeline/types.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  withFactualDefaults,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  asJsonOnly,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  type FactualOptions,
} from './hallucination/factual.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  withRagContext,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  extractCitations,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  validateCitations,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  type RagChunk,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  type RagOptions,
} from './hallucination/rag.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/rag'; the 2.0 root drops it. */
  MemoryVectorStore,
  /** @deprecated Import from 'nexus-ai-pro/rag'; the 2.0 root drops it. */
  createHashEmbeddings,
  /** @deprecated Import from 'nexus-ai-pro/rag'; the 2.0 root drops it. */
  cosineSimilarity,
  /** @deprecated Import from 'nexus-ai-pro/rag'; the 2.0 root drops it. */
  matchesMetadata,
  /** @deprecated Import from 'nexus-ai-pro/rag'; the 2.0 root drops it. */
  normalizeVector,
  /** @deprecated Import from 'nexus-ai-pro/rag'; the 2.0 root drops it. */
  type EmbeddingProvider,
  /** @deprecated Import from 'nexus-ai-pro/rag'; the 2.0 root drops it. */
  type VectorDocument,
  /** @deprecated Import from 'nexus-ai-pro/rag'; the 2.0 root drops it. */
  type VectorSearchOptions,
  /** @deprecated Import from 'nexus-ai-pro/rag'; the 2.0 root drops it. */
  type VectorSearchResult,
  /** @deprecated Import from 'nexus-ai-pro/rag'; the 2.0 root drops it. */
  type VectorStore,
} from './hallucination/retrieval.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  withKnowledgeGraphContext,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  selectGraphFacts,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  type KnowledgeGraph,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  type KnowledgeGraphEdge,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  type KnowledgeGraphNode,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  type KnowledgeGraphOptions,
} from './hallucination/knowledge-graph.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  completeVerified,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  verifyAgainstContext,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  extractFacts,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  lexicalEntailment,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  type NliVerifier,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  type VerificationClient,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  type VerificationFact,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  type VerificationOptions,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  type VerificationReport,
} from './hallucination/verification.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  completeWithSelfConsistency,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  selectMostConsistent,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  textSimilarity,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  type ConsistencyClient,
  /** @deprecated Import from 'nexus-ai-pro/grounding'; the 2.0 root drops it. */
  type SelfConsistencyOptions,
} from './hallucination/consistency.js';

export {
  /** @deprecated Import from 'nexus-ai-pro/providers/base'; the 2.0 root drops it. */
  BaseProvider,
  NexusProviderError,
  /** @deprecated Import from 'nexus-ai-pro/providers/errors'; the 2.0 root drops it. */
  type NexusProviderErrorCategory,
  /** @deprecated Import from 'nexus-ai-pro/providers/errors'; the 2.0 root drops it. */
  type NexusProviderErrorOptions,
  /** @deprecated Import from 'nexus-ai-pro/providers/base'; the 2.0 root drops it. */
  type ProviderInfo,
} from './providers/base.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/providers/openai'; the 2.0 root drops it. */
  OpenAIProvider,
} from './providers/openai.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/providers/anthropic'; the 2.0 root drops it. */
  AnthropicProvider,
} from './providers/anthropic.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/providers/google'; the 2.0 root drops it. */
  GoogleProvider,
} from './providers/google.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/providers/ollama'; the 2.0 root drops it. */
  OllamaProvider,
} from './providers/ollama.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/providers/openrouter'; the 2.0 root drops it. */
  OpenRouterProvider,
} from './providers/openrouter.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/providers/groq'; the 2.0 root drops it. */
  GroqProvider,
} from './providers/groq.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/providers/mistral'; the 2.0 root drops it. */
  MistralProvider,
} from './providers/mistral.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/providers/cohere'; the 2.0 root drops it. */
  CohereProvider,
} from './providers/cohere.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/providers/deepseek'; the 2.0 root drops it. */
  DeepSeekProvider,
} from './providers/deepseek.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/providers/azure-openai'; the 2.0 root drops it. */
  AzureOpenAIProvider,
} from './providers/azure-openai.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/providers/lmstudio'; the 2.0 root drops it. */
  LMStudioProvider,
} from './providers/lmstudio.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/providers/llamacpp'; the 2.0 root drops it. */
  LlamaCppProvider,
} from './providers/llamacpp.js';

export {
  /** @deprecated Import from 'nexus-ai-pro/router'; the 2.0 root drops it. */
  Router,
  /** @deprecated Import from 'nexus-ai-pro/router'; the 2.0 root drops it. */
  FailoverExecutor,
  /** @deprecated Import from 'nexus-ai-pro/router'; the 2.0 root drops it. */
  type RouteDecision,
  /** @deprecated Import from 'nexus-ai-pro/router'; the 2.0 root drops it. */
  type RouterContext,
} from './router/index.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  SecurityPipeline,
  NexusSecurityError,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  SchemaValidator,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  InjectionDetector,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  PIIDetector,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  OutputGuard,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  InputGuard,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  SemanticInjectionClassifier,
} from './security/index.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  guardrailPolicy,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  GUARDRAIL_POLICIES,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  type GuardrailPolicyName,
} from './security/policies.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  SEMANTIC_INJECTION_CALIBRATION_SET,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  calibrateSemanticInjectionClassifier,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  type InjectionCalibrationExample,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  type InjectionCalibrationResult,
} from './security/injection-calibration.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/optimizer'; the 2.0 root drops it. */
  TokenOptimizer,
  /** @deprecated Import from 'nexus-ai-pro/optimizer'; the 2.0 root drops it. */
  PromptDensifier,
  /** @deprecated Import from 'nexus-ai-pro/optimizer'; the 2.0 root drops it. */
  BudgetEnforcer,
  TokenBudgetError,
} from './optimizer/index.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/optimizer/cost'; the 2.0 root drops it. */
  estimateCost,
  /** @deprecated Import from 'nexus-ai-pro/optimizer/cost'; the 2.0 root drops it. */
  assertWithinCostBudget,
  /** @deprecated Import from 'nexus-ai-pro/optimizer/cost'; the 2.0 root drops it. */
  formatCost,
  CostBudgetError,
  /** @deprecated Import from 'nexus-ai-pro/optimizer/cost'; the 2.0 root drops it. */
  DEFAULT_CURRENCY,
  /** @deprecated Import from 'nexus-ai-pro/optimizer/cost'; the 2.0 root drops it. */
  type CostEstimateInput,
} from './optimizer/cost.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  createOpenAIEmbeddingProvider,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  createGeminiEmbeddingProvider,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  createCohereEmbeddingProvider,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  toEmbeddingFunction,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  type OpenAIEmbeddingOptions,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  type GeminiEmbeddingOptions,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  type CohereEmbeddingOptions,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  type EmbeddingSource,
} from './embeddings/providers.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingManager,
} from './embeddings/manager.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingCapabilityError,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingError,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingModelNotFoundError,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingProviderError,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingProviderNotFoundError,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingProviderResponseError,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingValidationError,
} from './embeddings/errors.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/embeddings/models'; the 2.0 root drops it. */
  EMBEDDING_MODEL_ALIASES,
  /** @deprecated Import from 'nexus-ai-pro/embeddings/models'; the 2.0 root drops it. */
  EMBEDDING_REGISTRY_PROVENANCE,
  /** @deprecated Import from 'nexus-ai-pro/embeddings/models'; the 2.0 root drops it. */
  KNOWN_EMBEDDING_MODELS,
  /** @deprecated Import from 'nexus-ai-pro/embeddings/models'; the 2.0 root drops it. */
  estimateEmbeddingCost,
  /** @deprecated Import from 'nexus-ai-pro/embeddings/models'; the 2.0 root drops it. */
  getEmbeddingModelAliases,
  /** @deprecated Import from 'nexus-ai-pro/embeddings/models'; the 2.0 root drops it. */
  getEmbeddingModelCapabilities,
  /** @deprecated Import from 'nexus-ai-pro/embeddings/models'; the 2.0 root drops it. */
  getEmbeddingModelRegistry,
  /** @deprecated Import from 'nexus-ai-pro/embeddings/models'; the 2.0 root drops it. */
  listEmbeddingModels,
  /** @deprecated Import from 'nexus-ai-pro/embeddings/models'; the 2.0 root drops it. */
  listEmbeddingModelsForProvider,
  /** @deprecated Import from 'nexus-ai-pro/embeddings/models'; the 2.0 root drops it. */
  priceEmbeddingUsage,
  /** @deprecated Import from 'nexus-ai-pro/embeddings/models'; the 2.0 root drops it. */
  resolveEmbeddingModel,
  /** @deprecated Import from 'nexus-ai-pro/embeddings/models'; the 2.0 root drops it. */
  type EmbeddingCostEstimateInput,
  /** @deprecated Import from 'nexus-ai-pro/embeddings/models'; the 2.0 root drops it. */
  type ResolvedEmbeddingModel,
} from './embeddings/models.js';
export {
  tool,
  /** @deprecated Import from 'nexus-ai-pro/agent'; the 2.0 root drops it. */
  ToolExecutor,
} from './agent/tool.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/agent'; the 2.0 root drops it. */
  AgentLoop,
  /** @deprecated Import `AgentLoopModelClient` from 'nexus-ai-pro/agent'; the 2.0 root drops it. */
  type AgentModelClient,
} from './agent/loop.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/optimizer'; the 2.0 root drops it. */
  Tokenizer,
} from './utils/tokenizer.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/rag'; the 2.0 root drops it. */
  ingestDocuments,
  /** @deprecated Import from 'nexus-ai-pro/rag'; the 2.0 root drops it. */
  ingestText,
  /** @deprecated Import from 'nexus-ai-pro/loaders'; the 2.0 root drops it. */
  type DocumentSource,
  /** @deprecated Import from 'nexus-ai-pro/rag'; the 2.0 root drops it. */
  type IngestionOptions,
  /** @deprecated Import from 'nexus-ai-pro/rag'; the 2.0 root drops it. */
  type IngestionResult,
} from './rag/ingestion.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/rag/files'; the 2.0 root drops it. */
  ingestFilesAfterScan,
  /** @deprecated Import from 'nexus-ai-pro/rag/files'; the 2.0 root drops it. */
  createPdfExtractor,
  /** @deprecated Import from 'nexus-ai-pro/rag/files'; the 2.0 root drops it. */
  createOcrExtractor,
  /** @deprecated Import from 'nexus-ai-pro/rag/files'; the 2.0 root drops it. */
  type FileTextExtractor,
  /** @deprecated Import from 'nexus-ai-pro/rag/files'; the 2.0 root drops it. */
  type FileIngestionOptions,
  /** @deprecated Import from 'nexus-ai-pro/rag/files'; the 2.0 root drops it. */
  type FileIngestionResult,
} from './rag/file-ingestion.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  UploadScanner,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  scanUploads,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  type FileUpload,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  type UploadScannerOptions,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  type UploadScanFinding,
  /** @deprecated Import from 'nexus-ai-pro/security'; the 2.0 root drops it. */
  type UploadScanResult,
} from './security/upload-scanner.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  EvalRunner,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  type EvalCase,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  type EvalClient,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  type EvalJudge,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  type EvalJudgment,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  type EvalResult,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  type EvalRunOptions,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  type EvalRunResult,
} from './evals/runner.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/evals/judge'; the 2.0 root drops it. */
  LLMJudge,
  /** @deprecated Import from 'nexus-ai-pro/evals/judge'; the 2.0 root drops it. */
  createLLMJudgeEval,
  /** @deprecated Import from 'nexus-ai-pro/evals/judge'; the 2.0 root drops it. */
  parseJudgeResponse,
  /** @deprecated Import from 'nexus-ai-pro/evals/judge'; the 2.0 root drops it. */
  type JudgeClient,
  /** @deprecated Import from 'nexus-ai-pro/evals/judge'; the 2.0 root drops it. */
  type LLMJudgeInput,
  /** @deprecated Import from 'nexus-ai-pro/evals/judge'; the 2.0 root drops it. */
  type LLMJudgeInputMapper,
  /** @deprecated Import from 'nexus-ai-pro/evals/judge'; the 2.0 root drops it. */
  type LLMJudgeOptions,
  /** @deprecated Import from 'nexus-ai-pro/evals/judge'; the 2.0 root drops it. */
  type LLMJudgeResult,
} from './evals/judge.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  calculateEvalMetrics,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  exactMatch,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  f1Score,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  semanticSimilarity,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  passAtK,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  perplexity,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  tokensPerSecond,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  faithfulness,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  contextualPrecision,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  contextualRecall,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  toxicityScore,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  biasScore,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  policyAdherence,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  refusalRate,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  type EvalMetrics,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  type MetricInputs,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  type QualityMetrics,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  type OperationalMetrics,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  type RagMetrics,
  /** @deprecated Import from 'nexus-ai-pro/evals'; the 2.0 root drops it. */
  type SafetyMetrics,
} from './evals/metrics.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  summarizeVerifyFormat,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  ragAnswer,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  extractStructured,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  classifyRoute,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  compareAndDecide,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  type SummarizeVerifyFormatOptions,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  type RagAnswerOptions,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  type ExtractStructuredOptions,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  type ClassifyRouteOptions,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  type CompareOptions,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  type WorkflowClient,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  type WorkflowResult,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  type WorkflowStepResult,
} from './workflow/chains.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  supportTriageWorkflow,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  salesQualificationWorkflow,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  legalReviewWorkflow,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  codeReviewWorkflow,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  type DomainWorkflowOptions,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  type SupportWorkflowOptions,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  type SalesWorkflowOptions,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  type LegalReviewWorkflowOptions,
  /** @deprecated Import from 'nexus-ai-pro/workflows'; the 2.0 root drops it. */
  type CodeReviewWorkflowOptions,
} from './workflow/domain.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/jobs/batch'; the 2.0 root drops it. */
  runBatch,
  /** @deprecated Import from 'nexus-ai-pro/jobs/batch'; the 2.0 root drops it. */
  type BatchOptions,
  /** @deprecated Import from 'nexus-ai-pro/jobs/batch'; the 2.0 root drops it. */
  type BatchItemResult,
} from './jobs/batch.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/jobs/queue'; the 2.0 root drops it. */
  JobQueue,
  /** @deprecated Import from 'nexus-ai-pro/jobs/queue'; the 2.0 root drops it. */
  type QueueJob,
  /** @deprecated Import from 'nexus-ai-pro/jobs/queue'; the 2.0 root drops it. */
  type QueueOptions,
} from './jobs/queue.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/jobs/durable-adapters'; the 2.0 root drops it. */
  RedisQueueAdapter,
  /** @deprecated Import from 'nexus-ai-pro/jobs/durable-adapters'; the 2.0 root drops it. */
  BullMQQueueAdapter,
  /** @deprecated Import from 'nexus-ai-pro/jobs/durable-adapters'; the 2.0 root drops it. */
  type DurableQueueAdapter,
  /** @deprecated Import from 'nexus-ai-pro/jobs/durable-adapters'; the 2.0 root drops it. */
  type RedisQueueLikeClient,
  /** @deprecated Import from 'nexus-ai-pro/jobs/durable-adapters'; the 2.0 root drops it. */
  type BullMQLikeQueue,
} from './jobs/durable-adapters.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/connectors'; the 2.0 root drops it. */
  createFetchUrlTool,
  /** @deprecated Import from 'nexus-ai-pro/connectors'; the 2.0 root drops it. */
  createSearchTool,
  /** @deprecated Import from 'nexus-ai-pro/connectors'; the 2.0 root drops it. */
  type WebConnectorOptions,
} from './connectors/web.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  PROVIDER_CONFORMANCE_FIXTURES,
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  runProviderConformance,
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  type ProviderConformanceCase,
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  type ProviderConformanceOptions,
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  type ProviderConformanceResult,
} from './testing/provider-conformance.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  EMBEDDING_PROVIDER_CONFORMANCE_FIXTURES,
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  runEmbeddingProviderConformance,
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  type EmbeddingProviderConformanceCase,
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  type EmbeddingProviderConformanceOptions,
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  type EmbeddingProviderConformanceResult,
} from './testing/embedding-provider-conformance.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  IMAGE_PROVIDER_CONFORMANCE_FIXTURES,
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  runImageProviderConformance,
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  type ImageEditProviderConformanceCase,
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  type ImageGenerateProviderConformanceCase,
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  type ImageProviderConformanceCase,
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  type ImageProviderConformanceOptions,
  /** @deprecated Import from 'nexus-ai-pro/testing'; the 2.0 root drops it. */
  type ImageProviderConformanceResult,
} from './testing/image-provider-conformance.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  OpenTelemetryTraceExporter,
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  type OpenTelemetryLikeSpan,
  /** @deprecated Import from 'nexus-ai-pro/ops'; the 2.0 root drops it. */
  type OpenTelemetryLikeTracer,
} from './ops/otel-tracing.js';

export type {
  CacheHint,
  CompletionRequest,
  Message,
  MessageRole,
  ContentPart,
  PromptCacheConfig,
  ReasoningConfig,
  TextContent,
  ImageContent,
  AudioContent,
  BinaryBuffer,
  VideoContent,
  ToolChoice,
  ToolDefinition,
  ToolCallResult,
} from './types/messages.js';

export type {
  CapabilityConfig,
  CapabilityPolicy,
  CapabilityWarning,
  CapabilityWarningAction,
} from './types/capabilities.js';

export type {
  CostEstimate,
  NexusPlan,
} from './types/planning.js';

export type {
  NexusResponse,
  NexusStream,
  ResponseCost,
  ResponseMeta,
  StreamChunk,
  TokenUsage,
  ToolCall,
} from './types/response.js';

export type {
  NexusAIConfig,
  ProvidersConfig,
  OpenAIProviderConfig,
  AnthropicProviderConfig,
  GoogleProviderConfig,
  OllamaProviderConfig,
  GroqProviderConfig,
  MistralProviderConfig,
  CohereProviderConfig,
  CustomProviderConfig,
  DeepSeekProviderConfig,
  AzureOpenAIProviderConfig,
  LMStudioProviderConfig,
  LlamaCppProviderConfig,
  RoutingConfig,
  RoutingRule,
  RoutingStrategy,
  FallbackConfig,
  ResponseFormatConfig,
  RetryConfig,
  CostBudgetConfig,
  AuditLogConfig,
  LoggerConfig,
  LogEvent,
  LogLevel,
  RateLimitConfig,
} from './types/config.js';

export type {
  ContextSummaryConfig,
  ContextSummaryInput,
  ContextSummaryMode,
  ContextSummarizer,
  ContextWindowConfig,
  ContextWindowResult,
  ContextWindowStrategy,
  ContextWindowUsage,
} from './types/context-window.js';

export type {
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  SpeechRequest,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  SpeechResponse,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  TranscriptionRequest,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  TranscriptionResponse,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  TranscriptionSegment,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  TranscriptionWord,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceAudioFormat,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceAudioInput,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceAudioOutput,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceConfig,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoicePromptText,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceProvider,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceProviderInfo,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceSessionConfig,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceSessionToolStep,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceSessionTurnInput,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceSessionTurnResponse,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceTaskPrompt,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceTaskPromptMatcher,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceTaskPromptMatcherInput,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceTranscriptMessageConfig,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceTurnRequest,
  /** @deprecated Import from 'nexus-ai-pro/voice'; the 2.0 root drops it. */
  VoiceTurnResponse,
} from './types/voice.js';

export type {
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  AssetBytesLocation,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  AssetChecksum,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  AssetDescriptor,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  AssetInput,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  AssetLocation,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  AssetLocationKind,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  AssetProvenance,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  AssetStoredLocation,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  AssetUrlLocation,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageBackground,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageConfig,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageDelivery,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageDimensions,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageEditRequest,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageGenerateRequest,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageManagerConfig,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageMaskInput,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageOperation,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageOperationSubmission,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageOutputFormat,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageProvider,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageProviderCallContext,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageProviderCapabilities,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageProviderInfo,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageQuality,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageRequestBase,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageResult,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageSafetyContext,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageSafetyPolicy,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  ImageWarning,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  MediaSafetyFinding,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  MediaUsage,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationErrorDescriptor,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationEvent,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationEventBase,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationHandle,
  /** @deprecated Import from 'nexus-ai-pro/images'; the 2.0 root drops it. */
  OperationMeta,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationStatus,
} from './types/images.js';

export type {
  /** @deprecated Import from 'nexus-ai-pro/images/assets'; the 2.0 root drops it. */
  AssetCapacityConstraint,
  /** @deprecated Import from 'nexus-ai-pro/images/assets'; the 2.0 root drops it. */
  AssetPutOptions,
  /** @deprecated Import from 'nexus-ai-pro/images/assets'; the 2.0 root drops it. */
  AssetSignOptions,
  /** @deprecated Import from 'nexus-ai-pro/images/assets'; the 2.0 root drops it. */
  AssetSigner,
  /** @deprecated Import from 'nexus-ai-pro/images/assets'; the 2.0 root drops it. */
  AssetSignerContext,
  /** @deprecated Import from 'nexus-ai-pro/images/assets'; the 2.0 root drops it. */
  AssetStat,
  /** @deprecated Import from 'nexus-ai-pro/images/assets'; the 2.0 root drops it. */
  AssetStore,
  /** @deprecated Import from 'nexus-ai-pro/images/assets'; the 2.0 root drops it. */
  AssetStoreResult,
  /** @deprecated Import from 'nexus-ai-pro/images/assets'; the 2.0 root drops it. */
  ByteAssetDescriptor,
  /** @deprecated Import from 'nexus-ai-pro/images/assets'; the 2.0 root drops it. */
  ByteAssetInput,
  /** @deprecated Import from 'nexus-ai-pro/images/assets'; the 2.0 root drops it. */
  MemoryAssetStoreOptions,
  /** @deprecated Import from 'nexus-ai-pro/images/assets'; the 2.0 root drops it. */
  MemoryAssetStoreSnapshot,
} from './images/assets.js';

export type {
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchConfig,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchCounts,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchInputItem,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchJobRef,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchJobResult,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchJobState,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchJobStatus,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchOutputItem,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchProvider,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchProviderCallContext,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchProviderCapabilities,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchProviderInfo,
  /** @deprecated Import from 'nexus-ai-pro/batch'; the 2.0 root drops it. */
  BatchSubmitRequest,
} from './types/batch.js';

export type {
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  DurableOperationHandle,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationContext,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationDispatcher,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationExecutor,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationLease,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationRecord,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationRetryConfig,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationRunnerConfig,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationStore,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationStoreFilter,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationStoreStats,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationSubmitOptions,
  /** @deprecated Import from 'nexus-ai-pro/operations'; the 2.0 root drops it. */
  OperationWebhookConfig,
} from './types/operations.js';

export type {
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  Embedding,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingConfig,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingCostBudgetConfig,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingEncodingFormat,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingInput,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingInputType,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingMeta,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingModelCapabilities,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingModelRegistryConfig,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingProviderCallContext,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingProviderCapabilities,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingProviderInfo,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingProviderRequest,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingProviderResult,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingProviderUsage,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingRequest,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingResponse,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingTruncateMode,
  /** @deprecated Import from 'nexus-ai-pro/embeddings'; the 2.0 root drops it. */
  EmbeddingsProvider,
} from './types/embeddings.js';

export type {
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  CreateCallRequest,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  CreateCallResponse,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyAudioEncoding,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyCallDirection,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyCallStatus,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyConfig,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyConnectedEvent,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyDtmfEvent,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyGatherConfig,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyHttpMethod,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyMarkEvent,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyMediaEvent,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyMediaStreamEvent,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyOutboundAudioMessage,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyProvider,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyProviderInfo,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyResponseRequest,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyStartEvent,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyStopEvent,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyStreamConfig,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyStreamMode,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyStreamTrack,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyWebhookResponse,
  /** @deprecated Import from 'nexus-ai-pro/telephony'; the 2.0 root drops it. */
  TelephonyWebhookValidationRequest,
} from './types/telephony.js';

export type {
  AliasMetadata,
  AliasStage,
  CacheTtl,
  Modality,
  ModelCapabilities,
  ModelEndpoint,
  ModelStatus,
  PromptCachingCapability,
  ProviderCapabilities,
  ReasoningEffort,
  RoutingModelPreference,
} from './types/providers.js';
export {
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  DEFAULT_CACHE_PRICING,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  KNOWN_MODELS,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  MODEL_ALIAS_METADATA,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  REGISTRY_PROVENANCE,
  /** @deprecated Import from 'nexus-ai-pro/models'; the 2.0 root drops it. */
  resolveProvider,
} from './types/providers.js';

export type {
  SecurityLevel,
  SecurityAction,
  PIIType,
  InjectionDetectionConfig,
  PIIConfig,
  SecurityConfig,
  SecurityFinding,
  SecurityResult,
} from './types/security.js';

export type {
  BudgetExceededAction,
  DensificationConfig,
  BudgetConfig,
  TokenOptimizerConfig,
  TokenUsageSnapshot,
  OptimizationResult,
} from './types/optimizer.js';

export type {
  AgentStep,
  AgentConfig,
  AgentResult,
  ToolExecutionResult,
} from './types/agent.js';
