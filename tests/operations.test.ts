import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BullMQOperationDispatcher,
  RedisOperationStore,
  type RedisOperationLikeClient,
} from '../src/operations/adapters.js';
import {
  OperationCancelledError,
  OperationLeaseLostError,
  OperationSerializationError,
  OperationTransitionError,
} from '../src/operations/errors.js';
import { LocalOperationHandle, describeOperationError } from '../src/operations/handle.js';
import { OperationRunner } from '../src/operations/runner.js';
import {
  allowedTransitions,
  assertTransition,
  canTransition,
  isClaimable,
  isSettled,
} from '../src/operations/state-machine.js';
import { MemoryOperationStore, assertSerializableRecord } from '../src/operations/store.js';
import {
  OPERATION_WEBHOOK_SIGNATURE_HEADER,
  deliverOperationWebhook,
  signOperationWebhook,
  verifyOperationWebhook,
} from '../src/operations/webhooks.js';
import type { OperationEvent, OperationRecord, OperationStatus, OperationStore } from '../src/types/operations.js';

/**
 * An executor that stays busy until it is aborted.
 *
 * The runner's heartbeat timer is deliberately unref'd so a stuck operation cannot hold a process
 * open, which means a test executor has to keep the event loop alive itself, exactly as a real one
 * would through its socket or file handle.
 */
function busyUntilAborted(timeoutMs = 2_000): (context: { signal: AbortSignal }) => Promise<string> {
  return (context) =>
    new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve('timed out'), timeoutMs);
      context.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve('aborted');
        },
        { once: true },
      );
    });
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function record(overrides: Partial<OperationRecord> = {}): OperationRecord {
  const now = new Date().toISOString();
  return {
    id: 'op-1',
    status: 'queued',
    attempt: 1,
    maxAttempts: 1,
    sequence: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// ── State machine ──────────────────────────────────────────────────

test('the lifecycle allows only the documented transitions', () => {
  assert.equal(canTransition('queued', 'running'), true);
  assert.equal(canTransition('running', 'succeeded'), true);
  assert.equal(canTransition('running', 'retrying'), true);
  assert.equal(canTransition('retrying', 'queued'), true);
  assert.equal(canTransition('queued', 'succeeded'), false);
  assert.equal(canTransition('succeeded', 'running'), false);
  assert.equal(canTransition('cancelled', 'running'), false);
});

test('cancelling can still reach a terminal success', () => {
  // Cancellation asks an executor to stop; it does not prove it stopped in time.
  assert.equal(canTransition('cancelling', 'succeeded'), true);
  assert.equal(canTransition('cancelling', 'failed'), true);
  assert.equal(canTransition('cancelling', 'cancelled'), true);
});

test('no status escapes a terminal state', () => {
  for (const terminal of ['succeeded', 'failed', 'cancelled', 'expired'] as OperationStatus[]) {
    assert.deepEqual(allowedTransitions(terminal), []);
    assert.equal(isSettled(terminal), true);
  }
});

test('assertTransition throws with both ends named', () => {
  assert.throws(
    () => assertTransition('succeeded', 'running', 'op-9'),
    (error: unknown) =>
      error instanceof OperationTransitionError &&
      error.from === 'succeeded' &&
      error.to === 'running' &&
      /op-9/.test(error.message),
  );
});

test('only queued and retrying are claimable', () => {
  assert.equal(isClaimable('queued'), true);
  assert.equal(isClaimable('retrying'), true);
  assert.equal(isClaimable('running'), false);
  assert.equal(isClaimable('succeeded'), false);
});

// ── Local handle ───────────────────────────────────────────────────

test('a handle emits queued, running, and succeeded in order', async () => {
  const handle = new LocalOperationHandle<string>('op-a');
  handle.start(async () => 'done');

  const events = await collect(handle.events());
  assert.deepEqual(
    events.map((event) => event.type),
    ['queued', 'running', 'succeeded'],
  );
  assert.equal(await handle.result(), 'done');
  assert.equal(handle.status(), 'succeeded');
});

test('sequence numbers increase monotonically', async () => {
  const handle = new LocalOperationHandle<string>('op-seq');
  handle.start(async () => 'ok');
  const events = await collect(handle.events());
  const sequences = events.map((event) => event.sequence);
  assert.deepEqual(
    sequences,
    [...sequences].sort((a, b) => a - b),
  );
  assert.equal(new Set(sequences).size, sequences.length);
});

test('progress events carry a running status', async () => {
  const handle = new LocalOperationHandle<string>('op-progress');
  handle.start(async () => {
    handle.report({ ratio: 0.5, message: 'halfway' });
    return 'ok';
  });

  const events = await collect(handle.events());
  const progress = events.find((event) => event.type === 'progress');
  assert.ok(progress);
  assert.equal(progress?.status, 'running');
  assert.equal(handle.progress()?.message, 'halfway');
});

test('cancelling rejects the result and aborts the executor signal', async () => {
  const handle = new LocalOperationHandle<string>('op-cancel');
  let sawAbort = false;
  handle.start(
    (signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve('late');
        });
      }),
  );

  await Promise.resolve();
  assert.equal(handle.cancel('user asked'), true);
  assert.equal(handle.cancel('again'), false, 'a second cancel is a no-op');

  await assert.rejects(() => handle.result(), OperationCancelledError);
  assert.equal(handle.status(), 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(sawAbort, true);
});

test('a late success after cancellation is discarded', async () => {
  const handle = new LocalOperationHandle<string>('op-late');
  let release!: (value: string) => void;
  handle.start(() => new Promise<string>((resolve) => (release = resolve)));

  await Promise.resolve();
  handle.cancel();
  release('too late');
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.equal(handle.status(), 'cancelled');
  const events = await collect(handle.events());
  assert.equal(
    events.some((event) => event.type === 'succeeded'),
    false,
  );
});

test('a family can supply its own cancellation error', async () => {
  class FamilyCancelled extends Error {}
  const handle = new LocalOperationHandle<string>('op-family', {
    cancellationError: () => new FamilyCancelled('family specific'),
  });
  handle.start(() => new Promise<string>(() => undefined));
  await Promise.resolve();
  handle.cancel();
  await assert.rejects(() => handle.result(), FamilyCancelled);
});

test('describeOperationError keeps a string code', () => {
  const error = Object.assign(new Error('boom'), { code: 'E_BOOM' });
  assert.deepEqual(describeOperationError(error), { name: 'Error', message: 'boom', code: 'E_BOOM' });
  assert.deepEqual(describeOperationError('plain'), { name: 'Error', message: 'plain' });
});

// ── Memory store ───────────────────────────────────────────────────

test('the store enforces compare-and-set on sequence', () => {
  const store = new MemoryOperationStore();
  store.create(record());

  assert.equal(store.update(record({ sequence: 1, status: 'running' }), 0), true);
  // A second writer holding the stale sequence loses.
  assert.equal(store.update(record({ sequence: 1, status: 'cancelled' }), 0), false);
  assert.equal(store.read('op-1')?.status, 'running');
});

test('the store returns copies, not live references', () => {
  const store = new MemoryOperationStore();
  store.create(record({ metadata: { tenant: 'a' } }));
  const first = store.read('op-1');
  (first as OperationRecord).status = 'failed';
  assert.equal(store.read('op-1')?.status, 'queued');
});

test('idempotency keys resolve to the original record', () => {
  const store = new MemoryOperationStore();
  store.create(record({ idempotencyKey: 'key-1' }));
  assert.equal(store.findByIdempotencyKey('key-1')?.id, 'op-1');
  assert.equal(store.findByIdempotencyKey('missing'), undefined);
});

test('claimExpired returns only lapsed non-terminal records', () => {
  const store = new MemoryOperationStore();
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  store.create(record({ id: 'stale', status: 'running', lease: { owner: 'w1', expiresAt: past } }));
  store.create(record({ id: 'held', status: 'running', lease: { owner: 'w2', expiresAt: future } }));
  store.create(record({ id: 'done', status: 'succeeded', lease: { owner: 'w3', expiresAt: past } }));

  const expired = store.claimExpired(new Date().toISOString(), 10);
  assert.deepEqual(
    expired.map((item) => item.id),
    ['stale'],
  );
});

test('persisting raw bytes is refused with the asset-store remedy named', () => {
  const store = new MemoryOperationStore();
  assert.throws(
    () => store.create(record({ result: { assets: [{ data: new Uint8Array([1, 2, 3]) }] } })),
    (error: unknown) =>
      error instanceof OperationSerializationError &&
      error.path === 'result.assets[0].data' &&
      /AssetStore/.test(error.message),
  );
});

test('the binary guard accepts an asset reference', () => {
  assert.doesNotThrow(() =>
    assertSerializableRecord(record({ result: { assets: [{ kind: 'stored', uri: 's3://bucket/key' }] } })),
  );
});

// ── Runner: happy path, progress, retry ────────────────────────────

test('the runner persists a terminal record with timestamps', async () => {
  const store = new MemoryOperationStore<string>();
  const runner = new OperationRunner<string>({ store });

  const handle = await runner.submit(async () => 'value', { kind: 'test.op' });
  assert.equal(await handle.result(), 'value');

  const stored = await runner.read(handle.id);
  assert.equal(stored?.status, 'succeeded');
  assert.equal(stored?.result, 'value');
  assert.equal(stored?.kind, 'test.op');
  assert.ok(stored?.startedAt);
  assert.ok(stored?.completedAt);
  assert.equal(stored?.lease, undefined, 'a settled record releases its lease');
});

test('progress reported by the executor reaches the handle', async () => {
  const runner = new OperationRunner<string>();
  const handle = await runner.submit(async (context) => {
    context.report({ completed: 1, total: 2 });
    return 'ok';
  });

  await handle.result();
  assert.equal(handle.progress()?.total, 2);
});

test('the runner drives the handle through the full event sequence', async () => {
  // Regression: the runner calls the executor itself, so it must move the handle to running.
  // Without that the handle sat in queued, no running event fired, and report() was dropped.
  const runner = new OperationRunner<string>();
  const handle = await runner.submit(async (context) => {
    context.report({ ratio: 0.5 });
    return 'ok';
  });

  const events = await collect(handle.events());
  assert.deepEqual(
    events.map((event) => event.type),
    ['queued', 'running', 'progress', 'succeeded'],
  );
  const running = events.find((event) => event.type === 'running');
  assert.equal(running?.status, 'running');
});

test('a failed attempt is retried and the retry is visible in events', async () => {
  const runner = new OperationRunner<string>({
    retry: { maxAttempts: 3, baseDelayMs: 1 },
  });
  let attempts = 0;
  const handle = await runner.submit(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('transient');
    return 'recovered';
  });

  const events = await collect(handle.events());
  assert.equal(await handle.result(), 'recovered');
  assert.equal(attempts, 3);
  assert.equal(events.filter((event) => event.type === 'retrying').length, 2);
});

test('the executor sees an increasing attempt number', async () => {
  const runner = new OperationRunner<number>({ retry: { maxAttempts: 3, baseDelayMs: 1 } });
  const seen: number[] = [];
  const handle = await runner.submit(async (context) => {
    seen.push(context.attempt);
    if (context.attempt < 3) throw new Error('again');
    return context.attempt;
  });

  await handle.result();
  assert.deepEqual(seen, [1, 2, 3]);
});

test('exhausting every attempt dead-letters the record', async () => {
  const store = new MemoryOperationStore<string>();
  const runner = new OperationRunner<string>({ store, retry: { maxAttempts: 2, baseDelayMs: 1 } });

  const handle = await runner.submit(async () => {
    throw new Error('always fails');
  });
  await assert.rejects(() => handle.result(), /always fails/);

  const stored = await runner.read(handle.id);
  assert.equal(stored?.status, 'failed');
  assert.equal(stored?.deadLettered, true);
  assert.equal(stored?.attempt, 2);
  assert.equal(stored?.error?.message, 'always fails');
});

test('a non-retryable failure is not retried', async () => {
  const runner = new OperationRunner<string>({
    retry: { maxAttempts: 5, baseDelayMs: 1, isRetryable: () => false },
  });
  let attempts = 0;
  const handle = await runner.submit(async () => {
    attempts += 1;
    throw new Error('permanent');
  });

  await assert.rejects(() => handle.result());
  assert.equal(attempts, 1);
});

test('a cancellation is never retried', async () => {
  const runner = new OperationRunner<string>({ retry: { maxAttempts: 5, baseDelayMs: 1 } });
  let attempts = 0;
  const handle = await runner.submit(async () => {
    attempts += 1;
    throw new OperationCancelledError('op', 'stop');
  });

  await assert.rejects(() => handle.result(), OperationCancelledError);
  assert.equal(attempts, 1);
});

// ── Runner: cancellation, idempotency, recovery ────────────────────

test('cancel() through the store settles a running operation', async () => {
  const store = new MemoryOperationStore<string>();
  const runner = new OperationRunner<string>({ store });

  const handle = await runner.submit(() => new Promise<string>(() => undefined));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(await runner.cancel(handle.id, 'operator stopped it'), true);
  const stored = await runner.read(handle.id);
  assert.equal(stored?.status, 'cancelled');
  assert.equal(stored?.lease, undefined);
});

test('cancelling an unknown operation reports it clearly', async () => {
  const runner = new OperationRunner();
  await assert.rejects(() => runner.cancel('nope'), /not in the store/);
});

test('an idempotency key replays instead of running twice', async () => {
  const store = new MemoryOperationStore<string>();
  const runner = new OperationRunner<string>({ store });
  let runs = 0;

  const first = await runner.submit(
    async () => {
      runs += 1;
      return 'first';
    },
    { idempotencyKey: 'charge-1' },
  );
  assert.equal(await first.result(), 'first');

  const second = await runner.submit(
    async () => {
      runs += 1;
      return 'second';
    },
    { idempotencyKey: 'charge-1' },
  );

  assert.equal(await second.result(), 'first', 'the replay returns the original result');
  assert.equal(runs, 1, 'the executor must not run a second time');
  assert.equal(second.id, first.id);
});

test('recover() resumes an operation whose lease lapsed', async () => {
  const store = new MemoryOperationStore<string>();
  const runner = new OperationRunner<string>({ store });
  const stale = new Date(Date.now() - 120_000).toISOString();

  // A record left behind by a worker that died mid-flight.
  store.create({
    id: 'orphan',
    status: 'running',
    attempt: 1,
    maxAttempts: 3,
    sequence: 4,
    createdAt: stale,
    updatedAt: stale,
    lease: { owner: 'dead-worker', expiresAt: stale },
  });

  const resumed = await runner.recover(async () => 'recovered');
  assert.equal(resumed.length, 1);
  assert.equal(await resumed[0]?.result(), 'recovered');
  assert.equal((await runner.read('orphan'))?.status, 'succeeded');
});

test('recovery expires a record past its deadline instead of rerunning it', async () => {
  const store = new MemoryOperationStore<string>();
  const runner = new OperationRunner<string>({ store });
  const stale = new Date(Date.now() - 120_000).toISOString();
  let ran = false;

  store.create({
    id: 'too-old',
    status: 'running',
    attempt: 1,
    maxAttempts: 3,
    sequence: 1,
    createdAt: stale,
    updatedAt: stale,
    expiresAt: stale,
    lease: { owner: 'dead', expiresAt: stale },
  });

  const resumed = await runner.recover(async () => {
    ran = true;
    return 'nope';
  });

  assert.equal(resumed.length, 0);
  assert.equal(ran, false);
  assert.equal((await runner.read('too-old'))?.status, 'expired');
});

test('recovery dead-letters a record that already used every attempt', async () => {
  const store = new MemoryOperationStore<string>();
  const runner = new OperationRunner<string>({ store });
  const stale = new Date(Date.now() - 120_000).toISOString();

  store.create({
    id: 'exhausted',
    status: 'running',
    attempt: 3,
    maxAttempts: 3,
    sequence: 1,
    createdAt: stale,
    updatedAt: stale,
    lease: { owner: 'dead', expiresAt: stale },
  });

  const resumed = await runner.recover(async () => 'nope');
  assert.equal(resumed.length, 0);
  const stored = await runner.read('exhausted');
  assert.equal(stored?.status, 'failed');
  assert.equal(stored?.deadLettered, true);
});

test('a submitted operation carries a lease naming this worker', async () => {
  const store = new MemoryOperationStore<string>();
  const runner = new OperationRunner<string>({ store, owner: 'worker-under-test', leaseMs: 5_000 });

  let seen: OperationRecord<string> | undefined;
  const handle = await runner.submit(
    async () => {
      seen = await store.read('lease-check');
      return 'ok';
    },
    { id: 'lease-check' },
  );

  await handle.result();
  assert.equal(seen?.lease?.owner, 'worker-under-test');
  assert.ok(seen?.lease?.expiresAt);
});

test('an external abort signal cancels the operation', async () => {
  const controller = new AbortController();
  const runner = new OperationRunner<string>();
  const handle = await runner.submit(() => new Promise<string>(() => undefined), { signal: controller.signal });

  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort('caller went away');
  await assert.rejects(() => handle.result(), OperationCancelledError);
});

test('a store that rejects the claim reports a lost lease', async () => {
  const base = new MemoryOperationStore<string>();
  const store: OperationStore<string> = {
    create: (item) => base.create(item),
    read: (id) => base.read(id),
    // Every update loses, as though another worker always won the race.
    update: () => false,
  };
  const runner = new OperationRunner<string>({ store });
  const handle = await runner.submit(async () => 'never');

  await assert.rejects(() => handle.result(), OperationLeaseLostError);
});

// ── Webhooks ───────────────────────────────────────────────────────

test('a signature verifies against the same body and secret', () => {
  const body = JSON.stringify({ type: 'succeeded' });
  const header = signOperationWebhook(body, 'shhh', 1_700_000_000);

  assert.equal(verifyOperationWebhook(body, header, 'shhh', { nowSeconds: 1_700_000_000 }), true);
  assert.equal(verifyOperationWebhook(body, header, 'wrong', { nowSeconds: 1_700_000_000 }), false);
  assert.equal(verifyOperationWebhook('{"tampered":true}', header, 'shhh', { nowSeconds: 1_700_000_000 }), false);
});

test('a replayed delivery outside the tolerance window is rejected', () => {
  const body = '{}';
  const header = signOperationWebhook(body, 'shhh', 1_700_000_000);
  assert.equal(
    verifyOperationWebhook(body, header, 'shhh', { nowSeconds: 1_700_000_000 + 3_600, toleranceSeconds: 300 }),
    false,
  );
});

test('a malformed signature header is rejected rather than throwing', () => {
  assert.equal(verifyOperationWebhook('{}', undefined, 'shhh'), false);
  assert.equal(verifyOperationWebhook('{}', 'garbage', 'shhh'), false);
  assert.equal(verifyOperationWebhook('{}', 't=abc,v1=zz', 'shhh'), false);
});

test('only terminal events are delivered by default', async () => {
  const delivered: string[] = [];
  const config = {
    url: 'https://example.test/hook',
    secret: 'shhh',
    fetch: (async (_url: string, init: RequestInit) => {
      delivered.push(JSON.parse(String(init.body)).type);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch,
  };

  const base = { operationId: 'op', sequence: 1, timestamp: new Date().toISOString() };
  await deliverOperationWebhook(config, { ...base, type: 'running', status: 'running', attempt: 1 });
  await deliverOperationWebhook(config, { ...base, type: 'succeeded', status: 'succeeded', result: 1 });

  assert.deepEqual(delivered, ['succeeded']);
});

test('a delivery carries the signature header', async () => {
  let header: string | undefined;
  await deliverOperationWebhook(
    {
      url: 'https://example.test/hook',
      secret: 'shhh',
      fetch: (async (_url: string, init: RequestInit) => {
        header = (init.headers as Record<string, string>)[OPERATION_WEBHOOK_SIGNATURE_HEADER];
        return new Response('', { status: 200 });
      }) as unknown as typeof fetch,
    },
    {
      operationId: 'op',
      sequence: 1,
      timestamp: new Date().toISOString(),
      type: 'succeeded',
      status: 'succeeded',
      result: 1,
    },
  );

  assert.match(String(header), /^t=\d+,v1=[0-9a-f]{64}$/);
});

test('a rejected webhook does not fail the operation', async () => {
  const errors: unknown[] = [];
  const runner = new OperationRunner<string>({
    webhook: {
      url: 'https://example.test/hook',
      secret: 'shhh',
      fetch: (async () => new Response('no', { status: 500 })) as unknown as typeof fetch,
    },
    onWebhookError: (error) => errors.push(error),
  });

  const handle = await runner.submit(async () => 'ok');
  assert.equal(await handle.result(), 'ok', 'the operation still succeeds');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(errors.length > 0, 'the delivery failure is reported');
});

// ── Redis and BullMQ adapters ──────────────────────────────────────

function fakeRedis(): { client: RedisOperationLikeClient; data: Map<string, Map<string, string>> } {
  const data = new Map<string, Map<string, string>>();
  const hash = (key: string): Map<string, string> => {
    let entry = data.get(key);
    if (!entry) {
      entry = new Map();
      data.set(key, entry);
    }
    return entry;
  };
  return {
    data,
    client: {
      hget: (key: string, field: string) => hash(key).get(field) ?? null,
      hset: (key: string, field: string, value: string) => void hash(key).set(field, value),
      hdel: (key: string, field: string) => void hash(key).delete(field),
      hvals: (key: string) => [...hash(key).values()],
    },
  };
}

test('the Redis store round-trips a record and honors compare-and-set', async () => {
  const { client } = fakeRedis();
  const store = new RedisOperationStore(client);

  await store.create(record({ idempotencyKey: 'k' }));
  assert.equal((await store.read('op-1'))?.status, 'queued');
  assert.equal((await store.findByIdempotencyKey('k'))?.id, 'op-1');

  assert.equal(await store.update(record({ sequence: 1, status: 'running' }), 0), true);
  assert.equal(await store.update(record({ sequence: 2, status: 'failed' }), 0), false);
  assert.equal((await store.read('op-1'))?.status, 'running');
});

test('the Redis store refuses to persist binary data', async () => {
  const { client } = fakeRedis();
  const store = new RedisOperationStore(client);
  await assert.rejects(
    () => Promise.resolve(store.create(record({ result: { bytes: new Uint8Array([1]) } }))),
    OperationSerializationError,
  );
});

test('a runner backed by Redis completes and persists', async () => {
  const { client } = fakeRedis();
  const runner = new OperationRunner<string>({ store: new RedisOperationStore<string>(client) });

  const handle = await runner.submit(async () => 'durable');
  assert.equal(await handle.result(), 'durable');
  assert.equal((await runner.read(handle.id))?.status, 'succeeded');
});

test('the BullMQ dispatcher queues only a reference, never the payload', async () => {
  const jobs: Array<{ name: string; data: Record<string, unknown>; options?: Record<string, unknown> }> = [];
  const dispatcher = new BullMQOperationDispatcher({
    add: (name, data, options) => {
      jobs.push({ name, data: data as Record<string, unknown>, options });
      return { id: 'job-1' };
    },
  });

  await dispatcher.dispatch(record({ id: 'op-7', kind: 'image.generate', result: { huge: 'payload' } }));

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.data.operationId, 'op-7');
  assert.equal(jobs[0]?.data.kind, 'image.generate');
  assert.equal('result' in (jobs[0]?.data ?? {}), false, 'the result must not be queued');
  assert.equal(jobs[0]?.options?.jobId, 'op-7');
});

test('the runner dispatches an accepted operation', async () => {
  const dispatched: string[] = [];
  const runner = new OperationRunner<string>({
    dispatcher: { dispatch: (item) => void dispatched.push(item.id) },
  });

  const handle = await runner.submit(async () => 'ok');
  await handle.result();
  assert.deepEqual(dispatched, [handle.id]);
});

// ── Handle contract shared with images ─────────────────────────────

test('the image manager still settles through the shared handle', async () => {
  const { ImageManager } = await import('../src/images/manager.js');
  const { MockImageProvider } = await import('../src/images/mock.js');
  const manager = new ImageManager({ providers: { mock: new MockImageProvider() }, defaultProvider: 'mock' });

  const handle = manager.submit({ operation: 'generate', request: { prompt: 'a square' } });
  const events = (await collect(handle.events())) as Array<OperationEvent<unknown>>;

  assert.deepEqual(
    events.map((event) => event.type),
    ['queued', 'running', 'succeeded'],
  );
  assert.equal(handle.status(), 'succeeded');
});

// ── Leases and heartbeats ──────────────────────────────────────────

test('the heartbeat extends the lease while the executor runs', async () => {
  const store = new MemoryOperationStore<string>();
  const runner = new OperationRunner<string>({ store, leaseMs: 90, heartbeatMs: 20 });

  let firstLease: string | undefined;
  const handle = await runner.submit(
    async () => {
      firstLease = (await store.read('beat'))?.lease?.expiresAt;
      await new Promise((resolve) => setTimeout(resolve, 90));
      return 'ok';
    },
    { id: 'beat' },
  );

  await handle.result();
  assert.ok(firstLease, 'a lease is taken before the executor runs');
  const stored = await runner.read('beat');
  assert.equal(stored?.status, 'succeeded');
  // The record advanced well past its first lease deadline without being reclaimed.
  assert.ok((stored?.sequence ?? 0) > 2, 'the heartbeat wrote lease renewals');
});

test('context.heartbeat() renews the lease on demand', async () => {
  const store = new MemoryOperationStore<string>();
  const runner = new OperationRunner<string>({ store, leaseMs: 5_000, heartbeatMs: 5_000 });

  let before: string | undefined;
  let after: string | undefined;
  const handle = await runner.submit(
    async (context) => {
      before = (await store.read('manual'))?.lease?.expiresAt;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await context.heartbeat();
      after = (await store.read('manual'))?.lease?.expiresAt;
      return 'ok';
    },
    { id: 'manual' },
  );

  await handle.result();
  assert.ok(before && after);
  assert.ok(after > before, 'an explicit heartbeat pushes the lease deadline out');
});

test('a cancellation written by another worker is observed through the heartbeat', async () => {
  const store = new MemoryOperationStore<string>();
  const worker = new OperationRunner<string>({ store, owner: 'worker-a', leaseMs: 60, heartbeatMs: 15 });
  const operator = new OperationRunner<string>({ store, owner: 'operator' });

  const handle = await worker.submit(busyUntilAborted(), { id: 'shared' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await operator.cancel('shared', 'stopped elsewhere');

  await assert.rejects(() => handle.result(), OperationCancelledError);
  assert.equal(handle.status(), 'cancelled');
});

test('a lease stolen by another worker settles the original handle', async () => {
  const store = new MemoryOperationStore<string>();
  const runner = new OperationRunner<string>({ store, owner: 'worker-a', leaseMs: 60, heartbeatMs: 15 });

  const handle = await runner.submit(busyUntilAborted(), { id: 'stolen' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // A second worker takes the lease directly, as a recovery sweep elsewhere would.
  const current = store.read('stolen');
  assert.ok(current);
  store.update(
    {
      ...current,
      sequence: current.sequence + 1,
      lease: { owner: 'worker-b', expiresAt: new Date(Date.now() + 60_000).toISOString() },
    },
    current.sequence,
  );

  await assert.rejects(() => handle.result(), OperationLeaseLostError);
});

test('an in-flight operation replayed by idempotency key follows the original', async () => {
  const store = new MemoryOperationStore<string>();
  const runner = new OperationRunner<string>({ store, heartbeatMs: 10 });
  let release!: (value: string) => void;

  const first = await runner.submit(() => new Promise<string>((resolve) => (release = resolve)), {
    idempotencyKey: 'in-flight',
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  let secondRan = false;
  const second = await runner.submit(
    async () => {
      secondRan = true;
      return 'should not run';
    },
    { idempotencyKey: 'in-flight' },
  );

  release('original');
  assert.equal(await first.result(), 'original');
  assert.equal(await second.result(), 'original', 'the replay resolves from the stored record');
  assert.equal(secondRan, false);
});

test('a durable handle exposes the persisted record', async () => {
  const runner = new OperationRunner<string>({ store: new MemoryOperationStore<string>() });
  const handle = await runner.submit(async () => 'value', { metadata: { tenant: 'acme' } });
  await handle.result();

  const record = await handle.record();
  assert.equal(record?.status, 'succeeded');
  assert.equal(record?.metadata?.tenant, 'acme');
});

test('the runner reports the worker id it writes into leases', () => {
  const runner = new OperationRunner({ owner: 'named-worker' });
  assert.equal(runner.workerId, 'named-worker');
  assert.match(new OperationRunner().workerId, /^worker-[0-9a-f]{12}$/);
});
