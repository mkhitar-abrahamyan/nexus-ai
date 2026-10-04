import type { SchemaMigration } from '../utils/schema-migrations.js';
import { sqliteOperationStoreMigrations } from './operations.js';
import { sqliteStoreMigrations } from './store.js';
import { sqliteVectorStoreMigrations } from './vectors.js';

export {
  type AppliedMigration,
  type MigrationResult,
  type MigrationStatus,
  migrationChecksum,
  type SchemaMigration,
  SchemaMigrationError,
} from '../utils/schema-migrations.js';
export {
  fromLibsql,
  fromSqliteDatabase,
  type LibsqlLikeClient,
  type SqliteDatabaseLike,
  type SqliteLikeClient,
  type SqliteValue,
} from './client.js';
export { applySqliteMigrations, type SqliteMigrateOptions, sqliteMigrationStatus } from './migrations.js';
export {
  SqliteOperationStore,
  type SqliteOperationStoreOptions,
  sqliteOperationStoreMigration,
  sqliteOperationStoreMigrations,
} from './operations.js';
export { SqliteStore, type SqliteStoreOptions, sqliteStoreMigration, sqliteStoreMigrations } from './store.js';
export {
  SqliteVectorStore,
  type SqliteVectorStoreOptions,
  sqliteVectorStoreMigration,
  sqliteVectorStoreMigrations,
} from './vectors.js';

/** The SQLite adapters a migration can include. */
export type SqliteAdapter = 'operations' | 'store' | 'vectors';

/**
 * The versioned migrations of the chosen adapters on their default tables, for
 * `applySqliteMigrations()`, `sqliteMigrationStatus()`, and `nexus db migrate`. Defaults to every
 * adapter. A store on a custom table migrates through its own `migrate()`.
 */
export function sqliteMigrations(options: { adapters?: readonly SqliteAdapter[] } = {}): SchemaMigration[] {
  const adapters = new Set(options.adapters ?? ['operations', 'store', 'vectors']);
  return [
    ...(adapters.has('operations') ? sqliteOperationStoreMigrations() : []),
    ...(adapters.has('store') ? sqliteStoreMigrations() : []),
    ...(adapters.has('vectors') ? sqliteVectorStoreMigrations() : []),
  ];
}
