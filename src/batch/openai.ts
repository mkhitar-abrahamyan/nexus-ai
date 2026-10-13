import type {
  BatchJobRef,
  BatchJobState,
  BatchOutputItem,
  BatchProvider,
  BatchProviderCallContext,
  BatchProviderInfo,
  BatchSubmitRequest,
} from '../types/batch.js';
import type { NexusResponse } from '../types/response.js';
import { buildMeta } from '../core/usage.js';
import { BatchCapabilityError } from './errors.js';
import { lineError, OpenAIBatchClient, type OpenAIBatchClientOptions, type OpenAIBatchLine } from './openai-client.js';

/** Options for the OpenAI batch provider. */
export interface OpenAIBatchProviderOptions extends OpenAIBatchClientOptions {
  /**
   * Endpoint every item targets. Defaults to chat completions. Embeddings are batched by
   * `OpenAIEmbeddingBatchProvider`, on `nexus-ai-pro/embeddings/batch/openai`; this adapter refuses
   * `/v1/embeddings`, since its items are completions.
   */
  endpoint?: '/v1/chat/completions' | '/v1/embeddings' | (string & {});
}

/**
 * OpenAI's Batch API: half price, 24-hour window.
 *
 * The wire protocol is a JSONL upload, a batch pointing at it, then JSONL downloads of what succeeded
 * and what failed — three different content types across four endpoints, which is why this adapter
 * is larger than a synchronous one.
 */
export class OpenAIBatchProvider implements BatchProvider {
  /** Always `openai`, with its batch limits. */
  readonly info: BatchProviderInfo = {
    name: 'openai',
    capabilities: {
      maxItems: 50_000,
      maxBytes: 200 * 1024 * 1024,
      completionWindows: ['24h'],
      supportsCancel: true,
      discount: 0.5,
    },
  };
  private readonly client: OpenAIBatchClient;

  constructor(private readonly options: OpenAIBatchProviderOptions) {
    this.client = new OpenAIBatchClient(options);
  }

  /** Uploads the items as JSONL and creates a batch over them. */
  async submit(request: BatchSubmitRequest, context: BatchProviderCallContext): Promise<BatchJobRef> {
    const endpoint = this.options.endpoint ?? '/v1/chat/completions';
    if (endpoint === '/v1/embeddings') {
      throw new BatchCapabilityError(
        'openai',
        'endpoint',
        'OpenAIBatchProvider batches completions; batch embeddings with OpenAIEmbeddingBatchProvider from nexus-ai-pro/embeddings/batch/openai',
      );
    }
    const { batch, fileId } = await this.client.create(
      request.items.map((item) => ({
        custom_id: item.customId,
        method: 'POST',
        url: endpoint,
        body: {
          model: item.request.model || request.model,
          messages: item.request.messages,
          max_tokens: item.request.maxTokens,
          temperature: item.request.temperature,
        },
      })),
      { endpoint, completionWindow: request.completionWindow, metadata: request.metadata },
      context,
    );
    return { id: batch.id as string, provider: 'openai', metadata: { inputFileId: fileId, endpoint } };
  }

  /** Reads a batch's status and counts. */
  async poll(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState> {
    return this.client.state(ref, await this.client.read(ref.id, context));
  }

  /** Downloads a finished batch's results: what succeeded and what failed. Empty until they exist. */
  async results(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchOutputItem[]> {
    return (await this.client.lines(ref.id, context)).map(toOutputItem);
  }

  /** Cancels a batch. Items already processed keep their results. */
  async cancel(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState> {
    return this.client.state(ref, await this.client.cancel(ref.id, context));
  }
}

function toOutputItem(line: OpenAIBatchLine): BatchOutputItem {
  const customId = line.custom_id ?? '';
  const error = lineError(line);
  if (error) return { customId, error };

  const body = line.response?.body as {
    model?: string;
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const choice = body.choices?.[0];
  const response: NexusResponse = {
    content: choice?.message?.content ?? '',
    role: 'assistant',
    finishReason: choice?.finish_reason === 'length' ? 'length' : 'stop',
    meta: buildMeta({
      provider: 'openai',
      model: body.model ?? '',
      latencyMs: 0,
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
    }),
  };
  return { customId, response };
}
