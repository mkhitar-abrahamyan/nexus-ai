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
}

/**
 * Chunks and their vectors in process memory, searched by cosine similarity. Defaults to hashed
 * term vectors, which need no provider.
 */
export class MemoryVectorStore {
  private documents: Array<VectorDocument & { embedding: number[] }> = [];
  private embed: EmbeddingProvider;

  constructor(embed: EmbeddingProvider = createHashEmbeddings) {
    this.embed = embed;
  }

  /** Adds chunks, embedding those without a vector in one batch. */
  async add(documents: VectorDocument[]): Promise<void> {
    const missing = documents.filter((doc) => !doc.embedding).map((doc) => doc.content);
    const generated = missing.length ? await this.embed(missing) : [];
    let generatedIndex = 0;

    for (const doc of documents) {
      const embedding = doc.embedding || generated[generatedIndex++];
      this.documents.push({ ...doc, embedding: normalizeVector(embedding) });
    }
  }

  /** The chunks most similar to a query, best first. */
  async search(query: string, options: VectorSearchOptions = {}): Promise<VectorSearchResult[]> {
    const topK = options.topK || 5;
    const minScore = options.minScore ?? 0;
    const [queryEmbedding] = await this.embed([query]);
    const normalizedQuery = normalizeVector(queryEmbedding);

    return this.documents
      .map(({ embedding, ...doc }) => ({
        ...doc,
        score: cosineSimilarity(normalizedQuery, embedding),
      }))
      .filter((doc) => doc.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  /** Removes every chunk. */
  clear(): void {
    this.documents = [];
  }

  /** Chunks held. */
  size(): number {
    return this.documents.length;
  }
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
