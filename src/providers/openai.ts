import { BaseProvider, type ProviderInfo } from './base.js';
import type { CompletionRequest, Message, ContentPart } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk, ToolCall } from '../types/response.js';
import type { OpenAIProviderConfig } from '../types/config.js';
import { generateRequestId } from '../utils/ids.js';
import { KNOWN_MODELS } from '../types/providers.js';

export class OpenAIProvider extends BaseProvider {
  readonly info: ProviderInfo = { name: 'openai', isLocal: false };
  private client: any;
  private config: OpenAIProviderConfig;

  constructor(config: OpenAIProviderConfig) {
    super();
    this.config = config;
  }

  private async getClient(): Promise<any> {
    if (!this.client) {
      const { default: OpenAI } = await import('openai');
      this.client = new OpenAI({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseUrl,
        organization: this.config.organization,
      });
    }
    return this.client;
  }

  private formatMessages(messages: Message[]): any[] {
    return messages.map((msg) => {
      if (typeof msg.content === 'string') {
        return { role: msg.role, content: msg.content };
      }

      const parts: any[] = msg.content.map((part: ContentPart) => {
        switch (part.type) {
          case 'text':
            return { type: 'text', text: part.text };
          case 'image': {
            const src = part.source;
            if ('url' in src) {
              return { type: 'image_url', image_url: { url: src.url } };
            }
            if ('base64' in src) {
              const mime = src.mimeType || 'image/png';
              return { type: 'image_url', image_url: { url: `data:${mime};base64,${src.base64}` } };
            }
            if ('buffer' in src) {
              const mime = src.mimeType || 'image/png';
              const b64 = src.buffer.toString('base64');
              return { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } };
            }
            return { type: 'text', text: '[image from path — requires preprocessing]' };
          }
          default:
            return { type: 'text', text: `[${part.type} content — not yet supported for this provider]` };
        }
      });

      return { role: msg.role, content: parts };
    });
  }

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    if (this.requiresResponsesApi(request.model)) {
      return this.completeResponses(request);
    }

    const client = await this.getClient();
    const startTime = Date.now();

    const params: any = {
      model: request.model,
      messages: this.formatMessages(request.messages),
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      top_p: request.topP,
      logit_bias: request.logitBias,
      stop: request.stop,
    };

    if (request.responseFormat?.type === 'json') {
      params.response_format = { type: 'json_object' };
    } else if (request.responseFormat?.type === 'json_schema' && request.responseFormat.schema) {
      params.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'nexus_response',
          schema: request.responseFormat.schema,
          strict: true,
        },
      };
    }

    const tools = this.formatTools(request.tools);
    if (tools) params.tools = tools;

    const result = await client.chat.completions.create(params);
    const choice = result.choices[0];
    const latency = Date.now() - startTime;

    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map((tc: any) => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

    const inputCost = (result.usage?.prompt_tokens || 0) / 1000;
    const outputCost = (result.usage?.completion_tokens || 0) / 1000;

    return {
      content: choice.message.content || '',
      role: 'assistant',
      toolCalls,
      finishReason: this.mapFinishReason(choice.finish_reason),
      meta: {
        requestId: generateRequestId(),
        providerUsed: 'openai',
        modelUsed: result.model,
        latencyMs: latency,
        tokensInput: result.usage?.prompt_tokens || 0,
        tokensOutput: result.usage?.completion_tokens || 0,
        tokensSaved: 0,
        estimatedCost: `$${(inputCost * 0.0025 + outputCost * 0.01).toFixed(4)}`,
        cacheHit: false,
        guardrailsApplied: [],
      },
    };
  }

  stream(request: CompletionRequest): NexusStream {
    const self = this;

    return this.createStream(async function* () {
      if (self.requiresResponsesApi(request.model)) {
        yield {
          type: 'error',
          error: `Model "${request.model}" requires the OpenAI Responses API. Streaming for Responses-only models is not implemented yet.`,
        } satisfies StreamChunk;
        return;
      }

      const client = await self.getClient();
      const startTime = Date.now();

      const params: any = {
        model: request.model,
        messages: self.formatMessages(request.messages),
        temperature: request.temperature,
        max_tokens: request.maxTokens,
        top_p: request.topP,
        logit_bias: request.logitBias,
        stop: request.stop,
        stream: true,
      };

      if (request.responseFormat?.type === 'json') {
        params.response_format = { type: 'json_object' };
      } else if (request.responseFormat?.type === 'json_schema' && request.responseFormat.schema) {
        params.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'nexus_response',
            schema: request.responseFormat.schema,
            strict: true,
          },
        };
      }

      const tools = self.formatTools(request.tools);
      if (tools) params.tools = tools;

      const stream = await client.chat.completions.create(params);

      let fullContent = '';
      const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          fullContent += delta.content;
          yield { type: 'text', content: delta.content } satisfies StreamChunk;
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!toolCallBuffers.has(tc.index)) {
              toolCallBuffers.set(tc.index, { id: tc.id || '', name: '', args: '' });
            }
            const buf = toolCallBuffers.get(tc.index)!;
            if (tc.id) buf.id = tc.id;
            if (tc.function?.name) buf.name += tc.function.name;
            if (tc.function?.arguments) buf.args += tc.function.arguments;
          }
        }

        if (chunk.choices?.[0]?.finish_reason) {
          for (const [, buf] of toolCallBuffers) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: buf.id,
                type: 'function',
                function: { name: buf.name, arguments: buf.args },
              },
            } satisfies StreamChunk;
          }

          yield {
            type: 'done',
            meta: {
              requestId: generateRequestId(),
              providerUsed: 'openai',
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

  private mapFinishReason(reason: string): NexusResponse['finishReason'] {
    switch (reason) {
      case 'stop': return 'stop';
      case 'tool_calls': return 'tool_calls';
      case 'length': return 'length';
      case 'content_filter': return 'content_filter';
      default: return 'stop';
    }
  }

  private async completeResponses(request: CompletionRequest): Promise<NexusResponse> {
    const client = await this.getClient();
    if (!client.responses?.create) {
      throw new Error(`Model "${request.model}" requires the OpenAI Responses API, but the installed openai SDK does not expose client.responses.create. Upgrade the openai package.`);
    }

    const startTime = Date.now();
    const params: any = {
      model: request.model,
      input: this.formatResponsesInput(request.messages),
      temperature: request.temperature,
      max_output_tokens: request.maxTokens,
      top_p: request.topP,
      store: false,
    };

    const tools = this.formatResponsesTools(request.tools);
    if (tools) params.tools = tools;

    if (request.responseFormat?.type === 'json') {
      params.text = { format: { type: 'json_object' } };
    } else if (request.responseFormat?.type === 'json_schema' && request.responseFormat.schema) {
      params.text = {
        format: {
          type: 'json_schema',
          name: 'nexus_response',
          schema: request.responseFormat.schema,
          strict: true,
        },
      };
    }

    const result = await client.responses.create(params);
    const latency = Date.now() - startTime;
    const content = result.output_text || this.extractResponsesText(result);
    const usage = result.usage || {};
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;

    return {
      content,
      role: 'assistant',
      finishReason: result.status === 'incomplete' ? 'length' : 'stop',
      meta: {
        requestId: generateRequestId(),
        providerUsed: 'openai',
        modelUsed: result.model || request.model,
        latencyMs: latency,
        tokensInput: inputTokens,
        tokensOutput: outputTokens,
        tokensSaved: 0,
        estimatedCost: this.estimateCost(request.model, inputTokens, outputTokens),
        cacheHit: false,
        guardrailsApplied: [],
      },
    };
  }

  private requiresResponsesApi(model: string): boolean {
    const endpoints = KNOWN_MODELS[model]?.endpoints;
    return Boolean(endpoints?.includes('responses') && !endpoints.includes('chat'));
  }

  private formatResponsesInput(messages: Message[]): any[] {
    return this.extractTextContent(messages).map((message) => ({
      role: message.role === 'tool' ? 'user' : message.role,
      content: message.content,
    }));
  }

  private formatResponsesTools(tools?: CompletionRequest['tools']): any[] | undefined {
    if (!tools?.length) return undefined;
    return tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  private extractResponsesText(result: any): string {
    return (result.output || [])
      .flatMap((item: any) => item.content || [])
      .filter((part: any) => part.type === 'output_text' || part.type === 'text')
      .map((part: any) => part.text || '')
      .join('');
  }

  private estimateCost(model: string, inputTokens: number, outputTokens: number): string {
    const caps = KNOWN_MODELS[model];
    if (!caps) return '$0.00';
    return `$${(inputTokens / 1000 * caps.costPer1kInput + outputTokens / 1000 * caps.costPer1kOutput).toFixed(4)}`;
  }
}
