import type { CacheAdapter } from '../cache/adapters.js';
import type { ProvidersConfig, RetryConfig } from '../types/config.js';
import type {
  Embedding,
  EmbeddingConfig,
  EmbeddingMeta,
  EmbeddingProviderCallContext,
  EmbeddingProviderRequest,
  EmbeddingProviderResult,
  EmbeddingRequest,
  EmbeddingResponse,
  EmbeddingsProvider,
} from '../types/embeddings.js';
import type { TokenUsage } from '../types/response.js';
import { MemoryCache, createCacheKey } from '../cache/memory-cache.js';
import { AuditLogger } from '../ops/audit-logger.js';
import { MetricsCollector } from '../ops/metrics.js';
import { RateLimiter } from '../ops/rate-limiter.js';
import { NexusProviderError, createTimeoutProviderError, isAbortError } from '../providers/errors.js';
import { assertWithinCostBudget } from '../optimizer/cost.js';
import { Tokenizer } from '../utils/tokenizer.js';
import { generateRequestId } from '../utils/ids.js';
import {
  EmbeddingCapabilityError,
  EmbeddingError,
  EmbeddingProviderError,
  EmbeddingProviderNotFoundError,
  EmbeddingProviderResponseError,
  EmbeddingValidationError,
} from './errors.js';
import {
  estimateEmbeddingCost,
  priceEmbeddingUsage,
  resolveEmbeddingModel,
  resolveMaxBatchSize,
  type ResolvedEmbeddingModel,
} from './models.js';
import { createConfiguredEmbeddingProviders } from './register.js';

const DEFAULT_CONCURRENCY = 4;

interface EmbeddingRoute {
  providerName: string;
  provider: EmbeddingsProvider;
  resolved: ResolvedEmbeddingModel;
  reason: string;
}

interface ManagerRuntime {
  metrics?: MetricsCollector;
  auditLogger?: AuditLogger;
  rateLimiter?: RateLimiter;
  /** Provider credentials used to auto-register adapters. */
  providers?: ProvidersConfig;
}

/**
 * Provider-neutral embeddings with routing, caching, batching, budget, retry, audit, and metrics.
 *
 * The operation family behind `ai.embed()`. It is usable standalone, and when it is reached through
 * `NexusAI` it shares that runtime's metrics collector, audit log, and rate limiter, so embedding
 * spend appears alongside completion spend instead of being invisible.
 */
export class EmbeddingManager {
  private readonly providers = new Map<string, EmbeddingsProvider>();
  private readonly tokenizer = new Tokenizer();
  private readonly metrics: MetricsCollector;
  private readonly auditLogger: AuditLogger;
  private readonly rateLimiter: RateLimiter;
  private readonly localCache?: MemoryCache<number[]>;
  private autoRegistered = false;

  constructor(
    private readonly config: EmbeddingConfig = {},
    private readonly runtime: ManagerRuntime = {},
  ) {
    this.metrics = runtime.metrics || new MetricsCollector();
    this.auditLogger = runtime.auditLogger || new AuditLogger();
    this.rateLimiter = runtime.rateLimiter || new RateLimiter();

    for (const [name, provider] of Object.entries(config.providers ?? {})) {
      this.registerEmbeddingProvider(name, provider);
    }

    // Only the exact-match cache is built here; a disabled cache costs nothing.
    if (config.cache?.enabled && !config.cache.adapter) {
      this.localCache = new MemoryCache<number[]>(config.cache.maxEntries || 2000);
    }
  }

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

  hasEmbeddingProvider(name: string): boolean {
    this.ensureAutoRegistered();
    return this.providers.has(name);
  }

  listEmbeddingProviders(): string[] {
    this.ensureAutoRegistered();
    return [...this.providers.keys()];
  }

  /**
   * Embeds one text or a batch.
   *
   * The single-string form returns one vector at `vectors[0]`; a batch returns them in input order
   * regardless of how many provider calls the split required.
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const inputs = normalizeInput(request.input);
    const requestId = request.requestId?.trim() || generateRequestId();
    const startedAt = Date.now();
    const route = this.resolveRoute(request);
    const model = route.resolved.model;

    try {
      await this.metrics.recordRequest({ model, operation: 'embed' });
      if (this.config.rateLimit?.store) {
        await this.rateLimiter.checkAsync({ model, userId: request.userId }, this.config.rateLimit);
      } else {
        this.rateLimiter.check({ model, userId: request.userId }, this.config.rateLimit);
      }
      await this.logAudit('request', { requestId, request, model, provider: route.providerName });

      assertRequestedOptions(route, request);
      this.enforceCostBudget(inputs, model);

      const cacheEnabled = request.cache ?? this.config.cache?.enabled ?? false;
      const cacheContext = cacheEnabled ? this.cacheContext(route, request) : undefined;
      const vectors = new Array<number[] | undefined>(inputs.length);
      let cachedInputs = 0;

      if (cacheContext) {
        for (let index = 0; index < inputs.length; index += 1) {
          const hit = await this.readCache(cacheContext, inputs[index] as string);
          if (hit) {
            vectors[index] = hit;
            cachedInputs += 1;
          }
        }
      }

      const pending: number[] = [];
      for (let index = 0; index < inputs.length; index += 1) {
        if (!vectors[index]) pending.push(index);
      }

      // Identical texts in one request are answered by a single provider call. Repeated inputs are
      // common in RAG ingestion, and every duplicate avoided is a token not billed.
      const deduplicate = this.config.deduplicate !== false;
      const uniqueTexts: string[] = [];
      const uniqueIndex = new Map<string, number>();
      const pendingToUnique: number[] = [];
      for (const index of pending) {
        const text = inputs[index] as string;
        if (deduplicate) {
          const existing = uniqueIndex.get(text);
          if (existing !== undefined) {
            pendingToUnique.push(existing);
            continue;
          }
          uniqueIndex.set(text, uniqueTexts.length);
        }
        pendingToUnique.push(uniqueTexts.length);
        uniqueTexts.push(text);
      }
      const deduplicatedInputs = pending.length - uniqueTexts.length;

      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      let batches = 0;
      let retries = 0;
      let raw: unknown;
      let truncated = false;
      let providerUsed = route.providerName;
      let modelUsed = model;

      if (uniqueTexts.length > 0) {
        const batchSize = resolveMaxBatchSize(route.resolved.capabilities, route.provider);
        const chunks = chunkInputs(uniqueTexts, batchSize);
        batches = chunks.length;

        const results = await this.runBatches(chunks, route, request, requestId, (used) => {
          retries += used;
        });

        let cursor = 0;
        for (const result of results) {
          if (result.vectors.length !== (chunks[cursor]?.length ?? 0)) {
            throw new EmbeddingProviderResponseError(
              route.providerName,
              `expected ${chunks[cursor]?.length ?? 0} vectors but received ${result.vectors.length}`,
            );
          }
          cursor += 1;
          if (result.truncated) truncated = true;
          if (result.model) modelUsed = result.model;
          if (result.raw !== undefined) raw = result.raw;
          usage = addUsage(usage, result.usage?.inputTokens, result.usage?.totalTokens);
        }

        const flatVectors = results.flatMap((result) => result.vectors);
        // Providers that report no usage still have to be priced, so tokens are estimated locally
        // rather than reported as zero.
        if (usage.inputTokens === 0) {
          usage = estimateUsage(uniqueTexts, this.tokenizer);
        }

        const finished = flatVectors.map((values) => this.postProcess(values, route, request));
        for (let position = 0; position < pending.length; position += 1) {
          const index = pending[position] as number;
          const vector = finished[pendingToUnique[position] as number];
          if (!vector) {
            throw new EmbeddingProviderResponseError(
              route.providerName,
              'the provider returned fewer vectors than inputs',
            );
          }
          vectors[index] = vector;
        }

        if (cacheContext) {
          for (let position = 0; position < uniqueTexts.length; position += 1) {
            const vector = finished[position];
            if (vector) await this.writeCache(cacheContext, uniqueTexts[position] as string, vector);
          }
        }

        providerUsed = route.provider.info.name?.trim() || route.providerName;
      }

      const embeddings: Embedding[] = vectors.map((values, index) => {
        if (!values) {
          throw new EmbeddingProviderResponseError(route.providerName, `no vector was produced for input ${index}`);
        }
        return {
          index,
          values,
          dimensions: values.length,
          truncated: truncated || undefined,
        };
      });

      const meta: EmbeddingMeta = {
        requestId,
        providerUsed,
        modelUsed,
        dimensions: embeddings[0]?.dimensions ?? 0,
        count: embeddings.length,
        latencyMs: Date.now() - startedAt,
        batches,
        usage,
        cost: priceEmbeddingUsage(model, usage, this.config.models),
        cacheHit: cachedInputs === inputs.length && inputs.length > 0,
        cachedInputs: cachedInputs || undefined,
        deduplicatedInputs: deduplicatedInputs || undefined,
        retries: retries || undefined,
        routingDecision: { reason: route.reason, fallbacksConsidered: this.config.fallback?.length ?? 0 },
      };

      await this.logAudit('response', { requestId, meta });
      await this.metrics.recordResponse(
        { provider: providerUsed, model: modelUsed, operation: 'embed' },
        meta.latencyMs,
        meta.cost.amount,
      );

      return {
        embeddings,
        vectors: embeddings.map((embedding) => embedding.values),
        meta,
        raw,
      };
    } catch (error) {
      await this.metrics.recordError({ model, operation: 'embed' });
      throw error;
    }
  }

  /** Embeds one text and returns the vector alone, for callers that never need the metadata. */
  async embedOne(text: string, options: Omit<EmbeddingRequest, 'input'> = {}): Promise<number[]> {
    const response = await this.embed({ ...options, input: text });
    const vector = response.vectors[0];
    if (!vector) throw new EmbeddingProviderResponseError(response.meta.providerUsed, 'no vector was returned');
    return vector;
  }

  // ── Routing ──────────────────────────────────────────────────────

  private resolveRoute(request: EmbeddingRequest): EmbeddingRoute {
    this.ensureAutoRegistered();
    if (this.providers.size === 0) throw new EmbeddingProviderNotFoundError();

    const requestedModel = request.model || this.config.defaultModel;
    const resolved = resolveEmbeddingModel(requestedModel || 'auto', this.config.models);

    const preferred = request.provider?.trim() || this.config.defaultProvider;
    if (preferred) {
      const provider = this.providers.get(preferred);
      if (!provider) throw new EmbeddingProviderNotFoundError(preferred);
      return {
        providerName: preferred,
        provider,
        resolved: this.withProviderDefaultModel(resolved, provider, requestedModel),
        reason: request.provider ? 'requested provider' : 'default provider',
      };
    }

    // A model names its own provider, so an explicit model routes without further configuration.
    if (resolved.providerName) {
      const provider = this.providers.get(resolved.providerName);
      if (provider) {
        return { providerName: resolved.providerName, provider, resolved, reason: 'model registry' };
      }
      // The model's own provider is not registered. Only fall through when the model was inferred
      // rather than named, so an explicit model never silently runs on a different provider.
      if (requestedModel && request.model) {
        throw new EmbeddingProviderNotFoundError(resolved.providerName);
      }
    }

    const declared = [...this.providers.entries()].find(([, provider]) =>
      provider.info.capabilities.models?.includes(resolved.model),
    );
    if (declared) {
      return { providerName: declared[0], provider: declared[1], resolved, reason: 'provider declares model' };
    }

    const [name, provider] = [...this.providers.entries()][0] as [string, EmbeddingsProvider];
    return {
      providerName: name,
      provider,
      resolved: this.withProviderDefaultModel(resolved, provider, requestedModel),
      reason: 'only registered provider',
    };
  }

  /**
   * Uses the adapter's own default model when the request named none.
   *
   * Without this a caller with a single non-OpenAI adapter would be routed to the `auto` alias
   * target, which that adapter does not serve.
   */
  private withProviderDefaultModel(
    resolved: ResolvedEmbeddingModel,
    provider: EmbeddingsProvider,
    requestedModel?: string,
  ): ResolvedEmbeddingModel {
    if (requestedModel) return resolved;
    const fallbackModel = provider.info.defaultModel;
    if (!fallbackModel) return resolved;
    return resolveEmbeddingModel(fallbackModel, this.config.models);
  }

  private ensureAutoRegistered(): void {
    if (this.autoRegistered) return;
    this.autoRegistered = true;
    if (this.config.autoRegisterProviders === false || !this.runtime.providers) return;

    for (const [name, provider] of createConfiguredEmbeddingProviders(this.runtime.providers)) {
      if (!this.providers.has(name)) this.providers.set(name, provider);
    }
  }

  // ── Provider calls ───────────────────────────────────────────────

  private async runBatches(
    chunks: string[][],
    route: EmbeddingRoute,
    request: EmbeddingRequest,
    requestId: string,
    onRetries: (count: number) => void,
  ): Promise<EmbeddingProviderResult[]> {
    const results = new Array<EmbeddingProviderResult>(chunks.length);
    const concurrency = Math.max(1, request.concurrency ?? this.config.concurrency ?? DEFAULT_CONCURRENCY);
    let next = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= chunks.length) return;
        results[index] = await this.callWithRetry(
          chunks[index] as string[],
          index,
          route,
          request,
          requestId,
          onRetries,
        );
      }
    };

    // One chunk is the common case; spawning a worker pool for it would only add scheduling work.
    if (chunks.length === 1) {
      results[0] = await this.callWithRetry(chunks[0] as string[], 0, route, request, requestId, onRetries);
      return results;
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
    return results;
  }

  private async callWithRetry(
    input: string[],
    batchIndex: number,
    route: EmbeddingRoute,
    request: EmbeddingRequest,
    requestId: string,
    onRetries: (count: number) => void,
  ): Promise<EmbeddingProviderResult> {
    const retry = mergeRetry(this.config.retry, request.retry);
    const attempts: Array<{ providerName: string; provider: EmbeddingsProvider; model: string }> = [
      { providerName: route.providerName, provider: route.provider, model: route.resolved.model },
    ];
    for (const fallback of this.config.fallback ?? []) {
      const providerName = fallback.provider || route.providerName;
      const provider = this.providers.get(providerName);
      if (provider) {
        attempts.push({ providerName, provider, model: fallback.model || route.resolved.model });
      }
    }

    const errors: string[] = [];
    let used = 0;

    for (const attempt of attempts) {
      for (let retryIndex = 0; retryIndex <= (retry.enabled ? retry.maxRetries : 0); retryIndex += 1) {
        try {
          const result = await this.callProvider(input, batchIndex, attempt, request, requestId, retryIndex + 1);
          if (used) onRetries(used);
          return result;
        } catch (error) {
          if (isAbortError(error)) throw error;
          used += 1;
          errors.push(`${attempt.providerName}/${attempt.model}: ${describe(error)}`);
          if (!retry.enabled || !isRetryable(error) || retryIndex >= retry.maxRetries) break;
          await delay(retryDelay(retry, retryIndex), request.signal);
        }
      }
    }

    onRetries(Math.max(0, used - 1));
    throw new EmbeddingProviderError(
      `All embedding attempts failed: ${errors.join(' | ')}`,
      route.providerName,
      errors,
    );
  }

  private async callProvider(
    input: string[],
    batchIndex: number,
    attempt: { providerName: string; provider: EmbeddingsProvider; model: string },
    request: EmbeddingRequest,
    requestId: string,
    attemptNumber: number,
  ): Promise<EmbeddingProviderResult> {
    const timeoutMs = request.timeoutMs ?? this.config.timeoutMs;
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) controller.abort(request.signal.reason);
    else request.signal?.addEventListener('abort', onExternalAbort, { once: true });

    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort(createTimeoutProviderError(attempt.providerName, attempt.model, timeoutMs));
          }, timeoutMs);

    const providerRequest: EmbeddingProviderRequest = {
      input,
      model: attempt.model,
      inputType: request.inputType,
      dimensions: request.dimensions,
      encodingFormat: request.encodingFormat,
      truncate: request.truncate,
      user: request.user,
      providerOptions: request.providerOptions,
    };
    const context: EmbeddingProviderCallContext = {
      requestId,
      signal: controller.signal,
      attempt: attemptNumber,
      batchIndex,
      deadline: timeoutMs === undefined ? undefined : Date.now() + timeoutMs,
      idempotencyKey: request.idempotencyKey,
    };

    try {
      const result = await attempt.provider.embed(providerRequest, context);
      if (!result || !Array.isArray(result.vectors)) {
        throw new EmbeddingProviderResponseError(attempt.providerName, 'embed() returned no vectors');
      }
      return result;
    } catch (error) {
      if (error instanceof EmbeddingError || error instanceof NexusProviderError) throw error;
      if (controller.signal.aborted && controller.signal.reason instanceof NexusProviderError) {
        throw controller.signal.reason;
      }
      // The cause's message is carried into the wrapper: the aggregate thrown after every attempt
      // fails is often all an operator sees, and "the call failed" alone does not explain why.
      throw new EmbeddingProviderError(
        `Embedding call failed for provider "${attempt.providerName}": ${describe(error)}`,
        attempt.providerName,
        error,
      );
    } finally {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  // ── Post-processing ──────────────────────────────────────────────

  private postProcess(values: number[], route: EmbeddingRoute, request: EmbeddingRequest): number[] {
    let vector = values;

    // A provider that ignores the dimension request is corrected locally, because a store expects
    // exactly the size that was asked for.
    const truncatedLocally = request.dimensions !== undefined && vector.length > request.dimensions;
    if (truncatedLocally) {
      vector = vector.slice(0, request.dimensions);
    }

    // Truncating a unit vector breaks its length, so a truncated vector is rescaled even when the
    // provider already returns normalized output.
    if (request.normalize && (truncatedLocally || !isAlreadyNormalized(route))) {
      vector = normalizeVector(vector);
    }

    return vector;
  }

  // ── Guards ───────────────────────────────────────────────────────

  private enforceCostBudget(inputs: string[], model: string): void {
    const budget = this.config.costBudget;
    if (!budget?.enabled || budget.maxEstimatedCost === undefined) return;

    let inputTokens = 0;
    for (const text of inputs) inputTokens += this.tokenizer.estimateTextTokens(text);
    const estimate = estimateEmbeddingCost({ model, inputTokens, config: this.config.models });

    if (budget.onExceeded === 'warn') {
      if (estimate.totalCost > budget.maxEstimatedCost) {
        console.warn(
          `[nexus-ai-pro] embedding cost ${estimate.formatted} exceeds maxEstimatedCost $${budget.maxEstimatedCost.toFixed(4)}`,
        );
      }
      return;
    }

    assertWithinCostBudget(estimate, budget.maxEstimatedCost);
  }

  // ── Cache ────────────────────────────────────────────────────────

  private cacheContext(route: EmbeddingRoute, request: EmbeddingRequest): Record<string, unknown> {
    return {
      provider: route.providerName,
      model: route.resolved.model,
      inputType: request.inputType,
      dimensions: request.dimensions,
      encodingFormat: request.encodingFormat,
      normalize: request.normalize,
      truncate: request.truncate,
    };
  }

  private async readCache(context: Record<string, unknown>, text: string): Promise<number[] | undefined> {
    const key = createCacheKey({ ...context, text });
    const adapter = this.config.cache?.adapter as CacheAdapter<number[]> | undefined;
    if (adapter) return (await adapter.get(key)) ?? undefined;
    return this.localCache?.get(key);
  }

  private async writeCache(context: Record<string, unknown>, text: string, vector: number[]): Promise<void> {
    const key = createCacheKey({ ...context, text });
    const ttlSeconds = this.config.cache?.ttlSeconds ?? 3600;
    const adapter = this.config.cache?.adapter as CacheAdapter<number[]> | undefined;
    if (adapter) {
      await adapter.set(key, vector, ttlSeconds);
      return;
    }
    this.localCache?.set(key, vector, ttlSeconds);
  }

  // ── Observability ────────────────────────────────────────────────

  private async logAudit(
    type: 'request' | 'response',
    payload: { requestId: string; request?: EmbeddingRequest; meta?: EmbeddingMeta; model?: string; provider?: string },
  ): Promise<void> {
    await this.auditLogger.log({
      type,
      requestId: payload.requestId,
      userId: payload.request?.userId,
      model: payload.model ?? payload.meta?.modelUsed,
      provider: payload.provider ?? payload.meta?.providerUsed,
      timestamp: new Date().toISOString(),
      metadata: payload.meta
        ? { operation: 'embed', count: payload.meta.count, cost: payload.meta.cost.amount }
        : { operation: 'embed', inputs: payload.request ? normalizeInput(payload.request.input).length : 0 },
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function normalizeInput(input: EmbeddingRequest['input']): string[] {
  if (typeof input === 'string') {
    if (!input) throw new EmbeddingValidationError('Embedding input must not be empty');
    return [input];
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new EmbeddingValidationError('Embedding input must be a string or a non-empty array of strings');
  }
  for (const text of input) {
    if (typeof text !== 'string' || !text) {
      throw new EmbeddingValidationError('Every embedding input must be a non-empty string');
    }
  }
  return [...input];
}

/**
 * Refuses a requested option the route cannot honor.
 *
 * Unlike a completion, where an ignored option changes only style, an ignored embedding option
 * changes the vector itself, and the damage shows up much later as unexplained retrieval quality
 * loss. Options the registry does not describe are still passed through, because an undeclared
 * capability means unknown rather than unsupported.
 */
function assertRequestedOptions(route: EmbeddingRoute, request: EmbeddingRequest): void {
  const model = route.resolved.capabilities;
  const provider = route.provider.info.capabilities;

  if (request.dimensions !== undefined) {
    if (!Number.isInteger(request.dimensions) || request.dimensions <= 0) {
      throw new EmbeddingValidationError('dimensions must be a positive integer');
    }
    const supported = model?.supportedDimensions;
    if (model && supported === undefined) {
      throw new EmbeddingCapabilityError(
        route.providerName,
        'dimensions',
        request.dimensions,
        `Embedding model "${route.resolved.model}" has a fixed size of ${model.dimensions} dimensions`,
      );
    }
    if (Array.isArray(supported) && !supported.includes(request.dimensions)) {
      throw new EmbeddingCapabilityError(
        route.providerName,
        'dimensions',
        request.dimensions,
        `Embedding model "${route.resolved.model}" accepts ${supported.join(', ')} dimensions`,
      );
    }
    if (supported === true && model && request.dimensions > model.dimensions) {
      throw new EmbeddingCapabilityError(
        route.providerName,
        'dimensions',
        request.dimensions,
        `Embedding model "${route.resolved.model}" produces at most ${model.dimensions} dimensions`,
      );
    }
    if (provider.dimensions === false) {
      throw new EmbeddingCapabilityError(route.providerName, 'dimensions', request.dimensions);
    }
    if (Array.isArray(provider.dimensions) && !provider.dimensions.includes(request.dimensions)) {
      throw new EmbeddingCapabilityError(route.providerName, 'dimensions', request.dimensions);
    }
  }

  if (request.inputType && provider.inputTypes && !provider.inputTypes.includes(request.inputType)) {
    throw new EmbeddingCapabilityError(route.providerName, 'inputType', request.inputType);
  }

  if (
    request.encodingFormat &&
    provider.encodingFormats &&
    !provider.encodingFormats.includes(request.encodingFormat)
  ) {
    throw new EmbeddingCapabilityError(route.providerName, 'encodingFormat', request.encodingFormat);
  }

  if (request.truncate && request.truncate !== 'none' && provider.truncate === false) {
    throw new EmbeddingCapabilityError(route.providerName, 'truncate', request.truncate);
  }
}

function chunkInputs(inputs: string[], size: number): string[][] {
  if (!Number.isFinite(size) || inputs.length <= size) return [inputs];
  const chunks: string[][] = [];
  for (let index = 0; index < inputs.length; index += size) {
    chunks.push(inputs.slice(index, index + size));
  }
  return chunks;
}

function addUsage(usage: TokenUsage, inputTokens?: number, totalTokens?: number): TokenUsage {
  const input = usage.inputTokens + (inputTokens ?? 0);
  return {
    inputTokens: input,
    outputTokens: 0,
    totalTokens: usage.totalTokens + (totalTokens ?? inputTokens ?? 0),
  };
}

function estimateUsage(inputs: string[], tokenizer: Tokenizer): TokenUsage {
  let inputTokens = 0;
  for (const text of inputs) inputTokens += tokenizer.estimateTextTokens(text);
  return { inputTokens, outputTokens: 0, totalTokens: inputTokens };
}

function isAlreadyNormalized(route: EmbeddingRoute): boolean {
  return route.resolved.capabilities?.normalized === true || route.provider.info.capabilities.normalized === true;
}

function normalizeVector(values: number[]): number[] {
  let sum = 0;
  for (const value of values) sum += value * value;
  if (sum === 0) return values;
  const magnitude = Math.sqrt(sum);
  const normalized = new Array<number>(values.length);
  for (let index = 0; index < values.length; index += 1) {
    normalized[index] = (values[index] as number) / magnitude;
  }
  return normalized;
}

function mergeRetry(
  global?: RetryConfig,
  request?: RetryConfig,
): Required<Pick<RetryConfig, 'enabled' | 'maxRetries' | 'baseDelayMs' | 'maxDelayMs' | 'backoff'>> {
  return {
    enabled: request?.enabled ?? global?.enabled ?? false,
    maxRetries: request?.maxRetries ?? global?.maxRetries ?? 1,
    baseDelayMs: request?.baseDelayMs ?? global?.baseDelayMs ?? 250,
    maxDelayMs: request?.maxDelayMs ?? global?.maxDelayMs ?? 2000,
    backoff: request?.backoff ?? global?.backoff ?? 'exponential',
  };
}

function retryDelay(
  retry: { baseDelayMs: number; maxDelayMs: number; backoff: 'fixed' | 'exponential' },
  retryIndex: number,
): number {
  const delayMs = retry.backoff === 'fixed' ? retry.baseDelayMs : retry.baseDelayMs * 2 ** retryIndex;
  return Math.min(delayMs, retry.maxDelayMs);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryable(error: unknown): boolean {
  if (error instanceof NexusProviderError) return error.retryable;
  const cause = error instanceof EmbeddingProviderError ? error.cause : undefined;
  if (cause instanceof NexusProviderError) return cause.retryable;
  // An unclassified transport failure is worth one more try; a validation error is not.
  return !(error instanceof EmbeddingValidationError) && !(error instanceof EmbeddingCapabilityError);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
