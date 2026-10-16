/**
 * Remote helpers, proved against two replicas of a real agent server sharing their stores: a deep
 * agent hands research to a helper on that server in the background and moves on; the agent's process
 * dies, and so does the server worker running the helper. Another worker takes the helper's run over
 * when its lease lapses, and the agent, resumed in a new process, collects that same run: one run, its
 * answer, and the agent's finished steps not repeated. A helper whose start never reached the server
 * is started by the process that collects it, once.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentInput } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { createDeepAgent, type DeepRemoteHelper } from '../src/deep-agent/index.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import { functionAssistant } from '../src/server/assistant.js';
import { MemoryRunEventLog } from '../src/server/events.js';
import { createRemoteGraph } from '../src/server/remote.js';
import { type AgentServer, createAgentServer } from '../src/server/server.js';
import { fromStore } from '../src/server/state.js';
import { MemoryStore } from '../src/store/memory.js';
import type { GraphCheckpointer } from '../src/types/graph.js';
import type { CompletionRequest, Message } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import type { ServerAssistant } from '../src/types/server.js';

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

/** What ran, across every process and every server worker. */
interface Counters {
  notes: number;
  runs: string[];
  attempts: number;
  inputs: unknown[];
}

/**
 * The agent's model: delegate the research to the background, write a note, then collect the answer.
 * `waitBeforeCollect` holds the model call that asks to collect, as a process that dies would.
 */
function agentOn(
  checkpointer: GraphCheckpointer,
  remote: DeepRemoteHelper,
  counters: Counters,
  waitBeforeCollect?: () => Promise<void>,
) {
  const note = tool<{ text: string }>({
    name: 'note',
    description: 'Writes a note',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    capabilities: [],
    execute: () => {
      counters.notes += 1;
      return 'noted';
    },
  });
  const model = {
    complete: async (request: CompletionRequest): Promise<NexusResponse> => {
      const results = request.messages.filter((message) => message.role === 'tool');
      const calls = request.messages.flatMap((message) => message.toolCalls ?? []);
      const resultOf = (name: string) =>
        text(results.find((message) => message.toolCallId === calls.find((made) => made.function.name === name)?.id));
      if (results.length === 0) {
        return reply({
          toolCalls: [call('delegate', { agent: 'researcher', task: 'Find the answer', background: true })],
        });
      }
      if (!calls.some((made) => made.function.name === 'note')) {
        return reply({ toolCalls: [call('note', { text: 'moved on while the research runs' })] });
      }
      if (!calls.some((made) => made.function.name === 'collect_helper')) {
        await waitBeforeCollect?.();
        const task = /task (\S+)\./.exec(JSON.parse(resultOf('delegate')) as string)?.[1];
        return reply({ toolCalls: [call('collect_helper', { task, wait_seconds: 30 })] });
      }
      return reply({ content: JSON.parse(resultOf('collect_helper')) as string });
    },
  };
  return createDeepAgent({
    client: model,
    planning: false,
    tools: [note],
    permissions: false,
    checkpointer,
    subagents: [
      { name: 'researcher', description: 'Researches a question', instructions: 'You research questions.', remote },
    ],
  });
}

/**
 * Two replicas of the agent server on shared stores. The first one's researcher starts, then hangs,
 * as a worker that dies would; the second's answers.
 */
function replicas(counters: Counters) {
  const state = fromStore(new MemoryStore());
  const operations = new MemoryOperationStore();
  const events = new MemoryRunEventLog();
  let started = () => {};
  const researching = new Promise<void>((resolve) => {
    started = resolve;
  });
  const hangs: ServerAssistant = {
    async *stream(input, context) {
      counters.attempts += 1;
      counters.runs.push(context.runId);
      counters.inputs.push(input);
      yield { type: 'step', step: 1, status: 'running', state: { step: 1 } };
      started();
      await never();
    },
  };
  const first = createAgentServer({
    assistants: { researcher: hangs },
    state,
    events,
    operations: { store: operations, leaseMs: 40, heartbeatMs: 20, retry: { maxAttempts: 2 } },
  });
  const second = createAgentServer({
    assistants: {
      researcher: functionAssistant((input, context) => {
        counters.attempts += 1;
        counters.runs.push(context.runId);
        counters.inputs.push(input);
        return { answer: 'Found it: the answer is 42' };
      }),
    },
    state,
    events,
    operations: { store: operations, leaseMs: 1_000, retry: { maxAttempts: 2 } },
  });
  /** The first replica's worker stops: the lease on the run it holds lapses and is never renewed. */
  const killFirst = async (runId: string) => {
    const held = await operations.read(runId);
    assert.ok(held, 'the run is in the shared store');
    await operations.update(
      {
        ...held,
        sequence: held.sequence + 1,
        lease: { owner: 'dead-worker', expiresAt: new Date(Date.now() - 60_000).toISOString() },
      },
      held.sequence,
    );
  };
  return { first, second, researching, killFirst };
}

/** The server, as a deep agent reaches it: through `createRemoteGraph()`. */
const remoteOn = (server: AgentServer, down = false): DeepRemoteHelper =>
  createRemoteGraph({
    url: 'http://agents.test',
    assistant: 'researcher',
    pollIntervalMs: 5,
    fetch: (async (url: string, init?: RequestInit) => {
      if (down) throw new Error('connect ECONNREFUSED');
      return server.handle(new Request(url, init));
    }) as typeof fetch,
  });

const fresh = (): Counters => ({ notes: 0, runs: [], attempts: 0, inputs: [] });

test('proof: a remote helper whose worker dies is taken over, and a resumed agent collects the same run', async () => {
  const counters = fresh();
  const checkpoints = new MemoryGraphCheckpointer();
  const server = replicas(counters);
  let atCollect = () => {};
  const waiting = new Promise<void>((resolve) => {
    atCollect = resolve;
  });

  // The agent delegates in the background, writes its note, and dies as it asks to collect.
  const dying = agentOn(checkpoints, remoteOn(server.first), counters, () => {
    atCollect();
    return never();
  });
  void dying.invoke(agentInput('What is the answer?'), { threadId: 'remote' }).catch(() => undefined);
  await Promise.all([waiting, server.researching]);
  assert.equal(counters.notes, 1);
  const [runId] = counters.runs;

  // The worker running the helper dies too; another replica takes its run over when the lease lapses.
  await server.killFirst(runId as string);
  assert.deepEqual(await server.second.runs.recover(), [runId], 'the second replica took the run over');

  // The agent, resumed in a new process, collects the helper by the call that started it.
  const resumed = agentOn(checkpoints, remoteOn(server.second), counters);
  for await (const _ of resumed.continue('remote')) {
    // Runs on from the last checkpoint the dead process wrote.
  }
  const final = await resumed.state('remote');
  assert.equal(final?.status, 'completed');
  assert.equal(final?.state.answer, "The researcher helper's answer: Found it: the answer is 42");
  assert.deepEqual(new Set(counters.runs), new Set([runId]), 'one run, carried on by the second worker');
  assert.equal(counters.attempts, 2, 'its first attempt, and the one that took it over');
  assert.equal(counters.notes, 1, "the agent's finished note was not repeated");
  assert.equal(
    text((counters.inputs[0] as { messages: Message[] }).messages[0]),
    'You research questions.\n\nFind the answer',
    'the helper is sent its brief and the task',
  );
});

test('a remote helper whose start never reached the server is started, once, by the process that collects it', async () => {
  const counters = fresh();
  const checkpoints = new MemoryGraphCheckpointer();
  const server = replicas(counters);
  let atCollect = () => {};
  const waiting = new Promise<void>((resolve) => {
    atCollect = resolve;
  });
  // The server is unreachable as the agent delegates: the helper's run never starts.
  const dying = agentOn(checkpoints, remoteOn(server.second, true), counters, () => {
    atCollect();
    return never();
  });
  void dying.invoke(agentInput('What is the answer?'), { threadId: 'unreached' }).catch(() => undefined);
  await waiting;
  assert.equal(counters.attempts, 0, 'nothing reached the server');

  const resumed = agentOn(checkpoints, remoteOn(server.second), counters);
  for await (const _ of resumed.continue('unreached')) {
    // Collecting the task starts the run its marker describes.
  }
  assert.equal(
    (await resumed.state('unreached'))?.state.answer,
    "The researcher helper's answer: Found it: the answer is 42",
  );
  assert.equal(counters.attempts, 1);

  assert.equal(
    text((counters.inputs[0] as { messages: Message[] }).messages[0]),
    'You research questions.\n\nFind the answer',
    'started with the task its marker kept',
  );
  // Asked again under the helper's key, from anywhere, the server answers with that run, not another.
  const helperThread = (await checkpoints.threadIds()).find((id) => id.startsWith('unreached/helper/'));
  assert.ok(helperThread, 'the task was marked on its own thread before delegate returned');
  const again = await remoteOn(server.second).invoke(agentInput('anything'), { idempotencyKey: helperThread });
  assert.equal(again.runId, counters.runs[0]);
  assert.equal(counters.attempts, 1, 'and nothing ran again');
});

test('a remote helper the agent waits for answers in the call, and its failure is the call’s', async () => {
  const outcomes: Array<{ status: string; output?: unknown; error?: { message: string } }> = [
    { status: 'succeeded', output: { messages: [{ role: 'assistant', content: 'Paris' }] } },
    { status: 'failed', error: { message: 'the research budget ran out' } },
  ];
  const keys: string[] = [];
  const remote: DeepRemoteHelper = {
    invoke: async (_input, options) => {
      keys.push(options.idempotencyKey);
      return { runId: `run-${keys.length}`, ...(outcomes.shift() as { status: string }) };
    },
  };
  const answers: string[] = [];
  const model = {
    complete: async (request: CompletionRequest): Promise<NexusResponse> => {
      const results = request.messages.filter((message) => message.role === 'tool');
      if (results.length < 2) {
        return reply({ toolCalls: [call('delegate', { agent: 'researcher', task: 'Capital of France?' })] });
      }
      for (const result of results) answers.push(text(result));
      return reply({ content: 'done' });
    },
  };
  const agent = createDeepAgent({
    client: model,
    planning: false,
    permissions: false,
    subagents: [{ name: 'researcher', description: 'Researches', instructions: 'You research.', remote }],
  });
  await agent.invoke(agentInput('Ask twice'), { threadId: 'foreground' });
  assert.equal(JSON.parse(answers[0] as string), 'Paris', 'the run’s last message is the answer');
  assert.match(answers[1] as string, /the research budget ran out/);
  assert.match(keys[0] as string, /^foreground\/helper\/researcher@call-\d+$/, 'keyed by the call that started it');
});
