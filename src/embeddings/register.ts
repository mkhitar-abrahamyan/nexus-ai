import type { ProvidersConfig } from '../types/config.js';
import type { EmbeddingsProvider } from '../types/embeddings.js';
import {
  CohereEmbeddingProvider,
  GoogleEmbeddingProvider,
  MistralEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
} from './adapters.js';

/**
 * Builds embedding adapters from credentials already present in `providers`.
 *
 * A configured chat provider is enough to make `embed()` work, so the smallest useful setup stays
 * one provider config rather than two. Adapters are constructed lazily by the manager on first use,
 * and an explicitly registered provider of the same name always wins.
 */
export function createConfiguredEmbeddingProviders(providers: ProvidersConfig): Array<[string, EmbeddingsProvider]> {
  const created: Array<[string, EmbeddingsProvider]> = [];

  if (providers.openai?.apiKey) {
    created.push([
      'openai',
      new OpenAIEmbeddingProvider({ apiKey: providers.openai.apiKey, baseUrl: providers.openai.baseUrl }),
    ]);
  }
  if (providers.google?.apiKey) {
    created.push([
      'google',
      new GoogleEmbeddingProvider({ apiKey: providers.google.apiKey, baseUrl: providers.google.baseUrl }),
    ]);
  }
  if (providers.cohere?.apiKey) {
    created.push([
      'cohere',
      new CohereEmbeddingProvider({ apiKey: providers.cohere.apiKey, baseUrl: providers.cohere.baseUrl }),
    ]);
  }
  if (providers.mistral?.apiKey) {
    created.push([
      'mistral',
      new MistralEmbeddingProvider({ apiKey: providers.mistral.apiKey, baseUrl: providers.mistral.baseUrl }),
    ]);
  }
  if (providers.ollama) {
    created.push(['ollama', new OllamaEmbeddingProvider({ baseUrl: providers.ollama.baseUrl })]);
  }

  return created;
}
