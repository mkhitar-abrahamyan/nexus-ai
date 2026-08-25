import { BaseProvider, type ProviderInfo } from './base.js';
import type { CacheHint, CompletionRequest, ContentPart, Message, ReasoningConfig } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk, ToolCall } from '../types/response.js';
import type { AnthropicProviderConfig } from '../types/config.js';
import type { CacheTtl, ReasoningEffort } from '../types/providers.js';
import { buildMeta, type UsageInput } from '../core/usage.js';
import { generateRequestId } from '../utils/ids.js';
import { getNumber, getRecord, getString } from './type-guards.js';

/**
 * Thinking budgets per portable effort level, in tokens.
 *
 * Anthropic budgets extended thinking in tokens rather than by effort, so the portable
 * `reasoning.effort` control is mapped onto a budget. An explicit `reasoning.maxTokens` always
 * wins over this table.
 */
const THINKING_BUDGETS: Record<ReasoningEffort, number> = {
  none: 0,
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 64000,
};

/** Anthropic requires headroom for visible output beyond the thinking budget. */
const THINKING_OUTPUT_HEADROOM = 1024;

/** Anthropic accepts at most four caller-placed cache breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Where cache breakpoints land for one request.
 *
 * `marks` maps a source message to the control that should be attached to its last content block;
 * `tools` marks the end of the tool block, which caches every definition before it.
 */
interface CachePlan {
  marks: Map<Message, AnthropicCacheControl>;
  tools?: AnthropicCacheControl;
}

function cacheControl(hint: CacheHint | undefined, fallbackTtl: CacheTtl | undefined): AnthropicCacheControl {
  const ttl = (typeof hint === 'object' ? hint.ttl : undefined) || fallbackTtl;
  // The default lifetime needs no field, so a short-lived breakpoint stays compatible with API
  // versions that predate the configurable TTL.
  return ttl && ttl !== '5m' ? { type: 'ephemeral', ttl } : { type: 'ephemeral' };
}

/**
 * Chooses which caller marks become wire breakpoints.
 *
 * Marks are collected in wire order (tools, then messages) and the deepest ones are kept when
 * there are more marks than the provider allows, because a deeper breakpoint caches strictly more
 * of the prompt than a shallower one.
 */
function planCache(request: CompletionRequest): CachePlan | undefined {
  if (request.cache?.mode !== 'explicit') return undefined;

  const limit = Math.max(1, Math.min(request.cache.maxBreakpoints ?? MAX_CACHE_BREAKPOINTS, MAX_CACHE_BREAKPOINTS));
  const fallbackTtl = request.cache.ttl;
  const cachedTool = request.tools?.find((tool) => tool.cache);
  const ordered: Array<{ message?: Message; hint: CacheHint }> = [];

  if (cachedTool?.cache) ordered.push({ hint: cachedTool.cache });
  for (const message of request.messages) {
    if (message.cache) ordered.push({ message, hint: message.cache });
  }

  const kept = ordered.slice(-limit);
  if (!kept.length) return undefined;

  const plan: CachePlan = { marks: new Map() };
  for (const entry of kept) {
    if (entry.message) plan.marks.set(entry.message, cacheControl(entry.hint, fallbackTtl));
    else plan.tools = cacheControl(entry.hint, fallbackTtl);
  }

  return plan;
}

/**
 * Resolves the extended-thinking budget for a request.
 *
 * An explicit `reasoning.maxTokens` wins; otherwise the portable effort level maps onto a budget.
 * Returns undefined when reasoning is off, so the parameter is never sent for an ordinary call.
 */
function thinkingBudget(reasoning: ReasoningConfig | undefined): number | undefined {
  if (!reasoning) return undefined;
  if (reasoning.maxTokens !== undefined) return reasoning.maxTokens > 0 ? reasoning.maxTokens : undefined;
  if (!reasoning.effort || reasoning.effort === 'none') return undefined;
  return THINKING_BUDGETS[reasoning.effort] || undefined;
}

function mapToolChoice(request: CompletionRequest): AnthropicToolChoice | undefined {
  const choice = request.toolChoice;
  const disableParallel = request.parallelToolCalls === false ? true : undefined;

  if (choice === undefined) {
    return disableParallel ? { type: 'auto', disable_parallel_tool_use: true } : undefined;
  }
  if (typeof choice === 'object') {
    return { type: 'tool', name: choice.name, disable_parallel_tool_use: disableParallel };
  }
  if (choice === 'required') return { type: 'any', disable_parallel_tool_use: disableParallel };
  if (choice === 'none') return { type: 'none' };
  return { type: 'auto', disable_parallel_tool_use: disableParallel };
}

/** Anthropic reports cache reads and writes outside `input_tokens`, so no subtraction is needed. */
function anthropicUsage(usage: AnthropicUsage | undefined): UsageInput {
  if (!usage) return {};
  return {
    inputTokens: usage.input_tokens || 0,
    outputTokens: usage.output_tokens || 0,
    cachedReadTokens: usage.cache_read_input_tokens,
    cachedWriteTokens: usage.cache_creation_input_tokens,
  };
}

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
  top_k?: number;
  stop_sequences?: string[];
  system?: string | AnthropicTextBlock[];
  tools?: AnthropicToolParam[];
  tool_choice?: AnthropicToolChoice;
  thinking?: { type: 'enabled'; budget_tokens: number };
  stream?: boolean;
}

interface AnthropicToolChoice {
  type: 'auto' | 'any' | 'tool' | 'none';
  name?: string;
  disable_parallel_tool_use?: boolean;
}

/** Marks the end of a cacheable prefix. Anthropic accepts at most four per request. */
interface AnthropicCacheControl {
  type: 'ephemeral';
  ttl?: CacheTtl;
}

interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl;
}

type AnthropicContentBlock =
  | AnthropicTextBlock
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
      cache_control?: AnthropicCacheControl;
    }
  | { type: 'image'; source: { type: 'url'; url: string }; cache_control?: AnthropicCacheControl };

interface AnthropicToolParam {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: AnthropicCacheControl;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicMessageResponse {
  model: string;
  content: AnthropicResponseContentBlock[];
  stop_reason?: string | null;
  usage?: AnthropicUsage;
}

type AnthropicResponseContentBlock =
  | { type: 'text'; text?: string }
  | { type: 'thinking'; thinking?: string }
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

  private formatMessages(
    messages: Message[],
    plan?: CachePlan,
  ): { system?: string | AnthropicTextBlock[]; messages: AnthropicMessageParam[] } {
    let system: string | AnthropicTextBlock[] | undefined;
    const formatted: AnthropicMessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = this.textFromContent(msg.content);
        const control = plan?.marks.get(msg);
        // A cached system prompt has to be sent as a block so the breakpoint has somewhere to sit.
        system = control ? [{ type: 'text', text, cache_control: control }] : text;
        continue;
      }

      const control = plan?.marks.get(msg);

      if (typeof msg.content === 'string') {
        formatted.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: control ? [{ type: 'text', text: msg.content, cache_control: control }] : msg.content,
        });
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

      if (control && parts.length) {
        parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: control };
      }

      formatted.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: parts });
    }

    return { system, messages: formatted };
  }

  private formatToolsAnthropic(tools?: CompletionRequest['tools'], plan?: CachePlan): AnthropicToolParam[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    const formatted: AnthropicToolParam[] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));

    // One breakpoint after the whole tool block caches every definition before it.
    if (plan?.tools) {
      formatted[formatted.length - 1] = { ...formatted[formatted.length - 1], cache_control: plan.tools };
    }

    return formatted;
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
        meta: buildMeta({
          provider: this.info.name,
          model: result.model,
          latencyMs: latency,
          cacheTtl: providerRequest.cache?.ttl,
          ...anthropicUsage(result.usage),
        }),
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
        const stream = client.messages.stream(
          {
            ...self.createParams(providerRequest),
            stream: true,
          },
          self.requestOptions(providerRequest),
        );

        // Anthropic splits usage across the opening and closing events: prompt and cache counts
        // arrive with `message_start`, and the output total is finalized on `message_delta`.
        let usage: UsageInput = {};

        for await (const event of stream) {
          if (event.type === 'message_start') {
            const message = getRecord(event, 'message');
            usage = anthropicUsage(getRecord(message, 'usage') as AnthropicUsage | undefined);
          }

          if (event.type === 'content_block_delta') {
            const delta = getRecord(event, 'delta');
            const deltaType = getString(delta, 'type');
            if (deltaType === 'text_delta') {
              yield { type: 'text', content: getString(delta, 'text') } satisfies StreamChunk;
            } else if (deltaType === 'thinking_delta') {
              yield { type: 'reasoning', content: getString(delta, 'thinking') } satisfies StreamChunk;
            }
          }

          if (event.type === 'message_delta') {
            const eventUsage = getRecord(event, 'usage');
            if (eventUsage) usage.outputTokens = getNumber(eventUsage, 'output_tokens', usage.outputTokens || 0);
          }

          if (event.type === 'message_stop') {
            yield {
              type: 'done',
              meta: buildMeta({
                provider: self.info.name,
                model: providerRequest.model,
                latencyMs: Date.now() - startTime,
                cacheTtl: providerRequest.cache?.ttl,
                ...usage,
              }),
            } satisfies StreamChunk;
          }
        }
      } catch (error) {
        throw self.normalizeProviderError(error, self.withProviderModel(request));
      }
    }, request.signal);
  }

  private createParams(request: CompletionRequest): AnthropicMessageCreateParams {
    const plan = planCache(request);
    const { system, messages } = this.formatMessages(request.messages, plan);
    const budget = thinkingBudget(request.reasoning);
    const params: AnthropicMessageCreateParams = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens || 4096,
      temperature: request.temperature,
      top_p: request.topP,
      top_k: request.topK,
      stop_sequences: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined,
    };

    if (budget) {
      params.thinking = { type: 'enabled', budget_tokens: budget };
      // The output limit has to leave room for visible text beyond the thinking budget, and
      // Anthropic rejects temperature and top-p sampling while thinking is enabled.
      params.max_tokens = Math.max(params.max_tokens, budget + THINKING_OUTPUT_HEADROOM);
      params.temperature = undefined;
      params.top_p = undefined;
      params.top_k = undefined;
    }

    if (system) params.system = system;
    const tools = this.formatToolsAnthropic(request.tools, plan);
    if (tools) {
      params.tools = tools;
      const toolChoice = mapToolChoice(request);
      if (toolChoice) params.tool_choice = toolChoice;
    }

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
      : this.config.modelPrefix
        ? [this.config.modelPrefix]
        : [];

    for (const prefix of prefixes) {
      const marker = `${prefix}/`;
      if (model.startsWith(marker)) return model.slice(marker.length);
    }

    return model;
  }
}
