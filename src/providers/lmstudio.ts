import { OpenAIProvider } from './openai.js';
import type { LMStudioProviderConfig } from '../types/config.js';

/**
 * Local LM Studio provider for its OpenAI-compatible server.
 */
export class LMStudioProvider extends OpenAIProvider {
  constructor(config: LMStudioProviderConfig = {}) {
    super({
      apiKey: config.apiKey || 'lm-studio',
      baseUrl: config.baseUrl || 'http://localhost:1234/v1',
      providerName: 'lmstudio',
      modelPrefix: config.modelPrefix || 'lmstudio',
      isLocal: true,
    });
  }
}
