# Grounding: retrieval, citations, and verification

<!-- covers: ./rag ./rag/qdrant -->
<!-- sources: src/hallucination src/rag -->

Grounding makes an answer follow from evidence, and catches it when it does not. Four steps:

1. **Ingest.** Split documents into chunks.
2. **Retrieve.** A vector store finds the chunks that match a question.
3. **Answer.** `withRagContext()` puts them in front of the model, with rules for citing them.
4. **Check.** The verification helpers test what came back.

Every export here comes from the root import, except ingestion, which is on `nexus-ai-pro/rag`.

```ts
import { MemoryVectorStore, withRagContext } from 'nexus-ai-pro';

const store = new MemoryVectorStore();
await store.add([{ id: 'doc-1', content: 'NexusAI supports RAG context with citations.', source: 'docs' }]);

const chunks = await store.search('How does NexusAI ground answers?', { topK: 3 });

const response = await ai.completeVerified(
  withRagContext(
    { model: 'auto', messages: [{ role: 'user', content: 'How does NexusAI ground answers?' }] },
    { chunks, requireCitations: true },
  ),
  { context: chunks.map((chunk) => chunk.content), minSupportRatio: 0.85 },
);
```

## Ingesting documents

`ingestDocuments()` and `ingestText()` split text into overlapping chunks. They return `RagChunk` values
ready for a vector store, and an `IngestionResult` that says how much was read.

Each `DocumentSource` is a text, with an optional id, source, and metadata. All of them are carried
onto its chunks. `IngestionOptions` sets the split:

| Option | Default | What it does |
| --- | --- | --- |
| `chunkSize` | 1,200 characters | How long a chunk may be. |
| `overlap` | 150 | How much consecutive chunks share. |
| `splitOnMarkdownHeadings` | off | Keeps every chunk inside one section. |

To read files, directories, web pages, sitemaps, CSV, JSON, PDF, and Git repositories, use the
[loaders](./loaders.md). `loadIntoStore()` streams what they read through this split into one or more
stores.

### Scanning uploads first

`ingestFilesAfterScan()` goes one step earlier, for files people upload:

1. It scans the files for unsafe content. Anything high or critical throws, before any file is read.
2. It extracts each file's text, and skips what it cannot read.
3. It chunks the text.

```ts
import { ingestFilesAfterScan, createPdfExtractor } from 'nexus-ai-pro';

const { chunks, skippedFiles } = await ingestFilesAfterScan(uploads, {
  extractors: [createPdfExtractor(myPdfToText)],
  chunkSize: 1200,
  splitOnMarkdownHeadings: true,
});
```

`FileIngestionOptions` adds the scan settings, and the extractors to try in order, to the split
options. Text files need no extractor. `FileIngestionResult` adds how many files were scanned and, for
each skipped file, its name and why.

`createPdfExtractor()` and `createOcrExtractor()` wrap your own PDF or OCR function as a
`FileTextExtractor`. So the library carries no parsing dependency of its own.

## Retrieval

Every retrieval store implements one contract, `VectorStore`:

| Method | What it does |
| --- | --- |
| `add()` | Stores chunks. A chunk whose id exists is replaced, so re-ingesting a document never duplicates it. |
| `search()` | Finds the chunks closest to a text. |
| `searchVector()` | Finds the chunks closest to a vector computed elsewhere. |
| `delete()` | Removes chunks by id. |

`VectorSearchOptions` sets `topK` (5 by default) and `minScore` (0). Its `filter` matches top-level
metadata fields exactly, such as `{ tenant: 'acme' }`; `matchesMetadata()` is that test on its own.

A `VectorDocument` is a chunk with an optional precomputed embedding. A `VectorSearchResult` is a chunk
with its cosine similarity.

These stores implement it, and pass the same contract tests:

| Store | Entry point | Where the vectors live |
| --- | --- | --- |
| `MemoryVectorStore` | `nexus-ai-pro/rag` | In process. For development, tests, and a few thousand chunks. |
| `PostgresVectorStore` | `nexus-ai-pro/postgres/vectors` | Postgres with pgvector, ranked in the database. See the [Postgres guide](./postgres.md). |
| `QdrantVectorStore` | `nexus-ai-pro/rag/qdrant` | A Qdrant collection, through its REST API. |
| `SqliteVectorStore` | `nexus-ai-pro/sqlite/vectors` | A SQLite file, optionally ranked by sqlite-vec. See the [SQLite guide](./sqlite.md). |

Redis, Pinecone, Weaviate, and Chroma are in the [retrieval guide](./retrieval.md), with hybrid search,
reranking, and the other retrievers.

### Embeddings

Each store takes any `EmbeddingProvider`:

- `toEmbeddingFunction()` adapts the embeddings family, so retrieval inherits its routing, batching,
  and caching.
- Without one, a store falls back to `createHashEmbeddings()`: hashed term vectors that are
  deterministic and need no provider. They suit tests, not production.

`cosineSimilarity()` and `normalizeVector()` are the arithmetic underneath.

### Qdrant

```ts
import { ingestDocuments } from 'nexus-ai-pro/rag';
import { QdrantVectorStore } from 'nexus-ai-pro/rag/qdrant';

const store = new QdrantVectorStore({
  url: process.env.QDRANT_URL!,
  apiKey: process.env.QDRANT_API_KEY,
  collection: 'support-docs',
  dimensions: 1536,
  embed: toEmbeddingFunction(ai, { model: 'text-embedding-3-small' }),
});
await store.migrate({ filterFields: ['tenant'] });

await store.add(ingestDocuments(docs).chunks);
const chunks = await store.search(question, { topK: 5, filter: { tenant: 'acme' } });
const answer = await ai.complete(withRagContext({ model: 'auto', messages: [{ role: 'user', content: question }] }, { chunks }));
```

`QdrantVectorStore` needs no Qdrant client. It speaks HTTP through `fetch` and hashes ids with Web
Crypto, so it runs on edge runtimes too. `QdrantVectorStoreOptions` takes the `url`, the `collection`,
the `dimensions`, an `apiKey`, the `embed` function, a `fetch`, extra `headers`, and a `timeoutMs`
(30 seconds).

`migrate()` creates the collection with cosine distance unless it exists. It also indexes the metadata
fields you filter on: a list as keywords, or a map naming each field's type.

Qdrant point ids must be UUIDs, so each chunk id maps to a stable UUID, and the original id travels in
the payload. A failed request raises `QdrantError`, with the status and Qdrant's response body.

## Answering from context

`withRagContext()` turns a request into a grounded one:

- the chunks become a system message;
- the model is told to answer only from them, and to cite them by id;
- sampling defaults low.

`RagOptions` sets the citation style, how many chunks are included, and what the model should say when
the context does not answer the question. `extractCitations()` reads the citations back out of an
answer. `validateCitations()` checks that each one names a chunk that was actually supplied.

### From a knowledge graph

`withKnowledgeGraphContext()` does the same for relationships instead of passages. It ranks a
`KnowledgeGraph` of `KnowledgeGraphNode` and `KnowledgeGraphEdge` values against the question, and
states the best ones as facts. It tells the model not to infer relationships the graph does not
contain. `selectGraphFacts()` is the ranking on its own, and `KnowledgeGraphOptions` configures it.

### With no retrieval

`withFactualDefaults()` is lighter, for when there is no retrieval at all. It asks for conservative
answers, sets an explicit "I do not know" fallback, and keeps sampling low. `FactualOptions` sets the
wording and worked examples. `asJsonOnly()` does the same for JSON-only output.

## Checking the answer

| Function | What it does |
| --- | --- |
| `verifyAgainstContext()` | Splits an answer into claims and checks each against the context. |
| `completeVerified()` | Completes, verifies, and asks once for a revision when claims are unsupported. |
| `completeWithSelfConsistency()` | Samples several answers and returns the one the others agree with most. |

`verifyAgainstContext()` splits the answer with `extractFacts()`. It returns a `VerificationReport` of
`VerificationFact` values, and the share that is supported. The default check is
`lexicalEntailment()`: term overlap, with no model. For a real entailment model, supply an
`NliVerifier`.

`completeVerified()` runs that whole loop, and attaches the report to the response's
`meta.verification`. `VerificationOptions` sets the minimum share supported and the fallback answer.
`VerificationClient` is the small client contract it needs.

`completeWithSelfConsistency()` attacks the problem from the other side. It picks the most consistent
answer with `selectMostConsistent()` and `textSimilarity()`, or with a judge you supply in
`SelfConsistencyOptions`. It survives failed samples as long as one succeeds. `ConsistencyClient` is
its minimal client contract.

## Limitations

- The default hash embeddings suit tests and demos, not real semantic search. Use a real embedding
  provider for production retrieval.
- NLI verification is an interface, not a model. The bundled check is lexical, so bring a specialized
  verifier when you need high-confidence entailment.
- `MemoryVectorStore` lives in one process. Use a real vector database, or the long-term store with an
  index, for anything shared or persistent.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/rag`

| Export | Kind | Summary |
| --- | --- | --- |
| `cosineSimilarity` | function | Cosine similarity of two unit-length vectors, as their dot product. |
| `createHashEmbeddings` | function | Hashed term-count vectors, normalized to unit length. |
| `EmbeddingProvider` | type | Turns texts into vectors, one per text, in order. |
| `ingestDocuments` | function | Splits documents into overlapping chunks for retrieval. |
| `IngestionOptions` | interface | How documents are split. |
| `IngestionResult` | interface | The chunks produced from a set of documents. |
| `ingestText` | function | Splits one text into overlapping chunks for retrieval. |
| `matchesMetadata` | function | Whether a chunk's metadata satisfies an exact-match filter. |
| `MemoryVectorStore` | class | Chunks and their vectors in process memory, searched by cosine similarity. |
| `normalizeVector` | function | Scales a vector to unit length, so a dot product is its cosine similarity. |
| `RagChunk` | interface | A passage of retrieved context. |
| `VectorDocument` | interface | A chunk to store, with its vector when already computed. |
| `VectorSearchOptions` | interface | Options for a vector search. |
| `VectorSearchResult` | interface | A stored chunk returned by a search. |
| `VectorStore` | interface | Where retrieval chunks live and how they are searched. |

### `nexus-ai-pro/rag/qdrant`

| Export | Kind | Summary |
| --- | --- | --- |
| `QdrantError` | class | Raised when Qdrant answers with an error. |
| `QdrantVectorStore` | class | Retrieval chunks in a Qdrant collection, through its REST API. |
| `QdrantVectorStoreOptions` | interface | Options for the Qdrant store. |

### `nexus-ai-pro`

| Export | Kind | Summary |
| --- | --- | --- |
| `asJsonOnly` | function | Adds a system message asking for JSON only, with low sampling defaults. |
| `completeVerified` | function | Completes a request, checks each claim in the answer against the context, and asks for one revision when claims are unsupported. |
| `completeWithSelfConsistency` | function | Samples several answers and returns the one they agree with most. |
| `ConsistencyClient` | interface | The part of a client that self-consistency needs. |
| `createOcrExtractor` | function | An extractor for images, around your own OCR function. |
| `createPdfExtractor` | function | An extractor for PDF files, around your own PDF-to-text function. |
| `extractCitations` | function | Every distinct bracketed citation in a text. |
| `extractFacts` | function | Splits an answer into sentence-level claims, dropping "I don't know" style answers. |
| `FactualOptions` | interface | Options for `withFactualDefaults()`. |
| `FileIngestionOptions` | interface | Options for `ingestFilesAfterScan()`. |
| `FileIngestionResult` | interface | The chunks produced from a set of files, and the files that could not be read. |
| `FileTextExtractor` | interface | Turns one kind of file into text, such as PDF or an image through OCR. |
| `ingestFilesAfterScan` | function | Scans uploads, extracts their text, and splits it into chunks. |
| `KnowledgeGraph` | interface | Entities and the relationships between them. |
| `KnowledgeGraphEdge` | interface | A relationship between two entities. |
| `KnowledgeGraphNode` | interface | An entity in a knowledge graph. |
| `KnowledgeGraphOptions` | interface | Options for `withKnowledgeGraphContext()`. |
| `lexicalEntailment` | function | Whether a context supports a claim by term overlap: at least 72% of its significant terms, or the claim appearing verbatim. |
| `NliVerifier` | interface | A natural-language-inference model that judges whether a context entails a claim. |
| `RagOptions` | interface | Options for `withRagContext()`. |
| `selectGraphFacts` | function | Ranks a graph's relationships by how many terms they share with the query and states the best as fact lines. |
| `selectMostConsistent` | function | The response whose text is most similar to the others'. |
| `SelfConsistencyOptions` | interface | Options for `completeWithSelfConsistency()`. |
| `textSimilarity` | function | Jaccard similarity of two texts' terms, from 0 to 1. |
| `validateCitations` | function | Checks that every bracketed citation in a response names a known chunk. |
| `VerificationClient` | interface | The part of a client that verified completion needs. |
| `VerificationFact` | interface | One claim from an answer and whether the context supports it. |
| `VerificationOptions` | interface | Options for checking an answer against its context. |
| `VerificationReport` | interface | How well an answer is supported by its context. |
| `verifyAgainstContext` | function | Checks every claim in an answer against the context. |
| `withFactualDefaults` | function | Adds a system message that asks for factual, conservative answers, with low sampling defaults. |
| `withKnowledgeGraphContext` | function | Adds the graph facts most relevant to the request as a system message, telling the model not to infer relationships the graph lacks. |
| `withRagContext` | function | Adds retrieved passages as a system message, telling the model to answer only from them and cite them. |
<!-- reference:end -->
