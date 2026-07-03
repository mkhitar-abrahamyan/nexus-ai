import { OpenAIProvider } from './openai.js';
import type { LlamaCppProviderConfig } from '../types/config.js';

/**
 * Local llama.cpp provider for its OpenAI-compatible server.
 */
export class LlamaCppProvider extends OpenAIProvider {
  constructor(config: LlamaCppProviderConfig = {}) {
    super({
      apiKey: config.apiKey || 'llama.cpp',
      baseUrl: config.baseUrl || 'http://localhost:8080/v1',
      providerName: 'llamacpp',
      modelPrefix: config.modelPrefix || ['llamacpp', 'llama.cpp'],
      isLocal: true,
    });
  }
}
