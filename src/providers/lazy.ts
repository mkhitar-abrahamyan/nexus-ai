import type { ProvidersConfig } from '../types/config.js';
import type { ProviderCallContext } from '../types/lifecycle.js';
import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse, NexusStream, StreamChunk } from '../types/response.js';
import { BaseProvider, type ProviderInfo } from './base.js';

/**
 * A provider whose adapter module loads on its first call.
 *
 * The client registers one of these for every provider in its config, so importing the client
 * costs nothing for adapters a deployment never calls. `info` is known up front, which is all
 * routing reads before the first call.
 */
export class LazyProvider extends BaseProvider {
  /** The provider's name and locality, known before the adapter loads. */
  readonly info: ProviderInfo;
  private loading?: Promise<BaseProvider>;

  constructor(
    info: ProviderInfo,
    private readonly load: () => Promise<BaseProvider>,
  ) {
    super();
    this.info = info;
  }

  /** The adapter, loaded and constructed once. A failed load is retried on the next call. */
  provider(): Promise<BaseProvider> {
    this.loading ??= this.load().catch((error: unknown) => {
      this.loading = undefined;
      throw error;
    });
    return this.loading;
  }

  /** Runs one completion on the loaded adapter. */
  async complete(request: CompletionRequest, context?: ProviderCallContext): Promise<NexusResponse> {
    return (await this.provider()).complete(request, context);
  }

  /** Streams one completion, loading the adapter when the stream is first read. */
  stream(request: CompletionRequest, context?: ProviderCallContext): NexusStream {
    const self = this;
    let inner: NexusStream | undefined;
    let aborted = false;
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<StreamChunk> {
        if (aborted) return;
        inner = (await self.provider()).stream(request, context);
        if (aborted) {
          inner.abort();
          return;
        }
        yield* inner;
      },
      abort() {
        aborted = true;
        inner?.abort();
      },
    };
  }

  /** The loaded adapter's health check. */
  async healthCheck(): Promise<boolean> {
    return (await this.provider()).healthCheck();
  }
}

/**
 * One lazily loaded provider for every provider a config names, keyed as the client registers them.
 * Each loader imports only its own adapter module.
 */
export function configuredProviders(providers: ProvidersConfig): Array<[string, BaseProvider]> {
  const entries: Array<[string, BaseProvider]> = [];
  const add = (key: string, info: ProviderInfo, load: () => Promise<BaseProvider>) => {
    entries.push([key, new LazyProvider(info, load)]);
  };

  const { openai, anthropic, google, ollama, openrouter, deepseek, azureOpenAI, lmstudio, llamaCpp, groq, mistral } =
    providers;
  if (openai) {
    add('openai', { name: openai.providerName || 'openai', isLocal: openai.isLocal ?? false }, async () => {
      const { OpenAIProvider } = await import('./openai.js');
      return new OpenAIProvider(openai);
    });
  }
  if (anthropic) {
    add('anthropic', { name: anthropic.providerName || 'anthropic', isLocal: anthropic.isLocal ?? false }, async () => {
      const { AnthropicProvider } = await import('./anthropic.js');
      return new AnthropicProvider(anthropic);
    });
  }
  if (google) {
    add('google', { name: 'google', isLocal: false }, async () => {
      const { GoogleProvider } = await import('./google.js');
      return new GoogleProvider(google);
    });
  }
  if (ollama) {
    add('ollama', { name: 'ollama', isLocal: true }, async () => {
      const { OllamaProvider } = await import('./ollama.js');
      return new OllamaProvider(ollama);
    });
  }
  if (openrouter) {
    add('openrouter', { name: 'openrouter', isLocal: false }, async () => {
      const { OpenRouterProvider } = await import('./openrouter.js');
      return new OpenRouterProvider(openrouter);
    });
  }
  if (deepseek) {
    add('deepseek', { name: 'deepseek', isLocal: false }, async () => {
      const { DeepSeekProvider } = await import('./deepseek.js');
      return new DeepSeekProvider(deepseek);
    });
  }
  if (azureOpenAI) {
    add('azure-openai', { name: 'azure-openai', isLocal: false }, async () => {
      const { AzureOpenAIProvider } = await import('./azure-openai.js');
      return new AzureOpenAIProvider(azureOpenAI);
    });
  }
  if (lmstudio) {
    add('lmstudio', { name: 'lmstudio', isLocal: true }, async () => {
      const { LMStudioProvider } = await import('./lmstudio.js');
      return new LMStudioProvider(lmstudio);
    });
  }
  if (llamaCpp) {
    add('llamacpp', { name: 'llamacpp', isLocal: true }, async () => {
      const { LlamaCppProvider } = await import('./llamacpp.js');
      return new LlamaCppProvider(llamaCpp);
    });
  }
  if (groq) {
    add('groq', { name: 'groq', isLocal: false }, async () => {
      const { GroqProvider } = await import('./groq.js');
      return new GroqProvider(groq);
    });
  }
  if (mistral) {
    add('mistral', { name: 'mistral', isLocal: false }, async () => {
      const { MistralProvider } = await import('./mistral.js');
      return new MistralProvider(mistral);
    });
  }
  if (providers.cohere) {
    const cohere = providers.cohere;
    add('cohere', { name: 'cohere', isLocal: false }, async () => {
      const { CohereProvider } = await import('./cohere.js');
      return new CohereProvider(cohere);
    });
  }

  for (const custom of providers.custom || []) {
    const info = { name: custom.name, isLocal: custom.isLocal ?? false };
    if (custom.format === 'anthropic') {
      add(custom.name, info, async () => {
        const { AnthropicProvider } = await import('./anthropic.js');
        return new AnthropicProvider({
          apiKey: custom.apiKey || 'custom',
          baseUrl: custom.baseUrl,
          providerName: custom.name,
          modelPrefix: custom.modelPrefix || custom.name,
          isLocal: custom.isLocal,
        });
      });
      continue;
    }
    add(custom.name, info, async () => {
      const { OpenAIProvider } = await import('./openai.js');
      return new OpenAIProvider({
        apiKey: custom.apiKey || 'custom',
        baseUrl: custom.baseUrl,
        defaultHeaders: custom.headers,
        defaultQuery: custom.query,
        providerName: custom.name,
        modelPrefix: custom.modelPrefix || custom.name,
        isLocal: custom.isLocal,
      });
    });
  }

  return entries;
}
