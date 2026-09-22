import type {
  BatchJobRef,
  BatchJobState,
  BatchJobStatus,
  BatchOutputItem,
  BatchProvider,
  BatchProviderCallContext,
  BatchProviderCapabilities,
  BatchProviderInfo,
  BatchSubmitRequest,
} from '../types/batch.js';
import { buildMeta } from '../core/usage.js';

/** Options for the mock batch provider. */
export interface MockBatchProviderOptions {
  /** Provider name. Defaults to `mock`. */
  name?: string;
  /** Capabilities reported, merged over the defaults. */
  capabilities?: Partial<BatchProviderCapabilities>;
  /**
   * Statuses returned by successive `poll()` calls. The last is repeated once exhausted, so
   * `['in_progress', 'completed']` finishes on the second poll.
   */
  statuses?: readonly BatchJobStatus[];
  /** customIds that come back as errors instead of responses. */
  failItems?: readonly string[];
  /** Tokens reported per successful item. */
  tokensPerItem?: { input: number; output: number };
  /** Model reported on responses when an item names none. Defaults to `mock-model`. */
  model?: string;
}

/**
 * Deterministic, network-free batch provider.
 *
 * Lets a test drive a full submit-poll-collect cycle in milliseconds, including a mixed batch where
 * some items fail, without a provider account or a 24-hour wait.
 */
export class MockBatchProvider implements BatchProvider {
  /** Provider name and capabilities. */
  readonly info: BatchProviderInfo;
  /** Every submitted batch, keyed by its generated id. */
  readonly submitted = new Map<string, BatchSubmitRequest>();
  private pollCounts = new Map<string, number>();
  private cancelled = new Set<string>();
  private counter = 0;

  constructor(private readonly options: MockBatchProviderOptions = {}) {
    this.info = {
      name: options.name ?? 'mock',
      capabilities: {
        maxItems: 100,
        completionWindows: ['24h'],
        supportsCancel: true,
        discount: 0.5,
        ...options.capabilities,
      },
    };
  }

  /** Number of times `poll()` was called for a batch. */
  pollCount(id: string): number {
    return this.pollCounts.get(id) ?? 0;
  }

  /** Records a batch and returns a generated id. */
  async submit(request: BatchSubmitRequest, _context: BatchProviderCallContext): Promise<BatchJobRef> {
    this.counter += 1;
    const id = `mock-batch-${this.counter}`;
    this.submitted.set(id, request);
    return { id, provider: this.info.name };
  }

  /** Returns the next scripted status. Defaults to `completed` immediately. */
  async poll(ref: BatchJobRef, _context: BatchProviderCallContext): Promise<BatchJobState> {
    const seen = (this.pollCounts.get(ref.id) ?? 0) + 1;
    this.pollCounts.set(ref.id, seen);

    if (this.cancelled.has(ref.id)) {
      return { ref, status: 'cancelled', counts: this.counts(ref) };
    }

    const statuses = this.options.statuses ?? (['completed'] as const);
    const status = statuses[Math.min(seen - 1, statuses.length - 1)] as BatchJobStatus;
    return {
      ref,
      status,
      counts: this.counts(ref),
      createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: status === 'completed' ? '2026-01-01T01:00:00.000Z' : undefined,
    };
  }

  /** A response per item, or an error for items in `failItems`. */
  async results(ref: BatchJobRef, _context: BatchProviderCallContext): Promise<BatchOutputItem[]> {
    const request = this.submitted.get(ref.id);
    if (!request) return [];
    const failing = new Set(this.options.failItems ?? []);
    const tokens = this.options.tokensPerItem ?? { input: 10, output: 5 };

    return request.items.map((item) => {
      if (failing.has(item.customId)) {
        return { customId: item.customId, error: { message: 'mock item failure', code: 'mock_error' } };
      }
      return {
        customId: item.customId,
        response: {
          content: `echo:${item.customId}`,
          role: 'assistant' as const,
          finishReason: 'stop' as const,
          meta: buildMeta({
            provider: this.info.name,
            model: item.request.model || request.model || this.options.model || 'mock-model',
            latencyMs: 0,
            inputTokens: tokens.input,
            outputTokens: tokens.output,
          }),
        },
      };
    });
  }

  /** Marks a batch cancelled. */
  async cancel(ref: BatchJobRef, _context: BatchProviderCallContext): Promise<BatchJobState> {
    this.cancelled.add(ref.id);
    return { ref, status: 'cancelled', counts: this.counts(ref) };
  }

  private counts(ref: BatchJobRef): { total: number; completed: number; failed: number } {
    const request = this.submitted.get(ref.id);
    const total = request?.items.length ?? 0;
    const failing = new Set(this.options.failItems ?? []);
    const failed = request?.items.filter((item) => failing.has(item.customId)).length ?? 0;
    return { total, completed: total - failed, failed };
  }
}
