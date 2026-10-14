/**
 * Media search and RAG: index what media say and show, find the media a question is about, and hand
 * the model the media themselves, not only their text.
 */
import type { VectorDocument, VectorStore } from '../hallucination/retrieval.js';
import type { AssetStore } from '../images/asset-support.js';
import { wireDocument, wireImage } from '../providers/content.js';
import type { EmbeddingRequest, EmbeddingResponse } from '../types/embeddings.js';
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
}

/** What `add()` indexed. */
export interface MediaIndexReport {
  /** Media indexed. */
  media: number;
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
  /** Reads, describes, and embeds each medium, and writes its chunks. Adding an id again replaces it. */
  add(documents: readonly MediaDocument[]): Promise<MediaIndexReport>;
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

  return {
    async add(documents) {
      const report: MediaIndexReport = { media: 0, pages: 0, captions: 0, vectors: 0, ids: {} };
      for (const document of documents) {
        const reference = await keep(document);
        const base = {
          ...document.metadata,
          mediaId: document.id,
          mediaRef: JSON.stringify(reference),
          ...(document.source ? { source: document.source } : {}),
        };
        const chunks: VectorDocument[] = [];
        if (want.pages) {
          const { pages } = await options.media.read({ media: document.media });
          for (const page of pages) {
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
          caption = (await options.media.describe({ media: document.media })).caption;
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
        if (chunks.length) await options.vectors.add(chunks);
        report.ids[document.id] = chunks.map((chunk) => chunk.id);
        report.media += 1;
      }
      return report;
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
