/**
 * The upgrade proof: a database created by the published 2.0.0 package is upgraded by 2.2's
 * migrations, and a worker running the published 2.1.0 package shares it with a 2.2 worker during the
 * rollout. Both old releases are the real packages from npm, installed as development aliases, so
 * nothing here imitates what an older release does.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import * as v20operations from 'nexus-ai-pro-2-0/operations';
import * as v20postgres from 'nexus-ai-pro-2-0/postgres';
import * as v20sqlite from 'nexus-ai-pro-2-0/sqlite';
import * as v21operations from 'nexus-ai-pro-2-1/operations';
import * as v21postgres from 'nexus-ai-pro-2-1/postgres';
import * as v21sqlite from 'nexus-ai-pro-2-1/sqlite';
import { OperationRunner } from '../src/operations/runner.js';
import {
  applyPostgresMigrations,
  PostgresOperationStore,
  type PostgresLikeClient,
  PostgresTraceStore,
  postgresMigrations,
  postgresMigrationStatus,
} from '../src/postgres/index.js';
import {
  applySqliteMigrations,
  SqliteOperationStore,
  sqliteMigrations,
  sqliteMigrationStatus,
} from '../src/sqlite/index.js';
import type { Run } from '../src/types/tracing.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'nexus-upgrade-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

interface Worker {
  name: string;
  claimQueued(
    executor: (context: { operationId: string }) => Promise<string>,
    limit?: number,
  ): Promise<Array<{ result(): Promise<string> }>>;
  enqueue(options: { kind?: string; metadata?: Record<string, unknown> }): Promise<{ id: string }>;
}

/**
 * Two workers of different releases drain one queue, each also accepting new work while it runs.
 * Every operation must run exactly once, and each release must have run some.
 */
async function rollout(
  workers: Worker[],
  read: (id: string) => Promise<{ status: string } | undefined>,
  seeded: string[],
) {
  const ran: Array<{ id: string; by: string }> = [];
  const accepted = [...seeded];
  for (let round = 0; round < 6; round += 1) {
    for (const worker of workers) accepted.push((await worker.enqueue({ kind: 'job', metadata: { round } })).id);
  }
  for (let turn = 0; ; turn += 1) {
    // Whoever asks first wins a race for the same rows, so the first to ask alternates.
    const order = turn % 2 === 0 ? workers : [...workers].reverse();
    const claims = await Promise.all(
      order.map((worker) =>
        worker.claimQueued(async ({ operationId }) => {
          ran.push({ id: operationId, by: worker.name });
          return `done ${operationId}`;
        }, 3),
      ),
    );
    const handles = claims.flat();
    if (handles.length === 0) break;
    await Promise.all(handles.map((handle) => handle.result()));
  }
  assert.equal(ran.length, accepted.length, 'every operation ran');
  assert.equal(new Set(ran.map((entry) => entry.id)).size, accepted.length, 'and none ran twice');
  for (const worker of workers) {
    assert.ok(
      ran.some((entry) => entry.by === worker.name),
      `the ${worker.name} worker ran part of the queue`,
    );
  }
  for (const id of accepted) assert.equal((await read(id))?.status, 'succeeded', id);
}

test('a Postgres database created by 2.0.0 upgrades in place, and 2.1 and 2.2 workers share it', async () => {
  const db = new PGlite();
  await db.waitReady;
  const client = db as unknown as PostgresLikeClient;
  try {
    // 2.0.0 creates its schema the way its guide says, and accepts work.
    const v20store = new v20postgres.PostgresOperationStore<string>(client as never);
    await v20store.migrate();
    const v20traces = new v20postgres.PostgresTraceStore(client as never);
    await v20traces.migrate();
    for (const adapter of [
      new v20postgres.PostgresStore(client as never),
      new v20postgres.PostgresCircuitStateStore(client as never),
      new v20postgres.PostgresPromptStore(client as never),
      new v20postgres.PostgresDatasetStore(client as never),
    ]) {
      await adapter.migrate();
    }
    const v20runner = new v20operations.OperationRunner<string>({ store: v20store });
    const seeded: string[] = [];
    for (let index = 0; index < 10; index += 1) seeded.push((await v20runner.enqueue({ kind: 'job' })).id);
    const run: Run = {
      id: 'run-1',
      traceId: 'trace-1',
      name: 'support',
      kind: 'chain',
      status: 'ok',
      startedAt: '2026-10-01T10:00:00.000Z',
      metadata: { tenantId: 'acme' },
    } as Run;
    await v20traces.save(run as never);

    // The upgrade: version 1 of every component is recognized as the 2.0 schema, and what 2.2 adds runs.
    const migrations = postgresMigrations();
    const before = await postgresMigrationStatus(client, migrations);
    assert.equal(before.applied.length, 0, 'a 2.0 database has never recorded a migration');
    const upgrade = await applyPostgresMigrations(client, migrations);
    assert.ok(upgrade.applied.some((m) => m.component === 'operations:nexus_operations' && m.version === 3));
    assert.ok(upgrade.applied.some((m) => m.component === 'traces:nexus_runs' && m.version === 2));
    assert.equal((await postgresMigrationStatus(client, migrations)).current, true);

    // What 2.0 wrote reads the same through 2.2, and the tenant index serves it.
    const v22traces = new PostgresTraceStore(client);
    assert.deepEqual(
      (await v22traces.query({ metadata: { tenantId: 'acme' } })).map((found) => found.id),
      ['run-1'],
    );

    // The rollout: a 2.1 worker restarts and runs its own migrate(), which must change nothing,
    // then drains the queue beside a 2.2 worker.
    const v21store = new v21postgres.PostgresOperationStore<string>(client as never);
    await v21store.migrate();
    assert.equal((await postgresMigrationStatus(client, migrations)).current, true);
    const v22store = new PostgresOperationStore<string>(client);
    await rollout(
      [
        { name: '2.1', ...bind(new v21operations.OperationRunner<string>({ store: v21store })) },
        { name: '2.2', ...bind(new OperationRunner<string>({ store: v22store })) },
      ],
      (id) => v22store.read(id),
      seeded,
    );
  } finally {
    await db.close();
  }
});

test('a SQLite file created by 2.0.0 upgrades in place, and 2.1 and 2.2 workers share it', async () => {
  const file = path.join(scratch, 'upgrade.db');
  const handle = () => {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  };
  const v20db = handle();
  const v20store = new v20sqlite.SqliteOperationStore<string>(v20db as never);
  await v20store.migrate();
  await new v20sqlite.SqliteStore(v20db as never).migrate();
  const v20runner = new v20operations.OperationRunner<string>({ store: v20store });
  const seeded: string[] = [];
  for (let index = 0; index < 10; index += 1) seeded.push((await v20runner.enqueue({ kind: 'job' })).id);

  const v22db = handle();
  const migrations = sqliteMigrations({ adapters: ['operations', 'store'] });
  assert.equal((await sqliteMigrationStatus(v22db, migrations)).applied.length, 0);
  const upgrade = await applySqliteMigrations(v22db, migrations);
  assert.ok(upgrade.applied.some((m) => m.version === 3));
  assert.equal((await sqliteMigrationStatus(v22db, migrations)).current, true);

  const v21db = handle();
  const v21store = new v21sqlite.SqliteOperationStore<string>(v21db as never);
  await v21store.migrate();
  const v22store = new SqliteOperationStore<string>(v22db);
  await rollout(
    [
      { name: '2.1', ...bind(new v21operations.OperationRunner<string>({ store: v21store })) },
      { name: '2.2', ...bind(new OperationRunner<string>({ store: v22store })) },
    ],
    (id) => v22store.read(id),
    seeded,
  );
  for (const db of [v20db, v21db, v22db]) db.close();
});

/** The two methods the rollout uses, bound, from a runner of any release. */
function bind(runner: {
  claimQueued(executor: never, limit?: number): Promise<unknown[]>;
  enqueue(options: never): Promise<{ id: string }>;
}): Omit<Worker, 'name'> {
  return {
    claimQueued: (executor, limit) =>
      runner.claimQueued(executor as never, limit) as Promise<Array<{ result(): Promise<string> }>>,
    enqueue: (options) => runner.enqueue(options as never),
  };
}
