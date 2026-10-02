import type { ProvidersConfig } from '../types/config.js';

/**
 * The embedding providers a client's chat credentials imply, by name, without building them: an API
 * key for OpenAI, Google, Cohere, or Mistral, or any Ollama config.
 */
export function configuredEmbeddingProviderNames(providers: ProvidersConfig): string[] {
  const names: string[] = [];
  if (providers.openai?.apiKey) names.push('openai');
  if (providers.google?.apiKey) names.push('google');
  if (providers.cohere?.apiKey) names.push('cohere');
  if (providers.mistral?.apiKey) names.push('mistral');
  if (providers.ollama) names.push('ollama');
  return names;
}
