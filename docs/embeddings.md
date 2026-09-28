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

## Requests and responses

`EmbeddingRequest` takes the `input` — an `EmbeddingInput`, one string or a list — and optionally the
`model` or an alias, the `provider`, and:

- `inputType`, an `EmbeddingInputType` of `document`, `query`, `classification`, or `clustering`.
  Store with `document` and search with `query` on providers that return different vectors for each.
- `dimensions` to shorten the vector on models that can, refused on a model with a fixed size.
- `encodingFormat`, an `EmbeddingEncodingFormat` of `float` or `base64`; `base64` is smaller on the
  wire, and both decode to numbers.
- `normalize` to scale vectors to unit length when the provider does not.
- `truncate`, an `EmbeddingTruncateMode`: `none` refuses a long input, and `start` or `end` cuts
  from that side.
- `user` for provider abuse monitoring, `userId` for rate limits and audit, a `requestId`, an
  `idempotencyKey`, a `signal`, `timeoutMs`, `retry`, `cache`, and `concurrency` for this call,
  `metadata`, and `providerOptions` merged into the provider body verbatim.

`EmbeddingResponse` has `vectors` in input order, `embeddings` — each an `Embedding` with its index,
values, size, and whether the provider cut its text — the last batch's raw payload, and
`EmbeddingMeta`: the provider and model, dimensions, count, latency, batches, usage, cost, whether it
was a full cache hit, how many inputs came from the cache or were de-duplicated, retries, and the
routing decision.

## Configuration

`EmbeddingConfig` is the client's `embeddings` option: `providers` by name, a `defaultProvider` and
`defaultModel`, `fallback` routes tried on a retryable failure, `models` — an
`EmbeddingModelRegistryConfig` of aliases, registry entries, and whether to keep the bundled ones —
per-input `cache`, `rateLimit`, `retry`, an `EmbeddingCostBudgetConfig` (a limit in US dollars, and
`error` to refuse or `warn` to report), `concurrency` for split batches (4 by default),
`deduplicate` (on by default), `timeoutMs`, and `autoRegisterProviders`, which builds adapters from
the chat credentials already in `providers` — `createConfiguredEmbeddingProviders()` is that step
on its own.

`EmbeddingManager` is the family behind `ai.embed()`, and works standalone:
`registerEmbeddingProvider()`, `hasEmbeddingProvider()`, `listEmbeddingProviders()`, `embed()`, and
`embedOne()`. `ai.embeddings` exposes the client's own. Anything with `embed()` is an
`EmbeddingSource`, which is what `toEmbeddingFunction()` adapts.

## Writing an adapter

An adapter implements `EmbeddingsProvider`: an `info` — `EmbeddingProviderInfo` with its name,
locality, version, default model, and `EmbeddingProviderCapabilities` (models, batch size, input
length, dimensions, input types, encodings, truncation, and whether vectors come back normalized; an
omitted field means unknown, not unsupported) — and `embed()`. It receives an
`EmbeddingProviderRequest`, a batch already split to fit and resolved to a concrete model, with an
`EmbeddingProviderCallContext`: the request id, a signal, the attempt, the batch index, a deadline,
the idempotency key, and trace headers. It returns an `EmbeddingProviderResult`: one vector per
input in order, `EmbeddingProviderUsage` when the provider reports tokens, the model it actually
used, whether it truncated, and the raw payload.

The bundled adapters, on `nexus-ai-pro/embeddings/adapters`, take `EmbeddingAdapterOptions` — an API
key, base URL, model, headers, and a `fetch`:

- `OpenAIEmbeddingProvider`, which also serves any OpenAI-compatible `/embeddings` server through
  `OpenAICompatibleEmbeddingOptions`: a `providerName` and the `capabilities` it declares.
- `GoogleEmbeddingProvider` and `CohereEmbeddingProvider`, which map input types to their own task
  names.
- `MistralEmbeddingProvider`, OpenAI-compatible.
- `OllamaEmbeddingProvider`, local.

`MockEmbeddingProvider`, on `nexus-ai-pro/embeddings/mock`, is deterministic for tests.
`MockEmbeddingProviderOptions` sets its name, model, dimensions (16), capabilities, the usage it
reports, a call to fail on — for retry and failover tests — and a latency.

For a vector store that needs no routing or retries at all, `createOpenAIEmbeddingProvider()`,
`createGeminiEmbeddingProvider()`, and `createCohereEmbeddingProvider()` return a bare embedding
function from `OpenAIEmbeddingOptions`, `GeminiEmbeddingOptions`, and `CohereEmbeddingOptions`.

## The embedding registry

`KNOWN_EMBEDDING_MODELS` maps each model to its `EmbeddingModelCapabilities`: the provider and
family, native dimensions and the sizes it can shorten to, input and batch limits, the price per
1,000 input tokens, whether it normalizes, the input types it distinguishes, its status, and when and
from where the entry was verified. `EMBEDDING_MODEL_ALIASES` holds stable names such as
`embed-quality`, and `EMBEDDING_REGISTRY_PROVENANCE` says when the bundled data was checked.

`/embeddings/models` reads it through your configuration: `resolveEmbeddingModel()` resolves an
alias to a `ResolvedEmbeddingModel`; `getEmbeddingModelCapabilities()`,
`getEmbeddingModelRegistry()`, and `getEmbeddingModelAliases()` return entries and merged maps;
`listEmbeddingModels()` and `listEmbeddingModelsForProvider()` list names;
`estimateEmbeddingCost()` prices an `EmbeddingCostEstimateInput` and `priceEmbeddingUsage()` prices
reported usage — embeddings bill on input only; `embeddingDimensions()` gives the size a model
produces, honouring a requested truncation; and `resolveMaxBatchSize()` takes the smaller of the
model's and the adapter's batch limits.

## Errors

Every embedding error extends `EmbeddingError` with a stable code. `EmbeddingValidationError` is a
malformed request. `EmbeddingProviderError` is a provider failure, with
`EmbeddingProviderNotFoundError` when no adapter serves the request, `EmbeddingCapabilityError` when
it cannot honour an option, and `EmbeddingProviderResponseError` when the response has the wrong
shape, such as the wrong number of vectors. `EmbeddingModelNotFoundError` names a model the registry
does not know.

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
