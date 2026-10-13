import { BatchCapabilityError, BatchProviderResponseError } from '../batch/errors.js';
import type { BatchJobRef, BatchJobState, BatchJobStatus, BatchProviderCallContext } from '../types/batch.js';
import type {
  EmbeddingBatchOutputItem,
  EmbeddingBatchProvider,
  EmbeddingBatchProviderInfo,
  EmbeddingBatchProviderRequest,
} from './batch.js';
import { GOOGLE_TASK_TYPES, googleParts, usesTaskPrefix } from './google-wire.js';

/** Options for Gemini's embedding batch tier. */
export interface GoogleEmbeddingBatchProviderOptions {
  /** Gemini API key, sent as `x-goog-api-key`. */
  apiKey: string;
  /** API base URL. Defaults to `https://generativelanguage.googleapis.com/v1beta`. */
  baseUrl?: string;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
}

/** Inline requests in one batch must stay under 20 MB. */
const INLINE_BYTES = 20 * 1024 * 1024;

/** Google reports a batch's state as `BATCH_STATE_*` on the wire and `JOB_STATE_*` in its clients. */
const STATES: Record<string, BatchJobStatus> = {
  PENDING: 'validating',
  RUNNING: 'in_progress',
  SUCCEEDED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
};

interface GoogleBatch {
  name?: string;
  state?: string;
  createTime?: string;
  endTime?: string;
  batchStats?: Record<string, string | number | undefined>;
  output?: {
    responsesFile?: string;
    inlinedEmbedContentResponses?: {
      inlinedResponses?: Array<{
        response?: { embedding?: { values?: number[] } };
        error?: { message?: string; code?: number | string };
      }>;
    };
  };
  metadata?: GoogleBatch;
  error?: { message?: string; code?: number | string };
}

/**
 * Gemini's Batch API for embeddings (`asyncBatchEmbedContent`): half price, inline requests under
 * 20 MB, and results inline, in the order submitted. It takes text, images, audio, and PDFs on a model
 * that does, such as gemini-embedding-2. The wire shape follows Google's API reference and its own
 * clients; it graduates with a recorded live run.
 */
export class GoogleEmbeddingBatchProvider implements EmbeddingBatchProvider {
  /** Always `google`, with its batch limits. */
  readonly info: EmbeddingBatchProviderInfo = {
    name: 'google',
    capabilities: {
      maxBytes: INLINE_BYTES,
      supportsCancel: true,
      discount: 0.5,
      inputModalities: ['text', 'image', 'audio', 'document'],
    },
  };

  constructor(private readonly options: GoogleEmbeddingBatchProviderOptions) {}

  /**
   * Sends every input inline as one batch. Results come back in the same order, so the ref keeps the
   * ids in that order.
   */
  async submit(request: EmbeddingBatchProviderRequest, context: BatchProviderCallContext): Promise<BatchJobRef> {
    const qualified = request.model.startsWith('models/') ? request.model : `models/${request.model}`;
    const prefixed = usesTaskPrefix(request.model);
    const body = JSON.stringify({
      batch: {
        displayName: request.metadata?.key ?? 'nexus-embeddings',
        inputConfig: {
          requests: {
            requests: request.items.map((item) => ({
              request: {
                model: qualified,
                content: {
                  parts: googleParts(
                    item.contents ?? [{ type: 'text', text: item.input }],
                    prefixed ? request.inputType : undefined,
                  ),
                },
                ...(request.inputType && !prefixed ? { taskType: GOOGLE_TASK_TYPES[request.inputType] } : {}),
                ...(request.dimensions !== undefined ? { outputDimensionality: request.dimensions } : {}),
              },
            })),
          },
        },
      },
    });
    if (body.length > INLINE_BYTES) {
      throw new BatchCapabilityError(
        'google',
        'maxBytes',
        `An inline Gemini batch holds at most 20 MB; this one is ${Math.ceil(body.length / 1024 / 1024)} MB, so split it`,
      );
    }
    const created = (await this.request(
      `/${qualified}:asyncBatchEmbedContent`,
      { method: 'POST', body },
      context,
    )) as GoogleBatch;
    const name = created.name ?? created.metadata?.name;
    if (!name) throw new BatchProviderResponseError('google', 'the batch response returned no name');
    return { id: name, provider: 'google', metadata: { customIds: request.items.map((item) => item.customId) } };
  }

  /** Reads a batch's state and counts. */
  async poll(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState> {
    return this.state(ref, await this.read(ref, context));
  }

  /** Every input's vector or error, matched to its id by position. */
  async results(ref: BatchJobRef, context: BatchProviderCallContext): Promise<EmbeddingBatchOutputItem[]> {
    const batch = await this.read(ref, context);
    const output = batch.output;
    if (output?.responsesFile) {
      throw new BatchProviderResponseError(
        'google',
        'the batch wrote its results to a file; this adapter reads inline results',
      );
    }
    const ids = (ref.metadata?.customIds ?? []) as string[];
    const responses = output?.inlinedEmbedContentResponses?.inlinedResponses ?? [];
    return responses.map((entry, index) => {
      const customId = ids[index] ?? String(index);
      const values = entry.response?.embedding?.values;
      if (Array.isArray(values)) return { customId, vector: values };
      return {
        customId,
        error: {
          message: entry.error?.message ?? 'the response carried no embedding',
          ...(entry.error?.code !== undefined ? { code: String(entry.error.code) } : {}),
        },
      };
    });
  }

  /** Cancels a batch. */
  async cancel(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState> {
    await this.request(`/${ref.id}:cancel`, { method: 'POST' }, context);
    return this.poll(ref, context);
  }

  /** The batch resource, whether Google answers with it or with an operation that holds it. */
  private async read(ref: BatchJobRef, context: BatchProviderCallContext): Promise<GoogleBatch> {
    const answer = (await this.request(`/${ref.id}`, {}, context)) as GoogleBatch;
    return { ...answer, ...answer.metadata };
  }

  private state(ref: BatchJobRef, batch: GoogleBatch): BatchJobState {
    const status = STATES[(batch.state ?? '').replace(/^(BATCH|JOB)_STATE_/, '')] ?? 'in_progress';
    const stats = batch.batchStats;
    const count = (key: string) => Number(stats?.[key] ?? 0);
    return {
      ref,
      status,
      ...(stats
        ? {
            counts: {
              total: count('requestCount'),
              completed: count('successfulRequestCount'),
              failed: count('failedRequestCount'),
            },
          }
        : {}),
      ...(batch.createTime ? { createdAt: batch.createTime } : {}),
      ...(batch.endTime ? { completedAt: batch.endTime } : {}),
      ...(batch.error
        ? { error: { message: batch.error.message ?? 'batch failed', code: String(batch.error.code ?? '') } }
        : {}),
      raw: batch,
    };
  }

  private async request(path: string, init: RequestInit, context: BatchProviderCallContext): Promise<unknown> {
    const fetchImpl = this.options.fetch ?? fetch;
    const base = (this.options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    const response = await fetchImpl(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.options.apiKey, ...this.options.headers },
      signal: context.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new BatchProviderResponseError('google', `${path} failed: ${response.status} ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : {};
  }
}
