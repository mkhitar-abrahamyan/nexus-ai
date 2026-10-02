# Embeddings and retrieval

<!-- covers: ./embeddings ./embeddings/adapters ./embeddings/mock ./embeddings/models -->

Turning text into vectors, from `nexus-ai-pro/embeddings`. An embedding call gets what a completion
gets: routing across providers, batching, caching, budgets, and retries. It also refuses an option a
model cannot honour, such as a dimension it does not produce, so a store never mixes incompatible
vectors. Adapters for OpenAI, Google, Cohere, Mistral, Ollama, and compatible servers are on
`nexus-ai-pro/embeddings/adapters`.

Searching the vectors, grounding answers in them, and checking those answers are in the
[grounding guide](./grounding.md).

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
import { toEmbeddingFunction } from 'nexus-ai-pro/embeddings';
import { MemoryVectorStore } from 'nexus-ai-pro/rag';

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

## Requests and responses

`EmbeddingRequest` needs only the `input`: an `EmbeddingInput`, which is one string or a list. The
rest is optional.

| Field | What it does |
| --- | --- |
| `model`, `provider` | A model or alias, and a provider, when routing should not choose. |
| `inputType` | An `EmbeddingInputType`: `document`, `query`, `classification`, or `clustering`. Store with `document` and search with `query` on providers that embed the two differently. |
| `dimensions` | Shortens the vector on models that can. Refused on a model with a fixed size. |
| `encodingFormat` | An `EmbeddingEncodingFormat`: `float`, or `base64`, which is smaller on the wire. Both come back as numbers. |
| `normalize` | Scales vectors to unit length when the provider does not. |
| `truncate` | An `EmbeddingTruncateMode`: `none` refuses a long input; `start` or `end` cuts from that side. |
| `user`, `userId` | For provider abuse monitoring, and for your rate limits and audit. |
| `requestId`, `idempotencyKey`, `signal`, `timeoutMs` | Per-call identity and control. |
| `retry`, `cache`, `concurrency` | Overrides for this call. |
| `metadata`, `providerOptions` | Application data, and fields merged into the provider body as they are. |

`EmbeddingResponse` returns:

- `vectors`, in input order;
- `embeddings`, each an `Embedding` with its index, values, size, and whether the provider cut its
  text;
- the last batch's raw payload;
- `EmbeddingMeta`: the provider and model, dimensions, count, latency, batches, usage, cost, cache and
  de-duplication counts, retries, and the routing decision.

## Configuration

`EmbeddingConfig` is the client's `embeddings` option.

| Option | What it sets |
| --- | --- |
| `providers`, `defaultProvider`, `defaultModel` | Adapters by name, and what a request uses by default. |
| `fallback` | Routes tried, in order, on a retryable failure. |
| `models` | An `EmbeddingModelRegistryConfig`: aliases, registry entries, and whether to keep the bundled ones. |
| `cache` | Caching per input, so a repeated text is embedded once. |
| `rateLimit`, `retry`, `timeoutMs` | Limits and retries, as for completions. |
| `costBudget` | An `EmbeddingCostBudgetConfig`: a limit in US dollars, and `error` to refuse or `warn` to report. |
| `concurrency` | Batches sent at once when a request is split. Defaults to 4. |
| `deduplicate` | Sends repeated texts once. On by default. |
| `autoRegisterProviders` | Builds adapters from the chat credentials already in `providers`. `createConfiguredEmbeddingProviders()` does this step on its own. |

`EmbeddingManager` is the family behind `ai.embed()`, and it works without a client too. Its methods
are `registerEmbeddingProvider()`, `hasEmbeddingProvider()`, `listEmbeddingProviders()`, `embed()`,
and `embedOne()`. A client exposes its own as `ai.embeddings`.

Anything with an `embed()` method is an `EmbeddingSource`. That is what `toEmbeddingFunction()` adapts
into the plain function vector stores take.

## Writing an adapter

An adapter implements `EmbeddingsProvider`: an `info` description and an `embed()` method.

`info` is an `EmbeddingProviderInfo`: a name, locality, version, default model, and
`EmbeddingProviderCapabilities`. Capabilities declare models, batch size, input length, dimensions,
input types, encodings, truncation, and whether vectors come back normalized. A field you leave out
means unknown, not unsupported.

`embed()` is called once per batch:

| Type | Contents |
| --- | --- |
| `EmbeddingProviderRequest` | One batch, already split to fit and resolved to a concrete model. |
| `EmbeddingProviderCallContext` | The `ProviderCallContext` every provider receives — request id, signal, deadline, idempotency key, and trace headers — with the attempt and the batch index. |
| `EmbeddingProviderResult` | What you return: one vector per input in order, the model actually used, whether it truncated, and the raw payload. |
| `EmbeddingProviderUsage` | Token counts, when the provider reports them. |

### Bundled adapters

The adapters on `nexus-ai-pro/embeddings/adapters` take `EmbeddingAdapterOptions`: an API key, a base
URL, a model, headers, and a `fetch`.

| Adapter | Notes |
| --- | --- |
| `OpenAIEmbeddingProvider` | Also serves any OpenAI-compatible `/embeddings` server, through `OpenAICompatibleEmbeddingOptions`: a `providerName` and the `capabilities` it declares. |
| `GoogleEmbeddingProvider` | Maps input types to Google's task names. |
| `CohereEmbeddingProvider` | Maps input types to Cohere's. |
| `MistralEmbeddingProvider` | OpenAI-compatible. |
| `OllamaEmbeddingProvider` | Local models. |

`MockEmbeddingProvider`, on `nexus-ai-pro/embeddings/mock`, is deterministic, for tests.
`MockEmbeddingProviderOptions` sets its name, model, dimensions (16), capabilities, and reported
usage. It can also fail on a chosen call, for retry and failover tests, and add latency.

A vector store that needs no routing or retries can use a bare function instead:
`createOpenAIEmbeddingProvider()`, `createGeminiEmbeddingProvider()`, or
`createCohereEmbeddingProvider()`. They take `OpenAIEmbeddingOptions`, `GeminiEmbeddingOptions`, and
`CohereEmbeddingOptions`.

## The embedding registry

`KNOWN_EMBEDDING_MODELS` maps each model to its `EmbeddingModelCapabilities`: provider and family,
native dimensions and the sizes it can shorten to, input and batch limits, the price per 1,000 input
tokens, whether it normalizes, the input types it distinguishes, and its status. Each entry also
records when and where it was verified.

`EMBEDDING_MODEL_ALIASES` holds stable names such as `embed-quality`. `EMBEDDING_REGISTRY_PROVENANCE`
says when the bundled data was checked.

`nexus-ai-pro/embeddings/models` reads the registry through your configuration:

| Function | Returns |
| --- | --- |
| `resolveEmbeddingModel()` | A `ResolvedEmbeddingModel` for a name or alias. |
| `getEmbeddingModelCapabilities()` | One model's entry. |
| `getEmbeddingModelRegistry()`, `getEmbeddingModelAliases()` | The merged maps. |
| `listEmbeddingModels()`, `listEmbeddingModelsForProvider()` | Model names. |
| `estimateEmbeddingCost()` | The price of an `EmbeddingCostEstimateInput`, before the call. |
| `priceEmbeddingUsage()` | The price of reported usage. Embeddings bill on input only. |
| `embeddingDimensions()` | The size a model produces, honouring a requested truncation. |
| `resolveMaxBatchSize()` | The smaller of the model's and the adapter's batch limits. |

## Errors

Every embedding error extends `EmbeddingError` and has a stable code.

| Error | When |
| --- | --- |
| `EmbeddingValidationError` | The request is malformed. |
| `EmbeddingProviderError` | The provider failed. The next three extend it. |
| `EmbeddingProviderNotFoundError` | No adapter serves the request. |
| `EmbeddingCapabilityError` | The model cannot honour an option. |
| `EmbeddingProviderResponseError` | The response has the wrong shape, such as the wrong number of vectors. |
| `EmbeddingModelNotFoundError` | The registry does not know the model. |

## Limitations

- Bundled dimensions and prices are defaults, verified on the date the registry records.
- Cost is estimated from tokens when a provider reports none.

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
| `EmbeddingProviderCallContext` | interface | What an adapter receives with every batch besides the request: the context every family's provider receives, and where this batch sits in the request. |
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
