import { OpenAIProvider } from './openai.js';
import type { OpenRouterProviderConfig } from '../types/config.js';
import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse, NexusStream } from '../types/response.js';

/** OpenRouter, one API across many hosted models, over the OpenAI chat protocol. */
export class OpenRouterProvider extends OpenAIProvider {
  /** Always `openrouter`, hosted. */
  readonly info = { name: 'openrouter', isLocal: false };

  constructor(config: OpenRouterProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || 'https://openrouter.ai/api/v1',
    });
  }

  /** Runs one completion. */
  async complete(request: CompletionRequest): Promise<NexusResponse> {
    return super.complete({ ...request, model: this.stripPrefix(request.model) });
  }

  /** Streams one completion. */
  stream(request: CompletionRequest): NexusStream {
    return super.stream({ ...request, model: this.stripPrefix(request.model) });
  }

  private stripPrefix(model: string): string {
    return model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model;
  }
}
