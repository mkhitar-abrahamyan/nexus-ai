import type {
  BatchJobRef,
  BatchJobState,
  BatchJobStatus,
  BatchOutputItem,
  BatchProvider,
  BatchProviderCallContext,
  BatchProviderInfo,
  BatchSubmitRequest,
} from '../types/batch.js';
import type { NexusResponse } from '../types/response.js';
import { buildMeta } from '../core/usage.js';
import { BatchProviderResponseError } from './errors.js';

export interface OpenAIBatchProviderOptions {
  apiKey: string;
  baseUrl?: string;
  organization?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Endpoint every item targets. Defaults to chat completions. */
  endpoint?: '/v1/chat/completions' | '/v1/embeddings' | (string & {});
}

/** OpenAI reports its own vocabulary; this maps it onto the neutral one. */
const STATUS_MAP: Record<string, BatchJobStatus> = {
  validating: 'validating',
  in_progress: 'in_progress',
  finalizing: 'finalizing',
  completed: 'completed',
  failed: 'failed',
  expired: 'expired',
  cancelling: 'cancelling',
  cancelled: 'cancelled',
};

interface OpenAIBatchPayload {
  id?: string;
  status?: string;
  output_file_id?: string;
  error_file_id?: string;
  created_at?: number;
  completed_at?: number;
  expires_at?: number;
  request_counts?: { total?: number; completed?: number; failed?: number };
  errors?: { data?: Array<{ message?: string; code?: string }> };
}

/**
 * OpenAI's Batch API: half price, 24-hour window.
 *
 * The wire protocol is a JSONL upload, a batch pointing at it, then a JSONL download — three
 * different content types across four endpoints, which is why this adapter is larger than a
 * synchronous one.
 */
export class OpenAIBatchProvider implements BatchProvider {
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

  constructor(private readonly options: OpenAIBatchProviderOptions) {}

  async submit(request: BatchSubmitRequest, context: BatchProviderCallContext): Promise<BatchJobRef> {
    const endpoint = this.options.endpoint ?? '/v1/chat/completions';
    const jsonl = request.items
      .map((item) =>
        JSON.stringify({
          custom_id: item.customId,
          method: 'POST',
          url: endpoint,
          body: {
            model: item.request.model || request.model,
            messages: item.request.messages,
            max_tokens: item.request.maxTokens,
            temperature: item.request.temperature,
          },
        }),
      )
      .join('\n');

    const form = new FormData();
    form.append('purpose', 'batch');
    form.append('file', new Blob([jsonl], { type: 'application/jsonl' }), 'batch.jsonl');

    const file = (await this.request('/files', { method: 'POST', body: form }, context)) as { id?: string };
    if (!file.id) throw new BatchProviderResponseError('openai', 'the file upload returned no id');

    const batch = (await this.request(
      '/batches',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input_file_id: file.id,
          endpoint,
          completion_window: request.completionWindow ?? '24h',
          metadata: request.metadata,
        }),
      },
      context,
    )) as OpenAIBatchPayload;

    if (!batch.id) throw new BatchProviderResponseError('openai', 'the batch response returned no id');
    return { id: batch.id, provider: 'openai', metadata: { inputFileId: file.id, endpoint } };
  }

  async poll(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState> {
    const batch = (await this.request(`/batches/${encodeURIComponent(ref.id)}`, {}, context)) as OpenAIBatchPayload;
    return this.toState(ref, batch);
  }

  async results(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchOutputItem[]> {
    const batch = (await this.request(`/batches/${encodeURIComponent(ref.id)}`, {}, context)) as OpenAIBatchPayload;
    if (!batch.output_file_id) return [];

    const body = await this.requestText(`/files/${encodeURIComponent(batch.output_file_id)}/content`, context);
    return body
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => this.toOutputItem(line));
  }

  async cancel(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState> {
    const batch = (await this.request(
      `/batches/${encodeURIComponent(ref.id)}/cancel`,
      { method: 'POST' },
      context,
    )) as OpenAIBatchPayload;
    return this.toState(ref, batch);
  }

  private toState(ref: BatchJobRef, batch: OpenAIBatchPayload): BatchJobState {
    const counts = batch.request_counts;
    return {
      ref,
      status: STATUS_MAP[batch.status ?? ''] ?? 'in_progress',
      counts: counts
        ? { total: counts.total ?? 0, completed: counts.completed ?? 0, failed: counts.failed ?? 0 }
        : undefined,
      createdAt: batch.created_at ? new Date(batch.created_at * 1000).toISOString() : undefined,
      completedAt: batch.completed_at ? new Date(batch.completed_at * 1000).toISOString() : undefined,
      expiresAt: batch.expires_at ? new Date(batch.expires_at * 1000).toISOString() : undefined,
      error: batch.errors?.data?.[0]
        ? { message: batch.errors.data[0].message ?? 'batch failed', code: batch.errors.data[0].code }
        : undefined,
      raw: batch,
    };
  }

  private toOutputItem(line: string): BatchOutputItem {
    let parsed: {
      custom_id?: string;
      response?: { status_code?: number; body?: Record<string, unknown> };
      error?: { message?: string; code?: string };
    };
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new BatchProviderResponseError('openai', 'an output line was not valid JSON', error);
    }

    const customId = parsed.custom_id ?? '';
    if (parsed.error) {
      return { customId, error: { message: parsed.error.message ?? 'batch item failed', code: parsed.error.code } };
    }

    const body = parsed.response?.body as
      | {
          model?: string;
          choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        }
      | undefined;
    const status = parsed.response?.status_code ?? 200;
    if (!body || status >= 400) {
      return { customId, error: { message: `batch item failed with status ${status}`, status } };
    }

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

  private async request(path: string, init: RequestInit, context: BatchProviderCallContext): Promise<unknown> {
    const response = await this.send(path, init, context);
    return response.json();
  }

  private async requestText(path: string, context: BatchProviderCallContext): Promise<string> {
    const response = await this.send(path, {}, context);
    return response.text();
  }

  private async send(path: string, init: RequestInit, context: BatchProviderCallContext): Promise<Response> {
    const fetchImpl = this.options.fetch ?? fetch;
    const baseUrl = (this.options.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      ...(this.options.organization ? { 'openai-organization': this.options.organization } : {}),
      ...this.options.headers,
      ...((init.headers as Record<string, string>) ?? {}),
    };

    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers, signal: context.signal });
    if (!response.ok) {
      throw new BatchProviderResponseError('openai', `${path} failed: ${response.status} ${await safeText(response)}`);
    }
    return response;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}
