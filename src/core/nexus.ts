import type { NexusAIConfig } from '../types/config.js';
import type { CompletionRequest } from '../types/messages.js';
import type { ContextSummaryInput, ContextWindowResult } from '../types/context-window.js';
import type { NexusPlan } from '../types/planning.js';
import type { NexusResponse, NexusStream } from '../types/response.js';
import type { AgentConfig, AgentResult } from '../types/agent.js';
import type {
  SpeechRequest,
  SpeechResponse,
  TranscriptionRequest,
  TranscriptionResponse,
  VoiceProvider,
  VoiceSessionConfig,
  VoiceTurnRequest,
  VoiceTurnResponse,
} from '../types/voice.js';
import type { ImageProvider } from '../types/images.js';
import type { EmbeddingRequest, EmbeddingResponse, EmbeddingsProvider } from '../types/embeddings.js';
import type {
  CreateCallRequest,
  CreateCallResponse,
  EndCallRequest,
  GetCallRequest,
  ListPhoneNumbersRequest,
  TelephonyCallDetails,
  TelephonyMediaStreamEvent,
  TelephonyOutboundAudioMessage,
  TelephonyPhoneNumber,
  TelephonyProvider,
  TelephonyResponseRequest,
  TelephonyStatusCallback,
  TelephonyWebhookResponse,
  TelephonyWebhookValidationRequest,
  UpdatePhoneNumberRequest,
} from '../types/telephony.js';
import type { PipelineStep } from '../pipeline/types.js';
import type { BaseProvider } from '../providers/base.js';
import { OpenAIProvider } from '../providers/openai.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { GoogleProvider } from '../providers/google.js';
import { OllamaProvider } from '../providers/ollama.js';
import { OpenRouterProvider } from '../providers/openrouter.js';
import { GroqProvider } from '../providers/groq.js';
import { MistralProvider } from '../providers/mistral.js';
import { CohereProvider } from '../providers/cohere.js';
import { DeepSeekProvider } from '../providers/deepseek.js';
import { AzureOpenAIProvider } from '../providers/azure-openai.js';
import { LMStudioProvider } from '../providers/lmstudio.js';
import { LlamaCppProvider } from '../providers/llamacpp.js';
import { Router, FailoverExecutor } from '../router/index.js';
import { Logger } from '../utils/logger.js';
import { SecurityPipeline } from '../security/index.js';
import { ContextWindowManager } from '../context/index.js';
import { VoiceManager, type VoiceSession } from '../voice/index.js';
import { ImageManager } from '../images/manager.js';
import { EmbeddingManager } from '../embeddings/manager.js';
import { TelephonyManager } from '../telephony/index.js';
import { TokenOptimizer } from '../optimizer/index.js';
import { AgentLoop } from '../agent/loop.js';
import { resolveModel } from '../models/registry.js';
import { createCacheKey, MemoryCache } from '../cache/memory-cache.js';
import { applyResponseFormat, withResponseFormat } from './response-format.js';
import { protectStreamOutput } from './secure-stream.js';
import { AuditLogger } from '../ops/audit-logger.js';
import { RateLimiter } from '../ops/rate-limiter.js';
import { completeVerified, type VerificationOptions } from '../hallucination/verification.js';
import { completeWithSelfConsistency, type SelfConsistencyOptions } from '../hallucination/consistency.js';
import { assertWithinCostBudget, estimateCost } from '../optimizer/cost.js';
import { negotiateCompletionRequest } from '../capabilities/negotiate.js';
import { costAmount, ensureUsageAndCost } from './usage.js';
import { PipelineRunner, createPipelineContext } from '../pipeline/pipeline.js';
import { MetricsCollector } from '../ops/metrics.js';
import { ProviderHealthMonitor } from '../ops/health.js';
import { CircuitBreaker } from '../ops/circuit-breaker.js';
import { SemanticCache } from '../cache/semantic-cache.js';
import { runBatch, type BatchOptions, type BatchItemResult } from '../jobs/batch.js';
import { JobQueue, type QueueOptions } from '../jobs/queue.js';
import { EvalRunner, type EvalCase, type EvalRunResult } from '../evals/runner.js';
import { summarizeVerifyFormat, type SummarizeVerifyFormatOptions, type WorkflowResult } from '../workflow/chains.js';

/**
 * Main runtime facade for provider routing, security, optimization, evals, voice, jobs, and observability.
 *
 * Use `new NexusAI(config)` when you want full control, or `createNexus()` for the beginner shorthand.
 */
export class NexusAI {
  /** Provider-neutral image generation and editing operations. */
  readonly images: ImageManager;

  private config: NexusAIConfig;
  private embeddingManager?: EmbeddingManager;
  private providers = new Map<string, BaseProvider>();
  private router = new Router();
  private failover = new FailoverExecutor();
  private logger: Logger;
  private security: SecurityPipeline;
  private contextWindow: ContextWindowManager;
  private voiceManager: VoiceManager;
  private telephonyManager: TelephonyManager;
  private optimizer: TokenOptimizer;
  private cache: MemoryCache<NexusResponse>;
  private auditLogger: AuditLogger;
  private rateLimiter = new RateLimiter();
  private pipeline: PipelineRunner;
  private metrics: MetricsCollector;
  private health: ProviderHealthMonitor;
  private circuitBreaker: CircuitBreaker;
  private semanticCache: SemanticCache;

  /**
   * Creates a configured Nexus runtime.
   *
   * Provider SDKs are loaded lazily by each provider adapter, so unused providers do not add runtime work.
   */
  constructor(config: NexusAIConfig) {
    this.config = {
      routing: { mode: 'auto', strategy: 'quality' },
      timeout: 60000,
      ...config,
    };
    this.logger = new Logger(this.config.debug, this.config.logger);
    this.security = new SecurityPipeline(this.config.security || 'standard');
    this.contextWindow = new ContextWindowManager(this.config.contextWindow || {});
    this.auditLogger = new AuditLogger(this.config.auditLog);
    this.metrics = new MetricsCollector(this.config.metrics || {});
    // Built before the families so every one of them shares this runtime's collector, audit log,
    // and rate limiter rather than reporting into instances nobody can read.
    const familyRuntime = {
      metrics: this.metrics,
      auditLogger: this.auditLogger,
      rateLimiter: this.rateLimiter,
      rateLimit: this.config.rateLimit,
    };
    this.voiceManager = new VoiceManager(this.config.voice || {}, familyRuntime);
    this.images = new ImageManager(this.config.images || {}, familyRuntime);
    this.telephonyManager = new TelephonyManager(this.config.telephony || {}, familyRuntime);
    this.optimizer = new TokenOptimizer(this.config.tokenOptimizer || {});
    this.cache = new MemoryCache<NexusResponse>(this.config.cache?.maxEntries || 500);
    this.pipeline = new PipelineRunner(this.config.pipeline || {});
    this.health = new ProviderHealthMonitor(this.config.health || {});
    this.circuitBreaker = new CircuitBreaker(this.config.circuitBreaker || {});
    this.semanticCache = new SemanticCache({
      enabled:
        this.config.cache?.enabled &&
        (this.config.cache.strategy === 'semantic' || this.config.cache.strategy === 'hybrid'),
      maxEntries: this.config.cache?.maxEntries,
      ttlSeconds: this.config.cache?.ttlSeconds,
      ...this.config.cache?.semantic,
    });
    this.registerConfiguredProviders();
  }

  /**
   * Runs a completion through the full configured pipeline and returns one normalized response.
   */
  async complete(request: CompletionRequest): Promise<NexusResponse> {
    let context = createPipelineContext(request);

    try {
      await this.metrics.recordRequest({ model: request.model });
      // The synchronous path stays the default so a request without a distributed store pays no
      // extra microtask for the limiter.
      if (this.config.rateLimit?.store) await this.rateLimiter.checkAsync(request, this.config.rateLimit);
      else this.rateLimiter.check(request, this.config.rateLimit);

      if (this.isAuditLogEnabled()) {
        await this.pipeline.trace(context, 'auditLog', () =>
          this.auditLogger.log({
            type: 'request',
            userId: request.userId,
            model: request.model,
            timestamp: new Date().toISOString(),
            metadata: this.config.auditLog?.includeInput ? { request } : undefined,
          }),
        );
      }

      context = await this.pipeline.runHook('beforeInput', context);
      context = await this.pipeline.runCustomSteps(context);

      if (this.hasResponseFormat(context.request)) {
        const formattedRequest = await this.pipeline.trace(context, 'responseFormat', () => {
          return withResponseFormat(context.request, this.config.responseFormat);
        });
        context.request = formattedRequest;
      }

      if (this.isContextWindowEnabled()) {
        const contextWindowResult = await this.pipeline.trace(context, 'contextWindow', () => {
          return this.contextWindow.optimize(context.request, {
            summarizer: (input) => this.summarizeContext(input),
          });
        });
        context.contextWindow = contextWindowResult;
        context.request = contextWindowResult.value;
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
        return this.router.route(
          context.request,
          this.config,
          this.providers,
          this.health.snapshot(),
          this.circuitBreaker.openProviders(),
        );
      });
      context.route = decision;
      this.logger.info('route decision', decision as unknown as Record<string, unknown>);

      // Capabilities can only be checked once routing has chosen the concrete model. Negotiation is
      // synchronous and returns the same request object when there is nothing to change, so it is
      // run inline and only traced when it actually altered the request.
      const routedModel = resolveModel(decision.model, this.config);
      context.request = { ...context.request, model: routedModel.model };
      const negotiation = negotiateCompletionRequest(context.request, routedModel.capabilities, {
        policy: this.config.capabilities?.policy,
        provider: routedModel.providerName || undefined,
      });
      context.request = negotiation.value;
      if (negotiation.warnings.length) {
        context.metadata.capabilityWarnings = negotiation.warnings;
        await this.pipeline.trace(context, 'capabilityNegotiation', () => undefined, {
          warnings: negotiation.warnings.length,
        });
      }

      if (this.isCostBudgetEnabled(context.request)) {
        await this.pipeline.trace(context, 'costBudget', () => {
          this.enforceCostBudget(context.request);
        });
      }

      const responseFormat = context.request.responseFormat || this.config.responseFormat;
      const cacheKey = createCacheKey({ request: context.request, responseFormat });
      if (this.isCacheEnabled()) {
        const cached = await this.pipeline.trace(context, 'cacheLookup', () =>
          this.getCachedResponse(cacheKey, context.request),
        );
        if (cached) {
          let cachedResponse = this.attachTrace(
            {
              ...cached,
              meta: { ...cached.meta, cacheHit: true },
            },
            this.pipeline.finish(context),
          );
          if (this.isSecurityEnabled()) {
            const outputResult = this.security.protectOutput(cachedResponse);
            context.securityFindings.push(...outputResult.findings);
            context.guardrailsApplied.push(...outputResult.guardrailsApplied);
            cachedResponse = outputResult.value;
            this.security.assertOutputSafe(outputResult);
          }
          return cachedResponse;
        }
      }

      context = await this.pipeline.runHook('beforeProvider', context);

      const response = await this.pipeline.trace(context, 'providerCall', () => {
        return this.failover.complete(context.request, decision, this.providers, {
          timeoutMs: this.config.timeout,
          retry: this.config.retry,
          onAttemptSuccess: (providerName, latencyMs) => {
            this.health.recordSuccess(providerName, latencyMs);
            this.circuitBreaker.recordSuccess(providerName);
          },
          onAttemptFailure: (providerName, error) => {
            this.health.recordFailure(providerName, error);
            this.circuitBreaker.recordFailure(providerName, error);
          },
        });
      });
      context.response = response;
      context = await this.pipeline.runHook('afterProvider', context);

      const providerResponse = context.response;
      if (!providerResponse) {
        throw new Error('The afterProvider pipeline hook removed the provider response.');
      }
      providerResponse.meta.guardrailsApplied.push(...context.guardrailsApplied);
      providerResponse.meta.tokensSaved += optimizationResult.usage.savedTokens;
      // A custom provider may not populate the structured fields, so they are filled in here and
      // every response carries the same usage and cost shape.
      ensureUsageAndCost(providerResponse.meta, this.config);
      if (negotiation.warnings.length) {
        providerResponse.meta.capabilityWarnings = negotiation.warnings;
      }
      if (context.contextWindow) {
        providerResponse.meta.contextWindow = context.contextWindow.usage;
      }
      providerResponse.meta.routingDecision = {
        reason: decision.reason,
        fallbacksConsidered: decision.fallbacks.length,
      };

      if (this.isSecurityEnabled()) {
        const outputResult = await this.pipeline.trace(context, 'outputSecurity', () => {
          return this.security.protectOutput(providerResponse);
        });
        context.securityFindings.push(...outputResult.findings);
        context.guardrailsApplied.push(...outputResult.guardrailsApplied);
        context.response = outputResult.value;
        this.security.assertOutputSafe(outputResult);
      }

      if (responseFormat && responseFormat.type !== 'text') {
        const responseToFormat = context.response;
        if (!responseToFormat) {
          throw new Error('Output security did not produce a response.');
        }
        const formattedResponse = await this.pipeline.trace(context, 'responseValidation', () => {
          return applyResponseFormat(responseToFormat, responseFormat);
        });
        context.response = formattedResponse;
      }

      if (this.isCacheEnabled()) {
        const responseToCache = context.response;
        if (!responseToCache) {
          throw new Error('Cannot cache an empty response.');
        }
        await this.pipeline.trace(context, 'cacheWrite', () =>
          this.setCachedResponse(cacheKey, context.request, responseToCache),
        );
      }

      context = await this.pipeline.runHook('beforeReturn', context);
      let responseToReturn = context.response;
      if (!responseToReturn) {
        throw new Error('The beforeReturn pipeline hook removed the response.');
      }

      // beforeReturn is deliberately allowed to replace the response, so it is
      // also the final trust boundary. Re-run output protection after the hook
      // to prevent custom middleware from reintroducing blocked or sensitive
      // content after the provider-output check above.
      if (this.isSecurityEnabled()) {
        const responseBeforeFinalSecurity = responseToReturn;
        const outputResult = await this.pipeline.trace(context, 'finalOutputSecurity', () => {
          return this.security.protectOutput(responseBeforeFinalSecurity);
        });
        context.securityFindings.push(...outputResult.findings);
        context.guardrailsApplied.push(...outputResult.guardrailsApplied);
        context.response = outputResult.value;
        responseToReturn = outputResult.value;
        this.security.assertOutputSafe(outputResult);
      }

      const finalContext = this.pipeline.finish(context);
      const finalResponse = this.attachTrace(responseToReturn, finalContext);

      if (this.isAuditLogEnabled()) {
        await this.pipeline.trace(finalContext, 'auditLog', () =>
          this.auditLogger.log({
            type: 'response',
            requestId: finalResponse.meta.requestId,
            userId: request.userId,
            model: finalResponse.meta.modelUsed,
            provider: finalResponse.meta.providerUsed,
            timestamp: new Date().toISOString(),
            metadata: this.config.auditLog?.includeOutput ? { response: finalResponse } : undefined,
          }),
        );
      }

      await this.metrics.recordResponse(
        {
          provider: finalResponse.meta.providerUsed,
          model: finalResponse.meta.modelUsed,
        },
        finalResponse.meta.latencyMs,
        costAmount(finalResponse.meta),
      );
      for (const step of finalResponse.meta.pipeline?.steps || []) {
        await this.metrics.recordStep(step);
      }

      return finalResponse;
    } catch (error) {
      await this.metrics.recordError({ model: request.model });
      throw error;
    }
  }

  /**
   * Completes a request and verifies generated claims against provided context.
   */
  async completeVerified(request: CompletionRequest, options: VerificationOptions): Promise<NexusResponse> {
    return completeVerified(this, request, options);
  }

  /**
   * Samples multiple completions and returns the most self-consistent answer.
   */
  async completeConsistent(request: CompletionRequest, options: SelfConsistencyOptions = {}): Promise<NexusResponse> {
    return completeWithSelfConsistency(this, request, options);
  }

  /**
   * Previews routing, token usage, context fit, cost, and guardrail findings without calling a provider.
   */
  plan(request: CompletionRequest): NexusPlan {
    const formattedRequest = this.hasResponseFormat(request)
      ? withResponseFormat(request, this.config.responseFormat)
      : request;
    const contextWindowResult = this.isContextWindowEnabled()
      ? this.contextWindow.preview(formattedRequest)
      : undefined;
    const requestForOptimization = contextWindowResult?.value || formattedRequest;
    const optimizationResult = this.optimizer.optimize(requestForOptimization);
    const securityResult = this.isSecurityEnabled()
      ? this.security.protectInput(optimizationResult.value)
      : { ok: true, value: optimizationResult.value, findings: [], guardrailsApplied: [] };
    const decision = this.router.route(
      securityResult.value,
      this.config,
      this.providers,
      this.health.snapshot(),
      this.circuitBreaker.openProviders(),
    );
    const resolved = resolveModel(decision.model, this.config);
    const outputTokens = this.estimatedOutputTokens(securityResult.value);
    const cost = estimateCost({
      model: resolved.model,
      inputTokens: optimizationResult.usage.afterTokens,
      outputTokens,
      config: this.config,
    });
    const maxContextTokens = resolved.capabilities?.maxContextTokens;
    // Planning is the "check before you spend" call, so it reports capability problems here rather
    // than letting them surface as a dropped option mid-request. It never throws: a plan under a
    // strict policy should still describe the request instead of failing.
    const capability = negotiateCompletionRequest(securityResult.value, resolved.capabilities, {
      policy: 'warn',
      provider: resolved.providerName || undefined,
    });
    const warnings = [
      ...(contextWindowResult?.warnings || []),
      ...optimizationResult.warnings,
      ...securityResult.findings.map((finding) => finding.message),
      ...capability.warnings.map(
        (warning) => `${warning.feature} was ${warning.action} for ${resolved.model}: ${warning.reason}`,
      ),
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
      contextWindow: contextWindowResult?.usage,
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

  /**
   * Streams a completion through the configured pipeline using normalized stream chunks.
   */
  stream(request: CompletionRequest): NexusStream {
    if (this.isContextWindowEnabled()) {
      return this.streamWithContextWindow(request);
    }

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
    const routedModel = resolveModel(decision.model, this.config);
    const routedRequest = negotiateCompletionRequest(
      { ...securityResult.value, model: routedModel.model },
      routedModel.capabilities,
      { policy: this.config.capabilities?.policy, provider: routedModel.providerName || undefined },
    ).value;
    const stream = this.failover.stream(routedRequest, decision, this.providers, {
      timeoutMs: this.config.timeout,
      retry: this.config.retry,
      onAttemptSuccess: (providerName, latencyMs) => {
        this.health.recordSuccess(providerName, latencyMs);
        this.circuitBreaker.recordSuccess(providerName);
      },
      onAttemptFailure: (providerName, error) => {
        this.health.recordFailure(providerName, error);
        this.circuitBreaker.recordFailure(providerName, error);
      },
    });
    return this.isSecurityEnabled() ? protectStreamOutput(stream, this.security, routedRequest.signal) : stream;
  }

  /**
   * Runs an agent loop with registered tools and iteration limits.
   */
  async agent(config: AgentConfig): Promise<AgentResult> {
    const loop = new AgentLoop(this);
    return loop.run(config);
  }

  /**
   * Transcribes audio through a registered voice provider.
   */
  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResponse> {
    return this.voiceManager.transcribe(request);
  }

  /**
   * Synthesizes speech through a registered voice provider.
   */
  async speak(request: SpeechRequest): Promise<SpeechResponse> {
    return this.voiceManager.speak(request);
  }

  /**
   * Runs one voice turn: optional transcription, completion, and optional speech synthesis.
   */
  async voice(request: VoiceTurnRequest): Promise<VoiceTurnResponse> {
    return this.voiceManager.runTurn(request, this);
  }

  /**
   * Alias for `voice()` for apps that model calls as turns.
   */
  async voiceTurn(request: VoiceTurnRequest): Promise<VoiceTurnResponse> {
    return this.voiceManager.runTurn(request, this);
  }

  /**
   * Creates a stateful voice session with transcript history, task prompts, and optional tools.
   */
  createVoiceSession(config: VoiceSessionConfig): VoiceSession {
    return this.voiceManager.createSession(config, this);
  }

  /**
   * Creates an outbound call through a registered telephony provider.
   */
  async createCall(request: CreateCallRequest): Promise<CreateCallResponse> {
    return this.telephonyManager.createCall(request);
  }

  /**
   * Creates a provider-specific webhook response such as TwiML.
   */
  async createTelephonyResponse(request: TelephonyResponseRequest): Promise<TelephonyWebhookResponse> {
    return this.telephonyManager.createWebhookResponse(request);
  }

  /**
   * Validates a telephony webhook signature when the provider supports it.
   */
  async validateTelephonyWebhook(request: TelephonyWebhookValidationRequest): Promise<boolean> {
    return this.telephonyManager.validateWebhook(request);
  }

  parseTelephonyMediaEvent(
    providerName: string,
    message: string | Record<string, unknown>,
  ): TelephonyMediaStreamEvent | undefined {
    return this.telephonyManager.parseMediaStreamEvent(providerName, message);
  }

  formatTelephonyAudioMessage(
    providerName: string,
    streamId: string,
    payload: string,
    options?: { event?: 'media' | 'mark' | 'clear'; markName?: string },
  ): TelephonyOutboundAudioMessage {
    return this.telephonyManager.formatAudioMessage(providerName, streamId, payload, options);
  }

  /**
   * Reads a call's current provider-side state, including the duration usage metering bills on.
   */
  async getCall(request: GetCallRequest): Promise<TelephonyCallDetails> {
    return this.telephonyManager.getCall(request);
  }

  /**
   * Hangs up a live call through the provider's call-control API.
   */
  async endCall(request: EndCallRequest): Promise<TelephonyCallDetails> {
    return this.telephonyManager.endCall(request);
  }

  /**
   * Parses a provider status webhook into a normalized record. Prefer this over media-stream
   * lifecycle events when metering usage.
   */
  parseTelephonyStatusCallback(
    providerName: string,
    body: string | URLSearchParams | Record<string, string | number | boolean | undefined>,
  ): TelephonyStatusCallback | undefined {
    return this.telephonyManager.parseStatusCallback(providerName, body);
  }

  /**
   * Lists phone numbers owned by the provider account.
   */
  async listPhoneNumbers(request?: ListPhoneNumbersRequest): Promise<TelephonyPhoneNumber[]> {
    return this.telephonyManager.listPhoneNumbers(request);
  }

  /**
   * Points a phone number at a voice webhook and/or status callback.
   */
  async updatePhoneNumber(request: UpdatePhoneNumberRequest): Promise<TelephonyPhoneNumber> {
    return this.telephonyManager.updatePhoneNumber(request);
  }

  /**
   * Provider-neutral embeddings, sharing this runtime's metrics, audit log, and rate limiter.
   *
   * Built on first access, so a runtime that never embeds pays nothing for the family. Adapters are
   * derived from the provider credentials already in `providers`, which makes `ai.embed('text')`
   * work without any embedding-specific configuration.
   */
  get embeddings(): EmbeddingManager {
    if (!this.embeddingManager) {
      this.embeddingManager = new EmbeddingManager(this.config.embeddings || {}, {
        metrics: this.metrics,
        auditLogger: this.auditLogger,
        rateLimiter: this.rateLimiter,
        providers: this.config.providers,
      });
    }
    return this.embeddingManager;
  }

  /**
   * Embeds one text or a batch through the configured embedding provider.
   *
   * `vectors[0]` is the answer for the single-string form; a batch comes back in input order no
   * matter how many provider calls the model's batch limit required.
   */
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return this.embeddings.embed(request);
  }

  /** Embeds one text and returns the vector alone. */
  embedOne(text: string, options: Omit<EmbeddingRequest, 'input'> = {}): Promise<number[]> {
    return this.embeddings.embedOne(text, options);
  }

  /**
   * Registers a custom text provider at runtime.
   */
  registerProvider(name: string, provider: BaseProvider): this {
    this.providers.set(name, provider);
    return this;
  }

  /**
   * Registers a custom voice provider at runtime.
   */
  registerVoiceProvider(name: string, provider: VoiceProvider): this {
    this.voiceManager.registerProvider(name, provider);
    return this;
  }

  /**
   * Registers a custom image provider at runtime.
   */
  registerImageProvider(name: string, provider: ImageProvider): this {
    this.images.registerImageProvider(name, provider);
    return this;
  }

  /**
   * Registers a custom telephony provider at runtime.
   */
  registerTelephonyProvider(name: string, provider: TelephonyProvider): this {
    this.telephonyManager.registerProvider(name, provider);
    return this;
  }

  /**
   * Registers a custom embedding provider at runtime.
   */
  registerEmbeddingProvider(name: string, provider: EmbeddingsProvider): this {
    this.embeddings.registerEmbeddingProvider(name, provider);
    return this;
  }

  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  hasVoiceProvider(name: string): boolean {
    return this.voiceManager.hasProvider(name);
  }

  hasImageProvider(name: string): boolean {
    return this.images.hasImageProvider(name);
  }

  hasTelephonyProvider(name: string): boolean {
    return this.telephonyManager.hasProvider(name);
  }

  hasEmbeddingProvider(name: string): boolean {
    return this.embeddings.hasEmbeddingProvider(name);
  }

  /**
   * Lists configured text providers.
   */
  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  listVoiceProviders(): string[] {
    return this.voiceManager.listProviders();
  }

  listImageProviders(): string[] {
    return this.images.listImageProviders();
  }

  listTelephonyProviders(): string[] {
    return this.telephonyManager.listProviders();
  }

  listEmbeddingProviders(): string[] {
    return this.embeddings.listEmbeddingProviders();
  }

  /**
   * Adds a custom pipeline step.
   */
  use(step: PipelineStep): this {
    this.pipeline.use(step);
    return this;
  }

  /**
   * Runs multiple completion requests with optional concurrency control.
   */
  async batchComplete(
    requests: CompletionRequest[],
    options: BatchOptions = {},
  ): Promise<Array<BatchItemResult<NexusResponse>>> {
    return runBatch(requests, (item) => this.complete(item), options);
  }

  /**
   * Creates an in-process job queue for completion requests.
   */
  createQueue(options: QueueOptions = {}): JobQueue<CompletionRequest, NexusResponse> {
    return new JobQueue<CompletionRequest, NexusResponse>((payload) => this.complete(payload), options);
  }

  /**
   * Runs eval cases against this Nexus instance.
   */
  runEvals(cases: EvalCase<NexusResponse>[]): Promise<EvalRunResult<NexusResponse>> {
    return new EvalRunner<NexusResponse>(this).run(cases);
  }

  summarizeVerifyFormat(options: SummarizeVerifyFormatOptions): Promise<WorkflowResult> {
    return summarizeVerifyFormat(this, options);
  }

  /**
   * Returns current provider health snapshots.
   */
  /** Circuit state per provider, for a health endpoint or dashboard. */
  getCircuitBreakerStatus() {
    return this.circuitBreaker.snapshot();
  }

  /** Forces a circuit closed, for an operator override. Omit the name to reset every provider. */
  resetCircuitBreaker(providerName?: string): void {
    this.circuitBreaker.reset(providerName);
  }

  getProviderHealth() {
    return this.health.snapshot();
  }

  /**
   * Calls each provider's health check and records the result.
   */
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

  /**
   * Returns an in-memory metrics snapshot.
   */
  getMetricsSnapshot(): Record<string, unknown> {
    return this.metrics.snapshot();
  }

  /**
   * Returns Prometheus-formatted metrics when metrics are enabled.
   */
  getPrometheusMetrics(): string {
    return this.metrics.toPrometheus();
  }

  /**
   * Clears exact and semantic caches.
   */
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

  private isContextWindowEnabled(): boolean {
    return this.config.contextWindow !== undefined && this.config.contextWindow.enabled !== false;
  }

  private hasResponseFormat(request: CompletionRequest): boolean {
    const responseFormat = request.responseFormat || this.config.responseFormat;
    return Boolean(responseFormat && responseFormat.type !== 'text');
  }

  private streamWithContextWindow(request: CompletionRequest): NexusStream {
    this.rateLimiter.check(request, this.config.rateLimit);

    let inner: NexusStream | undefined;
    let aborted = false;

    const create = async (): Promise<NexusStream> => {
      const formattedRequest = this.hasResponseFormat(request)
        ? withResponseFormat(request, this.config.responseFormat)
        : request;
      const contextWindowResult = await this.contextWindow.optimize(formattedRequest, {
        summarizer: (input) => this.summarizeContext(input),
      });
      const optimizationResult = this.optimizer.optimize(contextWindowResult.value);
      const securityResult = this.isSecurityEnabled()
        ? this.security.protectInput(optimizationResult.value)
        : { ok: true, value: optimizationResult.value, findings: [], guardrailsApplied: [] };
      if (this.isSecurityEnabled()) this.security.assertSafe(securityResult);

      const decision = this.router.route(securityResult.value, this.config, this.providers, this.health.snapshot());
      this.logger.info('stream route decision', {
        ...(decision as unknown as Record<string, unknown>),
        tokensSaved: optimizationResult.usage.savedTokens,
        contextWindow: contextWindowResult.usage,
      });
      const routedRequest = { ...securityResult.value, model: resolveModel(decision.model, this.config).model };
      const stream = this.failover.stream(routedRequest, decision, this.providers, {
        timeoutMs: this.config.timeout,
        retry: this.config.retry,
        onAttemptSuccess: (providerName, latencyMs) => this.health.recordSuccess(providerName, latencyMs),
        onAttemptFailure: (providerName, error) => this.health.recordFailure(providerName, error),
      });
      const securedStream = this.isSecurityEnabled()
        ? protectStreamOutput(stream, this.security, routedRequest.signal)
        : stream;
      return this.attachContextWindowToStream(securedStream, contextWindowResult);
    };

    return {
      async *[Symbol.asyncIterator]() {
        if (aborted) return;
        inner = inner || (await create());
        if (aborted) {
          inner.abort();
          return;
        }
        for await (const chunk of inner) {
          if (aborted) return;
          yield chunk;
        }
      },
      abort() {
        aborted = true;
        inner?.abort();
      },
    };
  }

  private attachContextWindowToStream(
    stream: NexusStream,
    result: ContextWindowResult<CompletionRequest>,
  ): NexusStream {
    let aborted = false;

    return {
      async *[Symbol.asyncIterator]() {
        for await (const chunk of stream) {
          if (aborted) return;
          if (chunk.type === 'done') {
            yield {
              ...chunk,
              meta: {
                ...chunk.meta,
                contextWindow: result.usage,
              },
            };
            continue;
          }
          yield chunk;
        }
      },
      abort() {
        aborted = true;
        stream.abort();
      },
    };
  }

  private async summarizeContext(input: ContextSummaryInput): Promise<string> {
    const model = input.model || input.request.model;
    const summaryRequest: CompletionRequest = {
      model,
      messages: [
        { role: 'system', content: input.instruction },
        {
          role: 'user',
          content: [
            'Summarize this earlier conversation for future context.',
            'Return only the summary.',
            '',
            input.serializedMessages,
          ].join('\n'),
        },
      ],
      maxTokens: input.maxTokens,
      estimatedOutputTokens: input.maxTokens,
      temperature: input.temperature ?? 0.2,
      signal: input.request.signal,
      userId: input.request.userId,
      metadata: {
        ...input.request.metadata,
        contextWindowSummary: true,
      },
    };
    const decision = this.router.route(summaryRequest, this.config, this.providers, this.health.snapshot());
    const routedRequest = { ...summaryRequest, model: resolveModel(decision.model, this.config).model };
    const response = await this.failover.complete(routedRequest, decision, this.providers, {
      timeoutMs: this.config.timeout,
      retry: this.config.retry,
      onAttemptSuccess: (providerName, latencyMs) => {
        this.health.recordSuccess(providerName, latencyMs);
        this.circuitBreaker.recordSuccess(providerName);
      },
      onAttemptFailure: (providerName, error) => {
        this.health.recordFailure(providerName, error);
        this.circuitBreaker.recordFailure(providerName, error);
      },
    });

    return response.content.trim();
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

    if (providers.deepseek) {
      this.providers.set('deepseek', new DeepSeekProvider(providers.deepseek));
    }

    if (providers.azureOpenAI) {
      this.providers.set('azure-openai', new AzureOpenAIProvider(providers.azureOpenAI));
    }

    if (providers.lmstudio) {
      this.providers.set('lmstudio', new LMStudioProvider(providers.lmstudio));
    }

    if (providers.llamaCpp) {
      this.providers.set('llamacpp', new LlamaCppProvider(providers.llamaCpp));
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

    for (const custom of providers.custom || []) {
      if (custom.format === 'anthropic') {
        this.providers.set(
          custom.name,
          new AnthropicProvider({
            apiKey: custom.apiKey || 'custom',
            baseUrl: custom.baseUrl,
            providerName: custom.name,
            modelPrefix: custom.modelPrefix || custom.name,
            isLocal: custom.isLocal,
          }),
        );
        continue;
      }

      this.providers.set(
        custom.name,
        new OpenAIProvider({
          apiKey: custom.apiKey || 'custom',
          baseUrl: custom.baseUrl,
          defaultHeaders: custom.headers,
          defaultQuery: custom.query,
          providerName: custom.name,
          modelPrefix: custom.modelPrefix || custom.name,
          isLocal: custom.isLocal,
        }),
      );
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
      return (await this.config.cache.adapter.get(cacheKey)) as NexusResponse | undefined;
    }
    return this.cache.get(cacheKey);
  }

  private async setCachedResponse(
    cacheKey: string,
    request: CompletionRequest,
    response: NexusResponse,
  ): Promise<void> {
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
    return request.estimatedOutputTokens ?? this.config.costBudget?.estimatedOutputTokens ?? request.maxTokens ?? 1000;
  }
}
