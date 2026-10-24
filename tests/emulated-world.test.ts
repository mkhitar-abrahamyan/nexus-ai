/**
 * An emulator that remembers the evaluation, over tools read from an OpenAPI document.
 *
 * The shop of `openapi-shop.ts` serves its own OpenAPI document. A support agent is evaluated on six
 * examples, run in order, the second and third of which depend on the refund the first makes: first
 * over tools written by hand for the shop, then over tools read from its document, and then over
 * those tools emulated in one world, which reach the same verdicts with nothing sent. Emulated
 * without a world, each run forgets the refund, and the two that depend on it come out otherwise.
 * Started each from a snapshot of the world after the refund, the rest reach their verdicts run side
 * by side; replayed from the answers kept, they reach them again with the emulator never asked.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { agentInput, createAgent } from '../src/agent/create-agent.js';
import { loadOpenApiTools } from '../src/agent/openapi.js';
import { tool } from '../src/agent/tool.js';
import { createDataset } from '../src/evaluate/datasets.js';
import {
  EmulatedWorld,
  type EmulatedWorldSnapshot,
  emulatedTools,
  emulationKey,
  MemoryEmulationStore,
} from '../src/evaluate/emulate.js';
import { evaluate } from '../src/evaluate/run.js';
import type { CompletionRequest, Message, ToolDefinition } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import {
  handWrittenTools,
  SHOP_SCENARIO,
  type ShopInputs,
  shopDataset,
  shopEmulator,
  shopEvaluators,
  startShop,
  supportModel,
  verdicts,
} from './openapi-shop.js';

let shop: Awaited<ReturnType<typeof startShop>>;
before(async () => {
  shop = await startShop();
});
after(() => shop.close());

const agentOver = (tools: ToolDefinition[]) => createAgent({ client: supportModel, model: 'mock', tools });
const text = (message: Message | undefined) => (typeof message?.content === 'string' ? message.content : '');
const reply = (content: string) => ({ content, role: 'assistant', finishReason: 'stop', meta: {} }) as NexusResponse;

test('proof: an agent over tools read from a stand-in’s OpenAPI document reaches the stand-in’s verdict, and emulated, sends nothing', async () => {
  // The reference: tools written by hand for the shop.
  shop.reset();
  const reference = await evaluate<ShopInputs>(
    async (inputs) => agentOver(handWrittenTools(shop.url)).invoke(agentInput(inputs.request)),
    shopDataset,
    shopEvaluators,
    { concurrency: 1 },
  );
  assert.ok(
    reference.results.every((result) => result.scores.every((score) => score.passed)),
    `the agent passes over the hand-written tools: ${JSON.stringify(verdicts(reference))}`,
  );
  const sentByHand = [...shop.requests];

  // The same evaluation over tools read from the shop's document: the same verdicts, and the same requests.
  shop.reset();
  const api = await loadOpenApiTools(`${shop.url}/openapi.json`);
  const overDocument = await evaluate<ShopInputs>(
    async (inputs) => agentOver(api.tools).invoke(agentInput(inputs.request)),
    shopDataset,
    shopEvaluators,
    { concurrency: 1 },
  );
  assert.deepEqual(verdicts(overDocument), verdicts(reference), 'the same verdict on every example');
  assert.deepEqual(shop.requests, sentByHand, 'the same requests, byte for byte');

  // Emulated, in one world the whole evaluation shares: the same verdicts, and nothing reaches the shop.
  shop.reset();
  const emulator = shopEmulator();
  const world = new EmulatedWorld({ scenario: SHOP_SCENARIO });
  const emulated = await evaluate<ShopInputs>(
    async (inputs) =>
      agentOver(emulatedTools(api.tools, { client: emulator, results: api.results, world })).invoke(
        agentInput(inputs.request),
      ),
    shopDataset,
    shopEvaluators,
    { concurrency: 1 },
  );
  assert.deepEqual(verdicts(emulated), verdicts(reference));
  assert.deepEqual(shop.requests, [], 'the emulated evaluation sent the shop nothing');
  assert.equal(emulator.requests.length, 7, 'the emulator played each of the seven calls');
  const told = text(emulator.requests[1]?.messages[0]);
  assert.match(told, /^Description: Refunds an order to the card it was paid with\.$/m, 'the document’s own words');
  assert.match(told, /^Result schema: \{"type":"object","properties":\{"refundId"/m, 'and what it returns');
  assert.deepEqual(
    world.changes.map((call) => `${call.tool} ${JSON.stringify(call.args)}`),
    ['createRefund {"orderId":"1042","amount":59}'],
    'one change: the refund; every lookup only read',
  );
});

test('proof: an evaluation whose examples build on each other’s changes reaches the stand-in’s verdict in order, and again from a snapshot', async () => {
  shop.reset();
  const reference = verdicts(
    await evaluate<ShopInputs>(
      async (inputs) => agentOver(handWrittenTools(shop.url)).invoke(agentInput(inputs.request)),
      shopDataset,
      shopEvaluators,
      { concurrency: 1 },
    ),
  );
  shop.reset();
  const api = await loadOpenApiTools(`${shop.url}/openapi.json`);
  const run =
    (
      world: EmulatedWorld | undefined,
      options: { store?: MemoryEmulationStore; emulator?: ReturnType<typeof shopEmulator> } = {},
    ) =>
    (inputs: ShopInputs) =>
      agentOver(
        emulatedTools(api.tools, {
          client: options.emulator ?? shopEmulator(),
          results: api.results,
          ...(world ? { world } : { scenario: SHOP_SCENARIO }),
          ...(options.store ? { store: options.store } : {}),
        }),
      ).invoke(agentInput(inputs.request));

  // Without a world, each run starts again from the scenario and forgets the refund: the two examples
  // that depend on it come out otherwise, and the evaluation says so.
  const forgetful = verdicts(
    await evaluate<ShopInputs>(async (inputs) => run(undefined)(inputs), shopDataset, shopEvaluators, {
      concurrency: 1,
    }),
  );
  assert.deepEqual(
    Object.keys(forgetful).filter((id) => JSON.stringify(forgetful[id]) !== JSON.stringify(reference[id])),
    ['again-1042', 'status-1042'],
    'only the examples that depend on an earlier one differ',
  );

  // In order, in one world, kept in a store: the stand-in's verdicts.
  const store = new MemoryEmulationStore();
  const world = new EmulatedWorld({ scenario: SHOP_SCENARIO });
  const inOrder = verdicts(
    await evaluate<ShopInputs>(async (inputs) => run(world, { store })(inputs), shopDataset, shopEvaluators, {
      concurrency: 1,
    }),
  );
  assert.deepEqual(inOrder, reference);

  // A snapshot of the world after the first example, written out and read back; every other example
  // then starts from it, side by side, each in a world of its own.
  const first = new EmulatedWorld({ scenario: SHOP_SCENARIO });
  await evaluate<ShopInputs>(
    async (inputs) => run(first)(inputs),
    createDataset<ShopInputs, string>({ name: 'first', examples: [shopDataset.examples[0] as never] }),
    shopEvaluators,
  );
  const snapshot = JSON.parse(JSON.stringify(first)) as EmulatedWorldSnapshot;
  const forks: EmulatedWorld[] = [];
  const rest = createDataset<ShopInputs, string>({ name: 'rest', examples: shopDataset.examples.slice(1) as never });
  const fromSnapshot = verdicts(
    await evaluate<ShopInputs>(
      async (inputs) => {
        const own = new EmulatedWorld(snapshot);
        forks.push(own);
        return run(own)(inputs);
      },
      rest,
      shopEvaluators,
      { concurrency: 5 },
    ),
  );
  assert.deepEqual(
    fromSnapshot,
    Object.fromEntries(Object.entries(reference).filter(([id]) => id !== 'refund-1042')),
    'from the snapshot, the stand-in’s verdict on each',
  );
  assert.equal(forks.length, 5);
  assert.ok(
    forks.every((own) => own.changes.length === 1 && own.calls.length === 3),
    'each world of its own: the snapshot’s two calls, the refund among them, and its own lookup, none of another run’s',
  );
  assert.equal(first.calls.length, 2, 'the world the snapshot came from is unchanged by the runs started from it');

  // Replayed from the store, in order, in a fresh world from the same scenario: the same verdicts,
  // and the emulator is never asked, since each call comes back under the same world.
  const silent = {
    requests: [] as CompletionRequest[],
    complete: async (): Promise<NexusResponse> => {
      throw new Error('the emulator was asked');
    },
  } as unknown as ReturnType<typeof shopEmulator>;
  const replayWorld = new EmulatedWorld({ scenario: SHOP_SCENARIO });
  const replayed = verdicts(
    await evaluate<ShopInputs>(
      async (inputs) =>
        agentOver(
          emulatedTools(api.tools, {
            client: silent,
            results: api.results,
            world: replayWorld,
            store: new MemoryEmulationStore(JSON.parse(JSON.stringify(store))),
            mode: 'replay',
          }),
        ).invoke(agentInput(inputs.request)),
      shopDataset,
      shopEvaluators,
      { concurrency: 1 },
    ),
  );
  assert.deepEqual(replayed, reference);
  assert.deepEqual(shop.requests, [], 'nothing reached the shop in any of it');
});

test('a world keeps every call and its changes; its digest follows its changes alone, and survives a snapshot', () => {
  const world = new EmulatedWorld({ scenario: 'Order 1 is delivered.' });
  const start = world.digest();
  world.record({ tool: 'getOrder', args: { orderId: '1' }, result: { status: 'delivered' } }, false);
  assert.equal(world.digest(), start, 'a read leaves the digest');
  assert.equal(world.ordinal('getOrder', { orderId: '1' }), 1, 'one such read since the last change');
  world.record({ tool: 'createRefund', args: { orderId: '1', amount: 5 }, result: { refundId: 'r-1' } }, true);
  const changed = world.digest();
  assert.notEqual(changed, start, 'a change moves it');
  assert.equal(world.ordinal('getOrder', { orderId: '1' }), 0, 'counted again from the change');
  world.record({ tool: 'getOrder', args: { orderId: '1' }, error: 'down' }, false);
  assert.deepEqual(
    world.calls.map((call) => `${call.tool}:${call.changed}`),
    ['getOrder:false', 'createRefund:true', 'getOrder:false'],
  );
  assert.equal(world.changes.length, 1);

  const restored = new EmulatedWorld(JSON.parse(JSON.stringify(world)) as EmulatedWorldSnapshot);
  assert.equal(restored.digest(), changed, 'read back, the same world');
  assert.equal(restored.scenario, 'Order 1 is delivered.');
  assert.equal(restored.ordinal('getOrder', { orderId: '1' }), 1);
  const fork = world.fork();
  fork.record({ tool: 'createRefund', args: { orderId: '2', amount: 1 }, result: {} }, true);
  assert.equal(world.digest(), changed, 'a fork’s changes stay its own');
  assert.notEqual(fork.digest(), changed);
  // A world given out is a copy: changing what it returned changes nothing in it.
  (world.calls[0] as { tool: string }).tool = 'tampered';
  assert.equal(world.calls[0]?.tool, 'getOrder');
});

test('a call is a change when it succeeds and its tool does more than read, by its capabilities or the reads it is named in', async () => {
  const make = (name: string, capabilities?: string[]) =>
    tool({
      name,
      description: name,
      parameters: { type: 'object' },
      ...(capabilities ? { capabilities } : {}),
      execute: async () => 'real',
    });
  const tools = [
    make('apiRead', ['api.read:shop/getOrder', 'network:shop.example']),
    make('mcpRead', ['mcp.read:files/list']),
    make('fileRead', ['filesystem:read:/data']),
    make('pure', []),
    make('apiWrite', ['api.write:shop/createRefund']),
    make('networkOnly', ['network:shop.example']),
    make('undeclared'),
    make('named', ['payments']),
    make('failing', ['payments']),
  ];
  const world = new EmulatedWorld();
  const emulated = emulatedTools(tools, {
    client: {
      complete: async (request: CompletionRequest) =>
        reply(
          JSON.stringify(/^Tool: failing$/m.test(text(request.messages[0])) ? { error: 'refused' } : { result: 'ok' }),
        ),
    },
    world,
    reads: ['named'],
  });
  for (const item of emulated) await item.execute?.({}).catch(() => undefined);
  assert.deepEqual(
    world.calls.map((call) => `${call.tool}:${call.changed}`),
    [
      'apiRead:false',
      'mcpRead:false',
      'fileRead:false',
      'pure:false',
      'apiWrite:true',
      'networkOnly:true',
      'undeclared:true',
      'named:false',
      'failing:false',
    ],
  );
});

test('in a world the emulator is told every change and the latest calls, and each answer’s key carries the world', async () => {
  const told: string[] = [];
  const world = new EmulatedWorld({ scenario: 'A shop.' });
  const keys: string[] = [];
  const [write, read] = emulatedTools(
    [
      // Schemas only: an emulated tool never runs.
      { name: 'write', description: 'w', parameters: { type: 'object' }, capabilities: ['api.write:s/write'] },
      { name: 'read', description: 'r', parameters: { type: 'object' }, capabilities: ['api.read:s/read'] },
    ],
    {
      client: {
        complete: async (request: CompletionRequest) => {
          told.push(text(request.messages[0]));
          return reply(JSON.stringify({ result: 'ok' }));
        },
      },
      world,
      history: 1,
      onCall: (call) => keys.push(call.key),
    },
  );
  const digestBefore = world.digest();
  await write?.execute?.({ n: 1 });
  for (let index = 0; index < 3; index += 1) await read?.execute?.({ n: index });
  await read?.execute?.({ n: 9 });
  const last = told.at(-1) ?? '';
  assert.match(last, /What has happened in this world, oldest first/);
  assert.match(last, /^Scenario: A shop\.$/m, 'the world’s scenario');
  assert.match(last, /^- write \{"n":1\} returned "ok"$/m, 'the change, however long ago');
  assert.match(last, /^- read \{"n":2\} returned "ok"$/m, 'the latest call');
  assert.doesNotMatch(last, /\{"n":0\}/, 'not the older reads');
  assert.equal(
    keys[0],
    emulationKey({ tool: 'write', args: { n: 1 }, scenario: 'A shop.', ordinal: 0, world: digestBefore }),
  );
  assert.notEqual(
    keys[0],
    emulationKey({ tool: 'write', args: { n: 1 }, scenario: 'A shop.', ordinal: 0 }),
    'a world’s key is its own',
  );
  // Without a world, keys are those of every release before worlds, so answers kept then replay.
  assert.equal(
    emulationKey({
      tool: 'refund',
      args: { orderId: '1042', amount: 59 },
      scenario: 'Order 1042 is delivered.',
      ordinal: 1,
    }),
    'df4f6511bfb4e82f0cbe50e0fd8650927d9edcfef655148498775cbfed65765f',
  );
  assert.equal(
    emulationKey({ tool: 'lookup_order', args: { orderId: '7' } }),
    '6d81671133906b6233090af3b84770135aa9e5b550008df511b5431309d8ec83',
  );
});
