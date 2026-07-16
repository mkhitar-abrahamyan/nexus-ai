import { BaseProvider, type ProviderInfo } from './base.js';
import type { CohereProviderConfig } from '../types/config.js';
import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../types/response.js';
import { generateRequestId } from '../utils/ids.js';
import { KNOWN_MODELS } from '../types/providers.js';
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
}

export class CohereProvider extends BaseProvider {
  readonly info: ProviderInfo = { name: 'cohere', isLocal: false };
  private config: CohereProviderConfig;

  constructor(config: CohereProviderConfig) {
    super();
    this.config = config;
  }

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    const model = this.stripPrefix(request.model);
    try {
      this.throwIfAborted(request);
      const startTime = Date.now();
      const response = await fetch(`${this.baseUrl()}/v2/chat`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
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

      return {
        content,
        role: 'assistant',
        finishReason: 'stop',
        meta: {
          requestId: generateRequestId(),
          providerUsed: 'cohere',
          modelUsed: result.model || model,
          latencyMs: Date.now() - startTime,
          tokensInput: inputTokens,
          tokensOutput: outputTokens,
          tokensSaved: 0,
          estimatedCost: this.estimateCost(model, inputTokens, outputTokens),
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
      try {
        const response = await self.complete(request);
        if (response.content) {
          yield { type: 'text', content: response.content } satisfies StreamChunk;
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

  async healthCheck(): Promise<boolean> {
    const response = await fetch(`${this.baseUrl()}/v2/models`, {
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

  private estimateCost(model: string, inputTokens: number, outputTokens: number): string {
    const caps = KNOWN_MODELS[model] || KNOWN_MODELS[`cohere/${model}`];
    if (!caps) return '$0.00';
    return `$${((inputTokens / 1000) * caps.costPer1kInput + (outputTokens / 1000) * caps.costPer1kOutput).toFixed(4)}`;
  }
}
