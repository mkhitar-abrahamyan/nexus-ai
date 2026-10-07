import { BaseProvider, type ProviderInfo } from './base.js';
import { assetReference, imagePlaceholder, textOf, toolArguments, wireImage } from './content.js';
import type { ProviderCallContext } from '../types/lifecycle.js';
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

/**
 * How a Claude model takes reasoning controls, read from its name.
 *
 * From the 4.6 generation on, Claude thinks adaptively and is steered by `output_config.effort`. A
 * thinking budget is deprecated on 4.6 and rejected after it, so only earlier models get one.
 */
interface ClaudeThinkingRules {
  /** `adaptive` takes an effort, `budget` a token budget. */
  mode: 'adaptive' | 'budget';
  /** Whether the model thinks when a request does not say. */
  thinksByDefault: boolean;
  /** How thinking is turned off, or undefined when the model always thinks. */
  off?: 'disabled' | 'between_tools';
  /** Whether the model has the `xhigh` effort level. */
  xhigh: boolean;
  /** Whether temperature, top-p, and top-k must stay at their defaults on every request. */
  fixedSampling: boolean;
}

const BUDGET_RULES: ClaudeThinkingRules = {
  mode: 'budget',
  thinksByDefault: false,
  xhigh: false,
  fixedSampling: false,
};

/**
 * The family and version in a Claude model name: `opus` and 4.6 for `claude-opus-4-6`, also with a
 * date, a platform prefix, or a platform suffix. Names from before the 4 generation give undefined.
 */
function claudeModel(model: string): { family: string; version: number } | undefined {
  const match = model.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?=$|[-@:.])/);
  if (!match) return undefined;
  return { family: match[1], version: Number(`${match[2]}.${match[3] ?? '0'}`) };
}

/** The reasoning rules of one Claude model. */
function thinkingRules(model: string): ClaudeThinkingRules {
  const parsed = claudeModel(model);
  if (!parsed || parsed.version < 4.6) return BUDGET_RULES;
  const { family, version } = parsed;
  const alwaysOn = family === 'fable' || family === 'mythos' || (family === 'opus' && version >= 5.5);
  return {
    mode: 'adaptive',
    thinksByDefault: version >= 5 || family === 'fable' || family === 'mythos',
    off: alwaysOn ? undefined : family === 'sonnet' && version >= 5.5 ? 'between_tools' : 'disabled',
    xhigh: version >= 4.7,
    fixedSampling: version >= 4.7,
  };
}

/**
 * The effort an adaptive model is asked for: the request's effort, or the smallest level whose
 * budget covers a requested `reasoning.maxTokens`, since adaptive models take no budget.
 */
function requestedEffort(reasoning: ReasoningConfig | undefined): ReasoningEffort | undefined {
  if (!reasoning) return undefined;
  if (reasoning.effort) return reasoning.effort;
  if (reasoning.maxTokens === undefined) return undefined;
  if (reasoning.maxTokens <= 0) return 'none';
  const levels: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
  return levels.find((level) => THINKING_BUDGETS[level] >= (reasoning.maxTokens ?? 0)) ?? 'max';
}

/** The wire effort for a portable one, on a model with or without `xhigh`. */
function wireEffort(effort: Exclude<ReasoningEffort, 'none'>, rules: ClaudeThinkingRules): AnthropicEffort {
  if (effort === 'minimal') return 'low';
  if (effort === 'xhigh' && !rules.xhigh) return 'high';
  return effort;
}

/**
 * Applies a request's reasoning to an adaptive model, and returns whether the model will think.
 *
 * Effort `none` turns thinking off where the model allows it; a model that always thinks gets the
 * lowest effort instead. A request that asks for reasoning summaries gets them displayed, since
 * the newest models omit thinking text unless asked.
 */
function applyAdaptiveThinking(
  params: AnthropicMessageCreateParams,
  reasoning: ReasoningConfig | undefined,
  rules: ClaudeThinkingRules,
): { thinks: boolean; effort?: AnthropicEffort } {
  const effort = requestedEffort(reasoning);
  const summary = reasoning?.summary;
  if (effort === 'none') {
    if (rules.off) {
      params.thinking = { type: rules.off };
      return { thinks: false };
    }
    params.output_config = { effort: 'low' };
    return { thinks: true, effort: 'low' };
  }
  const wire = effort ? wireEffort(effort, rules) : undefined;
  if (wire || (summary && summary !== 'none')) {
    params.thinking = summary
      ? { type: 'adaptive', display: summary === 'none' ? 'omitted' : 'summarized' }
      : { type: 'adaptive' };
    if (wire) params.output_config = { effort: wire };
    return { thinks: true, effort: wire };
  }
  return { thinks: rules.thinksByDefault };
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
    reasoningTokens: usage.output_tokens_details?.thinking_tokens,
  };
}

interface RequestOptions {
  signal?: AbortSignal;
  idempotencyKey?: string;
  headers?: Record<string, string>;
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
  thinking?: AnthropicThinking;
  output_config?: { effort: AnthropicEffort };
  stream?: boolean;
}

/** The thinking setting of one request: a budget, adaptive, off, or off before the first tool call. */
type AnthropicThinking =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'adaptive'; display?: 'summarized' | 'omitted' }
  | { type: 'disabled' }
  | { type: 'between_tools' };

/** Effort levels the Messages API takes. The portable `minimal` is sent as `low`. */
type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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

type AnthropicImageBlock =
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
      cache_control?: AnthropicCacheControl;
    }
  | { type: 'image'; source: { type: 'url'; url: string }; cache_control?: AnthropicCacheControl };

type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      cache_control?: AnthropicCacheControl;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: Array<AnthropicTextBlock | AnthropicImageBlock>;
      cache_control?: AnthropicCacheControl;
    };

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
  output_tokens_details?: { thinking_tokens?: number };
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

/** Anthropic's Messages API. */
export class AnthropicProvider extends BaseProvider {
  /** Always `anthropic`, hosted. */
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
        ...(this.config.fetch ? { fetch: this.config.fetch } : {}),
      } as ConstructorParameters<typeof Anthropic>[0]) as AnthropicClient;
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

      if (msg.role === 'tool') {
        const result: AnthropicContentBlock = {
          type: 'tool_result',
          tool_use_id: msg.toolCallId ?? '',
          // Anthropic refuses an empty text block, so a result with no text sends none.
          content: this.formatBlocks(msg.content).filter(
            (block): block is AnthropicTextBlock | AnthropicImageBlock =>
              (block.type === 'text' && block.text.length > 0) || block.type === 'image',
          ),
          ...(control ? { cache_control: control } : {}),
        };
        // Every result answering one assistant turn goes in the one user message that follows it.
        const previous = formatted.at(-1);
        if (
          previous?.role === 'user' &&
          Array.isArray(previous.content) &&
          previous.content.length > 0 &&
          previous.content.every((block) => block.type === 'tool_result')
        ) {
          previous.content.push(result);
        } else {
          formatted.push({ role: 'user', content: [result] });
        }
        continue;
      }

      if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const said = textOf(msg.content);
        const blocks: AnthropicContentBlock[] = [
          ...(said ? [{ type: 'text' as const, text: said }] : []),
          ...msg.toolCalls.map((call) => ({
            type: 'tool_use' as const,
            id: call.id,
            name: call.function.name,
            input: toolArguments(call),
          })),
        ];
        if (control)
          blocks[blocks.length - 1] = {
            ...(blocks[blocks.length - 1] as AnthropicContentBlock),
            cache_control: control,
          };
        formatted.push({ role: 'assistant', content: blocks });
        continue;
      }

      if (typeof msg.content === 'string') {
        formatted.push({
          role: msg.role === 'assistant' ? 'assistant' : 'user',
          content: control ? [{ type: 'text', text: msg.content, cache_control: control }] : msg.content,
        });
        continue;
      }

      const parts = this.formatBlocks(msg.content);
      if (control && parts.length) {
        parts[parts.length - 1] = { ...(parts[parts.length - 1] as AnthropicContentBlock), cache_control: control };
      }

      formatted.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: parts });
    }

    return { system, messages: formatted };
  }

  private formatBlocks(content: Message['content']): AnthropicContentBlock[] {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    return content.map((part: ContentPart): AnthropicContentBlock => {
      switch (part.type) {
        case 'text':
          return { type: 'text', text: part.text };
        case 'asset':
          return { type: 'text', text: assetReference(part.asset) };
        case 'image': {
          const image = wireImage(part);
          if (image?.kind === 'base64') {
            return { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } };
          }
          if (image?.kind === 'url') return { type: 'image', source: { type: 'url', url: image.url } };
          return { type: 'text', text: imagePlaceholder(part) };
        }
        default:
          return { type: 'text', text: `[${part.type} content is not yet supported for this provider]` };
      }
    });
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

  /** Runs one completion. */
  async complete(request: CompletionRequest, context?: ProviderCallContext): Promise<NexusResponse> {
    const providerRequest = this.withProviderModel(request);
    try {
      this.throwIfAborted(providerRequest);
      const client = await this.getClient();
      const startTime = Date.now();
      const params = this.createParams(providerRequest);
      const result = await client.messages.create(params, this.requestOptions(providerRequest, context));
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

  /** Streams one completion. */
  stream(request: CompletionRequest, context?: ProviderCallContext): NexusStream {
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
          self.requestOptions(providerRequest, context),
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
            if (eventUsage) {
              usage.outputTokens = getNumber(eventUsage, 'output_tokens', usage.outputTokens || 0);
              // The thinking share of the output arrives only on the final delta.
              const details = getRecord(eventUsage, 'output_tokens_details');
              if (details) usage.reasoningTokens = getNumber(details, 'thinking_tokens', 0);
            }
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
    const params: AnthropicMessageCreateParams = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens || 4096,
      temperature: request.temperature,
      top_p: request.topP,
      top_k: request.topK,
      stop_sequences: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined,
    };

    const rules = thinkingRules(request.model);
    let thinks = false;
    if (rules.mode === 'adaptive') {
      const applied = applyAdaptiveThinking(params, request.reasoning, rules);
      thinks = applied.thinks;
      // Thinking counts toward max_tokens. Without a caller limit, leave room for the thinking
      // the effort asks for, so a hard request is not cut off before its answer.
      if (thinks && request.maxTokens === undefined) {
        const effort = applied.effort ?? 'high';
        params.max_tokens = Math.max(params.max_tokens, THINKING_BUDGETS[effort] + THINKING_OUTPUT_HEADROOM);
      }
    } else {
      const budget = thinkingBudget(request.reasoning);
      if (budget) {
        params.thinking = { type: 'enabled', budget_tokens: budget };
        // The output limit has to leave room for visible text beyond the thinking budget.
        params.max_tokens = Math.max(params.max_tokens, budget + THINKING_OUTPUT_HEADROOM);
        thinks = true;
      }
    }

    // Sampling controls conflict with thinking, and from 4.7 on any non-default value is rejected.
    if (thinks || rules.fixedSampling) {
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
}
