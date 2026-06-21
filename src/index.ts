export { NexusAI } from './core/nexus.js';
export { collectStream, mapStream, createTextStream } from './core/streaming.js';
export { createNexusRouteHandler } from './next/route-handler.js';
export {
  getModelRegistry,
  getModelAliases,
  resolveModel,
  resolveModelAlias,
  listKnownModels,
  listModelsForProvider,
  getModelCapabilities,
} from './models/registry.js';
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
export {
  TelephonyManager,
  TelephonyProviderError,
  TelephonyCapabilityError,
  createVoiceTwiML,
} from './telephony/index.js';
export { hardenPrompt } from './security/prompt-hardening.js';
export { RateLimiter, NexusRateLimitError } from './ops/rate-limiter.js';
export { AuditLogger } from './ops/audit-logger.js';
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
  CostBudgetError,
  type CostEstimateInput,
} from './optimizer/cost.js';
export {
  createOpenAIEmbeddingProvider,
  createGeminiEmbeddingProvider,
  createCohereEmbeddingProvider,
  type OpenAIEmbeddingOptions,
  type GeminiEmbeddingOptions,
  type CohereEmbeddingOptions,
} from './embeddings/providers.js';
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
  OpenTelemetryTraceExporter,
  type OpenTelemetryLikeSpan,
  type OpenTelemetryLikeTracer,
} from './ops/otel-tracing.js';

export type {
  CompletionRequest,
  Message,
  MessageRole,
  ContentPart,
  TextContent,
  ImageContent,
  AudioContent,
  VideoContent,
  ToolDefinition,
  ToolCallResult,
} from './types/messages.js';

export type {
  CostEstimate,
  NexusPlan,
} from './types/planning.js';

export type {
  NexusResponse,
  NexusStream,
  ResponseMeta,
  StreamChunk,
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
  RoutingConfig,
  RoutingRule,
  RoutingStrategy,
  FallbackConfig,
  ResponseFormatConfig,
  RetryConfig,
  CostBudgetConfig,
  AuditLogConfig,
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
  Modality,
  ModelCapabilities,
  ModelEndpoint,
  ModelStatus,
  ProviderCapabilities,
  ReasoningEffort,
  RoutingModelPreference,
} from './types/providers.js';
export { KNOWN_MODELS, resolveProvider } from './types/providers.js';

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
