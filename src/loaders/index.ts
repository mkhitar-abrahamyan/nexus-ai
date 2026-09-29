import type { RagChunk } from '../hallucination/rag.js';
import { type DocumentSource, type IngestionOptions, ingestDocuments } from '../rag/ingestion.js';

export type { DocumentSource } from '../rag/ingestion.js';

/**
 * Documents produced one at a time. Every loader returns one, so a corpus larger than memory streams
 * through ingestion instead of being read whole, and an array of documents works as well.
 */
export type DocumentLoader = AsyncIterable<DocumentSource> | Iterable<DocumentSource>;

/**
 * A file to load: a path, a `file:` URL, or content already in memory with a name for it. In-memory
 * content is how a loader reads an upload, a database blob, or a file on a runtime without a disk.
 */
export type FileInput = string | URL | { source: string; content: string | Uint8Array };

/** Reads every document from one or more loaders, in order, into an array. */
export async function collectDocuments(...loaders: DocumentLoader[]): Promise<DocumentSource[]> {
  const documents: DocumentSource[] = [];
  for (const loader of loaders) {
    for await (const document of loader) documents.push(document);
  }
  return documents;
}

/**
 * Where loaded chunks go: a vector store, a `KeywordIndex`, or anything else with an `add()` for
 * chunks. Loading into several at once fills a vector store and the keyword index hybrid search reads
 * in one pass over the corpus.
 */
export interface ChunkSink {
  /** Adds chunks, replacing those whose id is already held. */
  add(chunks: RagChunk[]): unknown;
}

/** Options for `loadIntoStore()`: how documents are split, and how many are embedded at once. */
export interface LoadIntoStoreOptions extends IngestionOptions {
  /** Documents split and added to the store together. Defaults to 32. */
  batchSize?: number;
  /** Stops loading between batches. */
  signal?: AbortSignal;
  /** Called after each batch is stored, for progress reporting. */
  onBatch?: (progress: LoadIntoStoreResult) => void;
}

/** What `loadIntoStore()` stored. */
export interface LoadIntoStoreResult {
  /** Documents read from the loaders. */
  documents: number;
  /** Chunks added to the store. */
  chunks: number;
  /** Characters across every document. */
  totalCharacters: number;
}

/**
 * Streams documents from loaders into one or more stores: each batch is split into chunks and added to
 * every store at once, so memory holds one batch at a time however large the corpus is. Chunk ids
 * derive from document ids, so loading the same corpus again replaces its chunks rather than
 * duplicating them. A document with no id is numbered in load order.
 */
export async function loadIntoStore(
  stores: ChunkSink | readonly ChunkSink[],
  loaders: DocumentLoader | readonly DocumentLoader[],
  options: LoadIntoStoreOptions = {},
): Promise<LoadIntoStoreResult> {
  const batchSize = options.batchSize ?? 32;
  if (!(Number.isInteger(batchSize) && batchSize > 0)) throw new RangeError('batchSize must be a positive integer');
  const result: LoadIntoStoreResult = { documents: 0, chunks: 0, totalCharacters: 0 };
  let batch: DocumentSource[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const ingested = ingestDocuments(batch, options);
    const targets: readonly ChunkSink[] = 'add' in stores ? [stores as ChunkSink] : (stores as readonly ChunkSink[]);
    await Promise.all(targets.map((store) => store.add(ingested.chunks)));
    result.chunks += ingested.chunks.length;
    result.totalCharacters += ingested.totalCharacters;
    batch = [];
    options.onBatch?.({ ...result });
  };

  const sources: readonly DocumentLoader[] = isLoaderList(loaders) ? loaders : [loaders as DocumentLoader];
  for (const loader of sources) {
    for await (const document of loader) {
      options.signal?.throwIfAborted();
      result.documents++;
      batch.push(document.id ? document : { ...document, id: `doc-${result.documents}` });
      if (batch.length >= batchSize) await flush();
    }
  }
  options.signal?.throwIfAborted();
  await flush();
  return result;
}

/** Whether a value is a list of loaders rather than one loader that happens to be an array of documents. */
function isLoaderList(value: DocumentLoader | readonly DocumentLoader[]): value is readonly DocumentLoader[] {
  if (!Array.isArray(value)) return false;
  const first = value[0] as unknown;
  return first !== undefined && typeof first === 'object' && first !== null && !('text' in first);
}
