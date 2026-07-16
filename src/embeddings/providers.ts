import type { EmbeddingProvider } from '../hallucination/retrieval.js';

export interface OpenAIEmbeddingOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export interface GeminiEmbeddingOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}

export interface CohereEmbeddingOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  inputType?: 'search_document' | 'search_query' | 'classification' | 'clustering';
}

export function createOpenAIEmbeddingProvider(options: OpenAIEmbeddingOptions): EmbeddingProvider {
  return async (texts) => {
    const response = await fetch(`${(options.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model || 'text-embedding-3-small',
        input: texts,
      }),
    });
    if (!response.ok) throw new Error(`OpenAI embeddings failed: ${response.status} ${await response.text()}`);
    const result = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return result.data.map((item) => item.embedding);
  };
}

export function createGeminiEmbeddingProvider(options: GeminiEmbeddingOptions): EmbeddingProvider {
  return async (texts) => {
    const model = options.model || 'text-embedding-004';
    const baseUrl = (options.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
    const response = await fetch(
      `${baseUrl}/models/${encodeURIComponent(model)}:batchEmbedContents?key=${encodeURIComponent(options.apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
          })),
        }),
      },
    );
    if (!response.ok) throw new Error(`Gemini embeddings failed: ${response.status} ${await response.text()}`);
    const result = (await response.json()) as { embeddings: Array<{ values: number[] }> };
    return result.embeddings.map((item) => item.values);
  };
}

export function createCohereEmbeddingProvider(options: CohereEmbeddingOptions): EmbeddingProvider {
  return async (texts) => {
    const response = await fetch(`${(options.baseUrl || 'https://api.cohere.com/v2').replace(/\/$/, '')}/embed`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model || 'embed-v4.0',
        texts,
        input_type: options.inputType || 'search_document',
        embedding_types: ['float'],
      }),
    });
    if (!response.ok) throw new Error(`Cohere embeddings failed: ${response.status} ${await response.text()}`);
    const result = (await response.json()) as { embeddings: { float: number[][] } | number[][] };
    return Array.isArray(result.embeddings) ? result.embeddings : result.embeddings.float;
  };
}
