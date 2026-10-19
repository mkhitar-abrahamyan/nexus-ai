/**
 * Tools emulated by a model, for evaluations that must not touch the world.
 *
 * A shop of the test's own serves orders and takes refunds over HTTP, recording every request. A
 * support agent looks an order up and refunds it, refuses one not yet delivered, escalates one above
 * $100, and reports a refund the shop refuses. Evaluated over the real tools, and then over the same
 * tools emulated by a model told each example's scenario, it reaches the same verdict on every
 * example, and the emulated run sends the shop nothing. Replayed from the answers the emulated run
 * kept, it reaches that verdict again without asking the emulator anything.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { agentInput, createAgent } from '../src/agent/create-agent.js';
import { ToolExecutor, tool } from '../src/agent/tool.js';
import { createDataset } from '../src/evaluate/datasets.js';
import {
  type EmulatedToolCall,
  EmulationError,
  emulatedTools,
  emulationKey,
  MemoryEmulationStore,
} from '../src/evaluate/emulate.js';
import { trajectory } from '../src/evaluate/evaluators.js';
import { evaluate } from '../src/evaluate/run.js';
import type { Evaluator, Experiment } from '../src/types/evaluate.js';
import type { CompletionRequest, Message, ToolDefinition } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

/** The shop: orders, refunds already made, and every request it received. */
const shop = {
  url: '',
  requests: [] as string[],
  orders: {
    '1042': { status: 'delivered', total: 59 },
    '2001': { status: 'shipped', total: 30 },
    '3007': { status: 'delivered', total: 250 },
    '4410': { status: 'delivered', total: 20 },
  } as Record<string, { status: string; total: number }>,
  refunded: new Set(['4410']),
};
let server: ReturnType<typeof createServer>;

before(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      shop.requests.push(`${request.method} ${request.url}`);
      const json = (status: number, value: unknown) =>
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      const order = /^\/orders\/(\w+)$/.exec(request.url ?? '');
      if (request.method === 'GET' && order) {
        const found = shop.orders[order[1] as string];
        return found ? json(200, { id: order[1], ...found }) : json(404, { error: 'no such order' });
      }
      if (request.method === 'POST' && request.url === '/refunds') {
        const { orderId, amount } = JSON.parse(body) as { orderId: string; amount: number };
        if (shop.refunded.has(orderId)) return json(409, { error: 'already refunded' });
        shop.refunded.add(orderId);
        return json(200, { refundId: `r-${orderId}`, amount });
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  shop.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

/** The real tools: each sends the shop a request. */
function shopTools(): ToolDefinition[] {
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${shop.url}${path}`, init);
    const value = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(value.error));
    return value;
  };
  return [
    tool<{ orderId: string }>({
      name: 'lookup_order',
      description: 'Looks an order up: its status and its total in US dollars.',
      parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
      capabilities: ['network'],
      execute: ({ orderId }) => call(`/orders/${orderId}`),
    }),
    tool<{ orderId: string; amount: number }>({
      name: 'refund',
      description: 'Refunds an order to the card it was paid with.',
      parameters: {
        type: 'object',
        properties: { orderId: { type: 'string' }, amount: { type: 'number' } },
        required: ['orderId', 'amount'],
      },
      capabilities: ['payments'],
      execute: (args) =>
        call('/refunds', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args),
        }),
    }),
  ];
}

const answer = (content: string) => ({ content, role: 'assistant', finishReason: 'stop', meta: {} }) as NexusResponse;
const callTool = (name: string, args: Record<string, unknown>, id: string) =>
  ({
    content: '',
    role: 'assistant',
    finishReason: 'tool_calls',
    toolCalls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    meta: {},
  }) as unknown as NexusResponse;
const text = (message: Message | undefined) => (typeof message?.content === 'string' ? message.content : '');

/** The support agent's model: it decides from what each tool returned. */
const supportModel = {
  async complete(request: CompletionRequest): Promise<NexusResponse> {
    const orderId = /order (\w+)/.exec(text(request.messages.find((message) => message.role === 'user')))?.[1] ?? '';
    const results = request.messages
      .filter((message) => message.role === 'tool')
      .map((message) => JSON.parse(text(message)));
    const [order, refund] = results as Array<Record<string, unknown>>;
    if (!order) return callTool('lookup_order', { orderId }, 'c1');
    if (order.error) return answer(`I could not find order ${orderId}: ${order.error}.`);
    if (order.status !== 'delivered')
      return answer(`Order ${orderId} is ${order.status}; it can be refunded once delivered.`);
    if (Number(order.total) > 100)
      return answer(`Order ${orderId} cost $${order.total}, above $100: escalated to a person.`);
    if (!refund) return callTool('refund', { orderId, amount: order.total }, 'c2');
    if (refund.error) return answer(`Refund failed: ${refund.error}.`);
    return answer(`Refunded $${refund.amount} for order ${orderId}.`);
  },
};

/**
 * The emulator's model: it plays a tool from what it is told, the tool, the scenario, and the
 * arguments, as a model would, reading the scenario's sentences.
 */
function emulatorModel() {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    async complete(request: CompletionRequest): Promise<NexusResponse> {
      requests.push(request);
      const brief = text(request.messages[0]);
      const toolName = /^Tool: (\w+)$/m.exec(brief)?.[1];
      const scenario = /^Scenario: (.*)$/m.exec(brief)?.[1] ?? '';
      const args = JSON.parse(text(request.messages[1]).replace(/^Arguments: /, '')) as Record<string, unknown>;
      const described = new RegExp(`Order ${args.orderId} is (\\w+) and cost \\$(\\d+)`).exec(scenario);
      if (toolName === 'lookup_order') {
        if (!described) return answer(JSON.stringify({ error: 'no such order' }));
        return answer(
          JSON.stringify({ result: { id: args.orderId, status: described[1], total: Number(described[2]) } }),
        );
      }
      if (/already refunded/.test(scenario)) return answer(JSON.stringify({ error: 'already refunded' }));
      return answer(JSON.stringify({ result: { refundId: `r-${args.orderId}`, amount: args.amount } }));
    },
  };
}

type Inputs = { request: string };
const dataset = createDataset<Inputs, string>({
  name: 'refunds',
  examples: [
    {
      id: 'refunded',
      inputs: { request: 'Please refund order 1042.' },
      expected: 'Refunded $59 for order 1042.',
      metadata: { expectedPath: ['lookup_order', 'refund'], scenario: 'Order 1042 is delivered and cost $59.' },
    },
    {
      id: 'not-delivered',
      inputs: { request: 'Please refund order 2001.' },
      expected: 'it can be refunded once delivered',
      metadata: { expectedPath: ['lookup_order'], scenario: 'Order 2001 is shipped and cost $30.' },
    },
    {
      id: 'escalated',
      inputs: { request: 'Please refund order 3007.' },
      expected: 'escalated to a person',
      metadata: { expectedPath: ['lookup_order'], scenario: 'Order 3007 is delivered and cost $250.' },
    },
    {
      id: 'refused',
      inputs: { request: 'Please refund order 4410.' },
      expected: 'Refund failed: already refunded.',
      metadata: {
        expectedPath: ['lookup_order', 'refund'],
        scenario: 'Order 4410 is delivered and cost $20. It was already refunded last week.',
      },
    },
  ],
});

/** Whether the agent's answer says what the example expects. */
const answered: Evaluator = (context) => {
  const said = String((context.output as { state?: { answer?: string } })?.state?.answer ?? '');
  const passed = said.includes(String(context.example.expected));
  return { key: 'answer', score: passed ? 1 : 0, passed };
};
const evaluators = [answered, trajectory({ mode: 'exact' })];

/** Each example's verdict, by evaluator. */
const verdicts = (experiment: Experiment) =>
  Object.fromEntries(
    experiment.results.map((result) => [
      result.exampleId,
      result.scores.map((score) => `${score.key}:${score.passed}`),
    ]),
  );

function agentOver(tools: ToolDefinition[]) {
  return createAgent({ client: supportModel, model: 'mock', tools });
}

test('proof: an agent evaluated over emulated tools reaches the same verdict as over the real ones, with nothing sent', async () => {
  const sentBefore = shop.requests.length;
  const real = await evaluate<Inputs>(
    async (inputs) => agentOver(shopTools()).invoke(agentInput(inputs.request)),
    dataset,
    evaluators,
    { concurrency: 1 },
  );
  const sentByReal = shop.requests.slice(sentBefore);
  assert.deepEqual(
    sentByReal,
    ['GET /orders/1042', 'POST /refunds', 'GET /orders/2001', 'GET /orders/3007', 'GET /orders/4410', 'POST /refunds'],
    'the real tools reached the shop',
  );
  assert.ok(
    real.results.every((result) => result.scores.every((score) => score.passed)),
    `the agent passes over the real tools: ${JSON.stringify(verdicts(real))}`,
  );
  shop.refunded.delete('1042');

  const emulator = emulatorModel();
  const store = new MemoryEmulationStore();
  const calls: EmulatedToolCall[] = [];
  const emulated = await evaluate<Inputs>(
    async (inputs, { example }) =>
      agentOver(
        emulatedTools(shopTools(), {
          client: emulator,
          model: 'emulator',
          scenario: String(example.metadata?.scenario),
          store,
          onCall: (call) => calls.push(call),
        }),
      ).invoke(agentInput(inputs.request)),
    dataset,
    evaluators,
    { concurrency: 1 },
  );
  assert.deepEqual(verdicts(emulated), verdicts(real), 'the same verdict on every example');
  assert.equal(shop.requests.length, sentBefore + sentByReal.length, 'the emulated run sent the shop nothing');
  assert.equal(emulator.requests.length, 6, 'the emulator played each of the six calls');
  assert.deepEqual(
    calls.map((call) => `${call.tool}:${call.source}${call.error ? `:${call.error}` : ''}`),
    [
      'lookup_order:model',
      'refund:model',
      'lookup_order:model',
      'lookup_order:model',
      'lookup_order:model',
      'refund:model:already refunded',
    ],
  );
  assert.equal(store.size, 6, 'each answer kept');

  // Replayed from what the emulated run kept, written to a file and read back: the same verdict, and
  // the emulator is never asked.
  const replayed = await evaluate<Inputs>(
    async (inputs, { example }) =>
      agentOver(
        emulatedTools(shopTools(), {
          client: {
            complete: async () => {
              throw new Error('the emulator was asked');
            },
          },
          scenario: String(example.metadata?.scenario),
          store: new MemoryEmulationStore(JSON.parse(JSON.stringify(store))),
          mode: 'replay',
        }),
      ).invoke(agentInput(inputs.request)),
    dataset,
    evaluators,
    { concurrency: 1 },
  );
  assert.deepEqual(verdicts(replayed), verdicts(real));
  assert.equal(shop.requests.length, sentBefore + sentByReal.length, 'nothing sent on replay either');

  // The verdict follows the scenario: told order 1042 was not delivered, the emulator leads the agent
  // to another answer, and the evaluation says so.
  const wrong = await evaluate<Inputs>(
    async (inputs) =>
      agentOver(
        emulatedTools(shopTools(), { client: emulatorModel(), scenario: 'Order 1042 is shipped and cost $59.' }),
      ).invoke(agentInput(inputs.request)),
    createDataset<Inputs, string>({ name: 'one', examples: [dataset.examples[0] as never] }),
    evaluators,
  );
  assert.deepEqual(verdicts(wrong), { refunded: ['answer:false', 'trajectory:false'] });
});

test('the emulator is told the tool, its notes, the scenario, real calls, and the run’s earlier calls', async () => {
  const emulator = emulatorModel();
  const [lookup] = emulatedTools(shopTools(), {
    client: emulator,
    model: 'gpt-5-mini',
    scenario: 'Order 1042 is delivered and cost $59.',
    instructions: { lookup_order: 'Totals are whole dollars.' },
    examples: { lookup_order: [{ args: { orderId: '7' }, result: { id: '7', status: 'delivered', total: 12 } }] },
    results: { lookup_order: { type: 'object', required: ['id', 'status', 'total'] } },
    temperature: 0.2,
    maxTokens: 300,
  });
  const executor = new ToolExecutor([lookup as ToolDefinition]);
  const signal = new AbortController().signal;
  assert.deepEqual(await executor.execute('lookup_order', { orderId: '1042' }, { tenantId: 'acme', signal }), {
    ok: true,
    result: { id: '1042', status: 'delivered', total: 59 },
  });
  await executor.execute('lookup_order', { orderId: '1042' });

  const [first, second] = emulator.requests;
  assert.equal(first?.model, 'gpt-5-mini');
  assert.deepEqual(first?.responseFormat, { type: 'json' });
  assert.equal(first?.temperature, 0.2);
  assert.equal(first?.maxTokens, 300);
  assert.equal(first?.tenantId, 'acme');
  assert.equal(first?.signal, signal);
  assert.deepEqual(first?.metadata, { emulatedTool: 'lookup_order' });
  const brief = text(first?.messages[0]);
  for (const line of [
    'Tool: lookup_order',
    'Description: Looks an order up: its status and its total in US dollars.',
    'Arguments schema: {"type":"object","properties":{"orderId":{"type":"string"}},"required":["orderId"]}',
    'Result schema: {"type":"object","required":["id","status","total"]}',
    'Notes: Totals are whole dollars.',
    'Scenario: Order 1042 is delivered and cost $59.',
    '- arguments {"orderId":"7"} returned {"id":"7","status":"delivered","total":12}',
  ]) {
    assert.ok(brief.includes(line), `the brief says ${line}`);
  }
  assert.ok(!brief.includes('Earlier calls'), 'nothing earlier on the first call');
  assert.ok(
    text(second?.messages[0]).includes(
      'Earlier calls in this run, oldest first:\n- lookup_order {"orderId":"1042"} returned {"id":"1042","status":"delivered","total":59}',
    ),
    'the second call sees the first',
  );
  assert.equal(text(first?.messages[1]), 'Arguments: {"orderId":"1042"}');

  // With no history, the emulator sees no earlier call.
  const forgetful = emulatorModel();
  const [plain] = emulatedTools(shopTools(), {
    client: forgetful,
    history: 0,
    scenario: 'Order 1 is delivered and cost $1.',
  });
  await plain?.execute?.({ orderId: '1' });
  await plain?.execute?.({ orderId: '1' });
  assert.ok(!text(forgetful.requests[1]?.messages[0]).includes('Earlier calls'));
  assert.equal(forgetful.requests[0]?.model, 'auto', 'the client’s routing by default');
});

test('an emulated tool keeps the real one’s shape and never runs it', async () => {
  let ran = 0;
  const real = tool({
    name: 'charge_card',
    description: 'Charges a card.',
    parameters: { type: 'object', properties: { cents: { type: 'number' } } },
    capabilities: (args) => [`payments:${args.cents}`],
    deferred: true,
    execute: () => {
      ran += 1;
      return { charged: true };
    },
  });
  const [emulated] = emulatedTools([real], {
    client: { complete: async () => answer('{"result":{"charged":true,"emulated":true}}') },
  });
  assert.equal(emulated?.name, 'charge_card');
  assert.equal(emulated?.description, 'Charges a card.');
  assert.deepEqual(emulated?.parameters, real.parameters);
  assert.equal(emulated?.deferred, true);
  const capabilities = emulated?.capabilities as (args: Record<string, unknown>) => readonly string[];
  assert.deepEqual(capabilities({ cents: 5 }), ['payments:5']);
  assert.equal(emulated?.stream, undefined);
  assert.deepEqual(await emulated?.execute?.({ cents: 5 }), { charged: true, emulated: true });
  assert.equal(ran, 0, 'the real tool never ran');
});

test('a tool the emulator says fails throws its error, as the real tool would', async () => {
  const [lookup] = emulatedTools(shopTools(), {
    client: { complete: async () => answer('```json\n{"error":"no such order"}\n```') },
  });
  const executor = new ToolExecutor([lookup as ToolDefinition]);
  assert.deepEqual(await executor.execute('lookup_order', { orderId: '9' }), { ok: false, error: 'no such order' });

  // Any other JSON is the result itself.
  const [bare] = emulatedTools(shopTools(), { client: { complete: async () => answer('[1, 2]') } });
  assert.deepEqual(await bare?.execute?.({ orderId: '9' }), [1, 2]);
  const [wrapped] = emulatedTools(shopTools(), { client: { complete: async () => answer('{"result":null}') } });
  assert.equal(await wrapped?.execute?.({ orderId: '9' }), null);
  const [both] = emulatedTools(shopTools(), { client: { complete: async () => answer('{"result":1,"error":"x"}') } });
  assert.deepEqual(
    await both?.execute?.({ orderId: '9' }),
    { result: 1, error: 'x' },
    'only a lone key is the envelope',
  );
  const [first] = emulatedTools(shopTools(), { client: { complete: async () => answer('{"error":"x","result":1}') } });
  assert.deepEqual(await first?.execute?.({ orderId: '9' }), { error: 'x', result: 1 }, 'whichever key comes first');
  const [numbered] = emulatedTools(shopTools(), { client: { complete: async () => answer('{"error":42}') } });
  assert.deepEqual(await numbered?.execute?.({ orderId: '9' }), { error: 42 }, 'an error is a message');
});

test('an unusable answer is asked for again once, with the reason, then fails', async () => {
  const replies = [
    'not json',
    '{"result":{"id":"1","status":"lost","total":-1}}',
    '{"result":{"id":"1","status":"delivered","total":5}}',
  ];
  const seen: CompletionRequest[] = [];
  const client = {
    complete: async (request: CompletionRequest) => {
      seen.push(request);
      return answer(replies.shift() ?? '');
    },
  };
  const validate = {
    lookup_order: (result: unknown) =>
      Number((result as { total: number }).total) >= 0 ? (true as const) : 'the total is never negative',
  };
  const [lookup] = emulatedTools(shopTools(), { client, validate });
  await assert.rejects(lookup?.execute?.({ orderId: '1' }) as Promise<unknown>, (error: unknown) => {
    assert.ok(error instanceof EmulationError, `an emulation error: ${String(error)}`);
    assert.equal(error.code, 'EMULATION_INVALID');
    assert.equal(error.tool, 'lookup_order');
    assert.deepEqual(error.args, { orderId: '1' });
    assert.match(error.message, /does not fit what lookup_order returns: the total is never negative/);
    return true;
  });
  assert.equal(seen.length, 2, 'asked twice');
  const retry = seen[1]?.messages ?? [];
  assert.equal(text(retry.at(-2)), 'not json', 'it sees its answer');
  assert.equal(text(retry.at(-1)), 'The answer was not JSON. Reply with JSON only.');
  assert.equal(text(seen[0]?.messages.at(-1)), 'Arguments: {"orderId":"1"}', 'a request is left as it was sent');

  // The second answer, valid, is taken; the first, refused, is answered with why.
  replies.splice(
    0,
    replies.length,
    '{"result":{"id":"1","status":"lost","total":-1}}',
    '{"result":{"id":"1","status":"delivered","total":5}}',
  );
  const [patient] = emulatedTools(shopTools(), { client, validate });
  assert.deepEqual(await patient?.execute?.({ orderId: '1' }), { id: '1', status: 'delivered', total: 5 });
  assert.equal(
    text(seen.at(-1)?.messages.at(-1)),
    'The result does not fit what lookup_order returns: the total is never negative. Answer again.',
  );
});

test('answers are kept by tool, arguments, scenario, and call, and replayed or recorded by mode', async () => {
  const replies: string[] = [];
  let asked = 0;
  const client = {
    complete: async () => {
      asked += 1;
      return answer(replies.shift() ?? '{"result":"default"}');
    },
  };
  const store = new MemoryEmulationStore();
  replies.push('{"result":"first"}', '{"result":"second"}');
  const [auto] = emulatedTools(shopTools(), { client, store, scenario: 's' });
  assert.equal(await auto?.execute?.({ orderId: '1' }), 'first');
  assert.equal(await auto?.execute?.({ orderId: '1' }), 'second', 'a second call with the same arguments is its own');
  assert.equal(store.size, 2);
  assert.equal(
    store.get(emulationKey({ tool: 'lookup_order', args: { orderId: '1' }, scenario: 's', ordinal: 1 }))?.result,
    'second',
  );

  // auto replays what it has; replay never asks; record always asks and keeps the new answer.
  const [again] = emulatedTools(shopTools(), { client, store, scenario: 's' });
  assert.equal(await again?.execute?.({ orderId: '1' }), 'first');
  assert.equal(asked, 2, 'replayed, not asked');
  const [replay] = emulatedTools(shopTools(), { client, store, scenario: 'other', mode: 'replay' });
  await assert.rejects(replay?.execute?.({ orderId: '1' }) as Promise<unknown>, (error: unknown) => {
    assert.ok(error instanceof EmulationError);
    assert.equal(error.code, 'EMULATION_MISS');
    assert.match(error.message, /No kept answer for lookup_order\(\{"orderId":"1"\}\), call 1: record it first/);
    return true;
  });
  replies.push('{"result":"rerecorded"}');
  const [record] = emulatedTools(shopTools(), { client, store, scenario: 's', mode: 'record' });
  assert.equal(await record?.execute?.({ orderId: '1' }), 'rerecorded');
  assert.equal(asked, 3);
  assert.equal(
    store.get(emulationKey({ tool: 'lookup_order', args: { orderId: '1' }, scenario: 's' }))?.result,
    'rerecorded',
  );
  const [plain] = emulatedTools(shopTools(), { client });
  await plain?.execute?.({ orderId: '1' });
  assert.equal(asked, 4, 'with no store, every call asks');

  assert.throws(() => emulatedTools(shopTools(), { client, mode: 'replay' }), /Emulation mode "replay" needs a store/);
  assert.equal(
    emulationKey({ tool: 't', args: { a: 1, b: { c: 2, d: 3 } } }),
    emulationKey({ tool: 't', args: { b: { d: 3, c: 2 }, a: 1 }, scenario: '', ordinal: 0 }),
    'key order never changes a key',
  );
  assert.notEqual(emulationKey({ tool: 't', args: {} }), emulationKey({ tool: 't', args: {}, scenario: 'x' }));
  assert.deepEqual(new MemoryEmulationStore(store.toJSON()).toJSON(), store.toJSON());
});

test('a passed-through tool runs for real and is reported as real', async () => {
  const calls: EmulatedToolCall[] = [];
  const progress: unknown[] = [];
  const streaming = tool({
    name: 'count',
    description: 'Counts to three.',
    parameters: { type: 'object', properties: {} },
    async *stream() {
      yield 1;
      yield 2;
      return 3;
    },
  });
  const failing = tool({
    name: 'fail',
    description: 'Fails.',
    parameters: { type: 'object', properties: {} },
    execute: () => {
      throw new Error('real failure');
    },
  });
  const bare: ToolDefinition = { name: 'bare', description: 'Has no body.', parameters: {} };
  // A stream with no `execute` of its own, as a definition written by hand has.
  const raw: ToolDefinition = {
    name: 'raw',
    description: 'Streams.',
    parameters: {},
    async *stream() {
      yield 'working';
      return 'done';
    },
  };
  const tools = emulatedTools([...shopTools(), streaming, failing, bare, raw], {
    client: { complete: async () => answer('{"result":"emulated"}') },
    passthrough: ['lookup_order', 'count', 'fail', 'bare', 'raw'],
    onCall: (call) => {
      calls.push(call);
      throw new Error('an observer that throws');
    },
  });
  const byName = Object.fromEntries(tools.map((definition) => [definition.name, definition]));
  const before = shop.requests.length;
  assert.deepEqual(await byName.lookup_order?.execute?.({ orderId: '2001' }), {
    id: '2001',
    status: 'shipped',
    total: 30,
  });
  assert.equal(shop.requests.length, before + 1, 'the real tool reached the shop');
  assert.equal(await byName.count?.execute?.({}, { progress: (value) => progress.push(value) }), 3);
  assert.deepEqual(progress, [1, 2], 'its progress still reported');
  assert.equal(byName.count?.stream, undefined);
  await assert.rejects(byName.fail?.execute?.({}) as Promise<unknown>, /real failure/);
  assert.equal(byName.bare, bare, 'a tool with no body is left as it is');
  const rawProgress: unknown[] = [];
  assert.equal(await byName.raw?.execute?.({}, { progress: (value) => rawProgress.push(value) }), 'done');
  assert.deepEqual(rawProgress, ['working'], 'a hand-written stream’s progress reported too');
  assert.equal(await byName.refund?.execute?.({ orderId: '2001', amount: 30 }), 'emulated');
  assert.equal(shop.requests.length, before + 1, 'the emulated one did not');
  assert.deepEqual(
    calls.map((call) => [call.tool, call.source, call.error ?? null]),
    [
      ['lookup_order', 'real', null],
      ['count', 'real', null],
      ['fail', 'real', 'real failure'],
      ['raw', 'real', null],
      ['refund', 'model', null],
    ],
  );
});
