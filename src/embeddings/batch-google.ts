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
  /**
   * API base URL. Defaults to `https://generativelanguage.googleapis.com/v1beta`. A file is uploaded to,
   * and results downloaded from, the same URL with `/upload` and `/download` before its version.
   */
  baseUrl?: string;
  /** Headers added to every request. */
  headers?: Record<string, string>;
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
}

/** Inline requests in one batch must stay under 20 MB; an input file may hold 2 GB. */
const INLINE_BYTES = 20 * 1024 * 1024;
const FILE_BYTES = 2 * 1024 * 1024 * 1024;

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
    // The API reference names it `inlinedResponses`; Google's clients, `inlinedEmbedContentResponses`.
    inlinedResponses?: { inlinedResponses?: GoogleResponse[] };
    inlinedEmbedContentResponses?: { inlinedResponses?: GoogleResponse[] };
  };
  metadata?: GoogleBatch;
  error?: { message?: string; code?: number | string };
}

/** One input's answer, inline or a line of a results file: its embedding, or why it has none. */
interface GoogleResponse {
  key?: string;
  metadata?: { key?: string };
  response?: { embedding?: { values?: number[] } };
  embedding?: { values?: number[] };
  error?: { message?: string; code?: number | string };
}

/**
 * Gemini's Batch API for embeddings (`asyncBatchEmbedContent`): half price. Requests under 20 MB go
 * inline; a larger batch, up to 2 GB, is uploaded as a JSONL file through the Files API, a line per
 * input with its id as the key, and its results are read from the file the batch writes. It takes
 * text, images, audio, video, and PDFs on a model that does, such as gemini-embedding-2. The wire shape
 * follows Google's API reference and its own clients; it graduates with a recorded live run.
 */
export class GoogleEmbeddingBatchProvider implements EmbeddingBatchProvider {
  /** Always `google`, with its batch limits. */
  readonly info: EmbeddingBatchProviderInfo = {
    name: 'google',
    capabilities: {
      maxBytes: FILE_BYTES,
      supportsCancel: true,
      discount: 0.5,
      inputModalities: ['text', 'image', 'audio', 'video', 'document'],
    },
  };

  constructor(private readonly options: GoogleEmbeddingBatchProviderOptions) {}

  /**
   * Sends every input as one batch: inline under 20 MB, or else as a JSONL file uploaded first. Results
   * come back in the same order, so the ref keeps the ids in that order.
   */
  async submit(request: EmbeddingBatchProviderRequest, context: BatchProviderCallContext): Promise<BatchJobRef> {
    const qualified = request.model.startsWith('models/') ? request.model : `models/${request.model}`;
    const prefixed = usesTaskPrefix(request.model);
    const displayName = request.metadata?.key ?? 'nexus-embeddings';
    // Each request encoded once: joined inline, or written as a line of the input file.
    const encoded = request.items.map((item) =>
      JSON.stringify({
        model: qualified,
        content: {
          parts: googleParts(
            item.contents ?? [{ type: 'text', text: item.input }],
            prefixed ? request.inputType : undefined,
          ),
        },
        ...(request.inputType && !prefixed ? { taskType: GOOGLE_TASK_TYPES[request.inputType] } : {}),
        ...(request.dimensions !== undefined ? { outputDimensionality: request.dimensions } : {}),
      }),
    );
    const opening = `{"batch":{"displayName":${JSON.stringify(displayName)},"inputConfig":{"requests":{"requests":[`;
    const closing = ']}}}}';
    // Measured before it is joined, so a batch too large to be one string is never made one.
    const inlineSize =
      utf8Length(opening) +
      encoded.reduce((total, line) => total + utf8Length(line) + '{"request":},'.length, 0) +
      closing.length;
    let body: string;
    let inputFile: string | undefined;
    if (inlineSize <= INLINE_BYTES) {
      body = `${opening}${encoded.map((line) => `{"request":${line}}`).join(',')}${closing}`;
    } else {
      const lines = request.items.map(
        (item, index) => `{"key":${JSON.stringify(item.customId)},"request":${encoded[index]}}\n`,
      );
      const size = lines.reduce((total, line) => total + utf8Length(line), 0);
      const most = this.info.capabilities.maxBytes ?? FILE_BYTES;
      if (size > most) {
        throw new BatchCapabilityError(
          'google',
          'maxBytes',
          `A Gemini batch file holds at most ${Math.floor(most / 1024 / 1024)} MB; this one is ${Math.ceil(size / 1024 / 1024)} MB, so split it`,
        );
      }
      inputFile = await this.upload(new Blob(lines, { type: 'application/jsonl' }), displayName, context);
      body = JSON.stringify({ batch: { displayName, inputConfig: { fileName: inputFile } } });
    }
    const created = (await this.request(
      `/${qualified}:asyncBatchEmbedContent`,
      { method: 'POST', body },
      context,
    )) as GoogleBatch;
    const name = created.name ?? created.metadata?.name;
    if (!name) throw new BatchProviderResponseError('google', 'the batch response returned no name');
    return {
      id: name,
      provider: 'google',
      metadata: { customIds: request.items.map((item) => item.customId), ...(inputFile ? { inputFile } : {}) },
    };
  }

  /** Reads a batch's state and counts. */
  async poll(ref: BatchJobRef, context: BatchProviderCallContext): Promise<BatchJobState> {
    return this.state(ref, await this.read(ref, context));
  }

  /**
   * Every input's vector or error: inline, or read from the file the batch wrote. An answer that names
   * its key is matched by it, and one that does not, by its position.
   */
  async results(ref: BatchJobRef, context: BatchProviderCallContext): Promise<EmbeddingBatchOutputItem[]> {
    const batch = await this.read(ref, context);
    const output = batch.output;
    const ids = (ref.metadata?.customIds ?? []) as string[];
    const responses: GoogleResponse[] = output?.responsesFile
      ? (await this.download(output.responsesFile, context))
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as GoogleResponse)
      : (output?.inlinedResponses?.inlinedResponses ?? output?.inlinedEmbedContentResponses?.inlinedResponses ?? []);
    const known = new Set(ids);
    return responses.map((entry, index) => {
      const key = entry.key ?? entry.metadata?.key;
      const customId = key !== undefined && known.has(key) ? key : (ids[index] ?? String(index));
      const values = (entry.response ?? entry).embedding?.values;
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

  /**
   * Uploads an input file through the Files API's resumable protocol, a start and then the bytes, and
   * returns its name, such as `files/abc`. Google keeps it 48 hours.
   */
  private async upload(file: Blob, displayName: string, context: BatchProviderCallContext): Promise<string> {
    const started = await this.send(
      this.alongside('upload', '/files'),
      {
        method: 'POST',
        body: JSON.stringify({ file: { displayName } }),
        headers: {
          'content-type': 'application/json',
          'x-goog-upload-protocol': 'resumable',
          'x-goog-upload-command': 'start',
          'x-goog-upload-header-content-length': String(file.size),
          'x-goog-upload-header-content-type': 'application/jsonl',
        },
      },
      context,
    );
    const target = started.headers.get('x-goog-upload-url');
    if (!target) throw new BatchProviderResponseError('google', 'the upload was not given a URL to send the file to');
    const finished = await this.send(
      target,
      {
        method: 'POST',
        body: file,
        headers: { 'x-goog-upload-offset': '0', 'x-goog-upload-command': 'upload, finalize' },
      },
      context,
    );
    const name = (JSON.parse(await finished.text()) as { file?: { name?: string } }).file?.name;
    if (!name) throw new BatchProviderResponseError('google', 'the upload returned no file name');
    return name;
  }

  /** A results file's text, from the Files API's download URL. */
  private async download(file: string, context: BatchProviderCallContext): Promise<string> {
    const response = await this.send(this.alongside('download', `/${file}:download?alt=media`), {}, context);
    return response.text();
  }

  /** The URL beside the API's own for uploads or downloads: `/upload` or `/download` before the version. */
  private alongside(kind: 'upload' | 'download', path: string): string {
    const base = this.base();
    const moved = base.replace(/\/(v1[^/]*)$/, `/${kind}/$1`);
    if (moved === base) {
      throw new BatchProviderResponseError('google', `the base URL ${base} names no API version to ${kind} beside`);
    }
    return `${moved}${path}`;
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
    const response = await this.send(
      `${this.base()}${path}`,
      { ...init, headers: { 'content-type': 'application/json' } },
      context,
    );
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  private base(): string {
    return (this.options.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
  }

  /** A call with the key, refused unless it succeeds. */
  private async send(url: string, init: RequestInit, context: BatchProviderCallContext): Promise<Response> {
    // A credential resolved for the batch's tenant replaces the configured key.
    const credential = await context.credential?.(this.info.name);
    const response = await (this.options.fetch ?? fetch)(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        'x-goog-api-key': credential?.apiKey ?? this.options.apiKey,
        ...this.options.headers,
        ...credential?.headers,
      },
      signal: context.signal,
    });
    if (!response.ok) {
      const path = new URL(url).pathname;
      throw new BatchProviderResponseError(
        'google',
        `${path} failed: ${response.status} ${(await response.text()).slice(0, 500)}`,
      );
    }
    return response;
  }
}

/** A text's length in UTF-8 bytes, counted without encoding it. */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}
