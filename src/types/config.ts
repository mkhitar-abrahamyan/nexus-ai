import type { SecurityConfig, SecurityLevel } from './security.js';
import type { TokenOptimizerConfig } from './optimizer.js';
import type { ContextWindowConfig } from './context-window.js';
import type { VoiceConfig } from './voice.js';
import type { ImageConfig } from './images.js';
import type { TelephonyConfig } from './telephony.js';
import type { Modality, ModelCapabilities, ModelStatus, RoutingModelPreference } from './providers.js';
import type { PipelineConfig } from '../pipeline/types.js';
import type { CacheAdapter } from '../cache/adapters.js';
import type { SemanticCacheOptions } from '../cache/semantic-cache.js';
import type { MetricsConfig } from '../ops/metrics.js';
import type { HealthConfig } from '../ops/health.js';

// ── Provider Configs ───────────────────────────────────────────────

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string;
  organization?: string;
  defaultHeaders?: Record<string, string>;
  defaultQuery?: Record<string, string>;
  providerName?: string;
  modelPrefix?: string | string[];
  isLocal?: boolean;
}

export interface AnthropicProviderConfig {
  apiKey: string;
  baseUrl?: string;
  providerName?: string;
  modelPrefix?: string | string[];
  isLocal?: boolean;
}

export interface GoogleProviderConfig {
  apiKey: string;
  baseUrl?: string;
  projectId?: string;
}

export interface OllamaProviderConfig {
  baseUrl?: string;
  timeout?: number;
}

export interface GroqProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface MistralProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface CohereProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

export interface OpenRouterProviderConfig {
  apiKey: string;
  baseUrl?: string;
  appName?: string;
  siteUrl?: string;
}

/** Configuration for the DeepSeek OpenAI-compatible provider. */
export interface DeepSeekProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

/** Configuration for Azure OpenAI deployment-scoped chat completions. */
export interface AzureOpenAIProviderConfig {
  apiKey: string;
  endpoint: string;
  deployment: string;
  apiVersion?: string;
  baseUrl?: string;
  defaultHeaders?: Record<string, string>;
  defaultQuery?: Record<string, string>;
}

/** Configuration for a local LM Studio OpenAI-compatible server. */
export interface LMStudioProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  modelPrefix?: string | string[];
}

/** Configuration for a local llama.cpp OpenAI-compatible server. */
export interface LlamaCppProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  modelPrefix?: string | string[];
}

/** Configuration for user-owned OpenAI- or Anthropic-compatible endpoints. */
export interface CustomProviderConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  format: 'openai' | 'anthropic';
  headers?: Record<string, string>;
  query?: Record<string, string>;
  modelPrefix?: string | string[];
  isLocal?: boolean;
}

/** Provider configs that Nexus can register from the constructor. */
export interface ProvidersConfig {
  openai?: OpenAIProviderConfig;
  anthropic?: AnthropicProviderConfig;
  google?: GoogleProviderConfig;
  ollama?: OllamaProviderConfig;
  groq?: GroqProviderConfig;
  mistral?: MistralProviderConfig;
  cohere?: CohereProviderConfig;
  openrouter?: OpenRouterProviderConfig;
  deepseek?: DeepSeekProviderConfig;
  azureOpenAI?: AzureOpenAIProviderConfig;
  lmstudio?: LMStudioProviderConfig;
  llamaCpp?: LlamaCppProviderConfig;
  custom?: CustomProviderConfig[];
}

export interface ModelRegistryConfig {
  aliases?: Record<string, string>;
  registry?: Record<string, ModelCapabilities>;
  includeDefaults?: boolean;
}

export interface CacheConfig {
  enabled?: boolean;
  ttlSeconds?: number;
  maxEntries?: number;
  strategy?: 'exact' | 'semantic' | 'hybrid';
  adapter?: CacheAdapter;
  semantic?: SemanticCacheOptions;
}

export interface ResponseFormatConfig {
  type: 'text' | 'json' | 'json_schema';
  schema?: Record<string, unknown>;
}

export interface RateLimitConfig {
  enabled?: boolean;
  maxRequests: number;
  windowMs: number;
  key?: 'userId' | 'model' | 'global';
}

export interface AuditLogConfig {
  enabled?: boolean;
  includeInput?: boolean;
  includeOutput?: boolean;
  /**
   * Preserve raw credentials and personal data in audit events.
   * Enable only for an access-controlled sink with an appropriate retention policy.
   * @default false
   */
  includeSensitiveData?: boolean;
  sink?: (event: AuditLogEvent) => void | Promise<void>;
}

export interface AuditLogEvent {
  type: 'request' | 'response' | 'blocked';
  requestId?: string;
  userId?: string;
  model?: string;
  provider?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEvent {
  level: LogLevel;
  message: string;
  timestamp: string;
  data?: Record<string, unknown>;
  error?:
    | {
        name?: string;
        message: string;
        stack?: string;
      }
    | unknown;
}

/** Structured logger hook config. */
export interface LoggerConfig {
  sink?: (event: LogEvent) => void | Promise<void>;
  console?: boolean;
}

export interface RetryConfig {
  enabled?: boolean;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  backoff?: 'fixed' | 'exponential';
  retryOn?: Array<'timeout' | 'rate-limit' | 'server-error' | 'network' | 'unknown'>;
}

export interface CostBudgetConfig {
  enabled?: boolean;
  maxEstimatedCost?: number;
  estimatedOutputTokens?: number;
  onExceeded?: 'error' | 'warn';
}

// ── Routing ────────────────────────────────────────────────────────

export type RoutingStrategy = 'cost' | 'speed' | 'quality' | 'privacy';

export interface RoutingRule {
  when: Record<string, unknown> | '*';
  use: string;
}

export interface FallbackConfig {
  onError?: string[];
  onTimeout?: { after: number; fallbackTo: string };
  onRateLimit?: { retryAfter: number; maxRetries: number; thenFallbackTo: string };
}

export interface RoutingConfig {
  mode: 'auto' | 'rules' | 'hybrid' | 'direct';
  strategy?: RoutingStrategy;
  candidateModels?: string[];
  allowModels?: string[];
  denyModels?: string[];
  requiredCapabilities?: {
    modalities?: Modality[];
    streaming?: boolean;
    toolCalling?: boolean;
    structuredOutputs?: boolean;
    jsonMode?: boolean;
    reasoning?: boolean;
    minContextTokens?: number;
    maxInputCostPer1k?: number;
    maxOutputCostPer1k?: number;
    statuses?: ModelStatus[];
  };
  modelPreferences?: Partial<Record<RoutingStrategy, RoutingModelPreference[]>>;
  rules?: RoutingRule[];
  fallback?: FallbackConfig;
}

// ── Main Config ────────────────────────────────────────────────────

export interface NexusAIConfig {
  providers: ProvidersConfig;
  routing?: RoutingConfig;
  security?: SecurityLevel | SecurityConfig;
  contextWindow?: ContextWindowConfig;
  voice?: VoiceConfig;
  images?: ImageConfig;
  telephony?: TelephonyConfig;
  tokenOptimizer?: TokenOptimizerConfig;
  models?: ModelRegistryConfig;
  cache?: CacheConfig;
  rateLimit?: RateLimitConfig;
  auditLog?: AuditLogConfig;
  responseFormat?: ResponseFormatConfig;
  retry?: RetryConfig;
  costBudget?: CostBudgetConfig;
  pipeline?: PipelineConfig;
  metrics?: MetricsConfig;
  health?: HealthConfig;
  logger?: LoggerConfig;
  defaultModel?: string;
  timeout?: number;
  debug?: boolean;
}
