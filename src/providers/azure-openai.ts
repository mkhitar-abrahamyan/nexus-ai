import { OpenAIProvider } from './openai.js';
import type { AzureOpenAIProviderConfig } from '../types/config.js';

const DEFAULT_API_VERSION = '2024-10-21';

/**
 * Azure OpenAI provider for deployment-scoped chat completions.
 */
export class AzureOpenAIProvider extends OpenAIProvider {
  constructor(config: AzureOpenAIProviderConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || deploymentBaseUrl(config.endpoint, config.deployment),
      defaultHeaders: {
        'api-key': config.apiKey,
        ...config.defaultHeaders,
      },
      defaultQuery: {
        'api-version': config.apiVersion || DEFAULT_API_VERSION,
        ...config.defaultQuery,
      },
      providerName: 'azure-openai',
      modelPrefix: ['azure-openai', 'azure'],
    });
  }
}

function deploymentBaseUrl(endpoint: string, deployment: string): string {
  return `${endpoint.replace(/\/+$/, '')}/openai/deployments/${encodeURIComponent(deployment)}`;
}
