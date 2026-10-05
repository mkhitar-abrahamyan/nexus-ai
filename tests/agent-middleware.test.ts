/**
 * The agent middleware catalog, each piece in a real `createAgent()` loop with a scripted model:
 * retries and fallbacks around the model call, tool retries that never repeat a write, tool
 * selection, context editing, personal data, approvals per call, limits, and the filesystem as
 * context. Also the seam itself: `wrapModelCall`, `context.stop()`, and arguments a middleware
 * changes being decided again by the permission policy.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { type AgentMiddleware, agentInput, createAgent } from '../src/agent/create-agent.js';
import {
  contextEditor,
  dynamicModel,
  filesystemContext,
  humanApproval,
  limitToolCalls,
  ModelCallLimitError,
  modelCallLimit,
  modelFallback,
  modelRetry,
  PiiBlockedError,
  piiMiddleware,
  type ToolSelection,
  toolRetry,
  toolSelector,
} from '../src/agent/middleware/index.js';
import { permissionPolicy } from '../src/agent/permissions.js';
import { processSandbox, sandboxTools } from '../src/agent/sandbox.js';
import { tool } from '../src/agent/tool.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import { MemoryStore } from '../src/store/memory.js';
import type { CompletionRequest, Message, ToolDefinition } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'nexus-middleware-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const reply = (partial: Partial<NexusResponse>): NexusResponse =>
  ({ content: '', role: 'assistant', finishReason: 'stop', meta: {} as never, ...partial }) as NexusResponse;
const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
/** A client that answers from a script, one response per model call, and records each request. */
function scripted(script: Array<Partial<NexusResponse> | ((request: CompletionRequest) => Partial<NexusResponse>)>) {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    complete: async (request: CompletionRequest): Promise<NexusResponse> => {
      requests.push(request);
      const step = script[Math.min(requests.length - 1, script.length - 1)] ?? {};
      return reply(typeof step === 'function' ? step(request) : step);
    },
  };
}
const fail = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), extra);
const noWait = { initialMs: 0, jitter: false };

test('modelRetry retries a failed model call, and never one marked not retryable', async () => {
  let calls = 0;
  const flaky = {
    complete: async () => {
      calls += 1;
      if (calls < 3) throw fail('503 from the provider', { retryable: true });
      return reply({ content: 'third time' });
    },
  };
  const retries: number[] = [];
  const agent = createAgent({
    client: flaky,
    middleware: [modelRetry({ attempts: 3, backoff: noWait, onRetry: (event) => retries.push(event.attempt) })],
  });
  const result = await agent.invoke(agentInput('hi'));
  assert.equal(result.state.answer, 'third time');
  assert.deepEqual(retries, [1, 2]);

  let authCalls = 0;
  const denied = createAgent({
    client: {
      complete: async () => {
        authCalls += 1;
        throw fail('401 invalid key', { retryable: false });
      },
    },
    middleware: [modelRetry({ attempts: 5, backoff: noWait })],
  });
  await assert.rejects(denied.invoke(agentInput('hi')), /401 invalid key/);
  assert.equal(authCalls, 1, 'an error marked not retryable is thrown at once');

  // A response that arrived but is unusable can be retried too.
  const empty = scripted([{ content: '' }, { content: 'now with text' }]);
  const retried = await createAgent({
    client: empty,
    middleware: [modelRetry({ backoff: noWait, retryResponse: (response) => !response.content })],
  }).invoke(agentInput('hi'));
  assert.equal(retried.state.answer, 'now with text');
});

test('modelFallback moves to the next model, on the same client or another', async () => {
  const seen: string[] = [];
  const primary = {
    complete: async (request: CompletionRequest) => {
      seen.push(request.model);
      if (request.model !== 'backup') throw fail(`${request.model} is down`);
      return reply({ content: `answered by ${request.model}` });
    },
  };
  const events: string[] = [];
  const result = await createAgent({
    client: primary,
    model: 'main',
    middleware: [modelFallback(['backup'], { onFallback: (event) => events.push(`${event.from}->${event.to}`) })],
  }).invoke(agentInput('hi'));
  assert.equal(result.state.answer, 'answered by backup');
  assert.deepEqual(seen, ['main', 'backup']);
  assert.deepEqual(events, ['main->backup']);

  const other = scripted([{ content: 'answered by the other client' }]);
  const crossed = await createAgent({
    client: { complete: async () => Promise.reject(fail('everything is down')) },
    model: 'main',
    middleware: [modelFallback(['also-down', { client: other, model: 'elsewhere' }])],
  }).invoke(agentInput('hi'));
  assert.equal(crossed.state.answer, 'answered by the other client');
  assert.equal(other.requests[0]?.model, 'elsewhere');

  await assert.rejects(
    createAgent({
      client: { complete: async () => Promise.reject(fail('down')) },
      middleware: [modelFallback(['b'], { fallbackOn: () => false })],
    }).invoke(agentInput('hi')),
    /down/,
  );
  assert.throws(() => modelFallback([]), RangeError);
});

test('dynamicModel picks the model for each call from the run so far', async () => {
  const client = scripted([
    { toolCalls: [call('c1', 'noop', {})] },
    { toolCalls: [call('c2', 'noop', {})] },
    { content: 'done' },
  ]);
  await createAgent({
    client,
    model: 'small',
    tools: [
      tool({ name: 'noop', description: 'does nothing', parameters: { type: 'object' }, execute: async () => 'ok' }),
    ],
    middleware: [dynamicModel(({ state }) => (state.iterations >= 2 ? 'large' : undefined))],
  }).invoke(agentInput('hi'));
  assert.deepEqual(
    client.requests.map((request) => request.model),
    ['small', 'small', 'large'],
  );
});

test('toolRetry repeats a read that failed, and a write only when told to', async () => {
  let reads = 0;
  let writes = 0;
  const tools = [
    tool({
      name: 'read_page',
      description: 'reads',
      parameters: { type: 'object' },
      capabilities: ['filesystem:read'],
      execute: async () => {
        reads += 1;
        if (reads < 3) throw new Error('flaky disk');
        return 'page';
      },
    }),
    tool({
      name: 'charge',
      description: 'charges a card',
      parameters: { type: 'object' },
      capabilities: ['payments:charge'],
      execute: async () => {
        writes += 1;
        throw new Error('timed out after the charge landed');
      },
    }),
  ];
  const script = () =>
    scripted([{ toolCalls: [call('r', 'read_page', {}), call('w', 'charge', {})] }, { content: 'done' }]);
  const retried: string[] = [];
  const result = await createAgent({
    client: script(),
    tools,
    middleware: [toolRetry({ backoff: noWait, onRetry: (event) => retried.push(`${event.tool}#${event.attempt}`) })],
  }).invoke(agentInput('go'));
  assert.equal(reads, 3, 'the read ran until it succeeded');
  assert.equal(writes, 1, 'the charge was never repeated');
  assert.deepEqual(retried, ['read_page#1', 'read_page#2']);
  assert.match(String(result.state.messages.find((message) => message.toolCallId === 'r')?.content), /page/);

  reads = 0;
  writes = 0;
  await createAgent({
    client: script(),
    tools,
    middleware: [toolRetry({ tools: ['charge'], attempts: 2, backoff: noWait })],
  }).invoke(agentInput('go'));
  assert.equal(writes, 2, 'a tool named as idempotent is retried');
  assert.equal(reads, 1, 'and only the named tools are');
});

/** A deterministic embedding: hashed words, enough for a query that shares words with a tool. */
function bagOfWords(texts: string[]): number[][] {
  return texts.map((text) => {
    const vector = new Array(256).fill(0);
    for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      let hash = 0;
      for (const char of word) hash = (hash * 31 + char.charCodeAt(0)) % 256;
      vector[hash] += 1;
    }
    return vector;
  });
}

test('toolSelector sends only the tools the turn needs, and keeps the ones in use', async () => {
  const many: ToolDefinition[] = Array.from({ length: 40 }, (_, index) =>
    tool({
      name: `tool_${index}`,
      description: `Handles unrelated task number ${index}`,
      parameters: { type: 'object' },
      execute: async () => 'ok',
    }),
  );
  const weather = tool({
    name: 'get_weather',
    description: 'Gets the weather forecast for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } } },
    execute: async () => 'sunny',
  });
  const help = tool({
    name: 'help',
    description: 'Explains what the agent can do',
    parameters: { type: 'object' },
    execute: async () => 'help',
  });
  const tools = [...many, weather, help];
  let embedCalls = 0;
  const selections: ToolSelection[] = [];
  const client = scripted([
    (request) => ({
      toolCalls: request.tools?.some((offered) => offered.name === 'get_weather')
        ? [call('w1', 'get_weather', { city: 'Paris' })]
        : [],
    }),
    { toolCalls: [call('w2', 'tool_3', {})] },
    { content: 'Sunny in Paris' },
  ]);
  const result = await createAgent({
    client,
    tools,
    middleware: [
      toolSelector({
        embed: (texts) => {
          embedCalls += 1;
          return bagOfWords(texts);
        },
        maxTools: 4,
        always: ['help'],
        onSelect: (selection) => selections.push(selection),
      }),
    ],
  }).invoke(agentInput('What is the weather forecast in Paris?'));
  assert.equal(result.state.answer, 'Sunny in Paris');
  const first = client.requests[0]?.tools?.map((offered) => offered.name) ?? [];
  assert.equal(first.length, 4);
  assert.ok(first.includes('get_weather') && first.includes('help'));
  assert.equal(selections[0]?.offered, 42);
  const ranked = Object.entries(selections[0]?.scores ?? {}).sort((left, right) => right[1] - left[1]);
  assert.equal(ranked[0]?.[0], 'get_weather', 'the relevant tool ranks first');
  const third = client.requests[2]?.tools?.map((offered) => offered.name) ?? [];
  assert.ok(third.includes('get_weather') && third.includes('tool_3'), 'tools used this turn stay offered');
  // Tools are embedded once and the query once per turn: one call for the query, one for the tools.
  assert.equal(embedCalls, 2);

  // A rule alone, without embeddings.
  const ruled = scripted([{ content: 'ok' }]);
  await createAgent({
    client: ruled,
    tools,
    middleware: [toolSelector({ select: ({ query }) => (query.includes('weather') ? ['get_weather'] : []) })],
  }).invoke(agentInput('weather please'));
  assert.deepEqual(
    ruled.requests[0]?.tools?.map((offered) => offered.name),
    ['get_weather'],
  );
  assert.throws(() => toolSelector({}), TypeError);
});

test('contextEditor clears old tool results from the request in batches, and never from state', async () => {
  const big = 'x'.repeat(4_000);
  const results = 9;
  const client = scripted([
    ...Array.from({ length: results }, (_, index) => ({ toolCalls: [call(`c${index}`, 'fetch', { page: index })] })),
    { content: 'done' },
  ]);
  const edits: number[] = [];
  const result = await createAgent({
    client,
    maxIterations: 20,
    tools: [tool({ name: 'fetch', description: 'fetches', parameters: { type: 'object' }, execute: async () => big })],
    middleware: [
      contextEditor({ triggerTokens: 2_000, keepToolResults: 3, batch: 5, onEdit: (edit) => edits.push(edit.cleared) }),
    ],
  }).invoke(agentInput('read everything'));

  const last = client.requests.at(-1) as CompletionRequest;
  const tool_messages = last.messages.filter((message) => message.role === 'tool');
  const cleared = tool_messages.filter((message) => String(message.content).startsWith('[Cleared'));
  assert.equal(tool_messages.length, 9);
  assert.equal(cleared.length, 5, 'six are eligible, so one whole batch of five is cleared');
  assert.match(String(cleared[0]?.content), /the result of fetch, \d+ characters/);
  assert.ok(String(tool_messages.at(-1)?.content).includes('xxxx'), 'the most recent results are whole');
  assert.ok(
    result.state.messages
      .filter((message) => message.role === 'tool')
      .every((message) => String(message.content).includes('xxxx')),
    'the transcript in state keeps every result',
  );
  assert.ok(edits.length > 0);
});

test('piiMiddleware redacts, hashes, and blocks, and validates what it finds', async () => {
  const client = scripted([
    { toolCalls: [call('c1', 'lookup', {})] },
    { content: 'Your card ends in 1111. Mail me at a@b.co' },
  ]);
  const findings: string[] = [];
  const result = await createAgent({
    client,
    tools: [
      tool({
        name: 'lookup',
        description: 'looks up a customer',
        parameters: { type: 'object' },
        execute: async () => ({
          name: 'Ann',
          email: 'ann@example.com',
          phone: '+1 415 555 0100',
          order: '1234 5678 9012 3456',
        }),
      }),
    ],
    middleware: [
      piiMiddleware({
        strategy: { email: 'hash' },
        apply: { input: true, output: true, toolResults: true },
        onDetect: (finding) => findings.push(`${finding.where}:${finding.kind}`),
      }),
    ],
  }).invoke(agentInput('My card is 4111 1111 1111 1111 and my email is ann@example.com'));

  const sent = String(client.requests[0]?.messages.at(-1)?.content);
  assert.match(sent, /\[credit-card\]/);
  assert.match(sent, /\[email:[0-9a-f]{8}\]/);
  assert.doesNotMatch(sent, /4111|ann@example\.com/);
  const toolMessage = String(result.state.messages.find((message) => message.role === 'tool')?.content);
  assert.match(toolMessage, /\[phone\]/);
  assert.match(toolMessage, /1234 5678 9012 3456/, 'a number that fails Luhn is not a card');
  assert.equal(
    toolMessage.match(/\[email:([0-9a-f]{8})\]/)?.[1],
    sent.match(/\[email:([0-9a-f]{8})\]/)?.[1],
    'the same value hashes to the same token',
  );
  assert.match(result.state.answer, /\[email:/, 'the answer is cleaned too');
  assert.ok(findings.includes('tool:phone') && findings.includes('input:credit-card'));

  const blocked = createAgent({
    client: scripted([{ content: 'never' }]),
    middleware: [piiMiddleware({ strategy: 'block', kinds: ['secret'] })],
  });
  await assert.rejects(blocked.invoke(agentInput('key sk-abcdefghijklmnopqrstuvwx')), (error: Error) => {
    assert.ok(error.cause instanceof PiiBlockedError);
    assert.equal((error.cause as PiiBlockedError).kind, 'secret');
    return true;
  });

  const custom = scripted([{ content: 'ok' }]);
  await createAgent({
    client: custom,
    middleware: [piiMiddleware({ kinds: [], patterns: { employee: /\bEMP-\d{6}\b/ } })],
  }).invoke(agentInput('I am EMP-123456'));
  assert.match(String(custom.requests[0]?.messages.at(-1)?.content), /I am \[employee\]/);
});

test('humanApproval asks per call, and an edited call is decided again by the policy', async () => {
  let refunded: number[] = [];
  const refund = tool({
    name: 'refund',
    description: 'refunds an order',
    parameters: { type: 'object', properties: { amount: { type: 'number' } } },
    capabilities: (args) => [`payments:refund:${Number(args.amount) > 500 ? 'large' : 'small'}`],
    execute: async ({ amount }) => {
      refunded.push(Number(amount));
      return 'refunded';
    },
  });
  const script = () =>
    scripted([
      { toolCalls: [call('a', 'refund', { amount: 20 }), call('b', 'refund', { amount: 300 })] },
      { content: 'done' },
    ]);
  const agent = createAgent({
    client: script(),
    tools: [refund],
    checkpointer: new MemoryGraphCheckpointer(),
    permissions: permissionPolicy({ custom: { 'payments:refund:small': 'allow', 'payments:refund:large': 'deny' } }),
    middleware: [humanApproval({ when: (pending) => Number(pending.args.amount) > 100 })],
  });
  const paused = await agent.invoke(agentInput('refund both'), { threadId: 'refunds' });
  assert.equal(paused.status, 'awaiting_input');
  assert.match(String(paused.interrupt?.reason), /"amount":300/);
  assert.deepEqual(refunded, [20], 'the small refund ran without asking');

  // The approver raises the amount past what the policy allows: the edit is refused, not run.
  const done = await agent.resumeWith('refunds', { approved: true, args: { amount: 900 } });
  assert.equal(done.status, 'completed');
  assert.ok(refunded.includes(20) && !refunded.includes(900), 'the edited refund never ran');
  assert.match(String(done.state.messages.find((message) => message.toolCallId === 'b')?.content), /Permission denied/);

  // Out of band, with no interrupt.
  refunded = [];
  const asked: string[] = [];
  const outOfBand = await createAgent({
    client: script(),
    tools: [refund],
    middleware: [
      humanApproval({
        approve: (pending) => {
          asked.push(String(pending.args.amount));
          return Number(pending.args.amount) < 100 ? true : { approved: false, reason: 'too much' };
        },
      }),
    ],
  }).invoke(agentInput('refund both'));
  assert.equal(outOfBand.status, 'completed');
  assert.deepEqual(asked.sort(), ['20', '300'], 'both declare a custom capability, so both are asked about');
  assert.deepEqual(refunded, [20]);
  assert.match(String(outOfBand.state.messages.find((message) => message.toolCallId === 'b')?.content), /too much/);
});

test('modelCallLimit ends a run with an answer, or fails it, per run and per thread', async () => {
  const looping = () => scripted([(request) => ({ toolCalls: [call(`c${request.messages.length}`, 'noop', {})] })]);
  const noop = tool({
    name: 'noop',
    description: 'does nothing',
    parameters: { type: 'object' },
    execute: async () => 'ok',
  });

  const client = looping();
  const ended = await createAgent({
    client,
    tools: [noop],
    maxIterations: 50,
    middleware: [modelCallLimit({ run: 3 })],
  }).invoke(agentInput('loop'));
  assert.equal(ended.state.stopReason, 'stopped');
  assert.match(ended.state.answer, /limit of 3 model calls/);
  assert.equal(client.requests.length, 3, 'the call past the limit never reached the model');

  await assert.rejects(
    createAgent({
      client: looping(),
      tools: [noop],
      maxIterations: 50,
      middleware: [modelCallLimit({ run: 2, onLimit: 'error' })],
    }).invoke(agentInput('loop')),
    (error: Error) =>
      error.cause instanceof ModelCallLimitError && (error.cause as ModelCallLimitError).scope === 'run',
  );

  // A thread limit spans runs, counted in the store, so two processes sharing it share the budget.
  const chat = scripted([{ content: 'answer' }]);
  const store = new MemoryStore();
  const limit = () => [modelCallLimit({ run: 1, thread: 2, message: 'This conversation is over its budget.' })];
  const first = createAgent({ client: chat, store, middleware: limit() });
  const second = createAgent({ client: chat, store, middleware: limit() });
  assert.equal((await first.invoke(agentInput('one'), { threadId: 't' })).state.answer, 'answer');
  assert.equal((await second.invoke(agentInput('two'), { threadId: 't' })).state.answer, 'answer');
  const third = await first.invoke(agentInput('three'), { threadId: 't' });
  assert.equal(third.state.answer, 'This conversation is over its budget.');
  assert.equal(third.state.stopReason, 'stopped');
  assert.equal((await second.invoke(agentInput('elsewhere'), { threadId: 'other' })).state.answer, 'answer');
  assert.equal(chat.requests.length, 3);

  // Without a store, the thread count is kept in this process.
  const solo = scripted([{ content: 'answer' }]);
  const local = createAgent({ client: solo, middleware: [modelCallLimit({ thread: 1 })] });
  await local.invoke(agentInput('one'), { threadId: 'mine' });
  assert.match(
    (await local.invoke(agentInput('two'), { threadId: 'mine' })).state.answer,
    /thread reached its limit of 1/,
  );
  assert.throws(() => modelCallLimit({}), RangeError);
});

test('limitToolCalls counts per run from the transcript, so threads never share a count', async () => {
  let runs = 0;
  const peek = tool({
    name: 'peek',
    description: 'peeks',
    parameters: { type: 'object' },
    execute: async () => {
      runs += 1;
      return 'peeked';
    },
  });
  const agent = createAgent({
    client: {
      complete: async (request: CompletionRequest) =>
        reply(
          request.messages.filter((message) => message.role === 'tool').length >= 2
            ? { content: 'done' }
            : { toolCalls: [call(`p${request.messages.length}`, 'peek', {})] },
        ),
    },
    tools: [peek],
    checkpointer: new MemoryGraphCheckpointer(),
    middleware: [limitToolCalls({ peek: 1 })],
  });
  await Promise.all([
    agent.invoke(agentInput('a'), { threadId: 'one' }),
    agent.invoke(agentInput('b'), { threadId: 'two' }),
  ]);
  assert.equal(runs, 2, 'each thread ran peek once; a shared count would have refused the second thread');
});

test('filesystemContext puts instruction files in context and offloads a large result to a file', async () => {
  const root = path.join(scratch, 'fs-context');
  const sandbox = processSandbox({ root });
  await sandbox.writeFile('AGENTS.md', 'Always answer in French.');
  const huge = 'line of output\n'.repeat(3_000);
  const client = scripted([
    { toolCalls: [call('c1', 'dump', {})] },
    { toolCalls: [call('c2', 'read_file', { path: '/workspace/.context/dump-c1.txt' })] },
    { content: 'fini' },
  ]);
  const result = await createAgent({
    client,
    systemPrompt: 'You are helpful.',
    tools: [
      ...sandboxTools(sandbox, { shell: false }),
      tool({ name: 'dump', description: 'dumps a log', parameters: { type: 'object' }, execute: async () => huge }),
    ],
    middleware: [
      filesystemContext({
        source: sandbox,
        include: ['AGENTS.md', 'missing.md'],
        listing: {},
        offload: { overChars: 5_000 },
      }),
    ],
  }).invoke(agentInput('summarize the log'));

  const first = client.requests[0]?.messages as Message[];
  assert.equal(first[0]?.content, 'You are helpful.');
  assert.match(String(first[1]?.content), /<file path="AGENTS.md">\nAlways answer in French\./);
  assert.match(String(first[1]?.content), /<listing directory="\.">[\s\S]*AGENTS\.md/);
  assert.ok(!String(first[1]?.content).includes('missing.md'), 'a missing file is skipped');

  const offloaded = String(result.state.messages.find((message) => message.toolCallId === 'c1')?.content);
  assert.ok(offloaded.length < 2_000, 'the transcript holds a preview, not the whole result');
  assert.match(offloaded, /\.context\/dump-c1\.txt/);
  assert.equal(readFileSync(path.join(root, '.context', 'dump-c1.txt'), 'utf8'), huge);
  const readBack = String(result.state.messages.find((message) => message.toolCallId === 'c2')?.content);
  assert.ok(readBack.length > huge.length - 10, 'reading the file back is never offloaded again');
  assert.equal(result.state.answer, 'fini');
  assert.throws(() => filesystemContext({ source: { readFile: async () => '' }, offload: true }), TypeError);
});

test('wrapModelCall wraps the call, stop() ends the run, and a changed tool call is decided again', async () => {
  const order: string[] = [];
  const outer: AgentMiddleware = {
    async wrapModelCall(request, next) {
      order.push('outer');
      return next({ ...request, temperature: 0.1 });
    },
  };
  const inner: AgentMiddleware = {
    async wrapModelCall(request, next, context) {
      order.push(`inner:${request.temperature}`);
      if (context.state.messages.some((message) => message.content === 'stop now'))
        return context.stop('Stopped early.');
      return next(request);
    },
  };
  const client = scripted([{ content: 'normal' }]);
  const agent = createAgent({ client, middleware: [outer, inner] });
  assert.equal((await agent.invoke(agentInput('hello'))).state.answer, 'normal');
  assert.deepEqual(order, ['outer', 'inner:0.1']);
  const stopped = await agent.invoke(agentInput('stop now'));
  assert.equal(stopped.state.stopReason, 'stopped');
  assert.equal(stopped.state.answer, 'Stopped early.');
  assert.equal(client.requests.length, 1);

  const root = path.join(scratch, 'redirect');
  const sandbox = processSandbox({ root });
  const redirect: AgentMiddleware = {
    wrapToolCall: (pending, next) => next({ ...pending, args: { ...pending.args, path: '../../escape.txt' } }),
  };
  const result = await createAgent({
    client: scripted([{ toolCalls: [call('w', 'write_file', { path: 'ok.txt', content: 'x' })] }, { content: 'done' }]),
    tools: sandboxTools(sandbox, { shell: false }),
    permissions: permissionPolicy({ filesystem: { write: ['/workspace/**'] } }),
    middleware: [redirect],
  }).invoke(agentInput('write'));
  assert.match(
    String(result.state.messages.find((message) => message.toolCallId === 'w')?.content),
    /Permission denied/,
  );
  assert.ok(!existsSync(path.join(root, '..', '..', 'escape.txt')));
});
