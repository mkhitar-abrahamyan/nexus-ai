import { NexusAI } from './nexus.js';
import type {
  AnthropicProviderConfig,
  AuditLogConfig,
  AzureOpenAIProviderConfig,
  CacheConfig,
  CohereProviderConfig,
  CostBudgetConfig,
  CustomProviderConfig,
  DeepSeekProviderConfig,
  GoogleProviderConfig,
  GroqProviderConfig,
  LMStudioProviderConfig,
  LlamaCppProviderConfig,
  LoggerConfig,
  MistralProviderConfig,
  NexusAIConfig,
  OllamaProviderConfig,
  OpenAIProviderConfig,
  OpenRouterProviderConfig,
  ProvidersConfig,
  RateLimitConfig,
  ResponseFormatConfig,
  RetryConfig,
  RoutingConfig,
  RoutingStrategy,
} from '../types/config.js';
import type { ContextWindowConfig } from '../types/context-window.js';
import type { ImageConfig } from '../types/images.js';
import type { SecurityConfig, SecurityLevel } from '../types/security.js';
import type { TokenOptimizerConfig } from '../types/optimizer.js';
import type { PipelineConfig } from '../pipeline/types.js';
import type { MetricsConfig } from '../ops/metrics.js';
import type { HealthConfig } from '../ops/health.js';

/**
 * Fluent, typed builder for `NexusAIConfig`.
 *
 * The builder is intentionally thin: every method maps directly to a normal config field, so advanced users
 * can still call `build()` and edit the plain object before passing it to `new NexusAI(...)`.
 */
export class NexusConfigBuilder {
  private config: NexusAIConfig;

  constructor(seed: Partial<NexusAIConfig> = {}) {
    const { providers, ...rest } = seed;
    this.config = {
      ...rest,
      providers: { ...(providers || {}) },
    };
  }

  /** Adds or replaces a provider config by its `ProvidersConfig` key. */
  provider<Name extends keyof ProvidersConfig>(name: Name, config: NonNullable<ProvidersConfig[Name]>): this {
    this.config.providers[name] = config;
    return this;
  }

  /** Adds OpenAI. */
  openai(config: OpenAIProviderConfig | string): this {
    return this.provider('openai', typeof config === 'string' ? { apiKey: config } : config);
  }

  /** Adds Anthropic. */
  anthropic(config: AnthropicProviderConfig | string): this {
    return this.provider('anthropic', typeof config === 'string' ? { apiKey: config } : config);
  }

  /** Adds Google Gemini. */
  google(config: GoogleProviderConfig | string): this {
    return this.provider('google', typeof config === 'string' ? { apiKey: config } : config);
  }

  /** Adds a local Ollama server. */
  ollama(config: OllamaProviderConfig = {}): this {
    return this.provider('ollama', config);
  }

  /** Adds Groq. */
  groq(config: GroqProviderConfig | string): this {
    return this.provider('groq', typeof config === 'string' ? { apiKey: config } : config);
  }

  /** Adds Mistral. */
  mistral(config: MistralProviderConfig | string): this {
    return this.provider('mistral', typeof config === 'string' ? { apiKey: config } : config);
  }

  /** Adds Cohere. */
  cohere(config: CohereProviderConfig | string): this {
    return this.provider('cohere', typeof config === 'string' ? { apiKey: config } : config);
  }

  /** Adds OpenRouter. */
  openrouter(config: OpenRouterProviderConfig | string): this {
    return this.provider('openrouter', typeof config === 'string' ? { apiKey: config } : config);
  }

  /** Adds DeepSeek. */
  deepseek(config: DeepSeekProviderConfig | string): this {
    return this.provider('deepseek', typeof config === 'string' ? { apiKey: config } : config);
  }

  /** Adds Azure OpenAI. */
  azureOpenAI(config: AzureOpenAIProviderConfig): this {
    return this.provider('azureOpenAI', config);
  }

  /** Adds a local LM Studio OpenAI-compatible server. */
  lmstudio(config: LMStudioProviderConfig = {}): this {
    return this.provider('lmstudio', config);
  }

  /** Adds a local llama.cpp OpenAI-compatible server. */
  llamaCpp(config: LlamaCppProviderConfig = {}): this {
    return this.provider('llamaCpp', config);
  }

  /** Adds a user-defined OpenAI- or Anthropic-compatible endpoint. */
  custom(config: CustomProviderConfig): this {
    this.config.providers.custom = [...(this.config.providers.custom || []), config];
    return this;
  }

  /** Sets raw routing config. */
  routing(config: RoutingConfig): this {
    this.config.routing = config;
    return this;
  }

  /** Uses direct routing through a single default model. */
  direct(model: string): this {
    this.config.routing = { mode: 'direct' };
    this.config.defaultModel = model;
    return this;
  }

  /** Uses automatic routing with an optional strategy. */
  auto(strategy: RoutingStrategy = 'quality'): this {
    this.config.routing = { mode: 'auto', strategy };
    return this;
  }

  /** Sets input/output security behavior. */
  security(config: SecurityLevel | SecurityConfig): this {
    this.config.security = config;
    return this;
  }

  /** Sets context-window compaction behavior. */
  contextWindow(config: ContextWindowConfig): this {
    this.config.contextWindow = config;
    return this;
  }

  /** Sets image-provider defaults and registrations. */
  images(config: ImageConfig): this {
    this.config.images = config;
    return this;
  }

  /** Sets token optimization behavior. */
  tokenOptimizer(config: TokenOptimizerConfig): this {
    this.config.tokenOptimizer = config;
    return this;
  }

  /** Sets exact, semantic, or hybrid cache behavior. */
  cache(config: CacheConfig): this {
    this.config.cache = config;
    return this;
  }

  /** Sets rate limiting behavior. */
  rateLimit(config: RateLimitConfig): this {
    this.config.rateLimit = config;
    return this;
  }

  /** Sets audit logging behavior. */
  auditLog(config: AuditLogConfig): this {
    this.config.auditLog = config;
    return this;
  }

  /** Sets response-format defaults. */
  responseFormat(config: ResponseFormatConfig): this {
    this.config.responseFormat = config;
    return this;
  }

  /** Sets provider retry behavior. */
  retry(config: RetryConfig): this {
    this.config.retry = config;
    return this;
  }

  /** Sets request cost-budget behavior. */
  costBudget(config: CostBudgetConfig): this {
    this.config.costBudget = config;
    return this;
  }

  /** Sets pipeline hook and trace behavior. */
  pipeline(config: PipelineConfig): this {
    this.config.pipeline = config;
    return this;
  }

  /** Sets metrics sink behavior. */
  metrics(config: MetricsConfig): this {
    this.config.metrics = config;
    return this;
  }

  /** Sets provider health scoring behavior. */
  health(config: HealthConfig): this {
    this.config.health = config;
    return this;
  }

  /** Sets structured logger behavior. */
  logger(config: LoggerConfig): this {
    this.config.logger = config;
    return this;
  }

  /** Sets global provider timeout in milliseconds. */
  timeout(ms: number): this {
    this.config.timeout = ms;
    return this;
  }

  /** Toggles debug logging. */
  debug(enabled = true): this {
    this.config.debug = enabled;
    return this;
  }

  /** Returns a plain `NexusAIConfig` object. */
  build(): NexusAIConfig {
    return {
      ...this.config,
      providers: {
        ...this.config.providers,
        ...(this.config.providers.custom ? { custom: [...this.config.providers.custom] } : {}),
      },
    };
  }

  /** Creates a `NexusAI` instance from the current builder state. */
  create(): NexusAI {
    return new NexusAI(this.build());
  }
}

/**
 * Starts a fluent `NexusAIConfig` builder.
 */
export function createNexusConfig(seed: Partial<NexusAIConfig> = {}): NexusConfigBuilder {
  return new NexusConfigBuilder(seed);
}

/**
 * Identity helper for users who prefer object literals but want type inference and validation in editors.
 */
export function defineNexusConfig(config: NexusAIConfig): NexusAIConfig {
  return config;
}
