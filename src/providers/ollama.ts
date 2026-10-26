import { BaseProvider, type ProviderInfo } from './base.js';
import type { CompletionRequest, Message } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk, TokenLogprob } from '../types/response.js';
import type { OllamaProviderConfig } from '../types/config.js';
import { buildMeta } from '../core/usage.js';

interface OllamaClient {
  chat(params: OllamaChatParams & { stream: true }): Promise<AsyncIterable<OllamaChatResponse>>;
  chat(params: OllamaChatParams): Promise<OllamaChatResponse>;
}

interface OllamaChatParams {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  format?: string | Record<string, unknown>;
  signal?: AbortSignal;
  logprobs?: boolean;
  top_logprobs?: number;
  options?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    seed?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
    num_predict?: number;
    stop?: string[];
  };
}

interface OllamaMessage {
  role: Message['role'];
  content: string;
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
  logprobs?: Array<{ token?: string; logprob?: number; top_logprobs?: Array<{ token?: string; logprob?: number }> }>;
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

/** Ollama, for models running on this machine or a local server. */
export class OllamaProvider extends BaseProvider {
  /** Always `ollama`, local. */
  readonly info: ProviderInfo = { name: 'ollama', isLocal: true };
  private client?: OllamaClient;
  private config: OllamaProviderConfig;

  constructor(config: OllamaProviderConfig) {
    super();
    this.config = config;
  }

  private async getClient(): Promise<OllamaClient> {
    if (!this.client) {
      const { Ollama } = await import('ollama');
      this.client = new Ollama({ host: this.config.baseUrl || 'http://localhost:11434' }) as OllamaClient;
    }
    return this.client;
  }

  private formatMessages(messages: Message[]): OllamaMessage[] {
    return messages.map((msg) => ({
      role: msg.role,
      content:
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n'),
    }));
  }

  private extractModel(model: string): string {
    if (model.startsWith('ollama/')) return model.slice(7);
    return model;
  }

  /** Runs one completion. */
  async complete(request: CompletionRequest): Promise<NexusResponse> {
    const model = this.extractModel(request.model);
    try {
      this.throwIfAborted(request);
      const client = await this.getClient();
      const startTime = Date.now();
      const result = await client.chat({
        model,
        messages: this.formatMessages(request.messages),
        format: this.formatResponseFormat(request),
        signal: request.signal,
        ...logprobOptions(request),
        options: this.samplingOptions(request),
      });

      const latency = Date.now() - startTime;
      const logprobs = ollamaLogprobs(result.logprobs);

      return {
        content: result.message?.content || '',
        role: 'assistant',
        finishReason: 'stop',
        ...(logprobs ? { logprobs } : {}),
        meta: buildMeta({
          provider: 'ollama',
          model,
          latencyMs: latency,
          inputTokens: result.prompt_eval_count || 0,
          outputTokens: result.eval_count || 0,
        }),
      };
    } catch (error) {
      throw this.normalizeProviderError(error, request, { model });
    }
  }

  /** Streams one completion. */
  stream(request: CompletionRequest): NexusStream {
    const self = this;

    return this.createStream(async function* () {
      const model = self.extractModel(request.model);
      try {
        self.throwIfAborted(request);
        const client = await self.getClient();
        const startTime = Date.now();

        const stream = await client.chat({
          model,
          messages: self.formatMessages(request.messages),
          stream: true,
          format: self.formatResponseFormat(request),
          signal: request.signal,
          ...logprobOptions(request),
          options: self.samplingOptions(request),
        });

        for await (const chunk of stream) {
          if (chunk.message?.content) {
            const logprobs = ollamaLogprobs(chunk.logprobs);
            yield {
              type: 'text',
              content: chunk.message.content,
              ...(logprobs ? { logprobs } : {}),
            } satisfies StreamChunk;
          }

          if (chunk.done) {
            yield {
              type: 'done',
              meta: buildMeta({
                provider: 'ollama',
                model,
                latencyMs: Date.now() - startTime,
                inputTokens: chunk.prompt_eval_count || 0,
                outputTokens: chunk.eval_count || 0,
              }),
            } satisfies StreamChunk;
          }
        }
      } catch (error) {
        throw self.normalizeProviderError(error, request, { model });
      }
    }, request.signal);
  }

  /** Shared sampling options so buffered and streamed calls cannot drift apart: a stream stops where a call does. */
  private samplingOptions(request: CompletionRequest): OllamaChatParams['options'] {
    return {
      temperature: request.temperature,
      top_p: request.topP,
      top_k: request.topK,
      seed: request.seed,
      frequency_penalty: request.frequencyPenalty,
      presence_penalty: request.presencePenalty,
      num_predict: request.maxTokens,
      stop: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined,
    };
  }

  private formatResponseFormat(request: CompletionRequest): string | Record<string, unknown> | undefined {
    if (request.responseFormat?.type === 'json') return 'json';
    return request.responseFormat?.schema;
  }
}

/** Asks for log probabilities, and up to 20 alternatives a token, when the request does. */
function logprobOptions(request: CompletionRequest): { logprobs?: boolean; top_logprobs?: number } {
  if (!request.logprobs) return {};
  return {
    logprobs: true,
    ...(request.logprobs.top ? { top_logprobs: Math.min(20, Math.max(0, Math.floor(request.logprobs.top))) } : {}),
  };
}

/** Ollama's log probabilities, as every provider reports them. */
function ollamaLogprobs(items: OllamaChatResponse['logprobs']): TokenLogprob[] | undefined {
  if (!items?.length) return undefined;
  return items.map((item) => ({
    token: item.token ?? '',
    logprob: item.logprob ?? Number.NEGATIVE_INFINITY,
    ...(item.top_logprobs?.length
      ? {
          top: item.top_logprobs.map((alternative) => ({
            token: alternative.token ?? '',
            logprob: alternative.logprob ?? Number.NEGATIVE_INFINITY,
          })),
        }
      : {}),
  }));
}
