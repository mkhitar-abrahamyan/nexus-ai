# Embeddings and retrieval

<!-- covers: ./embeddings ./embeddings/adapters ./embeddings/mock ./embeddings/models -->

Embeddings as an operation family from `nexus-ai-pro/embeddings`: routing across providers, batching, caching, budgets, retries, and capability checks that refuse a dimension or input type a model cannot honor, with OpenAI, Google, Cohere, Ollama, and compatible adapters on `nexus-ai-pro/embeddings/adapters`. Retrieval, grounding, and the checks that catch an unsupported answer are in the [grounding guide](./grounding.md).

## Embeddings

`ai.embed()` is a first-class operation, not a helper: it gets the same routing, caching, batching,
budget, retry, audit, and metrics as a completion, so embedding spend shows up next to completion
spend instead of being invisible.

The smallest call is one line, and needs no embedding-specific configuration — adapters are derived
from the provider credentials already in `providers`:

```ts
import { NexusAI } from 'nexus-ai-pro';

const ai = new NexusAI({ providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } } });

const vector = await ai.embedOne('Provider-neutral embeddings.');
```

A batch returns vectors in input order regardless of how many provider calls the model's batch
limit required, and reports what the call cost:

```ts
const response = await ai.embed({
  input: documents.map((document) => document.text),
  model: 'embed-quality',
  inputType: 'document',
  normalize: true,
});

response.vectors;                  // number[][], in input order
response.meta.batches;             // provider calls the split required
response.meta.usage.inputTokens;   // reported by the provider, or estimated when it reports none
response.meta.cost.amount;         // numeric, priced from the embedding registry
response.meta.cachedInputs;        // inputs answered from cache
response.meta.deduplicatedInputs;  // repeated inputs answered from one call
```

Caching is per input rather than per request, so a partially repeated batch only sends the texts it
has not seen. Repeated texts inside one batch are collapsed into a single provider call:

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  embeddings: {
    cache: { enabled: true, ttlSeconds: 86_400 },
    costBudget: { enabled: true, maxEstimatedCost: 5 },
    retry: { enabled: true, maxRetries: 2 },
    fallback: [{ provider: 'cohere', model: 'embed-v4.0' }],
  },
});
```

Unlike a completion, an unsupported embedding option is **refused rather than dropped**. A vector
built with different dimensions or a different input type is silently incompatible with the vectors
already in a store, and the mismatch only surfaces later as unexplained retrieval quality loss:

```ts
await ai.embed({ input: 'x', model: 'embed-english-v3.0', dimensions: 512 });
// EmbeddingCapabilityError: model has a fixed size of 1024 dimensions
```

An option the registry says nothing about is still passed through, because an undeclared capability
means unknown rather than unsupported, and `providerOptions` reaches the provider body untouched for
anything the neutral contract does not model yet.

Existing vector stores keep their contract. `toEmbeddingFunction()` adapts the family to the plain
function `MemoryVectorStore`, the semantic cache, and RAG ingestion already accept:

```ts
import { MemoryVectorStore, toEmbeddingFunction } from 'nexus-ai-pro';

const store = new MemoryVectorStore(toEmbeddingFunction(ai, { inputType: 'document' }));
```

Bundled adapters cover OpenAI (and any OpenAI-compatible `/embeddings` server), Google, Cohere,
Mistral, and Ollama. A custom adapter implements `EmbeddingsProvider` and is checked against the
neutral contract by `runEmbeddingProviderConformance()`:

```ts
import { OpenAIEmbeddingProvider } from 'nexus-ai-pro/embeddings/adapters';
import { MockEmbeddingProvider } from 'nexus-ai-pro/embeddings/mock';

ai.registerEmbeddingProvider('gateway', new OpenAIEmbeddingProvider({
  apiKey: process.env.GATEWAY_KEY!,
  baseUrl: 'https://gateway.internal/v1',
  providerName: 'gateway',
}));
ai.registerEmbeddingProvider('mock', new MockEmbeddingProvider());
```

Bundled embedding dimensions and prices are defaults, not financial truth. Override them through
`embeddings.models.registry` when exact numbers matter.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/embeddings`

| Export | Kind | Summary |
| --- | --- | --- |
| `CohereEmbeddingOptions` | interface | Options for `createCohereEmbeddingProvider()`. |
| `createCohereEmbeddingProvider` | function | A minimal Cohere embedding function, for a vector store that needs no routing or retries. |
| `createConfiguredEmbeddingProviders` | function | Builds embedding adapters from credentials already present in `providers`. |
| `createGeminiEmbeddingProvider` | function | A minimal Gemini embedding function, for a vector store that needs no routing or retries. |
| `createOpenAIEmbeddingProvider` | function | A minimal OpenAI embedding function, for a vector store that needs no routing or retries. |
| `Embedding` | interface | One vector. |
| `EmbeddingCapabilityError` | class | A requested option the target model or adapter cannot honor. |
| `EmbeddingConfig` | interface | Configuration for `ai.embed()`. |
| `EmbeddingCostBudgetConfig` | interface | Refuses or flags an embedding request whose estimated cost exceeds a limit. |
| `EmbeddingEncodingFormat` | type | Wire encoding requested from the provider. |
| `EmbeddingError` | class | Base class for embeddings errors, each with a stable `code`. |
| `EmbeddingInput` | type | One or many texts. |
| `EmbeddingInputType` | type | What the vector will be used for. |
| `EmbeddingManager` | class | Provider-neutral embeddings with routing, caching, batching, budget, retry, audit, and metrics. |
| `EmbeddingMeta` | interface | How an embedding request ran. |
| `EmbeddingModelCapabilities` | interface | What the registry knows about an embedding model. |
| `EmbeddingModelNotFoundError` | class | Raised when a model is not in the embeddings registry and no provider was named. |
| `EmbeddingModelRegistryConfig` | interface | Embedding models and aliases that extend or replace the bundled registry. |
| `EmbeddingProviderCallContext` | interface | What an adapter receives with every batch besides the request. |
| `EmbeddingProviderCapabilities` | interface | What an adapter can do. |
| `EmbeddingProviderError` | class | Raised when an embeddings provider fails. |
| `EmbeddingProviderInfo` | interface | Identifies an embeddings adapter and what it supports. |
| `EmbeddingProviderNotFoundError` | class | Raised when no provider, or no provider by the requested name, is registered. |
| `EmbeddingProviderRequest` | interface | Request handed to an adapter. |
| `EmbeddingProviderResponseError` | class | Raised when a provider's response does not have the shape the adapter expects, such as the wrong number of vectors. |
| `EmbeddingProviderResult` | interface | What an adapter returns for one batch. |
| `EmbeddingProviderUsage` | interface | Token usage an adapter reports. |
| `EmbeddingRequest` | interface | A request to `ai.embed()`: texts in, vectors out, with routing, batching, caching, and budgets handled for you. |
| `EmbeddingResponse` | interface | The result of `ai.embed()`. |
| `EmbeddingSource` | interface | Anything that answers an embedding request: an `EmbeddingManager`, or a `NexusAI` runtime. |
| `EmbeddingsProvider` | interface | An embeddings adapter. |
| `EmbeddingTruncateMode` | type | How an input longer than the model's limit is handled. |
| `EmbeddingValidationError` | class | Raised when a request is invalid before anything is sent. |
| `GeminiEmbeddingOptions` | interface | Options for `createGeminiEmbeddingProvider()`. |
| `OpenAIEmbeddingOptions` | interface | Options for `createOpenAIEmbeddingProvider()`. |
| `toEmbeddingFunction` | function | Adapts the embeddings operation family to the plain function that `MemoryVectorStore`, the semantic cache, and RAG ingestion accept. |

### `nexus-ai-pro/embeddings/adapters`

| Export | Kind | Summary |
| --- | --- | --- |
| `CohereEmbeddingProvider` | class | Cohere v2 `/embed`. |
| `EmbeddingAdapterOptions` | interface | Hosted embedding adapters. |
| `GoogleEmbeddingProvider` | class | Google Generative Language `batchEmbedContents`. |
| `MistralEmbeddingProvider` | class | Mistral `/v1/embeddings`, which follows the OpenAI request and response shape. |
| `OllamaEmbeddingProvider` | class | Local Ollama `/api/embed`. |
| `OpenAICompatibleEmbeddingOptions` | interface | Options for any server that speaks the OpenAI `/embeddings` protocol. |
| `OpenAIEmbeddingProvider` | class | OpenAI and any OpenAI-compatible `/embeddings` endpoint. |

### `nexus-ai-pro/embeddings/mock`

| Export | Kind | Summary |
| --- | --- | --- |
| `MockEmbeddingProvider` | class | Deterministic, network-free embeddings adapter. |
| `MockEmbeddingProviderOptions` | interface | Options for the mock embeddings provider. |

### `nexus-ai-pro/embeddings/models`

| Export | Kind | Summary |
| --- | --- | --- |
| `EMBEDDING_MODEL_ALIASES` | constant | Stable names that resolve to a concrete embedding model. |
| `EMBEDDING_REGISTRY_PROVENANCE` | constant | Default provenance for bundled embedding entries. |
| `EmbeddingCostEstimateInput` | interface | Input for `estimateEmbeddingCost()`. |
| `embeddingDimensions` | function | Vector size a model produces, honoring a requested truncation. |
| `estimateEmbeddingCost` | function | Prices embedding input tokens. |
| `getEmbeddingModelAliases` | function | Bundled and application embedding aliases merged, application aliases winning. |
| `getEmbeddingModelCapabilities` | function | An embedding model's registry entry, resolving aliases first. |
| `getEmbeddingModelRegistry` | function | Bundled and application embedding model entries merged, application entries winning. |
| `KNOWN_EMBEDDING_MODELS` | constant | Embedding models known to the runtime. |
| `listEmbeddingModels` | function | Every embedding model name in the registry, sorted. |
| `listEmbeddingModelsForProvider` | function | Every embedding model in the registry that belongs to a provider, sorted. |
| `priceEmbeddingUsage` | function | Prices the usage an embedding call reported. |
| `ResolvedEmbeddingModel` | interface | An embedding model name resolved through aliases to a model, provider, and capabilities. |
| `resolveEmbeddingModel` | function | Resolves an alias and looks up embedding model capabilities. |
| `resolveMaxBatchSize` | function | Largest batch the model and adapter both accept. |
<!-- reference:end -->
