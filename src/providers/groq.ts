import { OpenAIProvider } from './openai.js';
import type { GroqProviderConfig } from '../types/config.js';
import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../types/response.js';
import { KNOWN_MODELS } from '../types/providers.js';

export class GroqProvider extends OpenAIProvider {
  readonly info = { name: 'groq', isLocal: false };

  constructor(config: GroqProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || 'https://api.groq.com/openai/v1',
    });
  }

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    const response = await super.complete({ ...request, model: this.stripPrefix(request.model) });
    return {
      ...response,
      meta: {
        ...response.meta,
        providerUsed: 'groq',
        modelUsed: response.meta.modelUsed || this.stripPrefix(request.model),
        estimatedCost: this.estimateProviderCost(request.model, response.meta.tokensInput, response.meta.tokensOutput),
      },
    };
  }

  stream(request: CompletionRequest): NexusStream {
    const stream = super.stream({ ...request, model: this.stripPrefix(request.model) });
    return this.createStream(async function* () {
      for await (const chunk of stream) {
        if (chunk.type === 'done') {
          yield {
            ...chunk,
            meta: {
              ...chunk.meta,
              providerUsed: 'groq',
            },
          } satisfies StreamChunk;
          continue;
        }
        yield chunk;
      }
    });
  }

  private stripPrefix(model: string): string {
    return model.startsWith('groq/') ? model.slice('groq/'.length) : model;
  }

  private estimateProviderCost(model: string, inputTokens: number, outputTokens: number): string {
    const caps = KNOWN_MODELS[model];
    if (!caps) return '$0.00';
    return `$${(inputTokens / 1000 * caps.costPer1kInput + outputTokens / 1000 * caps.costPer1kOutput).toFixed(4)}`;
  }
}
