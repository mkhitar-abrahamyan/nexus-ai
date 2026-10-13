# Embeddings and retrieval

<!-- covers: ./embeddings ./embeddings/adapters ./embeddings/mock ./embeddings/models ./embeddings/cache ./embeddings/batch ./embeddings/batch/openai ./embeddings/batch/google ./embeddings/batch/mock -->

Turning text, images, audio, and documents into vectors, from `nexus-ai-pro/embeddings`. An
embedding call gets what a completion gets: routing across providers, batching, caching, budgets, and
retries. It also refuses an option a model cannot honour, such as a dimension it does not produce, so
a store never mixes incompatible vectors. Adapters for OpenAI, Google, Cohere, Mistral, Ollama, and compatible servers are on
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

## Images, audio, and documents

An input can be media as well as text: an image, audio, a PDF, or text with them. A multimodal model
embeds each in the same space as text, so a text query finds the image it describes. Give the input
as `EmbeddingParts`: the same text, image, audio, and document parts a message takes.

```ts
const photos = await ai.embed({
  model: 'gemini-embedding-2',
  inputType: 'document',
  input: images.map((bytes) => ({ parts: [{ type: 'image', source: { buffer: bytes, mimeType: 'image/jpeg' } }] })),
});
await store.add(images.map((_, index) => ({ id: `photo-${index}`, content: '', embedding: photos.vectors[index] })));

const [query] = (await ai.embed({ model: 'gemini-embedding-2', inputType: 'query', input: 'a red bicycle' })).vectors;
const found = await store.searchVector(query, { topK: 5 });
```

An `EmbeddingPart` is a `TextContent`, `ImageContent`, `AudioContent`, or `DocumentContent`. Every part
of one input becomes one vector, such as a product photo with its caption. A part must hold its
content, as bytes, base64, or a URL. A path or a transcript is refused, since an embedding never reads
a file.

Media is sent only to a model that takes it. An `EmbeddingModality` is `text`, `image`, `audio`, or
`document`, and `inputModalities` on a model's registry entry says which it takes. A model without an
entry is judged by its adapter's capabilities. Anything else is refused with an
`EmbeddingCapabilityError` before any call, and a fallback that cannot take the media is skipped.

| Model | Takes | Notes |
| --- | --- | --- |
| `gemini-embedding-2` | text, image, audio, document | Up to 6 images, 180 seconds of audio, or a 6-page PDF an input. The task is a prefix on the text, which the adapter writes from `inputType`. |
| `embed-v4.0` | text, image | Images as JPEG, PNG, WebP, or GIF, 20 MB a request. |
| Every other bundled model | text | |

Google takes media inline, or by a Files API URI; Cohere takes images inline. Any other URL is refused
with the reason, since neither provider fetches it.

An image is priced at its model's `costPerImage`, beside the text's tokens. Audio and video are
billed by the second and the frame, which is not priced. A repeated medium is embedded once, and is
cached under a hash of its content.

## Sharing the cache

A shared cache lets every process reuse what any of them embedded. Re-indexing a corpus, or several
workers ingesting overlapping documents, then pays the provider only for what is new. Give
`cache.store` an `EmbeddingCacheStore`, from `nexus-ai-pro/embeddings/cache` or a database entry
point:

```ts
import Redis from 'ioredis';
import { NexusAI } from 'nexus-ai-pro';
import { MemoryEmbeddingCache, RedisEmbeddingCache, tieredEmbeddingCache } from 'nexus-ai-pro/embeddings/cache';

const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  embeddings: {
    cache: {
      store: tieredEmbeddingCache(new MemoryEmbeddingCache(), new RedisEmbeddingCache(new Redis(process.env.REDIS_URL!))),
      ttlSeconds: 30 * 86_400,
    },
  },
});
```

A store differs from a `CacheAdapter` in three ways:

- **One round trip a request.** It reads every input in one `getMany()` and writes what it embedded
  in one `setMany()`, so 2,000 cached texts cost one call, not 2,000.
- **Keys are hashes.** `embeddingCacheKey()` is a SHA-256 of the text and its
  `EmbeddingCacheContext`: the provider, model, input type, size, normalization, and truncation. No
  text is ever a key in a shared store, and the same text under another model is another entry.
- **Vectors are packed.** `packVector()` and `unpackVector()` store four bytes a dimension, against
  about twenty as JSON. Providers send float32 precision, so nothing they sent is lost.

`EmbeddingCacheConfig` is the `CacheConfig` every cache takes, plus `store`. A store turns the cache
on unless `enabled` is `false`, and takes the place of `adapter`. A store that fails fails the
request, as an adapter does. Wrap it to treat a failure as a miss.

| Store | Entry point | Where the vectors live |
| --- | --- | --- |
| `MemoryEmbeddingCache` | `nexus-ai-pro/embeddings/cache` | This process, least recently used first out. `MemoryEmbeddingCacheOptions` sets `maxEntries` (10,000). |
| `RedisEmbeddingCache` | `nexus-ai-pro/embeddings/cache` | Redis: one `MGET` and one script a batch. |
| `PostgresEmbeddingCache` | `nexus-ai-pro/postgres/embedding-cache` | A Postgres table. See the [Postgres guide](./postgres.md). |
| `SqliteEmbeddingCache` | `nexus-ai-pro/sqlite/embedding-cache` | A SQLite table. See the [SQLite guide](./sqlite.md). |

`tieredEmbeddingCache()` puts two stores in front of each other. The near one answers first, and
the far one answers the rest in one call. A far hit is copied near, and a write goes to both.

`RedisEmbeddingCache` takes a `RedisEmbeddingCacheClient`: ioredis, with `call()`, or node-redis,
with `sendCommand()`. `RedisEmbeddingCacheOptions` sets the key `prefix` (`nexus:embedding:`) and
`multiKey`. On Redis Cluster, set `multiKey: false`: each key then travels as its own command, all
sent at once, since a multi-key command needs every key in one slot.

An `EmbeddingCacheEntry` is a key and its vector. A store of your own implements the two methods.

A `cache.adapter`, without a store, keeps working with the keys it always had. It is now asked for
every input at once rather than one after another.

## A batch tier for large jobs

OpenAI and Google embed at half price through their batch tiers, in exchange for a completion window
measured in hours. `EmbeddingBatchManager`, on `nexus-ai-pro/embeddings/batch`, puts both behind one
durable handle: it submits, polls with backoff, collects, and prices at the batch rate.

```ts
import { EmbeddingBatchManager } from 'nexus-ai-pro/embeddings/batch';
import { OpenAIEmbeddingBatchProvider } from 'nexus-ai-pro/embeddings/batch/openai';

const batches = new EmbeddingBatchManager(
  { providers: { openai: new OpenAIEmbeddingBatchProvider({ apiKey: process.env.OPENAI_API_KEY! }) } },
  { operations: { store: operationStore } },
);
const handle = await batches.submit({
  model: 'text-embedding-3-small',
  items: chunks.map((chunk) => ({ customId: chunk.id, input: chunk.content })),
  idempotencyKey: 'nightly-reindex',
});
const result = await handle.result(); // hours later, or in another process
```

An `EmbeddingBatchSubmitRequest` holds `EmbeddingBatchItem` values: a `customId` each, which must be
unique, and an input, which is a text or `EmbeddingParts`. It also names the concrete `model`, and can
set the input type, `dimensions`, `normalize`, a completion window, an idempotency key, and labels.

A submission is checked before anything is sent: ids, the adapter's item limit, and whether the model
takes the inputs' media. It is then a durable operation that records its batch the moment it exists.
A worker that dies while it waits is replaced by one that collects that batch, never a second. The
same holds for completion batches on `nexus-ai-pro/batch`.

| Method | Does |
| --- | --- |
| `submit()` | Submits, and returns a durable handle that settles with an `EmbeddingBatchResult`. |
| `start()` | Submits, and returns the batch's ref at once, for a caller that keeps it. |
| `resume()` | Waits for a batch by its ref, submitted here or elsewhere, and collects it. |
| `status()`, `cancel()` | Reads or cancels a batch by its ref. |
| `registerEmbeddingBatchProvider()`, `hasEmbeddingBatchProvider()`, `listEmbeddingBatchProviders()` | Manage adapters. |

`EmbeddingBatchConfig` registers adapters and sets the poll interval, its maximum, the timeout
(26 hours), and the embedding `models` used for checks and prices. `EmbeddingBatchManagerRuntime`
gives it an operation store, and a client's `lifecycle` to authorize and budget each submission.

An `EmbeddingBatchResult` has every input's `EmbeddingBatchOutputItem`, matched by `customId`: a
vector, or an error. It also has counts, usage, and the cost with the provider's discount. Tokens are
reported where the provider reports them, and estimated where it does not, never priced at zero.

`batchEmbedder()` turns a manager into the `BatchEmbedder` an ingestion pipeline takes as
`batchEmbed`; the [loaders guide](./loaders.md#through-a-providers-batch-tier) shows it.
`BatchEmbedderOptions` names the model and sets the window `size` (10,000 texts), the input type
(`document`), `dimensions`, and normalization.

### Batch adapters

| Adapter | Entry point | Notes |
| --- | --- | --- |
| `OpenAIEmbeddingBatchProvider` | `nexus-ai-pro/embeddings/batch/openai` | `/v1/embeddings` lines, 50,000 a batch; failed lines are read from the error file. `OpenAIEmbeddingBatchProviderOptions`: the key, base URL, organization, headers, and `fetch`. |
| `GoogleEmbeddingBatchProvider` | `nexus-ai-pro/embeddings/batch/google` | `asyncBatchEmbedContent` with inline requests under 20 MB; takes media on a model that does. `GoogleEmbeddingBatchProviderOptions`: the key, base URL, headers, and `fetch`. Experimental until a live run is recorded. |
| `MockEmbeddingBatchProvider` | `nexus-ai-pro/embeddings/batch/mock` | In memory, for tests: scripted statuses and failures, and the vectors `MockEmbeddingProvider` gives. `MockEmbeddingBatchProviderOptions` sets them. |

An adapter of your own implements `EmbeddingBatchProvider`: `submit`, `poll`, `results`, and an optional
`cancel`. Its `EmbeddingBatchProviderInfo` declares its `EmbeddingBatchProviderCapabilities`: the
batch limits, discount, and `inputModalities`. `submit` receives an `EmbeddingBatchProviderRequest`,
whose `EmbeddingBatchProviderItem` values hold each input's text and, for media, its parts.

## Requests and responses

`EmbeddingRequest` needs only the `input`: an `EmbeddingInput`, which is one text or a list, where
media is `EmbeddingParts`. The rest is optional.

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
input types, encodings, truncation, whether vectors come back normalized, and the `inputModalities` it
takes. A field you leave out means unknown, not unsupported, except `inputModalities`: an adapter that
does not declare media is sent text only.

`embed()` is called once per batch:

| Type | Contents |
| --- | --- |
| `EmbeddingProviderRequest` | One batch, already split to fit and resolved to a concrete model. Its `contents` holds each input's parts when any holds media. |
| `EmbeddingProviderPart` | A part as an adapter receives it: an `EmbeddingProviderTextPart`, or an `EmbeddingProviderMediaPart` with its MIME type and base64 `data` or `url`. |
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
usage. It can also fail on a chosen call, for retry and failover tests, and add latency. It takes
every modality, and `describeMedia` turns a media part into the text its vector is hashed from, so a
test can put an image and its caption in one space.

A vector store that needs no routing or retries can use a bare function instead:
`createOpenAIEmbeddingProvider()`, `createGeminiEmbeddingProvider()`, or
`createCohereEmbeddingProvider()`. They take `OpenAIEmbeddingOptions`, `GeminiEmbeddingOptions`, and
`CohereEmbeddingOptions`.

## The embedding registry

`KNOWN_EMBEDDING_MODELS` maps each model to its `EmbeddingModelCapabilities`: provider and family,
native dimensions and the sizes it can shorten to, input and batch limits, the price per 1,000 input
tokens and per image, whether it normalizes, the input types and `inputModalities` it takes, and its
status. Each entry also
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
- Two processes that miss the same text at once both embed it; the shared cache keeps one vector.
- The Google batch adapter reads inline results, and refuses a batch over 20 MB; split a larger
  job into several.
- Video is not an embedding input yet, since a video part names a file; and audio and video are not
  priced, since their price depends on a duration this runtime does not measure.

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
| `EmbeddingCacheConfig` | interface | How embeddings are cached: the options every cache takes, and a shared store. |
| `EmbeddingCapabilityError` | class | A requested option the target model or adapter cannot honor. |
| `EmbeddingConfig` | interface | Configuration for `ai.embed()`. |
| `EmbeddingCostBudgetConfig` | interface | Refuses or flags an embedding request whose estimated cost exceeds a limit. |
| `EmbeddingEncodingFormat` | type | Wire encoding requested from the provider. |
| `EmbeddingError` | class | Base class for embeddings errors, each with a stable `code`. |
| `EmbeddingInput` | type | One input or many. |
| `EmbeddingInputType` | type | What the vector will be used for. |
| `EmbeddingManager` | class | Provider-neutral embeddings with routing, caching, batching, budget, retry, audit, and metrics. |
| `EmbeddingMeta` | interface | How an embedding request ran. |
| `EmbeddingModality` | type | What an embedding input can hold besides text. |
| `EmbeddingModelCapabilities` | interface | What the registry knows about an embedding model. |
| `EmbeddingModelNotFoundError` | class | Raised when a model is not in the embeddings registry and no provider was named. |
| `EmbeddingModelRegistryConfig` | interface | Embedding models and aliases that extend or replace the bundled registry. |
| `EmbeddingPart` | type | A part of an embedding input: the same text, image, audio, and document parts a message takes. |
| `EmbeddingParts` | interface | One input made of parts, such as an image with its caption, embedded as one vector in the same space as text. |
| `EmbeddingProviderCallContext` | interface | What an adapter receives with every batch besides the request: the context every family's provider receives, and where this batch sits in the request. |
| `EmbeddingProviderCapabilities` | interface | What an adapter can do. |
| `EmbeddingProviderError` | class | Raised when an embeddings provider fails. |
| `EmbeddingProviderInfo` | interface | Identifies an embeddings adapter and what it supports. |
| `EmbeddingProviderMediaPart` | interface | A media part, as an adapter receives it: its content as base64 data, or the URL that holds it. |
| `EmbeddingProviderNotFoundError` | class | Raised when no provider, or no provider by the requested name, is registered. |
| `EmbeddingProviderPart` | type | A part of an embedding input, as an adapter receives it. |
| `EmbeddingProviderRequest` | interface | Request handed to an adapter. |
| `EmbeddingProviderResponseError` | class | Raised when a provider's response does not have the shape the adapter expects, such as the wrong number of vectors. |
| `EmbeddingProviderResult` | interface | What an adapter returns for one batch. |
| `EmbeddingProviderTextPart` | interface | A text part, as an adapter receives it. |
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

### `nexus-ai-pro/embeddings/batch`

| Export | Kind | Summary |
| --- | --- | --- |
| `batchEmbedder` | function | An embedding batch tier as the ingestion pipeline's `batchEmbed`: each window of chunks becomes one provider batch at the batch price. |
| `BatchEmbedder` | interface | What `createIngestionPipeline()` takes as `batchEmbed`: submit texts as one batch, collect it later. |
| `BatchEmbedderOptions` | interface | What `batchEmbedder()` submits under. |
| `EmbeddingBatchConfig` | interface | Configuration for `EmbeddingBatchManager`. |
| `EmbeddingBatchItem` | interface | One input of an embedding batch, under the id its vector comes back by. |
| `EmbeddingBatchManager` | class | Embedding batch tiers behind one handle: submit, poll with backoff, collect, and price at the batch rate. |
| `EmbeddingBatchManagerRuntime` | interface | What the manager runs on. |
| `EmbeddingBatchOutputItem` | interface | One input's outcome: its vector, or why it failed. |
| `EmbeddingBatchProvider` | interface | A provider's batch tier for embeddings. |
| `EmbeddingBatchProviderCapabilities` | interface | What an embedding batch tier supports: a batch tier's limits, and the media it takes. |
| `EmbeddingBatchProviderInfo` | interface | Identifies an embedding batch adapter and what it supports. |
| `EmbeddingBatchProviderItem` | interface | One input as an adapter receives it: its text, and its parts when the batch holds media. |
| `EmbeddingBatchProviderRequest` | interface | A batch as an adapter receives it: inputs checked and resolved. |
| `EmbeddingBatchResult` | interface | A finished embedding batch: every input's outcome, its usage, and its cost at the batch price. |
| `EmbeddingBatchSubmitRequest` | interface | A batch of inputs to embed through a provider's batch tier. |

### `nexus-ai-pro/embeddings/batch/google`

| Export | Kind | Summary |
| --- | --- | --- |
| `GoogleEmbeddingBatchProvider` | class | Gemini's Batch API for embeddings (`asyncBatchEmbedContent`): half price, inline requests under 20 MB, and results inline, in the order submitted. |
| `GoogleEmbeddingBatchProviderOptions` | interface | Options for Gemini's embedding batch tier. |

### `nexus-ai-pro/embeddings/batch/mock`

| Export | Kind | Summary |
| --- | --- | --- |
| `MockEmbeddingBatchProvider` | class | A deterministic embedding batch tier, in memory. |
| `MockEmbeddingBatchProviderOptions` | interface | Options for the mock embedding batch tier. |

### `nexus-ai-pro/embeddings/batch/openai`

| Export | Kind | Summary |
| --- | --- | --- |
| `OpenAIEmbeddingBatchProvider` | class | OpenAI's Batch API for `/v1/embeddings`: half price, a 24-hour window, and at most 50,000 inputs a batch. |
| `OpenAIEmbeddingBatchProviderOptions` | type | Options for OpenAI's embedding batch tier: the key, and optionally the base URL, organization, and `fetch`. |

### `nexus-ai-pro/embeddings/cache`

| Export | Kind | Summary |
| --- | --- | --- |
| `EmbeddingCacheContext` | interface | What a cached vector depends on besides its input: the same text under another model is another vector. |
| `EmbeddingCacheEntry` | interface | A vector to cache, under its key. |
| `embeddingCacheKey` | function | The cache key for an input embedded under a context: a SHA-256 in hex, so the text itself never becomes a key in a shared store. |
| `EmbeddingCacheStore` | interface | Where embedding vectors are cached, shared by every process that uses the same store. |
| `MemoryEmbeddingCache` | class | Vectors in process memory, packed as float32, the least recently used evicted first. |
| `MemoryEmbeddingCacheOptions` | interface | Limits for the in-process embedding cache. |
| `packVector` | function | A vector as packed little-endian float32: four bytes a dimension, against about twenty as JSON. |
| `RedisEmbeddingCache` | class | Vectors in Redis, shared by every process that reaches it. |
| `RedisEmbeddingCacheClient` | type | A Redis client that sends raw commands: ioredis, with `call()`, or node-redis, with `sendCommand()`. |
| `RedisEmbeddingCacheOptions` | interface | Options for the Redis embedding cache. |
| `tieredEmbeddingCache` | function | Two caches as one: the near one, usually `MemoryEmbeddingCache`, answers first, and the far one, usually shared, answers the rest in one call. |
| `unpackVector` | function | A vector from the bytes `packVector()` wrote. |

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
