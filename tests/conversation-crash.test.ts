/**
 * Every conversation that runs on a worker, killed at every durable write, and taken over elsewhere:
 * an A2A task, an ACP turn, and a realtime conversation.
 *
 * A clean run is counted first: each write it makes to its stores is a boundary. Then the run is
 * repeated once per boundary, and the worker dies at that write: the write fails, and nothing that
 * process does reaches a store again. Another worker takes the conversation over, and it must end
 * where the clean run ended. Side effects may repeat, as the guarantee is at least once; what the
 * conversation ends with may not change, and nothing may be left half done. A worker that dies before
 * its conversation was first recorded must have told its caller so.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createAgent } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import {
  type A2aServerOptions,
  type A2aTask,
  type A2aTaskStore,
  a2aClient,
  a2aHandler,
  MemoryA2aTaskStore,
  storeA2aTasks,
} from '../src/protocols/a2a.js';
import { type AcpSessionStore, MemoryAcpSessionStore, storeAcpSessions } from '../src/protocols/acp.js';
import { MemoryRealtimeConversationStore } from '../src/realtime/conversation.js';
import { TypedEventEmitter } from '../src/realtime/events.js';
import { RealtimeSession } from '../src/realtime/session.js';
import type {
  RealtimeClientEvent,
  RealtimeConversation,
  RealtimeConversationStore,
  RealtimeServerEvent,
  RealtimeTransport,
  RealtimeTransportEvents,
} from '../src/realtime/types.js';
import { SqliteStore } from '../src/sqlite/store.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import { acpEditor, type Wire } from './acp-editor.js';

class Crash extends Error {
  constructor() {
    super('the worker died');
    this.name = 'Crash';
  }
}

/**
 * One worker's view of the shared stores. It counts the writes it makes (records, checkpoints, and
 * conversations), dies at the `crashAt`-th, and from then on reaches no store. Lease renewals (`claim`) are not boundaries: when one lands
 * depends on the clock, not on the conversation.
 */
function worker(crashAt = Number.POSITIVE_INFINITY) {
  const life = { dead: false, writes: 0 };
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, property, receiver) {
        const value = Reflect.get(object, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (life.dead) throw new Crash();
          if (property === 'put' || property === 'saveConversation') {
            life.writes += 1;
            if (life.writes >= crashAt) {
              life.dead = true;
              throw new Crash();
            }
          }
          return (value as (...inner: unknown[]) => unknown).apply(object, args);
        };
      },
    });
  return { life, wrap };
}

interface Effects {
  sent: string[];
}

/** A model that sends one email, then reports what the tool said. */
function mailer() {
  return {
    async complete(request: CompletionRequest) {
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

function mailAgent(
  checkpointer: MemoryGraphCheckpointer,
  effects: Effects,
  life: { dead: boolean },
  wrap: <T extends object>(target: T) => T,
) {
  const sendEmail = tool({
    name: 'send_email',
    description: 'Sends an email',
    parameters: { type: 'object' },
    async *stream(args) {
      yield 'drafting';
      if (life.dead) throw new Crash();
      effects.sent.push(String(args.to));
      return 'delivered';
    },
  });
  return createAgent({ client: mailer(), model: 'mock', tools: [sendEmail], checkpointer: wrap(checkpointer) });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, what: string, tries = 300): Promise<void> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (await check()) return;
    await sleep(5);
  }
  throw new Error(`never: ${what}`);
}

// ── A2A ─────────────────────────────────────────────────────────────

const CARD: A2aServerOptions['card'] = {
  name: 'Mailer',
  description: 'Sends mail',
  version: '1.0.0',
  url: 'http://agent.test/a2a',
  skills: [],
};
const LEASE_MS = 60;

function a2aReplica(store: A2aTaskStore, checkpointer: MemoryGraphCheckpointer, effects: Effects, crashAt?: number) {
  const { life, wrap } = worker(crashAt);
  const handler = a2aHandler(mailAgent(checkpointer, effects, life, wrap), {
    card: CARD,
    store: wrap(store),
    lease: { ms: LEASE_MS },
  });
  const client = a2aClient({ url: CARD.url, fetch: async (input, init) => handler(new Request(input, init)) });
  return { handler, client, life };
}

/**
 * Waits until a task can be taken over by the wall clock, which leases are kept by: its lease lapsed,
 * or, with none, it has been still a lease long; or it is no longer working. A timer runs on another
 * clock, which a virtual machine's wall clock, stepped back as it syncs with its host, can fall behind.
 */
async function lapsed(store: A2aTaskStore, id: string, what: string): Promise<void> {
  await until(
    async () => {
      const record = await store.get(id);
      if (!record || !['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED'].includes(record.task.status.state)) return true;
      const now = Date.now();
      return record.lease ? Date.parse(record.lease.expiresAt) < now : Date.parse(record.updatedAt) < now - LEASE_MS;
    },
    what,
    1_000,
  );
}

async function settledTask(client: ReturnType<typeof a2aClient>, id: string): Promise<A2aTask> {
  let task: A2aTask | undefined;
  await until(async () => {
    task = await client.getTask(id);
    return !['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED'].includes(task.status.state);
  }, `task ${id} settles`);
  return task as A2aTask;
}

test('an A2A task killed at every write is taken over and ends as an uninterrupted one does', async () => {
  const sqlite = new SqliteStore(new DatabaseSync(':memory:'));
  await sqlite.migrate();
  const stores: Array<[string, () => A2aTaskStore]> = [
    ['memory task store', () => new MemoryA2aTaskStore()],
    ['sqlite', () => storeA2aTasks(sqlite, { namespace: ['crash', String(Math.random())] })],
  ];
  for (const [name, open] of stores) {
    // The clean run, counted.
    const clean = a2aReplica(open(), new MemoryGraphCheckpointer(), { sent: [] });
    const baseline = await settledTask(
      clean.client,
      (await clean.client.send('Email Ana the report', { returnImmediately: true })).id,
    );
    clean.handler.close();
    const boundaries = clean.life.writes;
    assert.equal(baseline.status.state, 'TASK_STATE_COMPLETED');
    assert.ok(boundaries >= 4, `${name}: the task is written several times (${boundaries})`);

    let crashes = 0;
    for (let crashAt = 1; crashAt <= boundaries; crashAt += 1) {
      const store = open();
      const checkpointer = new MemoryGraphCheckpointer();
      const effects: Effects = { sent: [] };
      const first = a2aReplica(store, checkpointer, effects, crashAt);
      const at = `${name}, killed at write ${crashAt} of ${boundaries}`;
      let id: string | undefined;
      try {
        id = (await first.client.send('Email Ana the report', { returnImmediately: true })).id;
      } catch {
        // The worker died before the task was first recorded: its caller was told.
      }
      await until(() => first.life.dead, `${at}: the worker dies`);
      crashes += 1;
      first.handler.close();
      if (id === undefined) {
        assert.equal((await store.list({ limit: 10, offset: 0 })).records.length, 0, `${at}: nothing is left working`);
        continue;
      }

      // Another replica takes the task over once the lease lapses, and it ends as the clean run did.
      const second = a2aReplica(store, checkpointer, effects);
      await lapsed(store, id, `${at}: the lease lapses`);
      await second.handler.recover();
      const done = await settledTask(second.client, id);
      assert.equal(done.status.state, 'TASK_STATE_COMPLETED', at);
      assert.deepEqual(
        done.artifacts?.map((artifact) => artifact.parts),
        baseline.artifacts?.map((artifact) => artifact.parts),
        `${at}: the same answer`,
      );
      assert.ok(effects.sent.length >= 1, `${at}: the email is sent`);
      assert.deepEqual(await second.handler.recover(), { tookOver: [], skipped: 0 }, `${at}: nothing is left to take`);
      second.handler.close();
    }
    assert.equal(crashes, boundaries, `${name}: every boundary was crashed at`);
  }
});

// ── ACP ─────────────────────────────────────────────────────────────

const allow = () => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
const answers = (updates: Wire[]) =>
  updates.filter((update) => update.sessionUpdate === 'agent_message_chunk').map((update) => update.content?.text);

test('an ACP turn killed at every write goes on when the editor reopens the session', async () => {
  const sqlite = new SqliteStore(new DatabaseSync(':memory:'));
  await sqlite.migrate();
  const stores: Array<[string, () => AcpSessionStore]> = [
    ['memory', () => new MemoryAcpSessionStore()],
    ['sqlite', () => storeAcpSessions(sqlite, { namespace: ['crash', String(Math.random())] })],
  ];
  for (const [name, open] of stores) {
    const clean = worker();
    const cleanSessions = open();
    const cleanEditor = acpEditor(
      mailAgent(new MemoryGraphCheckpointer(), { sent: [] }, clean.life, clean.wrap),
      allow,
      {
        sessions: clean.wrap(cleanSessions),
      },
    );
    await cleanEditor.request('initialize', { protocolVersion: 1 });
    const cleanId = (await cleanEditor.request('session/new', { cwd: '/repo', mcpServers: [] })).result
      .sessionId as string;
    await cleanEditor.request('session/prompt', {
      sessionId: cleanId,
      prompt: [{ type: 'text', text: 'Email Ana the report' }],
    });
    await until(async () => (await cleanSessions.get(cleanId))?.turn === undefined, 'the clean turn is saved');
    cleanEditor.close();
    const boundaries = clean.life.writes;
    const baseline = (await cleanSessions.get(cleanId))?.history.map((message) => [message.role, message.content]);
    assert.ok(boundaries >= 4, `${name}: the session is written several times (${boundaries})`);

    for (let crashAt = 1; crashAt <= boundaries; crashAt += 1) {
      const sessions = open();
      const checkpointer = new MemoryGraphCheckpointer();
      const effects: Effects = { sent: [] };
      const { life, wrap } = worker(crashAt);
      const at = `${name}, killed at write ${crashAt} of ${boundaries}`;
      const first = acpEditor(mailAgent(checkpointer, effects, life, wrap), allow, { sessions: wrap(sessions) });
      await first.request('initialize', { protocolVersion: 1 });
      const created = await first.request('session/new', { cwd: '/repo', mcpServers: [] });
      if (created.error) {
        assert.ok(life.dead, `${at}: the editor was told the session was not created`);
        first.close();
        continue;
      }
      const sessionId = created.result.sessionId as string;
      let refused = false;
      void first
        .request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Email Ana the report' }] })
        .then((response) => {
          if (response.error) refused = true;
        });
      await until(() => life.dead, `${at}: the agent dies`);
      await sleep(10);
      first.close();

      const kept = await sessions.get(sessionId);
      if (!kept?.turn && !kept?.history.some((message) => message.role === 'user')) {
        // The agent died before it kept the turn: the editor's prompt was refused, and nothing is half done.
        assert.ok(refused, `${at}: the editor was told the prompt was not taken`);
        continue;
      }

      // The editor starts the agent again and reopens the session: the turn ends as the clean one did.
      const again = worker();
      const second = acpEditor(mailAgent(checkpointer, effects, again.life, again.wrap), allow, { sessions });
      await second.request('initialize', { protocolVersion: 1 });
      await second.request('session/load', { sessionId, cwd: '/repo', mcpServers: [] });
      await until(async () => (await sessions.get(sessionId))?.turn === undefined, `${at}: the turn is saved as over`);
      const record = await sessions.get(sessionId);
      assert.deepEqual(
        record?.history.map((message) => [message.role, message.content]),
        baseline,
        `${at}: the conversation is the clean run's`,
      );
      assert.ok(effects.sent.length >= 1, `${at}: the email is sent`);
      if (kept?.turn)
        assert.ok(answers(second.updates).includes('Sent: "delivered"'), `${at}: the editor hears the answer`);
      second.close();
    }
  }
});

test('an ACP agent that stops again while carrying a turn on leaves it for the next load', async () => {
  const sessions = new MemoryAcpSessionStore();
  const checkpointer = new MemoryGraphCheckpointer();
  const effects: Effects = { sent: [] };
  // The first agent stops at its first checkpoint, with the turn kept.
  const first = worker(3);
  const editor = acpEditor(mailAgent(checkpointer, effects, first.life, first.wrap), allow, {
    sessions: first.wrap(sessions),
  });
  await editor.request('initialize', { protocolVersion: 1 });
  const sessionId = (await editor.request('session/new', { cwd: '/repo', mcpServers: [] })).result.sessionId as string;
  await editor.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Email Ana the report' }] });
  editor.close();
  assert.equal((await sessions.get(sessionId))?.turn?.kind, 'invoke');

  // The second reopens the session and stops too, the moment it starts carrying the turn on.
  const second = worker(2);
  const reopened = acpEditor(mailAgent(checkpointer, effects, second.life, second.wrap), allow, {
    sessions: second.wrap(sessions),
  });
  await reopened.request('initialize', { protocolVersion: 1 });
  await reopened.request('session/load', { sessionId, cwd: '/repo', mcpServers: [] });
  await until(() => second.life.dead, 'the second agent stops');
  reopened.close();
  assert.equal((await sessions.get(sessionId))?.turn?.kind, 'invoke', 'the turn is still kept');

  // The third carries it to its end.
  const third = worker();
  const last = acpEditor(mailAgent(checkpointer, effects, third.life, third.wrap), allow, { sessions });
  await last.request('initialize', { protocolVersion: 1 });
  await last.request('session/load', { sessionId, cwd: '/repo', mcpServers: [] });
  await until(() => answers(last.updates).includes('Sent: "delivered"'), 'the answer');
  await until(async () => (await sessions.get(sessionId))?.turn === undefined, 'the turn is saved as over');
  assert.deepEqual(
    (await sessions.get(sessionId))?.history
      .filter((message) => message.role === 'user')
      .map((message) => message.content),
    ['Email Ana the report'],
  );
  last.close();
});

// ── Realtime ────────────────────────────────────────────────────────

class Transport implements RealtimeTransport {
  readonly kind = 'websocket' as const;
  readonly sent: RealtimeClientEvent[] = [];
  private readonly emitter = new TypedEventEmitter<RealtimeTransportEvents>();
  on<Event extends keyof RealtimeTransportEvents>(
    event: Event,
    listener: (payload: RealtimeTransportEvents[Event]) => void,
  ) {
    return this.emitter.on(event, listener);
  }
  async connect(): Promise<void> {
    this.emitter.emit('connected', { sessionId: 'provider', transport: this.kind, timestamp: 0 });
  }
  sendAudio(): void {}
  sendEvent(event: RealtimeClientEvent): void {
    this.sent.push(event);
  }
  interrupt(): void {}
  async disconnect(): Promise<void> {
    this.emitter.emit('disconnected', { transport: this.kind, timestamp: 0, expected: true, retryable: false });
  }
  emit(event: RealtimeServerEvent): void {
    this.emitter.emit('data', { event, raw: event });
  }
  exchange(turn: number, said: string, answer: string): void {
    this.emit({ type: 'input_audio_buffer.speech_started', item_id: `user_${turn}` });
    this.emit({ type: 'input_audio_buffer.speech_stopped', item_id: `user_${turn}` });
    this.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: `user_${turn}`,
      transcript: said,
    });
    this.emit({ type: 'response.created', response: { id: `response_${turn}` } });
    this.emit({
      type: 'response.output_audio_transcript.done',
      response_id: `response_${turn}`,
      item_id: `assistant_${turn}`,
      transcript: answer,
    });
    this.emit({ type: 'response.done', response: { id: `response_${turn}`, status: 'completed', output: [] } });
  }
}

const EXCHANGES: Array<[string, string]> = [
  ['My order number is 42', 'Order 42 ships Monday'],
  ['Can it ship sooner?', 'It can ship Saturday'],
  ['Please do that', 'Done: Saturday'],
];
const spoken = (conversation: RealtimeConversation | undefined) =>
  (conversation?.items ?? [])
    .filter((item) => item.type === 'user_speech' || item.type === 'assistant_speech')
    .map((item) => (item as { transcript: string }).transcript);

async function talk(conversationStore: RealtimeConversationStore, transport: Transport, id?: string) {
  const session = new RealtimeSession({
    model: 'gpt-realtime',
    transport,
    conversationStore,
    conversation: { captureTranscripts: true },
    ...(id ? { resume: id } : { id: 'conv_crash' }),
  });
  await session.connect();
  return session;
}

test('a realtime conversation killed at every write is resumed with what it had kept, and nothing twice', async () => {
  const clean = worker();
  const cleanStore = new MemoryRealtimeConversationStore();
  const cleanTransport = new Transport();
  const cleanSession = await talk(clean.wrap(cleanStore), cleanTransport);
  for (const [index, [said, answer]] of EXCHANGES.entries()) cleanTransport.exchange(index + 1, said, answer);
  await cleanSession.whenIdle();
  await sleep(5);
  const boundaries = clean.life.writes;
  const baseline = spoken(await cleanStore.get('conv_crash'));
  assert.equal(baseline.length, 6);
  assert.ok(boundaries >= 6, `the conversation is written after each committed turn (${boundaries})`);

  for (let crashAt = 1; crashAt <= boundaries; crashAt += 1) {
    const at = `killed at write ${crashAt} of ${boundaries}`;
    const store = new MemoryRealtimeConversationStore();
    const { life, wrap } = worker(crashAt);
    const transport = new Transport();
    const session = await talk(wrap(store), transport);
    session.on('error', () => undefined);
    for (const [index, [said, answer]] of EXCHANGES.entries()) transport.exchange(index + 1, said, answer);
    await session.whenIdle();
    await sleep(5);
    assert.ok(life.dead, `${at}: the worker died`);

    const kept = await store.get('conv_crash');
    if (!kept) {
      // Nothing was kept: there is no conversation to resume, and saying so is the right answer.
      await assert.rejects(talk(store, new Transport(), 'conv_crash'), /No conversation conv_crash is kept/);
      continue;
    }
    const keptSpeech = spoken(kept);
    assert.deepEqual(
      keptSpeech,
      baseline.slice(0, keptSpeech.length),
      `${at}: what was kept is what was said, in order`,
    );

    // Another worker resumes it: the provider is told what was kept, and the conversation goes on.
    const next = new Transport();
    const resumed = await talk(store, next, 'conv_crash');
    const replayed = next.sent
      .filter((event) => event.type === 'conversation.item.create')
      .map((event) => (event.item as { content: Array<{ text: string }> }).content[0]?.text);
    assert.deepEqual(replayed, keptSpeech, `${at}: the provider is told what was kept`);
    for (const event of next.sent.filter((sent) => sent.type === 'conversation.item.create')) {
      next.emit({ type: 'conversation.item.created', item: event.item });
    }
    next.exchange(9, 'Thank you', 'You are welcome');
    await resumed.whenIdle();
    await sleep(5);
    assert.deepEqual(
      spoken(await store.get('conv_crash')),
      [...keptSpeech, 'Thank you', 'You are welcome'],
      `${at}: one conversation, nothing twice`,
    );
    await resumed.disconnect();
  }
});
