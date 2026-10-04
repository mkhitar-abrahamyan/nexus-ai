/**
 * Ten workers race the same thread, operation, tenant budget, and circuit, on every shared store, and
 * every invariant holds: one run holds a thread at a time, an operation runs once, no spend is lost and
 * no slot is over-granted, and failures seen by different workers add up to one decision.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { RedisOperationStore } from '../src/operations/adapters.js';
import { OperationRunner } from '../src/operations/runner.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import { CircuitBreaker } from '../src/ops/circuit-breaker.js';
import { MemoryCircuitStateStore, RedisCircuitStateStore } from '../src/ops/circuit-store.js';
import { PostgresCircuitStateStore, type PostgresLikeClient, PostgresOperationStore } from '../src/postgres/index.js';
import { functionAssistant } from '../src/server/assistant.js';
import { ThreadBusyError } from '../src/server/errors.js';
import { MemoryRunEventLog } from '../src/server/events.js';
import { createAgentServer } from '../src/server/server.js';
import { fromStore } from '../src/server/state.js';
import { MemoryTenantUsage, RedisTenantUsage, tenantLimits } from '../src/server/tenancy.js';
import { SqliteOperationStore } from '../src/sqlite/index.js';
import { MemoryStore } from '../src/store/memory.js';
import type { CircuitStateStore } from '../src/ops/circuit-breaker.js';
import type { OperationStore } from '../src/types/operations.js';
import type { RunRecord } from '../src/types/server.js';
import { FakeRedis } from './redis-fake.js';

const WORKERS = 10;
let redis: FakeRedis;
let pg: PGlite;
let pgClient: PostgresLikeClient;
let tables = 0;

before(async () => {
  redis = await FakeRedis.create();
  pg = new PGlite();
  await pg.waitReady;
  pgClient = pg as unknown as PostgresLikeClient;
});
after(async () => {
  redis.close();
  await pg.close();
});

/** A fresh operation store of every kind, each on its own tables or keys. */
async function operationStores(): Promise<Array<[string, OperationStore<unknown>]>> {
  tables += 1;
  const postgres = new PostgresOperationStore<unknown>(pgClient, { table: `race_ops_${tables}` });
  await postgres.migrate();
  const sqlite = new SqliteOperationStore<unknown>(new DatabaseSync(':memory:'));
  await sqlite.migrate();
  return [
    ['memory', new MemoryOperationStore<unknown>()],
    ['sqlite', sqlite],
    ['postgres', postgres],
    ['redis', new RedisOperationStore<unknown>(redis, { prefix: `race-${tables}:` })],
    ['redis indexed', new RedisOperationStore<unknown>(redis, { prefix: `race-indexed-${tables}:`, index: true })],
  ];
}

async function settle(server: ReturnType<typeof createAgentServer>, runId: string): Promise<RunRecord> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const run = await server.runs.run(runId);
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${runId} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('ten replicas starting runs on one thread at once: exactly one holds it', async () => {
  for (const [name, store] of await operationStores()) {
    let running = 0;
    let most = 0;
    const assistant = functionAssistant(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return { ok: true };
    });
    const shared = { state: fromStore(new MemoryStore()), events: new MemoryRunEventLog(), operations: { store } };
    const replicas = Array.from({ length: WORKERS }, () =>
      createAgentServer({ assistants: { a: assistant }, ...shared }),
    );
    const thread = await replicas[0]?.runs.createThread({ assistant: 'a' });
    const threadId = thread?.id as string;

    const outcomes = await Promise.allSettled(
      replicas.map((replica) => replica.runs.start({ assistant: 'a', threadId, input: {}, onBusy: 'reject' })),
    );
    const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const refused = outcomes.filter(
      (outcome) => outcome.status === 'rejected' && outcome.reason instanceof ThreadBusyError,
    );
    assert.equal(accepted.length, 1, `${name}: one run took the thread`);
    assert.equal(refused.length, WORKERS - 1, `${name}: the rest were refused as busy`);
    const first = (accepted[0] as PromiseFulfilledResult<RunRecord>).value;
    assert.equal((await settle(replicas[0] as never, first.id)).status, 'succeeded');

    // With the thread free again, ten replicas queueing behind each other all run, one at a time.
    // Waiting turns take a poll each, so this runs on one store of each kind of locking.
    if (name !== 'memory' && name !== 'postgres') continue;
    const queued = await Promise.all(
      replicas.map((replica) => replica.runs.start({ assistant: 'a', threadId, input: {}, onBusy: 'enqueue' })),
    );
    for (const run of queued) assert.equal((await settle(replicas[0] as never, run.id)).status, 'succeeded', name);
    assert.equal(most, 1, `${name}: never two runs on the thread at once`);
  }
});

test('ten workers submitting one idempotency key run the work once', async () => {
  for (const [name, store] of await operationStores()) {
    let executions = 0;
    const runners = Array.from({ length: WORKERS }, () => new OperationRunner<unknown>({ store, heartbeatMs: 20 }));
    const handles = await Promise.all(
      runners.map((runner) =>
        runner.submit(
          async () => {
            executions += 1;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return 'charged once';
          },
          { idempotencyKey: 'charge-order-42' },
        ),
      ),
    );
    assert.equal(new Set(handles.map((handle) => handle.id)).size, 1, `${name}: one operation`);
    assert.deepEqual(
      await Promise.all(handles.map((handle) => handle.result())),
      Array.from({ length: WORKERS }, () => 'charged once'),
      `${name}: every submitter gets the one result`,
    );
    assert.equal(executions, 1, `${name}: the work ran once`);
  }
});

test('ten workers draining one queue run each operation exactly once', async () => {
  for (const [name, store] of await operationStores()) {
    const producer = new OperationRunner<unknown>({ store });
    const ids: string[] = [];
    for (let index = 0; index < 50; index += 1) ids.push((await producer.enqueue({ kind: 'job' })).id);
    const ran: string[] = [];
    const runners = Array.from({ length: WORKERS }, () => new OperationRunner<unknown>({ store }));
    for (;;) {
      const handles = (
        await Promise.all(
          runners.map((runner) =>
            runner.claimQueued(async ({ operationId }) => {
              ran.push(operationId);
              return operationId;
            }, 2),
          ),
        )
      ).flat();
      if (handles.length === 0) break;
      await Promise.all(handles.map((handle) => handle.result()));
    }
    assert.equal(ran.length, ids.length, `${name}: everything ran`);
    assert.equal(new Set(ran).size, ids.length, `${name}: nothing ran twice`);
  }
});

test('ten workers spending one tenant budget lose nothing, and its slots are never over-granted', async () => {
  for (const [name, usage] of [
    ['memory', new MemoryTenantUsage()],
    ['redis', new RedisTenantUsage(redis as never, { prefix: 'race-tenants:' })],
  ] as const) {
    const limiter = tenantLimits({ tenants: { acme: { maxActiveRuns: 3, budget: { usd: 100 } } }, usage });
    const principal = { tenantId: 'acme' };
    const admitted = await Promise.allSettled(
      Array.from({ length: WORKERS }, (_, index) =>
        limiter.admit({ runId: `run-${index}`, assistant: 'a', principal }),
      ),
    );
    assert.equal(admitted.filter((outcome) => outcome.status === 'fulfilled').length, 3, `${name}: three slots`);

    await Promise.all(
      Array.from({ length: WORKERS }, (_, worker) =>
        Promise.all(
          Array.from({ length: 10 }, () => limiter.spend({ runId: `run-${worker}`, tenantId: 'acme' }, 0.25)),
        ),
      ),
    );
    const spent = (await limiter.usage('acme')).spend.usd;
    assert.ok(Math.abs(spent - 25) < 1e-9, `${name}: 100 spends of $0.25 are $25, got ${spent}`);
  }
});

test('ten workers share one circuit: their failures add up, and one of them probes', async () => {
  let clock = Date.parse('2026-10-04T12:00:00.000Z');
  const now = () => clock;
  redis.now = now;
  tables += 1;
  const postgres = new PostgresCircuitStateStore(pgClient, { table: `race_circuits_${tables}`, now });
  await postgres.migrate();
  const stores: Array<[string, CircuitStateStore]> = [
    ['memory', new MemoryCircuitStateStore(now)],
    ['redis', new RedisCircuitStateStore(redis, { prefix: `race-circuits-${tables}:` })],
    ['postgres', postgres],
  ];

  for (const [name, store] of stores) {
    const breakers = Array.from(
      { length: WORKERS },
      (_, index) =>
        new CircuitBreaker({
          enabled: true,
          store,
          shareObservations: true,
          failureThreshold: WORKERS,
          resetTimeoutMs: 1_000,
          workerId: `w${index}`,
          now,
        }),
    );
    for (const breaker of breakers) await breaker.sync();
    for (const breaker of breakers) breaker.recordFailure('openai', new Error('503'));
    assert.ok(
      breakers.every((breaker) => breaker.state('openai') === 'closed'),
      `${name}: no worker saw ten alone`,
    );

    await Promise.all(breakers.map((breaker) => breaker.sync()));
    await Promise.all(breakers.map((breaker) => breaker.flush()));
    await Promise.all(breakers.map((breaker) => breaker.sync()));
    assert.ok(
      breakers.every((breaker) => breaker.state('openai') === 'open'),
      `${name}: ten failures on ten workers opened the circuit on all of them`,
    );

    clock += 1_000;
    await Promise.all(breakers.map((breaker) => breaker.sync()));
    const probing = breakers.filter((breaker) => breaker.state('openai') === 'half-open');
    assert.equal(probing.length, 1, `${name}: exactly one worker probes`);
    const prober = probing[0] as CircuitBreaker;
    assert.equal(prober.allowRequest('openai'), true);
    prober.recordSuccess('openai');
    await prober.flush();
    await Promise.all(breakers.map((breaker) => breaker.sync()));
    assert.ok(
      breakers.every((breaker) => breaker.state('openai') === 'closed'),
      `${name}: the probe closed it everywhere`,
    );

    // The failures that opened it do not reopen it: one new failure is one.
    (breakers[3] as CircuitBreaker).recordFailure('openai', new Error('503'));
    await Promise.all(breakers.map((breaker) => breaker.sync()));
    assert.ok(
      breakers.every((breaker) => breaker.state('openai') === 'closed'),
      `${name}: a fresh count after closing`,
    );
    assert.equal((breakers[3] as CircuitBreaker).snapshot('openai')[0]?.shared?.consecutiveFailures, 1, name);
    clock += 120_000;
  }
});

test('nine failures across three workers count as nine, and without sharing they never do', async () => {
  let clock = Date.parse('2026-10-04T12:00:00.000Z');
  const now = () => clock;
  for (const shareObservations of [true, false]) {
    const store = new MemoryCircuitStateStore(now);
    const breakers = Array.from(
      { length: 3 },
      (_, index) =>
        new CircuitBreaker({
          enabled: true,
          store,
          shareObservations,
          failureThreshold: 9,
          workerId: `w${index}`,
          now,
        }),
    );
    for (const breaker of breakers) {
      for (let call = 0; call < 3; call += 1) breaker.recordFailure('anthropic', new Error('overloaded'));
    }
    for (let round = 0; round < 2; round += 1) {
      await Promise.all(breakers.map((breaker) => breaker.sync()));
      await Promise.all(breakers.map((breaker) => breaker.flush()));
    }
    const states = breakers.map((breaker) => breaker.state('anthropic'));
    assert.deepEqual(states, shareObservations ? ['open', 'open', 'open'] : ['closed', 'closed', 'closed']);
    clock += 1;
  }
});

test('a shared failure rate opens the circuit once the window holds enough calls from every worker', async () => {
  const clock = Date.parse('2026-10-04T12:00:00.000Z');
  const store = new MemoryCircuitStateStore(() => clock);
  const breakers = Array.from(
    { length: 5 },
    (_, index) =>
      new CircuitBreaker({
        enabled: true,
        store,
        shareObservations: true,
        failureThreshold: 100,
        failureRateThreshold: 0.5,
        minimumThroughput: 10,
        workerId: `w${index}`,
        now: () => clock,
      }),
  );
  // Each worker sees one failure and one success: never a streak, never ten calls on its own.
  for (const breaker of breakers) {
    breaker.recordFailure('groq', new Error('500'));
    breaker.recordSuccess('groq');
  }
  for (let round = 0; round < 2; round += 1) {
    await Promise.all(breakers.map((breaker) => breaker.sync()));
    await Promise.all(breakers.map((breaker) => breaker.flush()));
  }
  assert.ok(breakers.every((breaker) => breaker.state('groq') === 'open'));
  assert.match((breakers[0] as CircuitBreaker).snapshot('groq')[0]?.state ?? '', /open/);
});
