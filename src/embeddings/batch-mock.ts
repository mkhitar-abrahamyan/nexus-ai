import { createHashEmbeddings } from '../hallucination/retrieval.js';
import type { BatchJobRef, BatchJobState, BatchJobStatus, BatchProviderCallContext } from '../types/batch.js';
import type { EmbeddingProviderMediaPart } from '../types/embeddings.js';
import type {
  EmbeddingBatchOutputItem,
  EmbeddingBatchProvider,
  EmbeddingBatchProviderCapabilities,
  EmbeddingBatchProviderInfo,
  EmbeddingBatchProviderRequest,
} from './batch.js';

/** Options for the mock embedding batch tier. */
export interface MockEmbeddingBatchProviderOptions {
  /** Its name, which its refs carry. Defaults to `mock`. */
  name?: string;
  /** Capabilities reported, merged over the defaults. */
  capabilities?: Partial<EmbeddingBatchProviderCapabilities>;
  /**
   * Statuses successive polls of a batch return; the last repeats, so `['in_progress', 'completed']`
   * finishes on the second poll. Defaults to completing at once.
   */
  statuses?: readonly BatchJobStatus[];
  /** customIds that come back as errors instead of vectors. */
  failItems?: readonly string[];
  /** Vector width when the request sets none. Defaults to 16. */
  dimensions?: number;
  /** Reports input tokens per item, a word count. Defaults to true; false leaves the cost to be estimated. */
  reportTokens?: boolean;
  /** The text a media part's vector is hashed from, as `MockEmbeddingProviderOptions.describeMedia`. */
  describeMedia?: (part: EmbeddingProviderMediaPart) => string;
}

/**
 * A deterministic embedding batch tier, in memory. Each input's vector is the one
 * `MockEmbeddingProvider` returns for it, so a test can compare the batch path with the direct one. It
 * keeps every batch it was given in `submitted`.
 */
export class MockEmbeddingBatchProvider implements EmbeddingBatchProvider {
  /** Its name and capabilities. */
  readonly info: EmbeddingBatchProviderInfo;
  /** Every batch submitted, in order. */
  readonly submitted: EmbeddingBatchProviderRequest[] = [];
  private readonly batches = new Map<
    string,
    { request: EmbeddingBatchProviderRequest; polls: number; cancelled?: boolean }
  >();

  constructor(private readonly options: MockEmbeddingBatchProviderOptions = {}) {
    this.info = {
      name: options.name ?? 'mock',
      capabilities: {
        maxItems: 50_000,
        supportsCancel: true,
        discount: 0.5,
        inputModalities: ['text', 'image', 'audio', 'document'],
        ...options.capabilities,
      },
    };
  }

  /** Accepts a batch and returns its ref. */
  async submit(request: EmbeddingBatchProviderRequest, context: BatchProviderCallContext): Promise<BatchJobRef> {
    if (context.signal.aborted) throw context.signal.reason ?? new Error('aborted');
    this.submitted.push(request);
    const id = `mock-batch-${this.submitted.length}`;
    this.batches.set(id, { request, polls: 0 });
    return { id, provider: this.info.name };
  }

  /** The next scripted status. */
  async poll(ref: BatchJobRef): Promise<BatchJobState> {
    const batch = this.batches.get(ref.id);
    if (!batch) throw new Error(`no mock batch ${ref.id}`);
    const statuses = this.options.statuses ?? ['completed'];
    const status = batch.cancelled
      ? 'cancelled'
      : (statuses[Math.min(batch.polls, statuses.length - 1)] ?? 'completed');
    batch.polls += 1;
    const total = batch.request.items.length;
    const failed = (this.options.failItems ?? []).filter((id) =>
      batch.request.items.some((item) => item.customId === id),
    ).length;
    return {
      ref,
      status,
      counts:
        status === 'completed' ? { total, completed: total - failed, failed } : { total, completed: 0, failed: 0 },
    };
  }

  /** Every input's vector, or its scripted failure. */
  async results(ref: BatchJobRef): Promise<EmbeddingBatchOutputItem[]> {
    const batch = this.batches.get(ref.id);
    if (!batch) throw new Error(`no mock batch ${ref.id}`);
    const { request } = batch;
    const describe =
      this.options.describeMedia ??
      ((part: EmbeddingProviderMediaPart) => `${part.type} ${(part.data ?? part.url)?.slice(0, 64)}`);
    const texts = request.items.map((item) =>
      item.contents
        ? item.contents.map((part) => (part.type === 'text' ? part.text : describe(part))).join(' ')
        : item.input,
    );
    const vectors = createHashEmbeddings(texts, request.dimensions ?? this.options.dimensions ?? 16);
    const failures = new Set(this.options.failItems ?? []);
    return request.items.map((item, index) =>
      failures.has(item.customId)
        ? { customId: item.customId, error: { message: 'scripted failure', code: 'mock_failure' } }
        : {
            customId: item.customId,
            vector: vectors[index] as number[],
            ...(this.options.reportTokens === false ? {} : { inputTokens: (texts[index] ?? '').split(/\s+/).length }),
          },
    );
  }

  /** Cancels a batch: its next poll reports `cancelled`. */
  async cancel(ref: BatchJobRef): Promise<BatchJobState> {
    const batch = this.batches.get(ref.id);
    if (batch) batch.cancelled = true;
    return { ref, status: 'cancelled' };
  }
}
