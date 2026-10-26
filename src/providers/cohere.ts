import { BaseProvider, type ProviderInfo } from './base.js';
import type { CohereProviderConfig } from '../types/config.js';
import type { ProviderCallContext } from '../types/lifecycle.js';
import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk, TokenLogprob } from '../types/response.js';
import { buildMeta, priceUsage } from '../core/usage.js';
import { createProviderHttpError } from './errors.js';
import { asString, getString, isRecord } from './type-guards.js';

type CohereContent = string | Array<string | { text?: string }>;

interface CohereUsage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface CohereChatResponse {
  model?: string;
  message?: {
    content?: CohereContent;
  };
  content?: CohereContent;
  text?: string;
  usage?: CohereUsage & {
    tokens?: CohereUsage;
  };
  /** Each piece of text and its tokens' log probabilities, when they were asked for. */
  logprobs?: Array<{ token_ids?: number[]; text?: string; logprobs?: number[] }>;
}

/** Cohere's Chat API. */
export class CohereProvider extends BaseProvider {
  /** Always `cohere`, hosted. */
  readonly info: ProviderInfo = { name: 'cohere', isLocal: false };
  private config: CohereProviderConfig;

  constructor(config: CohereProviderConfig) {
    super();
    this.config = config;
  }

  /** Runs one completion. */
  async complete(request: CompletionRequest, context?: ProviderCallContext): Promise<NexusResponse> {
    const model = this.stripPrefix(request.model);
    try {
      this.throwIfAborted(request);
      const startTime = Date.now();
      // A credential resolved for this call's tenant replaces the configured key.
      const credential = await context?.credential?.('cohere');
      const response = await (this.config.fetch ?? fetch)(`${this.baseUrl()}/v2/chat`, {
        method: 'POST',
        headers: {
          ...credential?.headers,
          Authorization: `Bearer ${credential?.apiKey ?? this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: this.extractTextContent(request.messages).map((message) => ({
            role: message.role === 'tool' ? 'user' : message.role,
            content: message.content,
          })),
          temperature: request.temperature,
          max_tokens: request.maxTokens,
          p: request.topP,
          k: request.topK,
          seed: request.seed,
          frequency_penalty: request.frequencyPenalty,
          presence_penalty: request.presencePenalty,
          ...(request.logprobs ? { logprobs: true } : {}),
        }),
        signal: request.signal,
      });

      if (!response.ok) {
        throw await createProviderHttpError('cohere', model, response);
      }

      const result = (await response.json()) as CohereChatResponse;
      const content = this.extractResponseText(result);
      const usage = result.usage?.tokens || result.usage || {};
      const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
      const outputTokens = usage.output_tokens || usage.completion_tokens || 0;

      const meta = buildMeta({
        provider: 'cohere',
        model: result.model || model,
        latencyMs: Date.now() - startTime,
        inputTokens,
        outputTokens,
      });
      // The registry files Cohere models under the `cohere/` prefix the API does not accept.
      if (meta.usage) meta.cost = priceUsage({ model: `cohere/${model}`, usage: meta.usage });
      const logprobs = cohereLogprobs(result.logprobs);
      return { content, role: 'assistant', finishReason: 'stop', ...(logprobs ? { logprobs } : {}), meta };
    } catch (error) {
      throw this.normalizeProviderError(error, request, { model });
    }
  }

  /** Streams one completion. */
  stream(request: CompletionRequest, context?: ProviderCallContext): NexusStream {
    const self = this;
    return this.createStream(async function* () {
      try {
        const response = await self.complete(request, context);
        if (response.content) {
          yield {
            type: 'text',
            content: response.content,
            ...(response.logprobs ? { logprobs: response.logprobs } : {}),
          } satisfies StreamChunk;
        }
        yield { type: 'done', meta: response.meta } satisfies StreamChunk;
      } catch (error) {
        yield {
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        } satisfies StreamChunk;
      }
    }, request.signal);
  }

  /** Whether the models endpoint answers with the configured key. */
  async healthCheck(): Promise<boolean> {
    const response = await (this.config.fetch ?? fetch)(`${this.baseUrl()}/v2/models`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
    });
    return response.ok;
  }

  private baseUrl(): string {
    return this.config.baseUrl || 'https://api.cohere.com';
  }

  private stripPrefix(model: string): string {
    return model.startsWith('cohere/') ? model.slice('cohere/'.length) : model;
  }

  private extractResponseText(result: CohereChatResponse): string {
    const content = result.message?.content || result.content || [];
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (isRecord(part)) return getString(part, 'text');
          return asString(part);
        })
        .join('');
    }
    return result.text || '';
  }
}

/**
 * Cohere's log probabilities, a piece of text at a time: each piece, which may be several tokens, is one
 * entry, its log probability the sum of its tokens'. Cohere reports no alternatives.
 */
function cohereLogprobs(items: CohereChatResponse['logprobs']): TokenLogprob[] | undefined {
  if (!items?.length) return undefined;
  return items.map((item) => ({
    token: item.text ?? '',
    logprob: (item.logprobs ?? []).reduce((sum, value) => sum + value, 0),
  }));
}
