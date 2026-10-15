/**
 * ACP turns that outlive the agent, proved: the agent stops in the middle of a turn, the editor
 * starts it again and reopens the session, and the turn goes on from the graph's last checkpoint. The
 * model call the stopped agent finished is not made again, the email it never sent is sent once, and
 * the answer reaches the editor. A turn stopped while the editor was deciding an approval asks again.
 * A graph that cannot carry a turn on says so. On the memory and SQLite session stores.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createAgent } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import { type AcpSessionStore, MemoryAcpSessionStore, storeAcpSessions } from '../src/protocols/acp.js';
import { SqliteStore } from '../src/sqlite/store.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import { acpEditor, type Wire } from './acp-editor.js';

interface Counters {
  modelCalls: number;
  sent: string[];
}

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

/** A process's view of a shared store, which stops answering the moment the process stops. */
function mortal<T extends object>(target: T, life: { dead: boolean }): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (life.dead) throw new Error('the agent stopped');
        return (value as (...inner: unknown[]) => unknown).apply(object, args);
      };
    },
  });
}

function agent(
  checkpointer: MemoryGraphCheckpointer,
  counters: Counters,
  life: { dead: boolean },
  options: { approve?: boolean; wait?: () => Promise<void> } = {},
) {
  const sendEmail = tool({
    name: 'send_email',
    description: 'Sends an email',
    parameters: { type: 'object' },
    async *stream(args) {
      yield 'drafting';
      await options.wait?.();
      if (life.dead) throw new Error('the agent stopped');
      counters.sent.push(String(args.to));
      return 'delivered';
    },
  });
  return createAgent({
    client: mailer(counters),
    model: 'mock',
    tools: [sendEmail],
    ...(options.approve ? { interruptOn: { send_email: true } } : {}),
    checkpointer: mortal(checkpointer, life),
  });
}

async function sessionStores(): Promise<Array<[string, AcpSessionStore]>> {
  const sqlite = new SqliteStore(new DatabaseSync(':memory:'));
  await sqlite.migrate();
  return [
    ['memory', new MemoryAcpSessionStore()],
    ['sqlite', storeAcpSessions(sqlite)],
  ];
}

const allow = () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } });

async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`never: ${what}`);
}

/** Waits until the session is saved with its turn over. */
async function turnOver(sessions: AcpSessionStore, sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if ((await sessions.get(sessionId))?.turn === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the turn was never saved as over');
}

const texts = (updates: Wire[]) =>
  updates.filter((update) => update.sessionUpdate === 'agent_message_chunk').map((update) => update.content?.text);

test('proof: a turn the agent stopped in the middle of goes on when the editor reopens the session', async () => {
  for (const [name, sessions] of await sessionStores()) {
    const checkpointer = new MemoryGraphCheckpointer();
    const counters: Counters = { modelCalls: 0, sent: [] };
    const life = { dead: false };
    let reached = () => {};
    const atTheTool = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const first = acpEditor(
      agent(checkpointer, counters, life, {
        wait: () => {
          reached();
          return new Promise(() => {});
        },
      }),
      allow,
      { sessions: mortal(sessions, life) },
    );
    await first.request('initialize', { protocolVersion: 1 });
    const sessionId = (await first.request('session/new', { cwd: '/repo', mcpServers: [] })).result.sessionId as string;
    void first.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Email Ana the report' }] });
    await atTheTool;
    life.dead = true;
    first.close();
    assert.equal(counters.modelCalls, 1, `${name}: the model chose the tool before the agent stopped`);
    assert.equal((await sessions.get(sessionId))?.turn?.kind, 'invoke', `${name}: the turn in progress is kept`);

    // The editor starts the agent again and reopens the session: the turn goes on.
    const second = acpEditor(agent(checkpointer, counters, { dead: false }), allow, { sessions });
    await second.request('initialize', { protocolVersion: 1 });
    const loaded = await second.request('session/load', { sessionId, cwd: '/repo', mcpServers: [] });
    assert.equal(loaded.result, null, name);
    await until(() => texts(second.updates).includes('Sent: "delivered"'), `${name}: the answer`);
    assert.deepEqual(counters.sent, ['ana'], `${name}: the email the stopped agent never sent is sent once`);
    assert.equal(counters.modelCalls, 2, `${name}: the model call the stopped agent finished is not made again`);
    await turnOver(sessions, sessionId);
    const record = await sessions.get(sessionId);
    assert.equal(record?.turn, undefined, `${name}: the turn is over`);
    assert.deepEqual(
      record?.history.filter((message) => message.role === 'user').map((message) => message.content),
      ['Email Ana the report'],
      `${name}: the prompt joined the conversation once`,
    );

    // The next prompt waits for nothing, and carries the conversation on.
    const next = await second.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Thanks' }] });
    assert.equal(next.result.stopReason, 'end_turn', name);
    second.close();
  }
});

test('a turn stopped while the editor decided an approval asks for it again', async () => {
  const sessions = new MemoryAcpSessionStore();
  const checkpointer = new MemoryGraphCheckpointer();
  const counters: Counters = { modelCalls: 0, sent: [] };
  const life = { dead: false };
  let asking = () => {};
  const asked = new Promise<void>((resolve) => {
    asking = resolve;
  });
  // The editor is still deciding when the agent stops.
  const first = acpEditor(
    agent(checkpointer, counters, life, { approve: true }),
    () => {
      asking();
      return new Promise(() => {});
    },
    { sessions: mortal(sessions, life) },
  );
  await first.request('initialize', { protocolVersion: 1 });
  const sessionId = (await first.request('session/new', { cwd: '/repo', mcpServers: [] })).result.sessionId as string;
  void first.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Email Ana the report' }] });
  await asked;
  life.dead = true;
  first.close();
  assert.deepEqual(counters.sent, [], 'nothing was sent before the approval');

  const second = acpEditor(agent(checkpointer, counters, { dead: false }, { approve: true }), allow, { sessions });
  await second.request('initialize', { protocolVersion: 1 });
  await second.request('session/load', { sessionId, cwd: '/repo', mcpServers: [] });
  await until(() => texts(second.updates).includes('Sent: "delivered"'), 'the answer');
  assert.deepEqual(
    second.asked.map((request) => request.method),
    ['session/request_permission'],
    'the approval is asked again',
  );
  assert.deepEqual(counters.sent, ['ana']);
  second.close();
});

test('a graph that cannot carry a turn on tells the editor so', async () => {
  const sessions = new MemoryAcpSessionStore();
  const life = { dead: false };
  let reached = () => {};
  const running = new Promise<void>((resolve) => {
    reached = resolve;
  });
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
  const first = acpEditor(graph, allow, { sessions: mortal(sessions, life) });
  await first.request('initialize', { protocolVersion: 1 });
  const sessionId = (await first.request('session/new', { cwd: '/repo', mcpServers: [] })).result.sessionId as string;
  void first.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] });
  await running;
  life.dead = true;
  first.close();

  const second = acpEditor(graph, allow, { sessions });
  await second.request('initialize', { protocolVersion: 1 });
  await second.request('session/load', { sessionId, cwd: '/repo', mcpServers: [] });
  await until(() => texts(second.updates).some((text) => /could not be carried on/.test(String(text))), 'the notice');
  await turnOver(sessions, sessionId);
  assert.equal((await sessions.get(sessionId))?.turn, undefined, 'the turn is over, not left in progress');
  second.close();
});
