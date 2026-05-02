import { OpenAIProvider } from './openai.js';
import type { MistralProviderConfig } from '../types/config.js';
import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../types/response.js';
import { KNOWN_MODELS } from '../types/providers.js';

export class MistralProvider extends OpenAIProvider {
  readonly info = { name: 'mistral', isLocal: false };

  constructor(config: MistralProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || 'https://api.mistral.ai/v1',
    });
  }

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    const response = await super.complete({ ...request, model: this.stripPrefix(request.model) });
    return {
      ...response,
      meta: {
        ...response.meta,
        providerUsed: 'mistral',
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
              providerUsed: 'mistral',
            },
          } satisfies StreamChunk;
          continue;
        }
        yield chunk;
      }
    });
  }

  private stripPrefix(model: string): string {
    return model.startsWith('mistral/') ? model.slice('mistral/'.length) : model;
  }

  private estimateProviderCost(model: string, inputTokens: number, outputTokens: number): string {
    const caps = KNOWN_MODELS[model];
    if (!caps) return '$0.00';
    return `$${(inputTokens / 1000 * caps.costPer1kInput + outputTokens / 1000 * caps.costPer1kOutput).toFixed(4)}`;
  }
}
