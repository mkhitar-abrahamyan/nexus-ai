import type { NexusAIConfig } from '../types/config.js';
import type {
  BatchConfig,
  BatchCounts,
  BatchJobRef,
  BatchJobResult,
  BatchJobState,
  BatchOutputItem,
  BatchProvider,
  BatchProviderCallContext,
  BatchSubmitRequest,
} from '../types/batch.js';
import { isTerminalBatchStatus } from '../types/batch.js';
import type { DurableOperationHandle, OperationRunnerConfig } from '../types/operations.js';
import type { ResponseCost, TokenUsage } from '../types/response.js';
import { OperationRunner } from '../operations/runner.js';
import { estimateCost } from '../optimizer/cost.js';
import { DEFAULT_CURRENCY } from '../optimizer/cost.js';
import { generateRequestId } from '../utils/ids.js';
import { BatchCapabilityError, BatchProviderNotFoundError, BatchValidationError } from './errors.js';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 300_000;
/** Just past the 24-hour discounted tier, so a batch that lands late is still collected. */
const DEFAULT_TIMEOUT_MS = 26 * 60 * 60 * 1000;

export interface BatchManagerRuntime {
  /** Persists the operation record, so a submitted batch survives a restart. */
  operations?: OperationRunnerConfig<BatchJobResult>;
  /** Model registry used to price results. */
  config?: Pick<NexusAIConfig, 'models'>;
}

/**
 * Provider batch tiers behind one operation handle.
 *
 * This is the discounted asynchronous path that local `runBatch()` concurrency cannot reach: both
 * OpenAI and Anthropic charge roughly half for work submitted this way, in exchange for a
 * completion window measured in hours. The manager submits, polls with backoff, collects results,
 * and prices them.
 *
 * Every call after `submit` takes only a `BatchJobRef`, which is JSON-serializable. That is what
 * makes `resume()` possible: a worker that did not submit the batch, in a process that has since
 * restarted, can still collect it.
 */
export class BatchManager {
  private readonly providers = new Map<string, BatchProvider>();
  private readonly runner: OperationRunner<BatchJobResult>;

  constructor(
    private readonly config: BatchConfig = {},
    private readonly runtime: BatchManagerRuntime = {},
  ) {
    this.runner = new OperationRunner<BatchJobResult>(runtime.operations ?? {});
    for (const [name, provider] of Object.entries(config.providers ?? {})) {
      this.registerBatchProvider(name, provider);
    }
  }

  registerBatchProvider(name: string, provider: BatchProvider): this {
    const normalized = name.trim();
    if (!normalized) throw new BatchValidationError('Batch provider name must not be empty');
    if (typeof provider?.submit !== 'function' || typeof provider.poll !== 'function') {
      throw new BatchValidationError(`Batch provider "${normalized}" must implement submit() and poll()`);
    }
    this.providers.set(normalized, provider);
    return this;
  }

  hasBatchProvider(name: string): boolean {
    return this.providers.has(name);
  }

  listBatchProviders(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Submits a batch and returns a handle that settles when the provider finishes.
   *
   * The handle resolves after the provider completes, which for the discounted tier can be hours
   * away. Read `handle.id` and persist it, or stream `handle.events()`, rather than blocking a
   * request on `handle.result()`.
   */
  async submit(request: BatchSubmitRequest): Promise<DurableOperationHandle<BatchJobResult>> {
    const [providerName, provider] = this.resolveProvider(request.provider);
    this.validate(request, providerName, provider);

    const requestId = generateRequestId();
    return this.runner.submit(
      async (operation) => {
        const context: BatchProviderCallContext = {
          requestId,
          signal: operation.signal,
          idempotencyKey: request.idempotencyKey,
          attempt: operation.attempt,
        };

        const ref = await provider.submit(request, context);
        operation.report({ completed: 0, total: request.items.length, message: `submitted as ${ref.id}` });
        return this.collect(provider, ref, request, operation, context);
      },
      {
        kind: `batch.${providerName}`,
        idempotencyKey: request.idempotencyKey,
        signal: request.signal,
        timeoutMs: request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        metadata: { provider: providerName, items: request.items.length },
      },
    );
  }

  /**
   * Attaches to a batch this process did not submit.
   *
   * The provider is the source of truth, so a restarted worker only needs the ref it persisted.
   */
  async resume(ref: BatchJobRef, options: Partial<BatchSubmitRequest> = {}): Promise<BatchJobResult> {
    const provider = this.providers.get(ref.provider);
    if (!provider) throw new BatchProviderNotFoundError(ref.provider);

    const context: BatchProviderCallContext = {
      requestId: generateRequestId(),
      signal: options.signal ?? new AbortController().signal,
      attempt: 1,
    };
    return this.collect(provider, ref, options, undefined, context);
  }

  /** Current provider-side state, without waiting. */
  async status(ref: BatchJobRef): Promise<BatchJobState> {
    const provider = this.providers.get(ref.provider);
    if (!provider) throw new BatchProviderNotFoundError(ref.provider);
    return provider.poll(ref, {
      requestId: generateRequestId(),
      signal: new AbortController().signal,
      attempt: 1,
    });
  }

  async cancel(ref: BatchJobRef): Promise<BatchJobState> {
    const provider = this.providers.get(ref.provider);
    if (!provider) throw new BatchProviderNotFoundError(ref.provider);
    if (!provider.cancel) throw new BatchCapabilityError(ref.provider, 'cancel');
    return provider.cancel(ref, {
      requestId: generateRequestId(),
      signal: new AbortController().signal,
      attempt: 1,
    });
  }

  // ── Internals ────────────────────────────────────────────────────

  private async collect(
    provider: BatchProvider,
    ref: BatchJobRef,
    request: Partial<BatchSubmitRequest>,
    operation: { report: (progress: { completed?: number; total?: number; message?: string }) => void } | undefined,
    context: BatchProviderCallContext,
  ): Promise<BatchJobResult> {
    const baseInterval = request.pollIntervalMs ?? this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxInterval = this.config.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS;
    let interval = baseInterval;
    let state = await provider.poll(ref, context);

    while (!isTerminalBatchStatus(state.status)) {
      if (context.signal.aborted) throw context.signal.reason ?? new Error('aborted');

      operation?.report({
        completed: state.counts?.completed,
        total: state.counts?.total,
        message: state.status,
      });

      await delay(interval, context.signal);
      // A batch measured in hours does not deserve a fixed short interval; backing off keeps the
      // poll count sane without delaying a fast batch, which the first few short polls still catch.
      interval = Math.min(Math.round(interval * 1.5), maxInterval);
      state = await provider.poll(ref, context);
    }

    const items = state.status === 'completed' ? await provider.results(ref, context) : [];
    const counts = state.counts ?? countItems(items, request.items?.length);
    const usage = sumUsage(items);

    operation?.report({ completed: counts.completed, total: counts.total, message: state.status });

    return {
      ref,
      status: state.status,
      items,
      counts,
      usage,
      cost: this.price(usage, items, request.model, provider),
      createdAt: state.createdAt,
      completedAt: state.completedAt,
      raw: state.raw,
    };
  }

  /**
   * Prices a finished batch at the provider's discounted rate.
   *
   * Each item is priced against the model it actually ran on rather than the batch default, because
   * a mixed batch is legal and averaging would misreport every row. The discount is applied last,
   * so a provider that changes it only changes one number.
   */
  private price(
    usage: TokenUsage,
    items: BatchOutputItem[],
    fallbackModel: string | undefined,
    provider: BatchProvider,
  ): ResponseCost {
    const discount = provider.info.capabilities.discount ?? 1;
    let amount = 0;
    let priced = false;

    for (const item of items) {
      const meta = item.response?.meta;
      if (!meta?.usage) continue;
      priced = true;
      const estimate = estimateCost({
        model: meta.modelUsed || fallbackModel || '',
        inputTokens: meta.usage.inputTokens,
        outputTokens: meta.usage.outputTokens,
        cachedReadTokens: meta.usage.cachedReadTokens,
        cachedWriteTokens: meta.usage.cachedWriteTokens,
        config: this.runtime.config,
      });
      amount += estimate.totalCost;
    }

    if (!priced && fallbackModel) {
      const estimate = estimateCost({
        model: fallbackModel,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        config: this.runtime.config,
      });
      amount = estimate.totalCost;
    }

    return {
      amount: amount * discount,
      currency: DEFAULT_CURRENCY,
      basis: 'estimated',
    };
  }

  private resolveProvider(preferred?: string): [string, BatchProvider] {
    const selected = preferred?.trim() || this.config.defaultProvider;
    if (selected) {
      const provider = this.providers.get(selected);
      if (!provider) throw new BatchProviderNotFoundError(selected);
      return [selected, provider];
    }

    const first = [...this.providers.entries()][0];
    if (!first) throw new BatchProviderNotFoundError();
    return first;
  }

  private validate(request: BatchSubmitRequest, providerName: string, provider: BatchProvider): void {
    if (!Array.isArray(request.items) || request.items.length === 0) {
      throw new BatchValidationError('A batch must contain at least one item');
    }

    const seen = new Set<string>();
    for (const item of request.items) {
      if (!item.customId?.trim()) {
        throw new BatchValidationError('Every batch item must carry a non-empty customId');
      }
      if (seen.has(item.customId)) {
        // Duplicates would make results ambiguous, and the provider will not detect it.
        throw new BatchValidationError(`Duplicate batch customId "${item.customId}"`);
      }
      seen.add(item.customId);
      if (!item.request?.messages?.length) {
        throw new BatchValidationError(`Batch item "${item.customId}" has no messages`);
      }
    }

    const maxItems = provider.info.capabilities.maxItems;
    if (maxItems !== undefined && request.items.length > maxItems) {
      throw new BatchCapabilityError(
        providerName,
        'maxItems',
        `Batch provider "${providerName}" accepts at most ${maxItems} items, received ${request.items.length}`,
      );
    }

    const windows = provider.info.capabilities.completionWindows;
    if (request.completionWindow && windows && !windows.includes(request.completionWindow)) {
      throw new BatchCapabilityError(
        providerName,
        'completionWindow',
        `Batch provider "${providerName}" accepts ${windows.join(', ')}`,
      );
    }
  }
}

function countItems(items: BatchOutputItem[], total?: number): BatchCounts {
  let completed = 0;
  let failed = 0;
  for (const item of items) {
    if (item.error) failed += 1;
    else completed += 1;
  }
  return { total: total ?? items.length, completed, failed };
}

function sumUsage(items: BatchOutputItem[]): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const item of items) {
    const usage = item.response?.meta.usage;
    if (!usage) continue;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
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
