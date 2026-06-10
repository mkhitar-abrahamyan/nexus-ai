import type { SecurityConfig, SecurityLevel } from './security.js';
import type { TokenOptimizerConfig } from './optimizer.js';
import type { ContextWindowConfig } from './context-window.js';
import type { VoiceConfig } from './voice.js';
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
}

export interface AnthropicProviderConfig {
  apiKey: string;
  baseUrl?: string;
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

export interface CustomProviderConfig {
  name: string;
  baseUrl: string;
  apiKey?: string;
  format: 'openai' | 'anthropic';
}

export interface ProvidersConfig {
  openai?: OpenAIProviderConfig;
  anthropic?: AnthropicProviderConfig;
  google?: GoogleProviderConfig;
  ollama?: OllamaProviderConfig;
  groq?: GroqProviderConfig;
  mistral?: MistralProviderConfig;
  cohere?: CohereProviderConfig;
  openrouter?: OpenRouterProviderConfig;
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
  defaultModel?: string;
  timeout?: number;
  debug?: boolean;
}
