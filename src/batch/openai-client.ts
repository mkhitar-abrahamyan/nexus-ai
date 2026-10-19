import type { BatchJobRef, BatchJobState, BatchJobStatus, BatchProviderCallContext } from '../types/batch.js';
import { BatchProviderResponseError } from './errors.js';

/** What every OpenAI batch adapter needs to reach the API. */
export interface OpenAIBatchClientOptions {
  /** OpenAI API key. */
  apiKey: string;
  /** API base URL. Defaults to `https://api.openai.com/v1`. */
  baseUrl?: string;
  /** Sent as the `OpenAI-Organization` header. */
  organization?: string;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
}

/** OpenAI's batch object, as far as the adapters read it. */
export interface OpenAIBatchPayload {
  id?: string;
  status?: string;
  output_file_id?: string | null;
  error_file_id?: string | null;
  created_at?: number;
  completed_at?: number;
  expires_at?: number;
  request_counts?: { total?: number; completed?: number; failed?: number };
  errors?: { data?: Array<{ message?: string; code?: string }> };
}

/** One line of a batch's output or error file. */
export interface OpenAIBatchLine {
  custom_id?: string;
  response?: { status_code?: number; body?: Record<string, unknown> };
  error?: { message?: string; code?: string } | null;
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

/**
 * OpenAI's Batch API wire protocol, shared by the completion and embedding adapters: a JSONL upload,
 * a batch pointing at it, and JSONL downloads of what succeeded and what failed.
 */
export class OpenAIBatchClient {
  constructor(private readonly options: OpenAIBatchClientOptions) {}

  /** Uploads the lines as a JSONL file and creates a batch over them. */
  async create(
    lines: readonly unknown[],
    batch: { endpoint: string; completionWindow?: string; metadata?: Record<string, string> },
    context: BatchProviderCallContext,
  ): Promise<{ batch: OpenAIBatchPayload; fileId: string }> {
    const form = new FormData();
    form.append('purpose', 'batch');
    form.append(
      'file',
      new Blob([lines.map((line) => JSON.stringify(line)).join('\n')], { type: 'application/jsonl' }),
      'batch.jsonl',
    );
    const file = (await this.json('/files', { method: 'POST', body: form }, context)) as { id?: string };
    if (!file.id) throw new BatchProviderResponseError('openai', 'the file upload returned no id');
    const created = (await this.json(
      '/batches',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input_file_id: file.id,
          endpoint: batch.endpoint,
          completion_window: batch.completionWindow ?? '24h',
          metadata: batch.metadata,
        }),
      },
      context,
    )) as OpenAIBatchPayload;
    if (!created.id) throw new BatchProviderResponseError('openai', 'the batch response returned no id');
    return { batch: created, fileId: file.id };
  }

  /** Reads a batch. */
  read(id: string, context: BatchProviderCallContext): Promise<OpenAIBatchPayload> {
    return this.json(`/batches/${encodeURIComponent(id)}`, {}, context) as Promise<OpenAIBatchPayload>;
  }

  /** Cancels a batch. */
  cancel(id: string, context: BatchProviderCallContext): Promise<OpenAIBatchPayload> {
    return this.json(
      `/batches/${encodeURIComponent(id)}/cancel`,
      { method: 'POST' },
      context,
    ) as Promise<OpenAIBatchPayload>;
  }

  /**
   * Every line a finished batch wrote: the output file holds what succeeded and the error file what
   * failed, so both are read, or a failed request would be missing from the results altogether.
   */
  async lines(id: string, context: BatchProviderCallContext): Promise<OpenAIBatchLine[]> {
    const batch = await this.read(id, context);
    const lines: OpenAIBatchLine[] = [];
    for (const fileId of [batch.output_file_id, batch.error_file_id]) {
      if (!fileId) continue;
      const response = await this.send(`/files/${encodeURIComponent(fileId)}/content`, {}, context);
      for (const line of (await response.text()).split('\n')) {
        if (!line.trim()) continue;
        try {
          lines.push(JSON.parse(line) as OpenAIBatchLine);
        } catch (error) {
          throw new BatchProviderResponseError('openai', 'an output line was not valid JSON', error);
        }
      }
    }
    return lines;
  }

  /** A batch as the neutral state. */
  state(ref: BatchJobRef, batch: OpenAIBatchPayload): BatchJobState {
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

  private async json(path: string, init: RequestInit, context: BatchProviderCallContext): Promise<unknown> {
    return (await this.send(path, init, context)).json();
  }

  private async send(path: string, init: RequestInit, context: BatchProviderCallContext): Promise<Response> {
    const fetchImpl = this.options.fetch ?? fetch;
    const baseUrl = (this.options.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    // A credential resolved for the batch's tenant replaces the configured key.
    const credential = await context.credential?.('openai');
    const headers: Record<string, string> = {
      authorization: `Bearer ${credential?.apiKey ?? this.options.apiKey}`,
      ...(this.options.organization ? { 'openai-organization': this.options.organization } : {}),
      ...this.options.headers,
      ...credential?.headers,
      ...((init.headers as Record<string, string>) ?? {}),
    };
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers, signal: context.signal });
    if (!response.ok) {
      throw new BatchProviderResponseError('openai', `${path} failed: ${response.status} ${await safeText(response)}`);
    }
    return response;
  }
}

/** A failed line's reason: the error the line carries, or the error body of its response. */
export function lineError(line: OpenAIBatchLine): { message: string; code?: string; status?: number } | undefined {
  if (line.error) return { message: line.error.message ?? 'batch item failed', code: line.error.code };
  const status = line.response?.status_code ?? 200;
  if (status < 400 && line.response?.body) return undefined;
  const body = line.response?.body as { error?: { message?: string; code?: string } } | undefined;
  return {
    message: body?.error?.message ?? `batch item failed with status ${status}`,
    ...(body?.error?.code ? { code: body.error.code } : {}),
    status,
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}
