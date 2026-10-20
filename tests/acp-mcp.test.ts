/**
 * The editor's MCP servers, over every transport, governed by the agent's own policy.
 *
 * An editor offers one MCP server over stdio, one over streamable HTTP, and one over HTTP with
 * Server-Sent Events. The agent tells the editor in `initialize` that it connects HTTP and SSE, calls
 * a tool on each server, and its permission policy, which only lets MCP tools read, refuses each
 * server's destructive tool before the server sees the call, with no rule naming any tool. The
 * capabilities come from what each server says of its tools, and the package's own MCP server says it
 * of the tools it serves.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAgent } from '../src/agent/create-agent.js';
import { permissionPolicy } from '../src/agent/permissions.js';
import { createSseTransport, McpClient, type McpToolDescriptor, mcpToolCapabilities } from '../src/mcp/client.js';
import { type JsonRpcMessage, MCP_PROTOCOL_VERSION, type McpTransport } from '../src/mcp/protocol.js';
import { McpServer, mcpToolAnnotations } from '../src/mcp/server.js';
import { acpEditor } from '../src/protocols/acp-editor.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import { acpEditor as editorDriving } from './acp-editor.js';

/** Every server offers these: one that reads, one that destroys, one that reaches out, one that says nothing. */
const TOOLS: McpToolDescriptor[] = [
  { name: 'lookup', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'wipe', inputSchema: { type: 'object' }, annotations: { destructiveHint: true, openWorldHint: false } },
  { name: 'browse', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  { name: 'legacy', inputSchema: { type: 'object' } },
];

/** One server's answers, whatever carries them. */
function answer(server: string, message: { id?: unknown; method?: string; params?: Record<string, unknown> }) {
  if (message.method === 'initialize') {
    return { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: server } };
  }
  if (message.method === 'tools/list') return { tools: TOOLS };
  if (message.method === 'tools/call')
    return { content: [{ type: 'text', text: `${server} ${message.params?.name}` }] };
  return {};
}

const STDIO_SERVER = `
const fs = require('node:fs');
const tools = ${JSON.stringify(TOOLS)};
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    const m = JSON.parse(line);
    if (m.id === undefined) continue;
    let result = {};
    if (m.method === 'initialize') result = { protocolVersion: '${MCP_PROTOCOL_VERSION}', capabilities: { tools: {} }, serverInfo: { name: 'local' } };
    else if (m.method === 'tools/list') result = { tools };
    else if (m.method === 'tools/call') {
      fs.writeFileSync('called-' + m.params.name, '');
      result = { content: [{ type: 'text', text: 'local ' + m.params.name }] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  }
});`;

/** A server over streamable HTTP: a POST per message, the answer in its body. */
async function httpServer() {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString()) as Parameters<typeof answer>[1];
    if (message.method === 'tools/call') calls.push(String(message.params?.name));
    if (message.id === undefined) return void response.writeHead(202).end();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answer('remote', message) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * A server over HTTP with Server-Sent Events, as MCP's 2024-11-05 transport has it: a GET opens the
 * stream, whose first event names where to POST, and every answer comes back on the stream.
 */
async function sseServer(options: { endpoint?: (origin: string) => string; endAfter?: string } = {}) {
  const calls: string[] = [];
  const headers: Array<string | undefined> = [];
  const posts: string[] = [];
  let stream: ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    headers.push(request.headers.authorization);
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/sse') {
      stream = response;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const origin = `http://${request.headers.host}`;
      response.write(`event: endpoint\ndata: ${options.endpoint?.(origin) ?? '/messages?session=s1'}\n\n`);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/messages') {
      posts.push(url.search);
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const message = JSON.parse(Buffer.concat(chunks).toString()) as Parameters<typeof answer>[1];
      response.writeHead(202).end('Accepted');
      if (message.method === 'tools/call') calls.push(String(message.params?.name));
      if (message.method === options.endAfter) {
        stream?.end();
        return;
      }
      if (message.id === undefined) return;
      const reply = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: answer('streamed', message) });
      // Split across writes, as a proxy may deliver it.
      stream?.write(`event: message\r\ndata: ${reply.slice(0, 10)}`);
      stream?.write(`${reply.slice(10)}\r\n\r\n`);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sse`,
    calls,
    headers,
    posts,
    close: () =>
      new Promise<void>((resolve) => {
        stream?.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A model that calls the given tools at once, then reports what each answered. */
function calling(names: readonly string[]) {
  const requests: CompletionRequest[] = [];
  const meta = { provider: 'mock', model: 'mock', requestId: 'r', latencyMs: 1, timestamp: '2026-10-20T00:00:00.000Z' };
  return {
    requests,
    client: {
      complete: async (request: CompletionRequest): Promise<NexusResponse> => {
        requests.push(request);
        const results = request.messages.filter((message) => message.role === 'tool');
        if (results.length) {
          return {
            content: results.map((message) => String(message.content)).join('\n'),
            meta,
          } as unknown as NexusResponse;
        }
        return {
          content: '',
          toolCalls: names.map((name, index) => ({
            id: `c${index}`,
            type: 'function',
            function: { name, arguments: '{}' },
          })),
          meta,
        } as unknown as NexusResponse;
      },
    },
  };
}

test('proof: an editor’s MCP servers over stdio, HTTP, and SSE, each tool decided by what its server says it does', async (t) => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'nexus-acp-mcp-'));
  const http = await httpServer();
  const sse = await sseServer();
  const bridge = acpEditor();
  t.after(async () => {
    await bridge.close();
    await http.close();
    await sse.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  const names = ['local', 'remote', 'streamed'].flatMap((server) => TOOLS.map((tool) => `${server}_${tool.name}`));
  const { client, requests } = calling(names);
  const agent = createAgent({
    client,
    model: 'mock',
    toolSource: bridge.toolSource,
    // MCP tools may read, and nothing else: no tool is named.
    permissions: permissionPolicy({ custom: { 'mcp.read': 'allow' } }),
  });
  const editor = editorDriving(agent, undefined, { editor: bridge });
  t.after(() => editor.close());

  const hello = await editor.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  assert.deepEqual(hello.result.agentCapabilities.mcpCapabilities, { http: true, sse: true }, 'HTTP and SSE, told');
  const { result } = await editor.request('session/new', {
    cwd,
    mcpServers: [
      { name: 'local', command: process.execPath, args: ['-e', STDIO_SERVER], env: [] },
      { type: 'http', name: 'remote', url: http.url, headers: [] },
      { type: 'sse', name: 'streamed', url: sse.url, headers: [{ name: 'authorization', value: 'Bearer editor' }] },
    ],
  });
  const done = await editor.request('session/prompt', {
    sessionId: result.sessionId,
    prompt: [{ type: 'text', text: 'Tidy up' }],
  });
  assert.equal(done.result.stopReason, 'end_turn');
  assert.deepEqual(
    requests[0]?.tools?.map((item) => item.name),
    names,
    'every server’s tools, prefixed by its name, on all three transports',
  );

  // Only the tools that read ran, one on each server; the others never reached their servers.
  assert.deepEqual(http.calls, ['lookup']);
  assert.deepEqual(sse.calls, ['lookup']);
  assert.equal(existsSync(path.join(cwd, 'called-lookup')), true, 'the stdio server ran its lookup');
  for (const tool of ['wipe', 'browse', 'legacy']) {
    assert.equal(existsSync(path.join(cwd, `called-${tool}`)), false, `the stdio server never saw ${tool}`);
  }
  const results = new Map(
    (requests[1]?.messages ?? [])
      .filter((message) => message.role === 'tool')
      .map((message) => [String(message.toolCallId), String(message.content)]),
  );
  // A result reaches the model as JSON: the tool's text, or the error that refused it.
  const said = (name: string) => {
    const sent = JSON.parse(results.get(`c${names.indexOf(name)}`) ?? 'null') as string | { error?: string } | null;
    return typeof sent === 'string' ? sent : String(sent?.error);
  };
  assert.equal(said('local_lookup'), 'local lookup');
  assert.equal(said('remote_lookup'), 'remote lookup');
  assert.equal(said('streamed_lookup'), 'streamed lookup');
  assert.match(said('streamed_wipe'), /Permission denied: mcp\.destructive:streamed\/wipe is not granted/);
  assert.match(said('remote_browse'), /Permission denied: network is not granted/, 'reaching beyond needs the network');
  assert.match(said('local_legacy'), /Permission denied: "local_legacy" declares no capabilities/);
  // The SSE server got the editor's headers on its stream and on every message.
  assert.ok(sse.headers.length >= 4, `the stream and its messages: ${sse.headers.length}`);
  assert.ok(
    sse.headers.every((value) => value === 'Bearer editor'),
    'every request carries the editor’s header',
  );
  assert.ok(
    sse.posts.every((search) => search === '?session=s1'),
    'every message went to the endpoint the stream named',
  );
});

test('an MCP tool’s capabilities follow its annotations, and the specification’s defaults for a hint left out', () => {
  const of = (annotations?: McpToolDescriptor['annotations']) =>
    mcpToolCapabilities({ name: 'tool', ...(annotations ? { annotations } : {}) }, 'srv');
  assert.equal(of(), undefined, 'no annotations: undeclared');
  assert.deepEqual(of({}), ['mcp.destructive:srv/tool', 'network'], 'every hint left out: may destroy, reaches out');
  assert.deepEqual(of({ readOnlyHint: true, openWorldHint: false }), ['mcp.read:srv/tool']);
  assert.deepEqual(of({ readOnlyHint: true }), ['mcp.read:srv/tool', 'network']);
  assert.deepEqual(of({ destructiveHint: false, openWorldHint: false }), ['mcp.write:srv/tool']);
  assert.deepEqual(of({ readOnlyHint: false, destructiveHint: true, openWorldHint: true }), [
    'mcp.destructive:srv/tool',
    'network',
  ]);
  assert.deepEqual(of({ readOnlyHint: true, destructiveHint: true, openWorldHint: false }), ['mcp.read:srv/tool']);

  // A policy can ask before a write, grant one server, or decide one tool, all by capability.
  const policy = permissionPolicy({
    custom: { 'mcp.read': 'allow', 'mcp.write': 'allow', 'mcp.destructive:srv/tool': 'allow' },
    ask: ['mcp.write:srv/*'],
  });
  const decide = (capabilities: string[] | undefined) => policy.decide({ tool: 'x', args: {}, capabilities }).decision;
  assert.equal(decide(of({ readOnlyHint: true, openWorldHint: false })), 'allow');
  assert.equal(decide(of({ destructiveHint: false, openWorldHint: false })), 'ask');
  assert.equal(decide(of({ openWorldHint: false })), 'allow', 'a destructive tool granted by its full name');
  assert.equal(decide(mcpToolCapabilities({ name: 'other', annotations: { openWorldHint: false } }, 'srv')), 'deny');
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

test('the package’s own MCP server says what its tools do, and its client reads it back', async () => {
  const run = async () => 'ok';
  const served = new McpServer({
    name: 'nexus',
    tools: [
      { name: 'pure', description: 'Adds', parameters: { type: 'object' }, capabilities: [], execute: run },
      {
        name: 'read',
        description: 'Reads',
        parameters: { type: 'object' },
        capabilities: ['filesystem:read:/repo/**'],
        execute: run,
      },
      {
        name: 'save',
        description: 'Writes',
        parameters: { type: 'object' },
        capabilities: ['filesystem:write:/repo/out'],
        execute: run,
      },
      {
        name: 'fetch',
        description: 'Fetches',
        parameters: { type: 'object' },
        capabilities: ['network:api.example.com'],
        execute: run,
      },
      {
        name: 'append',
        description: 'Appends',
        parameters: { type: 'object' },
        capabilities: ['mcp.write:notes/append'],
        execute: run,
      },
      {
        name: 'ask',
        description: 'Depends',
        parameters: { type: 'object' },
        capabilities: () => ['shell:ls'],
        execute: run,
      },
      { name: 'unsaid', description: 'Says nothing', parameters: { type: 'object' }, execute: run },
    ],
  });
  const [serverEnd, clientEnd] = linked();
  await served.connect(serverEnd);
  const client = new McpClient(clientEnd);
  const listed = await client.listTools();
  assert.deepEqual(
    Object.fromEntries(listed.map((tool) => [tool.name, tool.annotations])),
    {
      pure: { readOnlyHint: true, openWorldHint: false },
      read: { readOnlyHint: true, openWorldHint: false },
      save: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      fetch: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      append: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      ask: undefined,
      unsaid: undefined,
    },
    'never less than a tool may do',
  );
  const tools = await client.toNexusTools({ prefix: 'nx', capabilities: true });
  assert.deepEqual(Object.fromEntries(tools.map((tool) => [tool.name, tool.capabilities])), {
    nx_pure: ['mcp.read:nx/pure'],
    nx_read: ['mcp.read:nx/read'],
    nx_save: ['mcp.destructive:nx/save'],
    nx_fetch: ['mcp.destructive:nx/fetch', 'network'],
    nx_append: ['mcp.write:nx/append'],
    nx_ask: undefined,
    nx_unsaid: undefined,
  });
  // Without `capabilities`, nothing is declared, as before; with a function, it decides.
  assert.ok((await client.toNexusTools()).every((tool) => tool.capabilities === undefined));
  const decided = await client.toNexusTools({ capabilities: (tool) => (tool.name === 'pure' ? [] : undefined) });
  assert.deepEqual(decided.find((tool) => tool.name === 'pure')?.capabilities, []);
  assert.equal(decided.find((tool) => tool.name === 'read')?.capabilities, undefined);
  assert.equal(mcpToolAnnotations({ capabilities: ['payments:refund'] })?.openWorldHint, true);
  await client.close();
});

test('the SSE transport keeps to the stream’s origin, waits for its endpoint, and closes with the stream', async () => {
  // An endpoint on another origin is refused before anything is posted to it.
  const elsewhere = await sseServer({ endpoint: () => 'http://169.254.169.254/messages' });
  const posted: string[] = [];
  const watching: typeof fetch = (input, init) => {
    if (init?.method === 'POST') posted.push(String(input));
    return fetch(input, init);
  };
  const refused = new McpClient(createSseTransport({ url: elsewhere.url, fetch: watching }), { timeoutMs: 2_000 });
  await assert.rejects(refused.connect(), /endpoint on another origin, http:\/\/169\.254\.169\.254/);
  assert.deepEqual(posted, []);
  await refused.close();
  await elsewhere.close();

  // A stream that names no endpoint fails within its time, not never.
  const silent = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(': waiting\n\n');
  });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const quiet = new McpClient(
    createSseTransport({ url: `http://127.0.0.1:${(silent.address() as AddressInfo).port}/sse`, timeoutMs: 100 }),
  );
  await assert.rejects(quiet.connect(), /named no endpoint within 100ms/);
  await quiet.close();
  silent.closeAllConnections();
  await new Promise<void>((resolve) => silent.close(() => resolve()));

  // A stream that ends fails the call waiting on it, and the transport closes.
  const ending = await sseServer({ endAfter: 'tools/call' });
  const transport = createSseTransport({ url: ending.url });
  let closed = 0;
  transport.onClose?.(() => {
    closed += 1;
  });
  const client = new McpClient(transport, { timeoutMs: 5_000 });
  assert.equal((await client.listTools()).length, TOOLS.length, 'answers come on the stream');
  await assert.rejects(client.callTool('lookup'), /The MCP connection closed/);
  assert.equal(closed, 1, 'the transport closed once');
  await assert.rejects(client.callTool('lookup'), /closed/);
  await client.close();
  await ending.close();
});
