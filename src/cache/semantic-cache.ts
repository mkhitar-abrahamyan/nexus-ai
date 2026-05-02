import type { CompletionRequest } from '../types/messages.js';
import type { NexusResponse } from '../types/response.js';
import { createHashEmbeddings, cosineSimilarity, type EmbeddingProvider } from '../hallucination/retrieval.js';

export interface SemanticCacheOptions {
  enabled?: boolean;
  similarityThreshold?: number;
  maxEntries?: number;
  ttlSeconds?: number;
  embed?: EmbeddingProvider;
}

interface SemanticCacheEntry {
  key: string;
  text: string;
  embedding: number[];
  response: NexusResponse;
  expiresAt: number;
}

export class SemanticCache {
  private entries: SemanticCacheEntry[] = [];
  private embed: EmbeddingProvider;

  constructor(private options: SemanticCacheOptions = {}) {
    this.embed = options.embed || createHashEmbeddings;
  }

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
