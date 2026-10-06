import type { RagChunk } from '../hallucination/rag.js';
import {
  cosineSimilarity,
  type EmbeddingProvider,
  matchesMetadata,
  normalizeVector,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorStore,
} from '../hallucination/retrieval.js';
import type { CompletionRequest } from '../types/messages.js';
import { type DocumentSource, type IngestionOptions, ingestDocuments } from './ingestion.js';

/** What one retrieval asks for. */
export interface RetrieveOptions {
  /** Most results returned. Defaults to the retriever's own `topK`, or 5. */
  topK?: number;
  /** Exact matches on top-level metadata fields, passed down to every store searched. */
  filter?: VectorSearchOptions['filter'];
  /** Cancels the retrieval, including model calls a reranker or query generator makes. */
  signal?: AbortSignal;
}

/**
 * Anything that answers a query with ranked chunks. Every retriever here takes others and returns
 * one, so hybrid search, reranking, diversity, and parent lookup compose in any order over any store.
 */
export interface Retriever {
  /** The chunks that best answer a query, best first. */
  retrieve(query: string, options?: RetrieveOptions): Promise<VectorSearchResult[]>;
}

/**
 * Keyword search that holds its own chunks: an in-memory BM25 `KeywordIndex`, Postgres full-text
 * search, a search engine. It is a `Retriever`, so `hybridRetriever()` fuses it with vector search,
 * and it takes writes, so ingestion keeps it in step with a vector store.
 */
export interface SparseRetriever extends Retriever {
  /** Adds chunks, or replaces those whose id exists. */
  add(chunks: readonly RagChunk[]): Promise<void> | void;
  /** Removes chunks by id. An id that is not held is ignored. */
  delete(ids: readonly string[]): Promise<void> | void;
}

/** A client that runs one completion — a `NexusAI` instance, or anything with the same `complete()`. */
export interface RetrievalModelClient {
  /** Runs one completion and returns its text. */
  complete(request: CompletionRequest): Promise<{ content: string }>;
}

/** A vector store as a retriever, with defaults for every search. */
export function vectorRetriever(store: VectorStore, defaults: VectorSearchOptions = {}): Retriever {
  return {
    retrieve: (query, options = {}) =>
      store.search(query, {
        ...defaults,
        topK: options.topK ?? defaults.topK ?? 5,
        ...(options.filter || defaults.filter ? { filter: { ...defaults.filter, ...options.filter } } : {}),
      }),
  };
}

/** Options for a `KeywordIndex`. */
export interface KeywordIndexOptions {
  /** BM25 term-frequency saturation. Defaults to 1.2. */
  k1?: number;
  /** BM25 length normalization, from 0 to 1. Defaults to 0.75. */
  b?: number;
  /** Splits text into terms. Defaults to `tokenize()`. */
  tokenize?: (text: string) => string[];
}

/**
 * Lower-cased runs of letters and digits, in any script. Keeps identifiers such as `ERR-4012` findable
 * as `err` and `4012`, which is where keyword search beats vectors.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Keyword search with BM25 over chunks held in memory. Vector search misses exact terms — product
 * codes, error numbers, names — that keyword search finds; `hybridRetriever()` fuses the two.
 * Adding a chunk whose id exists replaces it, as in a vector store.
 */
export class KeywordIndex implements SparseRetriever {
  private readonly chunks = new Map<string, { chunk: RagChunk; terms: Map<string, number>; length: number }>();
  private readonly postings = new Map<string, Set<string>>();
  private totalLength = 0;
  private readonly k1: number;
  private readonly b: number;
  private readonly split: (text: string) => string[];

  constructor(options: KeywordIndexOptions = {}) {
    this.k1 = options.k1 ?? 1.2;
    this.b = options.b ?? 0.75;
    this.split = options.tokenize ?? tokenize;
  }

  /** Adds chunks, or replaces those whose id exists. */
  add(chunks: readonly RagChunk[]): void {
    for (const chunk of chunks) {
      this.remove(chunk.id);
      const terms = new Map<string, number>();
      const tokens = this.split(chunk.content);
      for (const term of tokens) terms.set(term, (terms.get(term) ?? 0) + 1);
      for (const term of terms.keys()) {
        const ids = this.postings.get(term);
        if (ids) ids.add(chunk.id);
        else this.postings.set(term, new Set([chunk.id]));
      }
      this.chunks.set(chunk.id, { chunk, terms, length: tokens.length });
      this.totalLength += tokens.length;
    }
  }

  /** Removes chunks by id. An id that is not held is ignored. */
  delete(ids: readonly string[]): void {
    for (const id of ids) this.remove(id);
  }

  /** Chunks held. */
  size(): number {
    return this.chunks.size;
  }

  /** The chunks that best match a query's terms, best first, scored by BM25. */
  async retrieve(query: string, options: RetrieveOptions = {}): Promise<VectorSearchResult[]> {
    const count = this.chunks.size;
    if (count === 0) return [];
    const averageLength = this.totalLength / count || 1;
    const scores = new Map<string, number>();
    for (const term of new Set(this.split(query))) {
      const ids = this.postings.get(term);
      if (!ids) continue;
      const idf = Math.log(1 + (count - ids.size + 0.5) / (ids.size + 0.5));
      for (const id of ids) {
        const entry = this.chunks.get(id);
        if (!entry) continue;
        const frequency = entry.terms.get(term) ?? 0;
        const weight =
          (frequency * (this.k1 + 1)) / (frequency + this.k1 * (1 - this.b + (this.b * entry.length) / averageLength));
        scores.set(id, (scores.get(id) ?? 0) + idf * weight);
      }
    }
    const results: VectorSearchResult[] = [];
    for (const [id, score] of scores) {
      const { chunk } = this.chunks.get(id) as { chunk: RagChunk };
      if (matchesMetadata(chunk.metadata, options.filter)) results.push({ ...chunk, score });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, options.topK ?? 5);
  }

  private remove(id: string): void {
    const existing = this.chunks.get(id);
    if (!existing) return;
    for (const term of existing.terms.keys()) {
      const ids = this.postings.get(term);
      ids?.delete(id);
      if (ids?.size === 0) this.postings.delete(term);
    }
    this.totalLength -= existing.length;
    this.chunks.delete(id);
  }
}

/** Options for `reciprocalRankFusion()`. */
export interface FusionOptions {
  /** Damps the weight of top ranks; higher values flatten the fusion. Defaults to 60, the usual choice. */
  k?: number;
  /** A weight per ranking, in order. Defaults to 1 each. */
  weights?: readonly number[];
  /** Most results returned. Defaults to every chunk that appears in any ranking. */
  topK?: number;
}

/**
 * Fuses rankings by reciprocal rank: each chunk scores the sum, over the rankings it appears in, of
 * `weight / (k + rank)`. Uses ranks, not scores, so rankings on different scales — BM25 and cosine —
 * combine without normalization. The result's `score` is the fused score.
 */
export function reciprocalRankFusion(
  rankings: readonly (readonly VectorSearchResult[])[],
  options: FusionOptions = {},
): VectorSearchResult[] {
  const k = options.k ?? 60;
  const fused = new Map<string, VectorSearchResult>();
  for (const [list, ranking] of rankings.entries()) {
    const weight = options.weights?.[list] ?? 1;
    for (const [rank, result] of ranking.entries()) {
      const contribution = weight / (k + rank + 1);
      const existing = fused.get(result.id);
      if (existing) existing.score += contribution;
      else fused.set(result.id, { ...result, score: contribution });
    }
  }
  const ranked = [...fused.values()].sort((a, b) => b.score - a.score);
  return options.topK === undefined ? ranked : ranked.slice(0, options.topK);
}

/** Options for `hybridRetriever()` and `multiQueryRetriever()`. */
export interface FusedRetrieverOptions extends Omit<FusionOptions, 'topK'> {
  /** Results returned. Defaults to 5. */
  topK?: number;
  /** Results asked of each retriever before fusing. Defaults to four times `topK`. */
  candidates?: number;
}

/**
 * Several retrievers at once — typically a vector store and a `KeywordIndex` over the same chunks —
 * fused by reciprocal rank. The retrievers run in parallel.
 */
export function hybridRetriever(retrievers: readonly Retriever[], options: FusedRetrieverOptions = {}): Retriever {
  if (retrievers.length === 0) throw new RangeError('hybridRetriever needs at least one retriever');
  return {
    async retrieve(query, retrieveOptions = {}) {
      const topK = retrieveOptions.topK ?? options.topK ?? 5;
      const candidates = options.candidates ?? topK * 4;
      const rankings = await Promise.all(
        retrievers.map((retriever) => retriever.retrieve(query, { ...retrieveOptions, topK: candidates })),
      );
      return reciprocalRankFusion(rankings, { ...options, topK });
    },
  };
}

/**
 * Scores each chunk's relevance to a query, higher meaning more relevant, one number per chunk in
 * order. A cross-encoder, a hosted rerank API, or `modelReranker()` over a chat model.
 */
export type Reranker = (
  query: string,
  chunks: readonly VectorSearchResult[],
  signal?: AbortSignal,
) => Promise<readonly number[]> | readonly number[];

/** Options for `rerankRetriever()`. */
export interface RerankRetrieverOptions {
  /** Results returned. Defaults to 5. */
  topK?: number;
  /** Results asked of the base retriever and scored. Defaults to 20. */
  candidates?: number;
  /** Drops results the reranker scored below this. */
  minScore?: number;
}

/**
 * A retriever whose results are rescored by a reranker: it asks the base for more candidates than it
 * returns, scores them all against the query, and keeps the best. The result's `score` is the
 * reranker's.
 */
export function rerankRetriever(base: Retriever, reranker: Reranker, options: RerankRetrieverOptions = {}): Retriever {
  return {
    async retrieve(query, retrieveOptions = {}) {
      const topK = retrieveOptions.topK ?? options.topK ?? 5;
      const candidates = await base.retrieve(query, { ...retrieveOptions, topK: options.candidates ?? 20 });
      if (candidates.length === 0) return [];
      const scores = await reranker(query, candidates, retrieveOptions.signal);
      if (scores.length !== candidates.length) {
        throw new RangeError(`The reranker returned ${scores.length} scores for ${candidates.length} chunks`);
      }
      return candidates
        .map((chunk, index) => ({ ...chunk, score: scores[index] }))
        .filter((chunk) => options.minScore === undefined || chunk.score >= options.minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
    },
  };
}

/** Options for `modelReranker()`. */
export interface ModelRerankerOptions {
  /** The model that judges relevance. */
  model: string;
  /** Characters of each chunk shown to the model. Defaults to 1,000. */
  maxChunkCharacters?: number;
}

/**
 * A reranker that asks a chat model to score each chunk from 0 to 10 for how well it answers the
 * query, in one call. Slower and costlier than a cross-encoder, but needs nothing beyond the model you
 * already use. A reply that cannot be read scores every chunk 0 rather than failing the retrieval.
 */
export function modelReranker(client: RetrievalModelClient, options: ModelRerankerOptions): Reranker {
  const limit = options.maxChunkCharacters ?? 1000;
  return async (query, chunks, signal) => {
    signal?.throwIfAborted();
    const passages = chunks.map((chunk, index) => `[${index}] ${chunk.content.slice(0, limit)}`).join('\n\n');
    const response = await client.complete({
      model: options.model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You rate how well passages answer a question. Reply with only a JSON array of numbers from 0 to 10, one per passage, in order.',
        },
        { role: 'user', content: `Question: ${query}\n\nPassages:\n${passages}` },
      ],
      ...(signal ? { signal } : {}),
    });
    const parsed = readNumbers(response.content, chunks.length);
    return parsed ?? chunks.map(() => 0);
  };
}

/** Options for `maximalMarginalRelevance()`. */
export interface MmrOptions {
  /** Trades relevance against diversity: 1 is pure relevance, 0 pure diversity. Defaults to 0.5. */
  lambda?: number;
  /** Candidates picked. Defaults to 5. */
  topK?: number;
}

/**
 * Picks candidates by maximal marginal relevance: each pick maximizes its similarity to the query
 * minus its similarity to what was already picked, so near-duplicates stop crowding out other
 * evidence. Returns the picked candidates' indexes, in pick order.
 */
export function maximalMarginalRelevance(
  query: readonly number[],
  candidates: readonly (readonly number[])[],
  options: MmrOptions = {},
): number[] {
  const lambda = options.lambda ?? 0.5;
  const topK = Math.min(options.topK ?? 5, candidates.length);
  const normalizedQuery = normalizeVector([...query]);
  const vectors = candidates.map((candidate) => normalizeVector([...candidate]));
  const relevance = vectors.map((vector) => cosineSimilarity(normalizedQuery, vector));
  const picked: number[] = [];
  const closest = vectors.map(() => Number.NEGATIVE_INFINITY);

  while (picked.length < topK) {
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < vectors.length; index++) {
      if (picked.includes(index)) continue;
      const redundancy = picked.length === 0 ? 0 : closest[index];
      const score = lambda * relevance[index] - (1 - lambda) * redundancy;
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
    picked.push(best);
    for (let index = 0; index < vectors.length; index++) {
      closest[index] = Math.max(closest[index], cosineSimilarity(vectors[index], vectors[best]));
    }
  }
  return picked;
}

/** Options for `mmrRetriever()`. */
export interface MmrRetrieverOptions extends MmrOptions {
  /** Embeds the query and the candidates, in one call. Use the embedding function the store uses. */
  embed: EmbeddingProvider;
  /** Results asked of the base retriever before picking. Defaults to 20. */
  candidates?: number;
}

/**
 * A retriever that diversifies its base's results by maximal marginal relevance. The query and the
 * candidates are embedded together in one call; the results keep the base's scores.
 */
export function mmrRetriever(base: Retriever, options: MmrRetrieverOptions): Retriever {
  return {
    async retrieve(query, retrieveOptions = {}) {
      const topK = retrieveOptions.topK ?? options.topK ?? 5;
      const candidates = await base.retrieve(query, { ...retrieveOptions, topK: options.candidates ?? 20 });
      if (candidates.length <= 1) return candidates.slice(0, topK);
      const [queryVector, ...vectors] = await options.embed([query, ...candidates.map((chunk) => chunk.content)]);
      return maximalMarginalRelevance(queryVector, vectors, { ...options, topK }).map((index) => candidates[index]);
    },
  };
}

/** Finds parent chunks by id: a map, or a function that fetches them, such as from your database. */
export type ParentLookup =
  | ReadonlyMap<string, RagChunk>
  | ((ids: readonly string[]) => Promise<readonly RagChunk[]> | readonly RagChunk[]);

/** Options for `parentDocumentRetriever()`. */
export interface ParentDocumentRetrieverOptions {
  /** Where parents are found. */
  parents: ParentLookup;
  /**
   * The child's metadata field naming its parent. Defaults to `documentId`, which ingestion sets on
   * every chunk and `splitParentChild()` points at the parent.
   */
  parentKey?: string;
  /** Results returned. Defaults to 5. */
  topK?: number;
  /** Children asked of the base retriever. Defaults to 20. */
  candidates?: number;
}

/**
 * Searches small chunks, which match a query precisely, and returns the larger parents they came
 * from, which give the model enough context to answer. Parents come back in the order of their best
 * child, each once, scored by that child. A child whose parent is not found is returned as it is.
 */
export function parentDocumentRetriever(base: Retriever, options: ParentDocumentRetrieverOptions): Retriever {
  const key = options.parentKey ?? 'documentId';
  return {
    async retrieve(query, retrieveOptions = {}) {
      const topK = retrieveOptions.topK ?? options.topK ?? 5;
      const children = await base.retrieve(query, { ...retrieveOptions, topK: options.candidates ?? 20 });
      const order: Array<{ parentId?: string; child: VectorSearchResult }> = [];
      const seen = new Set<string>();
      for (const child of children) {
        const parentId = child.metadata?.[key];
        if (typeof parentId !== 'string') order.push({ child });
        else if (!seen.has(parentId)) {
          seen.add(parentId);
          order.push({ parentId, child });
        }
      }
      const wanted = order
        .slice(0, topK)
        .map((entry) => entry.parentId)
        .filter((id): id is string => id !== undefined);
      const found = new Map<string, RagChunk>();
      if (typeof options.parents === 'function') {
        for (const parent of await options.parents(wanted)) found.set(parent.id, parent);
      } else {
        for (const id of wanted) {
          const parent = options.parents.get(id);
          if (parent) found.set(id, parent);
        }
      }
      return order.slice(0, topK).map(({ parentId, child }) => {
        const parent = parentId === undefined ? undefined : found.get(parentId);
        return parent ? { ...parent, score: child.score } : child;
      });
    },
  };
}

/** Options for `splitParentChild()`. */
export interface ParentChildOptions {
  /** How documents are split into parents. Defaults to 2,000-character chunks. */
  parent?: IngestionOptions;
  /** How parents are split into children. Defaults to 400-character chunks with 50 of overlap. */
  child?: IngestionOptions;
}

/**
 * Splits documents twice: into parents, kept for `parentDocumentRetriever()` to return, and each
 * parent into small children, added to the store it searches. Every child's `documentId` is its
 * parent's id.
 */
export function splitParentChild(
  documents: readonly DocumentSource[],
  options: ParentChildOptions = {},
): { parents: RagChunk[]; children: RagChunk[] } {
  const parents = ingestDocuments([...documents], { chunkSize: 2000, overlap: 200, ...options.parent }).chunks;
  const children = ingestDocuments(
    parents.map((parent) => ({
      id: parent.id,
      text: parent.content,
      source: parent.source,
      metadata: parent.metadata,
    })),
    { chunkSize: 400, overlap: 50, ...options.child },
  ).chunks;
  return { parents, children };
}

/** Rewrites a query into alternative phrasings, such as `modelQueryVariants()` over a chat model. */
export type QueryVariants = (query: string, signal?: AbortSignal) => Promise<readonly string[]> | readonly string[];

/** Options for `multiQueryRetriever()`. */
export interface MultiQueryRetrieverOptions extends FusedRetrieverOptions {
  /** Searches the original query as well as its variants. On by default. */
  includeOriginal?: boolean;
}

/**
 * Searches several phrasings of a query and fuses the results by reciprocal rank, so a question worded
 * differently from the documents still finds them. The searches run in parallel.
 */
export function multiQueryRetriever(
  base: Retriever,
  variants: QueryVariants,
  options: MultiQueryRetrieverOptions = {},
): Retriever {
  return {
    async retrieve(query, retrieveOptions = {}) {
      const topK = retrieveOptions.topK ?? options.topK ?? 5;
      const generated = await variants(query, retrieveOptions.signal);
      const queries = [...new Set([...(options.includeOriginal === false ? [] : [query]), ...generated])];
      const rankings = await Promise.all(
        queries.map((text) => base.retrieve(text, { ...retrieveOptions, topK: options.candidates ?? topK * 2 })),
      );
      return reciprocalRankFusion(rankings, { ...options, topK });
    },
  };
}

/** Options for `modelQueryVariants()`. */
export interface ModelQueryVariantsOptions {
  /** The model that rewrites queries. */
  model: string;
  /** Variants asked for. Defaults to 3. */
  count?: number;
}

/**
 * Query variants from a chat model, in one call. A reply that cannot be read yields no variants, so
 * the original query is still searched.
 */
export function modelQueryVariants(client: RetrievalModelClient, options: ModelQueryVariantsOptions): QueryVariants {
  const count = options.count ?? 3;
  return async (query, signal) => {
    signal?.throwIfAborted();
    const response = await client.complete({
      model: options.model,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: `Rewrite a search query ${count} different ways that could match documents answering it. Reply with only a JSON array of strings.`,
        },
        { role: 'user', content: query },
      ],
      ...(signal ? { signal } : {}),
    });
    try {
      const parsed = JSON.parse(jsonArrayIn(response.content)) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string').slice(0, count)
        : [];
    } catch {
      return [];
    }
  };
}

function readNumbers(text: string, count: number): number[] | undefined {
  try {
    const parsed = JSON.parse(jsonArrayIn(text)) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== count) return undefined;
    const numbers = parsed.map(Number);
    return numbers.every(Number.isFinite) ? numbers : undefined;
  } catch {
    return undefined;
  }
}

function jsonArrayIn(text: string): string {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}
