/**
 * MCP both ways: a server's prompts, its resources a client subscribes to, and every list's changes
 * told; a tool that asks the client that called it for a completion from its model, an answer from its
 * person, or its roots, through `context.mcp`; and all of it over streamable HTTP, where a server's
 * question in the middle of a call, and its progress, reach the client as they are sent, a `GET`
 * stream carries what it sends of its own accord, and sessions are kept apart.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { tool } from '../src/agent/tool.js';
import {
  createHttpTransport,
  type JsonRpcMessage,
  McpClient,
  McpError,
  mcpHttpHandler,
  McpServer,
  type McpTransport,
  samplingFrom,
} from '../src/mcp/index.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

function connectedPair(): { clientSide: McpTransport; serverSide: McpTransport } {
  let toClient: (message: JsonRpcMessage) => void = () => undefined;
  let toServer: (message: JsonRpcMessage) => void = () => undefined;
  return {
    clientSide: {
      send: (message) => toServer(message),
      onMessage: (handler) => {
        toClient = handler;
      },
      close: () => undefined,
    },
    serverSide: {
      send: (message) => toClient(message),
      onMessage: (handler) => {
        toServer = handler;
      },
      close: () => undefined,
    },
  };
}

/** A completion client whose model answers with what it was asked, and records each request. */
function echoModel() {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    async complete(request: CompletionRequest): Promise<NexusResponse> {
      requests.push(request);
      const last = request.messages.at(-1);
      const said = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content);
      return {
        content: `model ${request.model} says: ${said}`,
        role: 'assistant',
        finishReason: 'length',
        meta: { modelUsed: request.model },
      } as NexusResponse;
    },
  };
}

/** A tool that asks the client that called it for each thing a server may ask. */
const askingTool = tool({
  name: 'ask_client',
  description: 'Asks the client',
  parameters: { type: 'object', properties: { what: { type: 'string' } } },
  execute: async (args, context) => {
    const what = String(args.what);
    if (what === 'sample') {
      const answer = await context?.mcp?.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: 'Summarize the ticket' } }],
        systemPrompt: 'Be brief',
        maxTokens: 500,
        modelPreferences: { hints: [{ name: 'mini' }] },
      });
      return answer;
    }
    if (what === 'elicit') {
      return context?.mcp?.elicit({
        message: 'Which account?',
        requestedSchema: { type: 'object', properties: { account: { type: 'string' } }, required: ['account'] },
      });
    }
    return context?.mcp?.listRoots();
  },
});

const textOf = (result: { content: Array<{ text?: string }> }) => result.content.map((part) => part.text).join('');

test('a tool asks the client that called it for a completion, an answer, and its roots, and only what it declared', async () => {
  const model = echoModel();
  const elicited: string[] = [];
  const pair = connectedPair();
  const server = new McpServer({ tools: [askingTool] });
  await server.connect(pair.serverSide);
  const client = new McpClient(pair.clientSide, {
    sampling: samplingFrom(model, { model: 'big-1', models: ['gpt-mini-2', 'big-1'], maxTokens: 200 }),
    elicitation: (request) => {
      elicited.push(request.message);
      return { action: 'accept', content: { account: 'acme' } };
    },
    roots: () => [{ uri: 'file:///work/acme', name: 'acme' }],
  });
  const sampled = JSON.parse(textOf(await client.callTool('ask_client', { what: 'sample' })));
  assert.deepEqual(sampled, {
    role: 'assistant',
    content: { type: 'text', text: 'model gpt-mini-2 says: Summarize the ticket' },
    model: 'gpt-mini-2',
    stopReason: 'maxTokens',
  });
  const asked = model.requests[0];
  assert.deepEqual(asked?.messages, [
    { role: 'system', content: 'Be brief' },
    { role: 'user', content: 'Summarize the ticket' },
  ]);
  assert.equal(asked?.maxTokens, 200, 'capped at what the client allows');
  assert.ok(asked?.signal instanceof AbortSignal, 'and stoppable');
  assert.deepEqual(JSON.parse(textOf(await client.callTool('ask_client', { what: 'elicit' }))), {
    action: 'accept',
    content: { account: 'acme' },
  });
  assert.deepEqual(elicited, ['Which account?']);
  assert.deepEqual(JSON.parse(textOf(await client.callTool('ask_client', { what: 'roots' }))), [
    { uri: 'file:///work/acme', name: 'acme' },
  ]);
  assert.deepEqual(await server.listRoots(), [{ uri: 'file:///work/acme', name: 'acme' }], 'the server asks too');

  // A client that declared none of them: each is refused before it is sent.
  const bare = connectedPair();
  const quiet = new McpServer({ tools: [askingTool] });
  await quiet.connect(bare.serverSide);
  const plain = new McpClient(bare.clientSide);
  for (const [what, capability] of [
    ['sample', 'sampling'],
    ['elicit', 'elicitation'],
    ['roots', 'roots'],
  ]) {
    const result = await plain.callTool('ask_client', { what });
    assert.equal(result.isError, true, what);
    assert.match(textOf(result), new RegExp(`did not declare ${capability}`));
  }

  // A request the person declines is the server's error, and the model is never called.
  const declining = connectedPair();
  const strict = new McpServer({ tools: [askingTool] });
  await strict.connect(declining.serverSide);
  const careful = new McpClient(declining.clientSide, {
    sampling: samplingFrom(model, { model: 'big-1', approve: (request) => request.maxTokens < 100 }),
  });
  const declined = await careful.callTool('ask_client', { what: 'sample' });
  assert.equal(declined.isError, true);
  assert.match(textOf(declined), /declined/);
  assert.equal(model.requests.length, 1, 'the model asked once, for the first client only');
});

test('a client answers a server’s ping and roots, refuses what it was not given, and a server request it cancels stops', async () => {
  const sent: JsonRpcMessage[] = [];
  let deliver: (message: JsonRpcMessage) => void = () => undefined;
  let stopped: AbortSignal | undefined;
  const transport: McpTransport = {
    send: (message) => void sent.push(message),
    onMessage: (handler) => {
      deliver = handler;
    },
    close: () => undefined,
  };
  new McpClient(transport, {
    roots: () => [{ uri: 'file:///w' }],
    elicitation: (_request, context) =>
      new Promise((resolve) => {
        stopped = context.signal;
        context.signal.addEventListener('abort', () => resolve({ action: 'cancel' }));
      }),
  });
  const answerTo = async (id: string) => {
    for (let tries = 0; tries < 50 && !sent.some((message) => 'id' in message && message.id === id); tries += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    return sent.find((message) => 'id' in message && message.id === id) as {
      result?: unknown;
      error?: { code: number; message: string };
    };
  };
  deliver({ jsonrpc: '2.0', id: 'p', method: 'ping' });
  assert.deepEqual((await answerTo('p')).result, {});
  deliver({ jsonrpc: '2.0', id: 'r', method: 'roots/list' });
  assert.deepEqual((await answerTo('r')).result, { roots: [{ uri: 'file:///w' }] });
  deliver({ jsonrpc: '2.0', id: 's', method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } });
  assert.deepEqual((await answerTo('s')).error?.code, -32_601, 'no sampling handler: method not found');
  deliver({ jsonrpc: '2.0', id: 'toString', method: 'toString' });
  assert.match((await answerTo('toString')).error?.message ?? '', /does not implement "toString"/);
  deliver({
    jsonrpc: '2.0',
    id: 'e',
    method: 'elicitation/create',
    params: { message: 'x', requestedSchema: { type: 'object', properties: {} } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  deliver({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'e' } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(stopped?.aborted, true, 'the handler is told to stop');
  assert.equal(
    sent.some((message) => 'id' in message && message.id === 'e'),
    false,
    'and a cancelled request is not answered',
  );
});

test('prompts are listed and rendered, a required argument enforced, and every list’s changes told', async () => {
  const pair = connectedPair();
  const server = new McpServer({
    prompts: [
      {
        name: 'triage',
        title: 'Triage a ticket',
        description: 'Sorts a ticket',
        arguments: [
          { name: 'ticket', required: true },
          { name: 'tone', description: 'How to answer' },
        ],
        get: (args) => `Triage: ${args.ticket} (${args.tone ?? 'plain'})`,
      },
    ],
  });
  await server.connect(pair.serverSide);
  const client = new McpClient(pair.clientSide);
  assert.deepEqual(await client.listPrompts(), [
    {
      name: 'triage',
      title: 'Triage a ticket',
      description: 'Sorts a ticket',
      arguments: [
        { name: 'ticket', required: true },
        { name: 'tone', description: 'How to answer' },
      ],
    },
  ]);
  assert.deepEqual(await client.getPrompt('triage', { ticket: 42 }), [
    { role: 'user', content: { type: 'text', text: 'Triage: 42 (plain)' } },
  ]);
  await assert.rejects(
    client.getPrompt('triage', {}),
    (error: unknown) =>
      error instanceof McpError && error.code === -32_602 && /needs the argument "ticket"/.test(error.message),
  );
  await assert.rejects(client.getPrompt('missing'), /Unknown prompt "missing"/);

  const heard: string[] = [];
  client.onPromptsChanged(() => heard.push('prompts'));
  client.onResourcesChanged(() => heard.push('resources'));
  client.onToolsChanged(() => heard.push('tools'));
  server.registerPrompt({ name: 'greet', get: () => [{ role: 'assistant', content: { type: 'text', text: 'Hi' } }] });
  server.registerResource({ uri: 'note://1', read: () => 'one' });
  server.register(
    tool({ name: 'noop', description: 'Nothing', parameters: { type: 'object' }, execute: async () => 'ok' }),
  );
  assert.deepEqual(heard, ['prompts', 'resources', 'tools']);
  assert.deepEqual(await client.getPrompt('greet'), [{ role: 'assistant', content: { type: 'text', text: 'Hi' } }]);
});

test('a client subscribed to a resource hears when it changes, and only while subscribed', async () => {
  const pair = connectedPair();
  let note = 'first';
  const server = new McpServer({ resources: [{ uri: 'note://today', name: 'Today', read: () => note }] });
  await server.connect(pair.serverSide);
  const client = new McpClient(pair.clientSide);
  const updated: string[] = [];
  client.onResourceUpdated((uri) => updated.push(uri));
  server.resourceUpdated('note://today');
  assert.deepEqual(updated, [], 'not subscribed, not told');
  await client.subscribeResource('note://today');
  note = 'second';
  server.resourceUpdated('note://today');
  server.resourceUpdated('note://other');
  assert.deepEqual(updated, ['note://today']);
  assert.equal((await client.readResource('note://today'))[0]?.text, 'second');
  await client.unsubscribeResource('note://today');
  server.resourceUpdated('note://today');
  assert.deepEqual(updated, ['note://today'], 'unsubscribed, not told again');
  await assert.rejects(client.subscribeResource('note://missing'), /Unknown resource/);
});

/** A Web handler over node:http, streaming each response as it is written. */
async function serve(handler: (request: Request) => Promise<Response>) {
  let origin = '';
  const server: Server = createServer(async (incoming: IncomingMessage, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const aborted = new AbortController();
    outgoing.on('close', () => aborted.abort());
    const response = await handler(
      new Request(`${origin}${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        signal: aborted.signal,
        ...(incoming.method === 'GET' || incoming.method === 'DELETE' ? {} : { body: Buffer.concat(chunks) }),
      }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body)
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) outgoing.write(chunk);
    outgoing.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('proof: over streamable HTTP, a tool asks its own client mid-call, progress arrives before the answer, and sessions stay apart', async () => {
  const model = echoModel();
  const progressTool = tool({
    name: 'slow',
    description: 'Reports progress, then asks the client',
    parameters: { type: 'object' },
    execute: async (_args, context) => {
      context?.progress?.({ progress: 1, total: 2, message: 'halfway' });
      const answer = await context?.mcp?.createMessage({
        messages: [{ role: 'user', content: { type: 'text', text: 'Which next?' } }],
        maxTokens: 50,
      });
      return answer?.content.type === 'text' ? answer.content.text : '';
    },
  });
  const mcp = new McpServer({ tools: [progressTool, askingTool] });
  const handler = mcpHttpHandler(mcp);
  const http = await serve(handler);
  const sampling = (name: string) =>
    samplingFrom(
      {
        complete: async (request: CompletionRequest) => ({
          ...(await model.complete(request)),
          content: `${name} answers`,
        }),
      },
      { model: 'small-1' },
    );
  const ana = new McpClient(createHttpTransport({ url: `${http.origin}/mcp`, listen: true }), {
    sampling: sampling('ana'),
  });
  const rui = new McpClient(createHttpTransport({ url: `${http.origin}/mcp` }), { sampling: sampling('rui') });
  try {
    const reports: string[] = [];
    const result = await ana.callTool('slow', {}, { progress: (report) => reports.push(report.message ?? '') });
    assert.equal(textOf(result), 'ana answers', 'the question went to the client that called, mid-call, and came back');
    assert.deepEqual(reports, ['halfway'], 'progress arrived on the call’s own stream');
    assert.equal(textOf(await rui.callTool('slow', {})), 'rui answers', 'another session asks its own client');
    assert.equal(handler.sessions(), 2);
    await assert.rejects(mcp.createMessage({ messages: [], maxTokens: 1 }), /2 MCP clients are connected/);

    // What the server sends of its own accord reaches a listening client on its GET stream.
    const heard = new Promise<void>((resolve) => ana.onToolsChanged(resolve));
    mcp.register(
      tool({ name: 'late', description: 'Added later', parameters: { type: 'object' }, execute: async () => 'late' }),
    );
    await heard;

    // Closing ends the session on the server too.
    await rui.close();
    for (let tries = 0; tries < 50 && handler.sessions() !== 1; tries += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(handler.sessions(), 1, 'the DELETE ended it');
  } finally {
    await ana.close();
    await handler.close();
    await http.close();
  }
});

test('streamable HTTP refuses what it should: another origin, no session, an unknown one, a version it does not speak', async () => {
  const handler = mcpHttpHandler(new McpServer({ tools: [askingTool] }), {
    allowedOrigins: ['https://editor.example'],
    sessionId: (() => {
      let next = 0;
      return () => `s${++next}`;
    })(),
  });
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    handler(
      new Request('https://mcp.example/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    );
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } };
  assert.equal((await post(initialize, { origin: 'https://evil.example' })).status, 403, 'another origin');
  const opened = await post(initialize, { origin: 'https://editor.example' });
  assert.equal(opened.status, 200, 'an allowed origin');
  assert.equal(opened.headers.get('mcp-session-id'), 's1');
  assert.match(await opened.text(), /^event: message\ndata: \{"jsonrpc":"2.0","id":1,"result":\{"protocolVersion"/);
  assert.equal((await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).status, 400, 'no session');
  assert.equal(
    (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { 'mcp-session-id': 'nope' })).status,
    404,
    'an unknown session',
  );
  assert.equal(
    (
      await post(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { 'mcp-session-id': 's1', 'mcp-protocol-version': '1999-01-01' },
      )
    ).status,
    400,
    'a version it does not speak',
  );
  assert.equal((await post('{not json', { 'mcp-session-id': 's1' })).status, 400, 'not JSON');
  assert.equal(
    (await post([{ jsonrpc: '2.0', id: 3, method: 'ping' }], { 'mcp-session-id': 's1' })).status,
    400,
    'a batch',
  );
  assert.equal(
    (await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': 's1' })).status,
    202,
    'a notification is taken',
  );
  assert.equal((await post(initialize, { 'mcp-session-id': 's1' })).status, 400, 'a session is initialized once');
  const listed = await post(
    { jsonrpc: '2.0', id: 4, method: 'tools/list' },
    { 'mcp-session-id': 's1', 'mcp-protocol-version': '2025-06-18' },
  );
  assert.match(await listed.text(), /"name":"ask_client"/);
  const get = (headers: Record<string, string>) => handler(new Request('https://mcp.example/mcp', { headers }));
  assert.equal((await get({ 'mcp-session-id': 's1' })).status, 406, 'a GET must accept a stream');
  assert.equal((await get({ accept: 'text/event-stream' })).status, 400, 'a GET needs a session');
  assert.equal((await handler(new Request('https://mcp.example/mcp', { method: 'PUT' }))).status, 405);
  const deleted = await handler(
    new Request('https://mcp.example/mcp', { method: 'DELETE', headers: { 'mcp-session-id': 's1' } }),
  );
  assert.equal(deleted.status, 204);
  assert.equal(handler.sessions(), 0);

  // As JSON, a request is answered once the server finishes.
  const asJson = mcpHttpHandler(new McpServer(), { json: true, maxSessions: 1 });
  const answered = await asJson(
    new Request('https://mcp.example/mcp', { method: 'POST', body: JSON.stringify(initialize) }),
  );
  assert.equal(answered.headers.get('content-type'), 'application/json');
  assert.equal(((await answered.json()) as { id: number }).id, 1);
  const full = await asJson(
    new Request('https://mcp.example/mcp', { method: 'POST', body: JSON.stringify(initialize) }),
  );
  assert.equal(full.status, 503, 'past maxSessions');
  await asJson.close();
  await handler.close();
});

test('a session idle past its time is ended, and one still streaming is kept', async () => {
  const handler = mcpHttpHandler(new McpServer(), { sessionTtlMs: 1 });
  const open = async () => {
    const response = await handler(
      new Request('https://mcp.example/mcp', {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } }),
      }),
    );
    await response.text();
    return response.headers.get('mcp-session-id') as string;
  };
  const first = await open();
  const streaming = await handler(
    new Request('https://mcp.example/mcp', { headers: { accept: 'text/event-stream', 'mcp-session-id': first } }),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await open();
  assert.equal(handler.sessions(), 2, 'the first kept, its stream open');
  await streaming.body?.cancel();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await open();
  assert.equal(handler.sessions(), 1, 'idle and without a stream, both earlier ones are ended');
  await handler.close();
});

/** Fails after `ms` with `why`, for what must happen without waiting on something else. */
const within = <T>(promise: Promise<T>, ms: number, why: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(why)), ms);
      timer.unref?.();
    }),
  ]);

test('two requests in flight in one session are each answered on their own stream', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = new McpServer({
    tools: [
      tool({
        name: 'wait',
        description: 'Waits to be let go',
        parameters: { type: 'object' },
        execute: async () => {
          await gate;
          return 'done';
        },
      }),
    ],
  });
  const handler = mcpHttpHandler(server, { sessionId: () => 's1' });
  const post = (body: unknown, session = true) =>
    handler(
      new Request('https://mcp.example/mcp', {
        method: 'POST',
        headers: session ? { 'mcp-session-id': 's1' } : {},
        body: JSON.stringify(body),
      }),
    );
  await (await post({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { capabilities: {} } }, false)).text();
  const waiting = await post({
    jsonrpc: '2.0',
    id: 'call',
    method: 'tools/call',
    params: { name: 'wait', arguments: {} },
  });
  const listed = await post({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  const listText = await within(listed.text(), 2_000, 'the list was not answered on its own stream');
  assert.match(listText, /"id":"list"/);
  assert.doesNotMatch(listText, /"id":"call"/);
  release();
  const callText = await within(waiting.text(), 2_000, 'the call was not answered on its own stream');
  assert.match(callText, /"id":"call","result":\{"content":\[\{"type":"text","text":"done"\}\]\}/);
  await handler.close();
});

test('the HTTP transport hands over a streamed answer as it comes, without waiting for the stream to end', async () => {
  let push: (text: string) => void = () => undefined;
  let end: () => void = () => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (text) => controller.enqueue(new TextEncoder().encode(text));
      end = () => controller.close();
    },
  });
  const transport = createHttpTransport({
    url: 'https://mcp.example/mcp',
    fetch: (async () =>
      new Response(body, { headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 's9' } })) as typeof fetch,
  });
  const received: JsonRpcMessage[] = [];
  transport.onMessage((message) => received.push(message));
  await within(
    Promise.resolve(transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slow' } })),
    2_000,
    'send waited for the whole stream',
  );
  push(
    'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":1,"progress":1}}\n\n',
  );
  for (let tries = 0; tries < 50 && received.length < 1; tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(received.length, 1, 'the progress, while the stream is still open');
  push('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n');
  end();
  for (let tries = 0; tries < 50 && received.length < 2; tries += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(received[1], { jsonrpc: '2.0', id: 1, result: {} });
});
