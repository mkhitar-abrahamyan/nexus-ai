/**
 * A provider's batch tier for embeddings: large ingestion jobs at the provider's batch price, usually
 * half, in exchange for a completion window measured in hours.
 */
import { BatchCapabilityError, BatchProviderNotFoundError, BatchValidationError } from '../batch/errors.js';
import { pollUntilSettled } from '../batch/poll.js';
import { type ContinuedFields, continuing } from '../lifecycle/continue.js';
import type {
  BatchCounts,
  BatchJobRef,
  BatchJobState,
  BatchJobStatus,
  BatchProviderCallContext,
  BatchProviderCapabilities,
} from '../types/batch.js';
import type {
  EmbeddingInputType,
  EmbeddingModality,
  EmbeddingModelRegistryConfig,
  EmbeddingParts,
  EmbeddingProviderPart,
} from '../types/embeddings.js';
import type { OperationLifecycleLike } from '../types/lifecycle.js';
import type { DurableOperationHandle, OperationRunnerConfig } from '../types/operations.js';
import type { ResponseCost, TokenUsage } from '../types/response.js';
import { generateRequestId } from '../utils/ids.js';
import { Tokenizer } from '../utils/tokenizer.js';
import {
  acceptedModalities,
  assertLengths,
  type MediaUnits,
  mediaCost,
  normalizeInputs,
  totalUnits,
} from './inputs.js';
import { priceEmbeddingUsage, resolveEmbeddingModel } from './models.js';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 300_000;
/** Just past the 24-hour tier, so a batch that lands late is still collected. */
const DEFAULT_TIMEOUT_MS = 26 * 60 * 60 * 1000;

/** One input of an embedding batch, under the id its vector comes back by. */
export interface EmbeddingBatchItem {
  /** Echoed back with the vector. Required, and unique: a provider does not keep the order. */
  customId: string;
  /** A text, or parts holding media for a model that takes it. */
  input: string | EmbeddingParts;
}

/** A batch of inputs to embed through a provider's batch tier. */
export interface EmbeddingBatchSubmitRequest {
  /** The inputs. Every `customId` must be unique. */
  items: readonly EmbeddingBatchItem[];
  /** The concrete model. A batch tier takes no alias routing. */
  model: string;
  /** The adapter to use. Defaults to the manager's default. */
  provider?: string;
  /** What the vectors will be used for. */
  inputType?: EmbeddingInputType;
  /** Vector size to return, on models that can shorten theirs. */
  dimensions?: number;
  /** Scales every vector to unit length. */
  normalize?: boolean;
  /** How long the provider may take, in its own vocabulary. Defaults to `24h`. */
  completionWindow?: string;
  /** Replays the operation accepted under this key instead of submitting a second batch. */
  idempotencyKey?: string;
  /**
   * The tenant it runs for: its credentials, regions, and budget apply, and its ref records it, so
   * every later call on the batch uses the tenant's key.
   */
  tenantId?: string;
  /** Labels attached to the batch on the provider's side. */
  metadata?: Record<string, string>;
  /** Overrides the manager's poll interval. */
  pollIntervalMs?: number;
  /** Gives up waiting after this long. The provider-side batch is left running. */
  timeoutMs?: number;
  /** Stops waiting. The provider-side batch keeps running unless it is cancelled. */
  signal?: AbortSignal;
}

/** One input as an adapter receives it: its text, and its parts when the batch holds media. */
export interface EmbeddingBatchProviderItem {
  /** The id its vector comes back by. */
  customId: string;
  /** Its text: a string itself, or its text parts joined. */
  input: string;
  /** Its parts, media resolved to base64 or a URL, when the batch holds media. */
  contents?: EmbeddingProviderPart[];
}

/** A batch as an adapter receives it: inputs checked and resolved. */
export interface EmbeddingBatchProviderRequest {
  /** The inputs. */
  items: EmbeddingBatchProviderItem[];
  /** The provider's model name. */
  model: string;
  /** What the vectors will be used for. */
  inputType?: EmbeddingInputType;
  /** Vector size to return. */
  dimensions?: number;
  /** The completion window. */
  completionWindow?: string;
  /** Labels for the provider's side. */
  metadata?: Record<string, string>;
}

/** One input's outcome: its vector, or why it failed. */
export interface EmbeddingBatchOutputItem {
  /** The id of the input this answers. */
  customId: string;
  /** The vector, when the input succeeded. */
  vector?: number[];
  /** Why it failed, when it did. */
  error?: { message: string; code?: string; status?: number };
  /** Input tokens, when the provider reports them. */
  inputTokens?: number;
}

/** What an embedding batch tier supports: a batch tier's limits, and the media it takes. */
export interface EmbeddingBatchProviderCapabilities extends BatchProviderCapabilities {
  /** What its inputs can hold. Text only when absent. */
  inputModalities?: readonly EmbeddingModality[];
}

/** Identifies an embedding batch adapter and what it supports. */
export interface EmbeddingBatchProviderInfo {
  /** The adapter's name, which its refs carry. */
  name: string;
  /** What it supports. */
  capabilities: EmbeddingBatchProviderCapabilities;
}

/**
 * A provider's batch tier for embeddings. Everything after `submit` takes only a `BatchJobRef`, which
 * is JSON and survives a restart, so a worker can collect a batch it did not submit.
 */
export interface EmbeddingBatchProvider {
  /** What the adapter is and what it supports. */
  readonly info: EmbeddingBatchProviderInfo;
  /** Submits the batch and returns a reference that survives a restart. */
  submit(request: EmbeddingBatchProviderRequest, context: BatchProviderCallContext): Promise<BatchJobRef>;
  /** Reads the batch's current status. */
  poll(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState>;
  /** Every input's outcome, once the batch has finished. */
  results(ref: BatchJobRef, context: BatchProviderCallContext): Promise<EmbeddingBatchOutputItem[]>;
  /** Cancels a running batch. */
  cancel?(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState>;
}

/** A finished embedding batch: every input's outcome, its usage, and its cost at the batch price. */
export interface EmbeddingBatchResult {
  /** The batch. */
  ref: BatchJobRef;
  /** Its final status. */
  status: BatchJobStatus;
  /** Every input's outcome, matched by `customId`, never by position. */
  items: EmbeddingBatchOutputItem[];
  /** How many succeeded and failed. */
  counts: BatchCounts;
  /** Input tokens: reported where the provider reports them, estimated where it does not. */
  usage: TokenUsage;
  /** Priced from the embedding registry, with the provider's discount applied. */
  cost: ResponseCost;
  /** ISO-8601 time it was submitted. */
  createdAt?: string;
  /** ISO-8601 time it finished. */
  completedAt?: string;
  /** The provider's final status payload. */
  raw?: unknown;
}

/** Configuration for `EmbeddingBatchManager`. */
export interface EmbeddingBatchConfig {
  /** Adapters, by name. */
  providers?: Record<string, EmbeddingBatchProvider>;
  /** The adapter used when a submission names none. */
  defaultProvider?: string;
  /** How often to poll a running batch. Defaults to 30 seconds. */
  pollIntervalMs?: number;
  /** The longest poll interval once backoff has grown it. Defaults to 5 minutes. */
  maxPollIntervalMs?: number;
  /** How long a submission waits before giving up. Defaults to 26 hours. */
  timeoutMs?: number;
  /** Embedding models and prices beyond the bundled ones, used to check inputs and price results. */
  models?: EmbeddingModelRegistryConfig;
}

/** What the manager runs on. */
export interface EmbeddingBatchManagerRuntime {
  /** Persists each submission, so a submitted batch survives a restart. */
  operations?: OperationRunnerConfig<EmbeddingBatchResult>;
  /**
   * Runs every submission as one operation of a client's lifecycle, labelled `embedding`: pass
   * `ai.lifecycle`. It is authorized before the provider sees it, and its cost is reconciled when the
   * batch is collected.
   */
  lifecycle?: OperationLifecycleLike;
}

/** What the manager keeps on a ref, so whoever collects it can price and finish it. */
interface RefNotes {
  model?: string;
  estimatedInputTokens?: number;
  /** Images, from a batch submitted before media was measured; `media` holds them since. */
  images?: number;
  /** The batch's media, measured when it was submitted, for pricing. */
  media?: MediaUnits;
  normalize?: boolean;
  items?: number;
  /** The tenant the batch runs for, whose key every later call on it uses. */
  tenant?: string;
}

/**
 * Embedding batch tiers behind one handle: submit, poll with backoff, collect, and price at the
 * batch rate. A submission is a durable operation that records its batch the moment it exists, so a
 * worker that dies while it waits is replaced by one that collects that batch, never a second.
 */
export class EmbeddingBatchManager {
  private readonly providers = new Map<string, EmbeddingBatchProvider>();
  /** Loaded on the first `submit()`: `start()` and `resume()` need neither the runner nor the lifecycle. */
  private durable?: Promise<{
    runner: import('../operations/runner.js').OperationRunner<EmbeddingBatchResult>;
    withLifecycle: typeof import('../lifecycle/run.js').withLifecycle;
  }>;
  private readonly tokenizer = new Tokenizer();

  constructor(
    private readonly config: EmbeddingBatchConfig = {},
    private readonly runtime: EmbeddingBatchManagerRuntime = {},
  ) {
    for (const [name, provider] of Object.entries(config.providers ?? {}))
      this.registerEmbeddingBatchProvider(name, provider);
  }

  /** Registers an adapter under a name. Returns the manager, for chaining. */
  registerEmbeddingBatchProvider(name: string, provider: EmbeddingBatchProvider): this {
    const normalized = name.trim();
    if (!normalized) throw new BatchValidationError('Embedding batch provider name must not be empty');
    if (typeof provider?.submit !== 'function' || typeof provider.poll !== 'function') {
      throw new BatchValidationError(`Embedding batch provider "${normalized}" must implement submit() and poll()`);
    }
    this.providers.set(normalized, provider);
    return this;
  }

  /** Whether an adapter is registered. */
  hasEmbeddingBatchProvider(name: string): boolean {
    return this.providers.has(name);
  }

  /** Every registered adapter's name. */
  listEmbeddingBatchProviders(): string[] {
    return [...this.providers.keys()];
  }

  /**
   * Submits a batch and returns a durable handle that settles when the provider finishes, which can
   * be hours away: persist `handle.id`, rather than block a request on `handle.result()`.
   */
  async submit(request: EmbeddingBatchSubmitRequest): Promise<DurableOperationHandle<EmbeddingBatchResult>> {
    const [providerName, provider] = this.resolveProvider(request.provider);
    const prepared = this.prepare(request, providerName, provider);
    const requestId = generateRequestId();
    this.durable ??= Promise.all([import('../operations/runner.js'), import('../lifecycle/run.js')]).then(
      ([{ OperationRunner }, { withLifecycle }]) => ({
        runner: new OperationRunner<EmbeddingBatchResult>(this.runtime.operations ?? {}),
        withLifecycle,
      }),
    );
    const { runner, withLifecycle } = await this.durable;
    return runner.submit(
      (operation) =>
        withLifecycle(
          this.runtime.lifecycle,
          {
            family: 'embedding',
            operation: 'embedding.batch',
            requestId,
            provider: providerName,
            model: request.model,
            ...(request.tenantId !== undefined ? { tenantId: request.tenantId } : {}),
            metadata: { items: request.items.length },
          },
          { signal: operation.signal, ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}) },
          async (ticket) => {
            const context: BatchProviderCallContext = {
              ...ticket?.context,
              requestId,
              signal: operation.signal,
              idempotencyKey: request.idempotencyKey,
              attempt: operation.attempt,
            };
            // A batch an earlier attempt submitted is collected, never submitted again: the provider
            // would run, and bill, both. Its ref is recorded the moment it exists.
            let ref = (operation.previousHeartbeat as { batchRef?: BatchJobRef } | undefined)?.batchRef;
            if (!ref) {
              ref = withNotes(await provider.submit(prepared.request, context), prepared.notes);
              await operation.heartbeat({ batchRef: ref });
            }
            operation.report({ completed: 0, total: request.items.length, message: `submitted as ${ref.id}` });
            return this.collect(provider, ref, request.pollIntervalMs, context, operation);
          },
          (result) => ({ cost: result.cost.amount }),
        ),
      {
        kind: `embedding.batch.${providerName}`,
        idempotencyKey: request.idempotencyKey,
        signal: request.signal,
        timeoutMs: request.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        metadata: { provider: providerName, items: request.items.length },
      },
    );
  }

  /**
   * Submits a batch and returns its ref at once, without waiting: for a caller that keeps the ref
   * itself, as the ingestion pipeline does, and collects it later with `resume()`.
   */
  async start(request: EmbeddingBatchSubmitRequest): Promise<BatchJobRef> {
    const [providerName, provider] = this.resolveProvider(request.provider);
    const prepared = this.prepare(request, providerName, provider);
    return this.continuing('embedding.batch.submit', providerName, request.model, request.tenantId, async (context) =>
      withNotes(
        await provider.submit(prepared.request, {
          ...context,
          requestId: generateRequestId(),
          signal: request.signal ?? new AbortController().signal,
          idempotencyKey: request.idempotencyKey,
          attempt: 1,
        }),
        prepared.notes,
      ),
    );
  }

  /** Waits for a batch, submitted here or by another process, and collects it. */
  async resume(
    ref: BatchJobRef,
    options: { signal?: AbortSignal; pollIntervalMs?: number } = {},
  ): Promise<EmbeddingBatchResult> {
    const provider = this.providerFor(ref);
    return this.continuing(
      'embedding.batch.collect',
      ref.provider,
      notesOf(ref).model,
      notesOf(ref).tenant,
      (context) =>
        this.collect(provider, ref, options.pollIntervalMs, {
          ...context,
          requestId: generateRequestId(),
          signal: options.signal ?? new AbortController().signal,
          attempt: 1,
        }),
    );
  }

  /** The batch's state now, without waiting. */
  async status(ref: BatchJobRef): Promise<BatchJobState> {
    return this.continuing('embedding.batch.status', ref.provider, notesOf(ref).model, notesOf(ref).tenant, (context) =>
      this.providerFor(ref).poll(ref, {
        ...context,
        requestId: generateRequestId(),
        signal: new AbortController().signal,
        attempt: 1,
      }),
    );
  }

  /** Cancels a batch. Throws when the adapter cannot cancel. */
  async cancel(ref: BatchJobRef): Promise<BatchJobState> {
    const provider = this.providerFor(ref);
    const cancel = provider.cancel;
    if (!cancel) throw new BatchCapabilityError(ref.provider, 'cancel');
    return this.continuing('embedding.batch.cancel', ref.provider, notesOf(ref).model, notesOf(ref).tenant, (context) =>
      cancel.call(provider, ref, {
        ...context,
        requestId: generateRequestId(),
        signal: new AbortController().signal,
        attempt: 1,
      }),
    );
  }

  /** A call on a batch outside its operation: with its tenant's key, inside its regions. */
  private continuing<T>(
    operation: string,
    provider: string,
    model: string | undefined,
    tenant: string | undefined,
    call: (context: ContinuedFields) => Promise<T>,
  ): Promise<T> {
    return continuing(
      this.runtime.lifecycle,
      {
        family: 'embedding',
        operation,
        provider,
        ...(model !== undefined ? { model } : {}),
        ...(tenant !== undefined ? { tenantId: tenant } : {}),
      },
      call,
    );
  }

  // ── Internals ────────────────────────────────────────────────────

  private prepare(
    request: EmbeddingBatchSubmitRequest,
    providerName: string,
    provider: EmbeddingBatchProvider,
  ): { request: EmbeddingBatchProviderRequest; notes: RefNotes } {
    if (!Array.isArray(request.items) || request.items.length === 0) {
      throw new BatchValidationError('An embedding batch must contain at least one item');
    }
    if (!request.model?.trim()) throw new BatchValidationError('An embedding batch names its concrete model');
    const seen = new Set<string>();
    for (const item of request.items) {
      if (!item?.customId?.trim())
        throw new BatchValidationError('Every embedding batch item carries a non-empty customId');
      if (seen.has(item.customId))
        throw new BatchValidationError(`Duplicate embedding batch customId "${item.customId}"`);
      seen.add(item.customId);
    }
    const maxItems = provider.info.capabilities.maxItems;
    if (maxItems !== undefined && request.items.length > maxItems) {
      throw new BatchCapabilityError(
        providerName,
        'maxItems',
        `Embedding batch provider "${providerName}" accepts at most ${maxItems} inputs, received ${request.items.length}`,
      );
    }
    const inputs = normalizeInputs(request.items.map((item) => item.input));
    const model = resolveEmbeddingModel(request.model, this.config.models).capabilities;
    const accepted = acceptedModalities(model, provider.info.capabilities);
    const refused = [...inputs.media].filter((kind) => !accepted.includes(kind));
    if (refused.length) {
      throw new BatchCapabilityError(
        providerName,
        'input',
        `Embedding model "${request.model}" in the "${providerName}" batch tier takes ${accepted.join(', ')} input, not ${refused.join(' or ')}`,
      );
    }
    try {
      assertLengths(inputs, request.model, model);
    } catch (error) {
      throw new BatchCapabilityError(providerName, 'input', (error as Error).message);
    }
    const parts = inputs.parts;
    let estimatedInputTokens = 0;
    for (const text of inputs.texts) estimatedInputTokens += this.tokenizer.estimateTextTokens(text);
    return {
      request: {
        items: request.items.map((item, index) => ({
          customId: item.customId,
          input: inputs.texts[index] as string,
          ...(parts ? { contents: parts[index] } : {}),
        })),
        model: request.model,
        ...(request.inputType ? { inputType: request.inputType } : {}),
        ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
        ...(request.completionWindow ? { completionWindow: request.completionWindow } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
      },
      notes: {
        model: request.model,
        estimatedInputTokens,
        media: totalUnits(inputs.units),
        items: request.items.length,
        ...(request.normalize ? { normalize: true } : {}),
        ...(request.tenantId !== undefined ? { tenant: request.tenantId } : {}),
      },
    };
  }

  private async collect(
    provider: EmbeddingBatchProvider,
    ref: BatchJobRef,
    pollIntervalMs: number | undefined,
    context: BatchProviderCallContext,
    operation?: { report: (progress: { completed?: number; total?: number; message?: string }) => void },
  ): Promise<EmbeddingBatchResult> {
    const state = await pollUntilSettled(() => provider.poll(ref, context), {
      intervalMs: pollIntervalMs ?? this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxIntervalMs: this.config.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS,
      signal: context.signal,
      onState: (current) =>
        operation?.report({
          completed: current.counts?.completed,
          total: current.counts?.total,
          message: current.status,
        }),
    });
    const notes = (ref.metadata?.embedding ?? {}) as RefNotes;
    const items = state.status === 'completed' ? await provider.results(ref, context) : [];
    if (notes.normalize) {
      for (const item of items) if (item.vector) item.vector = unitLength(item.vector);
    }
    let completed = 0;
    let reported = 0;
    let reports = true;
    for (const item of items) {
      if (item.error) continue;
      completed += 1;
      if (item.inputTokens === undefined) reports = false;
      else reported += item.inputTokens;
    }
    const counts = state.counts ?? { total: notes.items ?? items.length, completed, failed: items.length - completed };
    // Reported where the provider reports, estimated where it does not: never priced at zero.
    const inputTokens = reports && completed > 0 ? reported : (notes.estimatedInputTokens ?? 0);
    const usage: TokenUsage = { inputTokens, outputTokens: 0, totalTokens: inputTokens };
    operation?.report({ completed: counts.completed, total: counts.total, message: state.status });
    return {
      ref,
      status: state.status,
      items,
      counts,
      usage,
      cost: this.price(usage, notes, provider),
      createdAt: state.createdAt,
      completedAt: state.completedAt,
      raw: state.raw,
    };
  }

  private price(usage: TokenUsage, notes: RefNotes, provider: EmbeddingBatchProvider): ResponseCost {
    const discount = provider.info.capabilities.discount ?? 1;
    if (!notes.model) return { amount: 0, currency: 'USD', basis: 'estimated' };
    const cost = priceEmbeddingUsage(notes.model, usage, this.config.models);
    const media = notes.media ?? { images: notes.images ?? 0, audio: [], video: [], unmeasured: 0 };
    const amount =
      (cost.amount + mediaCost(media, resolveEmbeddingModel(notes.model, this.config.models).capabilities)) * discount;
    return { ...cost, amount, input: amount, output: 0 };
  }

  private resolveProvider(preferred?: string): [string, EmbeddingBatchProvider] {
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

  /** The adapter a ref belongs to: by its registered name, or the adapter's own name the ref carries. */
  private providerFor(ref: BatchJobRef): EmbeddingBatchProvider {
    const provider =
      this.providers.get(ref.provider) ?? [...this.providers.values()].find((item) => item.info.name === ref.provider);
    if (!provider) throw new BatchProviderNotFoundError(ref.provider);
    return provider;
  }
}

function withNotes(ref: BatchJobRef, notes: RefNotes): BatchJobRef {
  return { ...ref, metadata: { ...ref.metadata, embedding: notes } };
}

function notesOf(ref: BatchJobRef): RefNotes {
  return (ref.metadata?.embedding ?? {}) as RefNotes;
}

function unitLength(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const length = Math.sqrt(sum);
  return length ? vector.map((value) => value / length) : vector;
}

/** What `batchEmbedder()` submits under. */
export interface BatchEmbedderOptions {
  /** The concrete model. */
  model: string;
  /** The adapter. Defaults to the manager's default. */
  provider?: string;
  /** What the vectors will be used for. Ingestion stores documents, so defaults to `document`. */
  inputType?: EmbeddingInputType;
  /** Vector size to return. */
  dimensions?: number;
  /** Scales every vector to unit length. */
  normalize?: boolean;
  /** Texts per provider batch. Defaults to 10,000. */
  size?: number;
  /** How often to poll. Defaults to the manager's interval. */
  pollIntervalMs?: number;
}

/** What `createIngestionPipeline()` takes as `batchEmbed`: submit texts as one batch, collect it later. */
export interface BatchEmbedder {
  /** Texts per provider batch. */
  readonly size: number;
  /** Submits texts as one batch, labelled with `key`, and returns its ref, which survives a restart. */
  submit(texts: string[], key: string): Promise<BatchJobRef>;
  /** Waits for a batch and returns its vectors, in the order its texts were submitted. */
  collect(ref: BatchJobRef, signal?: AbortSignal): Promise<number[][]>;
}

/**
 * An embedding batch tier as the ingestion pipeline's `batchEmbed`: each window of chunks becomes one
 * provider batch at the batch price. A batch that does not complete, or any input that fails, fails
 * the collection, so a window is never written half embedded.
 */
export function batchEmbedder(manager: EmbeddingBatchManager, options: BatchEmbedderOptions): BatchEmbedder {
  const size = options.size ?? 10_000;
  if (!(Number.isSafeInteger(size) && size > 0)) throw new RangeError('size must be a positive integer');
  return {
    size,
    submit: (texts, key) =>
      manager.start({
        items: texts.map((input, index) => ({ customId: String(index), input })),
        model: options.model,
        inputType: options.inputType ?? 'document',
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.dimensions !== undefined ? { dimensions: options.dimensions } : {}),
        ...(options.normalize ? { normalize: true } : {}),
        metadata: { key },
      }),
    async collect(ref, signal) {
      const result = await manager.resume(ref, {
        ...(signal ? { signal } : {}),
        ...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
      });
      if (result.status !== 'completed') {
        throw new Error(`Embedding batch ${ref.id} ended ${result.status}, so its window was not written`);
      }
      const vectors: number[][] = [];
      for (const item of result.items) {
        if (!item.vector) {
          throw new Error(
            `Embedding batch ${ref.id} failed input ${item.customId}: ${item.error?.message ?? 'no vector'}`,
          );
        }
        vectors[Number(item.customId)] = item.vector;
      }
      const expected = (ref.metadata?.embedding as RefNotes | undefined)?.items ?? vectors.length;
      if (vectors.length !== expected || vectors.some((vector) => vector === undefined)) {
        throw new Error(`Embedding batch ${ref.id} returned ${result.items.length} vectors for ${expected} inputs`);
      }
      return vectors;
    },
  };
}
