# Long-term memory

<!-- covers: ./store ./store/redis -->

Long-term memory from `nexus-ai-pro/store`: namespaced key-value items that outlive a run or a thread, with optional semantic search through an embedding function you inject. `MemoryStore` keeps them in process; `RedisStore`, on `nexus-ai-pro/store/redis`, shares them between processes; the Postgres and SQLite adapters are in the [Postgres](./postgres.md) and [SQLite](./sqlite.md) guides.

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
database with pgvector when `vectorDimensions` is set. `SqliteStore` from `nexus-ai-pro/sqlite/store`
keeps the same contract in one SQLite file.

## The contract

`Store` is five methods, and every adapter implements all of them. Each may answer synchronously or
with a promise, so the in-memory store costs no microtask on a read:

- `put()` stores a value under a namespace and key, replacing any item already there and keeping its
  original creation time.
- `get()` reads one, or returns `undefined` when it does not exist or has expired.
- `delete()` removes one.
- `search()` returns the items under a namespace prefix, newest first, or ranked by similarity when a
  query is given.
- `listNamespaces()` lists the namespaces under a prefix, for browsing what an agent remembered.

A `StoreNamespace` is a tuple of strings. A `StoreItem` carries its namespace and key, the value, when
it was created and last written, when it expires, and — on semantic search results — its `score`.

`StorePutOptions` sets a lifetime with `ttlMs`, and which fields of the value to embed with `index`:
dot paths into the value, the store's configured fields by default, or `false` to store the item
without indexing it. `StoreSearchOptions` takes a natural-language `query`, a `filter` of exact
matches on dot-path fields, and `limit` (20 by default) and `offset` for paging.

## Semantic search

`StoreIndexOptions` turns search on: an `embed` function that turns a batch of texts into vectors,
and the `fields` to embed, every string field in the value by default. Items are embedded when they
are written, and a query is embedded when it is searched, then ranked with `cosine()` — cosine
similarity, from -1 to 1, which is exported for adapters of your own. Pass the embeddings family as
the `embed` function to inherit its routing, batching, and caching. Without an index, a query is a
case-insensitive text match over the stored values: useful, and not semantic.

## The adapters

`MemoryStoreOptions` gives the in-memory store its `index`, `maxItems` — 10,000 by default, after
which the least recently written item is dropped, so a store that only grows cannot leak — and a
`now` clock for tests. `size()` counts the items it holds.

`RedisStore` takes a `RedisStoreLikeClient` — `get`, `set` with `PX` expiry, `del`, `sadd`, `srem`,
and `smembers`, which `ioredis` and `node-redis` both provide — and `RedisStoreOptions` with a key
`prefix` (`nexus:store` by default, so one Redis can hold several stores), an `index`, and a clock.
Expiry is Redis's own TTL, and each namespace keeps a set of its keys, so a prefix search never scans
the keyspace.

```ts
import Redis from 'ioredis';
import { RedisStore } from 'nexus-ai-pro/store/redis';

const store = new RedisStore(new Redis(process.env.REDIS_URL!), { prefix: 'support:memory', index: { embed } });
```

Hand a store to a graph with `compile({ store })`, and nodes reach it as `context.store`. Hand it to
an agent with `createAgent({ store })`, and its tools and middleware receive it as `store`.

## Limitations

- Semantic search ranks in the process for the memory and Redis stores: every item under the prefix
  is read and scored. Keep namespaces focused, or use `PostgresStore` with pgvector, which ranks in
  the database.
- The Redis, Postgres, and SQLite stores keep values as JSON, so a value must survive `JSON.stringify()`. The
  memory store holds the object itself, so mutating it after `put()` changes what is stored.

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
