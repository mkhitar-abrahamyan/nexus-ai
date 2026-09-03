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
import type { Message } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import { buildMeta } from '../core/usage.js';
import { BatchProviderResponseError } from './errors.js';

export interface AnthropicBatchProviderOptions {
  apiKey: string;
  baseUrl?: string;
  version?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  /** Applied to any item that names no model. */
  defaultModel?: string;
  maxTokens?: number;
}

/**
 * Anthropic reports only `in_progress` and `ended` for the batch itself.
 *
 * `ended` covers success, cancellation, and expiry alike, so the real outcome only appears on the
 * per-item results. This adapter reports `completed` on `ended` and lets the item errors carry the
 * detail, rather than inventing a batch-level failure the API never stated.
 */
const STATUS_MAP: Record<string, BatchJobStatus> = {
  in_progress: 'in_progress',
  canceling: 'cancelling',
  cancelling: 'cancelling',
  ended: 'completed',
};

interface AnthropicBatchPayload {
  id?: string;
  processing_status?: string;
  results_url?: string | null;
  created_at?: string;
  ended_at?: string;
  expires_at?: string;
  request_counts?: {
    processing?: number;
    succeeded?: number;
    errored?: number;
    canceled?: number;
    expired?: number;
  };
}

/** Anthropic Message Batches: half price, 24-hour window. */
export class AnthropicBatchProvider implements BatchProvider {
  readonly info: BatchProviderInfo = {
    name: 'anthropic',
    capabilities: {
      maxItems: 100_000,
      maxBytes: 256 * 1024 * 1024,
      completionWindows: ['24h'],
      supportsCancel: true,
      discount: 0.5,
    },
  };

  constructor(private readonly options: AnthropicBatchProviderOptions) {}

  async submit(request: BatchSubmitRequest, context: BatchProviderCallContext): Promise<BatchJobRef> {
    const requests = request.items.map((item) => {
      const { system, messages } = splitSystem(item.request.messages);
      return {
        custom_id: item.customId,
        params: {
          model: item.request.model || request.model || this.options.defaultModel,
          max_tokens: item.request.maxTokens ?? this.options.maxTokens ?? 1024,
          temperature: item.request.temperature,
          system,
          messages,
        },
      };
    });

    const batch = (await this.request(
      '/messages/batches',
      { method: 'POST', body: JSON.stringify({ requests }) },
      context,
    )) as AnthropicBatchPayload;

    if (!batch.id) throw new BatchProviderResponseError('anthropic', 'the batch response returned no id');
    return { id: batch.id, provider: 'anthropic' };
  }

  async poll(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState> {
    const batch = (await this.request(
      `/messages/batches/${encodeURIComponent(ref.id)}`,
      {},
      context,
    )) as AnthropicBatchPayload;
    return this.toState(ref, batch);
  }

  async results(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchOutputItem[]> {
    const body = await this.requestText(`/messages/batches/${encodeURIComponent(ref.id)}/results`, context);
    return body
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => this.toOutputItem(line));
  }

  async cancel(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState> {
    const batch = (await this.request(
      `/messages/batches/${encodeURIComponent(ref.id)}/cancel`,
      { method: 'POST' },
      context,
    )) as AnthropicBatchPayload;
    return this.toState(ref, batch);
  }

  private toState(ref: BatchJobRef, batch: AnthropicBatchPayload): BatchJobState {
    const counts = batch.request_counts;
    return {
      ref,
      status: STATUS_MAP[batch.processing_status ?? ''] ?? 'in_progress',
      counts: counts
        ? {
            total:
              (counts.processing ?? 0) +
              (counts.succeeded ?? 0) +
              (counts.errored ?? 0) +
              (counts.canceled ?? 0) +
              (counts.expired ?? 0),
            completed: counts.succeeded ?? 0,
            failed: (counts.errored ?? 0) + (counts.canceled ?? 0) + (counts.expired ?? 0),
          }
        : undefined,
      createdAt: batch.created_at,
      completedAt: batch.ended_at,
      expiresAt: batch.expires_at,
      raw: batch,
    };
  }

  private toOutputItem(line: string): BatchOutputItem {
    let parsed: {
      custom_id?: string;
      result?: {
        type?: string;
        message?: {
          model?: string;
          content?: Array<{ type?: string; text?: string }>;
          stop_reason?: string;
          usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
        };
        error?: { type?: string; message?: string };
      };
    };
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new BatchProviderResponseError('anthropic', 'a result line was not valid JSON', error);
    }

    const customId = parsed.custom_id ?? '';
    const result = parsed.result;

    if (result?.type !== 'succeeded' || !result.message) {
      return {
        customId,
        error: {
          message: result?.error?.message ?? `batch item ${result?.type ?? 'failed'}`,
          code: result?.error?.type ?? result?.type,
        },
      };
    }

    const message = result.message;
    const content = (message.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('');

    const response: NexusResponse = {
      content,
      role: 'assistant',
      finishReason: message.stop_reason === 'max_tokens' ? 'length' : 'stop',
      meta: buildMeta({
        provider: 'anthropic',
        model: message.model ?? '',
        latencyMs: 0,
        inputTokens: message.usage?.input_tokens,
        outputTokens: message.usage?.output_tokens,
        cachedReadTokens: message.usage?.cache_read_input_tokens,
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
    const baseUrl = (this.options.baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '');
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'x-api-key': this.options.apiKey,
        'anthropic-version': this.options.version ?? '2023-06-01',
        'content-type': 'application/json',
        ...this.options.headers,
        ...((init.headers as Record<string, string>) ?? {}),
      },
      signal: context.signal,
    });

    if (!response.ok) {
      throw new BatchProviderResponseError(
        'anthropic',
        `${path} failed: ${response.status} ${await safeText(response)}`,
      );
    }
    return response;
  }
}

/**
 * Anthropic takes the system prompt as a top-level field rather than a message.
 *
 * Splitting it here keeps the neutral request shape unchanged for callers, who write a system
 * message like every other provider.
 */
function splitSystem(messages: readonly Message[]): { system?: string; messages: Message[] } {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => (typeof message.content === 'string' ? message.content : ''))
    .join('\n')
    .trim();
  return {
    system: system || undefined,
    messages: messages.filter((message) => message.role !== 'system') as Message[],
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}
