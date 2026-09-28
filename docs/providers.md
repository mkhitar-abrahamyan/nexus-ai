# Providers, routing, and the model registry

<!-- covers: ./providers ./providers/anthropic ./providers/azure-openai ./providers/base ./providers/cohere ./providers/deepseek ./providers/errors ./providers/google ./providers/groq ./providers/llamacpp ./providers/lmstudio ./providers/mistral ./providers/ollama ./providers/openai ./providers/openrouter ./providers/type-guards ./models -->
<!-- sources: src/router -->

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

## The adapters

Each adapter has its own entry point, so an application that uses one provider loads one:

| Adapter | Entry point | Notes |
| --- | --- | --- |
| `OpenAIProvider` | `/providers/openai` | Chat Completions and the Responses API; the base of the OpenAI-compatible adapters below |
| `AnthropicProvider` | `/providers/anthropic` | Messages API, with extended thinking mapped from `reasoning.effort` and explicit cache breakpoints |
| `GoogleProvider` | `/providers/google` | Gemini, with thinking budgets mapped from effort and cached tokens separated out of the prompt count |
| `AzureOpenAIProvider` | `/providers/azure-openai` | OpenAI on an Azure endpoint and deployment |
| `OpenRouterProvider` | `/providers/openrouter` | Many vendors' models through one OpenAI-compatible API |
| `GroqProvider` | `/providers/groq` | Groq's OpenAI-compatible chat API |
| `MistralProvider` | `/providers/mistral` | Mistral's chat API |
| `DeepSeekProvider` | `/providers/deepseek` | DeepSeek's OpenAI-compatible API |
| `CohereProvider` | `/providers/cohere` | Cohere's Chat API |
| `OllamaProvider` | `/providers/ollama` | Models on this machine or a local server; local, so privacy routing prefers it |
| `LMStudioProvider` | `/providers/lmstudio` | LM Studio's local OpenAI-compatible server |
| `LlamaCppProvider` | `/providers/llamacpp` | llama.cpp's local OpenAI-compatible server |

The client constructs them from `providers` configuration; construct one yourself to call it
directly or to register it under another name.

## Writing a provider

`BaseProvider`, on `/providers/base`, is the contract: an `info` — a `ProviderInfo` with the name and
whether it runs locally, which privacy routing prefers — `complete()`, `stream()`, and a
`healthCheck()` that defaults to true. Protected helpers build the base response, extract text,
format tools, normalize errors, honour an aborted signal, and turn an async generator into a
`NexusStream`, so a new adapter is mostly its request and response mapping.

`/providers/type-guards` has the small readers adapters use on untyped JSON: `isRecord()`,
`asArray()`, `asString()`, and `asNumber()` coerce a value with a fallback, and `getRecord()`,
`getArray()`, `getString()`, and `getNumber()` read one key safely.

## Provider errors

Every adapter reports failure as a `NexusProviderError`: the provider, the model, the HTTP status, a
`NexusProviderErrorCategory` — `auth`, `abort`, `timeout`, `rate-limit`, `server-error`, `network`,
`bad-response`, or `unknown` — whether retrying could succeed, and the cause. `NexusProviderErrorOptions`
constructs one, inferring the category and retryability it is not given. Retries, failover, and the
circuit breaker all decide from these fields.

`/providers/errors` has the builders adapters share. `createProviderHttpError()` builds one from a
failed response, with the first 1,000 characters of its body. `toNexusProviderError()` wraps any
error, returning a provider error unchanged. `createAbortProviderError()` is for a request the caller
aborted, never retryable; `createTimeoutProviderError()` is for one that ran past its timeout,
retryable. `categorizeProviderError()` infers a category from the status, then the error's name,
code, and message; `isRetryableProviderError()` says whether a category is worth retrying — timeouts,
rate limits, server errors, and network failures are — and `isAbortError()` recognizes an abort.

## Routing internals

`Router` makes the decision: a directly named model, a matching rule, or the auto-router's ranking,
then the fallbacks `routing.fallback` adds. A routing strategy sees a `RouterContext` — the request,
the configuration, the providers, their health, and the providers whose circuit is open, which are
excluded entirely rather than ranked lower. It returns a `RouteDecision`: the provider and model to
try first, why, limits for that first attempt, and the fallbacks in order. `FailoverExecutor` runs
the decision, trying each attempt with its own timeout, rate-limit retries, and circuit check, and
throws with every attempt's error when none succeeds. Both are exported for a gateway that routes
requests without the rest of the client.

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

## Reading the registry

`KNOWN_MODELS` maps each model to its `ModelCapabilities`: the provider and family, each `Modality`
it accepts, streaming, tool calling, structured output and JSON mode, reasoning with the efforts it
takes, a `PromptCachingCapability` — whether the provider accepts caller-placed breakpoints, which
`CacheTtl` lifetimes, the minimum prefix, and how many breakpoints — which request options it honours
(tool choice, parallel tool calls, seed, top-k, penalties), context and output limits, prices,
quality and speed scores, release and knowledge cutoff, a `ModelStatus`, the `ModelEndpoint` values
it is served on, and when and from where the entry was verified. `ProviderCapabilities` groups a
provider's models with its name and locality, and a `CacheHint` is a breakpoint on a message or tool. Aliases such as
`openai/best` resolve by intent; `MODEL_ALIAS_METADATA` gives each one's `AliasMetadata` — its
`AliasStage` and whether it floats — and `REGISTRY_PROVENANCE` says where the bundled data came from
and when it was verified. `resolveProvider()` names the provider a model belongs to.

`/models` reads it all through the application's own configuration, so a model registered with
`models.registry` or an alias with `models.aliases` is seen like a bundled one:

- `resolveModel()` resolves an alias to a `ResolvedModel` — the model, its provider, its
  capabilities, and the alias metadata — and runs on every completion, so it reads the maps directly
  instead of merging them. `resolveModelAlias()` resolves the name alone.
- `getModelCapabilities()` returns one model's entry; `getModelRegistry()`, `getModelAliases()`, and
  `getAliasMetadata()` return the merged maps, application entries winning.
- `listKnownModels()` and `listModelsForProvider()` list names, sorted.
- `describeModel()` returns `ModelProvenance`: the resolution plus when the entry was verified and
  where its data came from, falling back to the registry-wide date for bundled entries.
- `checkRegistryFreshness()` returns `RegistryFreshness` — when the data was verified, its age in
  days, the window (180 days by default), whether it is stale, and entries older than the window —
  and `assertRegistryFreshness()` throws when it is stale, for a release check.

## Limitations

- Bundled prices and capabilities are defaults, verified on the date the registry records. A
  provider can change either between releases; override entries with `models.registry`.
- An option a model does not declare passes through untouched, so a registry that does not know a
  feature never blocks it; it also never warns about it.
- When the model is already known, use `direct` or `rules` routing: the auto-router ranks every
  candidate on each request, which is work a known choice does not need.

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

### `nexus-ai-pro`

| Export | Kind | Summary |
| --- | --- | --- |
| `FailoverExecutor` | class | Runs a routing decision: the primary provider, then each fallback, honouring per-attempt timeouts, rate limits, and circuits. |
| `RouteDecision` | interface | Where a request goes: the provider and model to try first, and what to try if they fail. |
| `Router` | class | Chooses where a request goes: a direct model, a matching rule, or the auto-router's ranking, with the fallbacks `routing.fallback` adds on top. |
| `RouterContext` | interface | What a routing strategy sees when it picks a provider. |
<!-- reference:end -->
