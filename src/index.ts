/**
 * The root import: the core client, its config builders, its types, the errors it throws, and the
 * lifecycle every operation runs through. Every family — graphs, agents, retrieval, images, voice,
 * evaluation, the server — is on a subpath of its own, so importing the client never loads them.
 */
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
  BudgetExceededError,
  LIFECYCLE_STAGES,
  OperationDeniedError,
  OperationLifecycle,
  type LifecycleRuntime,
  type OperationPlan,
} from './core/lifecycle.js';

export { NexusCapabilityError } from './capabilities/negotiate.js';
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

export { ResponseFormatError } from './core/response-format.js';

export { NexusRateLimitError } from './ops/rate-limiter.js';

export { NexusProviderError } from './providers/base.js';

export { NexusSecurityError } from './security/index.js';

export { TokenBudgetError } from './optimizer/index.js';
export { CostBudgetError } from './optimizer/cost.js';

export { tool, toolOutput } from './agent/tool.js';

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
  AssetContent,
  ToolChoice,
  ToolDefinition,
  ToolCallResult,
  ToolOutput,
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
  AuditLogEvent,
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
  AliasMetadata,
  AliasStage,
  CacheTtl,
  InputModality,
  ModelCapabilities,
  ModelEndpoint,
  ModelStatus,
  OutputModality,
  PromptCachingCapability,
  ProviderCapabilities,
  ReasoningEffort,
  RoutingModelPreference,
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

export type {
  BudgetLedger,
  BudgetPeriod,
  BudgetReservation,
  LifecycleConfig,
  LifecycleHooks,
  LifecycleStage,
  OperationDescriptor,
  OperationFamily,
  OperationLifecycleLike,
  OperationOutcome,
  OperationResultInfo,
  OperationStartOptions,
  OperationTicket,
  ProviderCallContext,
} from './types/lifecycle.js';
