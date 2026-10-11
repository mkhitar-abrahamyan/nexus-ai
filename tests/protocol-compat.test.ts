/**
 * The previous minor on the other side of the wire: a 2.5 client against this release's server, and
 * this release's client against a 2.5 server, on the server's HTTP API and on A2A. AG-UI and ACP have
 * no client in the package, so one harness, written against the protocols themselves, drives both
 * releases' servers. The 2.5 package is installed as `nexus-ai-pro-2-5`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as previousAgent from 'nexus-ai-pro-2-5/agent';
import * as previousGraph from 'nexus-ai-pro-2-5/graph';
import * as previousA2a from 'nexus-ai-pro-2-5/protocols/a2a';
import * as previousAcp from 'nexus-ai-pro-2-5/protocols/acp';
import * as previousAgUi from 'nexus-ai-pro-2-5/protocols/ag-ui';
import * as previousServer from 'nexus-ai-pro-2-5/server';
import * as previousRemote from 'nexus-ai-pro-2-5/server/remote';
import * as currentAgent from '../src/agent/index.js';
import * as currentGraph from '../src/graph/index.js';
import * as currentA2a from '../src/protocols/a2a.js';
import * as currentAcp from '../src/protocols/acp.js';
import * as currentAgUi from '../src/protocols/ag-ui.js';
import * as currentRemote from '../src/server/remote.js';
import * as currentServer from '../src/server/server.js';
import { graphAssistant } from '../src/server/assistant.js';

type Release = {
  name: string;
  agent: typeof currentAgent;
  graph: typeof currentGraph;
  a2a: typeof currentA2a;
  acp: typeof currentAcp;
  agUi: typeof currentAgUi;
  server: { createAgentServer: typeof currentServer.createAgentServer; graphAssistant: typeof graphAssistant };
  remote: typeof currentRemote;
};

const current: Release = {
  name: '2.6',
  agent: currentAgent,
  graph: currentGraph,
  a2a: currentA2a,
  acp: currentAcp,
  agUi: currentAgUi,
  server: { createAgentServer: currentServer.createAgentServer, graphAssistant },
  remote: currentRemote,
};
const previous = {
  name: '2.5',
  agent: previousAgent,
  graph: previousGraph,
  a2a: previousA2a,
  acp: previousAcp,
  agUi: previousAgUi,
  server: previousServer,
  remote: previousRemote,
} as unknown as Release;

/** A model that sends one email, then reports what the tool said. */
function mailer() {
  return {
    async complete(request: { messages: Array<{ role: string; content: unknown }> }) {
      const last = request.messages.at(-1);
      if (last?.role !== 'tool') {
        return {
          content: '',
          role: 'assistant',
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: `call-${request.messages.length}`,
              type: 'function',
              function: { name: 'send_email', arguments: '{"to":"ana"}' },
            },
          ],
          meta: {},
        };
      }
      return { content: `Sent: ${String(last.content)}`, role: 'assistant', finishReason: 'stop', meta: {} };
    },
  };
}

/** The same agent, built by a release: it sends an email after a person approves. */
function agentOf(release: Release) {
  return release.agent.createAgent({
    client: mailer() as never,
    model: 'mock',
    tools: [
      release.agent.tool({
        name: 'send_email',
        description: 'Sends an email',
        parameters: { type: 'object' },
        execute: async () => 'delivered',
      }),
    ],
    interruptOn: { send_email: true },
  });
}

/** A graph that asks a question, built by a release. */
function askingGraph(release: Release) {
  const { createGraph, appendList, END } = release.graph as unknown as {
    createGraph: typeof currentGraph.createGraph;
    appendList: typeof currentGraph.appendList;
    END: typeof currentGraph.END;
  };
  return createGraph({ channels: { log: appendList<string>() } })
    .addNode('ask', async (context) => {
      const answer = context.interrupt<string>({ reason: 'Proceed?' });
      return { log: [`answered:${answer}`] };
    })
    .setEntry('ask')
    .addEdge('ask', END)
    .compile({ checkpointer: new release.graph.MemoryGraphCheckpointer() });
}

const pairs: Array<[Release, Release]> = [
  [previous, current],
  [current, previous],
];

test('the server’s HTTP API: each release’s remote graph runs, streams, and resumes on the other’s server', async () => {
  for (const [client, server] of pairs) {
    const label = `${client.name} client, ${server.name} server`;
    const app = server.server.createAgentServer({
      assistants: {
        ask: server.server.graphAssistant(askingGraph(server) as never),
        mail: server.server.graphAssistant(agentOf(server) as never),
      },
    });
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) =>
      app.handle(new Request(input, init))) as typeof fetch;
    const remote = client.remote.createRemoteGraph({ url: 'http://server.test', assistant: 'ask', fetch: fetcher });
    const thread = await remote.createThread();
    const paused = await remote.invoke({}, { threadId: thread.id });
    assert.equal(paused.status, 'awaiting_input', label);
    const answered = await remote.resume(thread.id, 'yes');
    assert.equal(answered.status, 'succeeded', label);
    assert.deepEqual(((await remote.state(thread.id)) as { log: string[] }).log, ['answered:yes'], label);

    const streamed: Array<{ type: string; data: unknown }> = [];
    const mail = client.remote.createRemoteGraph({ url: 'http://server.test', assistant: 'mail', fetch: fetcher });
    for await (const event of mail.stream({ messages: [{ role: 'user', content: 'Email Ana' }] })) {
      streamed.push(event as never);
    }
    assert.equal((streamed.at(-1)?.data as { status?: string } | undefined)?.status, 'awaiting_input', label);
  }
});

test('A2A: each release’s client sends, streams, reads, and answers tasks on the other’s agent', async () => {
  for (const [client, server] of pairs) {
    const label = `${client.name} client, ${server.name} agent`;
    const card = {
      name: 'Mailer',
      description: 'Sends mail',
      version: '1.0.0',
      url: 'http://agent.test/a2a',
      skills: [],
    };
    const handler = server.a2a.a2aHandler(agentOf(server) as never, { card });
    const a2a = client.a2a.a2aClient({
      url: card.url,
      fetch: async (input, init) => handler(new Request(input, init)),
    });
    assert.equal((await a2a.card()).name, 'Mailer', label);
    const paused = await a2a.send('Email Ana');
    assert.equal(paused.status.state, 'TASK_STATE_INPUT_REQUIRED', label);
    const done = await a2a.send('yes', { taskId: paused.id });
    assert.equal(done.status.state, 'TASK_STATE_COMPLETED', label);
    assert.equal(done.artifacts?.[0]?.parts[0]?.text, 'Sent: "delivered"', label);
    assert.equal((await a2a.getTask(paused.id)).status.state, 'TASK_STATE_COMPLETED', label);

    const states: string[] = [];
    for await (const event of a2a.stream('Email Rui')) {
      if ('statusUpdate' in event) states.push(event.statusUpdate.status.state);
    }
    assert.equal(states.at(-1), 'TASK_STATE_INPUT_REQUIRED', label);
  }
  // A 2.6 client asking a 2.5 agent for what 2.6 added gets a clean protocol error.
  const handler = previous.a2a.a2aHandler(agentOf(previous) as never, {
    card: { name: 'Old', description: 'Old', version: '1.0.0', url: 'http://old.test/a2a', skills: [] },
  });
  const newer = current.a2a.a2aClient({
    url: 'http://old.test/a2a',
    fetch: async (input, init) => handler(new Request(input, init)),
  });
  await assert.rejects(newer.listTasks(), (error: { code?: number }) => error.code === -32601);
});

/** Reads an AG-UI run as a frontend does, whichever release serves it. */
async function agUiRun(handler: (request: Request) => Promise<Response>, body: unknown) {
  const response = await handler(
    new Request('http://ui.test/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const text = await response.text();
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data:'))
    .map((frame) => JSON.parse(frame.slice(5)) as Record<string, unknown>);
}

test('AG-UI: one frontend harness pauses and resumes a run on each release', async () => {
  for (const release of [previous, current]) {
    const handler = release.agUi.agUiHandler(agentOf(release) as never);
    const first = await agUiRun(handler, {
      threadId: `t-${release.name}`,
      runId: 'r1',
      messages: [{ id: 'm1', role: 'user', content: 'Email Ana' }],
    });
    assert.equal(first[0]?.type, 'RUN_STARTED', release.name);
    const finished = first.at(-1) as { type: string; outcome: { type: string; interrupts: Array<{ id: string }> } };
    assert.equal(finished.type, 'RUN_FINISHED', release.name);
    assert.equal(finished.outcome.type, 'interrupt', release.name);
    const second = await agUiRun(handler, {
      threadId: `t-${release.name}`,
      runId: 'r2',
      messages: [],
      resume: [{ interruptId: finished.outcome.interrupts[0]?.id, status: 'resolved' }],
    });
    assert.equal((second.at(-1) as { result?: string }).result, 'Sent: "delivered"', release.name);
    assert.ok(
      second.some((event) => event.type === 'TOOL_CALL_RESULT'),
      release.name,
    );
  }
});

/** A JSON-RPC message, loosely: the harness reads the fields it expects. */
// biome-ignore lint/suspicious/noExplicitAny: the other side of the wire has no types to borrow.
type Wire = Record<string, any>;

/** Drives an ACP agent from an editor that speaks only the protocol. */
async function acpTurn(serveAcp: typeof currentAcp.serveAcp, graph: unknown) {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  async function* input(): AsyncIterable<string> {
    while (true) {
      if (queue.length) {
        yield queue.shift() as string;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const waiting = new Map<number, (message: Wire) => void>();
  const updates: Wire[] = [];
  const send = (message: unknown) => {
    queue.push(`${JSON.stringify(message)}\n`);
    wake?.();
  };
  serveAcp(graph as never, {
    input: input(),
    output: {
      write(chunk: string) {
        const message = JSON.parse(chunk) as Wire;
        if (message.method === 'session/update') updates.push(message.params.update);
        else if (message.method === 'session/request_permission') {
          send({
            jsonrpc: '2.0',
            id: message.id,
            result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
          });
        } else waiting.get(message.id)?.(message);
      },
    },
  });
  let ids = 0;
  const request = (method: string, params: unknown) =>
    new Promise<Wire>((resolve) => {
      const id = ++ids;
      waiting.set(id, resolve);
      send({ jsonrpc: '2.0', id, method, params });
    });
  await request('initialize', { protocolVersion: 1 });
  const { result } = await request('session/new', { cwd: '/repo', mcpServers: [] });
  const turn = await request('session/prompt', {
    sessionId: result.sessionId,
    prompt: [{ type: 'text', text: 'Email Ana' }],
  });
  const reload = await request('session/load', { sessionId: result.sessionId, cwd: '/repo', mcpServers: [] });
  ended = true;
  wake?.();
  return { stopReason: turn.result.stopReason as string, updates, reload };
}

test('ACP: one editor harness runs an approved turn on each release, and only 2.6 reloads a session', async () => {
  for (const release of [previous, current]) {
    const { stopReason, updates, reload } = await acpTurn(release.acp.serveAcp, agentOf(release));
    assert.equal(stopReason, 'end_turn', release.name);
    assert.ok(
      updates.some((update) => update.sessionUpdate === 'tool_call'),
      release.name,
    );
    assert.equal(
      (
        [...updates].reverse().find((update: Wire) => update.sessionUpdate === 'agent_message_chunk')?.content as
          | { text?: string }
          | undefined
      )?.text,
      'Sent: "delivered"',
      release.name,
    );
    if (release === current) assert.equal(reload.result, null, 'a 2.6 agent reloads a session');
    else assert.equal(reload.error?.code, -32601, 'a 2.5 agent says it does not reload, as a protocol error');
  }
});
