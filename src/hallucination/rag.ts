import type { CompletionRequest, Message } from '../types/messages.js';

/** A passage of retrieved context. */
export interface RagChunk {
  /** Id the model cites it by. */
  id: string;
  /** The passage text. */
  content: string;
  /** Where it came from, shown to the model. */
  source?: string;
  /** Retrieval score. */
  score?: number;
  /** Application data, recorded in request metadata. */
  metadata?: Record<string, unknown>;
}

/** Options for `withRagContext()`. */
export interface RagOptions {
  /** The passages to answer from. */
  chunks: RagChunk[];
  /** Asks the model to cite chunk ids in square brackets. Defaults to true. */
  requireCitations?: boolean;
  /** How citations are written. */
  citationStyle?: 'bracket' | 'source';
  /**
   * What the model should answer when the context is not enough. Defaults to `I don't know based on
   * the provided context.`
   */
  unknownAnswer?: string;
  /** Most chunks included. Defaults to all of them. */
  maxChunks?: number;
}

/**
 * Adds retrieved passages as a system message, telling the model to answer only from them and cite
 * them. Temperature and top-p default low.
 */
export function withRagContext(request: CompletionRequest, options: RagOptions): CompletionRequest {
  const chunks = options.chunks.slice(0, options.maxChunks || options.chunks.length);
  const unknownAnswer = options.unknownAnswer || "I don't know based on the provided context.";
  const citationInstruction =
    options.requireCitations !== false
      ? 'Cite sources for factual claims using the chunk ids in square brackets, for example [doc-1].'
      : 'Use only the provided context for factual claims.';

  const context = chunks
    .map((chunk, index) => {
      const id = chunk.id || `chunk-${index + 1}`;
      const source = chunk.source ? ` source=${chunk.source}` : '';
      return `[${id}${source}]\n${chunk.content}`;
    })
    .join('\n\n');

  const systemMessage: Message = {
    role: 'system',
    content: [
      'You are answering with Retrieval-Augmented Generation context.',
      'Use only the provided context for factual claims.',
      `If the answer is not present in the context, say: "${unknownAnswer}"`,
      citationInstruction,
      'Do not invent sources, citations, facts, numbers, names, URLs, dates, or APIs.',
      'Context:',
      context || '[no context provided]',
    ].join('\n'),
  };

  return {
    ...request,
    temperature: request.temperature ?? 0,
    topP: request.topP ?? 0.1,
    messages: [systemMessage, ...request.messages],
    metadata: {
      ...request.metadata,
      rag: {
        chunks: chunks.map(({ id, source, score, metadata }) => ({ id, source, score, metadata })),
        requireCitations: options.requireCitations !== false,
      },
    },
  };
}

/** Every distinct bracketed citation in a text. */
export function extractCitations(text: string): string[] {
  return [...new Set([...text.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]))];
}

/** Checks that every bracketed citation in a response names a known chunk. */
export function validateCitations(responseText: string, chunks: RagChunk[]): { ok: boolean; missing: string[] } {
  const known = new Set(chunks.map((chunk) => chunk.id));
  const citations = extractCitations(responseText);
  const missing = citations.filter((citation) => !known.has(citation));
  return { ok: missing.length === 0, missing };
}
