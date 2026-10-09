/**
 * `nexus doctor` reports each misconfiguration a fixture deployment is seeded with, and passes the
 * same deployment once each is fixed.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { diagnose, type DoctorReport } from '../src/doctor/index.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import { RedisOperationStore } from '../src/operations/adapters.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import { MemoryCircuitStateStore } from '../src/ops/circuit-store.js';
import { MemoryTenantUsage } from '../src/server/tenancy.js';
import { applySqliteMigrations, sqliteMigrations } from '../src/sqlite/index.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer } from '../src/tracing/tracer.js';

/** A Redis client with the commands a store needs to be built, never called by the doctor. */
const redisClient = () => ({
  hget: async () => null,
  hset: async () => 1,
  hdel: async () => 1,
  hvals: async () => [],
  zadd: async () => 1,
  zrem: async () => 1,
  zrangebyscore: async () => [],
});
/** A trace store that is not in process memory, as the doctor sees one. */
class PostgresTraceStore {}

const scratch = mkdtempSync(path.join(tmpdir(), 'nexus-doctor-'));
after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const statusOf = (report: DoctorReport) => Object.fromEntries(report.checks.map((check) => [check.id, check.status]));

test('every seeded misconfiguration is reported, each by its own check', async () => {
  const operations = new MemoryOperationStore();
  await operations.create({
    id: 'stuck',
    status: 'running',
    attempt: 1,
    maxAttempts: 3,
    sequence: 1,
    createdAt: '2027-05-31T00:00:00.000Z',
    updatedAt: '2027-05-31T00:00:00.000Z',
    lease: { owner: 'dead-worker', expiresAt: '2027-05-31T00:05:00.000Z' },
  });
  await operations.create({
    id: 'waiting',
    status: 'queued',
    attempt: 1,
    maxAttempts: 3,
    sequence: 0,
    createdAt: '2027-05-31T22:00:00.000Z',
    updatedAt: '2027-05-31T22:00:00.000Z',
  });
  const report = await diagnose({
    nodeVersion: '20.11.0',
    env: {},
    resolvePackage: (name) => name === 'zod',
    now: () => new Date('2027-06-01T00:00:00.000Z'),
    database: { client: new DatabaseSync(':memory:') },
    redis: {
      ping: () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      },
    },
    operations,
    ai: {
      getProviderHealth: () => [
        { providerName: 'openai', healthy: true, stale: true },
        { providerName: 'groq', healthy: false },
      ],
    },
    deployment: {
      replicas: 3,
      stores: {
        checkpointer: new MemoryGraphCheckpointer(),
        tenantUsage: new MemoryTenantUsage(),
        circuits: new MemoryCircuitStateStore(),
        queue: new RedisOperationStore(redisClient() as never),
        tracer: new Tracer({ store: new PostgresTraceStore() as never }),
      },
    },
  });

  assert.deepEqual(statusOf(report), {
    node: 'fail',
    peers: 'ok',
    credentials: 'warn',
    registry: 'warn',
    database: 'ok',
    migrations: 'fail',
    redis: 'fail',
    queue: 'warn',
    health: 'warn',
    topology: 'fail',
    settings: 'warn',
  });
  const detail = (id: string) => report.checks.find((check) => check.id === id)?.detail ?? '';
  assert.match(detail('node'), /needs 22 or newer/);
  assert.match(detail('peers'), /Installed: zod/);
  assert.match(detail('migrations'), /pending: operations:nexus_operations v1/);
  assert.match(detail('redis'), /ECONNREFUSED/);
  assert.match(
    detail('queue'),
    /1 running operation hold a lease that lapsed; the oldest queued operation has waited 120 minutes/,
  );
  assert.match(detail('health'), /stale: openai; unhealthy: groq/);
  assert.match(detail('topology'), /checkpointer is a MemoryGraphCheckpointer/);
  assert.match(detail('topology'), /tenantUsage is a MemoryTenantUsage/);
  assert.match(detail('topology'), /circuits is a MemoryCircuitStateStore/);
  assert.equal(report.ok, false);
  assert.equal(report.failures, 4);
  assert.match(detail('settings'), /queue is a RedisOperationStore without index: true/);
  assert.match(detail('settings'), /tracer writes to a PostgresTraceStore without incremental/);
  assert.match(
    report.checks.find((check) => check.id === 'settings')?.hint ?? '',
    /index: true.*reindex().*incremental: true/,
  );
  assert.equal(report.warnings, 5);
  assert.ok(
    report.checks.every((check) => !JSON.stringify(check).includes('sk-')),
    'no secret is printed',
  );
});

test('the same deployment, fixed, passes every check', async () => {
  const db = new DatabaseSync(':memory:');
  await applySqliteMigrations(db, sqliteMigrations());
  class PostgresLikeCheckpointer {}
  const report = await diagnose({
    nodeVersion: '24.1.0',
    env: { OPENAI_API_KEY: 'sk-test-not-printed' },
    resolvePackage: () => false,
    now: () => new Date('2026-10-05T00:00:00.000Z'),
    database: { client: db },
    redis: { ping: () => 'PONG' },
    operations: new MemoryOperationStore(),
    ai: { getProviderHealth: () => [{ providerName: 'openai', healthy: true }] },
    deployment: {
      replicas: 3,
      stores: {
        checkpointer: new PostgresLikeCheckpointer(),
        queue: new RedisOperationStore(redisClient() as never, { index: true }),
        tracer: new Tracer({ store: new PostgresTraceStore() as never, incremental: true }),
        // A tracer in memory has nothing to lose to a crash that it would not lose anyway.
        local: new Tracer({ store: new MemoryTraceStore() }),
      },
    },
  });
  assert.equal(report.ok, true, JSON.stringify(report.checks, null, 2));
  assert.equal(report.warnings, 0);
  assert.match(report.checks.find((check) => check.id === 'credentials')?.detail ?? '', /openai/);
  assert.ok(!JSON.stringify(report).includes('sk-test-not-printed'), 'only the provider name is reported');
  const empty = await diagnose({ nodeVersion: '22.0.0', env: {}, resolvePackage: () => true });
  assert.deepEqual(
    empty.checks.filter((check) => check.status === 'skip').map((check) => check.id),
    ['database', 'migrations', 'redis', 'queue', 'health', 'topology', 'settings'],
  );
});

test('nexus doctor exits 1 on a failure, and with --strict on a warning', () => {
  const file = path.join(scratch, 'doctor.db');
  const module = path.join(scratch, 'doctor.mjs');
  writeFileSync(
    module,
    `import { DatabaseSync } from 'node:sqlite';\nexport const client = new DatabaseSync(${JSON.stringify(file)});\nexport const close = () => client.close();\n`,
  );
  const nexus = (...args: string[]) =>
    spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), ...args], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', OPENAI_API_KEY: 'sk-cli-not-printed' },
    });
  const failing = nexus('doctor', '--module', module);
  assert.equal(failing.status, 1, failing.stderr);
  assert.match(failing.stdout, /FAIL {2}Schema migrations: \d+ pending/);
  assert.match(failing.stdout, /nexus db migrate/);
  assert.doesNotMatch(failing.stdout, /sk-cli-not-printed/);

  assert.equal(nexus('db', 'migrate', '--client', module).status, 0);
  const passing = nexus('doctor', '--module', module, '--json');
  assert.equal(passing.status, 0, passing.stdout);
  assert.equal(JSON.parse(passing.stdout).ok, true);
  assert.equal(nexus('doctor', '--module', module, '--replicas', '2').status, 0, 'no store given is nothing to refuse');

  const warning = path.join(scratch, 'warning.mjs');
  writeFileSync(
    warning,
    "export const ai = { getProviderHealth: () => [{ providerName: 'openai', healthy: true, stale: true }] };\n",
  );
  const warned = nexus('doctor', '--module', warning);
  assert.equal(warned.status, 0, 'a warning alone passes');
  assert.match(warned.stdout, /warn {2}Provider health: stale: openai/);
  assert.equal(nexus('doctor', '--module', warning, '--strict').status, 1, '--strict fails on it');
});
