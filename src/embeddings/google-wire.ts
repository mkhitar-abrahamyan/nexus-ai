/**
 * Google's embedding wire format, shared by the synchronous adapter and the batch tier: task types,
 * the text prefixes gemini-embedding-2 reads instead, and parts.
 */
import type { EmbeddingInputType, EmbeddingProviderPart } from '../types/embeddings.js';
import { EmbeddingValidationError } from './errors.js';

/** Google's task type for each input type, on the models that take one. */
export const GOOGLE_TASK_TYPES: Record<EmbeddingInputType, string> = {
  document: 'RETRIEVAL_DOCUMENT',
  query: 'RETRIEVAL_QUERY',
  classification: 'CLASSIFICATION',
  clustering: 'CLUSTERING',
};

/** Whether a model reads its task from a text prefix rather than a task type, as gemini-embedding-2 does. */
export function usesTaskPrefix(model: string): boolean {
  return /^(models\/)?gemini-embedding-2/.test(model);
}

/** The text prefix gemini-embedding-2 reads its task from, by input type. */
const GOOGLE_TASK_PREFIXES: Record<EmbeddingInputType, (text: string) => string> = {
  query: (text) => `task: search result | query: ${text}`,
  document: (text) => `title: none | text: ${text}`,
  classification: (text) => `task: classification | query: ${text}`,
  clustering: (text) => `task: clustering | query: ${text}`,
};

/**
 * An input's parts as Google's: text as text, the first carrying the task prefix when one is given,
 * and media inline, or by a Files API URI. Google does not fetch any other URL.
 */
export function googleParts(parts: readonly EmbeddingProviderPart[], prefixFor: EmbeddingInputType | undefined) {
  let prefixed = prefixFor === undefined;
  return parts.map((part) => {
    if (part.type === 'text') {
      if (prefixed) return { text: part.text };
      prefixed = true;
      return { text: GOOGLE_TASK_PREFIXES[prefixFor as EmbeddingInputType](part.text) };
    }
    if (part.data !== undefined) return { inlineData: { mimeType: part.mimeType, data: part.data } };
    if (part.url?.startsWith('https://generativelanguage.googleapis.com/')) {
      return { fileData: { mimeType: part.mimeType, fileUri: part.url } };
    }
    throw new EmbeddingValidationError(
      `Google embeds media from its bytes or a Files API URI, not from ${part.url}; pass the ${part.type} as bytes`,
    );
  });
}
