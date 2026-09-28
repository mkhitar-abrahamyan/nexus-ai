import type { RagChunk } from './rag.js';

/** Turns texts into vectors, one per text, in order. */
export type EmbeddingProvider = (texts: string[]) => Promise<number[][]> | number[][];

/** A chunk to store, with its vector when already computed. */
export interface VectorDocument extends RagChunk {
  /** Its vector. Computed with the store's embedding function when omitted. */
  embedding?: number[];
}

/** A stored chunk returned by a search. */
export interface VectorSearchResult extends RagChunk {
  /** Cosine similarity to the query, from -1 to 1. */
  score: number;
}

/** Options for a vector search. */
export interface VectorSearchOptions {
  /** Most results returned. Defaults to 5. */
  topK?: number;
  /** Lowest similarity returned. Defaults to 0. */
  minScore?: number;
  /**
   * Exact matches on top-level `metadata` fields, such as `{ tenant: 'acme' }`. Every field must
   * match. Values are strings, numbers, or booleans, which every adapter can filter on natively.
   */
  filter?: Record<string, string | number | boolean>;
}

/**
 * Where retrieval chunks live and how they are searched. `MemoryVectorStore`, `PostgresVectorStore`,
 * and `QdrantVectorStore` implement it, and pass the same contract tests.
 *
 * Adding a chunk whose id already exists replaces it, so re-ingesting a document never duplicates
 * its passages.
 */
export interface VectorStore {
  /** Adds chunks, or replaces the ones whose id already exists, embedding those without a vector. */
  add(documents: VectorDocument[]): Promise<void>;
  /** The chunks most similar to a query text, best first. */
  search(query: string, options?: VectorSearchOptions): Promise<VectorSearchResult[]>;
  /** The chunks most similar to a vector computed elsewhere, best first. */
  searchVector(vector: number[], options?: VectorSearchOptions): Promise<VectorSearchResult[]>;
  /** Removes chunks by id. An id that is not stored is ignored. */
  delete(ids: readonly string[]): Promise<void>;
}

/**
 * Chunks and their vectors in process memory, searched by cosine similarity. Defaults to hashed
 * term vectors, which need no provider.
 */
export class MemoryVectorStore implements VectorStore {
  private documents = new Map<string, VectorDocument & { embedding: number[] }>();
  private embed: EmbeddingProvider;

  constructor(embed: EmbeddingProvider = createHashEmbeddings) {
    this.embed = embed;
  }

  /** Adds chunks, or replaces those whose id exists, embedding those without a vector in one batch. */
  async add(documents: VectorDocument[]): Promise<void> {
    const missing = documents.filter((doc) => !doc.embedding).map((doc) => doc.content);
    const generated = missing.length ? await this.embed(missing) : [];
    let generatedIndex = 0;

    for (const doc of documents) {
      const embedding = doc.embedding || generated[generatedIndex++];
      this.documents.set(doc.id, { ...doc, embedding: normalizeVector(embedding) });
    }
  }

  /** The chunks most similar to a query, best first. */
  async search(query: string, options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const [queryEmbedding] = await this.embed([query]);
    return this.searchVector(queryEmbedding, options);
  }

  /** The chunks most similar to a vector, best first. */
  async searchVector(vector: number[], options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const topK = options.topK || 5;
    const minScore = options.minScore ?? 0;
    const normalizedQuery = normalizeVector(vector);
    const results: VectorSearchResult[] = [];

    for (const { embedding, ...doc } of this.documents.values()) {
      if (!matchesMetadata(doc.metadata, options.filter)) continue;
      const score = cosineSimilarity(normalizedQuery, embedding);
      if (score >= minScore) results.push({ ...doc, score });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /** Removes chunks by id. */
  async delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.documents.delete(id);
  }

  /** Removes every chunk. */
  clear(): void {
    this.documents.clear();
  }

  /** Chunks held. */
  size(): number {
    return this.documents.size;
  }
}

/** Whether a chunk's metadata satisfies an exact-match filter. Every adapter filters the same way. */
export function matchesMetadata(
  metadata: Record<string, unknown> | undefined,
  filter: VectorSearchOptions['filter'],
): boolean {
  if (!filter) return true;
  for (const [key, expected] of Object.entries(filter)) {
    if (metadata?.[key] !== expected) return false;
  }
  return true;
}

/**
 * Hashed term-count vectors, normalized to unit length. Deterministic and free, for tests and a
 * store without a provider.
 */
export function createHashEmbeddings(texts: string[], dimensions = 384): number[][] {
  return texts.map((text) => {
    const vector = new Array<number>(dimensions).fill(0);
    const terms = text.toLowerCase().match(/[a-z0-9_'-]{2,}/g) || [];

    for (const term of terms) {
      const index = hashTerm(term) % dimensions;
      vector[index] += 1;
    }

    return normalizeVector(vector);
  });
}

/** Cosine similarity of two unit-length vectors, as their dot product. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;

  let dot = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
  }
  return dot;
}

/** Scales a vector to unit length, so a dot product is its cosine similarity. A zero vector stays zero. */
export function normalizeVector(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector.map(() => 0);
  return vector.map((value) => value / magnitude);
}

function hashTerm(term: string): number {
  let hash = 2166136261;
  for (let i = 0; i < term.length; i += 1) {
    hash ^= term.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
