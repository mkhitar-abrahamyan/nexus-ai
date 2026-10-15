/**
 * A2A tasks that outlive their replica, proved: a task working when its replica dies is taken over by
 * another once the lease lapses, and carried on from the graph's last checkpoint, so the model call
 * the dead replica finished is not made again and the email it never sent is sent once; two replicas
 * recovering at the same moment take it over once; a paused task answered on a replica that dies is
 * answered again by the one that takes it over; and a graph that cannot carry a run on fails the task
 * instead of leaving it working. On the memory, SQLite, Postgres, and Redis stores.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createAgent } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import type { PostgresLikeClient } from '../src/postgres/client.js';
import { PostgresStore } from '../src/postgres/store.js';
import {
  type A2aServerOptions,
  type A2aTask,
  type A2aTaskStore,
  a2aClient,
  a2aHandler,
  MemoryA2aTaskStore,
  storeA2aTasks,
} from '../src/protocols/a2a.js';
import { SqliteStore } from '../src/sqlite/store.js';
import { MemoryStore } from '../src/store/memory.js';
import { RedisStore } from '../src/store/redis.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import { FakeRedis } from './redis-fake.js';

let pg: PGlite;
let redis: FakeRedis;
let tables = 0;
before(async () => {
  pg = new PGlite();
  await pg.waitReady;
  redis = await FakeRedis.create();
});
after(async () => {
  await pg.close();
  redis.close();
});

const CARD: A2aServerOptions['card'] = {
  name: 'Mailer',
  description: 'Sends mail',
  version: '1.0.0',
  url: 'http://agent.test/a2a',
  skills: [],
};

/** What the agents did, across every replica. */
interface Counters {
  modelCalls: number;
  sent: string[];
}

/** A model that sends one email, then reports what the tool said. */
function mailer(counters: Counters) {
  return {
    async complete(request: CompletionRequest) {
      counters.modelCalls += 1;
      const last = request.messages.at(-1);
      if (last?.role !== 'tool') {
        return {
          content: '',
          role: 'assistant',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'send_email', arguments: '{"to":"ana"}' } }],
          meta: {},
        } as unknown as NexusResponse;
      }
      return {
        content: `Sent: ${String(last.content)}`,
        role: 'assistant',
        finishReason: 'stop',
        meta: {},
      } as NexusResponse;
    },
  };
}

/** A process's view of a shared store, which stops answering the moment it dies. */
function mortal<T extends object>(target: T, life: { dead: boolean }): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (life.dead) throw new Error('the replica died');
        return (value as (...inner: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

/** A replica: its own agent and handler, sharing the task store and the graph's checkpoints. */
function replica(
  store: A2aTaskStore,
  checkpointer: MemoryGraphCheckpointer,
  counters: Counters,
  options: { approve?: boolean; wait?: () => Promise<void>; life?: { dead: boolean } } = {},
) {
  const life = options.life ?? { dead: false };
  const sendEmail = tool({
    name: 'send_email',
    description: 'Sends an email',
    parameters: { type: 'object' },
    async *stream(args) {
      yield 'drafting';
      await options.wait?.();
      if (life.dead) throw new Error('the replica died');
      counters.sent.push(String(args.to));
      return 'delivered';
    },
  });
  const agent = createAgent({
    client: mailer(counters),
    model: 'mock',
    tools: [sendEmail],
    ...(options.approve ? { interruptOn: { send_email: true } } : {}),
    checkpointer: mortal(checkpointer, life),
  });
  const handler = a2aHandler(agent, { card: CARD, store: mortal(store, life), lease: { ms: 120 } });
  const client = a2aClient({ url: CARD.url, fetch: async (input, init) => handler(new Request(input, init)) });
  return { handler, client, life };
}

async function stores(): Promise<Array<[string, () => A2aTaskStore]>> {
  tables += 1;
  const postgres = new PostgresStore(pg as unknown as PostgresLikeClient, { table: `a2a_takeover_${tables}` });
  await postgres.migrate();
  const sqlite = new SqliteStore(new DatabaseSync(':memory:'));
  await sqlite.migrate();
  const memory = new MemoryStore();
  const redisStore = new RedisStore(redis as never, { prefix: `a2a-takeover-${tables}` });
  const own = new MemoryA2aTaskStore();
  return [
    ['memory task store', () => own],
    ['memory', () => storeA2aTasks(memory)],
    ['sqlite', () => storeA2aTasks(sqlite)],
    ['postgres', () => storeA2aTasks(postgres)],
    ['redis', () => storeA2aTasks(redisStore)],
  ];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function settled(client: ReturnType<typeof a2aClient>, id: string): Promise<A2aTask> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = await client.getTask(id);
    if (!['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED'].includes(task.status.state)) return task;
    await sleep(10);
  }
  throw new Error(`task ${id} never settled`);
}

test('proof: a task working when its replica dies is taken over and carried on from its last checkpoint, on every store', async () => {
  for (const [name, open] of await stores()) {
    const checkpointer = new MemoryGraphCheckpointer();
    const counters: Counters = { modelCalls: 0, sent: [] };
    let reached = () => {};
    const atTheTool = new Promise<void>((resolve) => {
      reached = resolve;
    });
    // The first replica reaches the tool and hangs there, as a process does the moment it dies.
    const first = replica(open(), checkpointer, counters, {
      wait: () => {
        reached();
        return new Promise(() => {});
      },
    });
    const started = await first.client.send('Email Ana the report', { returnImmediately: true });
    await atTheTool;
    first.life.dead = true;
    assert.equal(counters.modelCalls, 1, `${name}: the model chose the tool before the replica died`);

    // Two replicas recover at the same moment, once the lease has lapsed: one takes the task over.
    const second = replica(open(), checkpointer, counters);
    const third = replica(open(), checkpointer, counters);
    await sleep(200);
    const reports = await Promise.all([second.handler.recover(), third.handler.recover()]);
    assert.deepEqual(
      reports.flatMap((report) => report.tookOver),
      [started.id],
      `${name}: taken over once`,
    );

    const done = await settled(second.client, started.id);
    assert.equal(done.status.state, 'TASK_STATE_COMPLETED', name);
    assert.equal(done.artifacts?.[0]?.parts[0]?.text, 'Sent: "delivered"', name);
    assert.deepEqual(counters.sent, ['ana'], `${name}: the email the dead replica never sent is sent once`);
    assert.equal(counters.modelCalls, 2, `${name}: the model call the dead replica finished is not made again`);
    assert.deepEqual(await second.handler.recover(), { tookOver: [], skipped: 0 }, `${name}: nothing left to take`);
    second.handler.close();
    third.handler.close();
  }
});

test('a paused task answered on a replica that dies is answered again by the one that takes it over', async () => {
  const store = new MemoryA2aTaskStore();
  const checkpointer = new MemoryGraphCheckpointer();
  const counters: Counters = { modelCalls: 0, sent: [] };
  const first = replica(store, checkpointer, counters, { approve: true });
  const paused = await first.client.send('Email Ana the report');
  assert.equal(paused.status.state, 'TASK_STATE_INPUT_REQUIRED');

  // The answer reaches a replica that dies before the graph records it.
  let reached = () => {};
  const atTheTool = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const dying = replica(store, checkpointer, counters, {
    approve: true,
    wait: () => {
      reached();
      return new Promise(() => {});
    },
  });
  void dying.client.send('yes', { taskId: paused.id, returnImmediately: true });
  await atTheTool;
  dying.life.dead = true;

  const taker = replica(store, checkpointer, counters, { approve: true });
  await sleep(200);
  assert.deepEqual((await taker.handler.recover()).tookOver, [paused.id]);
  const done = await settled(taker.client, paused.id);
  assert.equal(done.status.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(counters.sent, ['ana'], 'the approved email is sent once');
});

test('a graph that cannot carry a run on fails the task instead of leaving it working', async () => {
  const store = new MemoryA2aTaskStore();
  const life = { dead: false };
  let reached = () => {};
  const running = new Promise<void>((resolve) => {
    reached = resolve;
  });
  // A graph of the application's own: it runs, but keeps no checkpoints to continue from.
  const graph = {
    async invoke() {
      reached();
      return new Promise<never>(() => {});
    },
    async resumeInterruptsWith(): Promise<never> {
      throw new Error('unused');
    },
    async state() {
      return { status: 'running' };
    },
  };
  const first = a2aHandler(graph, { card: CARD, store: mortal(store, life), lease: { ms: 100 } });
  const client = a2aClient({ url: CARD.url, fetch: async (input, init) => first(new Request(input, init)) });
  const started = await client.send('hello', { returnImmediately: true });
  await running;
  life.dead = true;

  const second = a2aHandler(graph, { card: CARD, store, lease: { ms: 100 } });
  const reader = a2aClient({ url: CARD.url, fetch: async (input, init) => second(new Request(input, init)) });
  await sleep(150);
  assert.deepEqual((await second.recover()).tookOver, [started.id]);
  const failed = await settled(reader, started.id);
  assert.equal(failed.status.state, 'TASK_STATE_FAILED');
  assert.match(String(failed.status.message?.parts[0]?.text), /cannot carry its run on/);
});

test('a lease is renewed while a task works, so a slow task is never taken over', async () => {
  const store = new MemoryA2aTaskStore();
  const checkpointer = new MemoryGraphCheckpointer();
  const counters: Counters = { modelCalls: 0, sent: [] };
  let release = () => {};
  const slow = replica(store, checkpointer, counters, {
    wait: () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  });
  const started = await slow.client.send('Email Ana the report', { returnImmediately: true });
  const other = replica(store, checkpointer, counters);
  await sleep(400);
  assert.deepEqual((await other.handler.recover()).tookOver, [], 'a renewed lease has not lapsed');
  release();
  const done = await settled(slow.client, started.id);
  assert.equal(done.status.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(counters.sent, ['ana']);
  const record = await store.get(started.id);
  assert.equal(record?.lease, undefined, 'a finished task holds no lease');
  assert.equal(record?.run, undefined);
});
