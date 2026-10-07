/**
 * The agent protocols, each proven from the other side of the wire with no Nexus client code:
 * - AG-UI rendered by a plain `fetch` and Server-Sent Events parser;
 * - A2A both ways: a raw JSON-RPC client against the served agent, and the client and tool against
 *   a stub that answers as the specification does;
 * - ACP driven as an editor drives it, line by line, approvals included.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentInput, createAgent } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { A2A_PROTOCOL_VERSION, A2aError, a2aClient, a2aHandler, a2aTool } from '../src/protocols/a2a.js';
import { ACP_PROTOCOL_VERSION, type AcpSessionUpdate, serveAcp } from '../src/protocols/acp.js';
import { agUiEvents, agUiHandler, agUiMessages, encodeAgUiEvent } from '../src/protocols/ag-ui.js';
import { approvalOf, transcriptOf } from '../src/protocols/shared.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse, StreamChunk } from '../src/types/response.js';

/**
 * JSON from the wire, read as a client written from a specification reads it: untyped, with no
 * Nexus types on that side.
 */
// biome-ignore lint/suspicious/noExplicitAny: the other side of the wire has no types to borrow.
type Wire = any;

const meta = (index: number) => ({
  provider: 'mock',
  model: 'mock',
  requestId: `r-${index}`,
  latencyMs: 1,
  timestamp: new Date().toISOString(),
});

/** A model that answers from a script, recording every request. */
function scriptedClient(responses: Array<Partial<NexusResponse>>) {
  const requests: CompletionRequest[] = [];
  let index = 0;
  const client = {
    complete: async (request: CompletionRequest): Promise<NexusResponse> => {
      requests.push(request);
      const scripted = responses[Math.min(index, responses.length - 1)] ?? {};
      index += 1;
      return { content: '', model: 'mock', provider: 'mock', meta: meta(index), ...scripted } as NexusResponse;
    },
  };
  return { client, requests };
}

/** A model that streams: a tool call first, then its answer word by word. */
function streamingClient() {
  let turns = 0;
  const done = { type: 'done', meta: meta(0) } as StreamChunk;
  return {
    complete: async () =>
      ({ content: 'unused', model: 'mock', provider: 'mock', meta: meta(0) }) as unknown as NexusResponse,
    async *stream(): AsyncIterable<StreamChunk> {
      turns += 1;
      if (turns === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'c1', type: 'function', function: { name: 'weather', arguments: '{"city":"Yerevan"}' } },
        } as StreamChunk;
        yield done;
        return;
      }
      for (const word of ['It ', 'is ', 'sunny.']) yield { type: 'text', content: word } as StreamChunk;
      yield done;
    },
  };
}

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

const weather = tool({
  name: 'weather',
  description: 'Weather for a city',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
  capabilities: [],
  execute: async (args) => ({ city: args.city, sky: 'clear' }),
});

function emailAgent(sent: string[], responses?: Array<Partial<NexusResponse>>) {
  const scripted = scriptedClient(
    responses ?? [
      { content: '', toolCalls: [call('c1', 'send_email', { to: 'ceo@example.test' })] },
      { content: 'Sent.' },
    ],
  );
  const agent = createAgent({
    client: scripted.client,
    interruptOn: { send_email: true },
    tools: [
      tool({
        name: 'send_email',
        description: 'Sends an email',
        parameters: { type: 'object', properties: { to: { type: 'string' } } },
        execute: async (args) => {
          sent.push(String(args.to));
          return 'sent';
        },
      }),
    ],
  });
  return { agent, requests: scripted.requests };
}

/** Server-Sent Events as any browser client reads them: `data:` lines, frames split by a blank line. */
async function readSse(response: Response): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split('\n\n')
    .map((frame) =>
      frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join(''),
    )
    .filter(Boolean)
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

// ── AG-UI ───────────────────────────────────────────────────────────

/** The fields the AG-UI specification requires on each event this adapter emits. */
const AG_UI_REQUIRED: Record<string, string[]> = {
  RUN_STARTED: ['threadId', 'runId'],
  RUN_FINISHED: ['threadId', 'runId'],
  RUN_ERROR: ['message'],
  STEP_STARTED: ['stepName'],
  STEP_FINISHED: ['stepName'],
  TEXT_MESSAGE_START: ['messageId', 'role'],
  TEXT_MESSAGE_CONTENT: ['messageId', 'delta'],
  TEXT_MESSAGE_END: ['messageId'],
  TOOL_CALL_START: ['toolCallId', 'toolCallName'],
  TOOL_CALL_ARGS: ['toolCallId', 'delta'],
  TOOL_CALL_END: ['toolCallId'],
  TOOL_CALL_RESULT: ['messageId', 'toolCallId', 'content'],
  STATE_SNAPSHOT: ['snapshot'],
};

function assertAgUiShapes(events: Array<Record<string, unknown>>) {
  for (const event of events) {
    const required = AG_UI_REQUIRED[String(event.type)];
    assert.ok(required, `${String(event.type)} is an AG-UI event type`);
    for (const field of required) assert.ok(field in event, `${String(event.type)} carries ${field}`);
    assert.equal(typeof event.timestamp, 'number');
  }
}

/** What a minimal AG-UI frontend renders from the events: the transcript, tool calls included. */
function render(events: Array<Record<string, unknown>>) {
  const messages = new Map<string, string>();
  const tools = new Map<string, { name: string; args: string; result?: string }>();
  for (const event of events) {
    if (event.type === 'TEXT_MESSAGE_START') messages.set(String(event.messageId), '');
    if (event.type === 'TEXT_MESSAGE_CONTENT') {
      const id = String(event.messageId);
      assert.ok(messages.has(id), 'content follows its start');
      messages.set(id, `${messages.get(id)}${String(event.delta)}`);
    }
    if (event.type === 'TOOL_CALL_START')
      tools.set(String(event.toolCallId), { name: String(event.toolCallName), args: '' });
    if (event.type === 'TOOL_CALL_ARGS') {
      const entry = tools.get(String(event.toolCallId));
      assert.ok(entry, 'arguments follow their start');
      entry.args += String(event.delta);
    }
    if (event.type === 'TOOL_CALL_RESULT') {
      const entry = tools.get(String(event.toolCallId));
      assert.ok(entry, 'a result follows its call');
      entry.result = String(event.content);
    }
  }
  return { messages: [...messages.values()], tools: [...tools.values()] };
}

test('AG-UI: a plain fetch and SSE parser renders a streaming agent run with its tool call', async () => {
  const agent = createAgent({ client: streamingClient(), streamTokens: true, tools: [weather] });
  const handler = agUiHandler(agent);
  const response = await handler(
    new Request('http://localhost/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        threadId: 'thread-1',
        runId: 'run-1',
        messages: [{ id: 'm1', role: 'user', content: 'Weather in Yerevan?' }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      }),
    }),
  );
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const events = await readSse(response);
  assertAgUiShapes(events);

  assert.equal(events[0]?.type, 'RUN_STARTED');
  assert.equal(events[0]?.threadId, 'thread-1');
  const last = events.at(-1) as Record<string, unknown>;
  assert.equal(last.type, 'RUN_FINISHED');
  assert.deepEqual(last.outcome, { type: 'success' });
  assert.equal(last.result, 'It is sunny.');
  assert.ok(events.some((event) => event.type === 'STEP_STARTED' && event.stepName === 'model'));

  const view = render(events);
  assert.deepEqual(view.messages, ['It is sunny.']);
  assert.equal(view.tools.length, 1);
  assert.equal(view.tools[0]?.name, 'weather');
  assert.deepEqual(JSON.parse(view.tools[0]?.args ?? ''), { city: 'Yerevan' });
  assert.deepEqual(JSON.parse(view.tools[0]?.result ?? ''), { city: 'Yerevan', sky: 'clear' });

  // Every text message that starts also ends, and the snapshot comes before the run finishes.
  const starts = events.filter((event) => event.type === 'TEXT_MESSAGE_START').length;
  assert.equal(events.filter((event) => event.type === 'TEXT_MESSAGE_END').length, starts);
  assert.equal(events.at(-2)?.type, 'STATE_SNAPSHOT');
});

test('AG-UI: a run that needs approval finishes with an interrupt, and a resume entry continues it', async () => {
  const sent: string[] = [];
  const { agent } = emailAgent(sent);
  const handler = agUiHandler(agent);
  const post = (body: unknown) =>
    handler(new Request('http://localhost/agent', { method: 'POST', body: JSON.stringify(body) })).then(readSse);

  const paused = await post({
    threadId: 'mail',
    runId: 'r1',
    messages: [{ id: 'm1', role: 'user', content: 'Email the ceo' }],
  });
  assertAgUiShapes(paused);
  const finished = paused.at(-1) as { outcome: { type: string; interrupts: Array<Record<string, unknown>> } };
  assert.equal(finished.outcome.type, 'interrupt');
  const [interrupt] = finished.outcome.interrupts;
  assert.equal(interrupt?.reason, 'tool_call');
  assert.equal(interrupt?.toolCallId, 'c1');
  assert.equal(typeof interrupt?.id, 'string');
  assert.deepEqual(sent, [], 'nothing is sent while the person decides');

  const resumed = await post({
    threadId: 'mail',
    runId: 'r2',
    parentRunId: 'r1',
    messages: [],
    resume: [{ interruptId: interrupt?.id, status: 'resolved' }],
  });
  assertAgUiShapes(resumed);
  assert.equal(resumed[0]?.parentRunId, 'r1');
  assert.deepEqual((resumed.at(-1) as { outcome: unknown }).outcome, { type: 'success' });
  assert.deepEqual(sent, ['ceo@example.test']);
  assert.ok(resumed.some((event) => event.type === 'TOOL_CALL_RESULT' && event.content === 'sent'));
});

test('AG-UI: a cancelled interrupt refuses the call, failures end in RUN_ERROR, and bad requests are refused', async () => {
  const sent: string[] = [];
  const { agent } = emailAgent(sent);
  const run = { threadId: 'refuse', runId: 'r1', messages: [{ id: 'm1', role: 'user', content: 'Email the ceo' }] };
  const paused: Array<Record<string, unknown>> = [];
  for await (const event of agUiEvents(agent, run)) paused.push(event);
  const id = (paused.at(-1) as { outcome: { interrupts: Array<{ id: string }> } }).outcome.interrupts[0]?.id as string;
  for await (const _ of agUiEvents(agent, {
    ...run,
    runId: 'r2',
    resume: [{ interruptId: id, status: 'cancelled' }],
  })) {
    // drained
  }
  assert.deepEqual(sent, [], 'a cancelled approval runs nothing');

  const failing = {
    invoke: async () => {
      throw Object.assign(new Error('model unavailable'), { code: 'PROVIDER_DOWN' });
    },
    resumeInterruptsWith: async () => {
      throw new Error('unused');
    },
  };
  const failed: Array<Record<string, unknown>> = [];
  for await (const event of agUiEvents(failing, run, { stateSnapshot: false })) failed.push(event);
  assert.deepEqual(
    failed.map((event) => event.type),
    ['RUN_STARTED', 'RUN_ERROR'],
  );
  assert.equal(failed[1]?.message, 'model unavailable');
  assert.equal(failed[1]?.code, 'PROVIDER_DOWN');

  const handler = agUiHandler(agent);
  assert.equal((await handler(new Request('http://localhost/agent'))).status, 405);
  assert.equal((await handler(new Request('http://localhost/agent', { method: 'POST', body: 'nope' }))).status, 400);
  assert.equal(
    (await handler(new Request('http://localhost/agent', { method: 'POST', body: JSON.stringify({ messages: [] }) })))
      .status,
    400,
  );
  assert.equal(encodeAgUiEvent({ type: 'RUN_STARTED' }), 'data: {"type":"RUN_STARTED"}\n\n');
});

test('AG-UI: messages convert to the conversation an agent takes, and the caller is resolved per request', async () => {
  assert.deepEqual(
    agUiMessages([
      { id: '1', role: 'developer', content: 'Be brief.' },
      { id: '2', role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      { id: '3', role: 'assistant', content: '', toolCalls: [call('t1', 'weather', {})] },
      { id: '4', role: 'tool', content: '{"sky":"clear"}', toolCallId: 't1' },
      { id: '5', role: 'activity', content: 'ignored' },
    ]).map((message) => [message.role, message.content, message.toolCallId ?? null, message.toolCalls?.length ?? 0]),
    [
      ['system', 'Be brief.', null, 0],
      ['user', 'Hi', null, 0],
      ['assistant', '', null, 1],
      ['tool', '{"sky":"clear"}', 't1', 0],
    ],
  );

  const seen: unknown[] = [];
  const graph = {
    invoke: async (input: unknown, options?: { principal?: unknown; threadId?: string }) => {
      seen.push(options?.principal, input);
      return { threadId: options?.threadId ?? '', status: 'completed', state: { answer: 'ok' } };
    },
    resumeInterruptsWith: async () => ({ threadId: '', status: 'completed', state: {} }),
  };
  const handler = agUiHandler(graph, {
    principal: (request) => ({ userId: request.headers.get('x-user') ?? 'anonymous' }),
    input: (run, messages) => ({ messages, tools: run.tools?.length ?? 0 }),
  });
  await handler(
    new Request('http://localhost/agent', {
      method: 'POST',
      headers: { 'x-user': 'ada' },
      body: JSON.stringify({ threadId: 't', messages: [{ id: '1', role: 'user', content: 'Hi' }], tools: [] }),
    }),
  ).then(readSse);
  assert.deepEqual(seen[0], { userId: 'ada' });
  assert.deepEqual(seen[1], { messages: [{ role: 'user', content: 'Hi' }], tools: 0 });
});

// ── A2A ─────────────────────────────────────────────────────────────

const CARD = {
  name: 'Weather agent',
  description: 'Answers questions about the weather',
  version: '1.0.0',
  url: 'https://agents.example.test/a2a',
  skills: [{ id: 'weather', name: 'Weather', description: 'Current weather by city', tags: ['weather'] }],
};

/** JSON-RPC as any A2A client writes it, with no Nexus code on this side. */
function rawRpc(handler: (request: Request) => Promise<Response>, headers: Record<string, string> = {}) {
  let id = 0;
  return async (method: string, params: unknown) => {
    const response = await handler(
      new Request(CARD.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'a2a-version': '1.0', ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      }),
    );
    return (await response.json()) as {
      jsonrpc: string;
      id: number;
      result?: Wire;
      error?: { code: number; message: string };
    };
  };
}

test('A2A: a raw JSON-RPC client reads the card, sends a message, and continues the conversation by context', async () => {
  const { client, requests } = scriptedClient([{ content: 'It is sunny in Yerevan.' }, { content: 'Still sunny.' }]);
  const agent = createAgent({ client });
  const handler = a2aHandler(agent, { card: CARD });

  const card = (await (
    await handler(new Request('https://agents.example.test/.well-known/agent-card.json'))
  ).json()) as Wire;
  assert.equal(card.name, 'Weather agent');
  assert.deepEqual(card.supportedInterfaces, [{ url: CARD.url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
  assert.equal(card.capabilities.streaming, true);
  assert.deepEqual(card.skills[0].tags, ['weather']);

  const rpc = rawRpc(handler);
  const first = await rpc('SendMessage', {
    message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Weather in Yerevan?' }], contextId: 'ctx-1' },
  });
  assert.equal(first.jsonrpc, '2.0');
  assert.equal(first.id, 1);
  const task = first.result.task;
  assert.equal(task.contextId, 'ctx-1');
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(task.status.message.role, 'ROLE_AGENT');
  assert.equal(task.artifacts[0].parts[0].text, 'It is sunny in Yerevan.');

  await rpc('SendMessage', {
    message: { messageId: 'm2', role: 'ROLE_USER', parts: [{ text: 'And now?' }], contextId: 'ctx-1' },
  });
  assert.deepEqual(
    requests[1]?.messages.map((message) => [message.role, message.content]),
    [
      ['user', 'Weather in Yerevan?'],
      ['assistant', 'It is sunny in Yerevan.'],
      ['user', 'And now?'],
    ],
    'the second task sees the context so far',
  );

  const fetched = await rpc('GetTask', { id: task.id, historyLength: 5 });
  assert.equal(fetched.result.id, task.id);
  assert.equal(fetched.result.history[0].parts[0].text, 'Weather in Yerevan?');
  assert.equal(fetched.result.history.at(-1).role, 'ROLE_AGENT');
});

test('A2A: a task that needs approval asks for input, and a message naming the task answers it', async () => {
  const sent: string[] = [];
  const { agent } = emailAgent(sent, [
    { content: '', toolCalls: [call('c1', 'send_email', { to: 'ceo@example.test' })] },
    { content: 'Sent.' },
    { content: '', toolCalls: [call('c2', 'send_email', { to: 'board@example.test' })] },
    { content: 'Not sent.' },
  ]);
  const rpc = rawRpc(a2aHandler(agent, { card: CARD }));

  const paused = (
    await rpc('SendMessage', { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Email the ceo' }] } })
  ).result.task;
  assert.equal(paused.status.state, 'TASK_STATE_INPUT_REQUIRED');
  assert.match(paused.status.message.parts[0].text, /send_email/);
  assert.equal(paused.status.message.parts[1].data.interrupts[0].payload.name, 'send_email');
  assert.deepEqual(sent, []);

  const done = await rpc('SendMessage', {
    message: { messageId: 'm2', role: 'ROLE_USER', taskId: paused.id, parts: [{ data: { approved: true } }] },
  });
  assert.equal(done.result.task.status.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(sent, ['ceo@example.test']);

  // Words answer an approval too, and "no" never reads as consent.
  const second = (
    await rpc('SendMessage', { message: { messageId: 'm3', role: 'ROLE_USER', parts: [{ text: 'Email the board' }] } })
  ).result.task;
  const refused = await rpc('SendMessage', {
    message: { messageId: 'm4', role: 'ROLE_USER', taskId: second.id, parts: [{ text: 'no, not the board' }] },
  });
  assert.equal(refused.result.task.status.state, 'TASK_STATE_COMPLETED');
  assert.deepEqual(sent, ['ceo@example.test']);

  const again = await rpc('SendMessage', {
    message: { messageId: 'm5', role: 'ROLE_USER', taskId: second.id, parts: [{ text: 'yes' }] },
  });
  assert.equal(again.error?.code, -32004, 'a finished task is not waiting for input');
});

test('A2A: streaming, cancelling, and the specification’s errors', async () => {
  const agent = createAgent({ client: streamingClient(), streamTokens: true, tools: [weather] });
  const handler = a2aHandler(agent, { card: CARD });
  const streamed = await handler(
    new Request(CARD.url, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'SendStreamingMessage',
        params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Weather in Yerevan?' }] } },
      }),
    }),
  );
  assert.equal(streamed.headers.get('content-type'), 'text/event-stream');
  const events = (await readSse(streamed)) as Array<{ id: number; result: Wire }>;
  assert.ok(events.every((event) => event.id === 7));
  assert.ok(events[0]?.result.task, 'the stream opens with the task');
  const text = events
    .filter((event) => event.result.artifactUpdate)
    .map((event) => event.result.artifactUpdate.artifact.parts.map((part: { text: string }) => part.text).join(''))
    .join('');
  assert.equal(text, 'It is sunny.');
  assert.equal(events.filter((event) => event.result.artifactUpdate?.lastChunk).length, 1);
  assert.equal(events.at(-1)?.result.statusUpdate.status.state, 'TASK_STATE_COMPLETED');

  // A task still running can be cancelled; one that finished cannot.
  let release: () => void = () => {};
  const slow = {
    invoke: (_input: unknown, options?: { signal?: AbortSignal; threadId?: string }) =>
      new Promise<{ threadId: string; status: string; state: unknown }>((resolve) => {
        release = () => resolve({ threadId: options?.threadId ?? '', status: 'completed', state: { answer: 'late' } });
      }),
    resumeInterruptsWith: async () => ({ threadId: '', status: 'completed', state: {} }),
  };
  const rpc = rawRpc(a2aHandler(slow, { card: CARD }));
  const started = await rpc('SendMessage', {
    message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Take your time' }] },
    configuration: { returnImmediately: true },
  });
  assert.equal(started.result.task.status.state, 'TASK_STATE_WORKING');
  const cancelled = await rpc('CancelTask', { id: started.result.task.id });
  assert.equal(cancelled.result.status.state, 'TASK_STATE_CANCELED');
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await rpc('GetTask', { id: started.result.task.id })).result.status.state, 'TASK_STATE_CANCELED');
  assert.equal((await rpc('CancelTask', { id: started.result.task.id })).error?.code, -32002);

  assert.equal((await rpc('GetTask', { id: 'missing' })).error?.code, -32001);
  assert.equal((await rpc('ListPushNotificationConfigs', {})).error?.code, -32601);
  assert.equal((await rpc('SendMessage', { message: { messageId: 'x' } })).error?.code, -32602);
  assert.equal(
    (
      await rpc('SendMessage', {
        message: { messageId: 'x', role: 'ROLE_USER', taskId: 'missing', parts: [{ text: 'hi' }] },
      })
    ).error?.code,
    -32001,
  );
  assert.equal((await rawRpc(handler, { 'a2a-version': '2.0' })('GetTask', { id: 'x' })).error?.code, -32009);
  const notJson = await handler(new Request(CARD.url, { method: 'POST', body: '{' }));
  assert.equal(((await notJson.json()) as { error: { code: number } }).error.code, -32700);
  assert.equal((await handler(new Request(CARD.url, { method: 'DELETE' }))).status, 405);
  assert.equal((await handler(new Request('https://agents.example.test/elsewhere'))).status, 404);
});

test('A2A: the client and tool speak the specification to a stub agent written from it', async () => {
  const calls: Array<{ url: string; headers: Headers; body: Wire }> = [];
  // A stub agent, written from the specification alone: a card, and JSON-RPC answers by method.
  const stub: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/.well-known/agent-card.json')) {
      return Response.json({
        name: 'Remote',
        description: 'A remote agent',
        version: '2.0.0',
        supportedInterfaces: [
          { url: 'https://remote.example.test/rpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        ],
        capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
        skills: [],
      });
    }
    const body = JSON.parse(String(init?.body));
    calls.push({ url, headers: new Headers(init?.headers), body });
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result });
    const message = body.params?.message;
    switch (body.method) {
      case 'SendMessage':
        if (message.parts[0].text === 'Just say hi') {
          return reply({ message: { messageId: 'r1', role: 'ROLE_AGENT', parts: [{ text: 'hi' }], contextId: 'c9' } });
        }
        if (message.parts[0].text === 'Break') {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32005, message: 'Content type not supported' },
          });
        }
        return reply({
          task: {
            id: 't1',
            contextId: message.contextId ?? 'c1',
            status: {
              state: 'TASK_STATE_COMPLETED',
              message: { messageId: 'r2', role: 'ROLE_AGENT', parts: [{ text: 'Done.' }] },
            },
            artifacts: [{ artifactId: 'a1', parts: [{ text: '42' }] }],
          },
        });
      case 'SendStreamingMessage': {
        const frames = [
          { task: { id: 't2', contextId: 'c2', status: { state: 'TASK_STATE_SUBMITTED' } } },
          {
            artifactUpdate: { taskId: 't2', contextId: 'c2', artifact: { artifactId: 'a', parts: [{ text: 'for' }] } },
          },
          {
            artifactUpdate: {
              taskId: 't2',
              contextId: 'c2',
              artifact: { artifactId: 'a', parts: [{ text: 'ty-two' }] },
              append: true,
            },
          },
          { statusUpdate: { taskId: 't2', contextId: 'c2', status: { state: 'TASK_STATE_COMPLETED' } } },
        ];
        const text = frames
          .map((result) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`)
          .join('');
        // Split mid-frame, as a network does.
        const bytes = new TextEncoder().encode(text);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, 37));
              controller.enqueue(bytes.slice(37));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      case 'GetTask':
        return reply({ id: body.params.id, contextId: 'c1', status: { state: 'TASK_STATE_WORKING' } });
      case 'CancelTask':
        return reply({ id: body.params.id, contextId: 'c1', status: { state: 'TASK_STATE_CANCELED' } });
      default:
        return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
    }
  };

  const client = a2aClient({
    url: 'https://remote.example.test/.well-known/agent-card.json',
    fetch: stub,
    headers: { authorization: 'Bearer t' },
  });
  assert.equal((await client.card()).name, 'Remote');
  const task = await client.send('What is six times seven?', { contextId: 'c5', data: { units: 'none' } });
  assert.equal(task.artifacts?.[0]?.parts[0]?.text, '42');
  assert.equal(calls[0]?.url, 'https://remote.example.test/rpc', 'the card names the endpoint');
  assert.equal(calls[0]?.headers.get('a2a-version'), A2A_PROTOCOL_VERSION);
  assert.equal(calls[0]?.headers.get('authorization'), 'Bearer t');
  assert.equal(calls[0]?.body.jsonrpc, '2.0');
  assert.equal(calls[0]?.body.params.message.role, 'ROLE_USER');
  assert.equal(calls[0]?.body.params.message.contextId, 'c5');
  assert.deepEqual(calls[0]?.body.params.message.parts[1], { data: { units: 'none' } });

  const direct = await client.send('Just say hi');
  assert.equal(direct.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(direct.contextId, 'c9');
  await assert.rejects(client.send('Break'), (error: unknown) => error instanceof A2aError && error.code === -32005);

  const streamed: string[] = [];
  for await (const event of client.stream('Count')) {
    if ('artifactUpdate' in event) streamed.push(event.artifactUpdate.artifact.parts[0]?.text ?? '');
    if ('statusUpdate' in event) streamed.push(event.statusUpdate.status.state);
  }
  assert.deepEqual(streamed, ['for', 'ty-two', 'TASK_STATE_COMPLETED']);
  assert.equal((await client.getTask('t1', 3)).status.state, 'TASK_STATE_WORKING');
  assert.equal(calls.at(-1)?.body.params.historyLength, 3);
  assert.equal((await client.cancel('t1')).status.state, 'TASK_STATE_CANCELED');

  const remote = a2aTool({
    name: 'ask_remote',
    description: 'Asks the remote agent',
    url: 'https://remote.example.test/rpc',
    fetch: stub,
  });
  assert.deepEqual(remote.capabilities, ['network:remote.example.test']);
  assert.deepEqual(await remote.execute?.({ task: 'What is six times seven?' }), {
    state: 'TASK_STATE_COMPLETED',
    taskId: 't1',
    contextId: 'c1',
    answer: '42',
  });
});

test('A2A: one Nexus agent calls another through the tool, as a remote agent', async () => {
  const remoteModel = scriptedClient([{ content: 'Paris is the capital of France.' }]);
  const served = a2aHandler(createAgent({ client: remoteModel.client }), {
    card: { ...CARD, url: 'https://geo.example.test/a2a' },
  });
  const ask = a2aTool({
    name: 'ask_geographer',
    description: 'Asks the geography agent',
    url: 'https://geo.example.test/a2a',
    fetch: (input, init) => served(new Request(String(input), init)),
  });
  const local = scriptedClient([
    { content: '', toolCalls: [call('c1', 'ask_geographer', { task: 'What is the capital of France?' })] },
    { content: 'The geographer says Paris.' },
  ]);
  const agent = createAgent({ client: local.client, tools: [ask] });
  const result = await agent.invoke(agentInput('Capital of France?'));
  assert.equal(result.state.answer, 'The geographer says Paris.');
  assert.equal(remoteModel.requests[0]?.messages.at(-1)?.content, 'What is the capital of France?');
  const reply = result.state.messages.find((message) => message.role === 'tool');
  assert.match(String(reply?.content), /Paris is the capital of France/);
});

// ── ACP ─────────────────────────────────────────────────────────────

/** An editor's end of an ACP connection: it writes lines, reads lines, and answers permissions. */
function editor(graph: Parameters<typeof serveAcp>[0], decide: (params: Wire) => unknown) {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const encoder = new TextEncoder();
  async function* input(): AsyncIterable<Uint8Array> {
    while (true) {
      if (queue.length) {
        yield queue.shift() as Uint8Array;
        continue;
      }
      if (ended) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }
  const send = (message: unknown) => {
    queue.push(encoder.encode(`${JSON.stringify(message)}\n`));
    wake?.();
  };
  const updates: AcpSessionUpdate[] = [];
  const permissions: Wire[] = [];
  const replies = new Map<string | number, (message: Wire) => void>();
  const errors: Wire[] = [];
  let ids = 0;
  const server = serveAcp(
    graph,
    {
      input: input(),
      output: {
        write(chunk: string) {
          assert.ok(chunk.endsWith('\n'), 'one message per line');
          const message = JSON.parse(chunk);
          assert.equal(message.jsonrpc, '2.0');
          if (message.method === 'session/update') updates.push(message.params.update);
          else if (message.method === 'session/request_permission') {
            permissions.push(message.params);
            Promise.resolve(decide(message.params)).then((result) => send({ jsonrpc: '2.0', id: message.id, result }));
          } else if (replies.has(message.id)) {
            replies.get(message.id)?.(message);
            replies.delete(message.id);
          } else errors.push(message);
        },
      },
    },
    { agentInfo: { name: 'test-agent', version: '1.0.0' } },
  );
  return {
    updates,
    permissions,
    errors,
    request: (method: string, params: unknown) =>
      new Promise<Wire>((resolve) => {
        const id = ++ids;
        replies.set(id, resolve);
        send({ jsonrpc: '2.0', id, method, params });
      }),
    notify: (method: string, params: unknown) => send({ jsonrpc: '2.0', method, params }),
    raw: (line: string) => {
      queue.push(encoder.encode(line));
      wake?.();
    },
    close: async () => {
      ended = true;
      wake?.();
      await server.closed;
    },
  };
}

test('ACP: an editor initializes, prompts, approves an edit, and sees the plan, the diff, and the answer', async () => {
  const edits: string[] = [];
  const { client, requests } = scriptedClient([
    {
      content: '',
      toolCalls: [call('c1', 'write_todos', { todos: [{ content: 'Fix the typo', status: 'in_progress' }] })],
    },
    { content: '', toolCalls: [call('c2', 'edit_file', { path: 'README.md', old_text: 'teh', new_text: 'the' })] },
    { content: 'Fixed the typo.' },
    { content: '', toolCalls: [call('c3', 'edit_file', { path: 'README.md', old_text: 'adn', new_text: 'and' })] },
    { content: 'Fixed another.' },
  ]);
  const agent = createAgent({
    client,
    interruptOn: { edit_file: true },
    tools: [
      tool({
        name: 'write_todos',
        description: 'Records the plan',
        parameters: { type: 'object' },
        capabilities: [],
        execute: async () => 'Plan recorded',
      }),
      tool({
        name: 'edit_file',
        description: 'Edits a file',
        parameters: { type: 'object' },
        execute: async (args) => {
          edits.push(`${String(args.old_text)}->${String(args.new_text)}`);
          return 'edited';
        },
      }),
    ],
  });
  const ide = editor(agent, (params) => ({ outcome: { outcome: 'selected', optionId: params.options[1].optionId } }));

  const init = await ide.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  });
  assert.equal(init.result.protocolVersion, ACP_PROTOCOL_VERSION);
  assert.equal(init.result.agentCapabilities.promptCapabilities.embeddedContext, true);
  assert.deepEqual(init.result.agentInfo, { name: 'test-agent', version: '1.0.0' });

  const session = await ide.request('session/new', { cwd: '/work', mcpServers: [] });
  const sessionId = session.result.sessionId as string;
  assert.equal(typeof sessionId, 'string');

  const turn = await ide.request('session/prompt', {
    sessionId,
    prompt: [
      { type: 'text', text: 'Fix the typo in' },
      { type: 'resource', resource: { uri: 'file:///work/README.md', text: 'teh readme', mimeType: 'text/markdown' } },
    ],
  });
  assert.deepEqual(turn.error, undefined);
  assert.deepEqual(turn.result, { stopReason: 'end_turn' });
  assert.match(String(requests[0]?.messages[0]?.content), /file:\/\/\/work\/README\.md\n```\nteh readme\n```/);

  const plan = ide.updates.find((update) => update.sessionUpdate === 'plan') as Wire;
  assert.deepEqual(plan.entries, [{ content: 'Fix the typo', priority: 'medium', status: 'in_progress' }]);
  const edit = ide.updates.find((update) => update.sessionUpdate === 'tool_call' && update.toolCallId === 'c2') as Wire;
  assert.equal(edit.kind, 'edit');
  assert.equal(edit.title, 'edit_file README.md');
  assert.deepEqual(edit.locations, [{ path: 'README.md' }]);
  const done = ide.updates.find(
    (update) => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'c2',
  ) as Wire;
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.content[0], { type: 'diff', path: 'README.md', oldText: 'teh', newText: 'the' });
  const thinking = ide.updates.find(
    (update) => update.sessionUpdate === 'tool_call' && update.toolCallId === 'c1',
  ) as Wire;
  assert.equal(thinking.kind, 'think');
  assert.deepEqual(ide.updates.at(-1), {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Fixed the typo.' },
  });

  assert.equal(ide.permissions.length, 1);
  assert.equal(ide.permissions[0].sessionId, sessionId);
  assert.equal(ide.permissions[0].toolCall.toolCallId, 'c2');
  assert.deepEqual(
    ide.permissions[0].options.map((option: { kind: string }) => option.kind),
    ['allow_once', 'allow_always', 'reject_once', 'reject_always'],
  );
  assert.deepEqual(edits, ['teh->the']);

  // "Always allow" holds for the rest of the session, and the conversation carries over.
  const second = await ide.request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'And the other one' }],
  });
  assert.deepEqual(second.result, { stopReason: 'end_turn' });
  assert.equal(ide.permissions.length, 1, 'no second question');
  assert.deepEqual(edits, ['teh->the', 'adn->and']);
  const history = requests[3]?.messages ?? [];
  assert.ok(
    history.some((message) => message.role === 'tool' && message.toolCallId === 'c2'),
    'the transcript carries over',
  );
  assert.equal(history.at(-1)?.content, 'And the other one');

  await ide.close();
  assert.deepEqual(ide.errors, []);
});

test('ACP: rejecting runs nothing, cancelling ends the turn, and questions are asked in words', async () => {
  const sent: string[] = [];
  const { agent } = emailAgent(sent, [
    { content: '', toolCalls: [call('c1', 'send_email', { to: 'ceo@example.test' })] },
    { content: 'Not sent.' },
  ]);
  const ide = editor(agent, () => ({ outcome: { outcome: 'selected', optionId: 'reject_once' } }));
  const { result } = await ide.request('session/new', { cwd: '/', mcpServers: [] });
  const rejected = await ide.request('session/prompt', {
    sessionId: result.sessionId,
    prompt: [{ type: 'text', text: 'Email the ceo' }],
  });
  assert.equal(rejected.result.stopReason, 'end_turn');
  assert.deepEqual(sent, []);
  const failedCall = ide.updates.find((update) => update.sessionUpdate === 'tool_call_update') as Wire;
  assert.ok(failedCall, 'the refused call is reported');

  // Cancelling while the editor is still deciding ends the turn as cancelled.
  const { agent: waiting } = emailAgent(sent);
  const pending = editor(waiting, () => new Promise(() => {}));
  const opened = await pending.request('session/new', { cwd: '/', mcpServers: [] });
  const turn = pending.request('session/prompt', {
    sessionId: opened.result.sessionId,
    prompt: [{ type: 'text', text: 'Email the ceo' }],
  });
  while (pending.permissions.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  pending.notify('session/cancel', { sessionId: opened.result.sessionId });
  assert.deepEqual((await turn).result, { stopReason: 'cancelled' });
  assert.deepEqual(sent, []);

  // A question that is not an approval is the agent's message, and the next prompt answers it.
  const answers: unknown[] = [];
  const asking = {
    invoke: async (_input: unknown, options?: { threadId?: string }) => ({
      threadId: options?.threadId ?? '',
      status: 'awaiting_input',
      state: {},
      interrupts: [{ id: 'q1', reason: 'Which branch?' }],
    }),
    resumeInterruptsWith: async (threadId: string, given: Record<string, unknown>) => {
      answers.push(given);
      return { threadId, status: 'completed', state: { answer: 'Deployed main.' } };
    },
  };
  const chat = editor(asking, () => ({ outcome: { outcome: 'cancelled' } }));
  const room = await chat.request('session/new', { cwd: '/', mcpServers: [] });
  const asked = await chat.request('session/prompt', {
    sessionId: room.result.sessionId,
    prompt: [{ type: 'text', text: 'Deploy' }],
  });
  assert.equal(asked.result.stopReason, 'end_turn');
  assert.deepEqual(chat.updates.at(-1), {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Which branch?' },
  });
  await chat.request('session/prompt', { sessionId: room.result.sessionId, prompt: [{ type: 'text', text: 'main' }] });
  assert.deepEqual(answers, [{ q1: 'main' }]);
  assert.deepEqual(chat.updates.at(-1), {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Deployed main.' },
  });

  // Protocol errors: an unknown session, an unknown method, and a line that is not JSON.
  assert.equal((await chat.request('session/prompt', { sessionId: 'missing', prompt: [] })).error.code, -32602);
  assert.equal((await chat.request('session/load', {})).error.code, -32601);
  assert.deepEqual((await chat.request('authenticate', { methodId: 'none' })).result, {});
  chat.raw('not json\n');
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(chat.errors.at(-1)?.error.code, -32700);
  await Promise.all([ide.close(), chat.close()]);
});

test('protocol helpers: approvals read from words, and the transcript a run leaves', () => {
  assert.deepEqual(approvalOf('Yes, go on'), { approved: true });
  assert.deepEqual(approvalOf('ok'), { approved: true });
  assert.deepEqual(approvalOf('no'), { approved: false, reason: 'no' });
  assert.deepEqual(approvalOf('   '), { approved: false });
  assert.deepEqual(approvalOf('yesterday was fine'), { approved: false, reason: 'yesterday was fine' });
  const fallback = [{ role: 'user' as const, content: 'hi' }];
  assert.equal(transcriptOf({ messages: [{ role: 'assistant', content: 'x' }] }, fallback).length, 1);
  assert.equal(transcriptOf({ answer: 'x' }, fallback), fallback);
  assert.equal(transcriptOf(null, fallback), fallback);
});
