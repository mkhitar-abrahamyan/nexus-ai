import { createHash } from 'node:crypto';
import type { CacheAdapter } from '../cache/adapters.js';
import type { NodeCacheEntry, NodeCachePolicy } from '../types/graph.js';

/**
 * Per-node result caching for a compiled graph.
 *
 * Loaded the first time a node that declares `cache` runs, so a graph that never caches carries none
 * of it.
 */

const DEFAULT_TTL_MS = 5 * 60_000;

/** @internal */
export class NodeCache {
  /** Created the first time a caching node has no store of its own, and not before. */
  private fallback: MemoryNodeCache | undefined;

  constructor(
    private readonly graphName: string,
    private readonly graphStore: CacheAdapter<NodeCacheEntry> | undefined,
    private readonly clock: () => number,
  ) {}

  /** The key for one task, or `undefined` when its state cannot be keyed safely. */
  key(policy: NodeCachePolicy, node: string, state: unknown, input: unknown): string | undefined {
    if (policy.key) return policy.key({ node, state, ...(input === undefined ? {} : { input }) });
    const material = keyMaterial({ graph: this.graphName, node, state, input });
    return material === undefined ? undefined : `nexus-graph:${createHash('sha256').update(material).digest('hex')}`;
  }

  // A cache that cannot be read or written is a miss, never a failed node: the node's own result is
  // always a correct answer, and a cache outage should cost time rather than correctness.
  async read(policy: NodeCachePolicy, key: string): Promise<NodeCacheEntry | undefined> {
    try {
      return (await this.store(policy).get(key)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  async write(policy: NodeCachePolicy, key: string, entry: NodeCacheEntry): Promise<void> {
    const ttlMs = policy.ttlMs ?? DEFAULT_TTL_MS;
    const store = this.store(policy);
    try {
      if (store instanceof MemoryNodeCache) store.put(key, entry, ttlMs);
      else await store.set(key, entry, Math.max(1, Math.ceil(ttlMs / 1000)));
    } catch {
      // See read().
    }
  }

  private store(policy: NodeCachePolicy): CacheAdapter<NodeCacheEntry> | MemoryNodeCache {
    if (policy.store) return policy.store;
    if (this.graphStore) return this.graphStore;
    this.fallback ??= new MemoryNodeCache(this.clock);
    return this.fallback;
  }
}

/** The default store: bounded, in process, and cloned in and out so a caller cannot mutate it. */
class MemoryNodeCache {
  private readonly entries = new Map<string, { entry: NodeCacheEntry; expiresAt: number }>();

  constructor(private readonly clock: () => number) {}

  get(key: string): NodeCacheEntry | undefined {
    const found = this.entries.get(key);
    if (!found) return undefined;
    if (found.expiresAt <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    return structuredClone(found.entry);
  }

  put(key: string, entry: NodeCacheEntry, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { entry: structuredClone(entry), expiresAt: this.clock() + ttlMs });
    while (this.entries.size > 1_000) this.entries.delete(this.entries.keys().next().value as string);
  }
}

/**
 * Deterministic text for a cache key, or `undefined` when the value cannot be keyed safely.
 *
 * Object keys are sorted so the same state always hashes the same. A Map, a Set, or a class
 * instance would serialize as `{}` and let two different states share a key, so they make the
 * default key refuse rather than return a stale result; a `key` function can handle them.
 */
function keyMaterial(value: unknown): string | undefined {
  // Ancestors only: the same object reached twice by different paths is fine, a cycle is not.
  const ancestors = new Set<object>();
  const normalize = (current: unknown): unknown => {
    if (current === undefined) return { $undefined: true };
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') return Number.isFinite(current) ? current : { $number: String(current) };
    if (typeof current !== 'object') throw new TypeError('unkeyable');
    if (current instanceof Date) return { $date: current.toISOString() };
    if (current instanceof Uint8Array) return { $bytes: createHash('sha256').update(current).digest('hex') };
    if (ancestors.has(current)) throw new TypeError('circular');
    const prototype = Object.getPrototypeOf(current);
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('unkeyable');
    }
    ancestors.add(current);
    const normalized = Array.isArray(current)
      ? current.map(normalize)
      : Object.keys(current)
          .sort()
          .map((key) => [key, normalize((current as Record<string, unknown>)[key])]);
    ancestors.delete(current);
    return normalized;
  };
  try {
    return JSON.stringify(normalize(value));
  } catch {
    return undefined;
  }
}
