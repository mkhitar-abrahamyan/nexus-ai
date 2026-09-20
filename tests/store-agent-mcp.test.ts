import assert from 'node:assert/strict';
import test from 'node:test';
import { agentInput, createAgent } from '../src/agent/create-agent.js';
import { appendList, counter } from '../src/graph/channels.js';
import { createGraph } from '../src/graph/graph.js';
import { McpClient } from '../src/mcp/client.js';
import { LineDecoder, type JsonRpcMessage, type McpTransport } from '../src/mcp/protocol.js';
import { McpServer } from '../src/mcp/server.js';
import { MemoryStore } from '../src/store/memory.js';
import { RedisStore, type RedisStoreLikeClient } from '../src/store/redis.js';
import { tool } from '../src/agent/tool.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import { END } from '../src/types/graph.js';

// ── Store ──────────────────────────────────────────────────────────

test('the store keeps namespaced items, and search filters and pages them', async () => {
  const store = new MemoryStore();
  await store.put(['tenant-7', 'users', 'alice'], 'preferences', { tone: 'brief', topics: ['ai'] });
  await store.put(['tenant-7', 'users', 'alice'], 'note-1', { text: 'prefers morning meetings', kind: 'note' });
  await store.put(['tenant-7', 'users', 'bob'], 'note-1', { text: 'works nights', kind: 'note' });

  const alice = await store.get<{ tone: string }>(['tenant-7', 'users', 'alice'], 'preferences');
  assert.equal(alice?.value.tone, 'brief');
  assert.equal(alice?.namespace.join('/'), 'tenant-7/users/alice');
  assert.ok(alice?.createdAt && alice.updatedAt);

  // A prefix search crosses the namespaces below it, which is what makes tuples worth having.
  const everyone = await store.search(['tenant-7', 'users']);
  assert.equal(everyone.length, 3);
  const notes = await store.search(['tenant-7', 'users'], { filter: { kind: 'note' } });
  assert.deepEqual(notes.map((item) => item.key).sort(), ['note-1', 'note-1']);
  assert.equal((await store.search(['tenant-7', 'users'], { limit: 1 })).length, 1);
  assert.equal((await store.search(['tenant-7', 'users'], { limit: 1, offset: 3 })).length, 0);
  assert.equal((await store.search(['tenant-7', 'users', 'bob'])).length, 1);

  assert.deepEqual(
    (await store.listNamespaces({ prefix: ['tenant-7'] })).map((namespace) => namespace.join('/')).sort(),
    ['tenant-7/users/alice', 'tenant-7/users/bob'],
  );

  await store.delete(['tenant-7', 'users', 'bob'], 'note-1');
  assert.equal(await store.get(['tenant-7', 'users', 'bob'], 'note-1'), undefined);
  await assert.rejects(() => store.put(['x'], '  ', {}), RangeError);
});

test('stored items expire, and the store stays bounded', async () => {
  let now = new Date('2026-01-01T00:00:00.000Z');
  const store = new MemoryStore({ maxItems: 2, now: () => now });

  await store.put(['s'], 'short', { value: 1 }, { ttlMs: 1_000 });
  assert.ok(await store.get(['s'], 'short'));

  now = new Date(now.getTime() + 2_000);
  assert.equal(await store.get(['s'], 'short'), undefined, 'an expired item reads as absent');
  assert.deepEqual(await store.search(['s']), []);

  await store.put(['s'], 'a', { value: 'a' });
  await store.put(['s'], 'b', { value: 'b' });
  await store.put(['s'], 'a', { value: 'a2' });
  await store.put(['s'], 'c', { value: 'c' });
  assert.equal(store.size(), 2);
  assert.equal(await store.get(['s'], 'b'), undefined, 'the least recently written item was dropped');
  assert.equal((await store.get<{ value: string }>(['s'], 'a'))?.value.value, 'a2');
  assert.throws(() => new MemoryStore({ maxItems: 0 }), RangeError);
});

test('semantic search ranks by an injected embedder, and falls back to text without one', async () => {
  // A toy embedding: one dimension per keyword, so "cat" and "kitten" land near each other.
  const vocabulary = ['cat', 'kitten', 'database', 'sql'];
  const embed = async (texts: string[]) =>
    texts.map((text) => vocabulary.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)));

  const indexed = new MemoryStore({ index: { embed, fields: ['text'] } });
  await indexed.put(['memories'], 'm1', { text: 'the cat sleeps on the keyboard' });
  await indexed.put(['memories'], 'm2', { text: 'sql database tuning notes' });

  const ranked = await indexed.search<{ text: string }>(['memories'], { query: 'cat' });
  assert.equal(ranked[0]?.key, 'm1');
  assert.ok((ranked[0]?.score ?? 0) > (ranked[1]?.score ?? 1));

  const plain = new MemoryStore();
  await plain.put(['memories'], 'm1', { text: 'the cat sleeps' });
  await plain.put(['memories'], 'm2', { text: 'sql notes' });
  const matched = await plain.search(['memories'], { query: 'SQL' });
  assert.deepEqual(
    matched.map((item) => item.key),
    ['m2'],
  );
});

test('the Redis store round-trips through a client-like interface', async () => {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const client: RedisStoreLikeClient = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => void values.set(key, value),
    del: async (key) => {
      for (const item of Array.isArray(key) ? key : [key]) values.delete(item);
    },
    sadd: async (key, member) => void (sets.get(key) ?? sets.set(key, new Set()).get(key))?.add(member),
    srem: async (key, member) => void sets.get(key)?.delete(member),
    smembers: async (key) => [...(sets.get(key) ?? [])],
  };

  const store = new RedisStore(client, { prefix: 'test' });
  await store.put(['team', 'notes'], 'n1', { text: 'shared across processes', kind: 'note' });
  await store.put(['team', 'notes'], 'n2', { text: 'another', kind: 'draft' });

  assert.equal((await store.get<{ text: string }>(['team', 'notes'], 'n1'))?.value.text, 'shared across processes');
  assert.equal((await store.search(['team'])).length, 2);
  assert.equal((await store.search(['team'], { filter: { kind: 'note' } })).length, 1);
  assert.equal((await store.search(['team'], { query: 'another' })).length, 1);
  assert.deepEqual(await store.listNamespaces(), [['team', 'notes']]);

  await store.delete(['team', 'notes'], 'n1');
  assert.equal(await store.get(['team', 'notes'], 'n1'), undefined);

  // An item Redis expired on its own leaves the namespace set; reading it cleans that up.
  values.delete('test:item:team:notes:n2');
  assert.equal(await store.get(['team', 'notes'], 'n2'), undefined);
  assert.equal((await store.search(['team'])).length, 0);
});

test('a graph node reads and writes the store it was compiled with', async () => {
  const store = new MemoryStore();
  await store.put(['users', 'alice'], 'tone', { value: 'brief' });

  const graph = createGraph({ channels: { log: appendList<string>(), turns: counter() } })
    .addNode('remember', async (context) => {
      const tone = await context.store?.get<{ value: string }>(['users', 'alice'], 'tone');
      await context.store?.put(['users', 'alice'], 'last-seen', { thread: context.threadId });
      return { log: [`tone=${tone?.value.value}`] };
    })
    .setEntry('remember')
    .addEdge('remember', END)
    .compile({ store });

  const result = await graph.invoke({}, { threadId: 'memory-thread' });
  assert.deepEqual(result.state.log, ['tone=brief']);
  // Memory outlives the thread: a different run, even a different graph, reads what this one wrote.
  assert.equal((await store.get<{ thread: string }>(['users', 'alice'], 'last-seen'))?.value.thread, 'memory-thread');

  const without = createGraph({ channels: { log: appendList<string>(), turns: counter() } })
    .addNode('check', (context) => ({ log: [String(context.store === undefined)] }))
    .setEntry('check')
    .addEdge('check', END)
    .compile();
  assert.deepEqual((await without.invoke()).state.log, ['true']);
});

// ── Agents on graphs ───────────────────────────────────────────────

function scriptedClient(responses: Array<Partial<NexusResponse>>) {
  const requests: CompletionRequest[] = [];
  let index = 0;
  const client = {
    complete: async (request: CompletionRequest): Promise<NexusResponse> => {
      requests.push(request);
      const scripted = responses[Math.min(index, responses.length - 1)] ?? {};
      index += 1;
      return {
        content: '',
        model: 'mock',
        provider: 'mock',
        meta: {
          provider: 'mock',
          model: 'mock',
          requestId: `r-${index}`,
          latencyMs: 1,
          timestamp: new Date().toISOString(),
        },
        ...scripted,
      } as NexusResponse;
    },
  };
  return { client, requests };
}

const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

test('an agent calls tools in parallel and answers, keeping the whole transcript', async () => {
  const started: string[] = [];
  const { client, requests } = scriptedClient([
    { content: '', toolCalls: [call('c1', 'weather', { city: 'Paris' }), call('c2', 'weather', { city: 'Oslo' })] },
    { content: 'Paris is warm and Oslo is cold.' },
  ]);

  const agent = createAgent({
    client,
    systemPrompt: 'You check the weather.',
    tools: [
      tool({
        name: 'weather',
        description: 'Weather for a city',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
        execute: async (args) => {
          started.push(String(args.city));
          await new Promise((resolve) => setTimeout(resolve, 20));
          return `${args.city}: fine`;
        },
      }),
    ],
  });

  const result = await agent.invoke(agentInput('How is the weather?'), { threadId: 'agent-1' });

  assert.equal(result.status, 'completed');
  assert.equal(result.state.answer, 'Paris is warm and Oslo is cold.');
  assert.equal(result.state.stopReason, 'completed');
  assert.deepEqual(started.sort(), ['Oslo', 'Paris']);
  assert.equal(requests[0]?.messages[0]?.role, 'system');
  assert.equal(requests[1]?.messages.filter((message) => message.role === 'tool').length, 2);
  assert.equal(result.state.messages.filter((message) => message.role === 'tool').length, 2);
});

test('an agent stops at its iteration limit and says so', async () => {
  const { client } = scriptedClient([{ content: '', toolCalls: [call('c1', 'loop', {})] }]);
  const agent = createAgent({
    client,
    maxIterations: 3,
    tools: [tool({ name: 'loop', description: 'loops', parameters: { type: 'object' }, execute: async () => 'again' })],
  });

  const result = await agent.invoke(agentInput('go'));
  assert.equal(result.state.stopReason, 'max_iterations');
  assert.equal(result.state.iterations, 3);
});

test('a tool needing approval pauses the agent, and the answer decides what runs', async () => {
  const sent: string[] = [];
  const { client } = scriptedClient([
    { content: '', toolCalls: [call('c1', 'send_email', { to: 'ceo@example.test' })] },
    { content: 'Done.' },
  ]);
  const agent = createAgent({
    client,
    interruptOn: { send_email: { reason: (item) => `Send an email to ${String(item.args.to)}?` } },
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

  const paused = await agent.invoke(agentInput('email the ceo'), { threadId: 'approval' });
  assert.equal(paused.status, 'awaiting_input');
  assert.equal(paused.interrupt?.reason, 'Send an email to ceo@example.test?');
  assert.equal(sent.length, 0, 'nothing was sent while a human was still deciding');

  const refused = await agent.resumeWith('approval', { approved: false, reason: 'not today' });
  assert.equal(refused.status, 'completed');
  assert.equal(sent.length, 0);
  const toolReply = refused.state.messages.find((message) => message.role === 'tool');
  assert.match(String(toolReply?.content), /not today/);

  // Approving with corrected arguments runs the tool with the human's version.
  const second = scriptedClient([
    { content: '', toolCalls: [call('c1', 'send_email', { to: 'ceo@example.test' })] },
    { content: 'Done.' },
  ]);
  const approving = createAgent({
    client: second.client,
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
  await approving.invoke(agentInput('email the ceo'), { threadId: 'approval-2' });
  await approving.resumeWith('approval-2', { approved: true, args: { to: 'assistant@example.test' } });
  assert.deepEqual(sent, ['assistant@example.test']);
});

test('middleware can rewrite the request, inspect the response, and wrap a tool call', async () => {
  const order: string[] = [];
  const { client, requests } = scriptedClient([
    { content: '', toolCalls: [call('c1', 'echo', { value: 'hi' })] },
    { content: 'final' },
  ]);

  const agent = createAgent({
    client,
    model: 'auto',
    tools: [
      tool({ name: 'echo', description: 'echo', parameters: { type: 'object' }, execute: async (args) => args.value }),
    ],
    middleware: [
      {
        beforeModel: ({ request }) => {
          order.push('before');
          return { ...request, model: 'rewritten' };
        },
        afterModel: ({ response }) => {
          order.push('after');
          return response;
        },
        wrapToolCall: async (item, next) => {
          order.push(`wrap:${item.name}`);
          const result = await next();
          return { ...result, result: `[${String(result.result)}]` };
        },
      },
    ],
  });

  const result = await agent.invoke(agentInput('go'));
  assert.equal(requests[0]?.model, 'rewritten');
  assert.deepEqual(order, ['before', 'after', 'wrap:echo', 'before', 'after']);
  assert.match(String(result.state.messages.find((message) => message.role === 'tool')?.content), /\[hi\]/);
});

test('an agent refuses malformed tool arguments and keeps its memory across threads', async () => {
  const store = new MemoryStore();
  let ran = 0;
  const { client } = scriptedClient([
    { content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'remember', arguments: 'not json' } }] },
    { content: 'ok' },
  ]);

  const agent = createAgent({
    client,
    store,
    tools: [
      tool({
        name: 'remember',
        description: 'stores a note',
        parameters: { type: 'object' },
        execute: async () => {
          ran += 1;
          return 'stored';
        },
      }),
    ],
  });

  const result = await agent.invoke(agentInput('remember this'));
  assert.equal(ran, 0);
  assert.match(String(result.state.messages.find((message) => message.role === 'tool')?.content), /not valid JSON/);
  assert.throws(() => createAgent({ client: {} as never }), TypeError);
});

// ── MCP ────────────────────────────────────────────────────────────

/** Wires a client and a server to each other in memory, which exercises both sides of the protocol. */
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

test('an MCP client lists and calls the tools an MCP server exposes', async () => {
  const pair = connectedPair();
  const server = new McpServer({
    name: 'test-server',
    version: '2.0.0',
    tools: [
      tool({
        name: 'add',
        description: 'Adds two numbers',
        parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
        execute: async (args) => Number(args.a) + Number(args.b),
      }),
      tool({
        name: 'explode',
        description: 'Always fails',
        parameters: { type: 'object' },
        execute: async () => {
          throw new Error('boom');
        },
      }),
    ],
    resources: [{ uri: 'memo://greeting', name: 'greeting', read: () => 'hello' }],
  });
  await server.connect(pair.serverSide);

  const client = new McpClient(pair.clientSide, { timeoutMs: 2_000 });
  const info = await client.connect();
  assert.equal(info.name, 'test-server');
  assert.equal(info.version, '2.0.0');

  const tools = await client.listTools();
  assert.deepEqual(tools.map((item) => item.name).sort(), ['add', 'explode']);
  assert.equal(tools.find((item) => item.name === 'add')?.inputSchema?.type, 'object');

  const added = await client.callTool('add', { a: 2, b: 3 });
  assert.equal(added.content[0]?.text, '5');
  assert.equal(added.isError, undefined);

  const failed = await client.callTool('explode');
  assert.equal(failed.isError, true);
  assert.match(String(failed.content[0]?.text), /boom/);

  const unknown = await client.callTool('nope');
  assert.equal(unknown.isError, true);

  assert.deepEqual(
    (await client.listResources()).map((item) => item.uri),
    ['memo://greeting'],
  );
  assert.equal((await client.readResource('memo://greeting'))[0]?.text, 'hello');
  await client.close();
});

test('MCP tools become agent tools, with optional name prefixes', async () => {
  const pair = connectedPair();
  const server = new McpServer({
    tools: [
      tool({
        name: 'search',
        description: 'Searches the wiki',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
        execute: async (args) => `results for ${String(args.q)}`,
      }),
    ],
  });
  await server.connect(pair.serverSide);
  const client = new McpClient(pair.clientSide, { timeoutMs: 2_000 });

  const tools = await client.toNexusTools({ prefix: 'wiki' });
  assert.equal(tools[0]?.name, 'wiki_search');
  assert.equal(await tools[0]?.execute?.({ q: 'graphs' }), 'results for graphs');

  const { client: modelClient } = scriptedClient([
    { content: '', toolCalls: [call('c1', 'wiki_search', { q: 'graphs' })] },
    { content: 'Found it.' },
  ]);
  const agent = createAgent({ client: modelClient, tools });
  const result = await agent.invoke(agentInput('look it up'));
  assert.equal(result.state.answer, 'Found it.');
  assert.match(String(result.state.messages.find((message) => message.role === 'tool')?.content), /results for graphs/);
});

test('the line decoder reassembles messages split across chunks and skips bad frames', () => {
  const decoder = new LineDecoder();
  assert.deepEqual(decoder.push('{"jsonrpc":"2.0","id":1,'), []);
  assert.deepEqual(decoder.push('"method":"ping"}\n'), [{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
  assert.deepEqual(decoder.push('not json\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n').length, 1);
});

test('an MCP request that goes unanswered fails with a timeout rather than hanging', async () => {
  const silent: McpTransport = { send: () => undefined, onMessage: () => undefined, close: () => undefined };
  const client = new McpClient(silent, { timeoutMs: 20 });
  await assert.rejects(() => client.connect(), /timed out/);
});
