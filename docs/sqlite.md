# SQLite

<!-- covers: ./sqlite ./sqlite/operations ./sqlite/store ./sqlite/vectors ./sqlite/migrations -->

Durable persistence on one machine with no server to run: operation records — and through them graph
and workflow checkpoints — long-term memory, and retrieval vectors, in a SQLite file. Each adapter takes the database
you already open, so no SQLite driver is a dependency of this package.

```ts
import { DatabaseSync } from 'node:sqlite';
import { OperationStoreCheckpointer } from 'nexus-ai-pro/graph';
import { SqliteOperationStore, SqliteStore } from 'nexus-ai-pro/sqlite';

const db = new DatabaseSync('agent.db');
const operations = new SqliteOperationStore(db);
const memory = new SqliteStore(db, { index: { embed } });
await operations.migrate();
await memory.migrate();

const graph = builder.compile({ checkpointer: new OperationStoreCheckpointer(operations), store: memory });
```

A thread checkpointed this way survives a restart of the process, and a second process that opens
the same file continues it. Every update is one `UPDATE … WHERE sequence = expected`, so two processes
sharing the file cannot both advance the same operation or thread.

## Drivers

`SqliteLikeClient` is the contract the adapters use: `run()` for a statement that changes rows,
reporting how many, `all()` for a query, and `exec()` for a migration. Each may answer synchronously
or with a promise, and parameters are only ever a `SqliteValue` — a string, a number, `null`, or bytes,
which every driver binds as a blob.

- **`node:sqlite`** and **`better-sqlite3`** are passed directly: a handle with `prepare()` and `exec()`,
  the `SqliteDatabaseLike` shape, is adapted automatically. `fromSqliteDatabase()` is that adapter on
  its own; it caches each prepared statement, so a statement the adapters run on every call is
  compiled once.
- **libSQL** and Turso are asynchronous: `fromLibsql()` adapts a client with `execute()` and
  `executeMultiple()`, the `LibsqlLikeClient` shape.

```ts
import { createClient } from '@libsql/client';
import { fromLibsql, SqliteOperationStore } from 'nexus-ai-pro/sqlite';

const operations = new SqliteOperationStore(fromLibsql(createClient({ url: process.env.LIBSQL_URL! })));
```

## Operation records

`SqliteOperationStore` implements the operation store contract, the same one the memory, Redis, and
Postgres stores keep, and passes the same tests. It backs an `OperationRunner`, the agent server, and —
through `OperationStoreCheckpointer` — graphs and workflows.

It does what every operation store does:

- creates, reads, and updates records, with a compare-and-set on their sequence;
- finds lapsed leases, for recovery;
- enforces unique idempotency keys; a duplicate raises `OperationDuplicateError`;
- lists records, and `prune()` deletes finished ones older than a cutoff.

`SqliteOperationStoreOptions` names the `table` (`nexus_operations`). `sqliteOperationStoreMigration()`
returns its schema, for your own tooling, and `sqliteOperationStoreMigrations()` its versions: version
2 indexes queued work by age, so a claim reads the oldest few rows instead of sorting the queue, and
version 3 indexes it by tenant.

## Long-term memory

`SqliteStore` implements the long-term store contract: namespaced items with expiry, filters, text
queries, and semantic search through the embedding function in its `index`.

The namespace prefix and expiry are matched in SQL. Filters, text queries, and semantic ranking run in
the process, with the same helpers the in-memory store uses, so every store answers a search the same
way.

`SqliteStoreOptions` takes the `table` (`nexus_store`), the `index`, and a clock. `sweep()` deletes
expired items. `sqliteStoreMigration()` returns the schema, and `sqliteStoreMigrations()` its versions.

## Retrieval vectors

`SqliteVectorStore`, on `nexus-ai-pro/sqlite/vectors`, implements the `VectorStore` contract and passes
the same contract test as every other store. Vectors are stored as float32 blobs. Metadata filters run
in SQL against the metadata JSON, and match each value's type as well as its value.

`SqliteVectorStoreOptions` sets the `dimensions`, the `table` (`nexus_vectors`), the `embed` function,
and how similarity is computed:

| `search` | How it ranks | Needs |
| --- | --- | --- |
| `scan` (default) | In JavaScript, over the rows that pass the filter. | Nothing. |
| `sqlite-vec` | Inside SQLite, with `vec_distance_cosine()`, so only the best rows leave the database. | The sqlite-vec extension, loaded into the handle first. |

`sqliteVectorStoreMigration()` returns the table's schema, and `sqliteVectorStoreMigrations()` its
versions.

```ts
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { SqliteVectorStore } from 'nexus-ai-pro/sqlite/vectors';

const db = new Database('knowledge.db');
sqliteVec.load(db);
const vectors = new SqliteVectorStore(db, { dimensions: 1536, embed, search: 'sqlite-vec' });
await vectors.migrate();
```

## Versioned migrations

Each adapter's `migrate()` applies its pending migrations and records each in
`nexus_schema_migrations` with a checksum, as the Postgres adapters do; the
[Postgres guide](./postgres.md) explains the shared types: `SchemaMigration`, `AppliedMigration`,
`MigrationStatus`, `MigrationResult`, `migrationChecksum()`, and `SchemaMigrationError`. Version 1 is
the schema 2.0 created, so a file made by 2.0 or 2.1 is recognized as it is, and an edited migration
is refused before anything runs.

Each migration runs inside `BEGIN IMMEDIATE`, which takes SQLite's write lock: its statements and the
row recording it land together or not at all, and a second process migrating the same file waits for
the first. `SqliteMigrateOptions` takes `dryRun` and the migrations `table`.

`sqliteMigrations()` lists the chosen adapters' migrations on their default tables; each is a
`SqliteAdapter` name, `operations`, `store`, or `vectors`, and all three are included by default.
`applySqliteMigrations()` and `sqliteMigrationStatus()` apply and inspect any list, from
`nexus-ai-pro/sqlite` or `nexus-ai-pro/sqlite/migrations`. `sqliteMigrationsTableStatement()` is the
statement that creates the migrations table, for your own tooling.

```ts
import { applySqliteMigrations, sqliteMigrations, sqliteMigrationStatus } from 'nexus-ai-pro/sqlite';

const status = await sqliteMigrationStatus(db, sqliteMigrations());
if (!status.current) await applySqliteMigrations(db, sqliteMigrations());
```

`nexus db migrate --client db.mjs` does the same from a shell; the [CLI guide](./cli.md) has the
details.

## Limitations

- SQLite is one machine. Several processes can share a file, but workers on several machines need
  Redis or Postgres.
- Semantic search reads every item under the prefix and ranks it in the process, which suits
  namespaces of a few thousand items; `PostgresStore` with pgvector ranks in the database.
- Vector search is exact in both modes, which suits one node's corpus. Beyond a few hundred thousand
  chunks, use pgvector or a dedicated vector database.
- `node:sqlite` is still marked experimental by Node.js and prints a warning when first loaded.
