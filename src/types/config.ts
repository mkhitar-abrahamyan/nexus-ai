import type { SecurityConfig, SecurityLevel } from './security.js';
import type { TokenOptimizerConfig } from './optimizer.js';
import type { ContextWindowConfig } from './context-window.js';
import type { VoiceConfig } from './voice.js';
import type { ImageConfig } from './images.js';
import type { EmbeddingConfig } from './embeddings.js';
import type { TelephonyConfig } from './telephony.js';
import type { AliasMetadata, Modality, ModelCapabilities, ModelStatus, RoutingModelPreference } from './providers.js';
import type { CapabilityConfig } from './capabilities.js';
import type { PipelineConfig } from '../pipeline/types.js';
import type { CacheAdapter } from '../cache/adapters.js';
import type { SemanticCacheOptions } from '../cache/semantic-cache.js';
import type { MetricsConfig } from '../ops/metrics.js';
import type { RateLimitStore } from '../ops/rate-limit-adapters.js';
import type { CircuitBreakerConfig } from '../ops/circuit-breaker.js';
import type { HealthConfig } from '../ops/health.js';

// ── Provider Configs ───────────────────────────────────────────────

/**
 * Configuration for OpenAI, and for any OpenAI-compatible server — vLLM, a gateway, a proxy —
 * through `baseUrl`.
 */
export interface OpenAIProviderConfig {
  /** API key, sent as a bearer token. */
  apiKey: string;
  /** API base URL. Point it at an OpenAI-compatible server to use that instead. */
  baseUrl?: string;
  /** OpenAI organization to bill. */
  organization?: string;
  /** Headers added to every request. */
  defaultHeaders?: Record<string, string>;
  /** Query parameters added to every request. */
  defaultQuery?: Record<string, string>;
  /**
   * Name this provider registers under, so an OpenAI-compatible server can sit beside OpenAI
   * itself.
   */
  providerName?: string;
  /**
   * Model-name prefixes this provider answers for, such as `vllm/`, which is how the router knows a
   * model is served here.
   */
  modelPrefix?: string | string[];
  /**
   * Marks the endpoint as local, so the `privacy` routing strategy prefers it as it prefers Ollama,
   * LM Studio, and llama.cpp.
   */
  isLocal?: boolean;
  /**
   * Requests token totals on the final streamed chunk through `stream_options.include_usage`, so a
   * streamed response reports real usage and cost instead of zeros. Defaults to on for OpenAI and
   * Azure. Enable it for any other OpenAI-compatible server that accepts the option.
   */
  streamUsage?: boolean;
}

/** Configuration for Anthropic, or an Anthropic-compatible endpoint through `baseUrl`. */
export interface AnthropicProviderConfig {
  /** API key. */
  apiKey: string;
  /** API base URL. */
  baseUrl?: string;
  /** Name this provider registers under. */
  providerName?: string;
  /** Model-name prefixes this provider answers for. */
  modelPrefix?: string | string[];
  /**
   * Marks the endpoint as local, so the `privacy` routing strategy prefers it as it prefers Ollama,
   * LM Studio, and llama.cpp.
   */
  isLocal?: boolean;
}

/** Configuration for Google's Gemini API. */
export interface GoogleProviderConfig {
  /** Gemini API key. */
  apiKey: string;
  /** API base URL. */
  baseUrl?: string;
  /**
   * Ignored: the Gemini API is addressed by API key alone, and Vertex AI projects are not supported
   * by this adapter.
   *
   * @deprecated Has never been read. It will be removed in 2.0.
   */
  projectId?: string;
}

/** Configuration for a local Ollama server. */
export interface OllamaProviderConfig {
  /** Server URL. Defaults to `http://localhost:11434`. */
  baseUrl?: string;
  /**
   * Ignored: set `timeout` on the client or `timeoutMs` on a request, which apply to every
   * provider, Ollama included.
   *
   * @deprecated Has never been read. It will be removed in 2.0.
   */
  timeout?: number;
}

/** Configuration for Groq. */
export interface GroqProviderConfig {
  /** API key. */
  apiKey: string;
  /** API base URL. */
  baseUrl?: string;
}

/** Configuration for Mistral. */
export interface MistralProviderConfig {
  /** API key. */
  apiKey: string;
  /** API base URL. */
  baseUrl?: string;
}

/** Configuration for Cohere. */
export interface CohereProviderConfig {
  /** API key. */
  apiKey: string;
  /** API base URL. */
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
  /** API key. */
  apiKey: string;
  /** API base URL. */
  baseUrl?: string;
}

/** Configuration for Azure OpenAI deployment-scoped chat completions. */
export interface AzureOpenAIProviderConfig {
  /** API key for the Azure OpenAI resource. */
  apiKey: string;
  /** Resource endpoint, such as `https://my-resource.openai.azure.com`. */
  endpoint: string;
  /** Deployment name. Azure addresses a model by deployment rather than by model name. */
  deployment: string;
  /** API version sent as `api-version`. */
  apiVersion?: string;
  /** Overrides the URL built from `endpoint` and `deployment`. */
  baseUrl?: string;
  /** Headers added to every request. */
  defaultHeaders?: Record<string, string>;
  /** Query parameters added to every request. */
  defaultQuery?: Record<string, string>;
}

/** Configuration for a local LM Studio OpenAI-compatible server. */
export interface LMStudioProviderConfig {
  /** Server URL. Defaults to LM Studio's local address. */
  baseUrl?: string;
  /** API key, if the server was configured to require one. */
  apiKey?: string;
  /** Model-name prefixes this provider answers for. */
  modelPrefix?: string | string[];
}

/** Configuration for a local llama.cpp OpenAI-compatible server. */
export interface LlamaCppProviderConfig {
  /** Server URL. Defaults to llama.cpp's local address. */
  baseUrl?: string;
  /** API key, if the server was started with one. */
  apiKey?: string;
  /** Model-name prefixes this provider answers for. */
  modelPrefix?: string | string[];
}

/** Configuration for user-owned OpenAI- or Anthropic-compatible endpoints. */
export interface CustomProviderConfig {
  /** Name the provider registers under. */
  name: string;
  /** API base URL. */
  baseUrl: string;
  /** API key. */
  apiKey?: string;
  /** Which wire protocol the endpoint speaks. */
  format: 'openai' | 'anthropic';
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /** Query parameters added to every request. */
  query?: Record<string, string>;
  /** Model-name prefixes this provider answers for. */
  modelPrefix?: string | string[];
  /**
   * Marks the endpoint as local, so the `privacy` routing strategy prefers it as it prefers Ollama,
   * LM Studio, and llama.cpp.
   */
  isLocal?: boolean;
}

/** Provider configs that Nexus can register from the constructor. */
export interface ProvidersConfig {
  /** OpenAI, or an OpenAI-compatible server. */
  openai?: OpenAIProviderConfig;
  /** Anthropic. */
  anthropic?: AnthropicProviderConfig;
  /** Google Gemini. */
  google?: GoogleProviderConfig;
  /** A local Ollama server. */
  ollama?: OllamaProviderConfig;
  /** Groq. */
  groq?: GroqProviderConfig;
  /** Mistral. */
  mistral?: MistralProviderConfig;
  /** Cohere. */
  cohere?: CohereProviderConfig;
  /** OpenRouter. */
  openrouter?: OpenRouterProviderConfig;
  /** DeepSeek. */
  deepseek?: DeepSeekProviderConfig;
  /** Azure OpenAI. */
  azureOpenAI?: AzureOpenAIProviderConfig;
  /** A local LM Studio server. */
  lmstudio?: LMStudioProviderConfig;
  /** A local llama.cpp server. */
  llamaCpp?: LlamaCppProviderConfig;
  /** Your own OpenAI- or Anthropic-compatible endpoints. */
  custom?: CustomProviderConfig[];
}

export interface ModelRegistryConfig {
  aliases?: Record<string, string>;
  aliasMetadata?: Record<string, AliasMetadata>;
  registry?: Record<string, ModelCapabilities>;
  includeDefaults?: boolean;
  /**
   * Cache prices as a multiple of the model's standard input rate, used when a registry entry
   * declares no explicit `costPer1kCachedInput` or `costPer1kCacheWrite`. Overrides the bundled
   * per-provider defaults.
   */
  cachePricing?: {
    read?: number;
    write?: number;
    writeLong?: number;
  };
  /**
   * Fails registry validation when a bundled entry has not been verified within this many days.
   * Used by `assertRegistryFreshness()`; it never affects a running request.
   */
  maxAgeDays?: number;
}

export interface CacheConfig {
  enabled?: boolean;
  ttlSeconds?: number;
  maxEntries?: number;
  strategy?: 'exact' | 'semantic' | 'hybrid';
  adapter?: CacheAdapter;
  semantic?: SemanticCacheOptions;
}

/** A response format applied to every request that does not set its own. */
export interface ResponseFormatConfig {
  /** Plain text, JSON, or JSON that must match `schema`. */
  type: 'text' | 'json' | 'json_schema';
  /** JSON Schema the response must match, for `json_schema`. */
  schema?: Record<string, unknown>;
}

/** Limits how many requests are allowed per window. */
export interface RateLimitConfig {
  /** Turns limiting on. */
  enabled?: boolean;
  /** Requests allowed per window. */
  maxRequests: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** What a budget is counted per: each user, each model, or everything together. */
  key?: 'userId' | 'model' | 'global';
  /**
   * Where counters live. Omitted means process-local, which multiplies the real limit by the
   * number of workers; supply `RedisRateLimitStore` to share one budget across them.
   */
  store?: RateLimitStore;
}

/**
 * What gets written to the audit log. Credentials and personal data are redacted unless
 * `includeSensitiveData` is set.
 */
export interface AuditLogConfig {
  /** Turns audit logging on. */
  enabled?: boolean;
  /** Records the request in each `request` event. */
  includeInput?: boolean;
  /** Records the response in each `response` event. */
  includeOutput?: boolean;
  /**
   * Preserve raw credentials and personal data in audit events.
   * Enable only for an access-controlled sink with an appropriate retention policy.
   * @default false
   */
  includeSensitiveData?: boolean;
  /** Receives every audit event. Without it, events go to the console. */
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

/** Severity of a log event. */
export type LogLevel = 'info' | 'warn' | 'error';

/** One structured log event. */
export interface LogEvent {
  /** Its severity. */
  level: LogLevel;
  /** What happened. */
  message: string;
  /** ISO-8601 time. */
  timestamp: string;
  /** Structured context. */
  data?: Record<string, unknown>;
  /** The error, when the event reports one. */
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
  /** Receives every log event. */
  sink?: (event: LogEvent) => void | Promise<void>;
  /** Also writes events to the console. */
  console?: boolean;
}

/** How a failed provider call is retried before failover moves on. */
export interface RetryConfig {
  /** Turns retries on. Off by default. */
  enabled?: boolean;
  /** Retries per provider attempt. */
  maxRetries?: number;
  /** Delay before the first retry, in milliseconds. */
  baseDelayMs?: number;
  /** Longest delay between retries, in milliseconds. */
  maxDelayMs?: number;
  /** Whether the delay doubles after each retry or stays fixed. */
  backoff?: 'fixed' | 'exponential';
  /** Error categories worth retrying. Authentication and bad requests never are. */
  retryOn?: Array<'timeout' | 'rate-limit' | 'server-error' | 'network' | 'unknown'>;
}

/** Refuses or flags a request whose estimated cost exceeds a limit, before it is sent. */
export interface CostBudgetConfig {
  /** Turns the budget check on. */
  enabled?: boolean;
  /** Most a request may cost, in US dollars, by the bundled or configured prices. */
  maxEstimatedCost?: number;
  /** Output tokens assumed when a request sets no `maxTokens`, for the estimate. */
  estimatedOutputTokens?: number;
  /** `error` refuses the request; `warn` sends it and reports the overrun. */
  onExceeded?: 'error' | 'warn';
}

// ── Routing ────────────────────────────────────────────────────────

/** What the auto-router optimizes for: price, latency, quality, or keeping data on local models. */
export type RoutingStrategy = 'cost' | 'speed' | 'quality' | 'privacy';

/** A routing rule: when a request matches, route it to a model. */
export interface RoutingRule {
  /**
   * Conditions on the request, or `*` for every request. Each key must equal, or satisfy an
   * operator object.
   */
  when: Record<string, unknown> | '*';
  /** Model the matching request is sent to. */
  use: string;
}

/**
 * Models tried when the route the router chose fails, applied to every request, including one that
 * names its model.
 */
export interface FallbackConfig {
  /** Models tried, in order, after everything the router chose has failed. */
  onError?: string[];
  /**
   * Gives the first attempt its own timeout, `after` milliseconds, and tries `fallbackTo` right
   * after it.
   */
  onTimeout?: { after: number; fallbackTo: string };
  /**
   * Retries a rate-limited first attempt `maxRetries` times, `retryAfter` milliseconds apart, then
   * tries `thenFallbackTo`. Applies even when `retry` is off.
   */
  onRateLimit?: { retryAfter: number; maxRetries: number; thenFallbackTo: string };
}

/** How requests with `model: 'auto'` are routed. */
export interface RoutingConfig {
  /**
   * `auto` ranks models by `strategy`. `rules` and `hybrid` both try `rules` first and rank when
   * none matches; they behave identically. `direct` always uses `defaultModel`.
   */
  mode: 'auto' | 'rules' | 'hybrid' | 'direct';
  /** What the auto-router optimizes for. */
  strategy?: RoutingStrategy;
  /** The models the auto-router chooses among. Defaults to every registered model. */
  candidateModels?: string[];
  /** Only these models may be chosen. */
  allowModels?: string[];
  /** These models are never chosen. */
  denyModels?: string[];
  /**
   * Capabilities every candidate model must have: modalities, streaming, tools, structured output,
   * reasoning, context size, price ceilings, and lifecycle status.
   */
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
  /**
   * Models the auto-router considers for each strategy, per provider, when `candidateModels` is not
   * set.
   */
  modelPreferences?: Partial<Record<RoutingStrategy, RoutingModelPreference[]>>;
  /** Rules checked in order; the first match wins. */
  rules?: RoutingRule[];
  /** Failover models, timeouts, and rate-limit handling added to every route. */
  fallback?: FallbackConfig;
}

// ── Main Config ────────────────────────────────────────────────────

/**
 * Everything a `NexusAI` client needs. Only `providers` is required; every other subsystem is off
 * or defaulted until configured.
 */
export interface NexusAIConfig {
  /** Providers to register, by name. */
  providers: ProvidersConfig;
  /** How `model: 'auto'` is routed. */
  routing?: RoutingConfig;
  /** A preset security level, or detailed guardrails. */
  security?: SecurityLevel | SecurityConfig;
  /** Keeps long conversations within a model's context window. */
  contextWindow?: ContextWindowConfig;
  /** Transcription and speech providers. */
  voice?: VoiceConfig;
  /** Image generation providers and policies. */
  images?: ImageConfig;
  /** Provider-neutral embeddings reached through ai.embed(). */
  embeddings?: EmbeddingConfig;
  /** Telephony providers. */
  telephony?: TelephonyConfig;
  /** Token optimization applied before a request is sent. */
  tokenOptimizer?: TokenOptimizerConfig;
  /** Aliases, prices, and capabilities that extend or replace the bundled registry. */
  models?: ModelRegistryConfig;
  /** How the runtime reacts to request options the target model does not declare. */
  capabilities?: CapabilityConfig;
  /** Response caching. */
  cache?: CacheConfig;
  /** Request rate limiting. */
  rateLimit?: RateLimitConfig;
  /** Audit logging. */
  auditLog?: AuditLogConfig;
  /** Default response format for requests that set none. */
  responseFormat?: ResponseFormatConfig;
  /** Retries for failed provider calls. */
  retry?: RetryConfig;
  /** Cost budget checked before each request. */
  costBudget?: CostBudgetConfig;
  /** Hooks around each stage of a request. */
  pipeline?: PipelineConfig;
  /** Metrics collection. */
  metrics?: MetricsConfig;
  /** Provider health monitoring, which ranks a struggling provider lower. */
  health?: HealthConfig;
  /** Trips routing away from a provider that is failing. Off unless enabled. */
  circuitBreaker?: CircuitBreakerConfig;
  /** Structured log output. */
  logger?: LoggerConfig;
  /** Model used by `direct` routing, and when a request names none. */
  defaultModel?: string;
  /** Default timeout per provider attempt, in milliseconds. */
  timeout?: number;
  /** Emits info-level log events, which are otherwise suppressed. */
  debug?: boolean;
}
