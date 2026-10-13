/**
 * What a vector store shows to graduate, beyond its contract: replacements that stay whole when ten
 * writers race on the same ids, a soak with flat memory, and search latency under load. The unit tests
 * run the race against the stand-ins; the live suite runs all three against the real servers.
 *
 * Each check wants a store of its own, empty, that can filter on `writer` and `page`.
 */
import assert from 'node:assert/strict';
import type { VectorStore } from '../src/hallucination/retrieval.js';
import { passages, type Settle } from './vector-contract.js';

const immediately: Settle = async () => undefined;

/**
 * Ten writers replace the same twenty ids at once, each with its own content and metadata, and odd
 * writers with a `page` field the even ones lack. Every id must end as exactly one writer's version:
 * found once, with that writer's content and metadata, and found by that writer's filters only.
 */
export async function concurrentWriters(
  name: string,
  store: VectorStore,
  settle: Settle = immediately,
  { writers = 10, ids = 20 } = {},
): Promise<void> {
  const names = Array.from({ length: ids }, (_, index) => `race#${index}`);
  await Promise.all(
    Array.from({ length: writers }, (_, writer) =>
      store.add(
        names.map((id) => ({
          id,
          content: `race chunk ${id} written by writer ${writer}`,
          metadata: { writer, ...(writer % 2 === 1 ? { page: writer } : {}) },
        })),
      ),
    ),
  );
  await settle();

  const found = await store.search('race chunk written by writer', { topK: ids * writers });
  assert.deepEqual(
    found.map((result) => result.id).sort(),
    [...names].sort(),
    `${name}: every id is stored once, however many writers raced`,
  );
  const winner = new Map<string, number>();
  for (const result of found) {
    const writer = Number(/by writer (\d+)$/.exec(result.content)?.[1]);
    winner.set(result.id, writer);
    assert.deepEqual(
      result.metadata,
      { writer, ...(writer % 2 === 1 ? { page: writer } : {}) },
      `${name}: ${result.id} has the metadata of the writer whose content it has`,
    );
  }
  for (let writer = 0; writer < writers; writer += 1) {
    const expected = names.filter((id) => winner.get(id) === writer).sort();
    const byWriter = await store.search('race chunk', { filter: { writer }, topK: ids });
    assert.deepEqual(byWriter.map((result) => result.id).sort(), expected, `${name}: writer ${writer}'s filter`);
    if (writer % 2 === 1) {
      const byPage = await store.search('race chunk', { filter: { page: writer }, topK: ids });
      assert.deepEqual(
        byPage.map((result) => result.id).sort(),
        expected,
        `${name}: page ${writer} finds only the chunks writer ${writer} won, so no losing field survived`,
      );
    }
  }
}

/** Heap growth over a soak, in megabytes, after a collection at each end. */
export interface SoakResult {
  cycles: number;
  heapGrowthMb: number;
  elapsedMs: number;
}

/**
 * Write, search, and delete cycles over a working set of fifty chunks. Needs `--expose-gc` to measure
 * the heap; without it the growth is reported as zero.
 */
export async function soak(store: VectorStore, cycles = 1_000): Promise<SoakResult> {
  const cycle = async (index: number) => {
    await store.add([
      { id: `soak#${index % 50}`, content: `soak passage ${index} about refunds`, metadata: { page: index } },
    ]);
    await store.search('refunds', { topK: 3 });
    if (index % 50 === 49) await store.delete(Array.from({ length: 50 }, (_, offset) => `soak#${offset}`));
  };
  for (let index = 0; index < 50; index += 1) await cycle(index);
  const heap = () => {
    (globalThis as { gc?: () => void }).gc?.();
    return process.memoryUsage().heapUsed;
  };
  const before = typeof (globalThis as { gc?: unknown }).gc === 'function' ? heap() : 0;
  const started = performance.now();
  for (let index = 0; index < cycles; index += 1) await cycle(index);
  const elapsedMs = performance.now() - started;
  const after = before ? heap() : 0;
  return { cycles, heapGrowthMb: Math.max(0, after - before) / 1024 / 1024, elapsedMs };
}

/** Write throughput and search latency over a loaded store. */
export interface LoadResult {
  chunks: number;
  writeMs: number;
  queries: number;
  p50Ms: number;
  p95Ms: number;
}

/** Loads `chunks` chunks in batches of 100, then times `queries` searches one after another. */
export async function load(
  store: VectorStore,
  settle: Settle = immediately,
  { chunks = 2_000, queries = 200 } = {},
): Promise<LoadResult> {
  const words = ['refund', 'shipping', 'invoice', 'warranty', 'return', 'delivery', 'account', 'billing'];
  const text = (index: number) =>
    `${words[index % 8]} ${words[(index * 3) % 8]} ${words[(index * 5) % 8]} passage ${index}`;
  const written = performance.now();
  for (let start = 0; start < chunks; start += 100) {
    await store.add(
      Array.from({ length: Math.min(100, chunks - start) }, (_, offset) => ({
        id: `load#${start + offset}`,
        content: text(start + offset),
        metadata: { page: (start + offset) % 10 },
      })),
    );
  }
  const writeMs = performance.now() - written;
  await settle();
  const timings: number[] = [];
  for (let query = 0; query < queries; query += 1) {
    const started = performance.now();
    await store.search(`${words[query % 8]} ${words[(query + 3) % 8]}`, {
      topK: 10,
      ...(query % 2 ? { filter: { page: query % 10 } } : {}),
    });
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);
  const at = (share: number) => timings[Math.min(timings.length - 1, Math.floor(share * timings.length))] ?? 0;
  return { chunks, writeMs, queries, p50Ms: at(0.5), p95Ms: at(0.95) };
}

/**
 * What the previous minor wrote, this release reads: ranked, with its metadata and source whole, and
 * filtered by type where the store filters by type. It can then replace a chunk whole and delete one.
 */
export async function upgradeFrom(
  name: string,
  previous: VectorStore,
  current: VectorStore,
  { settle = immediately, typedFilters = true }: { settle?: Settle; typedFilters?: boolean } = {},
): Promise<void> {
  await previous.add(passages);
  await settle();
  const ranked = await current.search('how long do refunds take', { topK: 2 });
  assert.equal(ranked[0]?.id, 'refunds#0', `${name}: a chunk the previous minor wrote ranks first`);
  assert.equal(ranked[0]?.source, 'policy.md', `${name}: its source reads back`);
  assert.deepEqual(ranked[0]?.metadata, { tenant: 'acme', page: 3 }, `${name}: its metadata reads back whole`);
  assert.deepEqual(
    (await current.search('refund', { filter: { tenant: 'globex' } })).map((result) => result.id),
    ['refunds#1'],
    `${name}: its filter fields still filter`,
  );
  if (typedFilters) {
    assert.deepEqual(
      (await current.search('refunds', { filter: { page: 3 }, topK: 10 })).map((result) => result.id),
      ['refunds#0'],
      `${name}: a number it wrote is still a number`,
    );
  }
  await current.add([{ id: 'shipping#0', content: passages[1].content }]);
  await settle();
  const acme = await current.search('orders ship from the warehouse', { filter: { tenant: 'acme' }, topK: 10 });
  assert.equal(
    acme.some((result) => result.id === 'shipping#0'),
    false,
    `${name}: a chunk the previous minor wrote is replaced whole`,
  );
  await current.delete(['refunds#0']);
  await settle();
  assert.equal(
    (await current.search('how long do refunds take', { topK: 10 })).some((result) => result.id === 'refunds#0'),
    false,
    `${name}: and deleted`,
  );
}
