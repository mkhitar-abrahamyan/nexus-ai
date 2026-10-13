/**
 * The embedding cache contract, as assertions any `EmbeddingCacheStore` must pass. The unit tests run
 * it against every store; the live suite runs it against a real Redis.
 */
import assert from 'node:assert/strict';
import type { EmbeddingCacheStore } from '../src/types/embeddings.js';

/** A vector already at float32 precision, so it reads back exactly. */
export const vector = (seed: number, size = 8) =>
  Array.from({ length: size }, (_, index) => Math.fround((seed + index) / 7));

/** What every store promises: misses are undefined, order is kept, and a write is read back. */
export async function cacheContract(name: string, store: EmbeddingCacheStore): Promise<void> {
  assert.deepEqual(await store.getMany([]), [], `${name}: an empty read`);
  await store.setMany([]);
  assert.deepEqual(await store.getMany(['a', 'b']), [undefined, undefined], `${name}: misses`);
  await store.setMany([
    { key: 'a', vector: vector(1) },
    { key: 'b', vector: vector(2) },
  ]);
  assert.deepEqual(await store.getMany(['b', 'missing', 'a', 'b']), [vector(2), undefined, vector(1), vector(2)], name);
  await store.setMany([{ key: 'a', vector: vector(3) }], 3600);
  assert.deepEqual(await store.getMany(['a']), [vector(3)], `${name}: a write replaces`);
  const many = Array.from({ length: 1_200 }, (_, index) => ({ key: `k${index}`, vector: vector(index, 4) }));
  await store.setMany(many, 3600);
  const read = await store.getMany(many.map((entry) => entry.key));
  assert.deepEqual(
    read,
    many.map((entry) => entry.vector),
    `${name}: a batch past one statement's keys`,
  );
}
