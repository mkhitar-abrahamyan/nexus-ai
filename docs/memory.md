# Long-term memory

<!-- covers: ./store ./store/redis -->

A checkpoint remembers one conversation. A store remembers across them. `nexus-ai-pro/store` keeps
namespaced items that outlive a run or a thread, with optional semantic search through an embedding
function you inject.

```ts
import { MemoryStore } from 'nexus-ai-pro/store';

const store = new MemoryStore({ index: { embed, fields: ['text'] } }); // embed is yours
await store.put(['tenant-7', 'users', 'alice'], 'tone', { text: 'prefers brief answers' });

// In any node or tool, in any thread, later:
const memories = await context.store.search(['tenant-7', 'users', 'alice'], { query: 'how do they like answers?' });
```

A namespace is a tuple, so `['tenant-7', 'users', 'alice']` is both a place to put something and a
prefix to search. Items can expire with `ttlMs`, and can be filtered by field.

| Store | Where | Guide |
| --- | --- | --- |
| `MemoryStore` | This process. | Here. |
| `RedisStore` | Redis, shared between processes. From `nexus-ai-pro/store/redis`. | Here. |
| `PostgresStore` | Postgres, ranking in the database with pgvector. | [Postgres](./postgres.md) |
| `SqliteStore` | One SQLite file. | [SQLite](./sqlite.md) |

The store never imports the embeddings runtime. Without an index, a query matches text instead.

## The contract

`Store` is five methods, and every adapter has all of them. Each may answer synchronously or with a
promise, so a read from the in-memory store costs no microtask.

| Method | What it does |
| --- | --- |
| `put()` | Stores a value under a namespace and key. It replaces any item there, keeping its creation time. |
| `get()` | Reads one item, or returns `undefined` when it does not exist or has expired. |
| `delete()` | Removes one item. |
| `search()` | Returns the items under a namespace prefix, newest first, or ranked by similarity to a query. |
| `listNamespaces()` | Lists the namespaces under a prefix, for browsing what an agent remembered. |

`putIfVersion()` is optional. It stores an item only when the stored one's `version` field is still
the version given, or, given `null`, only when none is stored, and it resolves whether it wrote. The
check and the write are one atomic step in every included store, so two processes deciding on one
version cannot both write. The memory, Postgres, and SQLite stores have it, and so does the Redis
store when its client has `eval`. Deployments use it to change atomically across replicas.

A `StoreNamespace` is a tuple of strings. A `StoreItem` carries:

- its namespace and key, and the value;
- when it was created and last written, and when it expires;
- on semantic search results, its `score`.

`StorePutOptions` has two fields:

- `ttlMs` sets a lifetime.
- `index` names the fields of the value to embed, as dot paths. It defaults to the store's configured
  fields; `false` stores the item without indexing it.

`StoreSearchOptions` has four:

- `query`, a natural-language question;
- `filter`, exact matches on dot-path fields;
- `limit`, 20 by default, and `offset`, for paging.

## Semantic search

`StoreIndexOptions` turns search on:

- `embed` turns a batch of texts into vectors. Pass the embeddings family's function to inherit its
  routing, batching, and caching.
- `fields` names what to embed. By default, every string field in the value.

Items are embedded when they are written. A query is embedded when it is searched, then ranked with
`cosine()`: cosine similarity, from -1 to 1. It is exported for adapters of your own.

Without an index, a query is a case-insensitive text match over the stored values. That is useful,
but not semantic.

## The adapters

`MemoryStoreOptions` has three fields:

| Field | Default | What it does |
| --- | --- | --- |
| `index` | none | Semantic search, as above. |
| `maxItems` | 10,000 | Past this, the least recently written item is dropped, so a store that only grows cannot leak. |
| `now` | the clock | Replaces the clock, for tests. |

`size()` counts the items it holds.

`RedisStore` takes a `RedisStoreLikeClient` and `RedisStoreOptions`:

```ts
import Redis from 'ioredis';
import { RedisStore } from 'nexus-ai-pro/store/redis';

const store = new RedisStore(new Redis(process.env.REDIS_URL!), { prefix: 'support:memory', index: { embed } });
```

The client needs six commands: `get`, `set` with `PX` expiry, `del`, `sadd`, `srem`, and `smembers`.
An `ioredis` client has them as it is; wrap another client in those six. `RedisStoreOptions` sets a key
`prefix` (`nexus:store` by default, so one Redis can hold several stores), an `index`, and a clock.

Expiry is Redis's own TTL. Each namespace keeps a set of its keys, so a prefix search never scans the
keyspace.

## Using a store

- In a graph: `compile({ store })`, and nodes reach it as `context.store`.
- In an agent: `createAgent({ store })`, and its tools and middleware receive it as `store`.

## Limitations

- The memory, Redis, and SQLite stores rank semantic search in the process. Every item under the
  prefix is read and scored, so keep namespaces focused. `PostgresStore` with pgvector ranks in the
  database.
- The Redis, Postgres, and SQLite stores keep values as JSON, so a value must survive
  `JSON.stringify()`. The memory store holds the object itself, so changing it after `put()` changes
  what is stored.

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
