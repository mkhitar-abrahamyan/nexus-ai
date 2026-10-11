/**
 * AG-UI, complete: state reported as it changes, as patches that rebuild the final state; the whole
 * transcript as a snapshot; and tools the frontend offers, which the model calls, the frontend runs,
 * and the agent waits for. Without the options, a run's events are what they were.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentInput, createAgent } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { type AgUiEvent, type AgUiMessage, type AgUiRunInput, agUiEvents } from '../src/protocols/ag-ui.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

type Step = Partial<NexusResponse> | ((request: CompletionRequest) => Partial<NexusResponse>);

/** A model that answers from a script, and records every request. */
function scripted(steps: Step[]) {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    client: {
      async complete(request: CompletionRequest) {
        requests.push(request);
        const step = steps[Math.min(requests.length - 1, steps.length - 1)] as Step;
        const response = typeof step === 'function' ? step(request) : step;
        return { content: '', role: 'assistant', finishReason: 'stop', meta: {}, ...response } as NexusResponse;
      },
    },
  };
}

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

const lookup = tool({
  name: 'lookup_flight',
  description: 'Looks up a flight',
  parameters: { type: 'object' },
  execute: async () => ({ flight: 'NX 42', seats: 3 }),
});

const confirm = {
  name: 'confirm_booking',
  description: 'Asks the traveller to confirm, in the page',
  parameters: { type: 'object', properties: { flight: { type: 'string' } } },
};

async function collect(events: AsyncIterable<AgUiEvent>): Promise<AgUiEvent[]> {
  const out: AgUiEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** RFC 6902, as a frontend applies it: add, remove, and replace, by JSON pointer. */
function applyPatch(document: unknown, operations: Array<{ op: string; path: string; value?: unknown }>): unknown {
  let root = structuredClone(document);
  for (const operation of operations) {
    if (operation.path === '') {
      root = structuredClone(operation.value);
      continue;
    }
    const keys = operation.path
      .slice(1)
      .split('/')
      .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'));
    const last = keys.pop() as string;
    let parent = root as Record<string, unknown> | unknown[];
    for (const key of keys) parent = (parent as Record<string, unknown>)[key] as Record<string, unknown>;
    if (Array.isArray(parent)) {
      const index = last === '-' ? parent.length : Number(last);
      if (operation.op === 'add') parent.splice(index, 0, structuredClone(operation.value));
      else if (operation.op === 'remove') parent.splice(index, 1);
      else parent[index] = structuredClone(operation.value);
    } else if (operation.op === 'remove') delete parent[last];
    else parent[last] = structuredClone(operation.value);
  }
  return root;
}

const run = (messages: AgUiMessage[], extra: Partial<AgUiRunInput> = {}): AgUiRunInput => ({
  threadId: 'trip',
  runId: `run-${messages.length}`,
  messages,
  ...extra,
});

test('state is reported as it changes, and the snapshot and its patches rebuild the final state', async () => {
  const { client } = scripted([
    { toolCalls: [call('c1', 'lookup_flight', { to: 'Yerevan' })], finishReason: 'tool_calls' },
    { content: 'NX 42 has 3 seats.' },
  ]);
  const agent = createAgent({ client, model: 'mock', tools: [lookup] });
  const events = await collect(
    agUiEvents(agent, run([{ id: 'u1', role: 'user', content: 'Flights to Yerevan?' }]), { stateDeltas: true }),
  );
  const snapshots = events.filter((event) => event.type === 'STATE_SNAPSHOT');
  const deltas = events.filter((event) => event.type === 'STATE_DELTA');
  assert.ok(deltas.length >= 2, `${deltas.length} deltas, one per step that changed the state`);
  const first = events.findIndex((event) => event.type === 'STATE_SNAPSHOT');
  assert.ok(first < events.findIndex((event) => event.type === 'STATE_DELTA'), 'a snapshot comes first');

  let state = snapshots[0]?.snapshot;
  for (const delta of deltas) state = applyPatch(state, delta.delta as never);
  const final = snapshots.at(-1)?.snapshot;
  assert.deepEqual(state, JSON.parse(JSON.stringify(final)), 'the patches rebuild the final state');
  assert.equal((state as { answer: string }).answer, 'NX 42 has 3 seats.');

  // A growing transcript costs only its new messages.
  const operations = deltas.flatMap((delta) => delta.delta as Array<{ op: string; path: string }>);
  assert.ok(operations.some((operation) => operation.op === 'add' && operation.path === '/messages/-'));
  assert.ok(!operations.some((operation) => operation.path === '/messages' && operation.op === 'replace'));
  // Each delta is sent where it happened, before the run finishes.
  assert.ok(events.indexOf(deltas.at(-1) as AgUiEvent) < events.findIndex((event) => event.type === 'RUN_FINISHED'));
});

test('the whole transcript comes as a messages snapshot, with the frontend’s ids and the tool results’', async () => {
  const { client } = scripted([
    { toolCalls: [call('c1', 'lookup_flight', {})], finishReason: 'tool_calls' },
    { content: 'Booked.' },
  ]);
  const agent = createAgent({ client, model: 'mock', tools: [lookup] });
  const events = await collect(
    agUiEvents(
      agent,
      run([
        { id: 'sys', role: 'developer', content: 'Be brief.' },
        { id: 'u1', role: 'user', content: 'Book NX 42' },
      ]),
      { messagesSnapshot: true },
    ),
  );
  const snapshot = events.find((event) => event.type === 'MESSAGES_SNAPSHOT')?.messages as AgUiMessage[];
  assert.deepEqual(
    snapshot.map((message) => [message.id, message.role]),
    [
      ['sys', 'developer'],
      ['u1', 'user'],
      ['run-2:2', 'assistant'],
      ['c1:result', 'tool'],
      ['run-2:4', 'assistant'],
    ],
  );
  assert.equal(snapshot[2]?.toolCalls?.[0]?.function.name, 'lookup_flight');
  assert.equal(snapshot[3]?.toolCallId, 'c1');
  assert.equal(snapshot[4]?.content, 'Booked.');
  const result = events.find((event) => event.type === 'TOOL_CALL_RESULT');
  assert.equal(result?.messageId, 'c1:result', 'the same id the result event used');
  assert.ok(
    events.findIndex((event) => event.type === 'MESSAGES_SNAPSHOT') <
      events.findIndex((event) => event.type === 'RUN_FINISHED'),
  );
});

test('a frontend tool is offered to the model, run by the frontend, and its result continues the turn', async () => {
  const { client, requests } = scripted([
    // Turn one: the agent looks up the flight and asks the page to confirm, in one step.
    {
      toolCalls: [call('c1', 'lookup_flight', {}), call('c2', 'confirm_booking', { flight: 'NX 42' })],
      finishReason: 'tool_calls',
    },
    // Turn two: the page's answer is in the transcript.
    (request) => ({ content: `The traveller said: ${String(request.messages.at(-1)?.content)}` }),
  ]);
  const agent = createAgent({ client, model: 'mock', tools: [lookup] });
  const first = await collect(
    agUiEvents(agent, run([{ id: 'u1', role: 'user', content: 'Book NX 42' }], { tools: [confirm] }), {
      frontendTools: true,
      messagesSnapshot: true,
    }),
  );
  assert.deepEqual(
    requests[0]?.tools?.map((item) => item.name),
    ['lookup_flight', 'confirm_booking'],
    'the model is offered the agent’s tools and the page’s',
  );
  const started = first.filter((event) => event.type === 'TOOL_CALL_START').map((event) => event.toolCallName);
  assert.deepEqual(started.sort(), ['confirm_booking', 'lookup_flight']);
  const results = first.filter((event) => event.type === 'TOOL_CALL_RESULT').map((event) => event.toolCallId);
  assert.deepEqual(results, ['c1'], 'the agent ran its own tool; the page runs its own');
  assert.equal(requests.length, 1, 'the agent waits for the page instead of calling the model again');
  const finished = first.find((event) => event.type === 'RUN_FINISHED');
  assert.deepEqual(finished?.outcome, { type: 'success' });
  assert.equal(
    (first.find((event) => event.type === 'STATE_SNAPSHOT')?.snapshot as { stopReason?: string } | undefined)
      ?.stopReason,
    'client_tools',
  );

  // The page runs confirm_booking and sends the conversation back with its result.
  const transcript = first.find((event) => event.type === 'MESSAGES_SNAPSHOT')?.messages as AgUiMessage[];
  const second = await collect(
    agUiEvents(
      agent,
      run([...transcript, { id: 'page-1', role: 'tool', toolCallId: 'c2', content: 'confirmed' }], {
        tools: [confirm],
      }),
      { frontendTools: true },
    ),
  );
  assert.equal(requests.length, 2);
  assert.equal(second.find((event) => event.type === 'RUN_FINISHED')?.result, 'The traveller said: confirmed');
});

test('without the options a run reports as before, and a page cannot shadow the agent’s own tools', async () => {
  const { client, requests } = scripted([{ content: 'Hello.' }]);
  const agent = createAgent({ client, model: 'mock', tools: [lookup] });
  const events = await collect(
    agUiEvents(agent, run([{ id: 'u1', role: 'user', content: 'Hi' }], { tools: [confirm] })),
  );
  const types = new Set(events.map((event) => event.type));
  assert.ok(!types.has('STATE_DELTA') && !types.has('MESSAGES_SNAPSHOT'));
  assert.equal(events.filter((event) => event.type === 'STATE_SNAPSHOT').length, 1, 'the final state, once');
  assert.deepEqual(
    requests[0]?.tools?.map((item) => item.name),
    ['lookup_flight'],
    'the page’s tools are not offered unless asked',
  );

  // A client tool named like the agent's own is the agent's: it runs on the server.
  const { client: second, requests: seen } = scripted([
    { toolCalls: [call('c1', 'lookup_flight', {})], finishReason: 'tool_calls' },
    { content: 'Found it.' },
  ]);
  const guarded = createAgent({ client: second, model: 'mock', tools: [lookup] });
  const result = await guarded.invoke({
    ...agentInput('Find NX 42'),
    clientTools: [{ name: 'lookup_flight', description: 'An impostor', parameters: { type: 'object' } }],
  });
  assert.equal(result.state.answer, 'Found it.');
  assert.equal(result.state.stopReason, 'completed');
  assert.deepEqual(
    seen[0]?.tools?.map((item) => item.description),
    ['Looks up a flight'],
    'offered once, as the agent’s',
  );
});

test('every step a run opens is closed before it finishes, a paused one too, and parallel calls are one step', async () => {
  // Two tool calls at once, the second waiting for approval: the run pauses inside the tools step.
  const { client } = scripted([
    {
      toolCalls: [call('c1', 'lookup_flight', {}), call('c2', 'book', {})],
      finishReason: 'tool_calls',
    },
  ]);
  const book = tool({
    name: 'book',
    description: 'Books',
    parameters: { type: 'object' },
    execute: async () => 'booked',
  });
  const agent = createAgent({ client, model: 'mock', tools: [lookup, book], interruptOn: { book: true } });
  const events = await collect(agUiEvents(agent, run([{ id: 'u1', role: 'user', content: 'Book NX 42' }])));
  const open = new Map<string, number>();
  for (const event of events) {
    const name = String(event.stepName);
    if (event.type === 'STEP_STARTED') {
      assert.ok(!open.has(name), `${name} is not started twice while it runs`);
      open.set(name, 1);
    } else if (event.type === 'STEP_FINISHED') {
      assert.ok(open.has(name), `${name} finishes after it started`);
      open.delete(name);
    } else if (event.type === 'RUN_FINISHED') {
      assert.deepEqual([...open.keys()], [], 'no step is open when the run finishes');
    }
  }
  assert.equal((events.at(-1)?.outcome as { type?: string } | undefined)?.type, 'interrupt');
  assert.equal(events.filter((event) => event.type === 'STEP_STARTED' && event.stepName === 'tools').length, 1);
});
