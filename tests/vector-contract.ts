/**
 * The `VectorStore` contract, as assertions any store must pass. The unit tests run it against every
 * store with in-memory stand-ins; the live suite runs the same checks against real servers.
 */
import assert from 'node:assert/strict';
import type { EmbeddingProvider, VectorStore } from '../src/hallucination/retrieval.js';

export const passages = [
  {
    id: 'refunds#0',
    content: 'Refunds are issued within fourteen days of a return',
    source: 'policy.md',
    metadata: { tenant: 'acme', page: 3 },
  },
  {
    id: 'shipping#0',
    content: 'Orders ship from the warehouse within two business days',
    source: 'policy.md',
    metadata: { tenant: 'acme' },
  },
  { id: 'refunds#1', content: 'A refund goes back to the original payment method', metadata: { tenant: 'globex' } },
  { id: 'careers#0', content: 'We are hiring engineers in three offices' },
];

/** Waits for writes to become searchable, for a store whose index is eventually consistent. */
export type Settle = () => Promise<void>;

const immediately: Settle = async () => undefined;

/** Ranking, filters, `minScore`, vector search, replacement by id, and deletes. */
export async function vectorStoreContract(
  name: string,
  store: VectorStore,
  embed: EmbeddingProvider,
  settle: Settle = immediately,
): Promise<void> {
  await store.add(passages);
  await settle();

  const refunds = await store.search('how long do refunds take', { topK: 2 });
  assert.equal(refunds[0]?.id, 'refunds#0', `${name}: the closest passage ranks first`);
  assert.equal(refunds.length, 2, `${name}: topK limits the results`);
  assert.ok(refunds[0].score > refunds[1].score, `${name}: best first`);
  assert.equal(refunds[0].source, 'policy.md', `${name}: the source comes back`);
  assert.deepEqual(refunds[0].metadata, { tenant: 'acme', page: 3 }, `${name}: metadata comes back whole`);

  const globex = await store.search('refund', { filter: { tenant: 'globex' } });
  assert.deepEqual(
    globex.map((result) => result.id),
    ['refunds#1'],
    `${name}: a metadata filter narrows the search`,
  );

  const strict = await store.search('how long do refunds take', { minScore: 0.99 });
  assert.equal(strict.length, 0, `${name}: minScore drops weak matches`);

  const [queryVector] = await embed(['orders ship from the warehouse']);
  const byVector = await store.searchVector(queryVector, { topK: 1 });
  assert.equal(byVector[0]?.id, 'shipping#0', `${name}: a precomputed vector searches too`);

  await store.add([
    { id: 'careers#0', content: 'Refunds for event tickets are not available', metadata: { tenant: 'acme' } },
  ]);
  await settle();
  const replaced = await store.search('event tickets refunds', { topK: 10 });
  assert.equal(
    replaced.filter((result) => result.id === 'careers#0').length,
    1,
    `${name}: adding an existing id replaces it rather than duplicating it`,
  );
  assert.match(replaced.find((result) => result.id === 'careers#0')?.content ?? '', /event tickets/);

  await store.delete(['refunds#0', 'not-stored']);
  await settle();
  const afterDelete = await store.search('how long do refunds take', { topK: 10 });
  assert.equal(
    afterDelete.some((result) => result.id === 'refunds#0'),
    false,
    `${name}: a deleted chunk is gone`,
  );
  await store.delete([]);
  await store.add([]);
}

/** A filter matches a value's type as well as the value, and several fields must all match. */
export async function typedFilterContract(
  name: string,
  store: VectorStore,
  settle: Settle = immediately,
): Promise<void> {
  await store.add(passages);
  await settle();
  const numeric = await store.search('refunds', { filter: { page: 3 }, topK: 10 });
  assert.deepEqual(
    numeric.map((result) => result.id),
    ['refunds#0'],
    `${name}: a number filter finds the number`,
  );
  const asText = await store.search('refunds', { filter: { page: '3' }, topK: 10 });
  assert.equal(asText.length, 0, `${name}: the same digits as text do not match a number`);
  const both = await store.search('refunds', { filter: { tenant: 'acme', page: 3 }, topK: 10 });
  assert.deepEqual(
    both.map((result) => result.id),
    ['refunds#0'],
    `${name}: several filter fields must all match`,
  );
}
