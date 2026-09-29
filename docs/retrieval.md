# Retrieval

<!-- covers: ./rag/retrievers ./rag/redis ./rag/pinecone ./rag/weaviate ./rag/chroma -->

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

A `Retriever` answers a query with ranked chunks through `retrieve()`, and `RetrieveOptions` asks
for a `topK`, a metadata `filter` passed down to every store searched, and a `signal`. Each
retriever here takes others and returns one, so they compose in any order.

- **Vector search.** `vectorRetriever()` makes a store a retriever, with defaults for every search.
- **Keyword search.** `KeywordIndex` ranks chunks in memory by BM25, which finds the exact terms —
  product codes, error numbers, names — that vector search misses. `KeywordIndexOptions` tunes `k1`
  and `b` and replaces the tokenizer; `tokenize()`, the default, splits into lower-cased runs of
  letters and digits in any script. Adding a chunk whose id is held replaces it, as in a store.
- **Hybrid search.** `hybridRetriever()` runs several retrievers in parallel — typically a store and a
  keyword index over the same chunks — and fuses their rankings. `reciprocalRankFusion()` is the
  fusion on its own: each chunk scores the sum of `weight / (k + rank)` over the rankings it appears
  in, which combines scores on different scales without normalizing them. `FusionOptions` sets `k`
  (60), a weight per ranking, and a `topK`; `FusedRetrieverOptions` adds the `candidates` asked of
  each retriever (four times `topK`).
- **Reranking.** `rerankRetriever()` asks its base for more candidates than it returns, scores them
  all with a `Reranker` — a cross-encoder, a hosted rerank API, or any function that scores chunks
  against a query — and keeps the best. `RerankRetrieverOptions` sets the `topK`, the `candidates`
  (20), and a `minScore`. `modelReranker()` is a reranker over a chat model: one call scores every
  candidate from 0 to 10, and a reply it cannot read scores them all 0 rather than failing the
  retrieval. `ModelRerankerOptions` names the `model` and limits the characters shown per chunk. The
  client is a `RetrievalModelClient` — a `NexusAI` instance, or anything with the same `complete()`.
- **Diversity.** `mmrRetriever()` reorders its base's results by maximal marginal relevance, so
  near-duplicates stop crowding out other evidence; `MmrRetrieverOptions` takes the `embed` function
  and the `candidates`, and `MmrOptions` the `lambda` between relevance (1) and diversity (0).
  `maximalMarginalRelevance()` is the selection on its own, over vectors you already have.
- **Parent documents.** `parentDocumentRetriever()` searches small chunks, which match precisely, and
  returns the larger parents they came from, which give the model enough context. Parents come back
  in the order of their best child, each once. A `ParentLookup` finds them — a map, or a function that
  fetches them by id — and `ParentDocumentRetrieverOptions` names the child's `parentKey`, which
  defaults to the `documentId` ingestion sets. `splitParentChild()` produces both sides from your
  documents, with `ParentChildOptions` for each split.
- **Several phrasings.** `multiQueryRetriever()` searches a query's rewrites in parallel and fuses the
  results, so a question worded differently from the documents still finds them. `QueryVariants`
  produces the rewrites; `modelQueryVariants()` asks a chat model for them, with
  `ModelQueryVariantsOptions` naming the `model` and the `count`. `MultiQueryRetrieverOptions` can
  leave the original query out.

To measure a retriever, run it over a dataset with `recallAtK()` and `reciprocalRank()` from the
[evaluation guide](./evaluation.md), and compare two retrievers with `compareExperiments()`.

## More vector stores

Each implements `VectorStore`, takes any embedding function, and passes the same contract test as
the other stores — ranking, typed metadata filters, replacement by id, and deletes. None adds a
dependency: the REST stores speak HTTP through `fetch`, and the Redis store sends commands through
the client you pass. Each has a `migrate()` that never runs implicitly, where the database needs one.

| Store | Entry point | Where the vectors live |
| --- | --- | --- |
| `RedisVectorStore` | `nexus-ai-pro/rag/redis` | Redis with RediSearch: Redis Stack, Redis 8, or Redis Cloud. |
| `PineconeVectorStore` | `nexus-ai-pro/rag/pinecone` | A Pinecone index, through its data-plane API. |
| `WeaviateVectorStore` | `nexus-ai-pro/rag/weaviate` | A Weaviate collection, through REST and GraphQL. |
| `ChromaVectorStore` | `nexus-ai-pro/rag/chroma` | A Chroma collection, through its v2 API. |
| `SqliteVectorStore` | `nexus-ai-pro/sqlite/vectors` | A SQLite file, optionally ranked by sqlite-vec. See the [SQLite guide](./sqlite.md). |

**Redis.** `RedisVectorStore` keeps each chunk as a hash and searches a RediSearch vector index. A
`RedisVectorLikeClient` is ioredis, with `call()`, or node-redis, with `sendCommand()`.
`RedisVectorStoreOptions` sets the `dimensions`, the `index` and key `prefix`, the `algorithm` —
`HNSW` or exact `FLAT` — and the `filterFields`: RediSearch filters only on fields declared in the
index, so those are indexed as tags, stored with their type, and a filter on any other field is
refused rather than silently ignored.

**Pinecone.** `PineconeVectorStore` upserts, queries, and deletes in batches. Create the index with
the cosine metric and the store's width; `PineconeVectorStoreOptions` takes the index `host`, the
`apiKey`, a `namespace`, the `apiVersion` header, and the upsert `batchSize` (100). A failed request
raises a `PineconeError` with the status and body.

**Weaviate.** `WeaviateVectorStore` brings its own vectors to a collection with no vectorizer and
cosine distance. `migrate()` creates the collection and adds a property for each field you filter on,
typed by a `WeaviateFieldType` — `text`, `number`, or `boolean`. `WeaviateVectorStoreOptions` takes
the `url`, the `collection` (`NexusChunk`), an `apiKey` sent as a bearer token, and the usual `fetch`,
`headers`, and `timeoutMs`. Errors — including ones Weaviate reports inside a successful batch —
raise a `WeaviateError`.

**Chroma.** `ChromaVectorStore` uses a collection with cosine distance, which `migrate()` creates.
`ChromaVectorStoreOptions` takes the `url`, the `collection`, the `tenant` and `database`, and an
`apiKey` sent as `x-chroma-token`. A failed request raises a `ChromaError`.

In the REST stores, a chunk's top-level string, number, and boolean metadata fields are copied under
`meta_` names, which is what filters match on, and its whole metadata travels as JSON, so nested
values still come back. Scores are cosine similarity in every store, so a `minScore` means the same
wherever the vectors live.

## Limitations

- `KeywordIndex` holds its chunks in memory. For a corpus that does not fit, use the database's own
  full-text search behind a `Retriever` of your own and fuse it the same way.
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
