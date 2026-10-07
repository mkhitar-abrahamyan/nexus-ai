/**
 * The contract suites the adapter kit ships: what every vector store, retriever, and long-term store
 * must do, as checks that need no test framework. Each check is named for the behavior it proves,
 * and a capability the adapter does not declare is reported as skipped, never as a failure.
 */
import type { RagChunk } from '../hallucination/rag.js';
import type { EmbeddingProvider, VectorStore } from '../hallucination/retrieval.js';
import type { Retriever, SparseRetriever } from '../rag/retrievers.js';
import type { Store } from '../types/store.js';

/** One check of a contract suite. */
export interface AdapterCheck {
  /** What was checked, as a sentence. */
  name: string;
  /** Whether it held. */
  ok: boolean;
  /** Why it did not hold, or why it was skipped. */
  detail?: string;
  /** True when the adapter does not declare the capability the check needs. */
  skipped?: boolean;
}

/** The passages every retrieval contract runs on, and that benchmarks reuse. */
export const ADAPTER_FIXTURE_PASSAGES: readonly RagChunk[] = [
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

/** Fresh copies of the fixture passages, so no suite can change what the next one reads. */
function fixturePassages(): RagChunk[] {
  return ADAPTER_FIXTURE_PASSAGES.map((passage) => ({
    ...passage,
    ...(passage.metadata ? { metadata: { ...passage.metadata } } : {}),
  }));
}

/** Runs checks in order, turning a thrown error into a failed check instead of an abandoned suite. */
class Suite {
  readonly checks: AdapterCheck[] = [];

  async check(name: string, run: () => Promise<boolean | string> | boolean | string): Promise<void> {
    try {
      const result = await run();
      this.checks.push(
        result === true ? { name, ok: true } : { name, ok: false, detail: result === false ? 'did not hold' : result },
      );
    } catch (error) {
      this.checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  skip(name: string, reason: string): void {
    this.checks.push({ name, ok: true, skipped: true, detail: reason });
  }
}

/** What a vector store declares it supports, for its contract. */
export interface VectorStoreCapabilities {
  /** `searchVector()` with a vector computed elsewhere. Defaults to true. */
  searchVector?: boolean;
  /** `minScore` drops weak matches. Defaults to true. */
  minScore?: boolean;
  /** Metadata filters: `exact` matches values, `typed` also tells `3` from `'3'`, `none` has no filters. Defaults to `exact`. */
  filters?: 'none' | 'exact' | 'typed';
}

/** Options for `runVectorStoreContract()`. */
export interface VectorStoreContractOptions {
  /** The embedding function the store was given, to compute a query vector for `searchVector()`. */
  embed: EmbeddingProvider;
  /** What the store supports. */
  capabilities?: VectorStoreCapabilities;
  /** Waits for writes to become searchable, for a store whose index is eventually consistent. */
  settle?: () => Promise<void>;
}

/**
 * The `VectorStore` contract: ranking, `topK`, sources and metadata round-tripped, filters,
 * `minScore`, vector search, replacement by id, deletes, and empty writes. The store should be empty
 * when it starts.
 */
export async function runVectorStoreContract(
  store: VectorStore,
  options: VectorStoreContractOptions,
): Promise<AdapterCheck[]> {
  const suite = new Suite();
  const settle = options.settle ?? (async () => undefined);
  const capabilities = options.capabilities ?? {};
  const filters = capabilities.filters ?? 'exact';

  await suite.check('adds passages', async () => {
    await store.add(fixturePassages());
    await settle();
    return true;
  });
  await suite.check('ranks the closest passage first, best first, within topK', async () => {
    const results = await store.search('how long do refunds take', { topK: 2 });
    if (results.length !== 2) return `expected 2 results for topK 2, got ${results.length}`;
    if (results[0]?.id !== 'refunds#0') return `expected refunds#0 first, got ${results[0]?.id}`;
    return (results[0]?.score ?? 0) > (results[1]?.score ?? 0) || 'results are not ordered by score';
  });
  await suite.check('returns a passage source and its metadata whole', async () => {
    const [first] = await store.search('how long do refunds take', { topK: 1 });
    if (first?.source !== 'policy.md') return `expected source policy.md, got ${first?.source}`;
    return (
      JSON.stringify(first?.metadata) === JSON.stringify({ tenant: 'acme', page: 3 }) ||
      `metadata came back as ${JSON.stringify(first?.metadata)}`
    );
  });
  if (filters === 'none') suite.skip('narrows a search by metadata', 'the store declares no filters');
  else {
    await suite.check('narrows a search by metadata', async () => {
      const results = await store.search('refund', { filter: { tenant: 'globex' } });
      return (
        (results.length === 1 && results[0]?.id === 'refunds#1') ||
        `got ${results.map((result) => result.id).join(', ')}`
      );
    });
  }
  if (filters === 'typed') {
    await suite.check('tells a number from the same digits as text in a filter', async () => {
      const numeric = await store.search('refunds', { filter: { page: 3 }, topK: 10 });
      const text = await store.search('refunds', { filter: { page: '3' }, topK: 10 });
      return (
        (numeric.length === 1 && text.length === 0) || `number matched ${numeric.length}, text matched ${text.length}`
      );
    });
  } else suite.skip('tells a number from the same digits as text in a filter', 'the store declares untyped filters');
  if (capabilities.minScore === false) suite.skip('drops matches under minScore', 'the store declares no minScore');
  else {
    await suite.check('drops matches under minScore', async () => {
      const results = await store.search('how long do refunds take', { minScore: 0.99 });
      return results.length === 0 || `${results.length} results above 0.99`;
    });
  }
  if (capabilities.searchVector === false)
    suite.skip('searches by a precomputed vector', 'the store declares no searchVector');
  else {
    await suite.check('searches by a precomputed vector', async () => {
      const [vector] = await options.embed(['orders ship from the warehouse']);
      const [first] = await store.searchVector(vector as number[], { topK: 1 });
      return first?.id === 'shipping#0' || `expected shipping#0, got ${first?.id}`;
    });
  }
  await suite.check('replaces a passage added again under its id', async () => {
    await store.add([
      { id: 'careers#0', content: 'Refunds for event tickets are not available', metadata: { tenant: 'acme' } },
    ]);
    await settle();
    const results = await store.search('event tickets refunds', { topK: 10 });
    const copies = results.filter((result) => result.id === 'careers#0');
    if (copies.length !== 1) return `found ${copies.length} copies`;
    return /event tickets/.test(copies[0]?.content ?? '') || 'the old content is still there';
  });
  await suite.check('deletes by id, ignoring ids it does not hold', async () => {
    await store.delete(['refunds#0', 'not-stored']);
    await settle();
    const results = await store.search('how long do refunds take', { topK: 10 });
    return !results.some((result) => result.id === 'refunds#0') || 'the deleted passage is still found';
  });
  await suite.check('accepts empty writes', async () => {
    await store.add([]);
    await store.delete([]);
    return true;
  });
  return suite.checks;
}

/** What a retriever declares it supports, for its contract. */
export interface RetrieverCapabilities {
  /** It holds its own passages, with `add()` and `delete()`: a `SparseRetriever`. Defaults to whether it has them. */
  writes?: boolean;
  /** Metadata filters. Defaults to true. */
  filters?: boolean;
}

/** Options for `runRetrieverContract()`. */
export interface RetrieverContractOptions {
  /** What the retriever supports. */
  capabilities?: RetrieverCapabilities;
  /**
   * Loads the fixture passages, for a retriever that does not hold its own: into the vector store
   * behind it, say. A retriever with `add()` is loaded through that.
   */
  load?: (passages: RagChunk[]) => Promise<void>;
  /** Waits for writes to become searchable. */
  settle?: () => Promise<void>;
}

/**
 * The `Retriever` contract, and the `SparseRetriever` contract when the retriever takes writes:
 * an exact term found, ranking, `topK`, filters, replacement, deletes, and an empty query.
 */
export async function runRetrieverContract(
  retriever: Retriever,
  options: RetrieverContractOptions = {},
): Promise<AdapterCheck[]> {
  const suite = new Suite();
  const settle = options.settle ?? (async () => undefined);
  const sparse = retriever as Partial<SparseRetriever>;
  const writes =
    options.capabilities?.writes ?? (typeof sparse.add === 'function' && typeof sparse.delete === 'function');
  const passages = fixturePassages();

  await suite.check('loads the fixture passages', async () => {
    if (writes) await sparse.add?.(passages);
    else if (options.load) await options.load(passages);
    else return 'a retriever without add() needs a load() to fill what it reads from';
    await settle();
    return true;
  });
  await suite.check('finds the passage holding the query terms first', async () => {
    const [first] = await retriever.retrieve('warehouse business days', { topK: 3 });
    return first?.id === 'shipping#0' || `expected shipping#0, got ${first?.id}`;
  });
  await suite.check('returns at most topK results, best first', async () => {
    const results = await retriever.retrieve('refund refunds return', { topK: 1 });
    return results.length <= 1 || `${results.length} results for topK 1`;
  });
  if (options.capabilities?.filters === false) suite.skip('narrows by metadata', 'the retriever declares no filters');
  else {
    await suite.check('narrows by metadata', async () => {
      const results = await retriever.retrieve('refund', { filter: { tenant: 'globex' }, topK: 10 });
      return (
        (results.every((result) => result.metadata?.tenant === 'globex') && results.length > 0) ||
        `got ${results.map((result) => result.id).join(', ')}`
      );
    });
  }
  if (!writes) {
    suite.skip('replaces a passage added again under its id', 'the retriever does not take writes');
    suite.skip('deletes by id, ignoring ids it does not hold', 'the retriever does not take writes');
  } else {
    await suite.check('replaces a passage added again under its id', async () => {
      await sparse.add?.([{ id: 'careers#0', content: 'Engineers relocate with a stipend' }]);
      await settle();
      const results = await retriever.retrieve('stipend relocate', { topK: 10 });
      return (
        results.filter((result) => result.id === 'careers#0').length === 1 || 'the passage is missing or duplicated'
      );
    });
    await suite.check('deletes by id, ignoring ids it does not hold', async () => {
      await sparse.delete?.(['shipping#0', 'not-stored']);
      await settle();
      const results = await retriever.retrieve('warehouse business days', { topK: 10 });
      return !results.some((result) => result.id === 'shipping#0') || 'the deleted passage is still found';
    });
  }
  await suite.check('answers an empty query without failing', async () => {
    await retriever.retrieve('', { topK: 3 });
    return true;
  });
  return suite.checks;
}

/** What a long-term store declares it supports, for its contract. */
export interface StoreCapabilities {
  /** `search()` lists a namespace prefix, newest first. Defaults to true. */
  search?: boolean;
  /** `search()` filters on value fields. Defaults to true. */
  filters?: boolean;
  /** `listNamespaces()`. Defaults to true. */
  namespaces?: boolean;
}

/**
 * The long-term `Store` contract: values round-trip, a replaced item keeps its creation time, a
 * missing key reads as nothing, deletes, prefix search with filters and paging, and namespace
 * listing. The store should be empty when it starts.
 */
export async function runStoreContract(
  store: Store,
  options: { capabilities?: StoreCapabilities } = {},
): Promise<AdapterCheck[]> {
  const suite = new Suite();
  const capabilities = options.capabilities ?? {};
  const namespace = ['contract', 'users'];

  await suite.check('round-trips a value', async () => {
    await store.put(namespace, 'ann', { name: 'Ann', plan: 'pro' });
    const item = await store.get<{ name: string }>(namespace, 'ann');
    return (item?.value.name === 'Ann' && item.key === 'ann') || `read ${JSON.stringify(item)}`;
  });
  await suite.check('keeps the creation time when an item is replaced', async () => {
    const before = await store.get(namespace, 'ann');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.put(namespace, 'ann', { name: 'Ann', plan: 'team' });
    const after = await store.get<{ plan: string }>(namespace, 'ann');
    if (after?.value.plan !== 'team') return 'the replacement was not stored';
    return after.createdAt === before?.createdAt || `createdAt moved from ${before?.createdAt} to ${after.createdAt}`;
  });
  await suite.check('reads a missing key as nothing', async () => (await store.get(namespace, 'nobody')) === undefined);
  await suite.check('deletes an item', async () => {
    await store.put(namespace, 'temp', { name: 'Temp' });
    await store.delete(namespace, 'temp');
    return (await store.get(namespace, 'temp')) === undefined;
  });
  if (capabilities.search === false)
    suite.skip('lists a namespace prefix, with paging', 'the store declares no search');
  else {
    await suite.check('lists a namespace prefix, with paging', async () => {
      await store.put([...namespace, 'archived'], 'bob', { name: 'Bob', plan: 'free' });
      await store.put(namespace, 'cy', { name: 'Cy', plan: 'free' });
      const all = await store.search(['contract'], { limit: 10 });
      if (all.length !== 3) return `expected 3 items under the prefix, got ${all.length}`;
      const page = await store.search(['contract'], { limit: 2, offset: 2 });
      return page.length === 1 || `expected 1 item on the second page, got ${page.length}`;
    });
  }
  if (capabilities.search === false || capabilities.filters === false)
    suite.skip('filters by a value field', 'the store declares no filters');
  else {
    await suite.check('filters by a value field', async () => {
      const free = await store.search<{ name: string }>(['contract'], { filter: { plan: 'free' }, limit: 10 });
      const names = free
        .map((item) => item.value.name)
        .sort()
        .join(',');
      return names === 'Bob,Cy' || `got ${names}`;
    });
  }
  if (capabilities.namespaces === false)
    suite.skip('lists namespaces under a prefix', 'the store declares no namespace listing');
  else {
    await suite.check('lists namespaces under a prefix', async () => {
      const listed = (await store.listNamespaces({ prefix: ['contract'] })).map((parts) => parts.join('/')).sort();
      return listed.join(',') === 'contract/users,contract/users/archived' || `got ${listed.join(', ')}`;
    });
  }
  return suite.checks;
}
