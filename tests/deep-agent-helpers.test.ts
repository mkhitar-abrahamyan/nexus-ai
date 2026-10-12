/**
 * Helpers beside the deep agent, proved with scripted models that react to what their tools return:
 * a background helper's answer reaches the agent after the agent has moved on, with the helper's
 * events in the agent's own stream under the helper's namespace; the agent creates a helper within
 * the limits the application set; and a crash, wherever it lands between the two, repeats neither the
 * helper's finished steps nor the agent's.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentInput } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { createDeepAgent } from '../src/deep-agent/index.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import type { GraphCheckpointer } from '../src/types/graph.js';
import type { CompletionRequest, Message } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

const meta = {
  requestId: 'r',
  providerUsed: 'mock',
  modelUsed: 'mock',
  latencyMs: 0,
  tokensInput: 0,
  tokensOutput: 0,
  tokensSaved: 0,
  cacheHit: false,
  guardrailsApplied: [],
};
let ids = 0;
const call = (name: string, args: unknown) => ({
  id: `call-${++ids}`,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (partial: Partial<NexusResponse>): NexusResponse =>
  ({ content: '', role: 'assistant', finishReason: 'stop', meta, ...partial }) as NexusResponse;
const text = (message: Message | undefined) => (typeof message?.content === 'string' ? message.content : '');
const never = () => new Promise<never>(() => {});

/** What the scripted models and tools did, across every process that ran them. */
interface Counters {
  lookups: number;
  notes: number;
  helperStarts: number;
  order: string[];
}

/**
 * The main agent delegates research to the background, writes a note, then collects the answer; the
 * researcher looks something up, then answers. `pause` holds a model call that should never return
 * in this process, as one that dies would.
 */
function script(counters: Counters, pause: { main?: () => Promise<void>; helper?: () => Promise<void> } = {}) {
  const lookup = tool<{ q: string }>({
    name: 'lookup',
    description: 'Looks something up',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    capabilities: [],
    execute: () => {
      counters.lookups += 1;
      counters.order.push('helper looked up');
      return 'the answer is 42';
    },
  });
  const note = tool<{ text: string }>({
    name: 'note',
    description: 'Writes a note',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    capabilities: [],
    execute: () => {
      counters.notes += 1;
      counters.order.push('agent wrote a note');
      return 'noted';
    },
  });
  const model = {
    complete: async (request: CompletionRequest): Promise<NexusResponse> => {
      const system = text(request.messages.find((message) => message.role === 'system'));
      const results = request.messages.filter((message) => message.role === 'tool');
      const calls = request.messages.flatMap((message) => message.toolCalls ?? []);
      const resultOf = (name: string) =>
        text(results.find((message) => message.toolCallId === calls.find((made) => made.function.name === name)?.id));
      if (system.startsWith('You research')) {
        if (results.length === 0) {
          counters.helperStarts += 1;
          return reply({ toolCalls: [call('lookup', { q: 'the answer' })] });
        }
        await pause.helper?.();
        counters.order.push('helper answered');
        return reply({ content: `Found it: ${JSON.parse(resultOf('lookup'))}` });
      }
      if (results.length === 0) {
        return reply({
          toolCalls: [call('delegate', { agent: 'researcher', task: 'Find the answer', background: true })],
        });
      }
      if (!calls.some((made) => made.function.name === 'note')) {
        return reply({ toolCalls: [call('note', { text: 'moved on while the research runs' })] });
      }
      if (!calls.some((made) => made.function.name === 'collect_helper')) {
        await pause.main?.();
        const task = /task (\S+)\./.exec(JSON.parse(resultOf('delegate')) as string)?.[1];
        return reply({ toolCalls: [call('collect_helper', { task, wait_seconds: 30 })] });
      }
      return reply({ content: JSON.parse(resultOf('collect_helper')) as string });
    },
  };
  return { model, tools: [lookup, note] };
}

function agentOn(checkpointer: GraphCheckpointer, counters: Counters, pause?: Parameters<typeof script>[1]) {
  const { model, tools } = script(counters, pause);
  return createDeepAgent({
    client: model,
    planning: false,
    tools,
    permissions: false,
    checkpointer,
    subagents: [
      {
        name: 'researcher',
        description: 'Researches a question',
        instructions: 'You research questions.',
        tools: ['lookup'],
      },
    ],
  });
}

const fresh = (): Counters => ({ lookups: 0, notes: 0, helperStarts: 0, order: [] });

test('a background helper answers after the agent has moved on, its events in the agent’s stream', async () => {
  const counters = fresh();
  let release = () => {};
  const noted = new Promise<void>((resolve) => {
    release = resolve;
  });
  // The researcher answers only once the agent has written its note: the agent did not wait for it.
  const agent = agentOn(new MemoryGraphCheckpointer(), counters, { helper: () => noted });
  const original = counters.order.push.bind(counters.order);
  counters.order.push = (...entries: string[]) => {
    if (entries.includes('agent wrote a note')) release();
    return original(...entries);
  };

  const stream = agent.events(agentInput('What is the answer?'), { threadId: 'background', subgraphs: true });
  const namespaces = new Set<string>();
  const helperTools: string[] = [];
  for await (const event of stream) {
    if (event.namespace.length === 0) continue;
    namespaces.add(event.namespace.join('/'));
    if (event.type === 'tools' && event.tool.phase === 'result') helperTools.push(event.tool.name);
  }
  const run = await stream.result;
  assert.equal(run.state.answer, "The researcher helper's answer: Found it: the answer is 42");
  assert.deepEqual([...counters.order], ['helper looked up', 'agent wrote a note', 'helper answered']);
  assert.ok(
    [...namespaces].some((namespace) => /^tools\/researcher@call-\d+$/.test(namespace)),
    `the helper's events arrive under its namespace: ${[...namespaces].join(', ')}`,
  );
  assert.deepEqual(helperTools, ['lookup']);
});

test('the agent creates a helper within the limits the application set', async () => {
  const requests: CompletionRequest[] = [];
  const lookup = tool({
    name: 'lookup',
    description: 'Looks something up',
    parameters: { type: 'object', properties: {} },
    capabilities: [],
    execute: () => 'a fact',
  });
  const secret = tool({
    name: 'secret',
    description: 'Reads a secret',
    parameters: { type: 'object', properties: {} },
    capabilities: [],
    execute: () => 'hush',
  });
  const model = {
    complete: async (request: CompletionRequest): Promise<NexusResponse> => {
      requests.push(request);
      const system = text(request.messages.find((message) => message.role === 'system'));
      if (system.startsWith('You summarize')) return reply({ content: 'A summary.' });
      const results = request.messages.filter((message) => message.role === 'tool');
      if (results.length === 0) {
        return reply({
          toolCalls: [
            call('delegate', {
              agent: 'summarizer',
              task: 'Summarize the facts',
              instructions: 'You summarize facts.',
            }),
          ],
        });
      }
      if (results.length === 1) {
        return reply({
          toolCalls: [call('delegate', { agent: 'translator', task: 'Translate it', instructions: 'You translate.' })],
        });
      }
      return reply({ content: results.map((message) => text(message)).join(' | ') });
    },
  };
  const agent = createDeepAgent({
    client: model,
    planning: false,
    tools: [lookup, secret],
    permissions: false,
    createHelpers: { max: 1, tools: ['lookup'], maxIterations: 2 },
  });
  const run = await agent.invoke(agentInput('Summarize, then translate.'), { threadId: 'created' });
  assert.match(run.state.answer, /^"A summary\." \| .*created its 1 helpers; delegate to one of: summarizer/);

  const helper = requests.find((request) => text(request.messages[0]).startsWith('You summarize facts.'));
  assert.ok(helper, 'the created helper ran on the instructions the agent wrote');
  assert.deepEqual(
    helper.tools?.map((offered) => offered.name),
    ['lookup'],
    'a created helper gets only the tools the limits allow',
  );
  const main = requests[0];
  assert.ok(main?.tools?.some((offered) => offered.name === 'collect_helper'));
  assert.match(text(main?.messages[0]), /create a helper: give delegate a new name and its instructions/);
});

/** One process on a shared store. A crash stops every write from that moment, as an exit would. */
function processOn(
  store: GraphCheckpointer,
  hooks: {
    crash?: (checkpoint: { threadId: string; step: number }) => Promise<boolean>;
    stored?: (checkpoint: { threadId: string; step: number }) => void;
  } = {},
) {
  let dead = false;
  const checkpointer: GraphCheckpointer = {
    async put(checkpoint) {
      if (dead) throw new Error('the process died');
      if (hooks.crash && (await hooks.crash(checkpoint))) {
        dead = true;
        throw new Error('the process died');
      }
      await store.put(checkpoint);
      hooks.stored?.(checkpoint);
    },
    get: (threadId, step) => store.get(threadId, step),
    history: (threadId, limit) => store.history(threadId, limit),
  };
  return { checkpointer, die: () => (dead = true) };
}

async function recover(store: GraphCheckpointer, counters: Counters, threadId: string) {
  const agent = agentOn(processOn(store).checkpointer, counters);
  for await (const _ of agent.continue(threadId)) {
    // Runs on from the last checkpoint the dead process wrote.
  }
  return agent.state(threadId);
}

test('a crash while the agent waits for its helper repeats neither one’s finished steps', async () => {
  const store = new MemoryGraphCheckpointer();
  const counters = fresh();
  let mainWaiting = () => {};
  let helperWaiting = () => {};
  const bothWaiting = Promise.all([
    new Promise<void>((resolve) => {
      mainWaiting = resolve;
    }),
    new Promise<void>((resolve) => {
      helperWaiting = resolve;
    }),
  ]);
  const first = processOn(store);
  const agent = agentOn(first.checkpointer, counters, {
    main: () => {
      mainWaiting();
      return never();
    },
    helper: () => {
      helperWaiting();
      return never();
    },
  });
  void agent.invoke(agentInput('What is the answer?'), { threadId: 'waiting' }).catch(() => undefined);
  // The agent has written its note and the helper has looked the answer up; both are mid-call.
  await bothWaiting;
  first.die();

  const final = await recover(store, counters, 'waiting');
  assert.equal(final?.status, 'completed');
  assert.equal(final?.state.answer, "The researcher helper's answer: Found it: the answer is 42");
  assert.equal(counters.lookups, 1, "the helper's finished lookup was not repeated");
  assert.equal(counters.notes, 1, "the agent's finished note was not repeated");
  assert.equal(counters.helperStarts, 1, 'the helper was carried on, not started again');
});

test('a crash before the agent saves the call that started its helper finds the same helper again', async () => {
  const store = new MemoryGraphCheckpointer();
  const counters = fresh();
  let helperLookedUp = () => {};
  const lookedUp = new Promise<void>((resolve) => {
    helperLookedUp = resolve;
  });
  // The process dies writing the step in which the agent called delegate, once the helper has
  // already looked the answer up: the helper is ahead of the agent's own record of starting it.
  const first = processOn(store, {
    stored: (checkpoint) => {
      if (checkpoint.threadId.includes('/helper/') && checkpoint.step === 2) helperLookedUp();
    },
    crash: async (checkpoint) => {
      if (checkpoint.threadId !== 'ahead' || checkpoint.step !== 2) return false;
      await lookedUp;
      return true;
    },
  });
  const agent = agentOn(first.checkpointer, counters, { helper: never });
  await assert.rejects(agent.invoke(agentInput('What is the answer?'), { threadId: 'ahead' }), /the process died/);

  const final = await recover(store, counters, 'ahead');
  assert.equal(final?.state.answer, "The researcher helper's answer: Found it: the answer is 42");
  assert.equal(counters.lookups, 1, 'the repeated delegate call carried the same helper on');
  assert.equal(counters.helperStarts, 1);
  assert.equal(counters.notes, 1);
});
