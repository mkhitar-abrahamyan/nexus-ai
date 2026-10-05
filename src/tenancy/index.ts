/**
 * One tenant model for every store.
 *
 * Each function returns one tenant's view of a shared store, implementing the same contract as the
 * store itself, so a tenant's code takes a `TraceStore`, a `PromptStore`, or a `VectorStore` as it
 * always did and cannot reach past its tenant. Names and keys are placed under the tenant's prefix
 * (`tenant/<id>/`) and records carry `tenantId`, so the views work over the memory, Redis, Postgres,
 * SQLite, and file stores alike, with no schema change. A tenant id is letters, digits, `_`, and `-`,
 * so no tenant's prefix is the start of another's.
 */
import type { CacheAdapter } from '../cache/adapters.js';
import type {
  VectorDocument,
  VectorSearchOptions,
  VectorSearchResult,
  VectorStore,
} from '../hallucination/retrieval.js';
import type { AssetPutOptions, AssetSignOptions, AssetStore } from '../images/asset-support.js';
import type { RollupKey, RollupQuery, RollupStore, RollupTotals } from '../tracing/rollups.js';
import type { Dataset, DatasetStore, Experiment, ExperimentStore } from '../types/evaluate.js';
import type { OperationRecord, OperationStore, OperationStoreFilter } from '../types/operations.js';
import type { PromptHistoryEntry, PromptLabel, PromptStore, PromptVersion } from '../types/prompts.js';
import type { Store } from '../types/store.js';
import type { Run, RunFeedback, RunQuery, RunTree, TraceStore } from '../types/tracing.js';
import { tenantPrefix } from '../utils/tenant.js';
import { tenantStore } from '../store/tenant.js';

export { TENANT_NAMESPACE, tenantStore } from '../store/tenant.js';
export { assertTenantId, TenantIdError } from '../utils/tenant.js';

/** Prefixes names into a tenant's space and back, refusing a name from outside it. */
function names(tenantId: string) {
  const prefix = tenantPrefix(tenantId);
  return {
    prefix,
    in: (name: string) => `${prefix}${name}`,
    owns: (name: string) => name.startsWith(prefix),
    out: (name: string) => name.slice(prefix.length),
  };
}

/** Whether a record's metadata names this tenant. */
function stamped(metadata: Record<string, unknown> | undefined, tenantId: string): boolean {
  return metadata?.tenantId === tenantId;
}

// ── Traces ────────────────────────────────────────────────────────

/**
 * One tenant's traces. Every run saved through it is stamped `metadata.tenantId`, the field rollups,
 * the studio, and the Postgres tenant index read; `get()`, `query()`, and `tree()` return only runs so
 * stamped, and feedback reaches only the tenant's own runs. `prune()` is left out, since it would
 * remove every tenant's old runs.
 */
export function tenantTraceStore(store: TraceStore, tenantId: string): TraceStore {
  tenantPrefix(tenantId);
  const own = (run: Run | undefined) => (run && stamped(run.metadata, tenantId) ? run : undefined);
  const prune = (tree: RunTree): RunTree => ({
    ...tree,
    children: tree.children.filter((child) => stamped(child.metadata, tenantId)).map(prune),
  });
  return {
    save: (run: Run) => store.save({ ...run, metadata: { ...run.metadata, tenantId } }),
    get: async (runId: string) => own(await store.get(runId)),
    query: (query: RunQuery = {}) => store.query({ ...query, metadata: { ...query.metadata, tenantId } }),
    async tree(traceId: string) {
      const tree = await store.tree(traceId);
      return tree && stamped(tree.metadata, tenantId) ? prune(tree) : undefined;
    },
    async addFeedback(runId: string, feedback: RunFeedback) {
      const run = own(await store.get(runId));
      if (!run) return;
      if (store.addFeedback) await store.addFeedback(runId, feedback);
      else await store.save({ ...run, feedback: [...(run.feedback ?? []), feedback] });
    },
  };
}

// ── Operations ────────────────────────────────────────────────────

/**
 * One tenant's operations. Records it creates carry `tenantId`, and their idempotency keys are
 * placed under the tenant's prefix, so two tenants using the same key never collide. Reads, updates,
 * deletes, recovery, and queue listings see only the tenant's records; `listQueued()` and `stats()`
 * pass the tenant to the store as a filter, which Postgres and SQLite answer from an index.
 */
export function tenantOperationStore<TResult = unknown>(
  store: OperationStore<TResult>,
  tenantId: string,
): OperationStore<TResult> {
  const keys = names(tenantId);
  const inward = (record: OperationRecord<TResult>): OperationRecord<TResult> => ({
    ...record,
    tenantId,
    ...(record.idempotencyKey ? { idempotencyKey: keys.in(record.idempotencyKey) } : {}),
  });
  const outward = (record: OperationRecord<TResult> | undefined): OperationRecord<TResult> | undefined => {
    if (!record || record.tenantId !== tenantId) return undefined;
    return record.idempotencyKey && keys.owns(record.idempotencyKey)
      ? { ...record, idempotencyKey: keys.out(record.idempotencyKey) }
      : record;
  };
  const own = (records: ReadonlyArray<OperationRecord<TResult>>) =>
    records.map(outward).filter((record): record is OperationRecord<TResult> => record !== undefined);
  const filtered = (filter?: OperationStoreFilter): OperationStoreFilter => ({ ...filter, tenantId });
  const view: OperationStore<TResult> = {
    create: (record) => store.create(inward(record)),
    read: async (id) => outward(await store.read(id)),
    async update(record, expectedSequence) {
      if (record.tenantId !== undefined && record.tenantId !== tenantId) return false;
      if (!outward(await store.read(record.id))) return false;
      return store.update(inward(record), expectedSequence);
    },
  };
  if (store.delete) {
    const remove = store.delete.bind(store);
    view.delete = async (id) => (outward(await store.read(id)) ? remove(id) : false);
  }
  if (store.claimExpired) {
    const claim = store.claimExpired.bind(store);
    view.claimExpired = async (now, limit) => own(await claim(now, limit));
  }
  if (store.findByIdempotencyKey) {
    const find = store.findByIdempotencyKey.bind(store);
    view.findByIdempotencyKey = async (key) => outward(await find(keys.in(key)));
  }
  if (store.list) {
    const list = store.list.bind(store);
    view.list = async () => own(await list());
  }
  if (store.listQueued) {
    const listQueued = store.listQueued.bind(store);
    view.listQueued = async (limit, filter) => own(await listQueued(limit, filtered(filter)));
  }
  if (store.stats) {
    const stats = store.stats.bind(store);
    view.stats = (now, filter) => stats(now, filtered(filter));
  }
  return view;
}

// ── Prompts and the context hub ───────────────────────────────────

/**
 * One tenant's prompts. Every prompt name is placed under the tenant's prefix on the way in and
 * taken off on the way out, so the tenant sees its own names and `listNames()` lists only them. A
 * `ContextHub` given this store keeps the tenant's context bundles apart the same way.
 */
export function tenantPromptStore(store: PromptStore, tenantId: string): PromptStore {
  const scoped = names(tenantId);
  const named = <T extends { name: string }>(value: T): T => ({ ...value, name: scoped.in(value.name) });
  const unnamed = <T extends { name: string }>(value: T | undefined): T | undefined =>
    value && scoped.owns(value.name) ? { ...value, name: scoped.out(value.name) } : undefined;
  const all = <T extends { name: string }>(values: readonly T[]) =>
    values.map(unnamed).filter((value): value is T => value !== undefined);
  return {
    saveVersion: (version: PromptVersion) => store.saveVersion(named(version)),
    getVersion: async (name, version) => unnamed(await store.getVersion(scoped.in(name), version)),
    listVersions: async (name, options) => all(await store.listVersions(scoped.in(name), options)),
    getLabel: async (name, label) => unnamed(await store.getLabel(scoped.in(name), label)),
    listLabels: async (name) => all(await store.listLabels(scoped.in(name))),
    setLabel: (label: PromptLabel, expected) => store.setLabel(named(label), expected),
    deleteLabel: (name, label) => store.deleteLabel(scoped.in(name), label),
    appendHistory: (entry: PromptHistoryEntry) => store.appendHistory(named(entry)),
    listHistory: async (name, options) => all(await store.listHistory(scoped.in(name), options)),
    listNames: async () => (await store.listNames()).filter(scoped.owns).map(scoped.out).sort(),
  };
}

// ── Datasets and experiments ──────────────────────────────────────

/** One tenant's datasets: names placed under the tenant's prefix, and `list()` showing only its own. */
export function tenantDatasetStore(store: DatasetStore, tenantId: string): DatasetStore {
  const scoped = names(tenantId);
  return {
    save: (dataset: Dataset) => store.save({ ...dataset, name: scoped.in(dataset.name) }),
    async get(name: string, version?: string) {
      const dataset = await store.get(scoped.in(name), version);
      return dataset ? { ...dataset, name: name } : undefined;
    },
    async list() {
      return (await store.list())
        .filter((entry) => scoped.owns(entry.name))
        .map((entry) => ({ ...entry, name: scoped.out(entry.name) }));
    },
  };
}

/**
 * One tenant's experiments. Ids, names, and dataset names are placed under the tenant's prefix, so
 * `get()` of another tenant's experiment id finds nothing and `list()` returns only the tenant's.
 */
export function tenantExperimentStore(store: ExperimentStore, tenantId: string): ExperimentStore {
  const scoped = names(tenantId);
  const inward = (experiment: Experiment): Experiment => ({
    ...experiment,
    id: scoped.in(experiment.id),
    name: scoped.in(experiment.name),
    dataset: { ...experiment.dataset, name: scoped.in(experiment.dataset.name) },
  });
  const outward = (experiment: Experiment | undefined): Experiment | undefined =>
    experiment && scoped.owns(experiment.id)
      ? {
          ...experiment,
          id: scoped.out(experiment.id),
          name: scoped.out(experiment.name),
          dataset: { ...experiment.dataset, name: scoped.out(experiment.dataset.name) },
        }
      : undefined;
  return {
    save: (experiment: Experiment) => store.save(inward(experiment)),
    get: async (id: string) => outward(await store.get(scoped.in(id))),
    async list(filter: { name?: string; dataset?: string; limit?: number } = {}) {
      const experiments = await store.list({
        ...filter,
        ...(filter.name === undefined ? {} : { name: scoped.in(filter.name) }),
        ...(filter.dataset === undefined ? {} : { dataset: scoped.in(filter.dataset) }),
      });
      return experiments.map(outward).filter((experiment): experiment is Experiment => experiment !== undefined);
    },
  };
}

// ── Retrieval ─────────────────────────────────────────────────────

/**
 * One tenant's retrieval chunks. Each chunk's id is placed under the tenant's prefix and its metadata
 * stamped `tenantId`, and every search adds `tenantId` to its filter, which every vector store applies
 * natively. A search never ranks another tenant's chunks, and `delete()` reaches only the tenant's.
 */
export function tenantVectorStore(store: VectorStore, tenantId: string): VectorStore {
  const scoped = names(tenantId);
  const outward = (results: VectorSearchResult[]): VectorSearchResult[] =>
    results
      .filter((result) => scoped.owns(result.id) && stamped(result.metadata, tenantId))
      .map((result) => {
        const { tenantId: _owner, ...metadata } = result.metadata ?? {};
        return { ...result, id: scoped.out(result.id), metadata };
      });
  const filtered = (options: VectorSearchOptions = {}): VectorSearchOptions => ({
    ...options,
    filter: { ...options.filter, tenantId },
  });
  return {
    add: (documents: VectorDocument[]) =>
      store.add(
        documents.map((document) => ({
          ...document,
          id: scoped.in(document.id),
          metadata: { ...document.metadata, tenantId },
        })),
      ),
    search: async (query, options) => outward(await store.search(query, filtered(options))),
    searchVector: async (vector, options) => outward(await store.searchVector(vector, filtered(options))),
    delete: (ids: readonly string[]) => store.delete(ids.map(scoped.in)),
  };
}

// ── Cache ─────────────────────────────────────────────────────────

/**
 * One tenant's cache: every key placed under the tenant's prefix, so a tenant can never read what
 * another cached. `clear()` is left out, since it would clear every tenant's entries.
 */
export function tenantCache<T = unknown>(cache: CacheAdapter<T>, tenantId: string): CacheAdapter<T> {
  const scoped = names(tenantId);
  const view: CacheAdapter<T> = {
    get: (key) => cache.get(scoped.in(key)),
    set: (key, value, ttlSeconds) => cache.set(scoped.in(key), value, ttlSeconds),
  };
  if (cache.delete) {
    const remove = cache.delete.bind(cache);
    view.delete = (key) => remove(scoped.in(key));
  }
  return view;
}

// ── Assets and rollups ────────────────────────────────────────────

/** An asset store with the tenant bound, so no call can name another. Returned by `tenantAssetStore()`. */
export interface TenantAssetStore {
  /** The tenant every call acts for. */
  readonly tenantId: string;
  /** Stores an asset for the tenant. */
  put(
    input: Parameters<AssetStore['put']>[0],
    options: Omit<AssetPutOptions, 'tenantId'>,
  ): ReturnType<AssetStore['put']>;
  /** Reads one of the tenant's assets with its bytes. */
  get(assetId: string): ReturnType<AssetStore['get']>;
  /** Describes one of the tenant's assets. */
  stat(assetId: string): ReturnType<AssetStore['stat']>;
  /** Deletes one of the tenant's assets. */
  delete(assetId: string): ReturnType<AssetStore['delete']>;
  /** Signs a URL for one of the tenant's assets. */
  sign(assetId: string, options?: AssetSignOptions): ReturnType<AssetStore['sign']>;
}

/**
 * One tenant's assets. Asset stores already treat another tenant's asset as missing; this binds the
 * tenant once, so code handed the view cannot pass a different one.
 */
export function tenantAssetStore(store: AssetStore, tenantId: string): TenantAssetStore {
  tenantPrefix(tenantId);
  return {
    tenantId,
    put: (input, options) => store.put(input, { ...options, tenantId }),
    get: (assetId) => store.get(assetId, tenantId),
    stat: (assetId) => store.stat(assetId, tenantId),
    delete: (assetId) => store.delete(assetId, tenantId),
    sign: (assetId, options) => store.sign(assetId, tenantId, options),
  };
}

/** One tenant's rollups: rows it adds are counted for the tenant, and queries read only the tenant's rows. */
export function tenantRollupStore(store: RollupStore, tenantId: string): RollupStore {
  tenantPrefix(tenantId);
  return {
    add: (key: RollupKey, totals: RollupTotals) => store.add({ ...key, tenant: tenantId }, totals),
    query: (query: RollupQuery = {}) => store.query({ ...query, tenant: tenantId }),
  };
}

// ── Everything at once ────────────────────────────────────────────

/** The stores `tenantScope()` can scope. Each is optional. */
export interface TenantStores {
  /** Long-term memory. */
  store?: Store;
  /** Traces. */
  traces?: TraceStore;
  /** Operation records. */
  operations?: OperationStore<unknown>;
  /** Prompt versions and labels, and the context hub's bundles. */
  prompts?: PromptStore;
  /** Datasets. */
  datasets?: DatasetStore;
  /** Experiments. */
  experiments?: ExperimentStore;
  /** Retrieval chunks. */
  vectors?: VectorStore;
  /** A cache. */
  cache?: CacheAdapter<unknown>;
  /** Dashboard rollups. */
  rollups?: RollupStore;
}

/**
 * Scopes every given store to one tenant at once, keeping each one's type, so a request handler
 * builds its tenant's view in one line.
 *
 * ```ts
 * const scoped = tenantScope(principal.tenantId, { store, traces, prompts, vectors });
 * ```
 */
export function tenantScope<T extends TenantStores>(tenantId: string, stores: T): T & { readonly tenantId: string } {
  tenantPrefix(tenantId);
  const scoped: TenantStores = {};
  if (stores.store) scoped.store = tenantStore(stores.store, tenantId);
  if (stores.traces) scoped.traces = tenantTraceStore(stores.traces, tenantId);
  if (stores.operations) scoped.operations = tenantOperationStore(stores.operations, tenantId);
  if (stores.prompts) scoped.prompts = tenantPromptStore(stores.prompts, tenantId);
  if (stores.datasets) scoped.datasets = tenantDatasetStore(stores.datasets, tenantId);
  if (stores.experiments) scoped.experiments = tenantExperimentStore(stores.experiments, tenantId);
  if (stores.vectors) scoped.vectors = tenantVectorStore(stores.vectors, tenantId);
  if (stores.cache) scoped.cache = tenantCache(stores.cache, tenantId);
  if (stores.rollups) scoped.rollups = tenantRollupStore(stores.rollups, tenantId);
  return { ...stores, ...scoped, tenantId };
}
