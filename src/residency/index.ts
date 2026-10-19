/**
 * Data residency: each tenant's requests and data kept in the regions it requires. A policy says
 * which regions each tenant may reach and what runs where; the client's lifecycle routes every
 * provider call by it, and the regional stores write each tenant's traces and assets in its region.
 */
import type {
  AssetByteRange,
  AssetPutOptions,
  AssetSignOptions,
  AssetStat,
  AssetStore,
  ByteAssetDescriptor,
  ByteAssetInput,
  StreamAssetDescriptor,
  StreamAssetInput,
} from '../images/asset-support.js';
import { applyQuery } from '../tracing/query.js';
import type {
  RegionDefinition,
  ResidencyDecision,
  ResidencyPlacement,
  ResidencyPolicy,
  ResidencyTarget,
} from '../types/residency.js';
import type { Run, RunFeedback, RunQuery, RunTree, TraceStore } from '../types/tracing.js';
import { ResidencyError } from './errors.js';

export { ResidencyError } from './errors.js';
export type {
  CallResidency,
  RegionDefinition,
  ResidencyDecision,
  ResidencyPlacement,
  ResidencyPolicy,
  ResidencyTarget,
} from '../types/residency.js';

/** Regions as a rule names them: every region, none, one, or a list, the first the home. */
export type RegionRule = 'any' | 'refuse' | string | readonly string[];

/** Options for `residency()`. */
export interface ResidencyOptions {
  /** Every region, by name, with the providers that run in it and their twins. */
  regions: Readonly<Record<string, RegionDefinition>>;
  /**
   * Each tenant's regions, the first its home: a map, or a function, such as one that reads the
   * tenant's record. A tenant it says nothing of follows `unassigned`.
   */
  tenants?:
    | Readonly<Record<string, RegionRule>>
    | ((tenantId: string) => RegionRule | undefined | Promise<RegionRule | undefined>);
  /** The regions of a tenant no rule names. Defaults to `any`; `refuse` refuses every one of its calls. */
  unassigned?: RegionRule;
  /** The regions of an operation with no tenant. Defaults to `any`. */
  untenanted?: RegionRule;
}

/** A policy from `residency()`, which also lists its regions. */
export interface Residency extends ResidencyPolicy {
  /** Every region, in the order the options name them. */
  regions(): string[];
}

/**
 * A residency policy: which regions each tenant may reach, the providers in each region, and the
 * twin of a provider inside a region, such as an EU endpoint of the same service. Give it to the
 * client as `lifecycle.residency`, and a tenant's calls never reach a provider outside its regions:
 * each is sent to the provider routing chose when it is inside, to its twin inside when there is
 * one, and refused with a `ResidencyError` naming the rule when neither.
 *
 * ```ts
 * const policy = residency({
 *   regions: {
 *     'eu-west': { providers: ['openai-eu', 'mistral'], twins: { openai: 'openai-eu' } },
 *     'us-east': { providers: ['openai', 'anthropic'] },
 *   },
 *   tenants: { acme: ['eu-west'], globex: 'any' },
 * });
 * ```
 */
export function residency(options: ResidencyOptions): Residency {
  const names = Object.keys(options.regions);
  const known = new Set(names);
  const providerRegion = new Map<string, string>();
  for (const [region, definition] of Object.entries(options.regions)) {
    for (const provider of definition.providers ?? []) claim(provider, region);
    // A twin runs in the region that names it.
    for (const twin of Object.values(definition.twins ?? {})) claim(twin, region);
  }
  function claim(provider: string, region: string): void {
    const earlier = providerRegion.get(provider);
    if (earlier && earlier !== region) {
      throw new RangeError(`Provider "${provider}" is listed in two regions: ${earlier} and ${region}`);
    }
    providerRegion.set(provider, region);
  }
  const normalize = (rule: RegionRule, source: string): string[] | undefined => {
    if (rule === 'any') return undefined;
    if (rule === 'refuse') return [];
    const list = typeof rule === 'string' ? [rule] : [...rule];
    for (const region of list) {
      if (!known.has(region))
        throw new RangeError(`${source} names region "${region}", which the policy does not define`);
    }
    return list;
  };
  const describe = (who: string, regions: readonly string[] | undefined) =>
    `${who}: ${regions === undefined ? 'any region' : regions.length === 0 ? 'no region' : regions.join(', ')}`;
  // A map is checked once, when the policy is built.
  const tenantMap = typeof options.tenants === 'function' ? undefined : options.tenants;
  for (const [tenant, rule] of Object.entries(tenantMap ?? {})) normalize(rule, `The rule for tenant ${tenant}`);
  const unassigned = normalize(options.unassigned ?? 'any', 'unassigned');
  const untenanted = normalize(options.untenanted ?? 'any', 'untenanted');

  const policy: Residency = {
    regions: () => [...names],

    async regionsFor(tenantId) {
      if (tenantId === undefined) {
        return { regions: untenanted, rule: describe('no tenant', untenanted) } as ResidencyDecision;
      }
      const rule = typeof options.tenants === 'function' ? await options.tenants(tenantId) : tenantMap?.[tenantId];
      if (rule === undefined) {
        return {
          tenantId,
          ...(unassigned ? { regions: unassigned } : {}),
          rule: describe(`tenant ${tenantId} (unassigned)`, unassigned),
        };
      }
      const regions = normalize(rule, `The rule for tenant ${tenantId}`);
      return { tenantId, ...(regions ? { regions } : {}), rule: describe(`tenant ${tenantId}`, regions) };
    },

    regionOf: (provider) => providerRegion.get(provider),

    allows(region, decision) {
      if (decision.regions === undefined) return true;
      return region !== undefined && decision.regions.includes(region);
    },

    place(provider, decision): ResidencyPlacement | undefined {
      const region = providerRegion.get(provider);
      if (policy.allows(region, decision)) return { provider, ...(region ? { region } : {}) };
      for (const allowed of decision.regions ?? []) {
        const twin = options.regions[allowed]?.twins?.[provider];
        if (twin) return { provider: twin, region: allowed };
      }
      return undefined;
    },

    check(target: ResidencyTarget, decision: ResidencyDecision) {
      if (!policy.allows(target.region, decision)) throw new ResidencyError(target, decision);
    },
  };
  return policy;
}

/** The first region a decision allows that has a store, else, when every region is allowed, `fallback`. */
function homeOf(
  stores: Readonly<Record<string, unknown>>,
  decision: ResidencyDecision,
  fallback?: string,
): string | undefined {
  if (decision.regions === undefined) return fallback ?? Object.keys(stores)[0];
  return decision.regions.find((region) => region in stores);
}

/** The regions a decision allows that have a store, in its order. */
function regionsWithStores(stores: Readonly<Record<string, unknown>>, decision: ResidencyDecision): string[] {
  return decision.regions === undefined ? Object.keys(stores) : decision.regions.filter((region) => region in stores);
}

// ── Traces ──

/** Options for `regionalTraceStore()`. */
export interface RegionalTraceStoreOptions {
  /** A trace store per region, by region. */
  stores: Readonly<Record<string, TraceStore>>;
  /** The residency policy. */
  residency: ResidencyPolicy;
  /**
   * The tenant a run belongs to. Defaults to its `metadata.tenantId`, or the `metadata.nexus.tenant`
   * an agent server records. A run without one goes where its trace went.
   */
  tenantOf?: (run: Run) => string | undefined;
  /** Where a trace with no tenant goes, when its operation may reach any region. Defaults to the first store. */
  defaultRegion?: string;
  /** Traces whose region is remembered, so their runs stay together. Defaults to 10,000. */
  maxTraces?: number;
}

/** A trace store across regions, with a view of one tenant's. */
export interface RegionalTraceStore extends TraceStore {
  /** Reads and writes one tenant's traces, in the regions it may reach only. */
  forTenant(tenantId: string): TraceStore;
  /** The region a trace was written in, when this store wrote it. */
  regionOfTrace(traceId: string): string | undefined;
}

/**
 * A trace store per region: each run is written in its tenant's home region, the first region it may
 * reach that has a store, and every run of a trace goes where the trace went. A run whose tenant may
 * reach no region with a store is refused with a `ResidencyError`, which a tracer reports through its
 * `onError`, and written nowhere. Queries read every region, newest first across them.
 */
export function regionalTraceStore(options: RegionalTraceStoreOptions): RegionalTraceStore {
  const maxTraces = options.maxTraces ?? 10_000;
  const traceRegion = new Map<string, string>();
  const tenantOf =
    options.tenantOf ??
    ((run: Run) => {
      const metadata = run.metadata as { tenantId?: unknown; nexus?: { tenant?: unknown } } | undefined;
      const tenant = metadata?.tenantId ?? metadata?.nexus?.tenant;
      return typeof tenant === 'string' ? tenant : undefined;
    });
  const remember = (traceId: string, region: string) => {
    traceRegion.delete(traceId);
    traceRegion.set(traceId, region);
    while (traceRegion.size > maxTraces) traceRegion.delete(traceRegion.keys().next().value as string);
  };

  const regionFor = async (run: Run, forced?: string): Promise<string> => {
    const tenant = forced ?? tenantOf(run);
    const known = traceRegion.get(run.traceId);
    if (tenant === undefined && known) return known;
    const decision = await options.residency.regionsFor(tenant);
    // A trace already written in an allowed region stays there.
    if (known && options.residency.allows(known, decision)) return known;
    const region = homeOf(options.stores, decision, options.defaultRegion);
    if (!region) {
      throw new ResidencyError(
        { kind: 'trace-store', name: `run ${run.id}` },
        decision,
        'no trace store is in a region it may reach',
      );
    }
    return region;
  };

  const view = (regions: () => Promise<string[]>, forced?: string): TraceStore => ({
    async save(run) {
      const region = await regionFor(run, forced);
      remember(run.traceId, region);
      await (options.stores[region] as TraceStore).save(run);
    },
    async get(runId) {
      for (const region of await regions()) {
        const found = await (options.stores[region] as TraceStore).get(runId);
        if (found) return found;
      }
      return undefined;
    },
    async query(query: RunQuery = {}) {
      const window = (query.offset ?? 0) + (query.limit ?? 50);
      const all: Run[] = [];
      for (const region of await regions()) {
        all.push(...(await (options.stores[region] as TraceStore).query({ ...query, offset: 0, limit: window })));
      }
      return applyQuery(all, query);
    },
    async tree(traceId): Promise<RunTree | undefined> {
      const known = traceRegion.get(traceId);
      const order = await regions();
      for (const region of known && order.includes(known)
        ? [known, ...order.filter((item) => item !== known)]
        : order) {
        const found = await (options.stores[region] as TraceStore).tree(traceId);
        if (found) return found;
      }
      return undefined;
    },
    async addFeedback(runId: string, feedback: RunFeedback) {
      for (const region of await regions()) {
        const store = options.stores[region] as TraceStore;
        if (await store.get(runId)) {
          await store.addFeedback?.(runId, feedback);
          return;
        }
      }
    },
    async prune(before: string) {
      let removed = 0;
      for (const region of await regions())
        removed += (await (options.stores[region] as TraceStore).prune?.(before)) ?? 0;
      return removed;
    },
  });

  const every = async () => Object.keys(options.stores);
  return {
    ...view(every),
    forTenant(tenantId) {
      return view(
        async () => regionsWithStores(options.stores, await options.residency.regionsFor(tenantId)),
        tenantId,
      );
    },
    regionOfTrace: (traceId) => traceRegion.get(traceId),
  };
}

// ── Assets ──

/** Options for `regionalAssetStore()`. */
export interface RegionalAssetStoreOptions {
  /** An asset store per region, by region. */
  stores: Readonly<Record<string, AssetStore>>;
  /** The residency policy. */
  residency: ResidencyPolicy;
}

/**
 * An asset store per region: each asset is stored in its tenant's home region, the first region it
 * may reach that has a store, and read only from the regions the tenant may reach, so an asset is
 * never stored or served outside them. A tenant that may reach no region with a store is refused
 * with a `ResidencyError`, and nothing is stored.
 */
export function regionalAssetStore(options: RegionalAssetStoreOptions): AssetStore {
  const home = async (tenantId: string): Promise<AssetStore> => {
    const decision = await options.residency.regionsFor(tenantId);
    const region = homeOf(options.stores, decision);
    if (!region) {
      throw new ResidencyError(
        { kind: 'asset-store', name: 'asset' },
        decision,
        'no asset store is in a region it may reach',
      );
    }
    return options.stores[region] as AssetStore;
  };
  const reachable = async (tenantId: string): Promise<AssetStore[]> =>
    regionsWithStores(options.stores, await options.residency.regionsFor(tenantId)).map(
      (region) => options.stores[region] as AssetStore,
    );
  // The first of the tenant's regions that has the asset answers.
  const first = async <T>(tenantId: string, read: (store: AssetStore) => T | Promise<T>): Promise<T | undefined> => {
    for (const store of await reachable(tenantId)) {
      const found = await read(store);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const store: AssetStore = {
    put: async (input: ByteAssetInput, putOptions: AssetPutOptions) =>
      (await home(putOptions.tenantId)).put(input, putOptions),
    get: (assetId: string, tenantId: string): Promise<ByteAssetDescriptor | undefined> =>
      first(tenantId, (each) => each.get(assetId, tenantId)),
    stat: (assetId: string, tenantId: string): Promise<AssetStat | undefined> =>
      first(tenantId, (each) => each.stat(assetId, tenantId)),
    delete: (assetId: string, tenantId: string): Promise<true | undefined> =>
      first(tenantId, (each) => each.delete(assetId, tenantId)),
    sign: (assetId: string, tenantId: string, signOptions?: AssetSignOptions): Promise<string | undefined> =>
      first(tenantId, async (each) =>
        (await each.stat(assetId, tenantId)) ? each.sign(assetId, tenantId, signOptions) : undefined,
      ),
    async purgeExpired() {
      let purged = 0;
      for (const each of Object.values(options.stores)) purged += await each.purgeExpired();
      return purged;
    },
    async putStream(input: StreamAssetInput, putOptions: AssetPutOptions): Promise<AssetStat> {
      const target = await home(putOptions.tenantId);
      if (target.putStream) return target.putStream(input, putOptions);
      const chunks: Uint8Array[] = [];
      for await (const chunk of input.stream as AsyncIterable<Uint8Array>) chunks.push(chunk);
      const data = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let at = 0;
      for (const chunk of chunks) {
        data.set(chunk, at);
        at += chunk.length;
      }
      const { stream: _stream, ...rest } = input;
      return target.put({ ...rest, location: { kind: 'bytes', data } }, putOptions);
    },
    getStream: (
      assetId: string,
      tenantId: string,
      streamOptions?: { range?: AssetByteRange },
    ): Promise<StreamAssetDescriptor | undefined> =>
      first(tenantId, (each) => each.getStream?.(assetId, tenantId, streamOptions)),
  };
  return store;
}
