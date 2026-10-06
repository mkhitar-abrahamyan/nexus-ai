# Retrieval

<!-- covers: ./rag/retrievers ./rag/rerankers ./rag/elasticsearch ./rag/redis ./rag/pinecone ./rag/weaviate ./rag/chroma -->

Retrieval quality and where the vectors live. Composable retrievers — hybrid search, reranking,
diversity, parent documents, and several phrasings of a query — work over any store, and five more
stores implement the `VectorStore` contract beside the memory, pgvector, Qdrant, and SQLite ones.
The contract itself, ingestion, and answering from retrieved context are in the
[grounding guide](./grounding.md).

```ts
import { loadIntoStore } from 'nexus-ai-pro/loaders';
import { hybridRetriever, KeywordIndex, modelReranker, rerankRetriever, vectorRetriever } from 'nexus-ai-pro/rag/retrievers';

const keywords = new KeywordIndex();
await loadIntoStore([store, keywords], loaders);

const retriever = rerankRetriever(
  hybridRetriever([vectorRetriever(store), keywords]),
  modelReranker(ai, { model: 'gpt-5.4-mini' }),
);
const chunks = await retriever.retrieve('what does error E4012 mean', { filter: { tenant: 'acme' } });
```

## Retrievers

A `Retriever` answers a query with ranked chunks through `retrieve()`. `RetrieveOptions` asks for a
`topK`, a metadata `filter` passed to every store searched, and a `signal`.

Every retriever here takes other retrievers and returns one, so they stack in any order:

| Retriever | Use it when |
| --- | --- |
| `vectorRetriever()` | You want a store's search as a retriever, with defaults for every call. |
| `KeywordIndex` | Queries contain exact terms — codes, error numbers, names — that vectors miss. |
| `hybridRetriever()` | You want both, fused. The usual production setup. |
| `rerankRetriever()` | The right answer is in the top 20 but not the top 5. |
| `mmrRetriever()` | Results are near-duplicates of each other. |
| `parentDocumentRetriever()` | Small chunks match well but are too short to answer from. |
| `multiQueryRetriever()` | Users phrase questions differently from your documents. |

### Keyword and hybrid search

`KeywordIndex` ranks chunks in memory by BM25. `KeywordIndexOptions` tunes the BM25 constants `k1` and
`b`, and can replace the tokenizer. The default, `tokenize()`, splits text into lower-cased runs of
letters and digits in any script. Adding a chunk whose id is already held replaces it, as in a store.

```ts
const keywords = new KeywordIndex();
await loadIntoStore([store, keywords], loaders); // fill both in one pass

const hybrid = hybridRetriever([vectorRetriever(store), keywords], { topK: 5 });
const results = await hybrid.retrieve('error E4012');
```

`hybridRetriever()` runs its retrievers in parallel and fuses their rankings.
`reciprocalRankFusion()` is the fusion on its own: each chunk scores the sum of `weight / (k + rank)`
over the rankings it appears in. It uses ranks, not scores, so BM25 and cosine combine without
normalizing.

| Option | Type | Default |
| --- | --- | --- |
| `k` | `FusionOptions` | 60 |
| `weights` | `FusionOptions` | 1 for each ranking |
| `topK` | `FusionOptions` | every chunk, for the function; 5, for the retriever |
| `candidates` | `FusedRetrieverOptions` | four times `topK`, asked of each retriever |

### Keyword search at scale

`KeywordIndex` is one `SparseRetriever`. That is the contract for keyword search that holds its own
chunks: it is a `Retriever`, so it fuses with vector search, and it takes `add()` and `delete()`, so
ingestion keeps it in step with a vector store. Two more ship, each checked by the same contract
test:

- `PostgresKeywordIndex`, on `nexus-ai-pro/postgres/fulltext`, uses Postgres full-text search. The
  [Postgres guide](./postgres.md#keyword-search) covers it.
- `ElasticsearchKeywordIndex`, on `nexus-ai-pro/rag/elasticsearch`, searches Elasticsearch or
  OpenSearch through the REST API, with no client library, as the vector stores do.
  `ElasticsearchKeywordIndexOptions` sets the cluster, the index, an API key or a user and password,
  the analyzer, and when writes become searchable (`refresh`, `wait_for` by default).
  - `migrate()` creates the index: `content` as analyzed text, and every metadata string as a keyword,
    so a filter matches it exactly.
  - Writes go in one NDJSON bulk request.
  - Scores are the engine's own BM25.
  - A failure raises an `ElasticsearchError` with the status and the body.

```ts
import { ElasticsearchKeywordIndex } from 'nexus-ai-pro/rag/elasticsearch';

const keywords = new ElasticsearchKeywordIndex({ url: 'https://search.internal:9200', index: 'kb', apiKey });
await keywords.migrate();
const hybrid = hybridRetriever([vectorRetriever(store), keywords]);
```

### Reranking

`rerankRetriever()` asks its base for more candidates than it returns, scores them all, and keeps the
best. The scorer is a `Reranker`: any function that scores chunks against a query, such as a
cross-encoder or a hosted rerank API. `RerankRetrieverOptions` sets `topK` (5), `candidates` (20), and
a `minScore`.

`modelReranker()` is a reranker over a chat model. One call scores every candidate from 0 to 10; a
reply it cannot read scores them all 0 instead of failing the search. `ModelRerankerOptions` names the
`model` and limits the characters shown per chunk. The client is a `RetrievalModelClient`: a
`NexusAI` instance, or anything with the same `complete()`.

```ts
const reranked = rerankRetriever(hybrid, modelReranker(ai, { model: 'gpt-5.4-mini' }), { topK: 5 });
```

`nexus-ai-pro/rag/rerankers` has rerankers that are faster and cheaper than a chat model. None
needs an SDK.

Hosted rerank APIs, each taking `HostedRerankerOptions` (the API key, the model, and an optional
endpoint):
- `cohereReranker()`;
- `voyageReranker()`;
- `jinaReranker()`.

Self-hosted and in-process:
- `teiReranker()` calls a cross-encoder that Hugging Face's text-embeddings-inference serves on your
  own machine or cluster (`TeiRerankerOptions`).
- `httpReranker()` covers any other rerank API. `HttpRerankerOptions` describes its request `body`
  and how to read its `scores`.
- `crossEncoderReranker()` runs a `CrossEncoder` in process. That is anything that scores
  (query, passage) pairs, so an ONNX or transformers model fits in a few lines, the passages never
  leave the machine, and there is no per-query price. `CrossEncoderRerankerOptions` sets the batch
  size, the characters scored per chunk, and a sigmoid for a model that returns logits.

Every HTTP reranker takes `RerankerHttpOptions`: `fetch`, headers, a timeout, and the characters sent
per chunk. They all do the same three things:
- put the scores back in the order of the chunks;
- give 0 to a passage the API left out;
- raise a `RerankerError` with the status when the API refuses.

```ts
import { cohereReranker, crossEncoderReranker } from 'nexus-ai-pro/rag/rerankers';

const hosted = rerankRetriever(hybrid, cohereReranker({ apiKey, model: 'rerank-v3.5' }), { candidates: 20 });
const local = rerankRetriever(hybrid, crossEncoderReranker({ score: (pairs) => model.score(pairs) }));
```

In the test suite, an experiment on the stored support dataset runs on real Postgres with
full-text search and pgvector. Its findings:
- Hybrid retrieval beats vector-only: recall@5 0.71 → 0.97, and mean reciprocal rank 0.51 → 0.71,
  both with a 95% interval above zero.
- A hosted reranker and a local cross-encoder, compared in the same experiment, each lift mean
  reciprocal rank to 0.97.

### Diversity

`mmrRetriever()` reorders its base's results by maximal marginal relevance, so near-duplicates stop
crowding out other evidence. `MmrRetrieverOptions` takes the `embed` function and the number of
`candidates`. `MmrOptions` sets `lambda`: 1 is pure relevance, 0 pure diversity, and the default is
0.5. `maximalMarginalRelevance()` is the selection on its own, over vectors you already have.

```ts
const diverse = mmrRetriever(vectorRetriever(store), { embed, lambda: 0.5, topK: 5 });
```

### Parent documents

Small chunks match a query precisely, but are often too short to answer from.
`parentDocumentRetriever()` searches small chunks and returns the larger parents they came from. Each
parent comes back once, in the order of its best child.

`splitParentChild()` produces both sides from your documents, with `ParentChildOptions` for each
split. Parents are found through a `ParentLookup`: a map, or a function that fetches them by id.
`ParentDocumentRetrieverOptions` names the child's `parentKey`, which defaults to the `documentId`
that ingestion sets.

```ts
const { parents, children } = splitParentChild(documents);
await store.add(children);
const retriever = parentDocumentRetriever(vectorRetriever(store), {
  parents: new Map(parents.map((parent) => [parent.id, parent])),
});
```

### Several phrasings

`multiQueryRetriever()` searches several rewrites of a query in parallel and fuses the results. A
`QueryVariants` function produces the rewrites. `modelQueryVariants()` asks a chat model for them;
`ModelQueryVariantsOptions` names the `model` and the `count`. `MultiQueryRetrieverOptions` can leave
the original query out.

```ts
const retriever = multiQueryRetriever(hybrid, modelQueryVariants(ai, { model: 'gpt-5.4-mini', count: 3 }));
```

### Measuring a retriever

Run a retriever over a dataset with `recallAtK()` and `reciprocalRank()` from the
[evaluation guide](./evaluation.md), then compare two retrievers with `compareExperiments()`. That is
how you know a change helped rather than guessing.

## More vector stores

Each store implements `VectorStore`, takes any embedding function, and passes the same contract test:
ranking, typed metadata filters, replacement by id, and deletes. None adds a dependency. The REST
stores speak HTTP through `fetch`, and the Redis store sends commands through the client you pass.
Call `migrate()` once where a store has one; it never runs on its own.

| Store | Entry point | Where the vectors live |
| --- | --- | --- |
| `RedisVectorStore` | `nexus-ai-pro/rag/redis` | Redis with RediSearch: Redis Stack, Redis 8, or Redis Cloud. |
| `PineconeVectorStore` | `nexus-ai-pro/rag/pinecone` | A Pinecone index, through its data-plane API. |
| `WeaviateVectorStore` | `nexus-ai-pro/rag/weaviate` | A Weaviate collection, through REST and GraphQL. |
| `ChromaVectorStore` | `nexus-ai-pro/rag/chroma` | A Chroma collection, through its v2 API. |
| `SqliteVectorStore` | `nexus-ai-pro/sqlite/vectors` | A SQLite file, optionally ranked by sqlite-vec. See the [SQLite guide](./sqlite.md). |

```ts
import Redis from 'ioredis';
import { RedisVectorStore } from 'nexus-ai-pro/rag/redis';

const store = new RedisVectorStore(new Redis(process.env.REDIS_URL!), {
  dimensions: 1536,
  embed,
  filterFields: ['tenant'],
});
await store.migrate();
```

### Redis

`RedisVectorStore` keeps each chunk as a hash and searches a RediSearch vector index. The client is a
`RedisVectorLikeClient`: ioredis, with `call()`, or node-redis, with `sendCommand()`.

`RedisVectorStoreOptions` sets the `dimensions`, the `index` and key `prefix`, the `algorithm` (`HNSW`,
or exact `FLAT`), and the `filterFields`. RediSearch can only filter on fields declared in the index.
So declared fields are indexed as tags with their type, and a filter on any other field is refused
instead of being silently ignored.

### Pinecone

`PineconeVectorStore` upserts, queries, and deletes in batches. Create the index yourself, with the
cosine metric and the store's width. `PineconeVectorStoreOptions` takes the index `host`, the `apiKey`,
a `namespace`, the `apiVersion` header, and the upsert `batchSize` (100). A failed request raises a
`PineconeError` with the status and body.

### Weaviate

`WeaviateVectorStore` brings its own vectors to a collection with no vectorizer and cosine distance.
`migrate()` creates the collection and adds a property for each field you filter on. Each field's type
is a `WeaviateFieldType`: `text`, `number`, or `boolean`.

`WeaviateVectorStoreOptions` takes the `url`, the `collection` (`NexusChunk`), an `apiKey` sent as a
bearer token, and the usual `fetch`, `headers`, and `timeoutMs`. Errors raise a `WeaviateError`,
including errors Weaviate reports inside a successful batch.

### Chroma

`ChromaVectorStore` uses a collection with cosine distance, which `migrate()` creates.
`ChromaVectorStoreOptions` takes the `url`, the `collection`, the `tenant` and `database`, and an
`apiKey` sent as `x-chroma-token`. A failed request raises a `ChromaError`.

### How the REST stores keep metadata

In the REST stores, each chunk's top-level string, number, and boolean metadata fields are copied under
`meta_` names; that is what filters match on. The whole metadata also travels as JSON, so nested values
still come back. Scores are cosine similarity in every store, so a `minScore` means the same wherever
the vectors live.

## Limitations

- `KeywordIndex` holds its chunks in memory. For a corpus that does not fit, use
  `PostgresKeywordIndex` or `ElasticsearchKeywordIndex`, or another engine behind a `SparseRetriever`
  of your own.
- `modelReranker()` and `modelQueryVariants()` cost a model call per retrieval; a cross-encoder or a
  hosted rerank API is faster and cheaper where you have one.
- The Pinecone store does not create the index, which is a control-plane operation; create it in the
  console or with Pinecone's client.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/rag/chroma`

| Export | Kind | Summary |
| --- | --- | --- |
| `ChromaError` | class | Raised when Chroma answers with an error. |
| `ChromaVectorStore` | class | Retrieval chunks in a Chroma collection, through its v2 REST API. |
| `ChromaVectorStoreOptions` | interface | Options for the Chroma store. |

### `nexus-ai-pro/rag/elasticsearch`

| Export | Kind | Summary |
| --- | --- | --- |
| `ElasticsearchError` | class | Raised when the cluster answers with an error. |
| `ElasticsearchKeywordIndex` | class | Keyword search in Elasticsearch or OpenSearch, through their REST API. |
| `ElasticsearchKeywordIndexOptions` | interface | Options for the Elasticsearch keyword index. |

### `nexus-ai-pro/rag/pinecone`

| Export | Kind | Summary |
| --- | --- | --- |
| `PineconeError` | class | Raised when Pinecone answers with an error. |
| `PineconeVectorStore` | class | Retrieval chunks in a Pinecone index, through its data-plane REST API. |
| `PineconeVectorStoreOptions` | interface | Options for the Pinecone store. |

### `nexus-ai-pro/rag/redis`

| Export | Kind | Summary |
| --- | --- | --- |
| `RedisVectorLikeClient` | type | A Redis client that sends raw commands — what RediSearch's `FT.*` commands need. |
| `RedisVectorStore` | class | Retrieval chunks in Redis, searched by RediSearch's vector index (Redis Stack, Redis 8, or Redis Cloud). |
| `RedisVectorStoreOptions` | interface | Options for the Redis store. |

### `nexus-ai-pro/rag/rerankers`

| Export | Kind | Summary |
| --- | --- | --- |
| `cohereReranker` | function | Cohere's rerank API (`/v2/rerank`), such as `rerank-v3.5`. |
| `CrossEncoder` | interface | A cross-encoder run in process: one score per (query, passage) pair, higher meaning more relevant. |
| `crossEncoderReranker` | function | A reranker over a cross-encoder you run in process: no network call, no per-query price, and the passages never leave the machine. |
| `CrossEncoderRerankerOptions` | interface | Options for `crossEncoderReranker()`. |
| `HostedRerankerOptions` | interface | Options for a hosted rerank API. |
| `httpReranker` | function | A reranker over any HTTP rerank API: you describe the request body and how to read the scores, and it handles the rest — truncation, the timeout, cancellation, errors, and scores put back in the order of the chunks. |
| `HttpRerankerOptions` | interface | Options for `httpReranker()`: any rerank API, described by its request and its response. |
| `jinaReranker` | function | Jina AI's rerank API (`/v1/rerank`), such as `jina-reranker-v2-base-multilingual`. |
| `RerankerError` | class | Raised when a rerank API answers with an error. |
| `RerankerHttpOptions` | interface | What every HTTP reranker takes. |
| `teiReranker` | function | A cross-encoder served by Hugging Face's text-embeddings-inference, on your own machine or cluster: `docker run ... |
| `TeiRerankerOptions` | interface | Options for `teiReranker()`. |
| `voyageReranker` | function | Voyage AI's rerank API (`/v1/rerank`), such as `rerank-2`. |

### `nexus-ai-pro/rag/retrievers`

| Export | Kind | Summary |
| --- | --- | --- |
| `FusedRetrieverOptions` | interface | Options for `hybridRetriever()` and `multiQueryRetriever()`. |
| `FusionOptions` | interface | Options for `reciprocalRankFusion()`. |
| `hybridRetriever` | function | Several retrievers at once — typically a vector store and a `KeywordIndex` over the same chunks — fused by reciprocal rank. |
| `KeywordIndex` | class | Keyword search with BM25 over chunks held in memory. |
| `KeywordIndexOptions` | interface | Options for a `KeywordIndex`. |
| `maximalMarginalRelevance` | function | Picks candidates by maximal marginal relevance: each pick maximizes its similarity to the query minus its similarity to what was already picked, so near-duplicates stop crowding out other evidence. |
| `MmrOptions` | interface | Options for `maximalMarginalRelevance()`. |
| `mmrRetriever` | function | A retriever that diversifies its base's results by maximal marginal relevance. |
| `MmrRetrieverOptions` | interface | Options for `mmrRetriever()`. |
| `modelQueryVariants` | function | Query variants from a chat model, in one call. |
| `ModelQueryVariantsOptions` | interface | Options for `modelQueryVariants()`. |
| `modelReranker` | function | A reranker that asks a chat model to score each chunk from 0 to 10 for how well it answers the query, in one call. |
| `ModelRerankerOptions` | interface | Options for `modelReranker()`. |
| `multiQueryRetriever` | function | Searches several phrasings of a query and fuses the results by reciprocal rank, so a question worded differently from the documents still finds them. |
| `MultiQueryRetrieverOptions` | interface | Options for `multiQueryRetriever()`. |
| `ParentChildOptions` | interface | Options for `splitParentChild()`. |
| `parentDocumentRetriever` | function | Searches small chunks, which match a query precisely, and returns the larger parents they came from, which give the model enough context to answer. |
| `ParentDocumentRetrieverOptions` | interface | Options for `parentDocumentRetriever()`. |
| `ParentLookup` | type | Finds parent chunks by id: a map, or a function that fetches them, such as from your database. |
| `QueryVariants` | type | Rewrites a query into alternative phrasings, such as `modelQueryVariants()` over a chat model. |
| `reciprocalRankFusion` | function | Fuses rankings by reciprocal rank: each chunk scores the sum, over the rankings it appears in, of `weight / (k + rank)`. |
| `Reranker` | type | Scores each chunk's relevance to a query, higher meaning more relevant, one number per chunk in order. |
| `rerankRetriever` | function | A retriever whose results are rescored by a reranker: it asks the base for more candidates than it returns, scores them all against the query, and keeps the best. |
| `RerankRetrieverOptions` | interface | Options for `rerankRetriever()`. |
| `RetrievalModelClient` | interface | A client that runs one completion — a `NexusAI` instance, or anything with the same `complete()`. |
| `RetrieveOptions` | interface | What one retrieval asks for. |
| `Retriever` | interface | Anything that answers a query with ranked chunks. |
| `SparseRetriever` | interface | Keyword search that holds its own chunks: an in-memory BM25 `KeywordIndex`, Postgres full-text search, a search engine. |
| `splitParentChild` | function | Splits documents twice: into parents, kept for `parentDocumentRetriever()` to return, and each parent into small children, added to the store it searches. |
| `tokenize` | function | Lower-cased runs of letters and digits, in any script. |
| `vectorRetriever` | function | A vector store as a retriever, with defaults for every search. |

### `nexus-ai-pro/rag/weaviate`

| Export | Kind | Summary |
| --- | --- | --- |
| `WeaviateError` | class | Raised when Weaviate answers with an error, or reports one for an object in a batch. |
| `WeaviateFieldType` | type | The type of a metadata field a Weaviate collection filters on. |
| `WeaviateVectorStore` | class | Retrieval chunks in a Weaviate collection, through its REST and GraphQL APIs. |
| `WeaviateVectorStoreOptions` | interface | Options for the Weaviate store. |
<!-- reference:end -->
