import { BaseProvider, type ProviderInfo } from './base.js';
import type { CompletionRequest, ContentPart, Message } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk, ToolCall } from '../types/response.js';
import type { AnthropicProviderConfig } from '../types/config.js';
import { generateRequestId } from '../utils/ids.js';
import { getRecord, getString } from './type-guards.js';

interface RequestOptions {
  signal?: AbortSignal;
}

interface AnthropicClient {
  messages: {
    create(params: AnthropicMessageCreateParams, options?: RequestOptions): Promise<AnthropicMessageResponse>;
    stream(
      params: AnthropicMessageCreateParams & { stream: true },
      options?: RequestOptions,
    ): AsyncIterable<AnthropicStreamEvent>;
  };
}

interface AnthropicMessageCreateParams {
  model: string;
  messages: AnthropicMessageParam[];
  max_tokens: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  system?: string;
  tools?: AnthropicToolParam[];
  stream?: boolean;
}

interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'image'; source: { type: 'url'; url: string } };

interface AnthropicToolParam {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicMessageResponse {
  model: string;
  content: AnthropicResponseContentBlock[];
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

type AnthropicResponseContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'tool_use'; id?: string; name?: string; input?: unknown };

type AnthropicStreamEvent = Record<string, unknown> & { type: string };

export class AnthropicProvider extends BaseProvider {
  readonly info: ProviderInfo;
  private client?: AnthropicClient;
  private config: AnthropicProviderConfig;

  constructor(config: AnthropicProviderConfig) {
    super();
    this.config = config;
    this.info = {
      name: config.providerName || 'anthropic',
      isLocal: config.isLocal ?? false,
    };
  }

  private async getClient(): Promise<AnthropicClient> {
    if (!this.client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseUrl,
      }) as AnthropicClient;
    }
    return this.client;
  }

  private formatMessages(messages: Message[]): { system?: string; messages: AnthropicMessageParam[] } {
    let system: string | undefined;
    const formatted: AnthropicMessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = this.textFromContent(msg.content);
        continue;
      }

      if (typeof msg.content === 'string') {
        formatted.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content });
        continue;
      }

      const parts = msg.content.map((part: ContentPart): AnthropicContentBlock => {
        switch (part.type) {
          case 'text':
            return { type: 'text', text: part.text };
          case 'image': {
            const src = part.source;
            if ('base64' in src) {
              return {
                type: 'image',
                source: { type: 'base64', media_type: src.mimeType || 'image/png', data: src.base64 },
              };
            }
            if ('buffer' in src) {
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: src.mimeType || 'image/png',
                  data: src.buffer.toString('base64'),
                },
              };
            }
            if ('url' in src) {
              return { type: 'image', source: { type: 'url', url: src.url } };
            }
            return { type: 'text', text: '[image from path requires preprocessing]' };
          }
          default:
            return { type: 'text', text: `[${part.type} content is not yet supported for this provider]` };
        }
      });

      formatted.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: parts });
    }

    return { system, messages: formatted };
  }

  private formatToolsAnthropic(tools?: CompletionRequest['tools']): AnthropicToolParam[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    const providerRequest = this.withProviderModel(request);
    try {
      this.throwIfAborted(providerRequest);
      const client = await this.getClient();
      const startTime = Date.now();
      const params = this.createParams(providerRequest);
      const result = await client.messages.create(params, this.requestOptions(providerRequest));
      const latency = Date.now() - startTime;

      let content = '';
      const toolCalls: ToolCall[] = [];

      for (const block of result.content) {
        if (block.type === 'text') {
          content += block.text || '';
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id || generateRequestId(),
            type: 'function',
            function: { name: block.name || '', arguments: JSON.stringify(block.input || {}) },
          });
        }
      }

      return {
        content,
        role: 'assistant',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: result.stop_reason === 'tool_use' ? 'tool_calls' : 'stop',
        meta: {
          requestId: generateRequestId(),
          providerUsed: this.info.name,
          modelUsed: result.model,
          latencyMs: latency,
          tokensInput: result.usage?.input_tokens || 0,
          tokensOutput: result.usage?.output_tokens || 0,
          tokensSaved: 0,
          estimatedCost: `$${((result.usage?.input_tokens || 0) / 1000 * 0.003 + (result.usage?.output_tokens || 0) / 1000 * 0.015).toFixed(4)}`,
          cacheHit: false,
          guardrailsApplied: [],
        },
      };
    } catch (error) {
      throw this.normalizeProviderError(error, providerRequest);
    }
  }

  stream(request: CompletionRequest): NexusStream {
    const self = this;

    return this.createStream(async function* () {
      try {
        const providerRequest = self.withProviderModel(request);
        self.throwIfAborted(providerRequest);
        const client = await self.getClient();
        const startTime = Date.now();
        const stream = client.messages.stream({
          ...self.createParams(providerRequest),
          stream: true,
        }, self.requestOptions(providerRequest));

        for await (const event of stream) {
          if (event.type === 'content_block_delta') {
            const delta = getRecord(event, 'delta');
            if (getString(delta, 'type') === 'text_delta') {
              yield { type: 'text', content: getString(delta, 'text') } satisfies StreamChunk;
            }
          }

          if (event.type === 'message_stop') {
            yield {
              type: 'done',
              meta: {
                requestId: generateRequestId(),
                providerUsed: self.info.name,
                modelUsed: providerRequest.model,
                latencyMs: Date.now() - startTime,
                tokensInput: 0,
                tokensOutput: 0,
                tokensSaved: 0,
                estimatedCost: '$0.00',
                cacheHit: false,
                guardrailsApplied: [],
              },
            } satisfies StreamChunk;
          }
        }
      } catch (error) {
        throw self.normalizeProviderError(error, self.withProviderModel(request));
      }
    }, request.signal);
  }

  private createParams(request: CompletionRequest): AnthropicMessageCreateParams {
    const { system, messages } = this.formatMessages(request.messages);
    const params: AnthropicMessageCreateParams = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens || 4096,
      temperature: request.temperature,
      top_p: request.topP,
      stop_sequences: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined,
    };

    if (system) params.system = system;
    const tools = this.formatToolsAnthropic(request.tools);
    if (tools) params.tools = tools;

    return params;
  }

  private textFromContent(content: Message['content']): string {
    if (typeof content === 'string') return content;
    return content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }

  private requestOptions(request: CompletionRequest): RequestOptions | undefined {
    return request.signal ? { signal: request.signal } : undefined;
  }

  private withProviderModel(request: CompletionRequest): CompletionRequest {
    const model = this.stripConfiguredPrefix(request.model);
    return model === request.model ? request : { ...request, model };
  }

  private stripConfiguredPrefix(model: string): string {
    const prefixes = Array.isArray(this.config.modelPrefix)
      ? this.config.modelPrefix
      : this.config.modelPrefix ? [this.config.modelPrefix] : [];

    for (const prefix of prefixes) {
      const marker = `${prefix}/`;
      if (model.startsWith(marker)) return model.slice(marker.length);
    }

    return model;
  }
}
