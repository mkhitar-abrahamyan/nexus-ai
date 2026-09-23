# Grounding: retrieval, citations, and verification

<!-- covers: ./rag -->
<!-- sources: src/hallucination src/rag -->

Making an answer follow from evidence, and catching it when it does not. Ingestion splits documents
into chunks, a vector store retrieves them, `withRagContext()` puts them in front of the model with
citation rules, and the verification helpers check what came back. Every export here is reached from
the root import except ingestion, which is on `nexus-ai-pro/rag`.

## RAG and Grounded Answers

```ts
import { MemoryVectorStore, withRagContext } from 'nexus-ai-pro';

const store = new MemoryVectorStore();
await store.add([
  { id: 'doc-1', content: 'NexusAI supports RAG context with citations.', source: 'docs' },
]);

const chunks = await store.search('How does NexusAI ground answers?', { topK: 3 });

const response = await ai.completeVerified(
  withRagContext({
    model: 'auto',
    messages: [{ role: 'user', content: 'How does NexusAI ground answers?' }],
  }, {
    chunks,
    requireCitations: true,
  }),
  {
    context: chunks.map((chunk) => chunk.content),
    minSupportRatio: 0.85,
  },
);
```

## Ingesting documents

`ingestDocuments()` and `ingestText()` split text into overlapping chunks, optionally at Markdown
headings, and return `RagChunk` values ready for a vector store, with an `IngestionResult` saying how
much was read. `ingestFilesAfterScan()` goes one step earlier: it scans uploaded files for unsafe
content first, extracts their text, and then chunks them, skipping what it cannot read.
`createPdfExtractor()` and `createOcrExtractor()` wrap your own PDF or OCR function as a
`FileTextExtractor`, so the library carries no parsing dependency of its own.

```ts
import { ingestFilesAfterScan, createPdfExtractor } from 'nexus-ai-pro';

const { chunks, skippedFiles } = await ingestFilesAfterScan(uploads, {
  extractors: [createPdfExtractor(myPdfToText)],
  chunkSize: 1200,
  splitOnMarkdownHeadings: true,
});
```

## Retrieval

`MemoryVectorStore` holds chunks and their vectors in process and searches them by cosine
similarity, with `VectorSearchOptions` for how many results and how similar they must be. It takes
any `EmbeddingProvider` — `toEmbeddingFunction()` adapts the embeddings family, so retrieval inherits
routing, batching, and caching — and falls back to `createHashEmbeddings()`, deterministic hashed
term vectors that need no provider and suit tests rather than production. `cosineSimilarity()` and
`normalizeVector()` are the arithmetic underneath, and `VectorDocument` and `VectorSearchResult` are
what goes in and comes out.

## Answering from context

`withRagContext()` turns a request into a grounded one: the chunks become a system message, the model
is told to answer only from them and to cite them by id, and sampling defaults low. `RagOptions`
controls the citation style, how many chunks are included, and what the model should say when the
context does not answer the question. `extractCitations()` reads the citations back out of an answer
and `validateCitations()` checks that each one names a chunk that was actually supplied.

`withKnowledgeGraphContext()` does the same for relationships rather than passages: it ranks a
`KnowledgeGraph` of `KnowledgeGraphNode` and `KnowledgeGraphEdge` values against the question,
states the best ones as facts, and tells the model not to infer relationships the graph does not
contain. `selectGraphFacts()` is the ranking on its own, and `KnowledgeGraphOptions` configures it.

`withFactualDefaults()` is the lighter option when there is no retrieval at all: it asks for
conservative answers, sets an explicit "I do not know" fallback, and keeps sampling low, with
`FactualOptions` for the wording and worked examples. `asJsonOnly()` does the same for JSON-only
output.

## Checking the answer

`verifyAgainstContext()` splits an answer into claims with `extractFacts()` and checks each one
against the context, returning a `VerificationReport` of `VerificationFact` values and the share
supported. The default check is `lexicalEntailment()`, term overlap that needs no model; supply an
`NliVerifier` for a real entailment model. `completeVerified()` runs the whole loop — complete,
verify, and ask once for a revision when claims are unsupported — and attaches the report to the
response's `meta.verification`. `VerificationOptions` sets the minimum share supported and the
fallback answer, and `VerificationClient` is the small client contract it needs.

`completeWithSelfConsistency()` attacks the same problem from the other side: it samples several
answers and returns the one the others agree with most, through `selectMostConsistent()` and
`textSimilarity()`, or a judge you supply in `SelfConsistencyOptions`. It survives failed samples as
long as one succeeds, and `ConsistencyClient` is again the minimal client contract.

## Limitations

- Default hash embeddings suit tests and demos, not strong semantic search. Register a real
  embedding provider for production retrieval.
- NLI verification is an interface, not a model: the bundled check is lexical, so bring a specialized
  verifier when you need high-confidence entailment.
- `MemoryVectorStore` is process-local. Use a real vector database, or the long-term store with an
  index, for anything shared or persistent.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/rag`

| Export | Kind | Summary |
| --- | --- | --- |
| `DocumentSource` | interface | A document to split into chunks. |
| `ingestDocuments` | function | Splits documents into overlapping chunks for retrieval. |
| `IngestionOptions` | interface | How documents are split. |
| `IngestionResult` | interface | The chunks produced from a set of documents. |
| `ingestText` | function | Splits one text into overlapping chunks for retrieval. |

### `nexus-ai-pro`

| Export | Kind | Summary |
| --- | --- | --- |
| `asJsonOnly` | function | Adds a system message asking for JSON only, with low sampling defaults. |
| `completeVerified` | function | Completes a request, checks each claim in the answer against the context, and asks for one revision when claims are unsupported. |
| `completeWithSelfConsistency` | function | Samples several answers and returns the one they agree with most. |
| `ConsistencyClient` | interface | The part of a client that self-consistency needs. |
| `cosineSimilarity` | function | Cosine similarity of two unit-length vectors, as their dot product. |
| `createHashEmbeddings` | function | Hashed term-count vectors, normalized to unit length. |
| `createOcrExtractor` | function | An extractor for images, around your own OCR function. |
| `createPdfExtractor` | function | An extractor for PDF files, around your own PDF-to-text function. |
| `EmbeddingProvider` | type | Turns texts into vectors, one per text, in order. |
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
| `MemoryVectorStore` | class | Chunks and their vectors in process memory, searched by cosine similarity. |
| `NliVerifier` | interface | A natural-language-inference model that judges whether a context entails a claim. |
| `RagChunk` | interface | A passage of retrieved context. |
| `RagOptions` | interface | Options for `withRagContext()`. |
| `selectGraphFacts` | function | Ranks a graph's relationships by how many terms they share with the query and states the best as fact lines. |
| `selectMostConsistent` | function | The response whose text is most similar to the others'. |
| `SelfConsistencyOptions` | interface | Options for `completeWithSelfConsistency()`. |
| `textSimilarity` | function | Jaccard similarity of two texts' terms, from 0 to 1. |
| `validateCitations` | function | Checks that every bracketed citation in a response names a known chunk. |
| `VectorDocument` | interface | A chunk to store, with its vector when already computed. |
| `VectorSearchOptions` | interface | Options for a vector search. |
| `VectorSearchResult` | interface | A stored chunk returned by a search. |
| `VerificationClient` | interface | The part of a client that verified completion needs. |
| `VerificationFact` | interface | One claim from an answer and whether the context supports it. |
| `VerificationOptions` | interface | Options for checking an answer against its context. |
| `VerificationReport` | interface | How well an answer is supported by its context. |
| `verifyAgainstContext` | function | Checks every claim in an answer against the context. |
| `withFactualDefaults` | function | Adds a system message that asks for factual, conservative answers, with low sampling defaults. |
| `withKnowledgeGraphContext` | function | Adds the graph facts most relevant to the request as a system message, telling the model not to infer relationships the graph lacks. |
| `withRagContext` | function | Adds retrieved passages as a system message, telling the model to answer only from them and cite them. |
<!-- reference:end -->
