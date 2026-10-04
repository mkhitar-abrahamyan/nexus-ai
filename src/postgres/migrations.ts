import {
  type AppliedMigration,
  assertUnchanged,
  delay,
  label,
  MIGRATIONS_TABLE,
  type MigrationResult,
  type MigrationStatus,
  migrationChecksum,
  planMigrations,
  type SchemaMigration,
  SchemaMigrationError,
} from '../utils/schema-migrations.js';
import { type PostgresLikeClient, quoteTable } from './client.js';

export {
  type AppliedMigration,
  type MigrationResult,
  type MigrationStatus,
  migrationChecksum,
  type SchemaMigration,
  SchemaMigrationError,
} from '../utils/schema-migrations.js';

/** Options for applying or inspecting Postgres migrations. */
export interface PostgresMigrateOptions {
  /** Plans without writing anything, not even the table that records migrations. */
  dryRun?: boolean;
  /** The table that records applied migrations, optionally schema-qualified. Defaults to `nexus_schema_migrations`. */
  table?: string;
  /**
   * Runs one migration's statements, and the row recording it, in one transaction on one connection.
   * Without it, statements run one at a time and the record is written last: every bundled statement
   * is idempotent, so an interrupted migration runs again on the next call. Pass it for a pool, where
   * `BEGIN` and `COMMIT` would otherwise reach different connections:
   *
   * ```ts
   * transaction: async (run) => {
   *   const connection = await pool.connect();
   *   try {
   *     await connection.query('BEGIN');
   *     const result = await run(connection);
   *     await connection.query('COMMIT');
   *     return result;
   *   } catch (error) {
   *     await connection.query('ROLLBACK');
   *     throw error;
   *   } finally {
   *     connection.release();
   *   }
   * }
   * ```
   *
   * PGlite needs only `transaction: (run) => db.transaction(run)`.
   */
  transaction?: <T>(run: (client: PostgresLikeClient) => Promise<T>) => Promise<T>;
  /**
   * How long one migrator holds the lock before another may take it over, renewed before each
   * migration. Defaults to 10 minutes, longer than any bundled migration takes.
   */
  lockTtlMs?: number;
  /** How long to wait for another migrator to finish before giving up. Defaults to 2 minutes. */
  lockTimeoutMs?: number;
}

const LOCK_NAME = 'migrate';
const DB_NOW = '(extract(epoch from clock_timestamp()) * 1000)';

/**
 * Where a Postgres database stands against a list of migrations. Reads only: on a database that has
 * never been migrated, everything is pending.
 */
export async function postgresMigrationStatus(
  client: PostgresLikeClient,
  migrations: readonly SchemaMigration[],
  options: Pick<PostgresMigrateOptions, 'table'> = {},
): Promise<MigrationStatus> {
  return planMigrations(migrations, await readApplied(client, options.table ?? MIGRATIONS_TABLE));
}

/**
 * Applies the pending migrations in order, under a lock, recording each with a checksum.
 *
 * The lock is a row with a lease rather than a session advisory lock, so it holds through a
 * connection pool and serverless drivers alike: a second migrator waits, and one that died is taken
 * over once its lease lapses. A migration whose statements changed after it ran is refused before
 * anything is written. Migrations a newer release recorded are left alone, so an older worker
 * starting mid-rollout does nothing.
 */
export async function applyPostgresMigrations(
  client: PostgresLikeClient,
  migrations: readonly SchemaMigration[],
  options: PostgresMigrateOptions = {},
): Promise<MigrationResult> {
  const tableName = options.table ?? MIGRATIONS_TABLE;
  if (options.dryRun) {
    const status = await postgresMigrationStatus(client, migrations, options);
    assertUnchanged(status);
    return { applied: status.pending, statements: status.pending.flatMap((m) => [...m.statements]), dryRun: true };
  }

  planMigrations(migrations, []); // validates the list before anything is created
  await bootstrap(client, tableName);
  const owner = `migrator-${globalThis.crypto.randomUUID()}`;
  const lockTtlMs = options.lockTtlMs ?? 600_000;
  await acquire(client, tableName, owner, lockTtlMs, options.lockTimeoutMs ?? 120_000);
  try {
    const status = planMigrations(migrations, await readApplied(client, tableName));
    assertUnchanged(status);
    const statements: string[] = [];
    for (const migration of status.pending) {
      if (!(await claim(client, tableName, owner, lockTtlMs))) {
        throw new SchemaMigrationError('MIGRATION_LOCKED', `The migration lock lapsed before ${label(migration)}`);
      }
      const apply = async (connection: PostgresLikeClient) => {
        for (const statement of migration.statements) await connection.query(statement);
        await connection.query(
          `INSERT INTO ${quoteTable(tableName)} (component, version, name, checksum, applied_at)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (component, version) DO NOTHING`,
          [
            migration.component,
            migration.version,
            migration.name,
            migrationChecksum(migration),
            new Date().toISOString(),
          ],
        );
      };
      if (options.transaction) await options.transaction(apply);
      else await apply(client);
      statements.push(...migration.statements);
    }
    return { applied: status.pending, statements, dryRun: false };
  } finally {
    await client
      .query(`DELETE FROM ${lockTable(tableName)} WHERE name = $1 AND owner = $2`, [LOCK_NAME, owner])
      .catch(() => undefined);
  }
}

/** The statements that create the migrations table and its lock, which `migrate()` runs first. */
export function migrationsTableStatements(table: string = MIGRATIONS_TABLE): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${quoteTable(table)} (
  component text NOT NULL,
  version integer NOT NULL,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at text COLLATE "C" NOT NULL,
  PRIMARY KEY (component, version)
)`,
    `CREATE TABLE IF NOT EXISTS ${lockTable(table)} (
  name text PRIMARY KEY,
  owner text NOT NULL,
  expires_at double precision NOT NULL
)`,
  ];
}

async function bootstrap(client: PostgresLikeClient, table: string): Promise<void> {
  for (const statement of migrationsTableStatements(table)) {
    try {
      await client.query(statement);
    } catch (error) {
      // Two migrators creating the same table at once: Postgres reports a duplicate type or table
      // to the loser, whose table now exists.
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== '23505' && code !== '42P07') throw error;
    }
  }
}

async function readApplied(client: PostgresLikeClient, table: string): Promise<AppliedMigration[]> {
  const { rows: exists } = await client.query('SELECT to_regclass($1) IS NOT NULL AS present', [quoteTable(table)]);
  if (!(exists[0] as { present?: unknown } | undefined)?.present) return [];
  const { rows } = await client.query(
    `SELECT component, version, name, checksum, applied_at FROM ${quoteTable(table)} ORDER BY applied_at, component, version`,
  );
  return rows.map((row) => {
    const value = row as Record<string, unknown>;
    return {
      component: String(value.component),
      version: Number(value.version),
      name: String(value.name),
      checksum: String(value.checksum),
      appliedAt: String(value.applied_at),
    };
  });
}

async function acquire(
  client: PostgresLikeClient,
  table: string,
  owner: string,
  ttlMs: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let wait = 50;
  while (!(await claim(client, table, owner, ttlMs))) {
    if (Date.now() >= deadline) {
      throw new SchemaMigrationError(
        'MIGRATION_LOCKED',
        `Another migrator held the lock for ${timeoutMs} ms. It is released when that migrator finishes, or when its lease lapses.`,
      );
    }
    await delay(wait);
    wait = Math.min(wait * 2, 1_000);
  }
}

/** Takes or renews the lock in one statement, by the database's clock so workers' clocks never matter. */
async function claim(client: PostgresLikeClient, table: string, owner: string, ttlMs: number): Promise<boolean> {
  const lock = lockTable(table);
  const { rows } = await client.query(
    `INSERT INTO ${lock} (name, owner, expires_at) VALUES ($1, $2, ${DB_NOW} + $3::double precision)
     ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
     WHERE ${lock}.owner = EXCLUDED.owner OR ${lock}.expires_at < ${DB_NOW}
     RETURNING owner`,
    [LOCK_NAME, owner, ttlMs],
  );
  return rows.length > 0;
}

function lockTable(table: string): string {
  return quoteTable(`${table}_lock`);
}
