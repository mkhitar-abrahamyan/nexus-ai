import { BaseProvider, type ProviderInfo } from './base.js';
import type { CompletionRequest, Message, ContentPart } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk, ToolCall } from '../types/response.js';
import type { AnthropicProviderConfig } from '../types/config.js';
import { generateRequestId } from '../utils/ids.js';

export class AnthropicProvider extends BaseProvider {
  readonly info: ProviderInfo = { name: 'anthropic', isLocal: false };
  private client: any;
  private config: AnthropicProviderConfig;

  constructor(config: AnthropicProviderConfig) {
    super();
    this.config = config;
  }

  private async getClient(): Promise<any> {
    if (!this.client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      this.client = new Anthropic({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseUrl,
      });
    }
    return this.client;
  }

  private formatMessages(messages: Message[]): { system?: string; messages: any[] } {
    let system: string | undefined;
    const formatted: any[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        system = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter((p) => p.type === 'text').map((p) => (p as any).text).join('\n');
        continue;
      }

      if (typeof msg.content === 'string') {
        formatted.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content });
        continue;
      }

      const parts: any[] = msg.content.map((part: ContentPart) => {
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
            return { type: 'text', text: '[image from path — requires preprocessing]' };
          }
          default:
            return { type: 'text', text: `[${part.type} content — not yet supported for this provider]` };
        }
      });

      formatted.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: parts });
    }

    return { system, messages: formatted };
  }

  private formatToolsAnthropic(tools?: CompletionRequest['tools']): any[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    const client = await this.getClient();
    const startTime = Date.now();
    const { system, messages } = this.formatMessages(request.messages);

    const params: any = {
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

    const result = await client.messages.create(params);
    const latency = Date.now() - startTime;

    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const block of result.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input) },
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
        providerUsed: 'anthropic',
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
  }

  stream(request: CompletionRequest): NexusStream {
    const self = this;

    return this.createStream(async function* () {
      const client = await self.getClient();
      const startTime = Date.now();
      const { system, messages } = self.formatMessages(request.messages);

      const params: any = {
        model: request.model,
        messages,
        max_tokens: request.maxTokens || 4096,
        temperature: request.temperature,
        top_p: request.topP,
        stream: true,
      };

      if (system) params.system = system;
      const tools = self.formatToolsAnthropic(request.tools);
      if (tools) params.tools = tools;

      const stream = client.messages.stream(params);

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            yield { type: 'text', content: event.delta.text } satisfies StreamChunk;
          } else if (event.delta.type === 'input_json_delta') {
            // Tool call argument streaming — buffered by Anthropic SDK
          }
        }

        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          // Tool call started
        }

        if (event.type === 'message_stop') {
          yield {
            type: 'done',
            meta: {
              requestId: generateRequestId(),
              providerUsed: 'anthropic',
              modelUsed: request.model,
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
    });
  }
}
