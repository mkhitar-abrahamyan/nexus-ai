/**
 * Durable ingestion: keeps a vector store, and any keyword indexes beside it, in step with a corpus
 * that changes.
 *
 * A manifest in any `Store` records, for every document, the version of its content, the chunking,
 * the embedding model, and each chunk's version. A run reads the corpus, embeds only the chunks that
 * are new or changed, deletes the chunks a document no longer has and the documents the corpus no
 * longer has, and writes every change idempotently, before the manifest records it. A run that dies
 * halfway leaves a manifest that says exactly what finished; the next run skips it, and inside a
 * durable operation it starts at the document it stopped on.
 */
import type { EmbeddingProvider, VectorStore } from '../hallucination/retrieval.js';
import type { OperationContext, OperationExecutor } from '../types/operations.js';
import type { Store } from '../types/store.js';
import { type DocumentSource, ingestDocuments, type IngestionOptions, type RagChunk } from './ingestion.js';
import type { SparseRetriever } from './retrievers.js';

/** A source of documents: a loader, an array, or any iterable, read once per run. */
export type IngestionSource = AsyncIterable<DocumentSource> | Iterable<DocumentSource>;

/** Options for `createIngestionPipeline()`. */
export interface IngestionPipelineOptions {
  /** Names the pipeline. Its manifest is kept under this name, so two pipelines never share one. */
  name: string;
  /**
   * Where the manifest is kept: any `Store`, so it lives in memory, Redis, Postgres, or SQLite. It
   * holds one item per document, and a `MemoryStore` keeps 10,000 items unless given a larger
   * `maxItems`: a manifest that forgets a document re-embeds it.
   */
  manifest: Store;
  /** The vector store chunks are embedded into. */
  vectors: VectorStore;
  /**
   * Keyword indexes kept in step, such as an `ElasticsearchKeywordIndex`. A `PostgresKeywordIndex`
   * that is `shared` needs no place here: the vector store's writes already reach it.
   */
  keywords?: readonly SparseRetriever[];
  /** Embeds chunk texts. Called only for chunks that are new or changed. */
  embed: EmbeddingProvider;
  /** The embedding model, recorded with every document: a different one re-embeds everything. */
  embeddingModel: string;
  /** How documents are split. Different options re-chunk every document. */
  chunking?: IngestionOptions;
  /** Documents read, embedded, and recorded together. Defaults to 64. */
  batchSize?: number;
}

/** Options for one run. */
export interface IngestionRunOptions {
  /** Stops the run between batches. Everything recorded so far stays recorded. */
  signal?: AbortSignal;
  /**
   * Removes the documents the manifest has and this run did not see, with their chunks. Defaults to
   * true: the source is the whole corpus. Turn it off when a run loads only part of it.
   */
  deleteMissing?: boolean;
  /** Called after each batch, with the run so far. */
  onProgress?: (progress: IngestionReport) => void;
  /**
   * The durable operation the run belongs to, when it runs inside an `OperationRunner`. After every
   * batch the run records how far it got with `heartbeat()`, and a later attempt reads it from
   * `previousHeartbeat` and skips straight past what was finished.
   */
  operation?: Pick<OperationContext, 'heartbeat' | 'previousHeartbeat'>;
}

/** What a run did. */
export interface IngestionReport {
  /** Documents read. */
  documents: number;
  /** Documents whose content, chunking, and model were all as recorded, so nothing was done. */
  unchanged: number;
  /** Documents the manifest did not have. */
  added: number;
  /** Documents that changed. */
  updated: number;
  /** Documents removed because the corpus no longer has them. */
  deleted: number;
  /** Chunks embedded and written. */
  chunksEmbedded: number;
  /** Chunks of changed documents whose text did not change, so their embedding was kept. */
  chunksKept: number;
  /** Chunks removed. */
  chunksDeleted: number;
  /** Documents a resumed run skipped because an earlier attempt had finished them. */
  resumed: number;
}

/** What the manifest records for one document. */
export interface IngestedDocument {
  /** The document's id. */
  id: string;
  /** A hash of its text, source, and metadata. */
  version: string;
  /** A hash of the chunking options it was split with. */
  chunking: string;
  /** The embedding model its chunks were embedded with. */
  model: string;
  /** Each chunk's id, with the hash of its text: the chunk's version. */
  chunks: Record<string, string>;
  /** When it was last written, as ISO-8601. */
  updatedAt: string;
}

/** A pipeline: run it as often as the corpus changes. */
export interface IngestionPipeline {
  /** Brings the stores in step with the documents a source yields. */
  run(source: IngestionSource | readonly IngestionSource[], options?: IngestionRunOptions): Promise<IngestionReport>;
  /** What the manifest records for a document, or `undefined`. */
  document(id: string): Promise<IngestedDocument | undefined>;
  /** Removes documents by id, with their chunks, from every store and the manifest. */
  remove(ids: readonly string[]): Promise<number>;
}

/** Where a durable run got to, as it records it with `heartbeat()`. */
interface IngestionCheckpoint {
  pipeline: string;
  documents: number;
}

/**
 * Builds a pipeline that keeps the stores in step with a corpus, re-embedding only what changed.
 *
 * Documents need an `id` (or a `source`), which is what ties a document to its earlier version. A
 * chunk's id is its document's id and a hash of its text, so a chunk whose text did not change keeps
 * its embedding wherever it moved. Chunks are cut by length, within each Markdown section when
 * `splitOnMarkdownHeadings` is on, so an edit re-embeds the chunks of its section from the edit on,
 * and a section added or removed leaves the others alone. One run at a time per pipeline; an
 * operation's idempotency key enforces that across workers.
 *
 * ```ts
 * const pipeline = createIngestionPipeline({
 *   name: 'help-center',
 *   manifest: store,
 *   vectors: new PostgresVectorStore(pool, { dimensions: 1536 }),
 *   embed,
 *   embeddingModel: 'text-embedding-3-small',
 * });
 * const report = await pipeline.run(loadDirectory('./docs'));
 * ```
 */
export function createIngestionPipeline(options: IngestionPipelineOptions): IngestionPipeline {
  const batchSize = options.batchSize ?? 64;
  if (!(Number.isInteger(batchSize) && batchSize > 0)) throw new RangeError('batchSize must be a positive integer');
  const namespace = ['nexus', 'ingestion', options.name, 'documents'];
  const keywords = options.keywords ?? [];
  const chunkingVersion = stableJson(options.chunking ?? {});

  const read = async (id: string): Promise<IngestedDocument | undefined> =>
    (await options.manifest.get<IngestedDocument>(namespace, id))?.value;

  const removeChunks = async (ids: string[]): Promise<void> => {
    if (ids.length === 0) return;
    await Promise.all([options.vectors.delete(ids), ...keywords.map((index) => index.delete(ids))]);
  };

  const remove = async (ids: readonly string[]): Promise<number> => {
    let chunks = 0;
    for (const id of ids) {
      const recorded = await read(id);
      if (!recorded) continue;
      const chunkIds = Object.keys(recorded.chunks);
      await removeChunks(chunkIds);
      await options.manifest.delete(namespace, id);
      chunks += chunkIds.length;
    }
    return chunks;
  };

  return {
    document: read,
    async remove(ids) {
      await remove(ids);
      return ids.length;
    },
    async run(source, runOptions = {}) {
      const report: IngestionReport = {
        documents: 0,
        unchanged: 0,
        added: 0,
        updated: 0,
        deleted: 0,
        chunksEmbedded: 0,
        chunksKept: 0,
        chunksDeleted: 0,
        resumed: 0,
      };
      const previous = runOptions.operation?.previousHeartbeat as IngestionCheckpoint | undefined;
      // Documents an earlier attempt of this operation finished; they are counted, not read again.
      const skip = previous?.pipeline === options.name ? previous.documents : 0;
      const seen = new Set<string>();
      let batch: Array<{ document: DocumentSource; id: string }> = [];

      const flush = async () => {
        if (batch.length === 0) return;
        const current = batch;
        batch = [];
        const versions = await Promise.all(
          current.map(({ document }) =>
            hashText(stableJson([document.text, document.source ?? null, document.metadata ?? null])),
          ),
        );
        const recorded = await Promise.all(current.map(({ id }) => read(id)));

        const writes: Array<{ id: string; version: string; chunks: RagChunk[]; hashes: string[] }> = [];
        const stale: string[] = [];
        const toEmbed: RagChunk[] = [];
        for (const [index, { document, id }] of current.entries()) {
          const version = versions[index] as string;
          const before = recorded[index];
          if (
            before &&
            before.version === version &&
            before.chunking === chunkingVersion &&
            before.model === options.embeddingModel
          ) {
            report.unchanged += 1;
            continue;
          }
          if (before) report.updated += 1;
          else report.added += 1;

          const split = ingestDocuments([{ ...document, id }], options.chunking).chunks;
          const hashes = await Promise.all(
            split.map((chunk) => hashText(stableJson([chunk.content, document.metadata ?? null]))),
          );
          // A chunk is named by its text, so an edit elsewhere in the document never renames it.
          const used = new Map<string, number>();
          const chunks = split.map((chunk, position) => {
            const base = `${id}#${(hashes[position] as string).slice(0, 12)}`;
            const count = (used.get(base) ?? 0) + 1;
            used.set(base, count);
            return { ...chunk, id: count === 1 ? base : `${base}-${count}` };
          });
          const reusable =
            before && before.model === options.embeddingModel ? before.chunks : ({} as Record<string, string>);
          for (const [position, chunk] of chunks.entries()) {
            if (reusable[chunk.id] === hashes[position]) report.chunksKept += 1;
            else toEmbed.push(chunk);
          }
          const kept = new Set(chunks.map((chunk) => chunk.id));
          if (before)
            stale.push(...Object.keys(before.chunks).filter((chunkId) => !kept.has(chunkId) || !reusable[chunkId]));
          writes.push({ id, version, chunks, hashes });
        }

        // The stores first, then the manifest: a crash in between repeats a write, never loses one.
        if (toEmbed.length > 0) {
          const vectors = await options.embed(toEmbed.map((chunk) => chunk.content));
          if (vectors.length !== toEmbed.length) {
            throw new RangeError(
              `The embedding function returned ${vectors.length} vectors for ${toEmbed.length} texts`,
            );
          }
          await Promise.all([
            options.vectors.add(toEmbed.map((chunk, index) => ({ ...chunk, embedding: vectors[index] as number[] }))),
            ...keywords.map((index) => index.add(toEmbed)),
          ]);
          report.chunksEmbedded += toEmbed.length;
        }
        const embeddedIds = new Set(toEmbed.map((chunk) => chunk.id));
        const removable = stale.filter((chunkId) => !embeddedIds.has(chunkId));
        await removeChunks(removable);
        report.chunksDeleted += removable.length;
        const updatedAt = new Date().toISOString();
        await Promise.all(
          writes.map(({ id, version, chunks, hashes }) =>
            options.manifest.put<IngestedDocument>(namespace, id, {
              id,
              version,
              chunking: chunkingVersion,
              model: options.embeddingModel,
              chunks: Object.fromEntries(chunks.map((chunk, index) => [chunk.id, hashes[index] as string])),
              updatedAt,
            }),
          ),
        );
        await runOptions.operation?.heartbeat({
          pipeline: options.name,
          documents: report.documents,
        } satisfies IngestionCheckpoint);
        runOptions.onProgress?.({ ...report });
      };

      const sources: readonly IngestionSource[] = isSourceList(source) ? source : [source as IngestionSource];
      for (const loader of sources) {
        for await (const document of loader) {
          runOptions.signal?.throwIfAborted();
          const id = document.id ?? document.source;
          if (!id) throw new TypeError('Durable ingestion needs a document id, or a source to use as one');
          seen.add(id);
          report.documents += 1;
          if (report.documents <= skip) {
            report.resumed += 1;
            continue;
          }
          batch.push({ document, id });
          if (batch.length >= batchSize) await flush();
        }
      }
      runOptions.signal?.throwIfAborted();
      await flush();

      if (runOptions.deleteMissing !== false) {
        const missing: string[] = [];
        for (let offset = 0; ; offset += 500) {
          const page = await options.manifest.search<IngestedDocument>(namespace, { limit: 500, offset });
          for (const item of page) if (!seen.has(item.key)) missing.push(item.key);
          if (page.length < 500) break;
        }
        for (const id of missing) {
          runOptions.signal?.throwIfAborted();
          report.chunksDeleted += await remove([id]);
          report.deleted += 1;
        }
        if (missing.length > 0) runOptions.onProgress?.({ ...report });
      }
      return report;
    },
  };
}

/**
 * The pipeline as the executor of a durable operation: submit it to an `OperationRunner`, and an
 * attempt that dies halfway is recovered by another worker, which starts at the document the first
 * one stopped on.
 *
 * ```ts
 * const runner = new OperationRunner({ store: new RedisOperationStore(redis), retry: { maxAttempts: 5 } });
 * await runner.submit(ingestionExecutor(pipeline, () => loadDirectory('./docs')), { idempotencyKey: 'help-center' });
 * ```
 */
export function ingestionExecutor(
  pipeline: IngestionPipeline,
  source: () => IngestionSource | readonly IngestionSource[],
  options: Omit<IngestionRunOptions, 'operation' | 'signal'> = {},
): OperationExecutor<IngestionReport> {
  return (context) => pipeline.run(source(), { ...options, signal: context.signal, operation: context });
}

/** SHA-256 of a text, as 32 hex digits: what a document's or a chunk's version is. */
async function hashText(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const byte of new Uint8Array(digest).subarray(0, 16)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** JSON with object keys sorted, so equal values always serialize, and hash, the same. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : entry,
  );
}

function isSourceList(value: IngestionSource | readonly IngestionSource[]): value is readonly IngestionSource[] {
  if (!Array.isArray(value)) return false;
  const first = value[0] as unknown;
  return first !== undefined && typeof first === 'object' && first !== null && !('text' in first);
}
