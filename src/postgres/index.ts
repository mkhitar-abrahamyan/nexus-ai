import { MIGRATIONS_TABLE, migrationChecksum, type SchemaMigration, sqlLiteral } from '../utils/schema-migrations.js';
import { circuitStoreMigrations } from './circuits.js';
import { quoteTable } from './client.js';
import { evaluationStoreMigrations } from './evaluate.js';
import { migrationsTableStatements } from './migrations.js';
import { operationStoreMigrations } from './operations.js';
import { promptStoreMigrations } from './prompts.js';
import { rollupStoreMigrations } from './rollups.js';
import { storeMigrations } from './store.js';
import { traceStoreMigrations } from './traces.js';
import { vectorStoreMigrations } from './vectors.js';

export {
  type AppliedMigration,
  type MigrationResult,
  type MigrationStatus,
  migrationChecksum,
  type SchemaMigration,
  SchemaMigrationError,
} from '../utils/schema-migrations.js';
export {
  circuitStoreMigration,
  circuitStoreMigrations,
  PostgresCircuitStateStore,
  type PostgresCircuitStateStoreOptions,
} from './circuits.js';
export { fromPostgresJs, type PostgresJsLike, type PostgresLikeClient } from './client.js';
export {
  evaluationStoreMigration,
  evaluationStoreMigrations,
  PostgresDatasetStore,
  type PostgresEvaluationStoreOptions,
  PostgresExperimentStore,
} from './evaluate.js';
export {
  applyPostgresMigrations,
  type PostgresMigrateOptions,
  postgresMigrationStatus,
} from './migrations.js';
export {
  operationStoreMigration,
  operationStoreMigrations,
  PostgresOperationStore,
  type PostgresOperationStoreOptions,
} from './operations.js';
export {
  PostgresPromptStore,
  type PostgresPromptStoreOptions,
  promptStoreMigration,
  promptStoreMigrations,
} from './prompts.js';
export {
  PostgresRollupStore,
  type PostgresRollupStoreOptions,
  rollupStoreMigration,
  rollupStoreMigrations,
} from './rollups.js';
export { PostgresStore, type PostgresStoreOptions, storeMigration, storeMigrations } from './store.js';
export {
  PostgresTraceStore,
  type PostgresTraceStoreOptions,
  traceStoreMigration,
  traceStoreMigrations,
} from './traces.js';
export {
  PostgresVectorStore,
  type PostgresVectorStoreOptions,
  vectorStoreMigration,
  vectorStoreMigrations,
} from './vectors.js';

/** The Postgres adapters a migration can include. */
export type PostgresAdapter =
  | 'operations'
  | 'store'
  | 'traces'
  | 'evaluation'
  | 'circuits'
  | 'prompts'
  | 'rollups'
  | 'vectors';

/** Options for `postgresMigrations()` and `postgresMigration()`. */
export interface PostgresMigrationOptions {
  /**
   * Adapters to include. Defaults to every one but `vectors`, which needs pgvector and
   * `vectorDimensions`, so it is included only when named.
   */
  adapters?: readonly PostgresAdapter[];
  /** Enables pgvector for the long-term store, and sets the width of the `vectors` table. */
  vectorDimensions?: number;
}

/** Options for `postgresMigration()`. */
export interface PostgresMigrationScriptOptions extends PostgresMigrationOptions {
  /**
   * Also creates `nexus_schema_migrations` and records every migration in the script as applied, so
   * `nexus db status` agrees with a database built by the application's own tooling. Off by default.
   */
  record?: boolean;
}

/** Every adapter, in the order a migration applies them. */
export const POSTGRES_ADAPTERS: readonly PostgresAdapter[] = [
  'operations',
  'store',
  'traces',
  'evaluation',
  'circuits',
  'prompts',
  'rollups',
  'vectors',
];

/**
 * The versioned migrations of the chosen adapters on their default tables, for
 * `applyPostgresMigrations()`, `postgresMigrationStatus()`, and `nexus db migrate`. A store on a
 * custom table migrates through its own `migrate()`.
 */
export function postgresMigrations(options: PostgresMigrationOptions = {}): SchemaMigration[] {
  const adapters = new Set(options.adapters ?? POSTGRES_ADAPTERS.filter((adapter) => adapter !== 'vectors'));
  const vectorDimensions = options.vectorDimensions;
  const migrationsOf: Record<PostgresAdapter, () => SchemaMigration[]> = {
    operations: () => operationStoreMigrations(),
    store: () => storeMigrations(vectorDimensions ? { vectorDimensions } : {}),
    traces: () => traceStoreMigrations(),
    evaluation: () => evaluationStoreMigrations(),
    circuits: () => circuitStoreMigrations(),
    prompts: () => promptStoreMigrations(),
    rollups: () => rollupStoreMigrations(),
    vectors: () => {
      if (vectorDimensions === undefined) throw new RangeError('The vectors adapter needs vectorDimensions');
      return vectorStoreMigrations({ dimensions: vectorDimensions });
    },
  };
  return POSTGRES_ADAPTERS.filter((adapter) => adapters.has(adapter)).flatMap((adapter) => migrationsOf[adapter]());
}

/**
 * The schema for the chosen adapters, as one SQL script.
 *
 * For migration tooling the application already has — Flyway, Prisma, a plain `psql -f` — which is
 * usually where a schema change belongs. Every statement is idempotent, so the script runs again
 * safely after an upgrade. `nexus db sql` prints the same script.
 */
export function postgresMigration(options: PostgresMigrationScriptOptions = {}): string {
  const migrations = postgresMigrations(options);
  const statements = migrations.flatMap((migration) => [...migration.statements]);
  if (options.record) {
    statements.push(...migrationsTableStatements());
    for (const migration of migrations) {
      statements.push(
        `INSERT INTO ${quoteTable(MIGRATIONS_TABLE)} (component, version, name, checksum, applied_at) VALUES (${[
          migration.component,
          String(migration.version),
          migration.name,
          migrationChecksum(migration),
        ]
          .map((value, index) => (index === 1 ? value : sqlLiteral(value)))
          .join(
            ', ',
          )}, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ON CONFLICT (component, version) DO NOTHING`,
      );
    }
  }
  return `${statements.join(';\n\n')};\n`;
}
