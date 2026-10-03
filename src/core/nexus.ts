import type { NexusAIConfig } from '../types/config.js';
import type { CompletionRequest } from '../types/messages.js';
import type { ContextSummaryInput, ContextWindowResult } from '../types/context-window.js';
import type { CostEstimate, NexusPlan } from '../types/planning.js';
import type { NexusResponse, NexusStream, ResponseMeta, StreamChunk } from '../types/response.js';
import type { AgentConfig, AgentResult } from '../types/agent.js';
import type { OperationDescriptor, OperationStartOptions, OperationTicket } from '../types/lifecycle.js';
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
import type { PipelineContext, PipelineStep, PipelineStepName } from '../pipeline/types.js';
import type { BaseProvider } from '../providers/base.js';
import { configuredProviders } from '../providers/lazy.js';
import type { RouteDecision } from '../router/types.js';
import { Router, FailoverExecutor } from '../router/index.js';
import type { ExecutionOptions } from '../router/failover.js';
import { Logger } from '../utils/logger.js';
import { SecurityPipeline } from '../security/index.js';
import { ContextWindowManager } from '../context/index.js';
import { VoiceManager } from '../voice/manager.js';
import type { VoiceSession } from '../voice/session.js';
import { ImageManager } from '../images/manager.js';
import { EmbeddingManager } from '../embeddings/manager.js';
import { TelephonyManager } from '../telephony/manager.js';
import { TokenOptimizer } from '../optimizer/index.js';
import { resolveModel } from '../models/registry.js';
import { createCacheKey, MemoryCache } from '../cache/memory-cache.js';
import type { SemanticCache } from '../cache/semantic-cache.js';
import { applyResponseFormat, withResponseFormat } from './response-format.js';
import { protectStreamOutput } from './secure-stream.js';
import { AuditLogger } from '../ops/audit-logger.js';
import { RateLimiter } from '../ops/rate-limiter.js';
import type { VerificationOptions } from '../hallucination/verification.js';
import type { SelfConsistencyOptions } from '../hallucination/consistency.js';
import { assertWithinCostBudget, estimateCost } from '../optimizer/cost.js';
import { negotiateCompletionRequest } from '../capabilities/negotiate.js';
import { buildUsage, costAmount, priceUsage } from './usage.js';
import { PipelineRunner, createPipelineContext } from '../pipeline/pipeline.js';
import { MetricsCollector } from '../ops/metrics.js';
import { ProviderHealthMonitor } from '../ops/health.js';
import { CircuitBreaker } from '../ops/circuit-breaker.js';
import { runBatch, type BatchOptions, type BatchItemResult } from '../jobs/batch.js';
import { JobQueue, type QueueOptions } from '../jobs/queue.js';
import type { EvalCase, EvalRunResult } from '../evals/runner.js';
import type { SummarizeVerifyFormatOptions, WorkflowResult } from '../workflow/chains.js';
import { OperationLifecycle } from './lifecycle.js';

/**
 * Main runtime facade for provider routing, security, optimization, evals, voice, jobs, and observability.
 *
 * Use `new NexusAI(config)` when you want full control, or `createNexus()` for the beginner shorthand.
 */
export class NexusAI {
  /** Provider-neutral image generation and editing operations. */
  readonly images: ImageManager;

  /**
   * What every operation of this client runs through: authorization, the rate limit, the budget,
   * hooks, audit, and metrics. Hand it to a graph, an agent, or a realtime session so its runs are
   * operations of this client too.
   */
  readonly lifecycle: OperationLifecycle;

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
  /**
   * Health, circuit, and probe-slot hooks for every provider call. Built once, not per request; the
   * arrow functions read `this` when called, after the constructor has run.
   */
  private readonly attemptHooks = {
    allowAttempt: (providerName: string) => this.circuitBreaker.allowRequest(providerName),
    onAttemptSuccess: (providerName: string, latencyMs: number) => {
      this.health.recordSuccess(providerName, latencyMs);
      this.circuitBreaker.recordSuccess(providerName);
    },
    onAttemptFailure: (providerName: string, error: unknown) => {
      this.health.recordFailure(providerName, error);
      this.circuitBreaker.recordFailure(providerName, error);
    },
  };
  /** Loaded on the first semantic lookup, so a client without one never imports it. */
  private semanticCache?: SemanticCache;
  private semanticCacheLoading?: Promise<SemanticCache>;

  /**
   * Creates a configured Nexus runtime.
   *
   * Provider adapters and their SDKs load on each provider's first call, so unused providers add no
   * import cost and no runtime work.
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
    this.lifecycle = new OperationLifecycle({
      metrics: this.metrics,
      auditLogger: this.auditLogger,
      rateLimiter: this.rateLimiter,
      rateLimit: this.config.rateLimit,
      config: this.config.lifecycle,
    });
    // Built before the families so every one of them runs through this client's lifecycle rather
    // than reporting into instances nobody can read.
    const familyRuntime = {
      metrics: this.metrics,
      auditLogger: this.auditLogger,
      rateLimiter: this.rateLimiter,
      rateLimit: this.config.rateLimit,
      lifecycle: this.lifecycle,
    };
    this.voiceManager = new VoiceManager(this.config.voice || {}, familyRuntime);
    this.images = new ImageManager(this.config.images || {}, familyRuntime);
    this.telephonyManager = new TelephonyManager(this.config.telephony || {}, familyRuntime);
    this.optimizer = new TokenOptimizer(this.config.tokenOptimizer || {});
    this.cache = new MemoryCache<NexusResponse>(this.config.cache?.maxEntries || 500);
    this.pipeline = new PipelineRunner(this.config.pipeline || {});
    this.health = new ProviderHealthMonitor(this.config.health || {});
    this.circuitBreaker = new CircuitBreaker(this.config.circuitBreaker || {});
    for (const [name, provider] of configuredProviders(this.config.providers)) this.providers.set(name, provider);
  }

  /**
   * Runs a completion through the full configured pipeline and returns one normalized response.
   */
  async complete(request: CompletionRequest): Promise<NexusResponse> {
    let context = createPipelineContext(request);
    const ticket = await this.lifecycleStep(context, 'authorize', () =>
      this.lifecycle.start(this.describe(request, 'complete'), this.startOptions(request)),
    );

    try {
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
        // A block is audited by the lifecycle, with the findings that caused it.
        this.security.assertSafe(securityResult);
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
      ticket.descriptor.provider = decision.providerName;
      ticket.descriptor.model = routedModel.model;
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

      await this.applyBudgets(context, ticket);

      const responseFormat = context.request.responseFormat || this.config.responseFormat;
      const cacheKey = this.isCacheEnabled() ? createCacheKey({ request: context.request, responseFormat }) : undefined;
      if (cacheKey) {
        const cached = await this.pipeline.trace(context, 'cacheLookup', () =>
          this.getCachedResponse(cacheKey, context.request),
        );
        if (cached) {
          let cachedResponse = this.attachTrace(
            {
              ...cached,
              meta: { ...cached.meta, requestId: ticket.descriptor.requestId, cacheHit: true },
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
          // A cache hit is still an operation: it is audited, counted, and costs the budget nothing.
          await ticket.succeed({
            cacheHit: true,
            cost: 0,
            provider: cachedResponse.meta.providerUsed,
            model: cachedResponse.meta.modelUsed,
          });
          return cachedResponse;
        }
      }

      context = await this.pipeline.runHook('beforeProvider', context);

      const response = await this.pipeline.trace(context, 'providerCall', () => {
        return this.failover.complete(context.request, decision, this.providers, this.executionOptions(ticket.context));
      });
      context.response = response;
      context = await this.pipeline.runHook('afterProvider', context);

      const providerResponse = context.response;
      if (!providerResponse) {
        throw new Error('The afterProvider pipeline hook removed the provider response.');
      }
      providerResponse.meta.requestId = ticket.descriptor.requestId;
      providerResponse.meta.guardrailsApplied.push(...context.guardrailsApplied);
      providerResponse.meta.tokensSaved += optimizationResult.usage.savedTokens;
      if (negotiation.warnings.length) {
        providerResponse.meta.capabilityWarnings = negotiation.warnings;
      }
      if (context.contextWindow) {
        providerResponse.meta.contextWindow = context.contextWindow.usage;
      }
      providerResponse.meta.routingDecision ??= {
        reason: decision.reason,
        fallbacksConsidered: decision.fallbacks.length,
      };
      const requestForCost = context.request;
      await this.pipeline.trace(context, 'reconcileCost', () =>
        this.reconcileCost(providerResponse.meta, requestForCost),
      );

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

      if (cacheKey) {
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

      await this.lifecycleStep(finalContext, 'audit', () =>
        ticket.succeed({
          cost: costAmount(finalResponse.meta),
          provider: finalResponse.meta.providerUsed,
          model: finalResponse.meta.modelUsed,
          ...(this.config.auditLog?.includeOutput ? { metadata: { response: finalResponse } } : {}),
        }),
      );
      for (const step of finalResponse.meta.pipeline?.steps || []) {
        await this.metrics.recordStep(step);
      }

      return finalResponse;
    } catch (error) {
      await ticket.fail(error);
      throw error;
    }
  }

  /**
   * Completes a request and verifies generated claims against provided context.
   */
  async completeVerified(request: CompletionRequest, options: VerificationOptions): Promise<NexusResponse> {
    const { completeVerified } = await import('../hallucination/verification.js');
    return completeVerified(this, request, options);
  }

  /**
   * Samples multiple completions and returns the most self-consistent answer.
   */
  async completeConsistent(request: CompletionRequest, options: SelfConsistencyOptions = {}): Promise<NexusResponse> {
    const { completeWithSelfConsistency } = await import('../hallucination/consistency.js');
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
   *
   * The stream opens on its first read: authorization, the rate limit, guardrails, routing, and the
   * budget run then, so an error from any of them surfaces from the iterator rather than from this
   * call. The operation finishes when the stream does, with the cost of the usage the provider
   * reported.
   */
  stream(request: CompletionRequest): NexusStream {
    const self = this;
    let inner: NexusStream | undefined;
    let aborted = false;

    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<StreamChunk> {
        if (aborted) return;
        const ticket = await self.lifecycle.start(self.describe(request, 'stream'), self.startOptions(request));
        let opened: OpenedStream;
        try {
          opened = await self.openStream(request, ticket);
        } catch (error) {
          await ticket.fail(error);
          throw error;
        }
        inner = opened.stream;
        if (aborted) {
          inner.abort();
          await ticket.fail(streamStopped());
          return;
        }

        let failure: string | undefined;
        let doneMeta: Partial<ResponseMeta> | undefined;
        let settled = false;
        try {
          for await (const chunk of inner) {
            if (aborted) break;
            if (chunk.type === 'error') failure = chunk.error || 'stream error';
            if (chunk.type === 'done') {
              doneMeta = self.finishStreamMeta(chunk.meta ?? {}, ticket, opened);
              yield { ...chunk, meta: doneMeta };
              continue;
            }
            yield chunk;
          }
          settled = true;
          if (failure !== undefined) await ticket.fail(new Error(failure));
          else if (aborted) await ticket.fail(streamStopped());
          else {
            await ticket.succeed({
              cost: doneMeta?.cost?.amount,
              provider: doneMeta?.providerUsed,
              model: doneMeta?.modelUsed,
            });
          }
        } catch (error) {
          settled = true;
          await ticket.fail(error);
          throw error;
        } finally {
          // The consumer stopped reading before the stream ended.
          if (!settled) await ticket.fail(streamStopped());
        }
      },
      abort() {
        aborted = true;
        inner?.abort();
      },
    };
  }

  /**
   * Runs an agent loop with registered tools and iteration limits, as one operation of this
   * client whose model calls are operations of their own.
   */
  async agent(config: AgentConfig): Promise<AgentResult> {
    const { AgentLoop } = await import('../agent/loop.js');
    return this.lifecycle.run(
      {
        family: 'agent',
        operation: 'agent',
        model: config.model,
        ...(config.metadata ? { metadata: config.metadata } : {}),
      },
      { execute: () => new AgentLoop(this).run(config) },
    );
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

  /** Parses a telephony media-stream message into a neutral event, through the named provider. */
  parseTelephonyMediaEvent(
    providerName: string,
    message: string | Record<string, unknown>,
  ): TelephonyMediaStreamEvent | undefined {
    return this.telephonyManager.parseMediaStreamEvent(providerName, message);
  }

  /** Formats outbound audio, a mark, or a clear as the named provider's media-stream message. */
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
   * Provider-neutral embeddings, sharing this runtime's lifecycle, metrics, audit log, and rate
   * limiter.
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
        lifecycle: this.config.lifecycle,
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

  /** Whether a text provider is configured. */
  hasProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /** Whether a voice provider is configured. */
  hasVoiceProvider(name: string): boolean {
    return this.voiceManager.hasProvider(name);
  }

  /** Whether an image provider is registered. */
  hasImageProvider(name: string): boolean {
    return this.images.hasImageProvider(name);
  }

  /** Whether a telephony provider is configured. */
  hasTelephonyProvider(name: string): boolean {
    return this.telephonyManager.hasProvider(name);
  }

  /** Whether an embeddings provider is registered. */
  hasEmbeddingProvider(name: string): boolean {
    return this.embeddings.hasEmbeddingProvider(name);
  }

  /**
   * Lists configured text providers.
   */
  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  /** Lists configured voice providers. */
  listVoiceProviders(): string[] {
    return this.voiceManager.listProviders();
  }

  /** Lists registered image providers. */
  listImageProviders(): string[] {
    return this.images.listImageProviders();
  }

  /** Lists configured telephony providers. */
  listTelephonyProviders(): string[] {
    return this.telephonyManager.listProviders();
  }

  /** Lists registered embeddings providers. */
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
   * Creates an in-process job queue for completion requests. Each job is one completion, and so one
   * operation of this client's lifecycle.
   */
  createQueue(options: QueueOptions = {}): JobQueue<CompletionRequest, NexusResponse> {
    return new JobQueue<CompletionRequest, NexusResponse>((payload) => this.complete(payload), options);
  }

  /**
   * Runs eval cases against this Nexus instance.
   */
  async runEvals(cases: EvalCase<NexusResponse>[]): Promise<EvalRunResult<NexusResponse>> {
    const { EvalRunner } = await import('../evals/runner.js');
    return new EvalRunner<NexusResponse>(this).run(cases);
  }

  /** Runs the summarize, verify, and format workflow on this client. */
  async summarizeVerifyFormat(options: SummarizeVerifyFormatOptions): Promise<WorkflowResult> {
    const { summarizeVerifyFormat } = await import('../workflow/chains.js');
    return summarizeVerifyFormat(this, options);
  }

  /** Circuit state per provider, for a health endpoint or dashboard. */
  getCircuitBreakerStatus() {
    return this.circuitBreaker.snapshot();
  }

  /** Forces a circuit closed, for an operator override. Omit the name to reset every provider. */
  resetCircuitBreaker(providerName?: string): void {
    this.circuitBreaker.reset(providerName);
  }

  /**
   * Loads circuit decisions other workers have published, when `circuitBreaker.store` is set.
   * Checks refresh shared state in the background on their own; awaiting this at startup means the
   * first request already avoids providers that are open elsewhere.
   */
  syncCircuitBreaker(): Promise<void> {
    return this.circuitBreaker.sync();
  }

  /** Health of every provider seen so far, when health tracking is on. */
  getProviderHealth() {
    return this.health.snapshot();
  }

  /**
   * Calls each provider's health check and records the result. With `staleOnly`, only the providers
   * whose health is `unknown` are checked: never called, or not since `health.observationTtlMs`. Run
   * it on a schedule to keep an idle provider's health current.
   */
  async checkProviders(
    options: { staleOnly?: boolean } = {},
  ): Promise<Array<{ providerName: string; ok: boolean; error?: string }>> {
    const results: Array<{ providerName: string; ok: boolean; error?: string }> = [];
    for (const [providerName, provider] of this.providers) {
      if (options.staleOnly && !this.health.isUnknown(providerName)) continue;
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
    this.semanticCache?.clear();
  }

  /** Removes expired response-cache entries, returning how many went. */
  clearExpiredCache(): number {
    return this.cache.clearExpired();
  }

  /** Response-cache size, capacity, and expired entries not yet removed. */
  getCacheStats(): { size: number; maxEntries: number; expiredEntries: number } {
    return this.cache.stats();
  }

  /** A completion as the lifecycle sees it. */
  private describe(
    request: CompletionRequest,
    operation: string,
  ): Omit<OperationDescriptor, 'requestId'> & { requestId?: string } {
    return {
      family: 'completion',
      operation,
      model: request.model,
      ...(request.requestId ? { requestId: request.requestId } : {}),
      ...(request.userId ? { userId: request.userId } : {}),
      ...(request.tenantId ? { tenantId: request.tenantId } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    };
  }

  private startOptions(request: CompletionRequest): OperationStartOptions & { audit?: Record<string, unknown> } {
    return {
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(this.config.auditLog?.includeInput ? { audit: { request } } : {}),
    };
  }

  /** How failover runs the provider calls of one operation, with the context each attempt hands on. */
  private executionOptions(
    context: Pick<OperationTicket['context'], 'requestId' | 'traceContext' | 'idempotencyKey'>,
  ): ExecutionOptions {
    const { requestId, traceContext, idempotencyKey } = context;
    return {
      timeoutMs: this.config.timeout,
      retry: this.config.retry,
      ...this.attemptHooks,
      callContext: {
        requestId,
        ...(traceContext ? { traceContext } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    };
  }

  /**
   * Times a lifecycle stage into the trace when the lifecycle has work to do, so a client with
   * nothing configured keeps the trace it always had.
   */
  private lifecycleStep<T>(context: PipelineContext, name: PipelineStepName, fn: () => Promise<T>): Promise<T> {
    return this.lifecycle.inert ? fn() : this.pipeline.trace(context, name, fn);
  }

  /**
   * Applies the per-request cost limit and holds the estimate against the shared budget. The
   * estimate is priced once for both.
   */
  private async applyBudgets(context: PipelineContext, ticket: OperationTicket): Promise<void> {
    const request = context.request;
    const perRequest = this.isCostBudgetEnabled(request);
    const shared = Boolean(this.config.lifecycle?.budget);
    if (!perRequest && !shared) return;
    const estimate = this.estimateRequestCost(request);
    if (perRequest) {
      await this.pipeline.trace(context, 'costBudget', () => {
        this.enforceCostBudget(estimate, request);
      });
    }
    if (shared) {
      await this.pipeline.trace(context, 'reserveBudget', () => ticket.reserve(estimate.totalCost));
    }
  }

  /**
   * Prices a response on the model the request was routed to, as the registry names it, unless the
   * provider reported an authoritative charge. A provider echoes back names such as a dated snapshot
   * that the registry does not file, so its own pricing can miss.
   */
  private reconcileCost(meta: Partial<ResponseMeta>, request: CompletionRequest): void {
    const usage = meta.usage ?? buildUsage({ inputTokens: meta.tokensInput, outputTokens: meta.tokensOutput });
    meta.usage = usage;
    if (meta.cost?.basis === 'reported') return;
    const model = meta.routingDecision?.model ?? request.model;
    if (resolveModel(model, this.config).capabilities || !meta.cost) {
      meta.cost = priceUsage({ model, usage, cacheTtl: request.cache?.ttl, config: this.config });
    }
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

  /** Every stage of a stream before the provider: guardrails, routing, and the budget. */
  private async openStream(request: CompletionRequest, ticket: OperationTicket): Promise<OpenedStream> {
    const formattedRequest = this.hasResponseFormat(request)
      ? withResponseFormat(request, this.config.responseFormat)
      : request;
    const contextWindowResult = this.isContextWindowEnabled()
      ? await this.contextWindow.optimize(formattedRequest, { summarizer: (input) => this.summarizeContext(input) })
      : undefined;
    const optimizationResult = this.optimizer.optimize(contextWindowResult?.value ?? formattedRequest);
    const securityResult = this.isSecurityEnabled()
      ? this.security.protectInput(optimizationResult.value)
      : { ok: true, value: optimizationResult.value, findings: [], guardrailsApplied: [] };
    if (this.isSecurityEnabled()) this.security.assertSafe(securityResult);

    const decision = this.router.route(
      securityResult.value,
      this.config,
      this.providers,
      this.health.snapshot(),
      this.circuitBreaker.openProviders(),
    );
    this.logger.info('stream route decision', {
      ...(decision as unknown as Record<string, unknown>),
      tokensSaved: optimizationResult.usage.savedTokens,
      ...(contextWindowResult ? { contextWindow: contextWindowResult.usage } : {}),
    });
    const routedModel = resolveModel(decision.model, this.config);
    const routedRequest = negotiateCompletionRequest(
      { ...securityResult.value, model: routedModel.model },
      routedModel.capabilities,
      { policy: this.config.capabilities?.policy, provider: routedModel.providerName || undefined },
    ).value;
    ticket.descriptor.provider = decision.providerName;
    ticket.descriptor.model = routedModel.model;

    const perRequest = this.isCostBudgetEnabled(routedRequest);
    const shared = Boolean(this.config.lifecycle?.budget);
    if (perRequest || shared) {
      const estimate = this.estimateRequestCost(routedRequest);
      if (perRequest) this.enforceCostBudget(estimate, routedRequest);
      if (shared) await ticket.reserve(estimate.totalCost);
    }

    const stream = this.failover.stream(routedRequest, decision, this.providers, this.executionOptions(ticket.context));
    return {
      stream: this.isSecurityEnabled() ? protectStreamOutput(stream, this.security, routedRequest.signal) : stream,
      request: routedRequest,
      decision,
      contextWindow: contextWindowResult,
    };
  }

  /** The final chunk's metadata: the operation's id, the context-window usage, and the reconciled cost. */
  private finishStreamMeta(
    meta: Partial<ResponseMeta>,
    ticket: OperationTicket,
    opened: OpenedStream,
  ): Partial<ResponseMeta> {
    const finished: Partial<ResponseMeta> = {
      ...meta,
      requestId: ticket.descriptor.requestId,
      ...(opened.contextWindow ? { contextWindow: opened.contextWindow.usage } : {}),
    };
    // Only usage the provider reported is priced; a stream that reported none stays unpriced.
    if (finished.usage) this.reconcileCost(finished, opened.request);
    return finished;
  }

  /**
   * Summarizes earlier turns for the context window. The summary is a paid model call, so it runs
   * as an operation of its own: authorized, budgeted, and audited like any other.
   */
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
      tenantId: input.request.tenantId,
      metadata: {
        ...input.request.metadata,
        contextWindowSummary: true,
      },
    };
    const decision = this.router.route(summaryRequest, this.config, this.providers, this.health.snapshot());
    const routedRequest = { ...summaryRequest, model: resolveModel(decision.model, this.config).model };
    const response = await this.lifecycle.run(
      { ...this.describe(routedRequest, 'summarize'), provider: decision.providerName },
      {
        execute: (callContext) =>
          this.failover.complete(routedRequest, decision, this.providers, this.executionOptions(callContext)),
        settle: (result) => {
          this.reconcileCost(result.meta, routedRequest);
          return { cost: costAmount(result.meta), provider: result.meta.providerUsed, model: result.meta.modelUsed };
        },
      },
      this.startOptions(routedRequest),
    );

    return response.content.trim();
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

  private usesSemanticCache(): boolean {
    const strategy = this.config.cache?.strategy;
    return strategy === 'semantic' || strategy === 'hybrid';
  }

  private loadSemanticCache(): Promise<SemanticCache> {
    this.semanticCacheLoading ??= import('../cache/semantic-cache.js').then(({ SemanticCache }) => {
      const cache = new SemanticCache({
        enabled: this.config.cache?.enabled && this.usesSemanticCache(),
        maxEntries: this.config.cache?.maxEntries,
        ttlSeconds: this.config.cache?.ttlSeconds,
        ...this.config.cache?.semantic,
      });
      this.semanticCache = cache;
      return cache;
    });
    return this.semanticCacheLoading;
  }

  private async getCachedResponse(cacheKey: string, request: CompletionRequest): Promise<NexusResponse | undefined> {
    if (!this.config.cache?.enabled) return undefined;
    if (this.usesSemanticCache()) {
      const semantic = await (await this.loadSemanticCache()).get(request);
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

    if (this.usesSemanticCache()) {
      await (await this.loadSemanticCache()).set(cacheKey, request, response);
    }

    if (this.config.cache.strategy === 'semantic') return;
    if (this.config.cache.adapter) {
      await this.config.cache.adapter.set(cacheKey, response, ttl);
      return;
    }
    this.cache.set(cacheKey, response, ttl);
  }

  private estimateRequestCost(request: CompletionRequest): CostEstimate {
    return estimateCost({
      model: request.model,
      inputTokens: this.optimizer.optimize(request).usage.afterTokens,
      outputTokens: this.estimatedOutputTokens(request),
      config: this.config,
    });
  }

  private enforceCostBudget(estimate: CostEstimate, request: CompletionRequest): void {
    const maxEstimatedCost = request.maxEstimatedCost ?? this.config.costBudget?.maxEstimatedCost;
    if (maxEstimatedCost === undefined) return;

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

/** A stream past its pre-provider stages, with what its final chunk needs. */
interface OpenedStream {
  stream: NexusStream;
  request: CompletionRequest;
  decision: RouteDecision;
  contextWindow?: ContextWindowResult<CompletionRequest>;
}

/** The error a stream's operation finishes with when it was stopped before it ended. */
function streamStopped(): Error {
  const error = new Error('The stream was stopped before it finished');
  error.name = 'AbortError';
  return error;
}
