import { circuitStoreMigration } from './circuits.js';
import { evaluationStoreMigration } from './evaluate.js';
import { operationStoreMigration } from './operations.js';
import { promptStoreMigration } from './prompts.js';
import { storeMigration } from './store.js';
import { traceStoreMigration } from './traces.js';
import { vectorStoreMigration } from './vectors.js';

export {
  circuitStoreMigration,
  PostgresCircuitStateStore,
  type PostgresCircuitStateStoreOptions,
} from './circuits.js';
export { fromPostgresJs, type PostgresJsLike, type PostgresLikeClient } from './client.js';
export {
  evaluationStoreMigration,
  PostgresDatasetStore,
  type PostgresEvaluationStoreOptions,
  PostgresExperimentStore,
} from './evaluate.js';
export { operationStoreMigration, PostgresOperationStore, type PostgresOperationStoreOptions } from './operations.js';
export { PostgresPromptStore, type PostgresPromptStoreOptions, promptStoreMigration } from './prompts.js';
export { PostgresStore, type PostgresStoreOptions, storeMigration } from './store.js';
export { PostgresTraceStore, type PostgresTraceStoreOptions, traceStoreMigration } from './traces.js';
export { PostgresVectorStore, type PostgresVectorStoreOptions, vectorStoreMigration } from './vectors.js';

/** The Postgres adapters a migration can include. */
export type PostgresAdapter = 'operations' | 'store' | 'traces' | 'evaluation' | 'circuits' | 'prompts' | 'vectors';

/** Options for `postgresMigration()`. */
export interface PostgresMigrationOptions {
  /**
   * Adapters to include. Defaults to every one but `vectors`, which needs pgvector and
   * `vectorDimensions`, so it is included only when named.
   */
  adapters?: readonly PostgresAdapter[];
  /** Enables pgvector for the long-term store, and sets the width of the `vectors` table. */
  vectorDimensions?: number;
}

/**
 * The schema for the chosen adapters, as one SQL script.
 *
 * For migration tooling the application already has — Flyway, Prisma, a plain `psql -f` — which is
 * usually where a schema change belongs. `nexus db sql` prints the same script.
 */
export function postgresMigration(options: PostgresMigrationOptions = {}): string {
  const adapters = new Set(options.adapters ?? ['operations', 'store', 'traces', 'evaluation', 'circuits', 'prompts']);
  const statements = [
    ...(adapters.has('operations') ? operationStoreMigration() : []),
    ...(adapters.has('store')
      ? storeMigration(options.vectorDimensions ? { vectorDimensions: options.vectorDimensions } : {})
      : []),
    ...(adapters.has('traces') ? traceStoreMigration() : []),
    ...(adapters.has('evaluation') ? evaluationStoreMigration() : []),
    ...(adapters.has('circuits') ? circuitStoreMigration() : []),
    ...(adapters.has('prompts') ? promptStoreMigration() : []),
    ...(adapters.has('vectors') ? vectorMigrationFor(options.vectorDimensions) : []),
  ];
  return `${statements.join(';\n\n')};\n`;
}

function vectorMigrationFor(dimensions: number | undefined): string[] {
  if (dimensions === undefined) throw new RangeError('The vectors adapter needs vectorDimensions');
  return vectorStoreMigration({ dimensions });
}
