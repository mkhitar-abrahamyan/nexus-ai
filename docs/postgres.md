# Postgres

<!-- covers: ./postgres ./postgres/operations ./postgres/store ./postgres/traces ./postgres/evaluate ./postgres/circuits ./postgres/prompts -->

One Postgres adapter family for every store that has to outlive a process: durable operations and graph checkpoints, long-term memory with pgvector, traces, datasets and experiments, shared circuit state, and prompt versions. Each adapter has its own entry point, takes any client with a `query(text, values)` method, and never creates a schema at import. `PostgresPromptStore` is covered in the [prompts guide](./prompts.md).

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

**No driver is a dependency.** Each adapter takes anything with a `query(text, values)` method that
resolves to `{ rows }`: `pg`'s `Pool` and `Client`, `@neondatabase/serverless`, PGlite.
`fromPostgresJs(sql)` adapts `postgres.js`. Parameters are only ever strings, numbers, and `null`,
cast in SQL, so a driver's own conversion of arrays or dates never changes what is stored.

**Nothing creates a schema at import.** `migrate()` applies an adapter's schema when you call it;
`postgresMigration()` and `nexus db sql` produce the same SQL for the migration tooling you already
use. Table names are options, schema-qualified if you like.

**What Postgres adds over the other stores.** An operation update is one `UPDATE … WHERE sequence =
expected`, atomic without a transaction. Idempotency keys are unique in the table, so when two
workers race to submit the same key the loser attaches to the winner's operation instead of running
the work twice. Trace feedback is appended in one statement, so two evaluators scoring one run at once
both land.

A graph thread started on one worker and finished on another is the same code as before, pointed at a
different store:

```ts
const graph = builder.compile({ checkpointer: new OperationStoreCheckpointer(new PostgresOperationStore(pool)) });
```

The adapters are tested on every run against a real Postgres engine — PGlite, PostgreSQL compiled to
WebAssembly — with the same contract tests the in-memory stores pass.

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
<!-- reference:end -->
