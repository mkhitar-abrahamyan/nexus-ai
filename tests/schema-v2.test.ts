import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateCheckpoint, toCheckpoint } from '../src/graph/checkpoint-migration.js';
import { MemoryGraphCheckpointer, OperationStoreCheckpointer } from '../src/graph/checkpointer.js';
import { createGraph } from '../src/graph/graph.js';
import { lastValue } from '../src/graph/channels.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import { KNOWN_MODELS } from '../src/types/providers.js';
import { modalitiesOf, resolveModel } from '../src/models/registry.js';
import { BaseProvider } from '../src/providers/base.js';
import { Router } from '../src/router/index.js';
import type { GraphCheckpointer, GraphCheckpointV1 } from '../src/types/graph.js';
import type { NexusAIConfig } from '../src/types/config.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse, NexusStream } from '../src/types/response.js';

// ── Modalities with a direction ────────────────────────────────────

test('every registry entry declares what it accepts and what it produces', () => {
  for (const [name, capabilities] of Object.entries(KNOWN_MODELS)) {
    assert.ok(capabilities.inputModalities.includes('text'), `${name} accepts text`);
    assert.ok(capabilities.outputModalities.length > 0, `${name} produces something`);
    assert.equal('modalities' in capabilities, false, `${name} has no undirected list`);
  }
  assert.deepEqual(KNOWN_MODELS['gemini-3-pro-image-preview']?.outputModalities, ['text', 'image']);
  assert.ok(KNOWN_MODELS['gemini-2.5-flash']?.inputModalities.includes('pdf'));
});

test('modalitiesOf returns copies of both lists', () => {
  const capabilities = {
    inputModalities: ['text', 'image'] as Array<'text' | 'image' | 'audio'>,
    outputModalities: ['text'] as Array<'text'>,
  };
  const read = modalitiesOf(capabilities);
  assert.deepEqual(read, { input: ['text', 'image'], output: ['text'] });
  read.input.push('audio');
  assert.deepEqual(capabilities.inputModalities, ['text', 'image'], 'the entry is not changed');
});

class QuietProvider extends BaseProvider {
  constructor(readonly info: { name: string; isLocal: boolean }) {
    super();
  }
  async complete(): Promise<NexusResponse> {
    throw new Error('not called');
  }
  stream(): NexusStream {
    return { async *[Symbol.asyncIterator]() {}, abort() {} };
  }
}

test('routing can require what a model accepts and what it produces', () => {
  const providers = new Map<string, BaseProvider>([['google', new QuietProvider({ name: 'google', isLocal: false })]]);
  const request: CompletionRequest = { model: 'auto', messages: [{ role: 'user', content: 'draw a cat' }] };
  const route = (requiredCapabilities: NonNullable<NexusAIConfig['routing']>['requiredCapabilities']) =>
    new Router().route(
      request,
      {
        providers: { google: { apiKey: 'test' } },
        routing: {
          mode: 'auto',
          strategy: 'quality',
          candidateModels: ['gemini-2.5-flash', 'gemini-3-pro-image-preview'],
          requiredCapabilities,
        },
      } as NexusAIConfig,
      providers,
      [],
      [],
    );
  assert.equal(route({ outputModalities: ['image'] }).model, 'gemini-3-pro-image-preview');
  assert.equal(route({ inputModalities: ['pdf'] }).model, 'gemini-2.5-flash', 'only the general model takes PDFs');
});

test('a provider-prefixed model name finds its registry entry', () => {
  const prefixed = resolveModel('google/gemini-2.5-flash');
  assert.equal(prefixed.capabilities, KNOWN_MODELS['gemini-2.5-flash']);
  assert.equal(prefixed.model, 'google/gemini-2.5-flash', 'the name sent on is unchanged');
  assert.equal(resolveModel('openai/gpt-4o').capabilities, KNOWN_MODELS['gpt-4o']);
  assert.equal(resolveModel('azure/gpt-4o').capabilities, undefined, 'another provider does not borrow the entry');
  assert.equal(resolveModel('groq/llama-3.3-70b-versatile').capabilities?.provider, 'groq');
});

// ── Checkpoints in the 2.0 schema ──────────────────────────────────

const v1: GraphCheckpointV1 = {
  threadId: 'thread-1',
  step: 3,
  state: { count: 1 },
  next: ['review', 'notify'],
  status: 'running',
  createdAt: '2026-10-01T00:00:00.000Z',
};

test('migrateCheckpoint gives a 1.x checkpoint its id, its tasks, and every question in one list', () => {
  const plain = migrateCheckpoint(v1);
  assert.equal(plain.version, 2);
  assert.equal(plain.id, 'thread-1:3');
  assert.deepEqual(plain.tasks, [
    { id: 'review', node: 'review' },
    { id: 'notify', node: 'notify' },
  ]);
  assert.deepEqual(plain.interrupts, []);
  assert.equal('interrupt' in plain, false);

  const question = { id: 'q', node: 'review', step: 3, index: 0, requestedAt: v1.createdAt, reason: 'ok?' };
  const paused = migrateCheckpoint({ ...v1, status: 'awaiting_input', interrupt: question });
  assert.deepEqual(paused.interrupts, [question]);
  const sent = migrateCheckpoint({ ...v1, tasks: [{ id: 'review#3.0', node: 'review', input: 1 }] });
  assert.deepEqual(sent.tasks, [{ id: 'review#3.0', node: 'review', input: 1 }], 'explicit tasks are kept');
  assert.equal(migrateCheckpoint(plain), plain, 'a 2.0 checkpoint passes through');
});

test('toCheckpoint derives the id again, so a copy to another thread never keeps a stale one', () => {
  const moved = toCheckpoint({ ...migrateCheckpoint(v1), threadId: 'fork-1' });
  assert.equal(moved.id, 'fork-1:3');
});

const approvalGraph = (checkpointer: GraphCheckpointer) =>
  createGraph({ channels: { draft: lastValue<string>(), approved: lastValue<boolean>() } })
    .addNode('approve', (context) => ({ approved: context.interrupt<boolean>({ reason: 'Approve?' }) }))
    .addEdge('__start__', 'approve')
    .addEdge('approve', '__end__')
    .compile({ checkpointer });

const checkpointers: Array<[string, () => GraphCheckpointer]> = [
  ['memory', () => new MemoryGraphCheckpointer()],
  ['operation store', () => new OperationStoreCheckpointer(new MemoryOperationStore())],
];

for (const [name, makeCheckpointer] of checkpointers) {
  test(`the ${name} checkpointer writes version 2 and resumes a thread 1.x left waiting`, async () => {
    const checkpointer = makeCheckpointer();
    const graph = approvalGraph(checkpointer);

    const paused = await graph.invoke({ draft: 'hello' }, { threadId: 'new' });
    assert.equal(paused.status, 'awaiting_input');
    const written = await checkpointer.get('new');
    assert.equal(written?.version, 2);
    assert.equal(written ? 'interrupt' in written : true, false, 'only interrupts is written');

    // What 1.x wrote for the same pause: no version, no id, and the question in `interrupt`.
    const current = await graph.state('new');
    assert.ok(current);
    const question = current.interrupts[0];
    assert.ok(question);
    const legacy: GraphCheckpointV1 = {
      threadId: 'legacy',
      step: current.step,
      state: current.state,
      next: current.next,
      status: 'awaiting_input',
      interrupt: question,
      createdAt: current.createdAt,
    };
    // A store written by 1.x holds exactly this shape.
    await checkpointer.put(legacy as never);

    const read = await graph.state('legacy');
    assert.equal(read?.version, 2);
    assert.equal(read?.interrupts.length, 1);
    const resumed = await graph.resumeWith('legacy', true);
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.state.approved, true);
  });
}
