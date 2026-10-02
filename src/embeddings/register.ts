import type { ProvidersConfig } from '../types/config.js';
import type { EmbeddingsProvider } from '../types/embeddings.js';
import {
  CohereEmbeddingProvider,
  GoogleEmbeddingProvider,
  MistralEmbeddingProvider,
  OllamaEmbeddingProvider,
  OpenAIEmbeddingProvider,
} from './adapters.js';
import { configuredEmbeddingProviderNames } from './auto-providers.js';

/** How each automatically registered adapter is built from the chat provider's credentials. */
const FACTORIES: Record<string, (providers: ProvidersConfig) => EmbeddingsProvider> = {
  openai: ({ openai }) => new OpenAIEmbeddingProvider({ apiKey: openai?.apiKey ?? '', baseUrl: openai?.baseUrl }),
  google: ({ google }) => new GoogleEmbeddingProvider({ apiKey: google?.apiKey ?? '', baseUrl: google?.baseUrl }),
  cohere: ({ cohere }) => new CohereEmbeddingProvider({ apiKey: cohere?.apiKey ?? '', baseUrl: cohere?.baseUrl }),
  mistral: ({ mistral }) => new MistralEmbeddingProvider({ apiKey: mistral?.apiKey ?? '', baseUrl: mistral?.baseUrl }),
  ollama: ({ ollama }) => new OllamaEmbeddingProvider({ baseUrl: ollama?.baseUrl }),
};

/**
 * Builds embedding adapters from credentials already present in `providers`.
 *
 * A configured chat provider is enough to make `embed()` work, so the smallest useful setup stays
 * one provider config rather than two. Adapters are constructed lazily by the manager on first use,
 * and an explicitly registered provider of the same name always wins.
 */
export function createConfiguredEmbeddingProviders(providers: ProvidersConfig): Array<[string, EmbeddingsProvider]> {
  return configuredEmbeddingProviderNames(providers).map((name) => [
    name,
    (FACTORIES[name] as (p: ProvidersConfig) => EmbeddingsProvider)(providers),
  ]);
}
