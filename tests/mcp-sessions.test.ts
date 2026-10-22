/**
 * MCP servers that change during a session: a stream that ends is opened again, and a process that
 * exits started again, with the server greeted again, and tools a server adds reach the agent at its
 * next turn.
 *
 * The server stands in for one over HTTP with Server-Sent Events, as MCP's 2024-11-05 transport has
 * it: each stream is a session of its own, and a session not yet greeted with `initialize` is refused.
 * So a client that opened a new stream without greeting the server again would fail.
 */
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createAgent } from '../src/agent/create-agent.js';
import { createSseTransport, createStdioTransport, McpClient, type McpToolDescriptor } from '../src/mcp/client.js';
import { type JsonRpcMessage, MCP_PROTOCOL_VERSION, type McpTransport } from '../src/mcp/protocol.js';
import { McpServer } from '../src/mcp/server.js';
import { acpEditor } from '../src/protocols/acp-editor.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import { acpEditor as editorDriving } from './acp-editor.js';

/** A server over HTTP with SSE whose sessions are its streams. */
async function liveServer() {
  let tools: McpToolDescriptor[] = [
    { name: 'lookup', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, openWorldHint: false } },
  ];
  const sessions = new Map<string, { stream: ServerResponse; greeted: boolean }>();
  let current: string | undefined;
  let opened = 0;
  /**
   * Streams opened and still open, greetings, `tools/list` calls, tools called, and how many streams
   * and lists to refuse.
   */
  const log = {
    streams: 0,
    open: 0,
    greetings: 0,
    lists: 0,
    calls: [] as string[],
    refuseStreams: 0,
    refuseLists: 0,
  };
  const write = (session: string, payload: unknown) =>
    sessions.get(session)?.stream.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/sse' && log.refuseStreams > 0) {
      // A server restarting answers the stream with a 503.
      log.refuseStreams -= 1;
      return void response.writeHead(503).end();
    }
    if (request.method === 'GET' && url.pathname === '/sse') {
      const id = `s${++opened}`;
      sessions.set(id, { stream: response, greeted: false });
      current = id;
      log.streams += 1;
      log.open += 1;
      response.on('close', () => {
        log.open -= 1;
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`event: endpoint\ndata: /messages?session=${id}\n\n`);
      return;
    }
    const id = url.searchParams.get('session') ?? '';
    const session = sessions.get(id);
    if (request.method !== 'POST' || url.pathname !== '/messages' || !session)
      return void response.writeHead(404).end();
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: number;
      method?: string;
      params?: { name?: string };
    };
    response.writeHead(202).end();
    if (message.id === undefined) return;
    if (message.method === 'initialize') {
      session.greeted = true;
      log.greetings += 1;
      write(id, {
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'live' },
        },
      });
    } else if (!session.greeted) {
      write(id, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32002, message: 'this session was never initialized' },
      });
    } else if (message.method === 'tools/list' && ++log.lists && log.refuseLists > 0) {
      log.refuseLists -= 1;
      write(id, { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'the tool index is rebuilding' } });
    } else if (message.method === 'tools/list') {
      write(id, { jsonrpc: '2.0', id: message.id, result: { tools } });
    } else if (message.method === 'tools/call') {
      log.calls.push(String(message.params?.name));
      write(id, {
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: `did ${message.params?.name}` }] },
      });
    } else {
      write(id, { jsonrpc: '2.0', id: message.id, result: {} });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sse`,
    log,
    /** Ends the stream, as a proxy or a restart does, and forgets its session. */
    drop() {
      if (!current) return;
      sessions.get(current)?.stream.end();
      sessions.delete(current);
    },
    /** Adds a tool and says so on every stream. */
    addTool(tool: McpToolDescriptor) {
      tools = [...tools, tool];
      for (const id of sessions.keys()) write(id, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const { stream } of sessions.values()) stream.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const until = async (check: () => boolean, message = 'waited for it') => {
  for (let tries = 0; tries < 200 && !check(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), message);
};

test('an SSE stream that ends is opened again, and the server greeted again, when the client reconnects', async () => {
  const live = await liveServer();
  try {
    const transport = createSseTransport({ url: live.url, reopen: true });
    let ended = 0;
    transport.onClose?.(() => {
      ended += 1;
    });
    const client = new McpClient(transport, { reconnect: true, timeoutMs: 5_000 });
    assert.equal((await client.listTools()).length, 1);
    live.drop();
    // Once the client has seen the stream end.
    await until(() => ended === 1);
    assert.equal(live.log.streams, 1, 'nothing opened before a message needs it');
    // The next call opens a new stream, greets the new session, and is answered on it.
    const result = await client.callTool('lookup');
    assert.deepEqual(result.content, [{ type: 'text', text: 'did lookup' }]);
    assert.deepEqual([live.log.streams, live.log.greetings], [2, 2], 'a second stream, and a second greeting');
    await client.close();
    await until(() => live.log.open === 0, 'the stream opened again closes with the client');

    // Without reconnecting, a stream that ended stays closed, as before.
    const plain = new McpClient(createSseTransport({ url: live.url }), { timeoutMs: 5_000 });
    await plain.listTools();
    live.drop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(plain.callTool('lookup'), /closed/);
    await plain.close();

    // And a client closed on purpose never reopens.
    const closed = new McpClient(createSseTransport({ url: live.url, reopen: true }), {
      reconnect: true,
      timeoutMs: 5_000,
    });
    await closed.listTools();
    const streams = live.log.streams;
    await closed.close();
    await assert.rejects(closed.listTools(), /closed/);
    assert.equal(live.log.streams, streams, 'no stream opened after close()');

    // Closing is at once: its listeners hear it within close(), and nothing more is sent.
    const direct = createSseTransport({ url: live.url, reopen: true });
    await direct.start?.();
    let heard = false;
    direct.onClose?.(() => {
      heard = true;
    });
    direct.close();
    assert.ok(heard, 'close() tells its listeners before it returns');
    await assert.rejects(Promise.resolve(direct.send({ jsonrpc: '2.0', method: 'ping' })), /closed/);
  } finally {
    await live.close();
  }
});

test('a stream that cannot open, or names no endpoint in time, fails its request, and the next opens a new one', async () => {
  const live = await liveServer();
  // When asked, a stream that names no endpoint and, let go, ends only when the test says: late.
  let silent = false;
  let aborted = false;
  let endLate: (() => void) | undefined;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (!silent || init?.method === 'POST') return globalThis.fetch(input, init);
    silent = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          endLate = () => controller.close();
        });
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  const transport = createSseTransport({ url: live.url, reopen: true, timeoutMs: 100, fetch });
  let closes = 0;
  transport.onClose?.(() => {
    closes += 1;
  });
  const client = new McpClient(transport, { reconnect: true, timeoutMs: 5_000 });
  try {
    live.log.refuseStreams = 1;
    await assert.rejects(client.listTools(), /failed with 503/);
    assert.equal((await client.listTools()).length, 1, 'the server back, the next request opens a stream');

    live.drop();
    await until(() => closes === 2, 'the dropped stream closes the transport');
    silent = true;
    await assert.rejects(client.callTool('lookup'), /named no endpoint within 100ms/);
    assert.ok(aborted, 'the silent stream is let go');
    const result = await client.callTool('lookup');
    assert.deepEqual(result.content, [{ type: 'text', text: 'did lookup' }], 'answered on a stream opened again');

    // The silent stream ends only now, after another replaced it, and so closes nothing.
    const streams = live.log.streams;
    endLate?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(closes, 3, 'closed by the 503, the drop, and the silent stream, once each');
    await client.callTool('lookup');
    assert.equal(live.log.streams, streams, 'the stream that replaced it still serves');
  } finally {
    await client.close();
    await live.close();
  }
});

/**
 * A server over stdio that answers `pid` with its process id and exits at `exit`, leaving half a
 * line behind, as a process that dies mid-write does. It refuses any call before `initialize`.
 */
const stdioServer = `
let greeted = false;
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    greeted = true;
    return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: ${JSON.stringify(MCP_PROTOCOL_VERSION)}, capabilities: {}, serverInfo: { name: 'pid' } } });
  }
  if (!greeted) return send({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'not initialized' } });
  if (message.params?.name === 'exit') return process.stdout.write('{"jsonrpc":"2.0","id":', () => process.exit(0));
  send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(process.pid) }] } });
});
`;

test('a stdio server that exits is started again, and greeted again, when the client reconnects', async () => {
  const client = new McpClient(createStdioTransport({ command: process.execPath, args: ['-e', stdioServer] }), {
    reconnect: true,
    timeoutMs: 5_000,
  });
  const pid = async () => (await client.callTool('pid')).content[0]?.text;
  const first = await pid();
  // The call in flight when the process exits fails; the next starts a new process.
  await assert.rejects(client.callTool('exit'), /closed/);
  const second = await pid();
  assert.ok(second && second !== first, `a second process answers: ${first} then ${second}`);
  await client.close();
  // Closed on purpose, the client starts no process again.
  await assert.rejects(pid(), /not started/);
});

/** Two transports joined end to end, in memory. */
function linked(): [McpTransport, McpTransport] {
  const handlers: Array<(message: JsonRpcMessage) => void> = [() => undefined, () => undefined];
  const end = (self: number): McpTransport => ({
    send: (message) => {
      queueMicrotask(() => handlers[1 - self]?.(structuredClone(message)));
    },
    onMessage: (handler) => {
      handlers[self] = handler;
    },
    close: () => undefined,
  });
  return [end(0), end(1)];
}

test('the package’s MCP server says when its tools change, and its client hears it', async () => {
  const run = async () => 'ok';
  const server = new McpServer({
    tools: [{ name: 'first', description: 'First', parameters: { type: 'object' }, execute: run }],
  });
  const sent: JsonRpcMessage[] = [];
  const probe = new McpServer();
  await probe.connect({
    send: (message) => void sent.push(message),
    onMessage: () => undefined,
    close: () => undefined,
  });
  await probe.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.deepEqual(
    (sent[0] as { result?: { capabilities?: { tools?: unknown } } }).result?.capabilities?.tools,
    { listChanged: true },
    'the server says its tools can change',
  );
  const [serverEnd, clientEnd] = linked();
  await server.connect(serverEnd);
  const client = new McpClient(clientEnd);
  let heard = 0;
  // A listener that throws keeps no other from hearing.
  client.onToolsChanged(() => {
    throw new Error('a listener that fails');
  });
  const stop = client.onToolsChanged(() => {
    heard += 1;
  });
  assert.deepEqual(
    (await client.listTools()).map((tool) => tool.name),
    ['first'],
  );
  server.register({ name: 'second', description: 'Second', parameters: { type: 'object' }, execute: run });
  await until(() => heard === 1);
  assert.deepEqual(
    (await client.listTools()).map((tool) => tool.name),
    ['first', 'second'],
  );
  stop();
  server.register({ name: 'third', description: 'Third', parameters: { type: 'object' }, execute: run });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(heard, 1, 'a listener that stopped hears no more');
  await client.close();
});

/**
 * An agent behind the editor bridge, offered one SSE server: a turn whose tools include
 * `live_summarize` calls it, and every other turn answers.
 */
function editorWith(live: Awaited<ReturnType<typeof liveServer>>) {
  const errors: string[] = [];
  const bridge = acpEditor({ onError: (error, name) => errors.push(`${name}: ${(error as Error).message}`) });
  const offered: string[][] = [];
  const meta = { provider: 'mock', model: 'mock', requestId: 'r', latencyMs: 1, timestamp: '2026-10-21T00:00:00.000Z' };
  const agent = createAgent({
    client: {
      complete: async (request: CompletionRequest): Promise<NexusResponse> => {
        const names = (request.tools ?? []).map((tool) => tool.name);
        const last = request.messages.at(-1);
        if (last?.role === 'user') offered.push(names);
        if (last?.role === 'user' && names.includes('live_summarize')) {
          return {
            content: '',
            toolCalls: [{ id: 'c1', type: 'function', function: { name: 'live_summarize', arguments: '{}' } }],
            meta,
          } as unknown as NexusResponse;
        }
        return {
          content: last?.role === 'tool' ? `Summary: ${last.content}` : 'Nothing to do.',
          meta,
        } as unknown as NexusResponse;
      },
    },
    model: 'mock',
    toolSource: bridge.toolSource,
  });
  const editor = editorDriving(agent, undefined, { editor: bridge });
  let sessionId: string | undefined;
  return {
    bridge,
    editor,
    offered,
    errors,
    async prompt(text: string) {
      if (!sessionId) {
        await editor.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
        const { result } = await editor.request('session/new', {
          cwd: '/repo',
          mcpServers: [{ type: 'sse', name: 'live', url: live.url, headers: [] }],
        });
        sessionId = result.sessionId as string;
      }
      return (await editor.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })).result;
    },
  };
}

const summarize: McpToolDescriptor = {
  name: 'summarize',
  inputSchema: { type: 'object' },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

test('proof: the editor’s server drops its stream and adds a tool between two turns, and the agent uses it at the next', async () => {
  const live = await liveServer();
  const { bridge, editor, offered, prompt } = editorWith(live);
  try {
    assert.equal((await prompt('Look around')).stopReason, 'end_turn');
    assert.deepEqual(offered[0], ['live_lookup']);

    // Between the turns the server adds a tool, says so, and its stream drops.
    live.addTool(summarize);
    await new Promise((resolve) => setTimeout(resolve, 30));
    live.drop();
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal((await prompt('Summarize it')).stopReason, 'end_turn');
    assert.deepEqual(offered[1], ['live_lookup', 'live_summarize'], 'the new tool, at the next turn');
    assert.deepEqual(live.log.calls, ['summarize'], 'called over the stream opened again');
    assert.deepEqual([live.log.streams, live.log.greetings], [2, 2]);
    const answer = editor.updates.filter((update) => update.sessionUpdate === 'agent_message_chunk').at(-1);
    assert.match(String((answer?.content as { text?: string } | undefined)?.text), /did summarize/);

    await bridge.close();
    await until(() => live.log.open === 0, 'the bridge closes the stream it opened again');
  } finally {
    editor.close();
    await bridge.close();
    await live.close();
  }
});

test('a server whose tools fail to list again keeps them as last listed, and is asked again at the next turn', async () => {
  const live = await liveServer();
  const { bridge, editor, offered, errors, prompt } = editorWith(live);
  try {
    await prompt('Look around');
    live.addTool(summarize);
    await new Promise((resolve) => setTimeout(resolve, 30));
    live.log.refuseLists = 1;

    await prompt('Summarize it');
    assert.deepEqual(offered[1], ['live_lookup'], 'the tools as last listed, while the server cannot list them');
    assert.deepEqual(errors, ['live: the tool index is rebuilding']);

    await prompt('Summarize it now');
    assert.deepEqual(offered[2], ['live_lookup', 'live_summarize'], 'listed again at the next turn');
    assert.deepEqual(live.log.calls, ['summarize']);

    await prompt('Once more');
    assert.equal(live.log.lists, 3, 'listed again only when the server said its tools changed');
  } finally {
    editor.close();
    await bridge.close();
    await live.close();
  }
});
