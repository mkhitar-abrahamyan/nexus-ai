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
export { createNexusRouteHandler } from './next/route-handler.js';
export {
  getModelRegistry,
  getModelAliases,
  getAliasMetadata,
  resolveModel,
  resolveModelAlias,
  listKnownModels,
  listModelsForProvider,
  getModelCapabilities,
  describeModel,
  checkRegistryFreshness,
  assertRegistryFreshness,
  type ModelProvenance,
  type RegistryFreshness,
  type ResolvedModel,
} from './models/registry.js';
export {
  negotiateCompletionRequest,
  NexusCapabilityError,
  type NegotiateOptions,
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
export { MemoryCache, createCacheKey } from './cache/memory-cache.js';
export {
  MemoryCacheAdapter,
  RedisCacheAdapter,
  SQLiteCacheAdapter,
  type CacheAdapter,
  type RedisLikeClient,
  type SQLiteLikeDatabase,
} from './cache/adapters.js';
export { SemanticCache, type SemanticCacheOptions } from './cache/semantic-cache.js';
export { ResponseFormatError } from './core/response-format.js';
export {
  ContextWindowManager,
  type ContextWindowRuntime,
} from './context/index.js';
export {
  VoiceManager,
  VoiceSession,
  VoiceProviderError,
  VoiceCapabilityError,
  type VoiceCompletionClient,
  type VoiceSessionCompletionClient,
  type VoiceSessionRuntime,
} from './voice/index.js';
export { OperationRunner } from './operations/runner.js';
export { LocalOperationHandle, describeOperationError } from './operations/handle.js';
export { MemoryOperationStore, assertSerializableRecord } from './operations/store.js';
export {
  BullMQOperationDispatcher,
  RedisOperationStore,
  type BullMQLikeOperationQueue,
  type RedisOperationLikeClient,
} from './operations/adapters.js';
export {
  OPERATION_WEBHOOK_SIGNATURE_HEADER,
  deliverOperationWebhook,
  signOperationWebhook,
  verifyOperationWebhook,
} from './operations/webhooks.js';
export { TERMINAL_OPERATION_STATUSES } from './types/operations.js';
export {
  allowedTransitions,
  assertTransition,
  canTransition,
  isClaimable,
  isSettled,
  isTerminalOperationStatus,
} from './operations/state-machine.js';
export {
  OperationCancelledError,
  OperationConflictError,
  OperationError,
  OperationExpiredError,
  OperationLeaseLostError,
  OperationNotFoundError,
  OperationSerializationError,
  OperationTransitionError,
} from './operations/errors.js';
export { ImageManager } from './images/manager.js';
export {
  ImageCapabilityError,
  ImageError,
  ImageOperationCancelledError,
  ImageProviderError,
  ImageProviderNotFoundError,
  ImageProviderResponseError,
  ImageSafetyError,
  ImageValidationError,
} from './images/errors.js';
export {
  TelephonyManager,
  TelephonyProviderError,
  TelephonyCapabilityError,
  createVoiceTwiML,
} from './telephony/index.js';
export { hardenPrompt } from './security/prompt-hardening.js';
export { RateLimiter, NexusRateLimitError, type RateLimitedRequest } from './ops/rate-limiter.js';
export { AuditLogger } from './ops/audit-logger.js';
export {
  FamilyTelemetry,
  type FamilyCallDescriptor,
  type FamilyRuntime,
} from './ops/family-telemetry.js';
export {
  MetricsCollector,
  InMemoryMetrics,
  OpenTelemetryMetricsSink,
  type MetricsConfig,
  type MetricsSink,
  type OpenTelemetryLikeMeter,
} from './ops/metrics.js';
export {
  ProviderHealthMonitor,
  type HealthConfig,
  type ProviderHealthSnapshot,
} from './ops/health.js';
export {
  CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitSnapshot,
  type CircuitState,
  type CircuitStateChange,
} from './ops/circuit-breaker.js';
export {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  type RateLimitHit,
  type RateLimitStore,
  type RedisRateLimitLikeClient,
  type RedisRateLimitStoreOptions,
} from './ops/rate-limit-adapters.js';
export {
  PipelineRunner,
  createPipelineContext,
} from './pipeline/pipeline.js';
export type {
  PipelineConfig,
  PipelineContext,
  PipelineHookName,
  PipelineHooksConfig,
  PipelineMiddleware,
  PipelineStep,
  PipelineStepName,
  PipelineTrace,
  PipelineTraceStep,
} from './pipeline/types.js';
export {
  withFactualDefaults,
  asJsonOnly,
  type FactualOptions,
} from './hallucination/factual.js';
export {
  withRagContext,
  extractCitations,
  validateCitations,
  type RagChunk,
  type RagOptions,
} from './hallucination/rag.js';
export {
  MemoryVectorStore,
  createHashEmbeddings,
  cosineSimilarity,
  type EmbeddingProvider,
  type VectorDocument,
  type VectorSearchOptions,
  type VectorSearchResult,
} from './hallucination/retrieval.js';
export {
  withKnowledgeGraphContext,
  selectGraphFacts,
  type KnowledgeGraph,
  type KnowledgeGraphEdge,
  type KnowledgeGraphNode,
  type KnowledgeGraphOptions,
} from './hallucination/knowledge-graph.js';
export {
  completeVerified,
  verifyAgainstContext,
  extractFacts,
  lexicalEntailment,
  type NliVerifier,
  type VerificationClient,
  type VerificationFact,
  type VerificationOptions,
  type VerificationReport,
} from './hallucination/verification.js';
export {
  completeWithSelfConsistency,
  selectMostConsistent,
  textSimilarity,
  type ConsistencyClient,
  type SelfConsistencyOptions,
} from './hallucination/consistency.js';

export {
  BaseProvider,
  NexusProviderError,
  type NexusProviderErrorCategory,
  type NexusProviderErrorOptions,
  type ProviderInfo,
} from './providers/base.js';
export { OpenAIProvider } from './providers/openai.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { GoogleProvider } from './providers/google.js';
export { OllamaProvider } from './providers/ollama.js';
export { OpenRouterProvider } from './providers/openrouter.js';
export { GroqProvider } from './providers/groq.js';
export { MistralProvider } from './providers/mistral.js';
export { CohereProvider } from './providers/cohere.js';
export { DeepSeekProvider } from './providers/deepseek.js';
export { AzureOpenAIProvider } from './providers/azure-openai.js';
export { LMStudioProvider } from './providers/lmstudio.js';
export { LlamaCppProvider } from './providers/llamacpp.js';

export { Router, FailoverExecutor, type RouteDecision, type RouterContext } from './router/index.js';
export {
  SecurityPipeline,
  NexusSecurityError,
  SchemaValidator,
  InjectionDetector,
  PIIDetector,
  OutputGuard,
  InputGuard,
  SemanticInjectionClassifier,
} from './security/index.js';
export {
  guardrailPolicy,
  GUARDRAIL_POLICIES,
  type GuardrailPolicyName,
} from './security/policies.js';
export {
  SEMANTIC_INJECTION_CALIBRATION_SET,
  calibrateSemanticInjectionClassifier,
  type InjectionCalibrationExample,
  type InjectionCalibrationResult,
} from './security/injection-calibration.js';
export {
  TokenOptimizer,
  PromptDensifier,
  BudgetEnforcer,
  TokenBudgetError,
} from './optimizer/index.js';
export {
  estimateCost,
  assertWithinCostBudget,
  formatCost,
  CostBudgetError,
  DEFAULT_CURRENCY,
  type CostEstimateInput,
} from './optimizer/cost.js';
export {
  createOpenAIEmbeddingProvider,
  createGeminiEmbeddingProvider,
  createCohereEmbeddingProvider,
  toEmbeddingFunction,
  type OpenAIEmbeddingOptions,
  type GeminiEmbeddingOptions,
  type CohereEmbeddingOptions,
  type EmbeddingSource,
} from './embeddings/providers.js';
export { EmbeddingManager } from './embeddings/manager.js';
export {
  EmbeddingCapabilityError,
  EmbeddingError,
  EmbeddingModelNotFoundError,
  EmbeddingProviderError,
  EmbeddingProviderNotFoundError,
  EmbeddingProviderResponseError,
  EmbeddingValidationError,
} from './embeddings/errors.js';
export {
  EMBEDDING_MODEL_ALIASES,
  EMBEDDING_REGISTRY_PROVENANCE,
  KNOWN_EMBEDDING_MODELS,
  estimateEmbeddingCost,
  getEmbeddingModelAliases,
  getEmbeddingModelCapabilities,
  getEmbeddingModelRegistry,
  listEmbeddingModels,
  listEmbeddingModelsForProvider,
  priceEmbeddingUsage,
  resolveEmbeddingModel,
  type EmbeddingCostEstimateInput,
  type ResolvedEmbeddingModel,
} from './embeddings/models.js';
export { tool, ToolExecutor } from './agent/tool.js';
export { AgentLoop, type AgentModelClient } from './agent/loop.js';
export { Tokenizer } from './utils/tokenizer.js';
export {
  ingestDocuments,
  ingestText,
  type DocumentSource,
  type IngestionOptions,
  type IngestionResult,
} from './rag/ingestion.js';
export {
  ingestFilesAfterScan,
  createPdfExtractor,
  createOcrExtractor,
  type FileTextExtractor,
  type FileIngestionOptions,
  type FileIngestionResult,
} from './rag/file-ingestion.js';
export {
  UploadScanner,
  scanUploads,
  type FileUpload,
  type UploadScannerOptions,
  type UploadScanFinding,
  type UploadScanResult,
} from './security/upload-scanner.js';
export {
  EvalRunner,
  type EvalCase,
  type EvalClient,
  type EvalJudge,
  type EvalJudgment,
  type EvalResult,
  type EvalRunResult,
} from './evals/runner.js';
export {
  LLMJudge,
  createLLMJudgeEval,
  parseJudgeResponse,
  type JudgeClient,
  type LLMJudgeInput,
  type LLMJudgeInputMapper,
  type LLMJudgeOptions,
  type LLMJudgeResult,
} from './evals/judge.js';
export {
  calculateEvalMetrics,
  exactMatch,
  f1Score,
  semanticSimilarity,
  passAtK,
  perplexity,
  tokensPerSecond,
  faithfulness,
  contextualPrecision,
  contextualRecall,
  toxicityScore,
  biasScore,
  policyAdherence,
  refusalRate,
  type EvalMetrics,
  type MetricInputs,
  type QualityMetrics,
  type OperationalMetrics,
  type RagMetrics,
  type SafetyMetrics,
} from './evals/metrics.js';
export {
  summarizeVerifyFormat,
  ragAnswer,
  extractStructured,
  classifyRoute,
  compareAndDecide,
  type SummarizeVerifyFormatOptions,
  type RagAnswerOptions,
  type ExtractStructuredOptions,
  type ClassifyRouteOptions,
  type CompareOptions,
  type WorkflowClient,
  type WorkflowResult,
  type WorkflowStepResult,
} from './workflow/chains.js';
export {
  supportTriageWorkflow,
  salesQualificationWorkflow,
  legalReviewWorkflow,
  codeReviewWorkflow,
  type DomainWorkflowOptions,
  type SupportWorkflowOptions,
  type SalesWorkflowOptions,
  type LegalReviewWorkflowOptions,
  type CodeReviewWorkflowOptions,
} from './workflow/domain.js';
export {
  runBatch,
  type BatchOptions,
  type BatchItemResult,
} from './jobs/batch.js';
export {
  JobQueue,
  type QueueJob,
  type QueueOptions,
} from './jobs/queue.js';
export {
  RedisQueueAdapter,
  BullMQQueueAdapter,
  type DurableQueueAdapter,
  type RedisQueueLikeClient,
  type BullMQLikeQueue,
} from './jobs/durable-adapters.js';
export {
  createFetchUrlTool,
  createSearchTool,
  type WebConnectorOptions,
} from './connectors/web.js';
export {
  PROVIDER_CONFORMANCE_FIXTURES,
  runProviderConformance,
  type ProviderConformanceCase,
  type ProviderConformanceOptions,
  type ProviderConformanceResult,
} from './testing/provider-conformance.js';
export {
  EMBEDDING_PROVIDER_CONFORMANCE_FIXTURES,
  runEmbeddingProviderConformance,
  type EmbeddingProviderConformanceCase,
  type EmbeddingProviderConformanceOptions,
  type EmbeddingProviderConformanceResult,
} from './testing/embedding-provider-conformance.js';
export {
  IMAGE_PROVIDER_CONFORMANCE_FIXTURES,
  runImageProviderConformance,
  type ImageEditProviderConformanceCase,
  type ImageGenerateProviderConformanceCase,
  type ImageProviderConformanceCase,
  type ImageProviderConformanceOptions,
  type ImageProviderConformanceResult,
} from './testing/image-provider-conformance.js';
export {
  OpenTelemetryTraceExporter,
  type OpenTelemetryLikeSpan,
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
  SpeechRequest,
  SpeechResponse,
  TranscriptionRequest,
  TranscriptionResponse,
  TranscriptionSegment,
  TranscriptionWord,
  VoiceAudioFormat,
  VoiceAudioInput,
  VoiceAudioOutput,
  VoiceConfig,
  VoicePromptText,
  VoiceProvider,
  VoiceProviderInfo,
  VoiceSessionConfig,
  VoiceSessionToolStep,
  VoiceSessionTurnInput,
  VoiceSessionTurnResponse,
  VoiceTaskPrompt,
  VoiceTaskPromptMatcher,
  VoiceTaskPromptMatcherInput,
  VoiceTranscriptMessageConfig,
  VoiceTurnRequest,
  VoiceTurnResponse,
} from './types/voice.js';

export type {
  AssetBytesLocation,
  AssetChecksum,
  AssetDescriptor,
  AssetInput,
  AssetLocation,
  AssetLocationKind,
  AssetProvenance,
  AssetStoredLocation,
  AssetUrlLocation,
  ImageBackground,
  ImageConfig,
  ImageDelivery,
  ImageDimensions,
  ImageEditRequest,
  ImageGenerateRequest,
  ImageManagerConfig,
  ImageMaskInput,
  ImageOperation,
  ImageOperationSubmission,
  ImageOutputFormat,
  ImageProvider,
  ImageProviderCallContext,
  ImageProviderCapabilities,
  ImageProviderInfo,
  ImageQuality,
  ImageRequestBase,
  ImageResult,
  ImageSafetyContext,
  ImageSafetyPolicy,
  ImageWarning,
  MediaSafetyFinding,
  MediaUsage,
  OperationErrorDescriptor,
  OperationEvent,
  OperationEventBase,
  OperationHandle,
  OperationMeta,
  OperationStatus,
} from './types/images.js';

export type {
  AssetCapacityConstraint,
  AssetPutOptions,
  AssetSignOptions,
  AssetSigner,
  AssetSignerContext,
  AssetStat,
  AssetStore,
  AssetStoreResult,
  ByteAssetDescriptor,
  ByteAssetInput,
  MemoryAssetStoreOptions,
  MemoryAssetStoreSnapshot,
} from './images/assets.js';

export type {
  DurableOperationHandle,
  OperationContext,
  OperationDispatcher,
  OperationExecutor,
  OperationLease,
  OperationRecord,
  OperationRetryConfig,
  OperationRunnerConfig,
  OperationStore,
  OperationSubmitOptions,
  OperationWebhookConfig,
} from './types/operations.js';

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
} from './types/embeddings.js';

export type {
  CreateCallRequest,
  CreateCallResponse,
  TelephonyAudioEncoding,
  TelephonyCallDirection,
  TelephonyCallStatus,
  TelephonyConfig,
  TelephonyConnectedEvent,
  TelephonyDtmfEvent,
  TelephonyGatherConfig,
  TelephonyHttpMethod,
  TelephonyMarkEvent,
  TelephonyMediaEvent,
  TelephonyMediaStreamEvent,
  TelephonyOutboundAudioMessage,
  TelephonyProvider,
  TelephonyProviderInfo,
  TelephonyResponseRequest,
  TelephonyStartEvent,
  TelephonyStopEvent,
  TelephonyStreamConfig,
  TelephonyStreamMode,
  TelephonyStreamTrack,
  TelephonyWebhookResponse,
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
  DEFAULT_CACHE_PRICING,
  KNOWN_MODELS,
  MODEL_ALIAS_METADATA,
  REGISTRY_PROVENANCE,
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
