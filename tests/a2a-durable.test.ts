/**
 * A2A, durable and complete: tasks live in a store, so a task paused halfway through survives a
 * restart and is finished by another replica, on the memory, SQLite, Postgres, and Redis stores. Tasks
 * are listed and followed, a cancel on one replica stands against the replica running the task, and
 * each update is pushed to a signed webhook that cannot point into the agent's own network.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createAgent } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import { verifyOperationWebhook } from '../src/operations/webhooks.js';
import type { PostgresLikeClient } from '../src/postgres/client.js';
import { PostgresStore } from '../src/postgres/store.js';
import {
  type A2aServerOptions,
  type A2aStreamEvent,
  A2A_ERRORS,
  a2aClient,
  a2aHandler,
  type A2aTaskStore,
  MemoryA2aTaskStore,
  storeA2aTasks,
} from '../src/protocols/a2a.js';
import { SqliteStore } from '../src/sqlite/store.js';
import { MemoryStore } from '../src/store/memory.js';
import { RedisStore } from '../src/store/redis.js';
import type { CompletionRequest, ToolDefinition } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import { FakeRedis } from './redis-fake.js';

let pg: PGlite;
let redis: FakeRedis;
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
  skills: [{ id: 'mail', name: 'Mail', description: 'Sends mail', tags: ['mail'] }],
};

/** A model that sends one email, then reports what the tool said. */
function mailer() {
  let calls = 0;
  return {
    async complete(request: CompletionRequest) {
      calls += 1;
      const last = request.messages.at(-1);
      if (last?.role !== 'tool') {
        return {
          content: '',
          role: 'assistant',
          finishReason: 'tool_calls',
          toolCalls: [
            { id: `call-${calls}`, type: 'function', function: { name: 'send_email', arguments: '{"to":"ana"}' } },
          ],
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

const sendEmail = (sent: string[], wait: () => Promise<void> = async () => undefined): ToolDefinition =>
  tool({
    name: 'send_email',
    description: 'Sends an email',
    parameters: { type: 'object' },
    async *stream(args) {
      yield 'drafting';
      await wait();
      sent.push(String(args.to));
      return 'delivered';
    },
  });

/** A replica: its own agent and handler, sharing the task store and the graph's checkpoints. */
function replica(
  store: A2aTaskStore,
  checkpointer: MemoryGraphCheckpointer,
  sent: string[],
  extra: Partial<A2aServerOptions> = {},
  wait?: () => Promise<void>,
) {
  const agent = createAgent({
    client: mailer(),
    model: 'mock',
    tools: [sendEmail(sent, wait)],
    interruptOn: { send_email: true },
    checkpointer,
  });
  const handler = a2aHandler(agent, { card: CARD, store, ...extra });
  const client = a2aClient({ url: CARD.url, fetch: async (input, init) => handler(new Request(input, init)) });
  return { handler, client };
}

async function stores(): Promise<Array<[string, () => A2aTaskStore]>> {
  const postgres = new PostgresStore(pg as unknown as PostgresLikeClient, { table: 'a2a_tasks' });
  await postgres.migrate();
  const sqlite = new SqliteStore(new DatabaseSync(':memory:'));
  await sqlite.migrate();
  const memory = new MemoryStore();
  const redisStore = new RedisStore(redis as never, { prefix: 'a2a-test' });
  return [
    ['memory', () => storeA2aTasks(memory)],
    ['sqlite', () => storeA2aTasks(sqlite)],
    ['postgres', () => storeA2aTasks(postgres)],
    ['redis', () => storeA2aTasks(redisStore)],
  ];
}

test('a task paused halfway survives a restart, and another replica finishes it, on every store', async () => {
  for (const [name, open] of await stores()) {
    const checkpointer = new MemoryGraphCheckpointer();
    const sent: string[] = [];
    const first = replica(open(), checkpointer, sent);
    const paused = await first.client.send('Email Ana the report');
    assert.equal(paused.status.state, 'TASK_STATE_INPUT_REQUIRED', name);
    assert.deepEqual(sent, [], `${name}: nothing sent before the approval`);

    // The first replica is gone; a new one, on the same store, finds the task and finishes it.
    const second = replica(open(), checkpointer, sent);
    const found = await second.client.getTask(paused.id, 10);
    assert.equal(found.status.state, 'TASK_STATE_INPUT_REQUIRED', `${name}: the task is still waiting`);
    assert.equal(found.history?.length, 1, `${name}: its history is kept`);
    const done = await second.client.send('yes', { taskId: paused.id });
    assert.equal(done.status.state, 'TASK_STATE_COMPLETED', name);
    assert.equal(done.artifacts?.[0]?.parts[0]?.text, 'Sent: "delivered"', name);
    assert.deepEqual(sent, ['ana'], `${name}: sent once, by the replica that resumed it`);
    assert.equal(
      (await first.client.getTask(paused.id)).status.state,
      'TASK_STATE_COMPLETED',
      `${name}: one task, everywhere`,
    );

    // The conversation carries over to the next task of its context, on any replica.
    const contextId = paused.contextId;
    const listed = await first.client.listTasks({ contextId });
    assert.deepEqual(
      listed.tasks.map((task) => task.id),
      [paused.id],
      name,
    );
  }
});

test('tasks are listed by context and state, a page at a time', async () => {
  const store = new MemoryA2aTaskStore();
  const { client } = replica(store, new MemoryGraphCheckpointer(), [], { answer: () => true });
  const ids: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const task = await client.send(`job ${index}`, { contextId: index < 3 ? 'ctx-a' : 'ctx-b' });
    ids.push(task.id);
  }
  const all = await client.listTasks({ pageSize: 2 });
  assert.equal(all.tasks.length, 2);
  assert.equal(all.totalSize, 5, 'the memory store counts them');
  const second = await client.listTasks({ pageSize: 2, pageToken: all.nextPageToken });
  const third = await client.listTasks({ pageSize: 2, pageToken: second.nextPageToken });
  assert.equal(third.tasks.length, 1);
  assert.equal(third.nextPageToken, '', 'the last page');
  assert.deepEqual(
    new Set([...all.tasks, ...second.tasks, ...third.tasks].map((task) => task.id)),
    new Set(ids),
    'every task, once',
  );
  assert.equal((await client.listTasks({ contextId: 'ctx-a' })).tasks.length, 3);
  assert.equal((await client.listTasks({ status: 'TASK_STATE_INPUT_REQUIRED' })).tasks.length, 5);
  assert.equal((await client.listTasks({ status: 'TASK_STATE_COMPLETED' })).tasks.length, 0);
  // A store-backed list filters in the store, and does not count.
  const shared = replica(storeA2aTasks(new MemoryStore()), new MemoryGraphCheckpointer(), [], { answer: () => true });
  await shared.client.send('one', { contextId: 'ctx-c' });
  const page = await shared.client.listTasks({ contextId: 'ctx-c', historyLength: 1 });
  assert.equal(page.tasks.length, 1);
  assert.equal(page.totalSize, undefined);
  assert.equal(page.tasks[0]?.history?.length, 1);
});

test('a running task is followed here and from another replica, and a cancel stands where it runs', async () => {
  const store = new MemoryA2aTaskStore();
  const checkpointer = new MemoryGraphCheckpointer();
  const sent: string[] = [];
  let release: () => void = () => undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const approve = { answer: () => true } as Partial<A2aServerOptions>;
  const a = replica(store, checkpointer, sent, { ...approve, pollMs: 10 }, () => waiting);
  const b = replica(store, checkpointer, sent, { ...approve, pollMs: 10 });

  // Started on A, without waiting: the tool is held until released.
  const started = await a.client.send('Email Ana');
  assert.equal(started.status.state, 'TASK_STATE_INPUT_REQUIRED');
  const answered = await a.client.send('yes', { taskId: started.id, returnImmediately: true });
  assert.equal(answered.id, started.id);
  const here: A2aStreamEvent[] = [];
  const there: A2aStreamEvent[] = [];
  const followHere = (async () => {
    for await (const event of a.client.subscribe(started.id)) here.push(event);
  })();
  const followThere = (async () => {
    for await (const event of b.client.subscribe(started.id)) there.push(event);
  })();
  await new Promise((resolve) => setTimeout(resolve, 30));
  release();
  await Promise.all([followHere, followThere]);
  const states = (events: A2aStreamEvent[]) =>
    events.flatMap((event) => ('statusUpdate' in event ? [event.statusUpdate.status.state] : []));
  assert.equal(states(here).at(-1), 'TASK_STATE_COMPLETED', 'followed where it runs');
  assert.equal(states(there).at(-1), 'TASK_STATE_COMPLETED', 'followed from another replica');
  assert.ok('task' in (here[0] as object) && 'task' in (there[0] as object), 'each starts with the task');
  await assert.rejects(a.client.subscribe(started.id).next(), (error: { code?: number }) => {
    return error.code === A2A_ERRORS.unsupportedOperation;
  });

  // Cancelled on B while A runs it: A finishes the work but does not record it over the cancel.
  let hold: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    hold = resolve;
  });
  const c = replica(store, checkpointer, sent, approve, () => held);
  const running = await c.client.send('Email Rui');
  await c.client.send('yes', { taskId: running.id, returnImmediately: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const cancelled = await b.client.cancel(running.id);
  assert.equal(cancelled.status.state, 'TASK_STATE_CANCELED');
  hold();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await c.client.getTask(running.id)).status.state, 'TASK_STATE_CANCELED', 'the cancel stands');
});

test('each update is pushed to a signed webhook, which may not point into the agent’s own network', async () => {
  const delivered: Array<{ url: string; headers: Headers; body: string }> = [];
  const push = {
    secret: 'whsec-test',
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      delivered.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response(null, { status: 204 });
    },
  };
  const { client } = replica(new MemoryA2aTaskStore(), new MemoryGraphCheckpointer(), [], {
    answer: () => true,
    pushNotifications: push,
  });
  const card = await client.card();
  assert.equal(card.capabilities.pushNotifications, true);
  const task = await client.send('Email Ana', {
    push: { url: 'https://hooks.example.com/a2a', token: 'caller-token' },
  });
  await client.send('yes', { taskId: task.id });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const states = delivered.map(
    (item) => (JSON.parse(item.body) as { statusUpdate: { status: { state: string } } }).statusUpdate.status.state,
  );
  assert.deepEqual(states, [
    'TASK_STATE_WORKING',
    'TASK_STATE_INPUT_REQUIRED',
    'TASK_STATE_WORKING',
    'TASK_STATE_COMPLETED',
  ]);
  for (const item of delivered) {
    assert.equal(item.url, 'https://hooks.example.com/a2a');
    assert.equal(item.headers.get('x-a2a-notification-token'), 'caller-token');
    assert.equal(
      verifyOperationWebhook(item.body, item.headers.get('x-nexus-signature') ?? undefined, 'whsec-test'),
      true,
      'signed as the server’s webhooks are',
    );
  }

  // Webhooks are managed per task.
  const configs = await client.listPushNotifications(task.id);
  assert.equal(configs.length, 1);
  const added = await client.setPushNotification(task.id, { url: 'https://audit.example.com/hook' });
  assert.ok(added.id);
  assert.equal((await client.listPushNotifications(task.id)).length, 2);
  await client.deletePushNotification(task.id, added.id as string);
  assert.equal((await client.listPushNotifications(task.id)).length, 1);

  // A caller cannot make the agent reach into its own network.
  for (const url of [
    'http://hooks.example.com/a2a',
    'https://127.0.0.1/hook',
    'https://10.1.2.3/hook',
    'https://192.168.0.7/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/hook',
    'https://localhost:8080/hook',
    'https://metadata.internal/hook',
    'file:///etc/passwd',
  ]) {
    await assert.rejects(
      client.setPushNotification(task.id, { url }),
      (error: { code?: number }) => {
        return error.code === -32602;
      },
      url,
    );
  }
  const open = replica(new MemoryA2aTaskStore(), new MemoryGraphCheckpointer(), [], {
    answer: () => true,
    pushNotifications: { ...push, allowPrivateNetworks: true },
  });
  const local = await open.client.send('Email Ana');
  assert.ok(await open.client.setPushNotification(local.id, { url: 'http://127.0.0.1:9000/hook' }));

  // Without push notifications, none are offered or accepted.
  const plain = replica(new MemoryA2aTaskStore(), new MemoryGraphCheckpointer(), [], { answer: () => true });
  assert.equal((await plain.client.card()).capabilities.pushNotifications, false);
  await assert.rejects(
    plain.client.send('Email Ana', { push: { url: 'https://hooks.example.com/a2a' } }),
    (error: { code?: number }) => error.code === A2A_ERRORS.pushNotificationNotSupported,
  );
});

test('the extended card is served to an authenticated caller only', async () => {
  const agent = createAgent({ client: mailer(), model: 'mock' });
  const handler = a2aHandler(agent, {
    card: CARD,
    principal: (request) =>
      request.headers.get('authorization') === 'Bearer partner' ? { userId: 'partner-agent' } : undefined,
    extendedCard: (principal) => ({
      skills: [
        ...CARD.skills,
        { id: 'bulk', name: 'Bulk mail', description: `For ${principal.userId}`, tags: ['mail'] },
      ],
    }),
  });
  const viaFetch = (headers: Record<string, string>) =>
    a2aClient({ url: CARD.url, headers, fetch: async (input, init) => handler(new Request(input, init)) });
  const anonymous = viaFetch({});
  assert.equal((await anonymous.card()).capabilities.extendedAgentCard, true);
  await assert.rejects(anonymous.extendedCard(), (error: { code?: number }) => {
    return error.code === A2A_ERRORS.extendedCardNotConfigured;
  });
  const extended = await viaFetch({ authorization: 'Bearer partner' }).extendedCard();
  assert.deepEqual(
    extended.skills.map((skill) => skill.id),
    ['mail', 'bulk'],
  );
  assert.equal(extended.skills[1]?.description, 'For partner-agent');
  const without = a2aHandler(agent, { card: CARD });
  const response = await without(
    new Request(CARD.url, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetExtendedAgentCard', params: {} }),
    }),
  );
  assert.equal(
    ((await response.json()) as { error: { code: number } }).error.code,
    A2A_ERRORS.extendedCardNotConfigured,
  );
});
