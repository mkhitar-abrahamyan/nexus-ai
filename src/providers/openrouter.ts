import { OpenAIProvider } from './openai.js';
import type { OpenRouterProviderConfig } from '../types/config.js';
import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse, NexusStream } from '../types/response.js';

export class OpenRouterProvider extends OpenAIProvider {
  readonly info = { name: 'openrouter', isLocal: false };

  constructor(config: OpenRouterProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || 'https://openrouter.ai/api/v1',
    });
  }

  async complete(request: CompletionRequest): Promise<NexusResponse> {
    return super.complete({ ...request, model: this.stripPrefix(request.model) });
  }

  stream(request: CompletionRequest): NexusStream {
    return super.stream({ ...request, model: this.stripPrefix(request.model) });
  }

  private stripPrefix(model: string): string {
    return model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model;
  }
}
