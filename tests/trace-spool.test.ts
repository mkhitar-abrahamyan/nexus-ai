/**
 * Traces that a collector being down cannot lose, proved: the collector stops for an hour while a
 * span finishes every second, and the process restarts halfway through; when the collector comes
 * back, every span reaches it, once. On the memory, SQLite, Postgres, and Redis operation stores.
 * Then the spool's bound, its dead letters, two replicas draining one spool, and a process that
 * dies in the middle of a send with write-ahead on.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { RedisOperationStore } from '../src/operations/adapters.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import type { PostgresLikeClient } from '../src/postgres/client.js';
import { PostgresOperationStore } from '../src/postgres/operations.js';
import { SqliteOperationStore } from '../src/sqlite/operations.js';
import { OtlpTraceExporter } from '../src/tracing/otlp.js';
import { type SpoolingExporterOptions, spoolingExporter } from '../src/tracing/spool.js';
import type { OperationStore } from '../src/types/operations.js';
import type { Run } from '../src/types/tracing.js';

let pg: PGlite;
let tables = 0;
before(async () => {
  pg = new PGlite();
  await pg.waitReady;
});
after(async () => {
  await pg.close();
});

function redisStore(): OperationStore {
  const hashes = new Map<string, Map<string, string>>();
  const hash = (key: string) => {
    let entry = hashes.get(key);
    if (!entry) {
      entry = new Map();
      hashes.set(key, entry);
    }
    return entry;
  };
  return new RedisOperationStore({
    hget: (key: string, field: string) => hash(key).get(field) ?? null,
    hset: (key: string, field: string, value: string) => void hash(key).set(field, value),
    hdel: (key: string, field: string) => void hash(key).delete(field),
    hvals: (key: string) => [...hash(key).values()],
  } as never) as unknown as OperationStore;
}

async function stores(): Promise<Array<[string, OperationStore]>> {
  const sqlite = new SqliteOperationStore(new DatabaseSync(':memory:'));
  await sqlite.migrate();
  tables += 1;
  const postgres = new PostgresOperationStore(pg as unknown as PostgresLikeClient, { table: `spool_${tables}` });
  await postgres.migrate();
  return [
    ['memory', new MemoryOperationStore() as unknown as OperationStore],
    ['sqlite', sqlite as unknown as OperationStore],
    ['postgres', postgres as unknown as OperationStore],
    ['redis', redisStore()],
  ];
}

/** A collector: down until told otherwise, counting each span it takes. */
function collector() {
  const state = { up: false, received: new Map<string, number>(), hang: false };
  const sender = {
    async send(runs: Run[]) {
      if (state.hang) await new Promise(() => {});
      if (!state.up) throw new Error('connect ECONNREFUSED collector:4318');
      for (const run of runs) state.received.set(run.id, (state.received.get(run.id) ?? 0) + 1);
    },
  };
  return { state, sender };
}

const iso = (ms: number) => new Date(ms).toISOString();
const span = (n: number, at: number): Run => ({
  id: `run-${n}`,
  traceId: `trace-${Math.floor(n / 10)}`,
  name: 'answer',
  kind: 'chain',
  status: 'ok',
  startedAt: iso(at - 5),
  endedAt: iso(at),
  latencyMs: 5,
});

test('proof: a collector stopped for an hour loses no span, across a restart, on every operation store', async () => {
  for (const [name, store] of await stores()) {
    const { state, sender } = collector();
    let clock = Date.parse('2026-10-18T12:00:00.000Z');
    const options: SpoolingExporterOptions = {
      sender,
      store,
      drainEveryMs: 0,
      baseDelayMs: 1_000,
      maxDelayMs: 60_000,
      now: () => clock,
    };
    let exporter = spoolingExporter({ ...options, owner: 'replica-1' });

    // An hour without a collector: a span finishes every second, sent each minute, and refused.
    for (let second = 0; second < 3_600; second += 1) {
      clock += 1_000;
      exporter.export(span(second, clock));
      if (second % 60 === 59) {
        await exporter.flush();
        await exporter.drain();
      }
      if (second === 1_799) {
        // The process restarts: a new one takes the same store.
        await exporter.close();
        exporter = spoolingExporter({ ...options, owner: 'replica-2' });
      }
    }
    const during = await exporter.stats();
    assert.equal(during.pendingBatches, 60, `${name}: an hour of spans waits in the spool`);
    assert.ok((during.oldestPendingAgeMs ?? 0) >= 59 * 60_000, `${name}: the oldest has waited the hour`);
    assert.equal(state.received.size, 0, name);

    // The collector comes back.
    state.up = true;
    clock += 5 * 60_000;
    while ((await exporter.drain()).sent > 0) {
      // Each pass takes up to 100 batches.
    }
    assert.equal(state.received.size, 3_600, `${name}: every span arrived`);
    assert.ok(
      [...state.received.values()].every((count) => count === 1),
      `${name}: each once`,
    );
    const afterwards = await exporter.stats();
    assert.deepEqual(
      [afterwards.pendingBatches, afterwards.dropped, afterwards.deadLettered, afterwards.retried],
      [0, 0, 0, 3_600],
      `${name}: nothing waits, nothing was dropped or dead-lettered, and the second process sent it all`,
    );
    await exporter.close();
  }
});

test('the spool keeps at most its bound, dropping the oldest batches first', async () => {
  const { state, sender } = collector();
  let clock = Date.parse('2026-10-18T12:00:00.000Z');
  const exporter = spoolingExporter({
    sender,
    store: new MemoryOperationStore() as unknown as OperationStore,
    maxBatch: 10,
    maxPendingBatches: 3,
    drainEveryMs: 0,
    now: () => clock,
  });
  for (let n = 0; n < 50; n += 1) {
    clock += 1_000;
    exporter.export(span(n, clock));
    if (n % 10 === 9) await exporter.flush();
  }
  const stats = await exporter.stats();
  assert.deepEqual([stats.spooled, stats.dropped, stats.pendingBatches], [50, 20, 3]);
  // Batches were spooled at 10, 20, 30, 40, and 50 seconds; the two oldest were dropped.
  assert.equal(stats.oldestPendingAgeMs, 50_000 - 30_000, 'the oldest waiting is the third batch');
  state.up = true;
  await exporter.drain();
  assert.deepEqual(
    [...state.received.keys()].map((id) => Number(id.slice(4))).sort((a, b) => a - b)[0],
    20,
    'what was kept is the newest',
  );
  await exporter.close();
});

test('a batch too old is dead-lettered, kept in the store, and never sent', async () => {
  const { state, sender } = collector();
  const store = new MemoryOperationStore() as unknown as OperationStore;
  let clock = Date.parse('2026-10-18T12:00:00.000Z');
  const exporter = spoolingExporter({ sender, store, drainEveryMs: 0, maxAgeMs: 3_600_000, now: () => clock });
  exporter.export(span(1, clock));
  await exporter.flush();
  clock += 2 * 3_600_000;
  const drained = await exporter.drain();
  assert.equal(drained.deadLettered, 1);
  const [record] = (await store.list?.()) ?? [];
  assert.deepEqual([record?.status, record?.deadLettered], ['failed', true], 'kept, and marked');
  state.up = true;
  await exporter.drain();
  assert.equal(state.received.size, 0, 'a dead letter is not sent');
  assert.equal((await exporter.stats()).deadLettered, 1);
  await exporter.close();
});

test('two replicas draining one spool at the same moment send each batch once', async () => {
  const { state, sender } = collector();
  const store = new MemoryOperationStore() as unknown as OperationStore;
  let clock = Date.parse('2026-10-18T12:00:00.000Z');
  const options = { sender, store, maxBatch: 5, drainEveryMs: 0, now: () => clock };
  const one = spoolingExporter({ ...options, owner: 'one' });
  const other = spoolingExporter({ ...options, owner: 'other' });
  for (let n = 0; n < 40; n += 1) one.export(span(n, clock));
  await one.flush();
  state.up = true;
  clock += 2_000;
  await Promise.all([one.drain(), other.drain(), one.drain(), other.drain()]);
  assert.equal(state.received.size, 40);
  assert.ok(
    [...state.received.values()].every((count) => count === 1),
    'each batch claimed by one replica',
  );
  await Promise.all([one.close(), other.close()]);
});

test('with write-ahead, a process that dies in the middle of a send loses nothing', async () => {
  const { state, sender } = collector();
  const store = new MemoryOperationStore() as unknown as OperationStore;
  let clock = Date.parse('2026-10-18T12:00:00.000Z');
  state.up = true;
  state.hang = true;
  const dying = spoolingExporter({
    sender,
    store,
    writeAhead: true,
    leaseMs: 10_000,
    drainEveryMs: 0,
    now: () => clock,
  });
  dying.export(span(7, clock));
  void dying.flush();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await store.list?.())?.length, 1, 'the batch was written before it was sent');
  // The process dies holding it; once its lease lapses, another replica sends it.
  state.hang = false;
  clock += 11_000;
  const next = spoolingExporter({ sender, store, writeAhead: true, drainEveryMs: 0, now: () => clock, owner: 'next' });
  const drained = await next.drain();
  assert.equal(drained.sent, 1);
  assert.deepEqual([...state.received.entries()], [['run-7', 1]]);
  assert.equal((await store.list?.())?.length, 0, 'and it leaves the spool once sent');
  await next.close();
});

test('the OTLP exporter sends a batch on request, and says when the collector refused it', async () => {
  const bodies: unknown[] = [];
  let status = 503;
  const exporter = new OtlpTraceExporter({
    endpoint: 'https://collector.test:4318/',
    fetch: (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(null, { status });
    }) as typeof fetch,
  });
  await assert.rejects(exporter.send([span(1, Date.now())]), /The collector answered 503/);
  status = 200;
  await exporter.send([span(2, Date.now()), { ...span(3, Date.now()), status: 'running' }]);
  const spans = (bodies[1] as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> }).resourceSpans[0]
    ?.scopeSpans[0]?.spans;
  assert.equal(spans?.length, 1, 'a run still running is not sent');
});
