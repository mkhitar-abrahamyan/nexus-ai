# Long-term memory

<!-- covers: ./store ./store/redis -->

Long-term memory from `nexus-ai-pro/store`: namespaced key-value items that outlive a run or a thread, with optional semantic search through an embedding function you inject. `MemoryStore` keeps them in process; `RedisStore`, on `nexus-ai-pro/store/redis`, shares them between processes; the Postgres adapter is in the [Postgres guide](./postgres.md).

## Long-term Memory

A checkpoint remembers one conversation. A store remembers across them:

```ts
import { MemoryStore } from 'nexus-ai-pro/store';

const store = new MemoryStore({ index: { embed, fields: ['text'] } });   // embed is yours
await store.put(['tenant-7', 'users', 'alice'], 'tone', { text: 'prefers brief answers' });

// In any node or tool, in any thread, later:
const memories = await context.store.search(['tenant-7', 'users', 'alice'], { query: 'how do they like answers?' });
```

Namespaces are tuples, so `['tenant-7', 'users', 'alice']` is both a place to put something and a
prefix to search. Items can expire with `ttlMs`, be filtered by field, and be ranked semantically by
any embedding function you inject — the store never imports the embeddings runtime, and without an
index a query falls back to matching text. `RedisStore` from `nexus-ai-pro/store/redis` carries the
same contract across processes through a client-like interface, so no Redis package is a dependency
here. `PostgresStore` from `nexus-ai-pro/postgres/store` does the same in Postgres, and ranks in the
database with pgvector when `vectorDimensions` is set.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/store`

| Export | Kind | Summary |
| --- | --- | --- |
| `cosine` | function | Cosine similarity of two vectors, from -1 to 1. |
| `MemoryStore` | class | In-process long-term memory. |
| `MemoryStoreOptions` | interface | Options for the in-memory store. |
| `Store` | interface | Long-term memory: namespaced key-value items that outlive a run, with optional semantic search. |
| `StoreIndexOptions` | interface | Turns text into vectors for semantic search. |
| `StoreItem` | interface | One remembered value, with where it lives and when it was written. |
| `StoreNamespace` | type | Path to a collection of items. |
| `StorePutOptions` | interface | Options for storing an item. |
| `StoreSearchOptions` | interface | Options for searching a namespace. |

### `nexus-ai-pro/store/redis`

| Export | Kind | Summary |
| --- | --- | --- |
| `RedisStore` | class | Long-term memory in Redis, so several processes share what an agent remembers. |
| `RedisStoreLikeClient` | interface | The subset of a Redis client this store uses. |
| `RedisStoreOptions` | interface | Options for the Redis store. |
<!-- reference:end -->
