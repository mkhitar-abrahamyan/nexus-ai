import type { NexusAIConfig } from '../types/config.js';
import type { CompletionRequest } from '../types/messages.js';
import type { NexusPlan } from '../types/planning.js';
import type { NexusResponse, NexusStream } from '../types/response.js';
import type { AgentConfig, AgentResult } from '../types/agent.js';
import type { PipelineStep } from '../pipeline/types.js';
import { BaseProvider } from '../providers/base.js';
import { OpenAIProvider } from '../providers/openai.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GoogleProvider } from '../providers/google.js';
import { OllamaProvider } from '../providers/ollama.js';
import { OpenRouterProvider } from '../providers/openrouter.js';
import { GroqProvider } from '../providers/groq.js';
import { MistralProvider } from '../providers/mistral.js';
import { CohereProvider } from '../providers/cohere.js';
import { Router, FailoverExecutor } from '../router/index.js';
import { Logger } from '../utils/logger.js';
import { SecurityPipeline } from '../security/index.js';
import { TokenOptimizer } from '../optimizer/index.js';
import { AgentLoop } from '../agent/loop.js';
import { resolveModel } from '../models/registry.js';
import { createCacheKey, MemoryCache } from '../cache/memory-cache.js';
import { applyResponseFormat, withResponseFormat } from './response-format.js';
import { protectStreamOutput } from './secure-stream.js';
import { AuditLogger } from '../ops/audit-logger.js';
import { RateLimiter } from '../ops/rate-limiter.js';
import {
  completeVerified,
  type VerificationOptions,
} from '../hallucination/verification.js';
import {
  completeWithSelfConsistency,
  type SelfConsistencyOptions,
} from '../hallucination/consistency.js';
import { assertWithinCostBudget, estimateCost } from '../optimizer/cost.js';
import { PipelineRunner, createPipelineContext } from '../pipeline/pipeline.js';
import { MetricsCollector } from '../ops/metrics.js';
import { ProviderHealthMonitor } from '../ops/health.js';
import { SemanticCache } from '../cache/semantic-cache.js';
import { runBatch, type BatchOptions, type BatchItemResult } from '../jobs/batch.js';
import { JobQueue, type QueueOptions } from '../jobs/queue.js';
import { EvalRunner, type EvalCase, type EvalRunResult } from '../evals/runner.js';
import { summarizeVerifyFormat, type SummarizeVerifyFormatOptions, type WorkflowResult } from '../workflow/chains.js';

export class NexusAI {
  private config: NexusAIConfig;
  private providers = new Map<string, BaseProvider>();
  private router = new Router();
  private failover = new FailoverExecutor();
  private logger: Logger;
  private security: SecurityPipeline;
  private optimizer: TokenOptimizer;
  private cache: MemoryCache<NexusResponse>;
  private auditLogger: AuditLogger;
  private rateLimiter = new RateLimiter();
  private pipeline: PipelineRunner;
  private metrics: MetricsCollector;
  private health: ProviderHealthMonitor;
  private semanticCache: SemanticCache;

  constructor(config: NexusAIConfig) {
    this.config = {
      routing: { mode: 'auto', strategy: 'quality' },
      timeout: 60000,
      ...config,
    };
    this.logger = new Logger(this.config.debug);
    this.security = new SecurityPipeline(this.config.security || 'standard');
    this.optimizer = new TokenOptimizer(this.config.tokenOptimizer || {});
    this.cache = new MemoryCache<NexusResponse>(this.config.cache?.maxEntries || 500);
    this.auditLogger = new AuditLogger(this.config.auditLog);
    this.pipeline = new PipelineRunner(this.config.pipeline || {});
    this.metrics = new MetricsCollector(this.config.metrics || {});
    this.health = new ProviderHealthMonitor(this.config.health || {});
    this.semanticCache = new SemanticCache({
      enabled: this.config.cache?.enabled && (this.config.cache.strategy === 'semantic' || this.config.cache.strategy === 'hybrid'),
      maxEntries: this.config.cache?.maxEntries,
      ttlSeconds: this.config.cache?.ttlSeconds,
      ...this.config.cache?.semantic,
    });
    this.registerConfiguredProviders();
  }

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    let context = createPipelineContext(request);

    try {
      await this.metrics.recordRequest({ model: request.model });
      this.rateLimiter.check(request, this.config.rateLimit);

      if (this.isAuditLogEnabled()) {
        await this.pipeline.trace(context, 'auditLog', () => this.auditLogger.log({
          type: 'request',
          userId: request.userId,
          model: request.model,
          timestamp: new Date().toISOString(),
          metadata: this.config.auditLog?.includeInput ? { request } : undefined,
        }));
      }

      context = await this.pipeline.runHook('beforeInput', context);
      context = await this.pipeline.runCustomSteps(context);

      if (this.hasResponseFormat(context.request)) {
        const formattedRequest = await this.pipeline.trace(context, 'responseFormat', () => {
          return withResponseFormat(context.request, this.config.responseFormat);
        });
        context.request = formattedRequest;
      }

      const optimizationResult = this.isTokenOptimizerEnabled()
        ? await this.pipeline.trace(context, 'tokenOptimization', () => {
            return this.optimizer.optimize(context.request);
          })
        : this.optimizer.optimize(context.request);
      context.optimization = optimizationResult;
      context.request = optimizationResult.value;

      if (this.isSecurityEnabled()) {
        const securityResult = await this.pipeline.trace(context, 'inputSecurity', () => {
          return this.security.protectInput(context.request);
        });
        context.request = securityResult.value;
        context.securityFindings.push(...securityResult.findings);
        context.guardrailsApplied.push(...securityResult.guardrailsApplied);

        try {
          this.security.assertSafe(securityResult);
        } catch (error) {
          if (this.isAuditLogEnabled()) {
            await this.auditLogger.log({
              type: 'blocked',
              userId: request.userId,
              model: request.model,
              timestamp: new Date().toISOString(),
              metadata: { findings: securityResult.findings },
            });
          }
          throw error;
        }
      }

      context = await this.pipeline.runHook('afterSecurity', context);

      const decision = await this.pipeline.trace(context, 'routing', () => {
        return this.router.route(context.request, this.config, this.providers, this.health.snapshot());
      });
      context.route = decision;
      this.logger.info('route decision', decision as unknown as Record<string, unknown>);
      context.request = { ...context.request, model: resolveModel(decision.model, this.config).model };

      if (this.isCostBudgetEnabled(context.request)) {
        await this.pipeline.trace(context, 'costBudget', () => {
          this.enforceCostBudget(context.request);
        });
      }

      const responseFormat = context.request.responseFormat || this.config.responseFormat;
      const cacheKey = createCacheKey({ request: context.request, responseFormat });
      if (this.isCacheEnabled()) {
        const cached = await this.pipeline.trace(context, 'cacheLookup', () => this.getCachedResponse(cacheKey, context.request));
        if (cached) {
          const cachedResponse = this.attachTrace({
            ...cached,
            meta: { ...cached.meta, cacheHit: true },
          }, this.pipeline.finish(context));
          return cachedResponse;
        }
      }

      context = await this.pipeline.runHook('beforeProvider', context);

      const response = await this.pipeline.trace(context, 'providerCall', () => {
        return this.failover.complete(context.request, decision, this.providers, {
          timeoutMs: this.config.timeout,
          retry: this.config.retry,
          onAttemptSuccess: (providerName, latencyMs) => this.health.recordSuccess(providerName, latencyMs),
          onAttemptFailure: (providerName, error) => this.health.recordFailure(providerName, error),
        });
      });
      context.response = response;
      context = await this.pipeline.runHook('afterProvider', context);

      context.response!.meta.guardrailsApplied.push(...context.guardrailsApplied);
      context.response!.meta.tokensSaved += optimizationResult.usage.savedTokens;
      context.response!.meta.routingDecision = {
        reason: decision.reason,
        fallbacksConsidered: decision.fallbacks.length,
      };

      if (this.isSecurityEnabled()) {
        const outputResult = await this.pipeline.trace(context, 'outputSecurity', () => {
          return this.security.protectOutput(context.response!);
        });
        context.response = outputResult.value;
      }

      if (responseFormat && responseFormat.type !== 'text') {
        const formattedResponse = await this.pipeline.trace(context, 'responseValidation', () => {
          return applyResponseFormat(context.response!, responseFormat);
        });
        context.response = formattedResponse;
      }

      if (this.isCacheEnabled()) {
        await this.pipeline.trace(context, 'cacheWrite', () => this.setCachedResponse(cacheKey, context.request, context.response!));
      }

      context = await this.pipeline.runHook('beforeReturn', context);
      const finalContext = this.pipeline.finish(context);
      const finalResponse = this.attachTrace(context.response!, finalContext);

      if (this.isAuditLogEnabled()) {
        await this.pipeline.trace(finalContext, 'auditLog', () => this.auditLogger.log({
          type: 'response',
          requestId: finalResponse.meta.requestId,
          userId: request.userId,
          model: finalResponse.meta.modelUsed,
          provider: finalResponse.meta.providerUsed,
          timestamp: new Date().toISOString(),
          metadata: this.config.auditLog?.includeOutput ? { response: finalResponse } : undefined,
        }));
      }

      await this.metrics.recordResponse({
        provider: finalResponse.meta.providerUsed,
        model: finalResponse.meta.modelUsed,
      }, finalResponse.meta.latencyMs, Number(finalResponse.meta.estimatedCost.replace('$', '')));
      for (const step of finalResponse.meta.pipeline?.steps || []) {
        await this.metrics.recordStep(step);
      }

      return finalResponse;
    } catch (error) {
      await this.metrics.recordError({ model: request.model });
      throw error;
    }
  }

  async completeVerified(request: CompletionRequest, options: VerificationOptions): Promise<NexusResponse> {
    return completeVerified(this, request, options);
  }

  async completeConsistent(request: CompletionRequest, options: SelfConsistencyOptions = {}): Promise<NexusResponse> {
    return completeWithSelfConsistency(this, request, options);
  }

  plan(request: CompletionRequest): NexusPlan {
    const formattedRequest = this.hasResponseFormat(request)
      ? withResponseFormat(request, this.config.responseFormat)
      : request;
    const optimizationResult = this.optimizer.optimize(formattedRequest);
    const securityResult = this.isSecurityEnabled()
      ? this.security.protectInput(optimizationResult.value)
      : { ok: true, value: optimizationResult.value, findings: [], guardrailsApplied: [] };
    const decision = this.router.route(securityResult.value, this.config, this.providers, this.health.snapshot());
    const resolved = resolveModel(decision.model, this.config);
    const outputTokens = this.estimatedOutputTokens(securityResult.value);
    const cost = estimateCost({
      model: resolved.model,
      inputTokens: optimizationResult.usage.afterTokens,
      outputTokens,
      config: this.config,
    });
    const maxContextTokens = resolved.capabilities?.maxContextTokens;
    const warnings = [
      ...optimizationResult.warnings,
      ...securityResult.findings.map((finding) => finding.message),
    ];

    if (maxContextTokens && optimizationResult.usage.afterTokens + outputTokens > maxContextTokens) {
      warnings.push(`Estimated tokens exceed ${resolved.model} context window`);
    }

    const maxEstimatedCost = request.maxEstimatedCost ?? this.config.costBudget?.maxEstimatedCost;
    if (maxEstimatedCost !== undefined && cost.totalCost > maxEstimatedCost) {
      warnings.push(`Estimated cost ${cost.formatted} exceeds maxEstimatedCost $${maxEstimatedCost.toFixed(4)}`);
    }

    return {
      requestModel: request.model,
      providerName: decision.providerName,
      model: resolved.model,
      route: decision,
      tokenUsage: optimizationResult.usage,
      estimatedCost: cost,
      maxContextTokens,
      fitsContext: maxContextTokens ? optimizationResult.usage.afterTokens + outputTokens <= maxContextTokens : true,
      cacheEligible: Boolean(this.config.cache?.enabled),
      wouldBlock: !securityResult.ok,
      securityFindings: securityResult.findings,
      warnings,
      guardrailsApplied: securityResult.guardrailsApplied,
    };
  }

  stream(request: CompletionRequest): NexusStream {
    this.rateLimiter.check(request, this.config.rateLimit);
    const formattedRequest = this.hasResponseFormat(request)
      ? withResponseFormat(request, this.config.responseFormat)
      : request;
    const optimizationResult = this.optimizer.optimize(formattedRequest);
    const securityResult = this.isSecurityEnabled()
      ? this.security.protectInput(optimizationResult.value)
      : { ok: true, value: optimizationResult.value, findings: [], guardrailsApplied: [] };
    if (this.isSecurityEnabled()) this.security.assertSafe(securityResult);

    const decision = this.router.route(securityResult.value, this.config, this.providers, this.health.snapshot());
    this.logger.info('stream route decision', {
      ...(decision as unknown as Record<string, unknown>),
      tokensSaved: optimizationResult.usage.savedTokens,
    });
    const routedRequest = { ...securityResult.value, model: resolveModel(decision.model, this.config).model };
    const stream = this.failover.stream(routedRequest, decision, this.providers, {
      timeoutMs: this.config.timeout,
      retry: this.config.retry,
      onAttemptSuccess: (providerName, latencyMs) => this.health.recordSuccess(providerName, latencyMs),
      onAttemptFailure: (providerName, error) => this.health.recordFailure(providerName, error),
    });
    return this.isSecurityEnabled() ? protectStreamOutput(stream, this.security) : stream;
  }

  async agent(config: AgentConfig): Promise<AgentResult> {
    const loop = new AgentLoop(this);
    return loop.run(config);
  }

  registerProvider(name: string, provider: BaseProvider): this {
    this.providers.set(name, provider);
    return this;
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  use(step: PipelineStep): this {
    this.pipeline.use(step);
    return this;
  }

  async batchComplete(
    requests: CompletionRequest[],
    options: BatchOptions = {},
  ): Promise<Array<BatchItemResult<NexusResponse>>> {
    return runBatch(requests, (item) => this.complete(item), options);
  }

  createQueue(options: QueueOptions = {}): JobQueue<CompletionRequest, NexusResponse> {
    return new JobQueue<CompletionRequest, NexusResponse>((payload) => this.complete(payload), options);
  }

  runEvals(cases: EvalCase<NexusResponse>[]): Promise<EvalRunResult<NexusResponse>> {
    return new EvalRunner<NexusResponse>(this).run(cases);
  }

  summarizeVerifyFormat(options: SummarizeVerifyFormatOptions): Promise<WorkflowResult> {
    return summarizeVerifyFormat(this, options);
  }

  getProviderHealth() {
    return this.health.snapshot();
  }

  async checkProviders(): Promise<Array<{ providerName: string; ok: boolean; error?: string }>> {
    const results: Array<{ providerName: string; ok: boolean; error?: string }> = [];
    for (const [providerName, provider] of this.providers) {
      const started = Date.now();
      try {
        const ok = await provider.healthCheck();
        if (ok) this.health.recordSuccess(providerName, Date.now() - started);
        else this.health.recordFailure(providerName, new Error('Health check returned false'));
        results.push({ providerName, ok });
      } catch (error) {
        this.health.recordFailure(providerName, error);
        results.push({
          providerName,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  getMetricsSnapshot(): Record<string, unknown> {
    return this.metrics.snapshot();
  }

  getPrometheusMetrics(): string {
    return this.metrics.toPrometheus();
  }

  clearCache(): void {
    this.cache.clear();
    this.semanticCache.clear();
  }

  clearExpiredCache(): number {
    return this.cache.clearExpired();
  }

  getCacheStats(): { size: number; maxEntries: number; expiredEntries: number } {
    return this.cache.stats();
  }

  private isAuditLogEnabled(): boolean {
    return this.config.auditLog?.enabled === true;
  }

  private isCacheEnabled(): boolean {
    return this.config.cache?.enabled === true;
  }

  private isCostBudgetEnabled(request: CompletionRequest): boolean {
    if (request.maxEstimatedCost !== undefined) return true;
    if (this.config.costBudget?.enabled === false) return false;
    return this.config.costBudget?.enabled === true || this.config.costBudget?.maxEstimatedCost !== undefined;
  }

  private isSecurityEnabled(): boolean {
    const security = this.config.security;
    if (security === 'off') return false;
    if (typeof security === 'object' && security.level === 'off') return false;
    return true;
  }

  private isTokenOptimizerEnabled(): boolean {
    return this.config.tokenOptimizer?.enabled !== false;
  }

  private hasResponseFormat(request: CompletionRequest): boolean {
    const responseFormat = request.responseFormat || this.config.responseFormat;
    return Boolean(responseFormat && responseFormat.type !== 'text');
  }

  private registerConfiguredProviders(): void {
    const providers = this.config.providers;

    if (providers.openai) {
      this.providers.set('openai', new OpenAIProvider(providers.openai));
    }

    if (providers.anthropic) {
      this.providers.set('anthropic', new AnthropicProvider(providers.anthropic));
    }

    if (providers.google) {
      this.providers.set('google', new GoogleProvider(providers.google));
    }

    if (providers.ollama) {
      this.providers.set('ollama', new OllamaProvider(providers.ollama));
    }

    if (providers.openrouter) {
      this.providers.set('openrouter', new OpenRouterProvider(providers.openrouter));
    }

    if (providers.groq) {
      this.providers.set('groq', new GroqProvider(providers.groq));
    }

    if (providers.mistral) {
      this.providers.set('mistral', new MistralProvider(providers.mistral));
    }

    if (providers.cohere) {
      this.providers.set('cohere', new CohereProvider(providers.cohere));
    }
  }

  private attachTrace(response: NexusResponse, context: ReturnType<PipelineRunner['finish']>): NexusResponse {
    if (this.config.pipeline?.trace === false) return response;
    if (this.config.pipeline?.includeTraceInResponse === false) return response;
    return {
      ...response,
      meta: {
        ...response.meta,
        pipeline: context.trace,
      },
    };
  }

  private async getCachedResponse(cacheKey: string, request: CompletionRequest): Promise<NexusResponse | undefined> {
    if (!this.config.cache?.enabled) return undefined;
    if (this.config.cache.strategy === 'semantic' || this.config.cache.strategy === 'hybrid') {
      const semantic = await this.semanticCache.get(request);
      if (semantic) return semantic;
    }

    if (this.config.cache.strategy === 'semantic') return undefined;
    if (this.config.cache.adapter) {
      return await this.config.cache.adapter.get(cacheKey) as NexusResponse | undefined;
    }
    return this.cache.get(cacheKey);
  }

  private async setCachedResponse(cacheKey: string, request: CompletionRequest, response: NexusResponse): Promise<void> {
    if (!this.config.cache?.enabled) return;
    const ttl = this.config.cache.ttlSeconds || 300;

    if (this.config.cache.strategy === 'semantic' || this.config.cache.strategy === 'hybrid') {
      await this.semanticCache.set(cacheKey, request, response);
    }

    if (this.config.cache.strategy === 'semantic') return;
    if (this.config.cache.adapter) {
      await this.config.cache.adapter.set(cacheKey, response, ttl);
      return;
    }
    this.cache.set(cacheKey, response, ttl);
  }

  private enforceCostBudget(request: CompletionRequest): void {
    const maxEstimatedCost = request.maxEstimatedCost ?? this.config.costBudget?.maxEstimatedCost;
    if (maxEstimatedCost === undefined) return;

    const estimate = estimateCost({
      model: request.model,
      inputTokens: this.optimizer.optimize(request).usage.afterTokens,
      outputTokens: this.estimatedOutputTokens(request),
      config: this.config,
    });

    try {
      assertWithinCostBudget(estimate, maxEstimatedCost);
    } catch (error) {
      if (this.config.costBudget?.onExceeded === 'warn') {
        this.logger.warn(error instanceof Error ? error.message : String(error));
        return;
      }
      throw error;
    }
  }

  private estimatedOutputTokens(request: CompletionRequest): number {
    return request.estimatedOutputTokens
      ?? this.config.costBudget?.estimatedOutputTokens
      ?? request.maxTokens
      ?? 1000;
  }
}
