import type {
  EmbeddingInputType,
  EmbeddingProviderCallContext,
  EmbeddingProviderCapabilities,
  EmbeddingProviderInfo,
  EmbeddingProviderRequest,
  EmbeddingProviderResult,
  EmbeddingsProvider,
} from '../types/embeddings.js';
import { createProviderHttpError, toNexusProviderError } from '../providers/errors.js';
import { EmbeddingProviderResponseError } from './errors.js';

/**
 * Hosted embedding adapters.
 *
 * They share one file because each is a single request/response mapping over `fetch` with no SDK
 * and no shared state; splitting them would repeat the HTTP and decoding helpers five times.
 */

export interface EmbeddingAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  headers?: Record<string, string>;
  /** Replaces the global `fetch`, for proxying or tests. */
  fetch?: typeof fetch;
}

/** Options for any server that speaks the OpenAI `/embeddings` protocol. */
export interface OpenAICompatibleEmbeddingOptions extends EmbeddingAdapterOptions {
  /** Name this adapter reports and registers under. */
  providerName?: string;
  /** Replaces the declared capabilities, for a compatible server with different limits. */
  capabilities?: Partial<EmbeddingProviderCapabilities>;
}

abstract class HttpEmbeddingProvider implements EmbeddingsProvider {
  abstract readonly info: EmbeddingProviderInfo;

  constructor(protected readonly options: EmbeddingAdapterOptions = {}) {}

  abstract embed(
    request: EmbeddingProviderRequest,
    context: EmbeddingProviderCallContext,
  ): Promise<EmbeddingProviderResult>;

  protected async post(url: string, body: unknown, model: string, signal: AbortSignal): Promise<unknown> {
    const fetchImpl = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeaders(), ...this.options.headers },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // Transport failures are categorized so the manager's retry policy sees a retryable network
      // error rather than an opaque one.
      throw toNexusProviderError(error, { provider: this.info.name, model });
    }

    if (!response.ok) throw await createProviderHttpError(this.info.name, model, response);
    return response.json();
  }

  protected authHeaders(): Record<string, string> {
    return this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {};
  }

  protected baseUrl(fallback: string): string {
    return (this.options.baseUrl || fallback).replace(/\/$/, '');
  }
}

/** Decodes the base64 float32 form OpenAI-compatible servers return for `encoding_format: base64`. */
function decodeBase64Vector(value: string): number[] {
  const bytes = Buffer.from(value, 'base64');
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
  return Array.from(floats);
}

function toVector(provider: string, value: unknown): number[] {
  if (typeof value === 'string') return decodeBase64Vector(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) return value as number[];
  throw new EmbeddingProviderResponseError(provider, 'an embedding was neither a float array nor a base64 string');
}

interface OpenAIEmbeddingPayload {
  data?: Array<{ embedding: number[] | string; index?: number }>;
  model?: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * OpenAI and any OpenAI-compatible `/embeddings` endpoint.
 *
 * `baseUrl` points it at Azure OpenAI, a gateway, or a self-hosted server; `model` sets the default
 * when the request names none.
 */
export class OpenAIEmbeddingProvider extends HttpEmbeddingProvider {
  readonly info: EmbeddingProviderInfo;

  constructor(options: OpenAICompatibleEmbeddingOptions = {}) {
    super(options);
    this.info = {
      name: options.providerName || 'openai',
      defaultModel: options.model || 'text-embedding-3-small',
      capabilities: {
        models: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'],
        maxBatchSize: 2048,
        maxInputTokens: 8191,
        dimensions: true,
        encodingFormats: ['float', 'base64'],
        truncate: false,
        ...options.capabilities,
      },
    };
  }

  async embed(
    request: EmbeddingProviderRequest,
    context: EmbeddingProviderCallContext,
  ): Promise<EmbeddingProviderResult> {
    const payload = (await this.post(
      `${this.baseUrl('https://api.openai.com/v1')}/embeddings`,
      {
        model: request.model,
        input: request.input,
        dimensions: request.dimensions,
        encoding_format: request.encodingFormat,
        user: request.user,
        ...request.providerOptions,
      },
      request.model,
      context.signal,
    )) as OpenAIEmbeddingPayload;

    const data = payload.data;
    if (!Array.isArray(data)) throw new EmbeddingProviderResponseError(this.info.name, 'the response carried no data');

    // The API documents index order but does not guarantee it, and one swapped vector silently
    // mislabels a document, so order is restored explicitly.
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    return {
      vectors: ordered.map((item) => toVector(this.info.name, item.embedding)),
      model: payload.model,
      usage: { inputTokens: payload.usage?.prompt_tokens, totalTokens: payload.usage?.total_tokens },
      raw: payload,
    };
  }
}

const GOOGLE_TASK_TYPES: Record<EmbeddingInputType, string> = {
  document: 'RETRIEVAL_DOCUMENT',
  query: 'RETRIEVAL_QUERY',
  classification: 'CLASSIFICATION',
  clustering: 'CLUSTERING',
};

interface GoogleEmbeddingPayload {
  embeddings?: Array<{ values?: number[] }>;
}

/** Google Generative Language `batchEmbedContents`. */
export class GoogleEmbeddingProvider extends HttpEmbeddingProvider {
  readonly info: EmbeddingProviderInfo;

  constructor(options: EmbeddingAdapterOptions = {}) {
    super(options);
    this.info = {
      name: 'google',
      defaultModel: options.model || 'gemini-embedding-001',
      capabilities: {
        models: ['gemini-embedding-001', 'text-embedding-004'],
        maxBatchSize: 100,
        maxInputTokens: 2048,
        dimensions: true,
        inputTypes: ['document', 'query', 'classification', 'clustering'],
        encodingFormats: ['float'],
        truncate: false,
      },
    };
  }

  protected override authHeaders(): Record<string, string> {
    return this.options.apiKey ? { 'x-goog-api-key': this.options.apiKey } : {};
  }

  async embed(
    request: EmbeddingProviderRequest,
    context: EmbeddingProviderCallContext,
  ): Promise<EmbeddingProviderResult> {
    const model = request.model;
    const qualified = model.startsWith('models/') ? model : `models/${model}`;
    const payload = (await this.post(
      `${this.baseUrl('https://generativelanguage.googleapis.com/v1beta')}/${qualified}:batchEmbedContents`,
      {
        requests: request.input.map((text) => ({
          model: qualified,
          content: { parts: [{ text }] },
          taskType: request.inputType ? GOOGLE_TASK_TYPES[request.inputType] : undefined,
          outputDimensionality: request.dimensions,
          ...request.providerOptions,
        })),
      },
      model,
      context.signal,
    )) as GoogleEmbeddingPayload;

    const embeddings = payload.embeddings;
    if (!Array.isArray(embeddings)) {
      throw new EmbeddingProviderResponseError(this.info.name, 'the response carried no embeddings');
    }

    // Google reports no token usage for this endpoint, so usage is left absent and the manager
    // estimates it rather than reporting a zero that would price the call at nothing.
    return {
      vectors: embeddings.map((item) => toVector(this.info.name, item.values)),
      raw: payload,
    };
  }
}

const COHERE_INPUT_TYPES: Record<EmbeddingInputType, string> = {
  document: 'search_document',
  query: 'search_query',
  classification: 'classification',
  clustering: 'clustering',
};

interface CoherePayload {
  embeddings?: { float?: number[][] } | number[][];
  meta?: { billed_units?: { input_tokens?: number } };
}

/** Cohere v2 `/embed`. */
export class CohereEmbeddingProvider extends HttpEmbeddingProvider {
  readonly info: EmbeddingProviderInfo;

  constructor(options: EmbeddingAdapterOptions = {}) {
    super(options);
    this.info = {
      name: 'cohere',
      defaultModel: options.model || 'embed-v4.0',
      capabilities: {
        models: ['embed-v4.0', 'embed-english-v3.0', 'embed-multilingual-v3.0'],
        maxBatchSize: 96,
        dimensions: [256, 512, 1024, 1536],
        inputTypes: ['document', 'query', 'classification', 'clustering'],
        encodingFormats: ['float'],
        truncate: true,
        normalized: true,
      },
    };
  }

  async embed(
    request: EmbeddingProviderRequest,
    context: EmbeddingProviderCallContext,
  ): Promise<EmbeddingProviderResult> {
    const payload = (await this.post(
      `${this.baseUrl('https://api.cohere.com/v2')}/embed`,
      {
        model: request.model,
        texts: request.input,
        input_type: COHERE_INPUT_TYPES[request.inputType ?? 'document'],
        embedding_types: ['float'],
        output_dimension: request.dimensions,
        truncate: request.truncate ? request.truncate.toUpperCase() : undefined,
        ...request.providerOptions,
      },
      request.model,
      context.signal,
    )) as CoherePayload;

    const raw = payload.embeddings;
    const vectors = Array.isArray(raw) ? raw : raw?.float;
    if (!Array.isArray(vectors)) {
      throw new EmbeddingProviderResponseError(this.info.name, 'the response carried no float embeddings');
    }

    return {
      vectors: vectors.map((item) => toVector(this.info.name, item)),
      usage: { inputTokens: payload.meta?.billed_units?.input_tokens },
      raw: payload,
    };
  }
}

/** Mistral `/v1/embeddings`, which follows the OpenAI request and response shape. */
export class MistralEmbeddingProvider extends OpenAIEmbeddingProvider {
  constructor(options: EmbeddingAdapterOptions = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl || 'https://api.mistral.ai/v1',
      model: options.model || 'mistral-embed',
      providerName: 'mistral',
      capabilities: {
        models: ['mistral-embed'],
        maxBatchSize: 128,
        maxInputTokens: 8000,
        dimensions: false,
        encodingFormats: ['float'],
        truncate: false,
      },
    });
  }
}

interface OllamaPayload {
  embeddings?: number[][];
  prompt_eval_count?: number;
}

/** Local Ollama `/api/embed`. */
export class OllamaEmbeddingProvider extends HttpEmbeddingProvider {
  readonly info: EmbeddingProviderInfo;

  constructor(options: EmbeddingAdapterOptions = {}) {
    super(options);
    this.info = {
      name: 'ollama',
      isLocal: true,
      defaultModel: options.model || 'nomic-embed-text',
      capabilities: {
        maxBatchSize: 64,
        dimensions: false,
        encodingFormats: ['float'],
        truncate: true,
      },
    };
  }

  async embed(
    request: EmbeddingProviderRequest,
    context: EmbeddingProviderCallContext,
  ): Promise<EmbeddingProviderResult> {
    const payload = (await this.post(
      `${this.baseUrl('http://localhost:11434')}/api/embed`,
      {
        model: request.model,
        input: request.input,
        truncate: request.truncate === undefined ? undefined : request.truncate !== 'none',
        ...request.providerOptions,
      },
      request.model,
      context.signal,
    )) as OllamaPayload;

    if (!Array.isArray(payload.embeddings)) {
      throw new EmbeddingProviderResponseError(this.info.name, 'the response carried no embeddings');
    }

    return {
      vectors: payload.embeddings.map((item) => toVector(this.info.name, item)),
      usage: { inputTokens: payload.prompt_eval_count },
      raw: payload,
    };
  }
}
