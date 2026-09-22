# Providers, routing, and the model registry

<!-- covers: ./providers ./providers/anthropic ./providers/azure-openai ./providers/base ./providers/cohere ./providers/deepseek ./providers/errors ./providers/google ./providers/groq ./providers/llamacpp ./providers/lmstudio ./providers/mistral ./providers/ollama ./providers/openai ./providers/openrouter ./providers/type-guards ./models -->

Twelve completion providers behind one contract, each on its own entry point so an application loads only the adapters it uses, plus the routing that chooses between them and the model registry it routes by. `BaseProvider` is the contract to implement for a provider that is not bundled.

## Providers and Routing

```ts
const ai = new NexusAI({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
    groq: { apiKey: process.env.GROQ_API_KEY! },
    deepseek: { apiKey: process.env.DEEPSEEK_API_KEY! },
    openrouter: { apiKey: process.env.OPENROUTER_API_KEY! },
    ollama: { baseUrl: 'http://localhost:11434' },
    lmstudio: { baseUrl: 'http://localhost:1234/v1' },
  },
  routing: {
    mode: 'auto',
    strategy: 'quality',
    requiredCapabilities: {
      streaming: true,
      minContextTokens: 128000,
    },
  },
});
```

First-class provider adapters:

- OpenAI
- Anthropic
- Google Gemini
- Ollama
- OpenRouter
- Groq
- Mistral
- Cohere
- DeepSeek
- Azure OpenAI
- LM Studio
- llama.cpp
- custom OpenAI- or Anthropic-compatible endpoints through `providers.custom` or `registerProvider(...)`

Routing modes:

- `direct` - always use the requested model or `defaultModel`
- `auto` - choose from available providers by cost, speed, quality, or privacy
- `rules` - route from request metadata
- `hybrid` - try rules first, then fall back to auto routing

## Model Registry Generation

The registry is generated from versioned provider data in `data/models/`, not hand-edited. The
Claude 5 reasoning bug fixed in 1.4.0 was exactly the kind of error a hand-written literal of 100+
models invites.

```bash
npm run registry:generate   # data/models/*.json -> src/models/generated.ts
npm run registry:check      # fails if the committed output is stale
```

`registry:check` runs as part of `npm run check`, so committed data and committed output cannot
drift apart. The generator validates required fields, price signs, context bounds, status values,
and that every alias points at a model that exists — a dangling alias otherwise fails only when a
request happens to use it.

The runtime still reads the hand-written `KNOWN_MODELS`; a test asserts the generated registry
matches it exactly. Swapping the runtime over is deliberately a separate change, so introducing the
generator cannot quietly alter pricing data in the same release.

`src/models/generated.ts` and `data/` are build-time artifacts and are **not** published. They
duplicate `KNOWN_MODELS` exactly, and shipping them in both builds would add roughly 310KB to every
install for data nothing reads. Both live in the repository, where a diff is what you actually want.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/models`

| Export | Kind | Summary |
| --- | --- | --- |
| `assertRegistryFreshness` | function | Throws when the bundled registry has not been verified inside the configured window. |
| `checkRegistryFreshness` | function | Measures how old the bundled registry data is. |
| `describeModel` | function | Reports where a model entry came from and when it was last checked. |
| `getAliasMetadata` | function | Stage and provenance for every alias, with application-registered metadata layered on top. |
| `getModelAliases` | function | Bundled and application aliases merged, application aliases winning. |
| `getModelCapabilities` | function | A model's registry entry, resolving aliases first. |
| `getModelRegistry` | function | Bundled and application model entries merged, application entries winning. |
| `listKnownModels` | function | Every model name in the registry, sorted. |
| `listModelsForProvider` | function | Every model in the registry that belongs to a provider, sorted. |
| `ModelProvenance` | interface | Where a model entry came from and when it was last checked. |
| `RegistryFreshness` | interface | How old the model registry is. |
| `ResolvedModel` | interface | A model name resolved through aliases to a model, provider, and capabilities. |
| `resolveModel` | function | Resolves an alias and looks up model capabilities. |
| `resolveModelAlias` | function | Resolves an alias, checking application aliases before bundled ones. |

### `nexus-ai-pro/providers/anthropic`

| Export | Kind | Summary |
| --- | --- | --- |
| `AnthropicProvider` | class | Anthropic's Messages API. |

### `nexus-ai-pro/providers/azure-openai`

| Export | Kind | Summary |
| --- | --- | --- |
| `AzureOpenAIProvider` | class | Azure OpenAI provider for deployment-scoped chat completions. |

### `nexus-ai-pro/providers/base`

| Export | Kind | Summary |
| --- | --- | --- |
| `BaseProvider` | class | Base class for chat providers: complete, stream, and a health check. |
| `ProviderInfo` | interface | What a provider says about itself. |

### `nexus-ai-pro/providers/cohere`

| Export | Kind | Summary |
| --- | --- | --- |
| `CohereProvider` | class | Cohere's Chat API. |

### `nexus-ai-pro/providers/deepseek`

| Export | Kind | Summary |
| --- | --- | --- |
| `DeepSeekProvider` | class | DeepSeek chat provider using DeepSeek's OpenAI-compatible API. |

### `nexus-ai-pro/providers/errors`

| Export | Kind | Summary |
| --- | --- | --- |
| `categorizeProviderError` | function | Categorizes an error from its HTTP status, then from its name, code, and message. |
| `createAbortProviderError` | function | An error for a request the caller aborted. |
| `createProviderHttpError` | function | Builds an error from a failed HTTP response, including the first 1,000 characters of its body. |
| `createTimeoutProviderError` | function | An error for a request that ran past its timeout. |
| `isAbortError` | function | Whether an error is an abort, by its name, its code, or its message. |
| `isRetryableProviderError` | function | Whether a category of failure is worth retrying: timeouts, rate limits, server errors, and network failures are. |
| `NexusProviderError` | class | An error from a provider call, carrying enough context to decide whether to retry or fall back. |
| `NexusProviderErrorCategory` | type | Why a provider call failed, in terms that decide whether to retry or fall back. |
| `NexusProviderErrorOptions` | interface | Options for constructing a `NexusProviderError`. |
| `toNexusProviderError` | function | Wraps any error as a `NexusProviderError`, inferring the status and category it does not know. |

### `nexus-ai-pro/providers/google`

| Export | Kind | Summary |
| --- | --- | --- |
| `GoogleProvider` | class | Google's Gemini API. |

### `nexus-ai-pro/providers/groq`

| Export | Kind | Summary |
| --- | --- | --- |
| `GroqProvider` | class | Groq's chat API. |

### `nexus-ai-pro/providers/llamacpp`

| Export | Kind | Summary |
| --- | --- | --- |
| `LlamaCppProvider` | class | Local llama.cpp provider for its OpenAI-compatible server. |

### `nexus-ai-pro/providers/lmstudio`

| Export | Kind | Summary |
| --- | --- | --- |
| `LMStudioProvider` | class | Local LM Studio provider for its OpenAI-compatible server. |

### `nexus-ai-pro/providers/mistral`

| Export | Kind | Summary |
| --- | --- | --- |
| `MistralProvider` | class | Mistral's chat API. |

### `nexus-ai-pro/providers/ollama`

| Export | Kind | Summary |
| --- | --- | --- |
| `OllamaProvider` | class | Ollama, for models running on this machine or a local server. |

### `nexus-ai-pro/providers/openai`

| Export | Kind | Summary |
| --- | --- | --- |
| `OpenAIProvider` | class | OpenAI's Chat Completions API, and any server compatible with it. |

### `nexus-ai-pro/providers/openrouter`

| Export | Kind | Summary |
| --- | --- | --- |
| `OpenRouterProvider` | class | OpenRouter, one API across many hosted models, over the OpenAI chat protocol. |

### `nexus-ai-pro/providers/type-guards`

| Export | Kind | Summary |
| --- | --- | --- |
| `asArray` | function | The value when it is an array, otherwise an empty one. |
| `asNumber` | function | The value when it is a finite number, otherwise the fallback. |
| `asString` | function | The value when it is a string, otherwise the fallback. |
| `getArray` | function | An array at a key, or an empty one. |
| `getNumber` | function | A finite number at a key, or the fallback. |
| `getRecord` | function | A nested object at a key, or `undefined`. |
| `getString` | function | A string at a key, or the fallback. |
| `isRecord` | function | Whether a value is a plain object, not null or an array. |
<!-- reference:end -->
