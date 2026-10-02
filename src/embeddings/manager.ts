import type { ProvidersConfig } from '../types/config.js';
import type { LifecycleConfig } from '../types/lifecycle.js';
import type { EmbeddingConfig, EmbeddingRequest, EmbeddingResponse, EmbeddingsProvider } from '../types/embeddings.js';
import type { AuditLogger } from '../ops/audit-logger.js';
import type { MetricsCollector } from '../ops/metrics.js';
import type { RateLimiter } from '../ops/rate-limiter.js';
import type { EmbeddingEngine } from './engine.js';
import { EmbeddingValidationError } from './errors.js';
import { configuredEmbeddingProviderNames } from './auto-providers.js';

/** What a client shares with its embedding family. Every field is optional. */
export interface EmbeddingManagerRuntime {
  /** Where metrics go. */
  metrics?: MetricsCollector;
  /** Where audit events go. */
  auditLogger?: AuditLogger;
  /** The rate limiter every family shares. */
  rateLimiter?: RateLimiter;
  /** The client's authorization, budget, and hooks, shared with every other family. */
  lifecycle?: LifecycleConfig;
  /** Provider credentials used to auto-register adapters. */
  providers?: ProvidersConfig;
}

/**
 * Provider-neutral embeddings with routing, caching, batching, budget, retry, audit, and metrics.
 *
 * The operation family behind `ai.embed()`. It is usable standalone, and when it is reached through
 * `NexusAI` it runs through that client's lifecycle, so embedding spend appears alongside completion
 * spend instead of being invisible. The routing, batching, and provider code loads on the first
 * embedding, so a client that never embeds never imports it.
 */
export class EmbeddingManager {
  private readonly providers = new Map<string, EmbeddingsProvider>();
  private engine?: Promise<EmbeddingEngine>;

  constructor(
    private readonly config: EmbeddingConfig = {},
    private readonly runtime: EmbeddingManagerRuntime = {},
  ) {
    for (const [name, provider] of Object.entries(config.providers ?? {})) {
      this.registerEmbeddingProvider(name, provider);
    }
  }

  /** Registers a provider under a name. Returns the manager, for chaining. */
  registerEmbeddingProvider(name: string, provider: EmbeddingsProvider): this {
    const normalizedName = name.trim();
    if (!normalizedName) throw new EmbeddingValidationError('Embedding provider name must not be empty');
    if (typeof provider?.embed !== 'function') {
      throw new EmbeddingValidationError(`Embedding provider "${normalizedName}" must implement embed()`);
    }
    if (!provider.info?.capabilities) {
      throw new EmbeddingValidationError(`Embedding provider "${normalizedName}" must declare capabilities`);
    }

    this.providers.set(normalizedName, provider);
    return this;
  }

  /** Whether a provider is registered, or will be built from the client's provider credentials. */
  hasEmbeddingProvider(name: string): boolean {
    return this.providers.has(name) || this.automaticNames().includes(name);
  }

  /** Every registered provider's name, then those the client's credentials will build. */
  listEmbeddingProviders(): string[] {
    const names = [...this.providers.keys()];
    for (const name of this.automaticNames()) if (!names.includes(name)) names.push(name);
    return names;
  }

  /**
   * Embeds one text or a batch.
   *
   * The single-string form returns one vector at `vectors[0]`; a batch returns them in input order
   * regardless of how many provider calls the split required.
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return (await this.load()).embed(request);
  }

  /** Embeds one text and returns the vector alone, for callers that never need the metadata. */
  async embedOne(text: string, options: Omit<EmbeddingRequest, 'input'> = {}): Promise<number[]> {
    return (await this.load()).embedOne(text, options);
  }

  private automaticNames(): string[] {
    if (this.config.autoRegisterProviders === false || !this.runtime.providers) return [];
    return configuredEmbeddingProviderNames(this.runtime.providers);
  }

  private load(): Promise<EmbeddingEngine> {
    this.engine ??= import('./engine.js').then(
      ({ EmbeddingEngine }) => new EmbeddingEngine(this.config, this.runtime, this.providers),
    );
    return this.engine;
  }
}
