/**
 * Media search and RAG: index what media say and show, find the media a question is about, and hand
 * the model the media themselves, not only their text.
 */
import type { VectorDocument, VectorStore } from '../hallucination/retrieval.js';
import type { AssetStore } from '../images/asset-support.js';
import { wireDocument, wireImage } from '../providers/content.js';
import type { EmbeddingRequest, EmbeddingResponse } from '../types/embeddings.js';
import type { Store } from '../types/store.js';
import { decodeBase64, encodeBase64 } from '../utils/base64.js';
import { type MediaAnswer, MediaError, type MediaInput, type MediaKind, type MediaManager } from './index.js';

/** Anything that embeds, such as an `EmbeddingManager` or a client's `embeddings`. */
export interface MediaEmbeddingSource {
  /** Embeds texts, or media as parts. */
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;
}

/** A medium to index, under its own id. */
export interface MediaDocument {
  /** The medium's id, which every hit carries. */
  id: string;
  /** The image or document. */
  media: MediaInput;
  /** Where it came from, such as a path or a URL, carried with every hit. */
  source?: string;
  /** Application data carried with every hit, and filterable. */
  metadata?: Record<string, string | number | boolean>;
}

/** Where a hit's medium is kept, so it can be handed back: by its URL, or as a stored asset. */
export interface MediaReference {
  /** An image or a document. */
  type: MediaKind;
  /** Its MIME type, when known. */
  mimeType?: string;
  /** Its file name, when it has one. */
  filename?: string;
  /** The URL that holds it. */
  url?: string;
  /** Its id in the index's asset store. */
  assetId?: string;
}

/** What `createMediaIndex()` indexes, and where. */
export interface MediaIndexOptions {
  /** The vector store the index's chunks go to. */
  vectors: VectorStore;
  /** Reads pages and describes images: a `MediaManager`. */
  media: Pick<MediaManager, 'read' | 'describe'>;
  /** Embeds chunks and questions. */
  embeddings: MediaEmbeddingSource;
  /** The embedding model. Defaults to the embedder's own. */
  model?: string;
  /**
   * Keeps each medium held as bytes or base64, so a hit can hand the model the medium itself. A medium
   * at a URL is kept by reference and needs no store.
   */
  assets?: { store: AssetStore; tenantId: string };
  /**
   * What is indexed for each medium: its pages' text, a caption (for images), and its own vector,
   * embedded from the medium itself by a model that takes it. Defaults to pages and captions.
   */
  index?: { pages?: boolean; captions?: boolean; vectors?: boolean };
  /** The longest chunk of page text, in characters; a longer page is split at paragraphs. Defaults to 4,000. */
  maxChunkChars?: number;
  /**
   * Where the index remembers what it holds: any `Store`, so it lives in memory, Redis, Postgres, or
   * SQLite. With one, `add()` skips a medium whose content and options are unchanged and replaces
   * exactly the chunks of one that changed, and `delete()`, `reindex()`, `describe()`, and `list()`
   * work by a medium's id. A store with an item limit must hold every medium.
   */
  manifest?: Store;
  /** Names the index. Its manifest is kept under this name, so two indexes never share one. Defaults to `media`. */
  name?: string;
}

/** Who produced a medium's text or caption. */
export interface MediaIndexReader {
  /** The provider that answered. */
  provider: string;
  /** The model it used. */
  model: string;
}

/** What the manifest records for one medium. */
export interface MediaIndexEntry {
  /** The medium's id. */
  id: string;
  /**
   * A hash of the medium's content, source, metadata, and how it was indexed: the medium's version.
   * Adding it again with the same hash writes nothing.
   */
  hash: string;
  /** Where it came from. */
  source?: string;
  /** Its metadata. */
  metadata?: Record<string, string | number | boolean>;
  /** Where the medium is kept: its URL, or its asset. */
  reference: MediaReference;
  /** The pages that were read. */
  pages: number;
  /** Every chunk's id in the vector store. */
  chunkIds: string[];
  /** The embedding model, when one was named. */
  model?: string;
  /** Who read its pages, when they were read. */
  reader?: MediaIndexReader;
  /** Who described it, when it was described. */
  describer?: MediaIndexReader;
  /** ISO-8601 time it was first indexed. */
  createdAt: string;
  /** ISO-8601 time it was last indexed. */
  updatedAt: string;
  /**
   * A change that began and has not finished, as a crash leaves it: its version, its chunks, and the
   * asset it stored. The next `add()`, `reindex()`, or `delete()` of the medium finishes or undoes it.
   */
  pending?: { hash: string; chunkIds: string[]; assetId?: string };
}

/** What `add()` indexed. */
export interface MediaIndexReport {
  /** Media indexed. */
  media: number;
  /** Media the manifest already held at the same version, which were not indexed again. */
  unchanged: number;
  /** Chunks of page text. */
  pages: number;
  /** Captions. */
  captions: number;
  /** Vectors of the media themselves. */
  vectors: number;
  /** Every chunk's id, by medium, for removing a medium from the store. */
  ids: Record<string, string[]>;
}

/** A medium a search found: the best of its chunks, and where to find the medium. */
export interface MediaHit {
  /** The medium's id. */
  id: string;
  /** The best chunk's similarity, 0 to 1. */
  score: number;
  /** What matched best: a page's text, the caption, or the medium's own vector. */
  kind: 'page' | 'caption' | 'image';
  /** The page that matched, from 0, when a page did. */
  page?: number;
  /** The matched chunk's text. */
  text: string;
  /** Where the medium came from. */
  source?: string;
  /** The medium's own metadata. */
  metadata: Record<string, unknown>;
  /** Where the medium is kept. */
  reference: MediaReference;
}

/** Options for a search. */
export interface MediaSearchOptions {
  /** Media to return, the best first. Defaults to 5. */
  topK?: number;
  /** Matches media by their metadata. */
  filter?: Record<string, string | number | boolean>;
}

/** An index of media in a vector store. */
export interface MediaIndex {
  /**
   * Reads, describes, and embeds each medium, and writes its chunks. Adding an id again replaces it;
   * with a manifest, only when its content, source, metadata, or the index's options changed.
   */
  add(documents: readonly MediaDocument[]): Promise<MediaIndexReport>;
  /** Removes media by id: their chunks, their stored assets, and their manifest entries. Needs a manifest. */
  delete(ids: readonly string[]): Promise<number>;
  /**
   * Indexes media again by id, from where the manifest says each is kept, even when unchanged: after a
   * new embedding model or a better reader. Needs a manifest.
   */
  reindex(ids: readonly string[]): Promise<MediaIndexReport>;
  /** What the manifest records for a medium, or `undefined`. Needs a manifest. */
  describe(id: string): Promise<MediaIndexEntry | undefined>;
  /** The manifest's entries, newest first, a page at a time. Needs a manifest. */
  list(options?: { limit?: number; offset?: number }): Promise<MediaIndexEntry[]>;
  /** The media a question is about, each once, at its best chunk. */
  search(query: string, options?: MediaSearchOptions): Promise<MediaHit[]>;
  /** The medium behind a hit, to hand a model; `undefined` when its asset is gone. */
  resolve(hit: Pick<MediaHit, 'reference'>): Promise<MediaInput | undefined>;
}

/** Keys the index keeps on every chunk, which a hit's `metadata` leaves out. */
const OWN = new Set(['mediaId', 'mediaKind', 'page', 'mediaRef', 'source']);

/**
 * Builds an index of media in a vector store. Each medium becomes chunks: its pages' text, from
 * `read()`; for an image, its caption, from `describe()`; and, when asked, a vector of the medium
 * itself. A search finds the media, and `resolve()` hands back each one, so the model sees the image,
 * not only what was written about it.
 *
 * ```ts
 * const index = createMediaIndex({ vectors, media, embeddings: ai.embeddings, assets: { store, tenantId: 'acme' } });
 * await index.add([{ id: 'invoice-17', media: { type: 'document', source: { buffer: pdf } } }]);
 * const answer = await answerFromMedia(media, index, 'What is the total on invoice 17?');
 * ```
 */
export function createMediaIndex(options: MediaIndexOptions): MediaIndex {
  const maxChunkChars = options.maxChunkChars ?? 4_000;
  const want = {
    pages: options.index?.pages ?? true,
    captions: options.index?.captions ?? true,
    vectors: options.index?.vectors ?? false,
  };
  const embed = async (input: EmbeddingRequest['input'], inputType: 'document' | 'query') =>
    (await options.embeddings.embed({ input, inputType, ...(options.model ? { model: options.model } : {}) })).vectors;
  const manifest = options.manifest;
  const namespace = ['nexus', 'media-index', options.name ?? 'media', 'media'];
  // What every medium's version depends on beside the medium: how the index reads, splits, and embeds it.
  const indexing = stableJson([want, maxChunkChars, options.model ?? null]);
  const needManifest = (method: string): Store => {
    if (!manifest) throw new MediaError(`A media index needs a manifest to ${method} by id`, 'MEDIA_INVALID');
    return manifest;
  };
  const entryOf = async (id: string): Promise<MediaIndexEntry | undefined> =>
    manifest ? (await manifest.get<MediaIndexEntry>(namespace, id))?.value : undefined;
  const dropAsset = async (assetId: string | undefined): Promise<void> => {
    if (assetId && options.assets) await options.assets.store.delete(assetId, options.assets.tenantId);
  };

  const keep = async (document: MediaDocument): Promise<MediaReference> => {
    const { media } = document;
    const wire = media.type === 'image' ? wireImage(media) : wireDocument(media);
    if (!wire)
      throw new MediaError(
        `Medium "${document.id}" must hold its content, as bytes, base64, or a URL`,
        'MEDIA_INVALID',
      );
    const filename = media.type === 'document' ? media.filename : undefined;
    if (wire.kind === 'url') return { type: media.type, url: wire.url, ...(filename ? { filename } : {}) };
    if (!options.assets) {
      throw new MediaError(
        `Medium "${document.id}" is held as bytes: give the index an asset store to keep it, so a hit can hand it back`,
        'MEDIA_INVALID',
      );
    }
    const stat = await options.assets.store.put(
      {
        location: { kind: 'bytes', data: decodeBase64(wire.data) },
        mimeType: wire.mimeType,
        ...(filename ? { filename } : {}),
      },
      {
        tenantId: options.assets.tenantId,
        provenance: { provider: 'media-index', requestId: document.id, operation: 'upload' },
      },
    );
    return { type: media.type, mimeType: wire.mimeType, assetId: stat.assetId, ...(filename ? { filename } : {}) };
  };

  /** Reads, describes, and embeds a medium into chunks, writing nothing. */
  const build = async (document: MediaDocument, reference: MediaReference, report: MediaIndexReport) => {
    const base = {
      ...document.metadata,
      mediaId: document.id,
      mediaRef: JSON.stringify(reference),
      ...(document.source ? { source: document.source } : {}),
    };
    const chunks: VectorDocument[] = [];
    let pages = 0;
    let reader: MediaIndexReader | undefined;
    let describer: MediaIndexReader | undefined;
    if (want.pages) {
      const read = await options.media.read({ media: document.media });
      reader = { provider: read.provider, model: read.model };
      pages = read.pages.length;
      for (const page of read.pages) {
        for (const [part, text] of splitText(page.text, maxChunkChars).entries()) {
          chunks.push({
            id: `${document.id}#p${page.index}${part ? `-${part}` : ''}`,
            content: text,
            ...(document.source ? { source: document.source } : {}),
            metadata: { ...base, mediaKind: 'page', page: page.index },
          });
          report.pages += 1;
        }
      }
    }
    let caption: string | undefined;
    if (want.captions && document.media.type === 'image') {
      const described = await options.media.describe({ media: document.media });
      describer = { provider: described.provider, model: described.model };
      caption = described.caption;
      chunks.push({
        id: `${document.id}#caption`,
        content: caption,
        ...(document.source ? { source: document.source } : {}),
        metadata: { ...base, mediaKind: 'caption' },
      });
      report.captions += 1;
    }
    const vectors = chunks.length
      ? await embed(
          chunks.map((chunk) => chunk.content),
          'document',
        )
      : [];
    chunks.forEach((chunk, index) => {
      chunk.embedding = vectors[index];
    });
    if (want.vectors) {
      const [vector] = await embed({ parts: [document.media] }, 'document');
      chunks.push({
        id: `${document.id}#image`,
        content: caption ?? `[${document.media.type} ${document.id}]`,
        ...(document.source ? { source: document.source } : {}),
        metadata: { ...base, mediaKind: 'image' },
        ...(vector ? { embedding: vector } : {}),
      });
      report.vectors += 1;
    }
    return { chunks, pages, reader, describer };
  };

  /**
   * Indexes one medium. With a manifest the order is what makes a crash harmless: the change is
   * recorded as pending, then the chunks are written, the stale ones removed, and the old asset
   * deleted, and only then is the change recorded as done. A crash anywhere leaves it pending, and the
   * next attempt drops what it stored and does it again. Chunk ids are fixed by the medium's id and
   * pages, so a write repeated after a crash replaces rather than adds.
   */
  const indexOne = async (document: MediaDocument, report: MediaIndexReport, force: boolean): Promise<void> => {
    const recorded = await entryOf(document.id);
    const wire = document.media.type === 'image' ? wireImage(document.media) : wireDocument(document.media);
    const hash = await hashText(
      stableJson([wire ?? null, document.source ?? null, document.metadata ?? null, indexing]),
    );
    if (manifest && recorded && !recorded.pending && recorded.hash === hash && !force) {
      report.unchanged += 1;
      report.ids[document.id] = recorded.chunkIds;
      return;
    }
    // A change a crash left halfway: its asset, unless it is the one recorded, goes before a new one.
    if (recorded?.pending?.assetId && recorded.pending.assetId !== recorded.reference.assetId) {
      await dropAsset(recorded.pending.assetId);
    }
    const unchangedAsset =
      recorded?.reference.assetId !== undefined && recorded.hash === hash && !recorded.pending
        ? recorded.reference
        : undefined;
    const reference = unchangedAsset ?? (await keep(document));
    const { chunks, pages, reader, describer } = await build(document, reference, report);
    const chunkIds = chunks.map((chunk) => chunk.id);
    const now = new Date().toISOString();
    if (manifest) {
      const pending = { hash, chunkIds, ...(reference.assetId ? { assetId: reference.assetId } : {}) };
      // A medium indexed for the first time is recorded as a placeholder that holds only the change.
      await manifest.put<MediaIndexEntry>(
        namespace,
        document.id,
        recorded
          ? { ...recorded, pending }
          : {
              id: document.id,
              hash: '',
              reference: { type: document.media.type },
              pages: 0,
              chunkIds: [],
              createdAt: now,
              updatedAt: now,
              pending,
            },
      );
    }
    if (chunks.length) await options.vectors.add(chunks);
    const stale = [...new Set([...(recorded?.chunkIds ?? []), ...(recorded?.pending?.chunkIds ?? [])])].filter(
      (id) => !chunkIds.includes(id),
    );
    if (stale.length) await options.vectors.delete(stale);
    if (manifest) {
      if (recorded?.reference.assetId && recorded.reference.assetId !== reference.assetId) {
        await dropAsset(recorded.reference.assetId);
      }
      await manifest.put<MediaIndexEntry>(namespace, document.id, {
        id: document.id,
        hash,
        ...(document.source ? { source: document.source } : {}),
        ...(document.metadata ? { metadata: document.metadata } : {}),
        reference,
        pages,
        chunkIds,
        ...(options.model ? { model: options.model } : {}),
        ...(reader ? { reader } : {}),
        ...(describer ? { describer } : {}),
        createdAt: recorded?.createdAt ?? now,
        updatedAt: now,
      });
    }
    report.ids[document.id] = chunkIds;
    report.media += 1;
  };

  const emptyReport = (): MediaIndexReport => ({ media: 0, unchanged: 0, pages: 0, captions: 0, vectors: 0, ids: {} });

  const index: MediaIndex = {
    async add(documents) {
      const report = emptyReport();
      for (const document of documents) await indexOne(document, report, false);
      return report;
    },

    async delete(ids) {
      const store = needManifest('delete');
      let removed = 0;
      for (const id of ids) {
        const recorded = await entryOf(id);
        if (!recorded) continue;
        // The chunks and assets first, the entry last: a crash in between leaves an entry that a
        // second delete finishes.
        const chunkIds = [...new Set([...recorded.chunkIds, ...(recorded.pending?.chunkIds ?? [])])];
        if (chunkIds.length) await options.vectors.delete(chunkIds);
        await dropAsset(recorded.reference.assetId);
        if (recorded.pending?.assetId !== recorded.reference.assetId) await dropAsset(recorded.pending?.assetId);
        await store.delete(namespace, id);
        removed += 1;
      }
      return removed;
    },

    async reindex(ids) {
      needManifest('reindex');
      const report = emptyReport();
      for (const id of ids) {
        const recorded = await entryOf(id);
        if (!recorded) throw new MediaError(`The media index holds no medium "${id}"`, 'MEDIA_INVALID');
        const media = await index.resolve({ reference: recorded.reference });
        if (!media) throw new MediaError(`Medium "${id}" is no longer where the index kept it`, 'MEDIA_INVALID');
        await indexOne(
          {
            id,
            media,
            ...(recorded.source ? { source: recorded.source } : {}),
            ...(recorded.metadata ? { metadata: recorded.metadata } : {}),
          },
          report,
          true,
        );
      }
      return report;
    },

    async describe(id) {
      needManifest('describe a medium');
      return entryOf(id);
    },

    async list(listOptions = {}) {
      const store = needManifest('list media');
      const items = await store.search<MediaIndexEntry>(namespace, {
        limit: listOptions.limit ?? 100,
        offset: listOptions.offset ?? 0,
      });
      return items.map((item) => item.value);
    },

    async search(query, searchOptions = {}) {
      const topK = searchOptions.topK ?? 5;
      const [vector] = await embed(query, 'query');
      // A medium has several chunks, so more are asked for than media are wanted.
      const found = await options.vectors.searchVector(vector as number[], {
        topK: topK * 4,
        ...(searchOptions.filter ? { filter: searchOptions.filter } : {}),
      });
      const hits: MediaHit[] = [];
      const seen = new Set<string>();
      for (const result of found) {
        const metadata = result.metadata ?? {};
        const id = String(metadata.mediaId ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        hits.push({
          id,
          score: result.score,
          kind: (metadata.mediaKind as MediaHit['kind']) ?? 'page',
          ...(typeof metadata.page === 'number' ? { page: metadata.page } : {}),
          text: result.content,
          ...(typeof metadata.source === 'string' ? { source: metadata.source } : {}),
          metadata: Object.fromEntries(Object.entries(metadata).filter(([key]) => !OWN.has(key))),
          reference: JSON.parse(String(metadata.mediaRef ?? '{}')) as MediaReference,
        });
        if (hits.length === topK) break;
      }
      return hits;
    },

    async resolve({ reference }) {
      if (reference.url) {
        return reference.type === 'image'
          ? { type: 'image', source: { url: reference.url } }
          : {
              type: 'document',
              source: { url: reference.url },
              ...(reference.filename ? { filename: reference.filename } : {}),
            };
      }
      if (!reference.assetId || !options.assets) return undefined;
      const asset = await options.assets.store.get(reference.assetId, options.assets.tenantId);
      if (!asset) return undefined;
      const base64 = encodeBase64(asset.location.data);
      return reference.type === 'image'
        ? { type: 'image', source: { base64, mimeType: asset.mimeType } }
        : {
            type: 'document',
            source: { base64, mimeType: asset.mimeType },
            ...(reference.filename ? { filename: reference.filename } : {}),
          };
    },
  };
  return index;
}

/** An answer from media, with the hits it was given. */
export interface MediaRagAnswer extends MediaAnswer {
  /** The media the answer was given, the best first. */
  hits: MediaHit[];
}

/**
 * Answers a question from the media an index finds for it: the media themselves go to the model, so
 * it sees what a page or an image shows, not only what was written about it.
 */
export async function answerFromMedia(
  media: Pick<MediaManager, 'answer'>,
  index: MediaIndex,
  question: string,
  options: MediaSearchOptions & { provider?: string; signal?: AbortSignal } = {},
): Promise<MediaRagAnswer> {
  const hits = await index.search(question, {
    topK: options.topK ?? 3,
    ...(options.filter ? { filter: options.filter } : {}),
  });
  const resolved: MediaInput[] = [];
  const used: MediaHit[] = [];
  for (const hit of hits) {
    const medium = await index.resolve(hit);
    if (!medium) continue;
    resolved.push(medium);
    used.push(hit);
  }
  if (resolved.length === 0) throw new MediaError('No media were found for the question', 'MEDIA_NO_PROVIDER');
  const answer = await media.answer({
    media: resolved,
    question,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { ...answer, hits: used };
}

/** SHA-256 of a text, through Web Crypto, as 64 hex digits: what a medium's version is. */
async function hashText(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** JSON with object keys sorted, so equal values always serialize, and hash, the same. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}

/** A page's text in pieces of at most `max` characters, cut at paragraphs, then at sentences. */
function splitText(text: string, max: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) return [trimmed];
  const pieces: string[] = [];
  let current = '';
  for (const paragraph of trimmed.split(/\n{2,}/)) {
    const parts =
      paragraph.length > max
        ? (paragraph.match(new RegExp(`[\\s\\S]{1,${max}}(?=\\s|$)`, 'g')) ?? [paragraph])
        : [paragraph];
    for (const part of parts) {
      if (current && current.length + part.length + 2 > max) {
        pieces.push(current);
        current = '';
      }
      current = current ? `${current}\n\n${part}` : part;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}
