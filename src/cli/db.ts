import { type PostgresAdapter, POSTGRES_ADAPTERS, postgresMigration, postgresMigrations } from '../postgres/index.js';
import type { PostgresLikeClient } from '../postgres/client.js';
import type { PostgresMigrateOptions } from '../postgres/migrations.js';
import type { SqliteAdapter } from '../sqlite/index.js';
import type { MigrationResult, MigrationStatus, SchemaMigration } from '../utils/schema-migrations.js';
import {
  CliUsageError,
  flagBool,
  listFlag,
  loadModule,
  numberFlag,
  type ParsedArgs,
  printTable,
  stringFlag,
  writeJson,
} from './args.js';

const SQLITE_ADAPTERS: readonly SqliteAdapter[] = ['operations', 'store', 'vectors'];

/**
 * `nexus db sql | status | migrate`.
 *
 * `sql` prints the Postgres schema, so the CLI needs no driver and the schema can go through the
 * application's own review and tooling: `nexus db sql | psql "$URL"`. `status` and `migrate` reach
 * the database through a module the application writes, which exports its own client:
 *
 * ```js
 * // db.mjs
 * import pg from 'pg';
 * export const client = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 * export const close = () => client.end();
 * ```
 *
 * The module may also export `dialect` (`postgres` or `sqlite`), a `transaction` function (see
 * `PostgresMigrateOptions`), and `migrations`, a list replacing the bundled ones, for stores on
 * custom tables.
 */
export async function runDbCommand(subcommand: string | undefined, args: ParsedArgs): Promise<void> {
  if (subcommand === 'sql') return printSql(args);
  if (subcommand === 'status' || subcommand === 'migrate') return withDatabase(subcommand, args);
  throw new CliUsageError(`Unknown db command "${subcommand ?? ''}". Use sql, status, or migrate.`);
}

function printSql({ flags }: ParsedArgs): void {
  const adapters = postgresAdapters(flags);
  const vectorDimensions = numberFlag(flags, 'vector-dimensions');
  process.stdout.write(
    postgresMigration({
      ...(adapters ? { adapters } : {}),
      ...(vectorDimensions === undefined ? {} : { vectorDimensions }),
      ...(flagBool(flags, 'record') ? { record: true } : {}),
    }),
  );
}

function postgresAdapters(flags: ParsedArgs['flags']): PostgresAdapter[] | undefined {
  const adapters = listFlag(flags, 'adapters') as PostgresAdapter[] | undefined;
  const unknown = adapters?.filter((adapter) => !POSTGRES_ADAPTERS.includes(adapter));
  if (unknown?.length) {
    throw new CliUsageError(`Unknown adapter ${unknown.join(', ')}. Choose from ${POSTGRES_ADAPTERS.join(', ')}.`);
  }
  if (adapters?.includes('vectors') && numberFlag(flags, 'vector-dimensions') === undefined) {
    throw new CliUsageError('The vectors adapter needs --vector-dimensions.');
  }
  return adapters;
}

interface DatabaseModule {
  dialect: 'postgres' | 'sqlite';
  client: unknown;
  transaction?: PostgresMigrateOptions['transaction'];
  migrations?: SchemaMigration[];
  close?: () => unknown;
}

async function withDatabase(command: 'status' | 'migrate', { flags }: ParsedArgs): Promise<void> {
  const location = stringFlag(flags, 'client');
  if (!location) throw new CliUsageError(`nexus db ${command} needs --client <db.mjs>, a module exporting \`client\`.`);
  const database = await openDatabase(location, stringFlag(flags, 'dialect'));
  try {
    const migrations = database.migrations ?? (await bundledMigrations(database.dialect, flags));
    const table = stringFlag(flags, 'table');
    if (command === 'status') {
      const status = await statusOf(database, migrations, table);
      if (flagBool(flags, 'json')) writeJson(status);
      else printStatus(status);
      if (flagBool(flags, 'check') && !status.current) process.exitCode = 1;
      return;
    }
    const result = await migrate(database, migrations, { dryRun: flagBool(flags, 'dry-run'), table });
    if (flagBool(flags, 'json')) writeJson(result);
    else printResult(result);
  } finally {
    await database.close?.();
  }
}

async function openDatabase(location: string, dialectFlag: string | undefined): Promise<DatabaseModule> {
  const loaded = await loadModule(location);
  const client = loaded.client ?? loaded.default;
  if (!client || typeof client !== 'object') {
    throw new CliUsageError(`${location} must export a database client as \`client\`.`);
  }
  const candidate = client as Record<string, unknown>;
  const dialect = (dialectFlag ?? loaded.dialect) as string | undefined;
  const detected =
    dialect ??
    (typeof candidate.query === 'function'
      ? 'postgres'
      : typeof candidate.prepare === 'function' || typeof candidate.exec === 'function'
        ? 'sqlite'
        : undefined);
  if (detected !== 'postgres' && detected !== 'sqlite') {
    throw new CliUsageError(
      `${location} exports a client this CLI cannot recognize. Export \`dialect\` as "postgres" or "sqlite".`,
    );
  }
  return {
    dialect: detected,
    client,
    ...(typeof loaded.transaction === 'function'
      ? { transaction: loaded.transaction as PostgresMigrateOptions['transaction'] }
      : {}),
    ...(Array.isArray(loaded.migrations) ? { migrations: loaded.migrations as SchemaMigration[] } : {}),
    ...(typeof loaded.close === 'function' ? { close: loaded.close as () => unknown } : {}),
  };
}

async function bundledMigrations(
  dialect: DatabaseModule['dialect'],
  flags: ParsedArgs['flags'],
): Promise<SchemaMigration[]> {
  if (dialect === 'postgres') {
    const adapters = postgresAdapters(flags);
    const vectorDimensions = numberFlag(flags, 'vector-dimensions');
    return postgresMigrations({
      ...(adapters ? { adapters } : {}),
      ...(vectorDimensions === undefined ? {} : { vectorDimensions }),
    });
  }
  const adapters = listFlag(flags, 'adapters') as SqliteAdapter[] | undefined;
  const unknown = adapters?.filter((adapter) => !SQLITE_ADAPTERS.includes(adapter));
  if (unknown?.length) {
    throw new CliUsageError(`Unknown SQLite adapter ${unknown.join(', ')}. Choose from ${SQLITE_ADAPTERS.join(', ')}.`);
  }
  const { sqliteMigrations } = await import('../sqlite/index.js');
  return sqliteMigrations(adapters ? { adapters } : {});
}

async function statusOf(
  database: DatabaseModule,
  migrations: SchemaMigration[],
  table: string | undefined,
): Promise<MigrationStatus> {
  const options = table ? { table } : {};
  if (database.dialect === 'postgres') {
    const { postgresMigrationStatus } = await import('../postgres/migrations.js');
    return postgresMigrationStatus(database.client as PostgresLikeClient, migrations, options);
  }
  const { sqliteMigrationStatus } = await import('../sqlite/migrations.js');
  return sqliteMigrationStatus(database.client as never, migrations, options);
}

async function migrate(
  database: DatabaseModule,
  migrations: SchemaMigration[],
  options: { dryRun: boolean; table: string | undefined },
): Promise<MigrationResult> {
  const common = { dryRun: options.dryRun, ...(options.table ? { table: options.table } : {}) };
  if (database.dialect === 'postgres') {
    const { applyPostgresMigrations } = await import('../postgres/migrations.js');
    return applyPostgresMigrations(database.client as PostgresLikeClient, migrations, {
      ...common,
      ...(database.transaction ? { transaction: database.transaction } : {}),
    });
  }
  const { applySqliteMigrations } = await import('../sqlite/migrations.js');
  return applySqliteMigrations(database.client as never, migrations, common);
}

function printStatus(status: MigrationStatus): void {
  const changed = new Set(status.changed.map(({ migration }) => `${migration.component}@${migration.version}`));
  const rows = [
    ...status.applied
      .filter((row) => !status.unknown.includes(row))
      .map((row) => {
        const key = `${row.component}@${row.version}`;
        return {
          component: row.component,
          version: String(row.version),
          name: row.name,
          state: changed.has(key) ? 'changed' : 'applied',
          applied: row.appliedAt,
        };
      }),
    ...status.unknown.map((row) => ({
      component: row.component,
      version: String(row.version),
      name: row.name,
      state: 'newer release',
      applied: row.appliedAt,
    })),
    ...status.pending.map((migration) => ({
      component: migration.component,
      version: String(migration.version),
      name: migration.name,
      state: 'pending',
      applied: '',
    })),
  ];
  if (rows.length === 0) {
    console.log('No migrations known or recorded.');
    return;
  }
  printTable(rows, ['component', 'version', 'name', 'state', 'applied']);
  console.log(
    status.current
      ? '\nUp to date.'
      : `\n${status.pending.length} pending${status.changed.length ? `, ${status.changed.length} changed after they ran` : ''}. Run: nexus db migrate`,
  );
}

function printResult(result: MigrationResult): void {
  if (result.applied.length === 0) {
    console.log('Nothing to apply: the database is up to date.');
    return;
  }
  const verb = result.dryRun ? 'Would apply' : 'Applied';
  for (const migration of result.applied)
    console.log(`${verb} ${migration.component} v${migration.version}: ${migration.name}`);
  if (result.dryRun) {
    console.log('\n-- The statements, in order:\n');
    console.log(`${result.statements.join(';\n\n')};`);
  }
}
