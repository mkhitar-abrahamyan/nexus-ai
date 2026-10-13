import { lineError, OpenAIBatchClient, type OpenAIBatchClientOptions } from '../batch/openai-client.js';
import type { BatchJobRef, BatchJobState, BatchProviderCallContext } from '../types/batch.js';
import type {
  EmbeddingBatchOutputItem,
  EmbeddingBatchProvider,
  EmbeddingBatchProviderInfo,
  EmbeddingBatchProviderRequest,
} from './batch.js';

/** Options for OpenAI's embedding batch tier: the key, and optionally the base URL, organization, and `fetch`. */
export type OpenAIEmbeddingBatchProviderOptions = OpenAIBatchClientOptions;

/**
 * OpenAI's Batch API for `/v1/embeddings`: half price, a 24-hour window, and at most 50,000 inputs a
 * batch. Each input is one line; failed lines are read from the error file, so none goes missing.
 */
export class OpenAIEmbeddingBatchProvider implements EmbeddingBatchProvider {
  /** Always `openai`, with its batch limits. */
  readonly info: EmbeddingBatchProviderInfo = {
    name: 'openai',
    capabilities: {
      maxItems: 50_000,
      maxBytes: 200 * 1024 * 1024,
      completionWindows: ['24h'],
      supportsCancel: true,
      discount: 0.5,
      inputModalities: ['text'],
    },
  };
  private readonly client: OpenAIBatchClient;

  constructor(options: OpenAIEmbeddingBatchProviderOptions) {
    this.client = new OpenAIBatchClient(options);
  }

  /** Uploads one line per input and creates a batch over them. */
  async submit(request: EmbeddingBatchProviderRequest, context: BatchProviderCallContext): Promise<BatchJobRef> {
    const { batch, fileId } = await this.client.create(
      request.items.map((item) => ({
        custom_id: item.customId,
        method: 'POST',
        url: '/v1/embeddings',
        body: {
          model: request.model,
          input: item.input,
          encoding_format: 'float',
          ...(request.dimensions !== undefined ? { dimensions: request.dimensions } : {}),
        },
      })),
      { endpoint: '/v1/embeddings', completionWindow: request.completionWindow, metadata: request.metadata },
      context,
    );
    return { id: batch.id as string, provider: 'openai', metadata: { inputFileId: fileId } };
  }

  /** Reads a batch's status and counts. */
  async poll(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState> {
    return this.client.state(ref, await this.client.read(ref.id, context));
  }

  /** Every input's vector or error, from the output and error files. */
  async results(ref: BatchJobRef, context: BatchProviderCallContext): Promise<EmbeddingBatchOutputItem[]> {
    return (await this.client.lines(ref.id, context)).map((line) => {
      const customId = line.custom_id ?? '';
      const error = lineError(line);
      if (error) return { customId, error };
      const body = line.response?.body as {
        data?: Array<{ embedding?: number[] }>;
        usage?: { prompt_tokens?: number };
      };
      const vector = body.data?.[0]?.embedding;
      if (!Array.isArray(vector)) return { customId, error: { message: 'the line carried no embedding' } };
      return {
        customId,
        vector,
        ...(body.usage?.prompt_tokens !== undefined ? { inputTokens: body.usage.prompt_tokens } : {}),
      };
    });
  }

  /** Cancels a batch. Inputs already embedded keep their results. */
  async cancel(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState> {
    return this.client.state(ref, await this.client.cancel(ref.id, context));
  }
}
