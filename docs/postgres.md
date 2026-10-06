# Postgres

<!-- covers: ./postgres ./postgres/operations ./postgres/store ./postgres/traces ./postgres/evaluate ./postgres/circuits ./postgres/prompts ./postgres/vectors ./postgres/fulltext ./postgres/migrations ./postgres/rollups -->

Postgres storage for everything that has to outlive a process or be shared between workers: durable
operations and graph checkpoints, long-term memory, traces and their hourly rollups, datasets and
experiments, shared circuit state, prompt versions, and retrieval vectors with pgvector. Every schema
is versioned, so an upgrade applies only what changed.

Each adapter has its own entry point and works with the Postgres client you already use. None creates
a schema until you ask. `PostgresPromptStore` is covered in the [prompts guide](./prompts.md).

## Overview

One adapter family for everything that has to outlive a process or be shared between workers, over
the Postgres client you already have:

```ts
import pg from 'pg';
import { PostgresOperationStore, PostgresStore, PostgresTraceStore } from 'nexus-ai-pro/postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const operations = new PostgresOperationStore(pool);
await operations.migrate(); // or: nexus db migrate --client db.mjs
```

| Adapter | Subpath | Serves |
| --- | --- | --- |
| `PostgresOperationStore` | `/postgres/operations` | durable operations, and graph checkpoints through `OperationStoreCheckpointer` |
| `PostgresStore` | `/postgres/store` | long-term memory, ranked by pgvector when `vectorDimensions` is set |
| `PostgresTraceStore` | `/postgres/traces` | traces, with every query filter in SQL |
| `PostgresDatasetStore`, `PostgresExperimentStore` | `/postgres/evaluate` | datasets and experiments |
| `PostgresCircuitStateStore` | `/postgres/circuits` | circuit state shared between workers, and the failure window they count together |
| `PostgresRollupStore` | `/postgres/rollups` | hourly totals of runs, for dashboards |
| `PostgresVectorStore` | `/postgres/vectors` | retrieval chunks, ranked by pgvector in the database |

**No driver is a dependency.** Each adapter takes anything with a `query(text, values)` method that
resolves to `{ rows }`: `pg`'s `Pool` and `Client`, `@neondatabase/serverless`, PGlite.
`fromPostgresJs(sql)` adapts `postgres.js`. Parameters are only ever strings, numbers, and `null`,
cast in SQL, so a driver's own conversion of arrays or dates never changes what is stored.

**Nothing creates a schema at import.** `migrate()` applies an adapter's pending migrations when you
call it, and `nexus db migrate` does it for every adapter. `postgresMigration()` and `nexus db sql`
produce the same SQL for the migration tooling you already use. Table names are options,
schema-qualified if you like.

**What Postgres adds over the other stores:**

- An operation update is one `UPDATE … WHERE sequence = expected`, atomic without a transaction.
- Idempotency keys are unique in the table. When two workers race to submit the same key, the loser
  attaches to the winner's operation instead of running the work twice.
- Trace feedback is appended in one statement, so two evaluators scoring one run at once both land.

A graph thread started on one worker and finished on another is the same code as before, pointed at a
different store:

```ts
const graph = builder.compile({ checkpointer: new OperationStoreCheckpointer(new PostgresOperationStore(pool)) });
```

The adapters are tested on every run against a real Postgres engine — PGlite, PostgreSQL compiled to
WebAssembly — with the same contract tests the in-memory stores pass.

## The client contract

`PostgresLikeClient` is the one method every adapter needs: `query(text, values)`, resolving to
`{ rows }` and, optionally, a `rowCount`. `PostgresJsLike` is the part of a `postgres.js` instance
that `fromPostgresJs()` adapts — its `unsafe(text, values)` — so the tagged-template driver works too:

```ts
import postgres from 'postgres';
import { fromPostgresJs, PostgresTraceStore } from 'nexus-ai-pro/postgres';

const traces = new PostgresTraceStore(fromPostgresJs(postgres(process.env.DATABASE_URL!)));
```

Every adapter selects jsonb as text and parses it itself, because drivers disagree about whether
they parse jsonb; reading text everywhere is what makes every driver return the same value.

## Options and schemas

Each adapter takes an options object whose `table` names its table, optionally as `schema.table`. A
name that is not letters, digits, and underscores is refused, so a table option can never inject SQL.

| Options | Fields |
| --- | --- |
| `PostgresOperationStoreOptions` | `table` (`nexus_operations`). |
| `PostgresStoreOptions` | `table` (`nexus_store`); the `index` that embeds items for semantic search; `vectorDimensions`, to store embeddings in a pgvector column and rank in the database; and a `now` clock for tests. |
| `PostgresTraceStoreOptions` | `table` (`nexus_runs`). |
| `PostgresEvaluationStoreOptions` | `datasetsTable` (`nexus_datasets`) and `experimentsTable` (`nexus_experiments`), shared by the dataset and experiment stores. |
| `PostgresCircuitStateStoreOptions` | `table` (`nexus_circuits`), and the clock for probe leases. It must be the breaker's own clock. |
| `PostgresPromptStoreOptions` | `table`, used as a prefix: `nexus_prompt` gives `nexus_prompt_versions` and the tables beside it. |
| `PostgresVectorStoreOptions` | `dimensions`, the width of every vector (required); `embed` (hashed term vectors by default); `table` (`nexus_vectors`); and `index`: `hnsw` (the default) searches without scanning every row, `none` scans exactly. |

Without `vectorDimensions`, `PostgresStore` keeps embeddings as JSON and ranks in the process. That
works on any Postgres and suits namespaces of a few thousand items.

### Versioned migrations

Each adapter's schema is a list of numbered migrations, and the database records which ran. A
`SchemaMigration` names its `component` — the adapter and its table, such as
`operations:nexus_operations` — its `version`, counted from 1 within the component, a `name`, and
its `statements`. Version 1 of every component is the schema 2.0 created, statement for statement,
so a database made by 2.0 or 2.1 is recognized as it is: its first migration records version 1 and
applies only what came later.

`migrate()` applies an adapter's pending migrations and resolves to a `MigrationResult`: the
migrations it `applied`, the `statements` it ran, and whether it was a `dryRun`. Each is recorded in
`nexus_schema_migrations` with `migrationChecksum()` of its statements, a hash that ignores line
endings. A migration whose statements changed after it ran — an edited migration, or adapter options
such as a vector width that differ from those it ran with — is refused with a `SchemaMigrationError`
before anything is written. Its `code` is `MIGRATION_CHANGED`, `MIGRATION_INVALID` for a list with a
gap or a duplicate, or `MIGRATION_LOCKED` when another migrator held the lock too long.

`PostgresMigrateOptions` tunes a run:

- `dryRun` plans without writing anything, not even the migrations table.
- `table` renames `nexus_schema_migrations`.
- `transaction` runs each migration and the row recording it in one transaction on one connection.
  Pass it for a pool, where `BEGIN` and `COMMIT` would otherwise reach different connections;
  PGlite needs only `transaction: (run) => db.transaction(run)`. Without it, statements run one at a
  time and the record is written last. Every bundled statement is idempotent, so a migration that was
  interrupted runs again next time.
- `lockTtlMs` and `lockTimeoutMs`: the lock is a row with a lease rather than a session advisory
  lock, so it holds through a connection pool and serverless drivers alike. A second migrator waits up
  to `lockTimeoutMs` (2 minutes), and the lease (10 minutes, renewed before each migration) lets one
  take over from a migrator that died.

`applyPostgresMigrations(client, migrations, options)` and `postgresMigrationStatus(client,
migrations)` do the same for any list, such as every adapter's together. A `MigrationStatus` lists
what is `applied` (each an `AppliedMigration` with its checksum and `appliedAt`), what is `pending`,
what `changed`, and what is `unknown`: migrations a newer release recorded. Unknown ones are expected
during a rollout and are left alone, and `current` is true when nothing is pending or changed. Both
functions live in `nexus-ai-pro/postgres/migrations` too, for an application that imports one adapter.

`postgresMigrations()` lists the migrations of the chosen adapters on their default tables, in the
order `POSTGRES_ADAPTERS` gives. `PostgresMigrationOptions` chooses the `adapters`, each a
`PostgresAdapter` name: `operations`, `store`, `traces`, `evaluation`, `circuits`, `prompts`,
`rollups`, or `vectors`. Every one but `vectors` is included by default, and `vectorDimensions` sets
the store's and the `vectors` table's width. A store on a custom table migrates through its own
`migrate()`, under a component of its own.

```ts
import { applyPostgresMigrations, postgresMigrations, postgresMigrationStatus } from 'nexus-ai-pro/postgres';

const migrations = postgresMigrations({ adapters: ['operations', 'traces', 'rollups'] });
const status = await postgresMigrationStatus(pool, migrations);
if (!status.current) await applyPostgresMigrations(pool, migrations, { transaction });
```

`nexus db status --client db.mjs` and `nexus db migrate --client db.mjs` do the same from a shell,
through a module that exports your client; the [CLI guide](./cli.md) has the details.

What each version adds:

| Component | Version | What it does |
| --- | --- | --- |
| `operations:nexus_operations` | 1 | the 2.0 table |
| | 2 | indexes queued work by age, so a claim reads the oldest few rows instead of sorting the queue |
| | 3 | indexes queued work by tenant |
| `traces:nexus_runs` | 1 | the 2.0 table |
| | 2 | indexes runs by `metadata.tenantId`, which a tenant's trace queries read |
| `circuits:nexus_circuits` | 1 | the 2.0 table |
| | 2 | the failure window workers count together, and its streak |
| `rollups:nexus_rollups` | 1 | the rollups table |
| `store`, `evaluation`, `prompts`, `vectors` | 1 | the 2.0 tables |

**Schema changes expand, then contract.** A column or index is added in one minor release, written
by the next, and removed only in a major, so a worker of the previous minor keeps running against a
migrated database during a rollout. That is tested against the published packages: a database 2.0.0
created is migrated by 2.2, and a 2.1.0 worker and a 2.2 worker drain one queue together with nothing
run twice.

Each adapter still has a function returning its statements, for your own tooling, and one returning
its versions; both take the same table options:

| Adapter | Statements | Versions |
| --- | --- | --- |
| `PostgresOperationStore` | `operationStoreMigration()` | `operationStoreMigrations()` |
| `PostgresStore` | `storeMigration()`, which also creates the pgvector extension when `vectorDimensions` is set | `storeMigrations()` |
| `PostgresTraceStore` | `traceStoreMigration()` | `traceStoreMigrations()` |
| `PostgresDatasetStore`, `PostgresExperimentStore` | `evaluationStoreMigration()` | `evaluationStoreMigrations()` |
| `PostgresCircuitStateStore` | `circuitStoreMigration()` | `circuitStoreMigrations()` |
| `PostgresPromptStore` | `promptStoreMigration()` | `promptStoreMigrations()` |
| `PostgresRollupStore` | `rollupStoreMigration()` | `rollupStoreMigrations()` |
| `PostgresVectorStore` | `vectorStoreMigration()` | `vectorStoreMigrations()` |

`postgresMigration()` joins every chosen adapter's statements into one script, which is what
`nexus db sql` prints. Every statement is idempotent, so the script runs again safely after an
upgrade. `PostgresMigrationScriptOptions` adds `record`, which also creates the migrations table
— the statements `migrationsTableStatements()` returns — and records every migration in the script as
applied, so `nexus db status` agrees with a database your own tooling built
(`nexus db sql --record`).

```ts
import { writeFileSync } from 'node:fs';
import { postgresMigration } from 'nexus-ai-pro/postgres';

writeFileSync('migrations/0007_nexus.sql', postgresMigration({ adapters: ['operations', 'traces'], record: true }));
```

## Dashboard rollups

`PostgresRollupStore` keeps the hourly rollups `rollupTraceStore()` produces (see the
[tracing guide](./tracing.md)) beside the traces themselves, so a dashboard's totals survive a restart
and every replica adds to the same rows. Adding to a row is one `INSERT … ON CONFLICT DO UPDATE`
that sums every total, latency buckets included, so two workers finishing runs in the same hour both
count. A query reads only the rows of its range and filters exactly as `MemoryRollupStore` does.
`PostgresRollupStoreOptions` has one field, `table` (`nexus_rollups`).

```ts
import { PostgresRollupStore } from 'nexus-ai-pro/postgres/rollups';
import { rollupTraceStore, sumRollups } from 'nexus-ai-pro/tracing/rollups';

const rollups = new PostgresRollupStore(pool);
await rollups.migrate();
const traces = rollupTraceStore(new PostgresTraceStore(pool), rollups);
const month = sumRollups(await rollups.query({ since: '2026-10-01T00:00:00Z', tenant: 'acme' }));
```

## Retrieval with pgvector

`PostgresVectorStore` implements the retrieval contract every vector store shares: `add()`, `search()`,
`searchVector()`, and `delete()`. The [grounding guide](./grounding.md) covers the contract.

Only the nearest chunks leave the database, so a search costs the same for a thousand chunks or ten
million. Adding a chunk whose id exists replaces it. A metadata filter runs in SQL as a jsonb
containment check. A vector of the wrong width is refused before it reaches the database, and
`size()` counts the chunks.

```ts
import { PostgresVectorStore } from 'nexus-ai-pro/postgres/vectors';

const chunks = new PostgresVectorStore(pool, {
  dimensions: 1536,
  embed: toEmbeddingFunction(ai, { model: 'text-embedding-3-small' }),
});
await chunks.migrate();
await chunks.add(ingestDocuments(docs).chunks);
const context = await chunks.search(question, { topK: 5, filter: { tenant: 'acme' } });
```

## Keyword search

`PostgresKeywordIndex`, on `nexus-ai-pro/postgres/fulltext`, is keyword search with Postgres's own
full-text search: stemmed terms, a GIN index, and `ts_rank_cd` ranking from 0 to 1. Only the best
matches leave the database. It is a `SparseRetriever`, so `hybridRetriever()` fuses it with
`PostgresVectorStore`.

`PostgresKeywordIndexOptions`:
- `table`;
- `language`, the text search configuration, `english` by default;
- `match`: `any` finds chunks with any of the query's terms and ranks partial matches; `all` needs
  every term and reads the query as a web search, with quoted phrases and `-` exclusions;
- `shared`.

With `shared`, the index searches a `PostgresVectorStore`'s own table:
- `migrate()` adds a generated `tsvector` column and its index to that table;
- the store's writes keep the column current;
- `add()` and `delete()` leave writing to the store.

So the hybrid search runs over one copy of every chunk, and keyword and vector search never disagree
about what exists. `keywordIndexMigrations()` is the versioned schema, and `migrate()` applies it.

```ts
import { PostgresKeywordIndex } from 'nexus-ai-pro/postgres/fulltext';
import { hybridRetriever, vectorRetriever } from 'nexus-ai-pro/rag/retrievers';

const keywords = new PostgresKeywordIndex(pool, { table: 'nexus_vectors', shared: true });
await keywords.migrate();                          // after chunks.migrate()
const retriever = hybridRetriever([vectorRetriever(chunks), keywords]);
```

## Limitations

- Migrations only add. A column or index is never dropped in a minor release, so the schema of an
  upgraded database is a superset of what each release reads.
- `nexus db migrate` migrates the default tables. A store on a custom table migrates through its own
  `migrate()`, or through a `migrations` list the database module exports.
- Without `vectorDimensions`, semantic search in `PostgresStore` reads and ranks every item under the
  prefix in the process.
- The HNSW index is approximate: it can miss a match that an exact scan would return, and a metadata
  filter is applied to the candidates it returns. For small tables, or when every match must be
  found, use `index: 'none'`.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/postgres`

| Export | Kind | Summary |
| --- | --- | --- |
| `fromPostgresJs` | function | Adapts a `postgres.js` instance to the client contract. |
| `POSTGRES_ADAPTERS` | constant | Every adapter, in the order a migration applies them. |
| `PostgresAdapter` | type | The Postgres adapters a migration can include. |
| `PostgresJsLike` | interface | The part of a `postgres.js` instance the adapter needs. |
| `PostgresLikeClient` | interface | The one method every Postgres adapter needs. |
| `postgresMigration` | function | The schema for the chosen adapters, as one SQL script. |
| `PostgresMigrationOptions` | interface | Options for `postgresMigrations()` and `postgresMigration()`. |
| `postgresMigrations` | function | The versioned migrations of the chosen adapters on their default tables, for `applyPostgresMigrations()`, `postgresMigrationStatus()`, and `nexus db migrate`. |
| `PostgresMigrationScriptOptions` | interface | Options for `postgresMigration()`. |

### `nexus-ai-pro/postgres/circuits`

| Export | Kind | Summary |
| --- | --- | --- |
| `circuitStoreMigration` | function | The schema, as statements: every migration's, in order. |
| `circuitStoreMigrations` | function | The versioned schema, which `migrate()` and `nexus db migrate` apply. |
| `PostgresCircuitStateStore` | class | Shared circuit state in Postgres. |
| `PostgresCircuitStateStoreOptions` | interface | Options for the Postgres circuit store. |

### `nexus-ai-pro/postgres/evaluate`

| Export | Kind | Summary |
| --- | --- | --- |
| `evaluationStoreMigration` | function | The schema for both tables, as statements. |
| `evaluationStoreMigrations` | function | The versioned schema, which `migrate()` and `nexus db migrate` apply. |
| `PostgresDatasetStore` | class | Dataset versions in Postgres, keyed by name and content version. |
| `PostgresEvaluationStoreOptions` | interface | Options for the Postgres evaluation stores. |
| `PostgresExperimentStore` | class | Experiments in Postgres, newest first by start time. |

### `nexus-ai-pro/postgres/fulltext`

| Export | Kind | Summary |
| --- | --- | --- |
| `keywordIndexMigrations` | function | The versioned schema, which `migrate()` applies. |
| `PostgresKeywordIndex` | class | Keyword search in Postgres, with its full-text search: stemmed terms, a GIN index, and `ts_rank_cd` ranking, so only the best matches leave the database however large the table. |
| `PostgresKeywordIndexOptions` | interface | Options for `PostgresKeywordIndex`. |

### `nexus-ai-pro/postgres/migrations`

| Export | Kind | Summary |
| --- | --- | --- |
| `AppliedMigration` | interface | A migration the database has recorded as applied. |
| `applyPostgresMigrations` | function | Applies the pending migrations in order, under a lock, recording each with a checksum. |
| `migrationChecksum` | function | A checksum of a migration's statements: cyrb53, a fast 53-bit hash, as 14 hex digits. |
| `MigrationResult` | interface | What one `migrate()` call did, or with `dryRun`, would do. |
| `migrationsTableStatements` | function | The statements that create the migrations table and its lock, which `migrate()` runs first. |
| `MigrationStatus` | interface | Where a database stands against the migrations this code knows. |
| `PostgresMigrateOptions` | interface | Options for applying or inspecting Postgres migrations. |
| `postgresMigrationStatus` | function | Where a Postgres database stands against a list of migrations. |
| `SchemaMigration` | interface | One numbered schema change to one adapter's tables. |
| `SchemaMigrationError` | class | Raised when migrations cannot run safely: a changed migration, a bad list, or a lock held too long. |

### `nexus-ai-pro/postgres/operations`

| Export | Kind | Summary |
| --- | --- | --- |
| `operationStoreMigration` | function | The schema, as statements: every migration's, in order. |
| `operationStoreMigrations` | function | The versioned schema, which `migrate()` and `nexus db migrate` apply. |
| `PostgresOperationStore` | class | Operation records in Postgres. |
| `PostgresOperationStoreOptions` | interface | Options for the Postgres operation store. |

### `nexus-ai-pro/postgres/prompts`

| Export | Kind | Summary |
| --- | --- | --- |
| `PostgresPromptStore` | class | Prompt versions, labels, and history in Postgres. |
| `PostgresPromptStoreOptions` | interface | Options for the Postgres prompt store. |
| `promptStoreMigration` | function | The schema for the prompt store, as statements. |
| `promptStoreMigrations` | function | The versioned schema, which `migrate()` and `nexus db migrate` apply. |

### `nexus-ai-pro/postgres/rollups`

| Export | Kind | Summary |
| --- | --- | --- |
| `PostgresRollupStore` | class | Rollup rows in Postgres, so a dashboard's totals live beside its traces and survive a restart. |
| `PostgresRollupStoreOptions` | interface | Options for the Postgres rollup store. |
| `rollupStoreMigration` | function | The schema, as statements: every migration's, in order. |
| `rollupStoreMigrations` | function | The versioned schema, which `migrate()` and `nexus db migrate` apply. |

### `nexus-ai-pro/postgres/store`

| Export | Kind | Summary |
| --- | --- | --- |
| `PostgresStore` | class | Long-term memory in Postgres, with pgvector when it is available. |
| `PostgresStoreOptions` | interface | Options for the Postgres store. |
| `storeMigration` | function | The schema, as statements. |
| `storeMigrations` | function | The versioned schema, which `migrate()` and `nexus db migrate` apply. |

### `nexus-ai-pro/postgres/traces`

| Export | Kind | Summary |
| --- | --- | --- |
| `PostgresTraceStore` | class | Traces in Postgres. |
| `PostgresTraceStoreOptions` | interface | Options for the Postgres trace store. |
| `traceStoreMigration` | function | The schema, as statements: every migration's, in order. |
| `traceStoreMigrations` | function | The versioned schema, which `migrate()` and `nexus db migrate` apply. |

### `nexus-ai-pro/postgres/vectors`

| Export | Kind | Summary |
| --- | --- | --- |
| `PostgresVectorStore` | class | Retrieval chunks in Postgres with pgvector, ranked by cosine similarity in the database. |
| `PostgresVectorStoreOptions` | interface | Options for the pgvector store. |
| `vectorStoreMigration` | function | The schema, as statements: the pgvector extension, the table, and its index. |
| `vectorStoreMigrations` | function | The versioned schema, which `migrate()` and `nexus db migrate` apply. |
<!-- reference:end -->
