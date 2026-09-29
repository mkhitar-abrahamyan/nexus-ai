# Postgres

<!-- covers: ./postgres ./postgres/operations ./postgres/store ./postgres/traces ./postgres/evaluate ./postgres/circuits ./postgres/prompts ./postgres/vectors -->

Postgres storage for everything that has to outlive a process or be shared between workers: durable
operations and graph checkpoints, long-term memory, traces, datasets and experiments, shared circuit
state, prompt versions, and retrieval vectors with pgvector.

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
await operations.migrate(); // or: nexus db sql | psql "$DATABASE_URL"
```

| Adapter | Subpath | Serves |
| --- | --- | --- |
| `PostgresOperationStore` | `/postgres/operations` | durable operations, and graph checkpoints through `OperationStoreCheckpointer` |
| `PostgresStore` | `/postgres/store` | long-term memory, ranked by pgvector when `vectorDimensions` is set |
| `PostgresTraceStore` | `/postgres/traces` | traces, with every query filter in SQL |
| `PostgresDatasetStore`, `PostgresExperimentStore` | `/postgres/evaluate` | datasets and experiments |
| `PostgresCircuitStateStore` | `/postgres/circuits` | circuit state shared between workers |
| `PostgresVectorStore` | `/postgres/vectors` | retrieval chunks, ranked by pgvector in the database |

**No driver is a dependency.** Each adapter takes anything with a `query(text, values)` method that
resolves to `{ rows }`: `pg`'s `Pool` and `Client`, `@neondatabase/serverless`, PGlite.
`fromPostgresJs(sql)` adapts `postgres.js`. Parameters are only ever strings, numbers, and `null`,
cast in SQL, so a driver's own conversion of arrays or dates never changes what is stored.

**Nothing creates a schema at import.** `migrate()` applies an adapter's schema when you call it;
`postgresMigration()` and `nexus db sql` produce the same SQL for the migration tooling you already
use. Table names are options, schema-qualified if you like.

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

### Migrations

Each adapter's `migrate()` applies its schema. Each also has a migration function that returns the
same statements, for your own tooling, and takes the same table options:

| Adapter | Migration function |
| --- | --- |
| `PostgresOperationStore` | `operationStoreMigration()` |
| `PostgresStore` | `storeMigration()`, which also creates the pgvector extension when `vectorDimensions` is set. |
| `PostgresTraceStore` | `traceStoreMigration()` |
| `PostgresDatasetStore`, `PostgresExperimentStore` | `evaluationStoreMigration()` |
| `PostgresCircuitStateStore` | `circuitStoreMigration()` |
| `PostgresPromptStore` | `promptStoreMigration()` |
| `PostgresVectorStore` | `vectorStoreMigration()` |

`postgresMigration()` joins them into one script, which is what `nexus db sql` prints.
`PostgresMigrationOptions` chooses:

- the `adapters`, each a `PostgresAdapter` name: `operations`, `store`, `traces`, `evaluation`,
  `circuits`, `prompts`, or `vectors`. Every one but `vectors` is included by default.
- `vectorDimensions`, for the store and for the `vectors` table. The `vectors` table needs it, and is
  included only when named: `nexus db sql --adapters vectors --vector-dimensions 1536`.

The script uses the default table names. When you rename a table, build its SQL from the adapter's own
migration function with the same options.

```ts
import { writeFileSync } from 'node:fs';
import { postgresMigration } from 'nexus-ai-pro/postgres';

writeFileSync('migrations/0007_nexus.sql', postgresMigration({ adapters: ['operations', 'traces'] }));
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

## Limitations

- A migration creates what is missing; it does not alter a table an earlier version created. The
  changelog says when a release changes a schema.
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
| `PostgresAdapter` | type | The Postgres adapters a migration can include. |
| `PostgresJsLike` | interface | The part of a `postgres.js` instance the adapter needs. |
| `PostgresLikeClient` | interface | The one method every Postgres adapter needs. |
| `postgresMigration` | function | The schema for the chosen adapters, as one SQL script. |
| `PostgresMigrationOptions` | interface | Options for `postgresMigration()`. |

### `nexus-ai-pro/postgres/circuits`

| Export | Kind | Summary |
| --- | --- | --- |
| `circuitStoreMigration` | function | The schema, as statements. |
| `PostgresCircuitStateStore` | class | Shared circuit state in Postgres. |
| `PostgresCircuitStateStoreOptions` | interface | Options for the Postgres circuit store. |

### `nexus-ai-pro/postgres/evaluate`

| Export | Kind | Summary |
| --- | --- | --- |
| `evaluationStoreMigration` | function | The schema for both tables, as statements. |
| `PostgresDatasetStore` | class | Dataset versions in Postgres, keyed by name and content version. |
| `PostgresEvaluationStoreOptions` | interface | Options for the Postgres evaluation stores. |
| `PostgresExperimentStore` | class | Experiments in Postgres, newest first by start time. |

### `nexus-ai-pro/postgres/operations`

| Export | Kind | Summary |
| --- | --- | --- |
| `operationStoreMigration` | function | The schema, as statements. |
| `PostgresOperationStore` | class | Operation records in Postgres. |
| `PostgresOperationStoreOptions` | interface | Options for the Postgres operation store. |

### `nexus-ai-pro/postgres/prompts`

| Export | Kind | Summary |
| --- | --- | --- |
| `PostgresPromptStore` | class | Prompt versions, labels, and history in Postgres. |
| `PostgresPromptStoreOptions` | interface | Options for the Postgres prompt store. |
| `promptStoreMigration` | function | The schema for the prompt store, as statements. |

### `nexus-ai-pro/postgres/store`

| Export | Kind | Summary |
| --- | --- | --- |
| `PostgresStore` | class | Long-term memory in Postgres, with pgvector when it is available. |
| `PostgresStoreOptions` | interface | Options for the Postgres store. |
| `storeMigration` | function | The schema, as statements. |

### `nexus-ai-pro/postgres/traces`

| Export | Kind | Summary |
| --- | --- | --- |
| `PostgresTraceStore` | class | Traces in Postgres. |
| `PostgresTraceStoreOptions` | interface | Options for the Postgres trace store. |
| `traceStoreMigration` | function | The schema, as statements. |

### `nexus-ai-pro/postgres/vectors`

| Export | Kind | Summary |
| --- | --- | --- |
| `PostgresVectorStore` | class | Retrieval chunks in Postgres with pgvector, ranked by cosine similarity in the database. |
| `PostgresVectorStoreOptions` | interface | Options for the pgvector store. |
| `vectorStoreMigration` | function | The schema, as statements: the pgvector extension, the table, and its index. |
<!-- reference:end -->
