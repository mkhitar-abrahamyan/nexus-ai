import { BaseProvider, type ProviderInfo } from './base.js';
import type { ProviderCallContext } from '../types/lifecycle.js';
import type { CompletionRequest, ContentPart, ImageContent, Message, ToolChoice } from '../types/messages.js';
import { assetReference, imagePlaceholder, imagesOf, textOf, wireImage } from './content.js';
import type { NexusResponse, NexusStream, StreamChunk, ToolCall } from '../types/response.js';
import type { OpenAIProviderConfig } from '../types/config.js';
import { buildMeta, type UsageInput } from '../core/usage.js';
import { generateRequestId } from '../utils/ids.js';
import { KNOWN_MODELS } from '../types/providers.js';
import { asArray, asNumber, asString, getArray, getNumber, getRecord, getString, isRecord } from './type-guards.js';

interface RequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
  headers?: Record<string, string>;
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
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
  logit_bias?: Record<string, number>;
  stop?: string | string[];
  response_format?: unknown;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
}

interface OpenAIChatMessage {
  role: Message['role'];
  content: string | OpenAIChatContentPart[] | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

type OpenAIChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };

interface OpenAIChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAIChatCompletion {
  model: string;
  choices: OpenAIChatChoice[];
  usage?: OpenAIChatUsage;
}

interface OpenAIChatChoice {
  message?: {
    content?: string | null;
    reasoning_content?: string | null;
    tool_calls?: unknown[];
  };
  finish_reason?: string | null;
}

interface OpenAIChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      // DeepSeek and other OpenAI-compatible reasoning servers stream summaries here.
      reasoning_content?: string | null;
      tool_calls?: unknown[];
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIChatUsage;
}

interface OpenAIResponsesCreateParams {
  model: string;
  input: unknown[];
  temperature?: number;
  max_output_tokens?: number;
  top_p?: number;
  store: boolean;
  text?: unknown;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning?: { effort?: string; summary?: string };
  stream?: boolean;
}

interface OpenAIResponseUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAIResponse {
  model?: string;
  output_text?: string;
  status?: 'completed' | 'failed' | 'in_progress' | 'cancelled' | 'queued' | 'incomplete' | string;
  usage?: OpenAIResponseUsage;
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

/** OpenAI's Chat Completions API, and any server compatible with it. */
export class OpenAIProvider extends BaseProvider {
  /** Provider name and locality. */
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
        ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
      } as ConstructorParameters<typeof OpenAI>[0]) as OpenAIClient;
    }
    return this.client;
  }

  /**
   * The conversation in chat form. An assistant turn carries its tool calls, and each result goes
   * back as a `tool` message under the call's id. The chat API takes only text in a tool message,
   * so images a tool returned follow the run of tool messages as one user message.
   */
  private formatMessages(messages: Message[]): OpenAIChatMessage[] {
    const formatted: OpenAIChatMessage[] = [];
    let toolImages: OpenAIChatContentPart[] = [];
    const flushToolImages = (): void => {
      if (!toolImages.length) return;
      formatted.push({ role: 'user', content: [{ type: 'text', text: 'Images the tools returned:' }, ...toolImages] });
      toolImages = [];
    };

    for (const msg of messages) {
      if (msg.role === 'tool') {
        const images = imagesOf(msg.content).map((part) => this.formatContentPart(part));
        toolImages.push(...images);
        formatted.push({
          role: 'tool',
          tool_call_id: msg.toolCallId ?? '',
          content: textOf(msg.content) || (images.length ? 'The result is the images that follow.' : ''),
        });
        continue;
      }
      flushToolImages();

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        formatted.push({
          role: 'assistant',
          content: textOf(msg.content) || null,
          tool_calls: msg.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.function.name, arguments: call.function.arguments },
          })),
        });
        continue;
      }

      formatted.push({
        role: msg.role,
        content:
          typeof msg.content === 'string' ? msg.content : msg.content.map((part) => this.formatContentPart(part)),
      });
    }
    flushToolImages();
    return formatted;
  }

  private formatContentPart(part: ContentPart): OpenAIChatContentPart {
    switch (part.type) {
      case 'text':
        return { type: 'text', text: part.text };
      case 'asset':
        return { type: 'text', text: assetReference(part.asset) };
      case 'image': {
        const image = wireImage(part);
        if (image?.kind === 'url') return { type: 'image_url', image_url: { url: image.url } };
        if (image?.kind === 'base64') {
          return { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.data}` } };
        }
        return { type: 'text', text: imagePlaceholder(part) };
      }
      default:
        return { type: 'text', text: `[${part.type} content is not yet supported for this provider]` };
    }
  }

  /** Runs one completion. */
  async complete(request: CompletionRequest, context?: ProviderCallContext): Promise<NexusResponse> {
    const providerRequest = this.withProviderModel(request);
    try {
      this.throwIfAborted(providerRequest);
      if (this.requiresResponsesApi(providerRequest.model)) {
        return await this.completeResponses(providerRequest, context);
      }

      const client = await this.getClient();
      const startTime = Date.now();
      const params = this.createChatParams(providerRequest);
      const result = await client.chat.completions.create(params, this.requestOptions(providerRequest, context));
      const choice = result.choices[0];

      if (!choice?.message) {
        throw new Error('OpenAI chat response did not include a message choice');
      }

      return {
        content: choice.message.content || '',
        role: 'assistant',
        toolCalls: this.extractChatToolCalls(choice.message.tool_calls),
        finishReason: this.mapFinishReason(choice.finish_reason),
        meta: this.createMeta(result.model, Date.now() - startTime, chatUsage(result.usage)),
      };
    } catch (error) {
      throw this.normalizeProviderError(error, providerRequest);
    }
  }

  /** Streams one completion. */
  stream(request: CompletionRequest, context?: ProviderCallContext): NexusStream {
    const self = this;

    return this.createStream(async function* () {
      try {
        const providerRequest = self.withProviderModel(request);
        self.throwIfAborted(providerRequest);
        if (self.requiresResponsesApi(providerRequest.model)) {
          yield* self.streamResponses(providerRequest, context);
          return;
        }

        const client = await self.getClient();
        const startTime = Date.now();
        const streamParams: OpenAIChatCompletionParams & { stream: true } = {
          ...self.createChatParams(providerRequest),
          stream: true,
        };
        if (self.includeStreamUsage()) streamParams.stream_options = { include_usage: true };
        const stream = await client.chat.completions.create(
          streamParams,
          self.requestOptions(providerRequest, context),
        );

        const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();
        // Usage arrives on its own final chunk when stream_options is enabled, which can be after
        // the chunk carrying finish_reason, so it is captured as it appears.
        let usage: UsageInput | undefined;
        let finished = false;

        for await (const chunk of stream) {
          if (chunk.usage) usage = chatUsage(chunk.usage);

          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (!delta) continue;

          if (delta.reasoning_content) {
            yield { type: 'reasoning', content: delta.reasoning_content } satisfies StreamChunk;
          }

          if (delta.content) {
            yield { type: 'text', content: delta.content } satisfies StreamChunk;
          }

          for (const toolCall of asArray(delta.tool_calls)) {
            const index = thisToolCallIndex(toolCall, toolCallBuffers.size);
            let buffer = toolCallBuffers.get(index);
            if (!buffer) {
              buffer = { id: '', name: '', args: '' };
              toolCallBuffers.set(index, buffer);
            }
            const fn = getRecord(toolCall, 'function');
            const id = getString(toolCall, 'id');
            if (id) buffer.id = id;
            buffer.name += getString(fn, 'name');
            buffer.args += getString(fn, 'arguments');
          }

          if (choice.finish_reason) {
            yield* self.flushToolCalls(toolCallBuffers);
            finished = true;
            yield {
              type: 'done',
              meta: self.createMeta(providerRequest.model, Date.now() - startTime, usage),
            } satisfies StreamChunk;
          }
        }

        // A usage-only chunk can follow the finish chunk. Emitting a second `done` would confuse
        // consumers, so the totals are only reported here when no finish chunk ever arrived.
        if (!finished) {
          yield* self.flushToolCalls(toolCallBuffers);
          yield {
            type: 'done',
            meta: self.createMeta(providerRequest.model, Date.now() - startTime, usage),
          } satisfies StreamChunk;
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
      // Not part of the OpenAI schema, but accepted by llama.cpp, LM Studio, and other
      // OpenAI-compatible servers. Capability negotiation removes it for models that declare
      // `topK: false`, so it only reaches a server that can use it.
      top_k: request.topK,
      frequency_penalty: request.frequencyPenalty,
      presence_penalty: request.presencePenalty,
      seed: request.seed,
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
    if (tools) {
      params.tools = tools;
      const toolChoice = mapChatToolChoice(request.toolChoice);
      if (toolChoice !== undefined) params.tool_choice = toolChoice;
      if (request.parallelToolCalls !== undefined) params.parallel_tool_calls = request.parallelToolCalls;
    }

    if (request.reasoning?.effort) params.reasoning_effort = request.reasoning.effort;

    return params;
  }

  /**
   * Whether to ask for usage totals on the final streamed chunk.
   *
   * Enabled for OpenAI and Azure by default, where `stream_options` is part of the API. Other
   * OpenAI-compatible servers vary, so they opt in through `streamUsage` rather than risking a
   * rejected request.
   */
  protected includeStreamUsage(): boolean {
    return this.config.streamUsage ?? this.info.name === 'openai';
  }

  private mapFinishReason(reason: string | null | undefined): NexusResponse['finishReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'tool_calls':
        return 'tool_calls';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'stop';
    }
  }

  private async completeResponses(request: CompletionRequest, context?: ProviderCallContext): Promise<NexusResponse> {
    const client = await this.getClient();
    const responses = client.responses;
    if (!responses?.create) {
      throw new Error(
        `Model "${request.model}" requires the OpenAI Responses API, but the installed openai SDK does not expose client.responses.create. Upgrade the openai package.`,
      );
    }

    const startTime = Date.now();
    const result = await responses.create(this.createResponsesParams(request), this.requestOptions(request, context));
    const toolCalls = this.extractResponsesToolCalls(result);

    return {
      content: this.extractResponsesText(result),
      role: 'assistant',
      toolCalls: toolCalls.length ? toolCalls : undefined,
      finishReason: toolCalls.length ? 'tool_calls' : this.mapResponsesFinishReason(result.status),
      meta: this.createMeta(result.model || request.model, Date.now() - startTime, responsesUsage(result.usage)),
    };
  }

  private async *streamResponses(
    request: CompletionRequest,
    context?: ProviderCallContext,
  ): AsyncGenerator<StreamChunk> {
    const client = await this.getClient();
    const responses = client.responses;
    if (!responses?.create) {
      throw new Error(
        `Model "${request.model}" requires the OpenAI Responses API, but the installed openai SDK does not expose client.responses.create. Upgrade the openai package.`,
      );
    }

    const startTime = Date.now();
    const stream = await responses.create(
      {
        ...this.createResponsesParams(request),
        stream: true,
      },
      this.requestOptions(request, context),
    );
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
            const key =
              item.id || item.call_id || getString(event, 'item_id') || String(getNumber(event, 'output_index'));
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

        case 'response.reasoning_summary_text.delta': {
          const delta = getString(event, 'delta');
          if (delta) yield { type: 'reasoning', content: delta } satisfies StreamChunk;
          break;
        }

        case 'response.completed':
        case 'response.incomplete': {
          yield* this.flushToolCalls(toolCallBuffers);
          const response = getRecord(event, 'response') as OpenAIResponse | undefined;
          yield {
            type: 'done',
            meta: this.createMeta(
              response?.model || request.model,
              Date.now() - startTime,
              responsesUsage(response?.usage),
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
    if (tools) {
      params.tools = tools;
      const toolChoice = mapResponsesToolChoice(request.toolChoice);
      if (toolChoice !== undefined) params.tool_choice = toolChoice;
      if (request.parallelToolCalls !== undefined) params.parallel_tool_calls = request.parallelToolCalls;
    }

    // The Responses API takes reasoning as a structured field rather than `reasoning_effort`, and
    // it is the only OpenAI surface that can return reasoning summaries.
    if (request.reasoning?.effort || (request.reasoning?.summary && request.reasoning.summary !== 'none')) {
      params.reasoning = {
        effort: request.reasoning.effort,
        summary: request.reasoning.summary === 'none' ? undefined : request.reasoning.summary,
      };
    }

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

  /**
   * The conversation as Responses input items: a tool call is a `function_call` item, its result a
   * `function_call_output` item under the same call id, and images a tool returned follow as one
   * user message.
   */
  private formatResponsesInput(messages: Message[]): unknown[] {
    const input: unknown[] = [];
    let toolImages: ImageContent[] = [];
    const flushToolImages = (): void => {
      if (!toolImages.length) return;
      input.push({
        role: 'user',
        content: [
          { type: 'input_text', text: 'Images the tools returned:' },
          ...toolImages.map((part) => this.responsesImage(part)),
        ],
      });
      toolImages = [];
    };

    for (const message of messages) {
      if (message.role === 'tool') {
        const images = imagesOf(message.content);
        toolImages.push(...images);
        input.push({
          type: 'function_call_output',
          call_id: message.toolCallId ?? '',
          output: textOf(message.content) || (images.length ? 'The result is the images that follow.' : ''),
        });
        continue;
      }
      flushToolImages();

      if (message.role === 'assistant' && message.toolCalls?.length) {
        const said = textOf(message.content);
        if (said) input.push({ role: 'assistant', content: said });
        for (const call of message.toolCalls) {
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          });
        }
        continue;
      }

      const images = message.role === 'user' ? imagesOf(message.content) : [];
      input.push(
        images.length
          ? {
              role: message.role,
              content: [
                { type: 'input_text', text: textOf(message.content) },
                ...images.map((part) => this.responsesImage(part)),
              ],
            }
          : { role: message.role, content: textOf(message.content) },
      );
    }
    flushToolImages();
    return input;
  }

  private responsesImage(part: ImageContent): Record<string, unknown> {
    const image = wireImage(part);
    if (image?.kind === 'url') return { type: 'input_image', image_url: image.url };
    if (image?.kind === 'base64')
      return { type: 'input_image', image_url: `data:${image.mimeType};base64,${image.data}` };
    return { type: 'input_text', text: imagePlaceholder(part) };
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
    const normalized = asArray(toolCalls)
      .map((toolCall) => {
        const fn = getRecord(toolCall, 'function');
        return {
          id: getString(toolCall, 'id'),
          type: 'function' as const,
          function: {
            name: getString(fn, 'name'),
            arguments: getString(fn, 'arguments'),
          },
        };
      })
      .filter((toolCall) => toolCall.id && toolCall.function.name);

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

  private createMeta(model: string, latencyMs: number, usage: UsageInput = {}): NexusResponse['meta'] {
    return buildMeta({ provider: this.info.name, model, latencyMs, ...usage });
  }

  private requestOptions(request: CompletionRequest, context?: ProviderCallContext): RequestOptions | undefined {
    const options: RequestOptions = {};
    if (request.signal) options.signal = request.signal;
    if (context?.idempotencyKey) options.idempotencyKey = context.idempotencyKey;
    if (context?.traceContext) options.headers = context.traceContext;
    return options.signal || options.idempotencyKey || options.headers ? options : undefined;
  }

  private withProviderModel(request: CompletionRequest): CompletionRequest {
    const model = this.stripConfiguredPrefix(request.model);
    return model === request.model ? request : { ...request, model };
  }

  private stripConfiguredPrefix(model: string): string {
    const prefixes = Array.isArray(this.config.modelPrefix)
      ? this.config.modelPrefix
      : this.config.modelPrefix
        ? [this.config.modelPrefix]
        : [];

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

/**
 * Normalizes chat usage.
 *
 * OpenAI counts cached tokens inside `prompt_tokens`, so the cached share is subtracted to leave
 * only the tokens billed at the standard input rate.
 */
function chatUsage(usage: OpenAIChatUsage | undefined): UsageInput {
  if (!usage) return {};
  const cachedReadTokens = usage.prompt_tokens_details?.cached_tokens;
  return {
    inputTokens: Math.max(0, (usage.prompt_tokens || 0) - (cachedReadTokens || 0)),
    outputTokens: usage.completion_tokens || 0,
    cachedReadTokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
  };
}

/** Normalizes Responses API usage, which reports cached input the same way. */
function responsesUsage(usage: OpenAIResponseUsage | undefined): UsageInput {
  if (!usage) return {};
  const cachedReadTokens = usage.input_tokens_details?.cached_tokens;
  return {
    inputTokens: Math.max(0, (usage.input_tokens || 0) - (cachedReadTokens || 0)),
    outputTokens: usage.output_tokens || 0,
    cachedReadTokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
  };
}

function mapChatToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined) return undefined;
  if (typeof choice === 'string') return choice;
  return { type: 'function', function: { name: choice.name } };
}

function mapResponsesToolChoice(choice: ToolChoice | undefined): unknown {
  if (choice === undefined) return undefined;
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.name };
}
