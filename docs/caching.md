# Caching

<!-- covers: ./cache ./cache/adapters ./cache/memory-cache ./cache/semantic-cache -->

Response caching from `nexus-ai-pro/cache`: an exact cache keyed by the request, a semantic cache that reuses the answer to a request that means nearly the same, and memory, Redis, and SQLite adapters for where cached values live.

## Configuring the cache

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
```

Available runtime helpers:

- exact and semantic cache
- Redis and SQLite cache adapters
- batch completion with concurrency control
- in-memory job queue
- Redis and BullMQ queue adapters
- eval runner with quality, operations, RAG, safety metrics, and optional LLM-as-judge scoring
- voice sessions for multi-turn calls with conditional task prompts and app tools
- realtime sessions with WebRTC/WebSocket transports, interruption, tools, metrics, and conversation exports
- workflow templates for RAG answers, extraction, classification, comparison, support, sales, legal review, and code review

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
