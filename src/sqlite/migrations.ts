import {
  type AppliedMigration,
  assertUnchanged,
  MIGRATIONS_TABLE,
  type MigrationResult,
  type MigrationStatus,
  migrationChecksum,
  planMigrations,
  type SchemaMigration,
  sqlLiteral,
} from '../utils/schema-migrations.js';
import { quoteSqliteTable, type SqliteDatabaseLike, type SqliteLikeClient, toSqliteClient } from './client.js';

export {
  type AppliedMigration,
  type MigrationResult,
  type MigrationStatus,
  migrationChecksum,
  type SchemaMigration,
  SchemaMigrationError,
} from '../utils/schema-migrations.js';

/** Options for applying or inspecting SQLite migrations. */
export interface SqliteMigrateOptions {
  /** Plans without writing anything, not even the table that records migrations. */
  dryRun?: boolean;
  /** The table that records applied migrations. Defaults to `nexus_schema_migrations`. */
  table?: string;
}

/**
 * Where a SQLite database stands against a list of migrations. Reads only: on a database that has
 * never been migrated, everything is pending.
 */
export async function sqliteMigrationStatus(
  database: SqliteLikeClient | SqliteDatabaseLike,
  migrations: readonly SchemaMigration[],
  options: Pick<SqliteMigrateOptions, 'table'> = {},
): Promise<MigrationStatus> {
  return planMigrations(migrations, await readApplied(toSqliteClient(database), options.table ?? MIGRATIONS_TABLE));
}

/**
 * Applies the pending migrations in order, recording each with a checksum.
 *
 * Each migration runs inside `BEGIN IMMEDIATE`, which takes SQLite's write lock: its statements and
 * the row recording it land together or not at all, and a second process migrating the same file
 * waits for the first instead of interleaving with it. A migration whose statements changed after it
 * ran is refused before anything is written.
 */
export async function applySqliteMigrations(
  database: SqliteLikeClient | SqliteDatabaseLike,
  migrations: readonly SchemaMigration[],
  options: SqliteMigrateOptions = {},
): Promise<MigrationResult> {
  const client = toSqliteClient(database);
  const tableName = options.table ?? MIGRATIONS_TABLE;
  if (options.dryRun) {
    const status = await sqliteMigrationStatus(client, migrations, options);
    assertUnchanged(status);
    return { applied: status.pending, statements: status.pending.flatMap((m) => [...m.statements]), dryRun: true };
  }

  planMigrations(migrations, []); // validates the list before anything is created
  await client.exec(sqliteMigrationsTableStatement(tableName));
  const status = planMigrations(migrations, await readApplied(client, tableName));
  assertUnchanged(status);
  const table = quoteSqliteTable(tableName);
  const statements: string[] = [];
  for (const migration of status.pending) {
    const record = `INSERT OR IGNORE INTO ${table} (component, version, name, checksum, applied_at) VALUES (${sqlLiteral(migration.component)}, ${migration.version}, ${sqlLiteral(migration.name)}, ${sqlLiteral(migrationChecksum(migration))}, ${sqlLiteral(new Date().toISOString())})`;
    const script = ['BEGIN IMMEDIATE', ...migration.statements, record, 'COMMIT'].join(';\n');
    try {
      await client.exec(`${script};`);
    } catch (error) {
      // A synchronous driver leaves the transaction open when a statement fails.
      try {
        await client.exec('ROLLBACK');
      } catch {
        // Nothing was open.
      }
      throw error;
    }
    statements.push(...migration.statements);
  }
  return { applied: status.pending, statements, dryRun: false };
}

/** The statement that creates the migrations table, which `migrate()` runs first. */
export function sqliteMigrationsTableStatement(table: string = MIGRATIONS_TABLE): string {
  return `CREATE TABLE IF NOT EXISTS ${quoteSqliteTable(table)} (
  component TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (component, version)
)`;
}

async function readApplied(client: SqliteLikeClient, table: string): Promise<AppliedMigration[]> {
  const exists = (await client.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [
    table,
  ])) as unknown[];
  if (exists.length === 0) return [];
  const rows = (await client.all(
    `SELECT component, version, name, checksum, applied_at FROM ${quoteSqliteTable(table)} ORDER BY applied_at, component, version`,
    [],
  )) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    component: String(row.component),
    version: Number(row.version),
    name: String(row.name),
    checksum: String(row.checksum),
    appliedAt: String(row.applied_at),
  }));
}
