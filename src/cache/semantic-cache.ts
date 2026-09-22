import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import { createHashEmbeddings, cosineSimilarity, type EmbeddingProvider } from '../hallucination/retrieval.js';

/** Options for the semantic response cache. */
export interface SemanticCacheOptions {
  /** Turns it on. Off by default, and then every lookup misses. */
  enabled?: boolean;
  /** Cosine similarity at which a cached answer is reused, from 0 to 1. Defaults to 0.88. */
  similarityThreshold?: number;
  /** Entries kept before the oldest is dropped. Defaults to 500. */
  maxEntries?: number;
  /** Lifetime of an entry, in seconds. Defaults to 5 minutes. */
  ttlSeconds?: number;
  /** Embeds requests. Defaults to hashed term vectors, which need no provider. */
  embed?: EmbeddingProvider;
}

interface SemanticCacheEntry {
  key: string;
  text: string;
  embedding: number[];
  response: NexusResponse;
  expiresAt: number;
}

/**
 * Reuses a cached response for a request that means nearly the same as an earlier one, not only one
 * that is identical.
 */
export class SemanticCache {
  private entries: SemanticCacheEntry[] = [];
  private embed: EmbeddingProvider;

  constructor(private options: SemanticCacheOptions = {}) {
    this.embed = options.embed || createHashEmbeddings;
  }

  /**
   * The cached response for the most similar earlier request above the threshold, or `undefined`.
   */
  async get(request: CompletionRequest): Promise<NexusResponse | undefined> {
    if (!this.options.enabled) return undefined;
    const text = requestToSearchText(request);
    const [embedding] = await this.embed([text]);
    const threshold = this.options.similarityThreshold ?? 0.88;
    const now = Date.now();
    let best: { entry: SemanticCacheEntry; score: number } | undefined;

    this.entries = this.entries.filter((entry) => entry.expiresAt > now);

    for (const entry of this.entries) {
      const score = cosineSimilarity(embedding, entry.embedding);
      if (score >= threshold && (!best || score > best.score)) {
        best = { entry, score };
      }
    }

    if (!best) return undefined;
    return {
      ...best.entry.response,
      meta: {
        ...best.entry.response.meta,
        cacheHit: true,
        semanticCache: {
          hit: true,
          score: best.score,
          key: best.entry.key,
        },
      },
    };
  }

  /** Caches a response under its request's embedding. */
  async set(key: string, request: CompletionRequest, response: NexusResponse): Promise<void> {
    if (!this.options.enabled) return;
    const text = requestToSearchText(request);
    const [embedding] = await this.embed([text]);
    const maxEntries = this.options.maxEntries || 500;
    if (this.entries.length >= maxEntries) this.entries.shift();

    this.entries.push({
      key,
      text,
      embedding,
      response,
      expiresAt: Date.now() + (this.options.ttlSeconds || 300) * 1000,
    });
  }

  /** Removes every entry. */
  clear(): void {
    this.entries = [];
  }
}

function requestToSearchText(request: CompletionRequest): string {
  return request.messages
    .map((message) => {
      if (typeof message.content === 'string') return `${message.role}: ${message.content}`;
      return `${message.role}: ${message.content
        .filter((part) => part.type === 'text')
        .map((part) => (part as { type: 'text'; text: string }).text)
        .join('\n')}`;
    })
    .join('\n');
}
