# Caching

<!-- covers: ./cache ./cache/adapters ./cache/memory-cache ./cache/semantic-cache -->

Response caching, from `nexus-ai-pro/cache`. The exact cache answers a request it has seen before. The
semantic cache also answers a request that means nearly the same. Cached values live in memory, Redis,
or SQLite.

## Two caches, one switch

There are two response caches, and `strategy` picks which run:

| Strategy | What it reuses |
| --- | --- |
| `exact` | A request whose key matches exactly: same model, messages, and sampling settings |
| `semantic` | A request that *means* nearly the same as an earlier one |
| `hybrid` | Exact first, then semantic. The default worth using: an exact hit costs no embedding |

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  cache: {
    enabled: true,
    strategy: 'hybrid',
    ttlSeconds: 600,
    semantic: { enabled: true, similarityThreshold: 0.86 },
  },
});

const response = await ai.complete(request);
response.meta.cacheHit; // true when the answer came from a cache
```

Caching is off until `enabled` is set, so nothing is reused by accident. `ai.clearExpiredCache()`
removes lapsed entries and returns how many went; `ai.getCacheStats()` reports size, capacity, and
expired entries not yet swept.

## Namespaces and outcomes

A cached response is reused only within its namespace. `CacheConfig.namespace` sets one, fixed or
computed per request, as a `CacheNamespace`: the `tenant` (the request's `tenantId` by default), the
`environment`, a `modelRevision`, and a `contextVersion`. Changing the revision or the context
version starts from an empty cache, so a prompt or model change never serves answers written for the
old one. Without a namespace, exact-cache keys are what they were before 2.2.

```ts
const ai = new NexusAI({
  providers,
  cache: {
    enabled: true,
    strategy: 'hybrid',
    namespace: (request) => ({ environment: 'production', contextVersion: String(request.metadata?.context ?? '') }),
  },
});
```

The semantic cache only ever matches entries of the same tenant, namespace or not: before 2.2, a
tenant asking another tenant's question could be answered with that tenant's response.

Every response carries what the cache did as `meta.cache`, a `CacheOutcome`, which the request's
trace records too:

| `outcome` | Meaning |
| --- | --- |
| `hit` | Answered from the exact or the semantic `layer`. |
| `miss` | Looked, found nothing. |
| `stale` | Found an entry that had expired. |
| `bypass` | The request skipped the lookup: `responseCache: 'bypass'` neither reads nor writes, and `'refresh'` writes the fresh answer. |
| `error` | The cache failed; the request went to the provider as on a miss. |

Each has a `reason` and the `namespace` it ran in, and `writeError` says when storing the answer
failed — the answer is returned either way. A cache that throws never fails a request.

This is the library's own cache, which stores whole responses. It is unrelated to provider-side
prompt caching, which discounts the *input* tokens of a long shared prefix and is covered in the
[client guide](./core.md).

## The exact cache

`MemoryCache` is the store behind it: a bounded cache with per-entry expiry that evicts the least
recently used entry when full, holding 500 entries by default. `CacheEntry` is what it holds — the
value and when it expires — and its `get`, `set`, `delete`, `clear`, `clearExpired`, and `stats`
methods are the whole surface, with `lookup()`, which also says whether a missing value had expired.

The key is what decides whether two requests are "the same". `createCacheKey()` builds it from any
value with object keys sorted, so two requests that differ only in property order share a key, and
circular structures and dates do not throw:

```ts
import { createCacheKey, MemoryCache } from 'nexus-ai-pro/cache/memory-cache';

const cache = new MemoryCache<string>(1_000);
cache.set(createCacheKey({ model, messages }), answer, 300);
```

## The semantic cache

`SemanticCache` answers a request that means nearly the same as an earlier one. It embeds the
request, compares it with what it holds, and returns the closest entry above `similarityThreshold`.
The default, 0.88, is high enough that "reset my password" never answers "cancel my account".
`SemanticCacheOptions` also sets `maxEntries`, `ttlSeconds`, and `embed`. `get()` and `set()` take a
`scope`, and a lookup compares only entries stored under the same one; the client passes the
request's tenant and namespace.

`embed` is the part worth configuring. The default is hashed term vectors, which need no provider and
suit tests; for production, pass an embedding function so similarity means what you expect:

```ts
import { SemanticCache } from 'nexus-ai-pro/cache/semantic-cache';
import { toEmbeddingFunction } from 'nexus-ai-pro/embeddings';

const cache = new SemanticCache({
  enabled: true,
  similarityThreshold: 0.9,
  embed: toEmbeddingFunction(ai, { model: 'text-embedding-3-small' }),
});
```

A semantic lookup costs an embedding call, which is why `hybrid` tries the exact key first.

## Where cached values live

`CacheAdapter` is the storage contract: `get`, `set` with a TTL, `delete`, and `clear`, each of which
may be synchronous or asynchronous. Three adapters ship:

| Adapter | Entry point | Use it for |
| --- | --- | --- |
| `MemoryCacheAdapter` | `/cache/adapters` | One process. Expired entries are dropped when read |
| `RedisCacheAdapter` | `/cache/adapters` | Sharing a cache between processes; values are JSON under a key prefix |
| `SQLiteCacheAdapter` | `/cache/adapters` | One machine, surviving restarts |

The Redis and SQLite adapters take the client you already have, so neither library is a dependency.
`RedisLikeClient` is the `get`, `set`, and `del` of an `ioredis`-style client. `SQLiteLikeDatabase` is the
`prepare` and `exec` of a `better-sqlite3` handle:

```ts
import { RedisCacheAdapter, SQLiteCacheAdapter } from 'nexus-ai-pro/cache/adapters';

const shared = new RedisCacheAdapter(redis, 'nexus:cache:');
const local = new SQLiteCacheAdapter(new Database('cache.db'));
```

Writing your own adapter is implementing those four methods against whatever store you already run.

## Limitations

- A process-memory cache is per replica: two replicas each keep their own, and neither sees the
  other's hits. Use the Redis adapter when that matters.
- Default hash embeddings make the semantic cache cheap but crude. Give it a real embedding function
  before trusting it in production.
- Keep the semantic cache off latency-sensitive routes unless the embedding call is cheaper than the
  completion it saves.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/cache/adapters`

| Export | Kind | Summary |
| --- | --- | --- |
| `CacheAdapter` | interface | Where cached values live. |
| `MemoryCacheAdapter` | class | Cache values in process memory. |
| `RedisCacheAdapter` | class | Cache values in Redis, shared across processes. |
| `RedisLikeClient` | interface | The Redis commands the cache adapter needs, in `ioredis` argument order. |
| `SQLiteCacheAdapter` | class | Cache values in a SQLite table, for a single-machine cache that survives restarts. |
| `SQLiteLikeDatabase` | interface | The part of a SQLite database handle the cache adapter needs, as `better-sqlite3` provides it. |

### `nexus-ai-pro/cache/memory-cache`

| Export | Kind | Summary |
| --- | --- | --- |
| `CacheEntry` | interface | A cached value and when it expires. |
| `createCacheKey` | function | A cache key for any value, with object keys sorted so equal values give equal keys. |
| `MemoryCache` | class | A bounded in-memory cache with per-entry expiry, evicting the least recently used entry when full. |

### `nexus-ai-pro/cache/semantic-cache`

| Export | Kind | Summary |
| --- | --- | --- |
| `SemanticCache` | class | Reuses a cached response for a request that means nearly the same as an earlier one, not only one that is identical. |
| `SemanticCacheOptions` | interface | Options for the semantic response cache. |
<!-- reference:end -->
