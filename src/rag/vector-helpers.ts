import type { EmbeddingProvider, VectorDocument, VectorSearchOptions } from '../hallucination/retrieval.js';

/** Every document's vector, in order, embedding the ones without a vector in one batch. */
export async function vectorsFor(
  documents: readonly VectorDocument[],
  embed: EmbeddingProvider,
  dimensions: number,
): Promise<number[][]> {
  const missing = documents.filter((doc) => !doc.embedding).map((doc) => doc.content);
  const generated = missing.length ? await embed(missing) : [];
  let next = 0;
  return documents.map((doc) => {
    const vector = doc.embedding ?? generated[next++];
    assertWidth(vector, dimensions);
    return vector;
  });
}

/** Refuses a vector whose width does not match the store's, before it reaches the database. */
export function assertWidth(vector: readonly number[] | undefined, dimensions: number): asserts vector is number[] {
  if (!vector || vector.length !== dimensions) {
    throw new RangeError(`A vector has ${vector?.length ?? 0} dimensions; this store was created with ${dimensions}`);
  }
}

/** Checks a store's `dimensions` option. */
export function assertDimensions(dimensions: number): void {
  if (!(Number.isInteger(dimensions) && dimensions > 0)) throw new RangeError('dimensions must be a positive integer');
}

/** The prefix that marks a copied metadata field in stores that filter on flat fields. */
export const META_PREFIX = 'meta_';

/**
 * A chunk's top-level string, number, and boolean metadata, copied under `meta_` names, which is what
 * stores with flat, typed payloads filter on. The whole metadata travels separately as JSON, so
 * nested values still come back.
 */
export function filterFields(metadata: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      fields[`${META_PREFIX}${key}`] = value;
    }
  }
  return fields;
}

/** A search's filter entries, or none when the filter is empty. */
export function filterEntries(filter: VectorSearchOptions['filter']): Array<[string, string | number | boolean]> {
  return Object.entries(filter ?? {});
}

/** Parses metadata stored as JSON, tolerating a missing value. */
export function parseMetadata(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = JSON.parse(value) as Record<string, unknown> | null;
  return parsed ?? undefined;
}

/** A stable UUID for a chunk id, from the first 16 bytes of its SHA-256, shaped as version 5. */
export async function stableUuid(id: string): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(id)));
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** What a JSON-over-HTTP store needs to make one request. */
export interface JsonRequest {
  fetch: typeof globalThis.fetch;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  /** Returned instead of throwing when the server answers 404. */
  notFound?: unknown;
  /** Builds the error thrown for a status that is not 2xx. */
  error: (message: string, status: number, body: string) => Error;
}

/** Sends a JSON request with a timeout and returns the parsed body, or `undefined` when it is empty. */
export async function requestJson(request: JsonRequest): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await request.fetch(request.url, {
      method: request.method,
      headers: { ...(request.body === undefined ? {} : { 'content-type': 'application/json' }), ...request.headers },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      signal: controller.signal,
    });
    if (response.status === 404 && 'notFound' in request) return request.notFound;
    const text = await response.text();
    if (!response.ok) {
      const path = new URL(request.url).pathname;
      throw request.error(`${request.method} ${path} failed with ${response.status}`, response.status, text);
    }
    return text ? JSON.parse(text) : undefined;
  } finally {
    clearTimeout(timer);
  }
}
