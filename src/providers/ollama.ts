import { BaseProvider, type ProviderInfo } from './base.js';
import type { CompletionRequest, Message } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../types/response.js';
import type { OllamaProviderConfig } from '../types/config.js';
import { generateRequestId } from '../utils/ids.js';

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
  options?: {
    temperature?: number;
    top_p?: number;
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
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider extends BaseProvider {
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
      content: typeof msg.content === 'string'
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
        options: {
          temperature: request.temperature,
          top_p: request.topP,
          stop: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined,
        },
      });

      const latency = Date.now() - startTime;

      return {
        content: result.message?.content || '',
        role: 'assistant',
        finishReason: 'stop',
        meta: {
          requestId: generateRequestId(),
          providerUsed: 'ollama',
          modelUsed: model,
          latencyMs: latency,
          tokensInput: result.prompt_eval_count || 0,
          tokensOutput: result.eval_count || 0,
          tokensSaved: 0,
          estimatedCost: '$0.00',
          cacheHit: false,
          guardrailsApplied: [],
        },
      };
    } catch (error) {
      throw this.normalizeProviderError(error, request, { model });
    }
  }

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
          options: {
            temperature: request.temperature,
            top_p: request.topP,
          },
        });

        for await (const chunk of stream) {
          if (chunk.message?.content) {
            yield { type: 'text', content: chunk.message.content } satisfies StreamChunk;
          }

          if (chunk.done) {
            yield {
              type: 'done',
              meta: {
                requestId: generateRequestId(),
                providerUsed: 'ollama',
                modelUsed: model,
                latencyMs: Date.now() - startTime,
                tokensInput: chunk.prompt_eval_count || 0,
                tokensOutput: chunk.eval_count || 0,
                tokensSaved: 0,
                estimatedCost: '$0.00',
                cacheHit: false,
                guardrailsApplied: [],
              },
            } satisfies StreamChunk;
          }
        }
      } catch (error) {
        throw self.normalizeProviderError(error, request, { model });
      }
    }, request.signal);
  }

  private formatResponseFormat(request: CompletionRequest): string | Record<string, unknown> | undefined {
    if (request.responseFormat?.type === 'json') return 'json';
    return request.responseFormat?.schema;
  }
}
