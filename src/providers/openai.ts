import { BaseProvider, type ProviderInfo } from './base.js';
import type { CompletionRequest, ContentPart, Message } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk, ToolCall } from '../types/response.js';
import type { OpenAIProviderConfig } from '../types/config.js';
import { generateRequestId } from '../utils/ids.js';
import { KNOWN_MODELS } from '../types/providers.js';
import { asArray, asNumber, asString, getArray, getNumber, getRecord, getString, isRecord } from './type-guards.js';

interface RequestOptions {
  signal?: AbortSignal;
}

interface OpenAIClient {
  chat: {
    completions: {
      create(
        params: OpenAIChatCompletionParams & { stream: true },
        options?: RequestOptions,
      ): Promise<AsyncIterable<OpenAIChatCompletionChunk>>;
      create(params: OpenAIChatCompletionParams, options?: RequestOptions): Promise<OpenAIChatCompletion>;
    };
  };
  responses?: {
    create(
      params: OpenAIResponsesCreateParams & { stream: true },
      options?: RequestOptions,
    ): Promise<AsyncIterable<OpenAIResponseStreamEvent>>;
    create(params: OpenAIResponsesCreateParams, options?: RequestOptions): Promise<OpenAIResponse>;
  };
}

interface OpenAIChatCompletionParams {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  logit_bias?: Record<string, number>;
  stop?: string | string[];
  response_format?: unknown;
  tools?: unknown[];
  stream?: boolean;
}

interface OpenAIChatMessage {
  role: Message['role'];
  content: string | OpenAIChatContentPart[];
}

type OpenAIChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIChatCompletion {
  model: string;
  choices: OpenAIChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

interface OpenAIChatChoice {
  message?: {
    content?: string | null;
    tool_calls?: unknown[];
  };
  finish_reason?: string | null;
}

interface OpenAIChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      tool_calls?: unknown[];
    };
    finish_reason?: string | null;
  }>;
}

interface OpenAIResponsesCreateParams {
  model: string;
  input: Array<{ role: string; content: string }>;
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
  store: boolean;
  text?: unknown;
  tools?: unknown[];
  stream?: boolean;
}

interface OpenAIResponse {
  model?: string;
  output_text?: string;
  status?: 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'queued' | 'incomplete' | string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  output?: unknown[];
  error?: {
    message?: string;
    code?: string;
  } | null;
}

interface OpenAIResponseFunctionCallItem {
  type: 'function_call';
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
}

type OpenAIResponseStreamEvent = Record<string, unknown> & { type: string };

export class OpenAIProvider extends BaseProvider {
  readonly info: ProviderInfo;
  private client?: OpenAIClient;
  private config: OpenAIProviderConfig;

  constructor(config: OpenAIProviderConfig) {
    super();
    this.config = config;
    this.info = {
      name: config.providerName || 'openai',
      isLocal: config.isLocal ?? false,
    };
  }

  private async getClient(): Promise<OpenAIClient> {
    if (!this.client) {
      const { default: OpenAI } = await import('openai');
      this.client = new OpenAI({
        apiKey: this.config.apiKey,
        baseURL: this.config.baseUrl,
        organization: this.config.organization,
        defaultHeaders: this.config.defaultHeaders,
        defaultQuery: this.config.defaultQuery,
      } as ConstructorParameters<typeof OpenAI>[0]) as OpenAIClient;
    }
    return this.client;
  }

  private formatMessages(messages: Message[]): OpenAIChatMessage[] {
    return messages.map((msg) => {
      if (typeof msg.content === 'string') {
        return { role: msg.role, content: msg.content };
      }

      const parts: OpenAIChatContentPart[] = msg.content.map((part: ContentPart) => {
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
            return { type: 'text', text: '[image from path requires preprocessing]' };
          }
          default:
            return { type: 'text', text: `[${part.type} content is not yet supported for this provider]` };
        }
      });

      return { role: msg.role, content: parts };
    });
  }

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    const providerRequest = this.withProviderModel(request);
    try {
      this.throwIfAborted(providerRequest);
      if (this.requiresResponsesApi(providerRequest.model)) {
        return await this.completeResponses(providerRequest);
      }

      const client = await this.getClient();
      const startTime = Date.now();
      const params = this.createChatParams(providerRequest);
      const result = await client.chat.completions.create(params, this.requestOptions(providerRequest));
      const choice = result.choices[0];

      if (!choice?.message) {
        throw new Error('OpenAI chat response did not include a message choice');
      }

      const inputTokens = result.usage?.prompt_tokens || 0;
      const outputTokens = result.usage?.completion_tokens || 0;

      return {
        content: choice.message.content || '',
        role: 'assistant',
        toolCalls: this.extractChatToolCalls(choice.message.tool_calls),
        finishReason: this.mapFinishReason(choice.finish_reason),
        meta: this.createMeta(result.model, Date.now() - startTime, inputTokens, outputTokens),
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
        if (self.requiresResponsesApi(providerRequest.model)) {
          yield* self.streamResponses(providerRequest);
          return;
        }

        const client = await self.getClient();
        const startTime = Date.now();
        const stream = await client.chat.completions.create({
          ...self.createChatParams(providerRequest),
          stream: true,
        }, self.requestOptions(providerRequest));

        const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();

        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (!delta) continue;

          if (delta.content) {
            yield { type: 'text', content: delta.content } satisfies StreamChunk;
          }

          for (const toolCall of asArray(delta.tool_calls)) {
            const index = thisToolCallIndex(toolCall, toolCallBuffers.size);
            if (!toolCallBuffers.has(index)) {
              toolCallBuffers.set(index, { id: '', name: '', args: '' });
            }
            const buffer = toolCallBuffers.get(index)!;
            const fn = getRecord(toolCall, 'function');
            const id = getString(toolCall, 'id');
            if (id) buffer.id = id;
            buffer.name += getString(fn, 'name');
            buffer.args += getString(fn, 'arguments');
          }

          if (choice.finish_reason) {
            yield* self.flushToolCalls(toolCallBuffers);
            yield {
              type: 'done',
              meta: self.createMeta(providerRequest.model, Date.now() - startTime),
            } satisfies StreamChunk;
          }
        }
      } catch (error) {
        throw self.normalizeProviderError(error, self.withProviderModel(request));
      }
    }, request.signal);
  }

  private createChatParams(request: CompletionRequest): OpenAIChatCompletionParams {
    const params: OpenAIChatCompletionParams = {
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

    return params;
  }

  private mapFinishReason(reason: string | null | undefined): NexusResponse['finishReason'] {
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
    const responses = client.responses;
    if (!responses?.create) {
      throw new Error(`Model "${request.model}" requires the OpenAI Responses API, but the installed openai SDK does not expose client.responses.create. Upgrade the openai package.`);
    }

    const startTime = Date.now();
    const result = await responses.create(this.createResponsesParams(request), this.requestOptions(request));
    const inputTokens = result.usage?.input_tokens || 0;
    const outputTokens = result.usage?.output_tokens || 0;
    const toolCalls = this.extractResponsesToolCalls(result);

    return {
      content: this.extractResponsesText(result),
      role: 'assistant',
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason: toolCalls.length ? 'tool_calls' : this.mapResponsesFinishReason(result.status),
      meta: this.createMeta(result.model || request.model, Date.now() - startTime, inputTokens, outputTokens),
    };
  }

  private async *streamResponses(request: CompletionRequest): AsyncGenerator<StreamChunk> {
    const client = await this.getClient();
    const responses = client.responses;
    if (!responses?.create) {
      throw new Error(`Model "${request.model}" requires the OpenAI Responses API, but the installed openai SDK does not expose client.responses.create. Upgrade the openai package.`);
    }

    const startTime = Date.now();
    const stream = await responses.create({
      ...this.createResponsesParams(request),
      stream: true,
    }, this.requestOptions(request));
    const toolCallBuffers = new Map<string, { id: string; name: string; args: string }>();

    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta': {
          const delta = getString(event, 'delta');
          if (delta) yield { type: 'text', content: delta } satisfies StreamChunk;
          break;
        }

        case 'response.output_item.added':
        case 'response.output_item.done': {
          const item = event.item;
          if (this.isResponseFunctionCall(item)) {
            const key = item.id || item.call_id || getString(event, 'item_id') || String(getNumber(event, 'output_index'));
            toolCallBuffers.set(key, {
              id: item.call_id || item.id || key,
              name: item.name || '',
              args: item.arguments || '',
            });
          }
          break;
        }

        case 'response.function_call_arguments.delta': {
          const key = getString(event, 'item_id') || String(getNumber(event, 'output_index'));
          const buffer = toolCallBuffers.get(key) || { id: key, name: '', args: '' };
          buffer.args += getString(event, 'delta');
          toolCallBuffers.set(key, buffer);
          break;
        }

        case 'response.function_call_arguments.done': {
          const key = getString(event, 'item_id') || String(getNumber(event, 'output_index'));
          const buffer = toolCallBuffers.get(key) || { id: key, name: '', args: '' };
          buffer.args = getString(event, 'arguments', buffer.args);
          toolCallBuffers.set(key, buffer);
          break;
        }

        case 'response.completed':
        case 'response.incomplete': {
          yield* this.flushToolCalls(toolCallBuffers);
          const response = getRecord(event, 'response') as OpenAIResponse | undefined;
          const usage = response?.usage;
          yield {
            type: 'done',
            meta: this.createMeta(
              response?.model || request.model,
              Date.now() - startTime,
              usage?.input_tokens || 0,
              usage?.output_tokens || 0,
            ),
          } satisfies StreamChunk;
          return;
        }

        case 'response.failed': {
          const response = getRecord(event, 'response') as OpenAIResponse | undefined;
          throw new Error(response?.error?.message || 'OpenAI Responses stream failed');
        }

        case 'error':
          throw new Error(getString(event, 'message', 'OpenAI Responses stream error'));
      }
    }

    yield* this.flushToolCalls(toolCallBuffers);
    yield {
      type: 'done',
      meta: this.createMeta(request.model, Date.now() - startTime),
    } satisfies StreamChunk;
  }

  private createResponsesParams(request: CompletionRequest): OpenAIResponsesCreateParams {
    const params: OpenAIResponsesCreateParams = {
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

    return params;
  }

  private requiresResponsesApi(model: string): boolean {
    const endpoints = KNOWN_MODELS[model]?.endpoints;
    return Boolean(endpoints?.includes('responses') && !endpoints.includes('chat'));
  }

  private formatResponsesInput(messages: Message[]): Array<{ role: string; content: string }> {
    return this.extractTextContent(messages).map((message) => ({
      role: message.role === 'tool' ? 'user' : message.role,
      content: message.content,
    }));
  }

  private formatResponsesTools(tools?: CompletionRequest['tools']): unknown[] | undefined {
    if (!tools?.length) return undefined;
    return tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  private extractChatToolCalls(toolCalls: unknown[] | undefined): ToolCall[] | undefined {
    const normalized = asArray(toolCalls).map((toolCall) => {
      const fn = getRecord(toolCall, 'function');
      return {
        id: getString(toolCall, 'id'),
        type: 'function' as const,
        function: {
          name: getString(fn, 'name'),
          arguments: getString(fn, 'arguments'),
        },
      };
    }).filter((toolCall) => toolCall.id && toolCall.function.name);

    return normalized.length ? normalized : undefined;
  }

  private extractResponsesText(result: OpenAIResponse): string {
    if (result.output_text) return result.output_text;

    return asArray(result.output)
      .flatMap((item) => getArray(item, 'content'))
      .map((part) => {
        if (!isRecord(part)) return '';
        const type = asString(part.type);
        if (type === 'output_text' || type === 'text') return asString(part.text);
        return '';
      })
      .join('');
  }

  private extractResponsesToolCalls(result: OpenAIResponse): ToolCall[] {
    return asArray(result.output)
      .filter((item): item is OpenAIResponseFunctionCallItem => this.isResponseFunctionCall(item))
      .map((item) => ({
        id: item.call_id || item.id || generateRequestId(),
        type: 'function' as const,
        function: {
          name: item.name || '',
          arguments: item.arguments || '',
        },
      }))
      .filter((toolCall) => toolCall.function.name);
  }

  private isResponseFunctionCall(value: unknown): value is OpenAIResponseFunctionCallItem {
    return isRecord(value) && value.type === 'function_call';
  }

  private mapResponsesFinishReason(status: OpenAIResponse['status']): NexusResponse['finishReason'] {
    if (status === 'incomplete') return 'length';
    if (status === 'failed' || status === 'cancelled') return 'error';
    return 'stop';
  }

  private createMeta(
    model: string,
    latencyMs: number,
    inputTokens = 0,
    outputTokens = 0,
  ): NexusResponse['meta'] {
    return {
      requestId: generateRequestId(),
      providerUsed: this.info.name,
      modelUsed: model,
      latencyMs,
      tokensInput: inputTokens,
      tokensOutput: outputTokens,
      tokensSaved: 0,
      estimatedCost: this.estimateCost(model, inputTokens, outputTokens),
      cacheHit: false,
      guardrailsApplied: [],
    };
  }

  private estimateCost(model: string, inputTokens: number, outputTokens: number): string {
    const caps = KNOWN_MODELS[model];
    if (!caps) return '$0.00';
    return `$${(inputTokens / 1000 * caps.costPer1kInput + outputTokens / 1000 * caps.costPer1kOutput).toFixed(4)}`;
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

  private *flushToolCalls(
    toolCallBuffers: Map<number | string, { id: string; name: string; args: string }>,
  ): Generator<StreamChunk> {
    for (const [key, buffer] of toolCallBuffers) {
      if (!buffer.name) continue;
      yield {
        type: 'tool_call',
        toolCall: {
          id: buffer.id || String(key),
          type: 'function',
          function: { name: buffer.name, arguments: buffer.args },
        },
      } satisfies StreamChunk;
    }
    toolCallBuffers.clear();
  }
}

function thisToolCallIndex(toolCall: unknown, fallback: number): number {
  const index = isRecord(toolCall) ? toolCall.index : undefined;
  return asNumber(index, fallback);
}
