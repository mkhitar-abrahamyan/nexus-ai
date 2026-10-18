/**
 * A media catalog: one record of every stored asset, in any long-term store, kept in step with the
 * asset stores that hold them, and searchable by what an asset is, who made it, and how it scored.
 */
import { mediaParts } from '../evaluate/trace.js';
import type { AssetStat, AssetStore } from '../images/asset-support.js';
import type { EvaluationScore } from '../types/evaluate.js';
import type { Store, StoreNamespace } from '../types/store.js';

/** What kind of medium an asset is, from its MIME type. */
export type CatalogMediaKind = 'image' | 'audio' | 'video' | 'document' | 'other';

/** The latest score of one key an asset was given. */
export interface CatalogScore {
  /** The score. */
  score: number;
  /** Whether it passed, when the evaluator judged rather than measured. */
  passed?: boolean;
  /** The evaluator's explanation. */
  comment?: string;
  /** Who gave it, such as an online evaluation's source. */
  source?: string;
  /** ISO-8601 time it was given. */
  at: string;
}

/** One stored asset, as the catalog records it. */
export interface MediaCatalogEntry {
  /** The asset's id in its store. */
  assetId: string;
  /** The tenant that owns it. */
  tenantId: string;
  /** Its kind, from its MIME type. */
  kind: CatalogMediaKind;
  /** Its MIME type. */
  mimeType: string;
  /** The store's URI for it. */
  uri: string;
  /** The asset store's name, when the catalog covers several. */
  store?: string;
  /** Its size in bytes, when known. */
  bytes?: number;
  /** Width in pixels, when known. */
  width?: number;
  /** Height in pixels, when known. */
  height?: number;
  /** Its file name, when it has one. */
  filename?: string;
  /** Its SHA-256 digest, hex-encoded, when known. */
  sha256?: string;
  /** The provider that made it, or `upload`'s provider for one brought in. */
  provider: string;
  /** The model that made it. */
  model?: string;
  /** Whether it was generated, edited, or uploaded. */
  operation: string;
  /** The request that made it. */
  requestId: string;
  /** The assets it was derived from, for an edit. */
  parentAssetIds?: string[];
  /** The run that made it, from its provenance's `runId`, when recorded. */
  runId?: string;
  /** The trace that made it, from its provenance's `traceId`, when recorded. */
  traceId?: string;
  /** Labels to find it by. */
  tags: string[];
  /** Application data. */
  metadata?: Record<string, unknown>;
  /** The latest score per key, from evaluations of it. */
  scores: Record<string, CatalogScore>;
  /** ISO-8601 time it was stored. */
  createdAt: string;
  /** ISO-8601 time it expires, when it does; the entry is never read after it. */
  expiresAt?: string;
  /** Goes up on every change, so concurrent changes are never lost. */
  version: number;
  /** Each tag as a field, so a store filters by it. */
  tagged: Record<string, true>;
}

/** What `MediaCatalog.list()` looks for. Every field narrows the match. */
export interface MediaCatalogQuery {
  /** One tenant's assets. Defaults to every tenant's. */
  tenantId?: string;
  /** Assets of this kind. */
  kind?: CatalogMediaKind;
  /** Assets of this MIME type. */
  mimeType?: string;
  /** Assets this provider made. */
  provider?: string;
  /** Assets this model made. */
  model?: string;
  /** Assets generated, edited, or uploaded. */
  operation?: string;
  /** Assets one run made. */
  runId?: string;
  /** Assets in one asset store. */
  store?: string;
  /** Assets with this tag. */
  tag?: string;
  /** Assets stored at or after this ISO-8601 time. */
  since?: string;
  /** Assets stored at or before this ISO-8601 time. */
  until?: string;
  /** Assets whose latest score for `key` is below `below`. */
  scoreBelow?: { key: string; below: number };
  /** Assets whose latest score for `key` is at least `atLeast`. */
  scoreAtLeast?: { key: string; atLeast: number };
  /** Assets with no score for this key yet. */
  unscored?: string;
  /** Most entries returned. Defaults to 50. */
  limit?: number;
  /** Where the page before ended, from its `next`. */
  cursor?: string;
  /** Most entries read to fill a page, when filters the store cannot apply skip many. Defaults to 10,000. */
  scanLimit?: number;
}

/** A page of entries, newest first. */
export interface MediaCatalogPage {
  /** The entries. */
  entries: MediaCatalogEntry[];
  /** Passed as `cursor`, the next page; absent after the last. */
  next?: string;
}

/** How much is catalogued, by kind. */
export interface MediaCatalogStats {
  /** Assets. */
  assets: number;
  /** Their bytes, of those whose size is known. */
  bytes: number;
  /** The same, per kind. */
  byKind: Partial<Record<CatalogMediaKind, { assets: number; bytes: number }>>;
  /** True when it stopped at its limit before the end. */
  truncated: boolean;
}

/** What `record()` adds to what the asset store says. */
export interface MediaCatalogRecordOptions {
  /** Labels to find it by. */
  tags?: string[];
  /** Application data. */
  metadata?: Record<string, unknown>;
  /** The asset store's name, when the catalog covers several. */
  store?: string;
  /** The run that made it, when its provenance does not say. */
  runId?: string;
  /** The trace that made it, when its provenance does not say. */
  traceId?: string;
}

/** Options for `mediaCatalog()`. */
export interface MediaCatalogOptions {
  /** Where entries are kept: any long-term store, such as the Postgres, SQLite, Redis, or memory one. */
  store: Store;
  /** The namespace entries live under, beside each tenant's id. Defaults to `['nexus', 'media']`. */
  namespace?: readonly string[];
  /** Replaces the system clock, for tests. */
  now?: () => Date;
}

/** One record of every stored asset. */
export interface MediaCatalog {
  /** Records an asset an asset store has stored, from its `AssetStat`, replacing any earlier entry. */
  record(stat: AssetStat, options?: MediaCatalogRecordOptions): Promise<MediaCatalogEntry>;
  /** Removes an asset's entry. */
  forget(assetId: string, tenantId: string): Promise<void>;
  /** One asset's entry. */
  get(assetId: string, tenantId: string): Promise<MediaCatalogEntry | undefined>;
  /** Entries that match, newest first, a page at a time. */
  list(query?: MediaCatalogQuery): Promise<MediaCatalogPage>;
  /** Records an asset's score, keeping the latest per key. Resolves to the entry, or `undefined` when there is none. */
  score(
    assetId: string,
    tenantId: string,
    score: EvaluationScore & { source?: string },
  ): Promise<MediaCatalogEntry | undefined>;
  /** Adds and removes an asset's tags. */
  tag(
    assetId: string,
    tenantId: string,
    change: { add?: string[]; remove?: string[] },
  ): Promise<MediaCatalogEntry | undefined>;
  /**
   * Records scores on every stored asset a value refers to, such as the images in a run's output,
   * and resolves to how many assets were scored: what an online evaluation's `onScored` calls.
   */
  attach(
    value: unknown,
    scores: readonly EvaluationScore[],
    options: { tenantId: string; source?: string },
  ): Promise<number>;
  /** Counts what is catalogued, reading at most `limit` entries (100,000). */
  stats(options?: { tenantId?: string; limit?: number }): Promise<MediaCatalogStats>;
  /**
   * Removes the entries of assets that expired. An expired entry is never read, so this only frees
   * the space; an asset store wrapped by `catalogedAssetStore()` calls it from `purgeExpired()`.
   * Resolves to how many went.
   */
  purgeExpired(options?: { tenantId?: string }): Promise<number>;
  /**
   * Removes entries whose asset is gone from its store, as when it was deleted around the catalog.
   * Reads at most `limit` entries (10,000).
   */
  reconcile(
    assets: Pick<AssetStore, 'stat'>,
    options?: { tenantId?: string; store?: string; limit?: number },
  ): Promise<{ checked: number; removed: number }>;
}

/** Times a change is made again after another process changed the entry first. */
const MAX_ATTEMPTS = 10;

/**
 * A media catalog in any long-term store. Give the asset stores to `catalogedAssetStore()`, and
 * every asset stored through them is recorded, its entry gone when it is deleted or expires.
 *
 * ```ts
 * const catalog = mediaCatalog({ store: new PostgresStore(pool) });
 * const assets = catalogedAssetStore(new S3AssetStore({ ... }), catalog, { name: 's3' });
 * const blurry = await catalog.list({ tenantId: 'acme', scoreBelow: { key: 'sharpness', below: 0.5 } });
 * ```
 */
export function mediaCatalog(options: MediaCatalogOptions): MediaCatalog {
  const root = [...(options.namespace ?? ['nexus', 'media'])];
  const store = options.store;
  const now = options.now ?? (() => new Date());
  const space = (tenantId: string): StoreNamespace => [...root, tenantId];

  const expired = (entry: MediaCatalogEntry): boolean =>
    entry.expiresAt !== undefined && Date.parse(entry.expiresAt) <= now().getTime();

  const write = async (entry: MediaCatalogEntry, expected: number | null): Promise<boolean> => {
    if (expired(entry)) {
      await store.delete(space(entry.tenantId), entry.assetId);
      return true;
    }
    // Compared where the store can, so two processes changing one entry never lose a change; an
    // expired entry is then never read, and `purgeExpired()` removes it.
    if (store.putIfVersion) return store.putIfVersion(space(entry.tenantId), entry.assetId, entry, expected);
    // Otherwise the store expires it itself, with the asset.
    const ttlMs = entry.expiresAt ? Date.parse(entry.expiresAt) - now().getTime() : undefined;
    await store.put(space(entry.tenantId), entry.assetId, entry, {
      index: false,
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
    return true;
  };

  const get = async (assetId: string, tenantId: string) => {
    const entry = (await store.get<MediaCatalogEntry>(space(tenantId), assetId))?.value;
    return entry && !expired(entry) ? entry : undefined;
  };

  /** Changes an entry, again on what another process wrote when it changed first. */
  const change = async (
    assetId: string,
    tenantId: string,
    edit: (entry: MediaCatalogEntry) => MediaCatalogEntry,
  ): Promise<MediaCatalogEntry | undefined> => {
    for (let attempt = 1; ; attempt += 1) {
      const current = await get(assetId, tenantId);
      if (!current) return undefined;
      const next = { ...edit(current), version: current.version + 1 };
      if (await write(next, current.version)) return next;
      if (attempt >= MAX_ATTEMPTS) {
        throw new Error(`The catalog entry for asset ${assetId} changed ${attempt} times while it was being changed`);
      }
    }
  };

  const matches = (entry: MediaCatalogEntry, query: MediaCatalogQuery): boolean => {
    if (expired(entry)) return false;
    if (query.since && entry.createdAt < query.since) return false;
    if (query.until && entry.createdAt > query.until) return false;
    if (query.scoreBelow) {
      const scored = entry.scores[query.scoreBelow.key];
      if (!scored || scored.score >= query.scoreBelow.below) return false;
    }
    if (query.scoreAtLeast) {
      const scored = entry.scores[query.scoreAtLeast.key];
      if (!scored || scored.score < query.scoreAtLeast.atLeast) return false;
    }
    if (query.unscored && entry.scores[query.unscored]) return false;
    return true;
  };

  const catalog: MediaCatalog = {
    async record(stat, recordOptions = {}) {
      const descriptor = stat.descriptor;
      const provenance = descriptor.provenance;
      const from = (provenance.metadata ?? {}) as { runId?: unknown; traceId?: unknown };
      const runId = recordOptions.runId ?? (typeof from.runId === 'string' ? from.runId : undefined);
      const traceId = recordOptions.traceId ?? (typeof from.traceId === 'string' ? from.traceId : undefined);
      const tags = [...new Set(recordOptions.tags ?? [])];
      const location = descriptor.location as { uri?: string };
      // The stored entry as it is, expired or not, since a write is compared with its version; only
      // one still live hands on its scores.
      const stored = (await store.get<MediaCatalogEntry>(space(stat.tenantId), stat.assetId))?.value;
      const previous = stored && !expired(stored) ? stored : undefined;
      const entry: MediaCatalogEntry = {
        assetId: stat.assetId,
        tenantId: stat.tenantId,
        kind: kindOf(descriptor.mimeType),
        mimeType: descriptor.mimeType,
        uri: location.uri ?? '',
        ...(recordOptions.store ? { store: recordOptions.store } : {}),
        ...(descriptor.byteLength === undefined ? {} : { bytes: descriptor.byteLength }),
        ...(descriptor.width === undefined ? {} : { width: descriptor.width }),
        ...(descriptor.height === undefined ? {} : { height: descriptor.height }),
        ...(descriptor.filename ? { filename: descriptor.filename } : {}),
        ...(descriptor.checksum?.algorithm === 'sha256' ? { sha256: descriptor.checksum.value } : {}),
        provider: provenance.provider,
        ...(provenance.model ? { model: provenance.model } : {}),
        operation: provenance.operation,
        requestId: provenance.requestId,
        ...(provenance.parentAssetIds?.length ? { parentAssetIds: [...provenance.parentAssetIds] } : {}),
        ...(runId ? { runId } : {}),
        ...(traceId ? { traceId } : {}),
        tags,
        ...(recordOptions.metadata ? { metadata: recordOptions.metadata } : {}),
        // An asset stored again under its id keeps the scores it was given.
        scores: previous?.scores ?? {},
        createdAt: stat.createdAt,
        ...(stat.expiresAt ? { expiresAt: stat.expiresAt } : {}),
        version: (stored?.version ?? 0) + 1,
        tagged: Object.fromEntries(tags.map((tag) => [tag, true as const])),
      };
      if (!(await write(entry, stored ? stored.version : null))) {
        // Recorded by another process meanwhile: this record replaces it, keeping its scores.
        return (
          (await change(stat.assetId, stat.tenantId, (current) => ({ ...entry, scores: current.scores }))) ?? entry
        );
      }
      return entry;
    },

    async forget(assetId, tenantId) {
      await store.delete(space(tenantId), assetId);
    },

    get,

    async list(query = {}) {
      const limit = Math.max(1, query.limit ?? 50);
      const filter: Record<string, unknown> = {};
      for (const field of ['kind', 'mimeType', 'provider', 'model', 'operation', 'runId', 'store'] as const) {
        if (query[field] !== undefined) filter[field] = query[field];
      }
      if (query.tag !== undefined) filter[`tagged.${query.tag}`] = true;
      const prefix = query.tenantId === undefined ? root : space(query.tenantId);
      const page = Math.max(limit, 100);
      const scanLimit = query.scanLimit ?? 10_000;
      let offset = query.cursor ? Number(query.cursor) : 0;
      let scanned = 0;
      const entries: MediaCatalogEntry[] = [];
      for (;;) {
        const items = await store.search<MediaCatalogEntry>(prefix, { filter, limit: page, offset });
        for (let index = 0; index < items.length; index += 1) {
          const entry = items[index]?.value as MediaCatalogEntry;
          if (!matches(entry, query)) continue;
          entries.push(entry);
          if (entries.length === limit) {
            const more = index + 1 < items.length || items.length === page;
            return { entries, ...(more ? { next: String(offset + index + 1) } : {}) };
          }
        }
        offset += items.length;
        scanned += items.length;
        if (items.length < page) return { entries };
        if (scanned >= scanLimit) return { entries, next: String(offset) };
      }
    },

    score(assetId, tenantId, score) {
      const at = now().toISOString();
      return change(assetId, tenantId, (entry) => ({
        ...entry,
        scores: {
          ...entry.scores,
          [score.key]: {
            score: score.score,
            ...(score.passed === undefined ? {} : { passed: score.passed }),
            ...(score.comment ? { comment: score.comment } : {}),
            ...(score.source ? { source: score.source } : {}),
            at,
          },
        },
      }));
    },

    tag(assetId, tenantId, edit) {
      return change(assetId, tenantId, (entry) => {
        const tags = [...new Set([...entry.tags, ...(edit.add ?? [])])].filter((tag) => !edit.remove?.includes(tag));
        return { ...entry, tags, tagged: Object.fromEntries(tags.map((tag) => [tag, true as const])) };
      });
    },

    async attach(value, scores, attachOptions) {
      const ids = new Set<string>();
      for (const part of mediaParts(value)) {
        const location =
          part.type === 'asset'
            ? part.asset.location
            : ((part.source as { asset?: { location?: { kind?: string; assetId?: string } } }).asset?.location ?? {});
        if (location.kind === 'stored' && typeof (location as { assetId?: unknown }).assetId === 'string') {
          ids.add((location as { assetId: string }).assetId);
        }
      }
      let scored = 0;
      for (const assetId of ids) {
        let entry: MediaCatalogEntry | undefined;
        for (const score of scores) {
          entry = await catalog.score(assetId, attachOptions.tenantId, {
            ...score,
            ...(attachOptions.source ? { source: attachOptions.source } : {}),
          });
          if (!entry) break;
        }
        if (entry) scored += 1;
      }
      return scored;
    },

    async stats(statsOptions = {}) {
      const limit = statsOptions.limit ?? 100_000;
      const prefix = statsOptions.tenantId === undefined ? root : space(statsOptions.tenantId);
      const stats: MediaCatalogStats = { assets: 0, bytes: 0, byKind: {}, truncated: false };
      for (let offset = 0; ; ) {
        const items = await store.search<MediaCatalogEntry>(prefix, { limit: 500, offset });
        for (const item of items) {
          const entry = item.value;
          if (expired(entry)) continue;
          const kind = stats.byKind[entry.kind] ?? { assets: 0, bytes: 0 };
          stats.byKind[entry.kind] = kind;
          stats.assets += 1;
          kind.assets += 1;
          stats.bytes += entry.bytes ?? 0;
          kind.bytes += entry.bytes ?? 0;
        }
        offset += items.length;
        if (items.length < 500) return stats;
        if (offset >= limit) return { ...stats, truncated: true };
      }
    },

    async purgeExpired(purgeOptions = {}) {
      const prefix = purgeOptions.tenantId === undefined ? root : space(purgeOptions.tenantId);
      let removed = 0;
      for (let offset = 0; ; ) {
        const items = await store.search<MediaCatalogEntry>(prefix, { limit: 200, offset });
        let kept = 0;
        for (const item of items) {
          if (expired(item.value)) {
            await store.delete(item.namespace, item.key);
            removed += 1;
          } else kept += 1;
        }
        offset += kept;
        if (items.length < 200) return removed;
      }
    },

    async reconcile(assets, reconcileOptions = {}) {
      const limit = reconcileOptions.limit ?? 10_000;
      const prefix = reconcileOptions.tenantId === undefined ? root : space(reconcileOptions.tenantId);
      const filter = reconcileOptions.store === undefined ? undefined : { store: reconcileOptions.store };
      let checked = 0;
      let removed = 0;
      for (let offset = 0; checked < limit; ) {
        const items = await store.search<MediaCatalogEntry>(prefix, {
          limit: 200,
          offset,
          ...(filter ? { filter } : {}),
        });
        let kept = 0;
        for (const item of items) {
          checked += 1;
          const entry = item.value;
          if (await assets.stat(entry.assetId, entry.tenantId)) kept += 1;
          else {
            await catalog.forget(entry.assetId, entry.tenantId);
            removed += 1;
          }
        }
        // What was removed is no longer there to skip.
        offset += kept;
        if (items.length < 200) break;
      }
      return { checked, removed };
    },
  };
  return catalog;
}

/** Options for `catalogedAssetStore()`. */
export interface CatalogedAssetStoreOptions {
  /** The store's name, recorded on each entry, when the catalog covers several stores. */
  name?: string;
  /** Tags each asset is recorded with, from what was stored. */
  tags?: (stat: AssetStat) => string[] | undefined;
  /**
   * Hears a failure to record an asset, which then stays stored, uncatalogued. Without it, the asset
   * is deleted again and the store's `put()` rejects, so the catalog and the store always agree.
   */
  onError?: (error: unknown, stat: AssetStat) => void;
}

/**
 * Wraps an asset store so the catalog records every asset stored through it, and forgets every asset
 * deleted through it. An entry expires with its asset, and `purgeExpired()` removes both. Everything
 * else about the store is its own.
 */
export function catalogedAssetStore(
  assets: AssetStore,
  catalog: MediaCatalog,
  options: CatalogedAssetStoreOptions = {},
): AssetStore {
  const recorded = async (stat: AssetStat): Promise<AssetStat> => {
    try {
      const tags = options.tags?.(stat);
      await catalog.record(stat, {
        ...(options.name ? { store: options.name } : {}),
        ...(tags?.length ? { tags } : {}),
      });
    } catch (error) {
      if (options.onError) {
        options.onError(error, stat);
        return stat;
      }
      await Promise.resolve(assets.delete(stat.assetId, stat.tenantId)).catch(() => undefined);
      throw error;
    }
    return stat;
  };
  const put: AssetStore['put'] = async (input, putOptions) => recorded(await assets.put(input, putOptions));
  const putStream: NonNullable<AssetStore['putStream']> = async (input, putOptions) =>
    recorded(await (assets.putStream as NonNullable<AssetStore['putStream']>).call(assets, input, putOptions));
  const remove: AssetStore['delete'] = async (assetId, tenantId) => {
    const deleted = await assets.delete(assetId, tenantId);
    await catalog.forget(assetId, tenantId);
    return deleted;
  };
  const purgeExpired: AssetStore['purgeExpired'] = async () => {
    const purged = await assets.purgeExpired();
    await catalog.purgeExpired();
    return purged;
  };
  return new Proxy(assets, {
    get(target, property) {
      if (property === 'put') return put;
      if (property === 'putStream') return target.putStream ? putStream : undefined;
      if (property === 'delete') return remove;
      if (property === 'purgeExpired') return purgeExpired;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function kindOf(mimeType: string): CatalogMediaKind {
  const family = mimeType.split('/')[0];
  if (family === 'image' || family === 'audio' || family === 'video') return family;
  if (mimeType === 'application/pdf' || family === 'text') return 'document';
  return 'other';
}
