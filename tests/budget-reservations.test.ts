/**
 * Budget reservations that outlive their worker, proved. On every store a reservation is recorded
 * under a lease and moves with its total in one step: reconciled, released, refused over the limit,
 * or settled from another process by what became of its operation, and of two processes settling one
 * reservation only one changes the total. An online-evaluation worker killed while holding a
 * reservation, before its evaluator, during it, or after it wrote its scores, leaves the budget where
 * the provider's bill is once another worker takes over: given back, charged by policy, or charged at
 * what the scores cost.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { onlineEvaluationWorker } from '../src/evaluate/online.js';
import { type BudgetUsageStore, budgetLedger, MemoryBudgetUsage } from '../src/lifecycle/budget.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import type { PostgresLikeClient } from '../src/postgres/client.js';
import { PostgresTenantUsage } from '../src/postgres/tenancy.js';
import { MemoryTenantUsage, RedisTenantUsage } from '../src/server/tenancy.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import type { Evaluator } from '../src/types/evaluate.js';
import type { BudgetLedger, OperationDescriptor } from '../src/types/lifecycle.js';
import type { OperationStore } from '../src/types/operations.js';
import type { Run, TraceStore } from '../src/types/tracing.js';
import { FakeRedis } from './redis-fake.js';

let redis: FakeRedis;
let pg: PGlite;
let stores = 0;

before(async () => {
  redis = await FakeRedis.create();
  pg = new PGlite();
  await pg.waitReady;
});
after(async () => {
  redis.close();
  await pg.close();
});

/** A fresh store of one kind that records reservations, on its own keys or tables. */
async function storeOf(kind: string): Promise<BudgetUsageStore> {
  stores += 1;
  if (kind === 'memory') return new MemoryBudgetUsage();
  if (kind === 'tenant memory') return new MemoryTenantUsage();
  if (kind === 'redis') return new RedisTenantUsage(redis as never, { prefix: `budget-${stores}:` });
  const postgres = new PostgresTenantUsage(pg as unknown as PostgresLikeClient, { table: `budget_usage_${stores}` });
  await postgres.migrate();
  return postgres;
}

/** A fresh store of every kind that records reservations. */
async function everyStore(): Promise<Array<[string, BudgetUsageStore]>> {
  const kinds = ['memory', 'tenant memory', 'redis', 'postgres'];
  return Promise.all(kinds.map(async (kind) => [kind, await storeOf(kind)] as [string, BudgetUsageStore]));
}

const operation = (requestId: string, name = 'test.call'): OperationDescriptor => ({
  family: 'completion',
  operation: name,
  requestId,
  tenantId: 'acme',
});
const close = (actual: number, expected: number, message: string) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);

test('every store records a reservation and moves it with its total in one step', async () => {
  for (const [name, store] of await everyStore()) {
    const ledger = budgetLedger({ limit: 1, store, leaseMs: 60_000 });
    const held = await ledger.reserve(operation('a'), 0.3);
    assert.ok(held?.id, `${name}: the reservation has an id`);
    const record = await ledger.reservation(held.id);
    assert.equal(record?.status, 'reserved', name);
    assert.equal(record?.operationId, 'a', name);
    assert.equal(record?.operation, 'test.call', name);
    close(await ledger.spent('acme'), 0.3, `${name}: held`);

    await ledger.reconcile(held, 0.12);
    assert.equal((await ledger.reservation(held.id))?.status, 'settled', name);
    close((await ledger.reservation(held.id))?.actual ?? -1, 0.12, `${name}: actual`);
    close(await ledger.spent('acme'), 0.12, `${name}: reconciled`);
    await ledger.reconcile(held, 0.5);
    close(await ledger.spent('acme'), 0.12, `${name}: a second reconcile changes nothing`);

    const released = await ledger.reserve(operation('b'), 0.2);
    await ledger.release(released as NonNullable<typeof released>);
    assert.equal((await ledger.reservation(released?.id as string))?.status, 'released', name);
    close(await ledger.spent('acme'), 0.12, `${name}: released`);

    await assert.rejects(ledger.reserve(operation('c'), 0.95), /budget/i, `${name}: over the limit`);
    close(await ledger.spent('acme'), 0.12, `${name}: a refused reservation is not charged`);
  }
});

test('a lapsed reservation is settled from another process by what became of its operation', async () => {
  for (const [name, store] of await everyStore()) {
    let clock = Date.parse('2026-10-14T12:00:00.000Z');
    const now = () => new Date(clock);
    const dead = budgetLedger({ limit: 10, store, leaseMs: 1_000, now });
    const finished = await dead.reserve(operation('finished', 'job.a'), 1);
    const neverStarted = await dead.reserve(operation('never', 'job.a'), 1);
    const unknown = await dead.reserve(operation('unknown', 'job.a'), 1);
    const running = await dead.reserve(operation('running', 'job.a'), 1);
    const foreign = await dead.reserve(operation('foreign', 'job.b'), 1);
    close(await dead.spent('acme'), 5, `${name}: five held`);

    // The process that held them is gone; another reads them back once their leases lapse.
    clock += 1_001;
    const charged = budgetLedger({ limit: 10, store, leaseMs: 1_000, now });
    const outcomes = new Map([
      ['finished', { kind: 'finished', cost: 0.25 }],
      ['never', { kind: 'never-started' }],
      ['unknown', { kind: 'unknown' }],
      ['running', { kind: 'running' }],
    ] as const);
    const report = await charged.recover((reservation) => outcomes.get(reservation.operationId as never), {
      operation: 'job.a',
    });
    assert.deepEqual(report, { settled: 1, expired: 1, uncertain: 1, renewed: 1, skipped: 0 }, name);
    // 0.25 finished, nothing for the one that never started, 1 kept for the unknown, 1 still running,
    // and 1 for the other operation's, which this pass did not read.
    close(await charged.spent('acme'), 3.25, `${name}: after recovery`);
    for (const [held, status] of [
      [finished, 'settled'],
      [neverStarted, 'expired'],
      [unknown, 'uncertain'],
      [running, 'reserved'],
      [foreign, 'reserved'],
    ] as const) {
      assert.equal((await charged.reservation(held?.id as string))?.status, status, `${name}: ${status}`);
    }
    assert.deepEqual(
      await charged.recover(() => ({ kind: 'never-started' }), { operation: 'job.a' }),
      { settled: 0, expired: 0, uncertain: 0, renewed: 0, skipped: 0 },
      `${name}: a renewed lease has not lapsed`,
    );

    // A late report from the operation itself corrects what recovery decided.
    await dead.reconcile(neverStarted as NonNullable<typeof neverStarted>, 0.5);
    await dead.reconcile(unknown as NonNullable<typeof unknown>, 0.1);
    close(await charged.spent('acme'), 3.25 + 0.5 - 0.9, `${name}: corrected`);

    // Given back on release, where the policy says so.
    const releasing = budgetLedger({ limit: 10, store, leaseMs: 1_000, now, uncertain: 'release' });
    const doubtful = await releasing.reserve(operation('doubtful', 'job.c'), 2);
    clock += 1_001;
    await releasing.recover(() => ({ kind: 'unknown' }), { operation: 'job.c' });
    assert.equal((await releasing.reservation(doubtful?.id as string))?.status, 'uncertain', name);
    close(await releasing.spent('acme'), 2.85, `${name}: an uncertain reservation given back by policy`);
  }
});

test('of two processes settling one reservation at once, one changes the total', async () => {
  for (const [name, store] of await everyStore()) {
    const ledger = budgetLedger({ limit: 100, store });
    const held = await ledger.reserve(operation('race'), 1);
    const other = budgetLedger({ limit: 100, store });
    const moves = await Promise.all([
      ledger.settle(held?.id as string, { kind: 'finished', cost: 0.4 }),
      other.settle(held?.id as string, { kind: 'never-started' }),
      other.settle(held?.id as string, { kind: 'finished', cost: 0.7 }),
    ]);
    const spent = await ledger.spent('acme');
    const record = await ledger.reservation(held?.id as string);
    assert.ok(moves.includes(true), `${name}: one moved it`);
    close(spent, record?.charged ?? -1, `${name}: the total is what the reservation charges`);
  }
});

test('a store that records reservations implements all five methods, or the ledger refuses it', () => {
  const partial: BudgetUsageStore = { add: () => 0, total: () => 0, hold: () => 0 };
  assert.throws(() => budgetLedger({ limit: 1, store: partial }), /missing settle, renew, lapsed, reservation/);
  const plain: BudgetUsageStore = { add: () => 0, total: () => 0 };
  const ledger = budgetLedger({ limit: 1, store: plain });
  return ledger.reserve(operation('plain'), 0.1).then((held) => assert.equal(held?.id, undefined));
});

test('a Redis reservation shares its total Cluster slot', async () => {
  const store = new RedisTenantUsage(redis as never, { prefix: 'slots:' });
  const ledger = budgetLedger({ limit: 1, store });
  const held = await ledger.reserve(operation('slot'), 0.1);
  const record = [...redis.hashes.keys()].find((key) => key.endsWith(`:reservation:${held?.id}`));
  assert.ok(record?.startsWith('{slots:budget:acme:'), `the record key is tagged with its total: ${record}`);
  const tag = record?.slice(1, record.indexOf('}'));
  assert.ok(redis.strings.has(tag as string), 'the tag is the total key itself');
});

// ── The online-evaluation proof ──────────────────────────────────────

function runs(count: number): MemoryTraceStore {
  const traces = new MemoryTraceStore();
  for (let index = 0; index < count; index += 1) {
    traces.save({
      id: `run-${String(index).padStart(2, '0')}`,
      traceId: `trace-${index}`,
      name: 'support-agent',
      kind: 'model',
      status: 'ok',
      startedAt: new Date(Date.parse('2026-10-14T09:00:00.000Z') + index).toISOString(),
      outputs: 'Here is your refund.',
    } satisfies Run);
  }
  return traces;
}

/** A worker's view of a shared store, which stops answering the moment its process dies. */
function mortal<T extends object>(
  target: T,
  life: { dead: boolean },
  onCall?: (name: string, args: unknown[]) => void,
): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (life.dead) throw new Error('the process died');
        onCall?.(String(property), args);
        if (life.dead) throw new Error('the process died');
        return (value as (...inner: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

type KillPoint = 'before the evaluator' | 'during the evaluator' | 'after the scores';

/**
 * Twenty runs at a cent each, estimated at five. One worker dies at `point` on its first evaluation,
 * holding its reservation; a second worker scores everything and settles what the first held.
 */
async function killed(point: KillPoint, store: BudgetUsageStore, uncertain: 'charge' | 'release' = 'charge') {
  const traces = runs(20);
  const operations = new MemoryOperationStore();
  const budget = budgetLedger({ limit: 100, store, leaseMs: 150, uncertain });
  const life = { dead: false };
  let calls = 0;
  const judge: Evaluator = () => {
    calls += 1;
    return { key: 'resolved', score: 1 };
  };
  const doomedJudge: Evaluator = (context) => {
    if (point === 'during the evaluator') {
      life.dead = true;
      throw new Error('the process died mid-call');
    }
    return judge(context);
  };
  const doomed = onlineEvaluationWorker({
    source: 'quality',
    traces: mortal(traces as TraceStore, life, (name) => {
      // Dies once its scores are on the run, before it reconciles.
      if (point === 'after the scores' && name === 'addFeedback') queueMicrotask(() => (life.dead = true));
    }),
    operations: mortal(operations as OperationStore, life, (name, args) => {
      // Dies as it records that it is about to call its evaluator, so that record never lands.
      const details = (args[0] as { heartbeatDetails?: { evaluating?: boolean } } | undefined)?.heartbeatDetails;
      if (point === 'before the evaluator' && name === 'update' && details?.evaluating) life.dead = true;
    }),
    budget: mortal(budget as BudgetLedger, life),
    evaluators: [doomedJudge],
    estimate: 0.05,
    costOf: () => 0.01,
    concurrency: 1,
    leaseMs: 100,
    owner: 'doomed',
  });
  await doomed.schedule();
  await doomed.work().catch(() => undefined);
  assert.equal(life.dead, true, `${point}: the doomed worker died`);
  close(await budget.spent('default'), 0.05, `${point}: the dead worker left its estimate charged`);
  // Its reservation was made before now, so it lapses by the wall clock within its lease from now.
  const diedAt = Date.now();

  const survivor = onlineEvaluationWorker({
    source: 'quality',
    traces,
    operations,
    budget,
    evaluators: [judge],
    estimate: 0.05,
    costOf: () => 0.01,
    leaseMs: 100,
    pollMs: 20,
    owner: 'survivor',
  });
  const report = await survivor.drain();
  assert.equal(report.stoppedBy, 'idle', point);
  // A reservation the dead worker held and never recorded lapses after its lease, and the next pass
  // settles it. The lease is kept by the wall clock, which a timer does not run on: a virtual machine's,
  // stepped back as it is synced with its host's, can be a few hundred milliseconds behind a timer.
  while (Date.now() <= diedAt + 200) await new Promise((resolve) => setTimeout(resolve, 10));
  await survivor.work();
  for (let index = 0; index < 20; index += 1) {
    const feedback = traces.get(`run-${String(index).padStart(2, '0')}`)?.feedback ?? [];
    assert.equal(feedback.length, 1, `${point}: run ${index} scored once`);
  }
  return { spent: await budget.spent('default'), calls };
}

test('proof: a worker killed holding a reservation leaves the budget where the bill is, on every store', async () => {
  for (const name of ['memory', 'tenant memory', 'redis', 'postgres']) {
    const fresh = () => storeOf(name);
    // Never at its evaluator: nothing was billed, and the reservation is given back.
    const before = await killed('before the evaluator', await fresh());
    close(before.spent, 0.2, `${name}, killed before the evaluator`);
    // Scores written: charged at what they cost, a cent. The run is not scored again, but its judge
    // runs again to find what is missing, and that call is charged too.
    const scored = await killed('after the scores', await fresh());
    assert.equal(scored.calls, 21, `${name}: the scored run was judged once more, and not rescored`);
    close(scored.spent, 0.21, `${name}, killed after the scores`);
    // At its evaluator with nothing written: the provider may have billed, so the policy decides.
    const charged = await killed('during the evaluator', await fresh(), 'charge');
    close(charged.spent, 0.2 + 0.05, `${name}, killed during the evaluator, charged`);
    const released = await killed('during the evaluator', await fresh(), 'release');
    close(released.spent, 0.2, `${name}, killed during the evaluator, released`);
  }
});
