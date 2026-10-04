import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  applyPostgresMigrations,
  PostgresOperationStore,
  type PostgresLikeClient,
  postgresMigration,
  postgresMigrations,
  postgresMigrationStatus,
  type SchemaMigration,
  SchemaMigrationError,
} from '../src/postgres/index.js';
import {
  applySqliteMigrations,
  SqliteOperationStore,
  sqliteMigrations,
  sqliteMigrationStatus,
} from '../src/sqlite/index.js';
import { migrationChecksum } from '../src/utils/schema-migrations.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'nexus-migrations-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const sample = (component: string, statements: string[][]): SchemaMigration[] =>
  statements.map((list, index) => ({ component, version: index + 1, name: `step ${index + 1}`, statements: list }));

async function withPglite<T>(run: (db: PGlite, client: PostgresLikeClient) => Promise<T>): Promise<T> {
  const db = new PGlite();
  await db.waitReady;
  try {
    return await run(db, db as unknown as PostgresLikeClient);
  } finally {
    await db.close();
  }
}

/** Runs the CLI from source, as the other CLI tests do. */
function nexus(args: string[]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('Postgres migrations apply once, in order, and record a checksum for each', async () => {
  await withPglite(async (_db, client) => {
    const migrations = postgresMigrations();
    const before = await postgresMigrationStatus(client, migrations);
    assert.equal(before.applied.length, 0);
    assert.equal(before.pending.length, migrations.length);
    assert.equal(before.current, false);

    const first = await applyPostgresMigrations(client, migrations);
    assert.equal(first.applied.length, migrations.length);
    assert.ok(first.statements.length >= migrations.length);
    const second = await applyPostgresMigrations(client, migrations);
    assert.deepEqual(second.applied, [], 'a second run applies nothing');

    const after = await postgresMigrationStatus(client, migrations);
    assert.equal(after.current, true);
    assert.equal(after.applied.length, migrations.length);
    for (const row of after.applied) {
      const known = migrations.find((m) => m.component === row.component && m.version === row.version);
      assert.equal(row.checksum, migrationChecksum(known as SchemaMigration));
    }
    const { rows } = await client.query(
      "SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = 'nexus_operations_queued'",
    );
    assert.equal((rows[0] as { n: number }).n, 1, 'version 2 of the operation store ran');
  });
});

test('a dry run writes nothing, not even the migrations table', async () => {
  await withPglite(async (_db, client) => {
    const result = await applyPostgresMigrations(client, postgresMigrations({ adapters: ['operations'] }), {
      dryRun: true,
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.applied.length, 3);
    assert.match(result.statements.join('\n'), /CREATE TABLE IF NOT EXISTS "nexus_operations"/);
    const { rows } = await client.query("SELECT to_regclass('nexus_schema_migrations') IS NULL AS absent");
    assert.equal((rows[0] as { absent: boolean }).absent, true);
  });
});

test('an edited migration is refused before anything runs, and a newer release is left alone', async () => {
  await withPglite(async (_db, client) => {
    const original = sample('demo:things', [['CREATE TABLE IF NOT EXISTS things (id text PRIMARY KEY)']]);
    await applyPostgresMigrations(client, original);

    const edited = sample('demo:things', [['CREATE TABLE IF NOT EXISTS things (id text PRIMARY KEY, extra text)']]);
    const status = await postgresMigrationStatus(client, edited);
    assert.equal(status.changed.length, 1);
    assert.equal(status.current, false);
    await assert.rejects(
      applyPostgresMigrations(client, [
        ...edited,
        ...sample('demo:other', [['CREATE TABLE IF NOT EXISTS other (id text)']]),
      ]),
      (error: unknown) => error instanceof SchemaMigrationError && error.code === 'MIGRATION_CHANGED',
    );
    const { rows } = await client.query("SELECT to_regclass('other') IS NULL AS absent");
    assert.equal((rows[0] as { absent: boolean }).absent, true, 'nothing ran');

    // A newer release recorded version 2; this code knows only version 1 and must not object.
    const newer = sample('demo:things', [
      ['CREATE TABLE IF NOT EXISTS things (id text PRIMARY KEY)'],
      ['ALTER TABLE things ADD COLUMN IF NOT EXISTS note text'],
    ]);
    await applyPostgresMigrations(client, newer);
    const older = await postgresMigrationStatus(client, original);
    assert.equal(older.current, true);
    assert.deepEqual(
      older.unknown.map((row) => row.version),
      [2],
    );
    assert.deepEqual((await applyPostgresMigrations(client, original)).applied, []);
  });
});

test('a list with a gap or a duplicate is refused', async () => {
  await withPglite(async (_db, client) => {
    const gap: SchemaMigration[] = [{ component: 'demo:gap', version: 2, name: 'two', statements: ['SELECT 1'] }];
    await assert.rejects(applyPostgresMigrations(client, gap), /skips version 1/);
    const twice: SchemaMigration[] = [
      { component: 'demo:twice', version: 1, name: 'one', statements: ['SELECT 1'] },
      { component: 'demo:twice', version: 1, name: 'again', statements: ['SELECT 1'] },
    ];
    await assert.rejects(applyPostgresMigrations(client, twice), /listed twice/);
    await assert.rejects(
      applyPostgresMigrations(client, [{ component: 'demo:empty', version: 1, name: 'none', statements: [] }]),
      /no statements/,
    );
  });
});

test('migrators racing on one database each apply nothing twice', async () => {
  await withPglite(async (_db, client) => {
    const migrations = postgresMigrations();
    const results = await Promise.all(Array.from({ length: 5 }, () => applyPostgresMigrations(client, migrations)));
    const applied = results.flatMap((result) => result.applied.map((m) => `${m.component}@${m.version}`));
    assert.equal(applied.length, migrations.length, 'every migration was applied by exactly one migrator');
    assert.equal(new Set(applied).size, migrations.length);
    const { rows } = await client.query('SELECT count(*)::int AS n FROM nexus_schema_migrations');
    assert.equal((rows[0] as { n: number }).n, migrations.length);
  });
});

test('a held lock makes a second migrator wait, and a lapsed one is taken over', async () => {
  await withPglite(async (_db, client) => {
    const migrations = postgresMigrations({ adapters: ['circuits'] });
    await applyPostgresMigrations(client, sample('demo:boot', [['SELECT 1']]));
    await client.query(
      "INSERT INTO nexus_schema_migrations_lock (name, owner, expires_at) VALUES ('migrate', 'someone-else', (extract(epoch from clock_timestamp()) * 1000) + 60000)",
    );
    await assert.rejects(
      applyPostgresMigrations(client, migrations, { lockTimeoutMs: 120 }),
      (error: unknown) => error instanceof SchemaMigrationError && error.code === 'MIGRATION_LOCKED',
    );

    await client.query("UPDATE nexus_schema_migrations_lock SET expires_at = 0 WHERE owner = 'someone-else'");
    const result = await applyPostgresMigrations(client, migrations, { lockTimeoutMs: 120 });
    assert.equal(result.applied.length, 2, 'both versions of the circuit store');
    const { rows } = await client.query('SELECT count(*)::int AS n FROM nexus_schema_migrations_lock');
    assert.equal((rows[0] as { n: number }).n, 0, 'the lock is released afterwards');
  });
});

test('with a transaction, a failing migration leaves nothing behind; without one, it runs again next time', async () => {
  await withPglite(async (db, client) => {
    const failing = sample('demo:atomic', [
      ['CREATE TABLE IF NOT EXISTS atomic_a (id text)', 'CREATE TABLE IF NOT EXISTS atomic_b (id text', 'SELECT 1'],
    ]);
    await assert.rejects(
      applyPostgresMigrations(client, failing, { transaction: (run) => db.transaction((tx) => run(tx as never)) }),
    );
    const { rows } = await client.query("SELECT to_regclass('atomic_a') IS NULL AS absent");
    assert.equal((rows[0] as { absent: boolean }).absent, true, 'rolled back');

    await assert.rejects(applyPostgresMigrations(client, failing));
    const status = await postgresMigrationStatus(client, failing);
    assert.equal(status.pending.length, 1, 'not recorded, so it runs again');
    const fixed = sample('demo:atomic', [
      ['CREATE TABLE IF NOT EXISTS atomic_a (id text)', 'CREATE TABLE IF NOT EXISTS atomic_b (id text)', 'SELECT 1'],
    ]);
    assert.equal((await applyPostgresMigrations(client, fixed)).applied.length, 1);
  });
});

test('the SQL script can record what it creates, so status agrees with a database built by other tooling', async () => {
  await withPglite(async (db, client) => {
    await db.exec(postgresMigration({ record: true }));
    await db.exec(postgresMigration({ record: true }));
    const status = await postgresMigrationStatus(client, postgresMigrations());
    assert.equal(status.current, true);
    assert.doesNotMatch(postgresMigration(), /nexus_schema_migrations/, 'recording is opt-in');
  });
});

test('an adapter migrates itself on a custom table, recorded under its own component', async () => {
  await withPglite(async (_db, client) => {
    const store = new PostgresOperationStore(client, { table: 'tenant_a_ops' });
    const result = await store.migrate();
    assert.deepEqual(
      result.applied.map((m) => `${m.component}@${m.version}`),
      ['operations:tenant_a_ops@1', 'operations:tenant_a_ops@2', 'operations:tenant_a_ops@3'],
    );
    assert.deepEqual((await store.migrate()).applied, []);
    const status = await postgresMigrationStatus(client, postgresMigrations({ adapters: ['operations'] }));
    assert.equal(status.pending.length, 3, 'the default table is a different component');
  });
});

test('SQLite migrations apply once, each atomically, and refuse an edited migration', async () => {
  const db = new DatabaseSync(':memory:');
  const migrations = sqliteMigrations();
  assert.equal((await sqliteMigrationStatus(db, migrations)).pending.length, migrations.length);
  const first = await applySqliteMigrations(db, migrations);
  assert.equal(first.applied.length, migrations.length);
  assert.deepEqual((await applySqliteMigrations(db, migrations)).applied, []);
  assert.equal((await sqliteMigrationStatus(db, migrations)).current, true);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'nexus_operations_%'")
    .all();
  assert.ok(indexes.some((row) => (row as { name: string }).name === 'nexus_operations_tenant_queued'));

  const failing = sample('demo:atomic', [['CREATE TABLE atomic_a (id TEXT)', 'CREATE TABLE atomic_b (id TEXT']]);
  await assert.rejects(applySqliteMigrations(db, failing));
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'atomic_a'").get()?.n,
    0,
    'rolled back',
  );

  await applySqliteMigrations(db, sample('demo:edit', [['CREATE TABLE IF NOT EXISTS edit_a (id TEXT)']]));
  await assert.rejects(
    applySqliteMigrations(db, sample('demo:edit', [['CREATE TABLE IF NOT EXISTS edit_a (id TEXT, more TEXT)']])),
    (error: unknown) => error instanceof SchemaMigrationError && error.code === 'MIGRATION_CHANGED',
  );
  const dry = await applySqliteMigrations(new DatabaseSync(':memory:'), migrations, { dryRun: true });
  assert.equal(dry.applied.length, migrations.length);
});

test('two SQLite handles migrating one file both succeed, and each migration is recorded once', async () => {
  const file = path.join(scratch, 'race.db');
  const a = new DatabaseSync(file);
  const b = new DatabaseSync(file);
  a.exec('PRAGMA busy_timeout = 5000');
  b.exec('PRAGMA busy_timeout = 5000');
  const migrations = sqliteMigrations();
  await Promise.all([applySqliteMigrations(a, migrations), applySqliteMigrations(b, migrations)]);
  assert.equal(a.prepare('SELECT count(*) AS n FROM nexus_schema_migrations').get()?.n, migrations.length);
  const store = new SqliteOperationStore(b);
  assert.deepEqual((await store.migrate()).applied, []);
  a.close();
  b.close();
});

test('nexus db status and migrate reach a database through the application module', () => {
  const file = path.join(scratch, 'cli.db');
  const module = path.join(scratch, 'db.mjs');
  writeFileSync(
    module,
    `import { DatabaseSync } from 'node:sqlite';
export const client = new DatabaseSync(${JSON.stringify(file)});
export const close = () => client.close();
`,
  );
  const db = (...args: string[]) => nexus(['db', ...args, '--client', module]);

  const pending = db('status', '--check');
  assert.equal(pending.status, 1, '--check fails while anything is pending');
  assert.match(pending.stdout, /pending/);

  assert.match(db('migrate', '--dry-run').stdout, /Would apply operations:nexus_operations v1/);
  const applied = db('migrate');
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /Applied operations:nexus_operations v3: index queued work by tenant/);
  assert.match(db('migrate').stdout, /Nothing to apply/);

  const status = db('status', '--json', '--check');
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).current, true);

  assert.equal(nexus(['db', 'status']).status, 2, 'a missing --client is a usage mistake');
  assert.match(nexus(['db', 'drop']).stderr, /Use sql, status, or migrate/);
  assert.match(db('migrate', '--adapters', 'traces').stderr, /Unknown SQLite adapter traces/);
});
