import { OpenAIProvider } from './openai.js';
import type { DeepSeekProviderConfig } from '../types/config.js';

/**
 * DeepSeek chat provider using DeepSeek's OpenAI-compatible API.
 */
export class DeepSeekProvider extends OpenAIProvider {
  constructor(config: DeepSeekProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || 'https://api.deepseek.com',
      providerName: 'deepseek',
      modelPrefix: 'deepseek',
    });
  }
}
