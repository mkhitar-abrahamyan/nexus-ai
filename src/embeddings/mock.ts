import type {
  EmbeddingProviderCallContext,
  EmbeddingProviderCapabilities,
  EmbeddingProviderInfo,
  EmbeddingProviderRequest,
  EmbeddingProviderResult,
  EmbeddingsProvider,
} from '../types/embeddings.js';
import { createHashEmbeddings } from '../hallucination/retrieval.js';

export interface MockEmbeddingProviderOptions {
  name?: string;
  defaultModel?: string;
  dimensions?: number;
  capabilities?: Partial<EmbeddingProviderCapabilities>;
  /** Reported input tokens per call. Defaults to a word count, so cost is non-zero and testable. */
  usage?: (request: EmbeddingProviderRequest) => { inputTokens?: number; totalTokens?: number };
  /** Thrown on the matching call, counting from 1, to exercise retry and failover. */
  failOn?: { attempt: number; error: unknown };
  /** Milliseconds to wait before answering, for timeout and cancellation tests. */
  latencyMs?: number;
}

/**
 * Deterministic, network-free embeddings adapter.
 *
 * The same text always produces the same vector, so a test can assert on cache hits, batching, and
 * deduplication without a provider account. It records every call it received.
 */
export class MockEmbeddingProvider implements EmbeddingsProvider {
  readonly info: EmbeddingProviderInfo;
  /** Every provider request this instance received, in call order. */
  readonly calls: EmbeddingProviderRequest[] = [];
  private attempts = 0;

  constructor(private readonly options: MockEmbeddingProviderOptions = {}) {
    this.info = {
      name: options.name || 'mock',
      isLocal: true,
      defaultModel: options.defaultModel || 'mock-embedding',
      capabilities: {
        models: [options.defaultModel || 'mock-embedding'],
        maxBatchSize: 8,
        dimensions: true,
        encodingFormats: ['float'],
        inputTypes: ['document', 'query', 'classification', 'clustering'],
        truncate: true,
        ...options.capabilities,
      },
    };
  }

  /** Number of provider calls made, including ones that threw. */
  get callCount(): number {
    return this.attempts;
  }

  async embed(
    request: EmbeddingProviderRequest,
    context: EmbeddingProviderCallContext,
  ): Promise<EmbeddingProviderResult> {
    this.attempts += 1;
    this.calls.push(request);

    // A real adapter's fetch rejects on an already-aborted signal, so the mock does too; otherwise
    // cancellation tests would pass against the mock and fail in production.
    if (context.signal.aborted) throw context.signal.reason ?? new Error('aborted');

    if (this.options.failOn && this.options.failOn.attempt === this.attempts) {
      throw this.options.failOn.error;
    }

    if (this.options.latencyMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.options.latencyMs);
        context.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(context.signal.reason ?? new Error('aborted'));
          },
          { once: true },
        );
      });
    }

    const dimensions = request.dimensions ?? this.options.dimensions ?? 16;
    const vectors = createHashEmbeddings([...request.input], dimensions);
    const words = request.input.reduce((total, text) => total + text.split(/\s+/).length, 0);

    return {
      vectors,
      model: request.model,
      usage: this.options.usage?.(request) ?? { inputTokens: words, totalTokens: words },
      raw: { mock: true, batchIndex: context.batchIndex },
    };
  }
}
