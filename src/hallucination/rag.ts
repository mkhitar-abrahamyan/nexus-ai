import type { CompletionRequest, Message } from '../types/messages.js';

export interface RagChunk {
  id: string;
  content: string;
  source?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface RagOptions {
  chunks: RagChunk[];
  requireCitations?: boolean;
  citationStyle?: 'bracket' | 'source';
  unknownAnswer?: string;
  maxChunks?: number;
}

export function withRagContext(request: CompletionRequest, options: RagOptions): CompletionRequest {
  const chunks = options.chunks.slice(0, options.maxChunks || options.chunks.length);
  const unknownAnswer = options.unknownAnswer || "I don't know based on the provided context.";
  const citationInstruction = options.requireCitations !== false
    ? 'Cite sources for factual claims using the chunk ids in square brackets, for example [doc-1].'
    : 'Use only the provided context for factual claims.';

  const context = chunks.map((chunk, index) => {
    const id = chunk.id || `chunk-${index + 1}`;
    const source = chunk.source ? ` source=${chunk.source}` : '';
    return `[${id}${source}]\n${chunk.content}`;
  }).join('\n\n');

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

export function extractCitations(text: string): string[] {
  return [...new Set([...text.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]))];
}

export function validateCitations(responseText: string, chunks: RagChunk[]): { ok: boolean; missing: string[] } {
  const known = new Set(chunks.map((chunk) => chunk.id));
  const citations = extractCitations(responseText);
  const missing = citations.filter((citation) => !known.has(citation));
  return { ok: missing.length === 0, missing };
}
