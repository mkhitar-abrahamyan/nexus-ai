/**
 * A shop of the tests' own, served over HTTP with its own OpenAPI 3.1 document at `/openapi.json`:
 * orders to look up and list, and refunds to make. It keeps every request it receives, and starts
 * again from its three orders with `reset()`.
 *
 * Beside it: the tools an application would write for it by hand, a support agent's scripted model,
 * a scripted model that plays the shop's tools from what it is told, as a model would, and a dataset
 * whose examples build on each other's changes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tool } from '../src/agent/tool.js';
import { createDataset } from '../src/evaluate/datasets.js';
import { trajectory } from '../src/evaluate/evaluators.js';
import type { Evaluator, Experiment } from '../src/types/evaluate.js';
import type { CompletionRequest, Message, ToolDefinition } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

/** The shop's OpenAPI document. Its server is relative, so it is read against where it is served. */
export const SHOP_DOCUMENT = {
  openapi: '3.1.0',
  info: { title: 'Corner Shop', version: '1.0.0' },
  servers: [{ url: '/api' }],
  paths: {
    '/orders': {
      get: {
        operationId: 'listOrders',
        summary: 'Lists orders, newest first.',
        tags: ['orders'],
        parameters: [
          { name: 'status', in: 'query', schema: { $ref: '#/components/schemas/Status' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
        ],
        responses: {
          '200': {
            description: 'The orders',
            content: {
              'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Order' } } },
            },
          },
        },
      },
    },
    '/orders/{orderId}': {
      parameters: [{ $ref: '#/components/parameters/OrderId' }],
      get: {
        operationId: 'getOrder',
        summary: 'Looks an order up: its status and its total in US dollars.',
        tags: ['orders'],
        responses: { '200': { $ref: '#/components/responses/Order' }, '404': { $ref: '#/components/responses/Error' } },
      },
    },
    '/refunds': {
      post: {
        operationId: 'createRefund',
        summary: 'Refunds an order to the card it was paid with.',
        tags: ['refunds'],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RefundRequest' } } },
        },
        responses: {
          '201': {
            description: 'The refund',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Refund' } } },
          },
          '409': { $ref: '#/components/responses/Error' },
        },
      },
    },
  },
  components: {
    parameters: {
      OrderId: {
        name: 'orderId',
        in: 'path',
        required: true,
        description: 'The order’s number',
        schema: { type: 'string' },
      },
    },
    schemas: {
      Status: { type: 'string', enum: ['shipped', 'delivered', 'refunded'] },
      Order: {
        type: 'object',
        required: ['id', 'status', 'total'],
        properties: {
          id: { type: 'string' },
          status: { $ref: '#/components/schemas/Status' },
          total: { type: 'number', description: 'In US dollars' },
        },
      },
      RefundRequest: {
        type: 'object',
        required: ['orderId', 'amount'],
        properties: {
          orderId: { type: 'string' },
          amount: { type: 'number', exclusiveMinimum: 0 },
          refundId: { type: 'string', readOnly: true },
        },
      },
      Refund: {
        type: 'object',
        properties: { refundId: { type: 'string' }, orderId: { type: 'string' }, amount: { type: 'number' } },
      },
      Error: { type: 'object', properties: { error: { type: 'string' } } },
    },
    responses: {
      Order: {
        description: 'The order',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
      },
      Error: {
        description: 'Why not',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
};

/** The orders the shop starts from. */
const ORDERS = {
  '1042': { status: 'delivered', total: 59 },
  '2001': { status: 'shipped', total: 30 },
  '3007': { status: 'delivered', total: 250 },
};

/** Starts the shop on a free port. */
export async function startShop() {
  let orders: Record<string, { status: string; total: number }> = structuredClone(ORDERS);
  /** Every request, as `METHOD /path?query body`. */
  const requests: string[] = [];
  /** Every request's headers, in order. */
  const headers: IncomingMessage['headers'][] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const url = new URL(request.url ?? '/', 'http://shop');
      if (url.pathname !== '/openapi.json') {
        requests.push(`${request.method} ${url.pathname}${url.search}${body ? ` ${body}` : ''}`);
        headers.push(request.headers);
      }
      const json = (status: number, value: unknown) =>
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      if (request.method === 'GET' && url.pathname === '/openapi.json') return json(200, SHOP_DOCUMENT);
      const order = /^\/api\/orders\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && order) {
        const id = decodeURIComponent(order[1] as string);
        const found = orders[id];
        return found ? json(200, { id, ...found }) : json(404, { error: 'no such order' });
      }
      if (request.method === 'GET' && url.pathname === '/api/orders') {
        const status = url.searchParams.get('status');
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const listed = Object.entries(orders)
          .filter(([, item]) => !status || item.status === status)
          .slice(0, limit)
          .map(([id, item]) => ({ id, ...item }));
        return json(200, listed);
      }
      if (request.method === 'POST' && url.pathname === '/api/refunds') {
        const { orderId, amount } = JSON.parse(body || '{}') as { orderId: string; amount: number };
        const found = orders[orderId];
        if (!found) return json(404, { error: 'no such order' });
        if (found.status === 'refunded') return json(409, { error: 'already refunded' });
        found.status = 'refunded';
        return json(201, { refundId: `r-${orderId}`, orderId, amount });
      }
      json(404, { error: 'not found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    headers,
    reset() {
      orders = structuredClone(ORDERS);
      requests.length = 0;
      headers.length = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** The tools an application would write by hand for the shop, which call it directly. */
export function handWrittenTools(url: string): ToolDefinition[] {
  const call = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${url}/api${path}`, init);
    const value = (await response.json()) as Record<string, unknown>;
    if (!response.ok) throw new Error(String(value.error));
    return value;
  };
  return [
    tool<{ orderId: string }>({
      name: 'getOrder',
      description: 'Looks an order up: its status and its total in US dollars.',
      parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
      execute: ({ orderId }) => call(`/orders/${encodeURIComponent(orderId)}`),
    }),
    tool<{ orderId: string; amount: number }>({
      name: 'createRefund',
      description: 'Refunds an order to the card it was paid with.',
      parameters: {
        type: 'object',
        properties: { orderId: { type: 'string' }, amount: { type: 'number' } },
        required: ['orderId', 'amount'],
      },
      execute: (args) =>
        call('/refunds', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ orderId: args.orderId, amount: args.amount }),
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

/** The support agent's model: it looks the order up, and decides from what the tools returned. */
export const supportModel = {
  async complete(request: CompletionRequest): Promise<NexusResponse> {
    const asked = text(request.messages.find((message) => message.role === 'user'));
    const orderId = /order (\w+)/.exec(asked)?.[1] ?? '';
    const [order, refund] = request.messages
      .filter((message) => message.role === 'tool')
      .map((message) => JSON.parse(text(message)) as Record<string, unknown>);
    if (!order) return callTool('getOrder', { orderId }, 'c1');
    if (order.error) return answer(`I could not find order ${orderId}.`);
    if (/status/.test(asked)) return answer(`Order ${orderId} is ${order.status}.`);
    if (order.status !== 'delivered') return answer(`Order ${orderId} is ${order.status}, so it cannot be refunded.`);
    if (Number(order.total) > 100)
      return answer(`Order ${orderId} cost $${order.total}, above $100: escalated to a person.`);
    if (!refund) return callTool('createRefund', { orderId, amount: order.total }, 'c2');
    if (refund.error) return answer(`The refund of order ${orderId} failed.`);
    return answer(`Refunded $${refund.amount} for order ${orderId}.`);
  },
};

/** The world the shop starts in, as the emulator is told it. */
export const SHOP_SCENARIO =
  'Order 1042 is delivered and cost $59. Order 2001 is shipped and cost $30. Order 3007 is delivered and cost $250. There is no other order.';

/**
 * A model playing the shop's tools from what it is told: the tool, the scenario, the arguments, and
 * what has happened so far, which it reads as a model would. A refund it was told succeeded leaves
 * the order refunded.
 */
export function shopEmulator() {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    async complete(request: CompletionRequest): Promise<NexusResponse> {
      requests.push(request);
      const brief = text(request.messages[0]);
      const toolName = /^Tool: (\w+)$/m.exec(brief)?.[1];
      const scenario = /^Scenario: (.*)$/m.exec(brief)?.[1] ?? '';
      const args = JSON.parse(text(request.messages[1]).replace(/^Arguments: /, '')) as Record<string, unknown>;
      const refunded = [...brief.matchAll(/^- createRefund (\{.*?\}) returned /gm)].some(
        (match) => (JSON.parse(match[1] as string) as { orderId?: string }).orderId === args.orderId,
      );
      const described = new RegExp(`Order ${args.orderId} is (\\w+) and cost \\$(\\d+)`).exec(scenario);
      if (!described) return answer(JSON.stringify({ error: 'no such order' }));
      if (toolName === 'getOrder') {
        const status = refunded ? 'refunded' : described[1];
        return answer(JSON.stringify({ result: { id: args.orderId, status, total: Number(described[2]) } }));
      }
      if (refunded) return answer(JSON.stringify({ error: 'already refunded' }));
      return answer(
        JSON.stringify({ result: { refundId: `r-${args.orderId}`, orderId: args.orderId, amount: args.amount } }),
      );
    },
  };
}

export type ShopInputs = { request: string };

/** Six examples, run in order: the second and third depend on the refund the first makes. */
export const shopDataset = createDataset<ShopInputs, string>({
  name: 'shop-support',
  examples: [
    {
      id: 'refund-1042',
      inputs: { request: 'Please refund order 1042.' },
      expected: 'Refunded $59 for order 1042.',
      metadata: { expectedPath: ['getOrder', 'createRefund'] },
    },
    {
      id: 'again-1042',
      inputs: { request: 'Please refund order 1042 once more.' },
      expected: 'Order 1042 is refunded, so it cannot be refunded.',
      metadata: { expectedPath: ['getOrder'] },
    },
    {
      id: 'status-1042',
      inputs: { request: 'What is the status of order 1042?' },
      expected: 'Order 1042 is refunded.',
      metadata: { expectedPath: ['getOrder'] },
    },
    {
      id: 'shipped-2001',
      inputs: { request: 'Please refund order 2001.' },
      expected: 'Order 2001 is shipped, so it cannot be refunded.',
      metadata: { expectedPath: ['getOrder'] },
    },
    {
      id: 'large-3007',
      inputs: { request: 'Please refund order 3007.' },
      expected: 'escalated to a person',
      metadata: { expectedPath: ['getOrder'] },
    },
    {
      id: 'missing-9999',
      inputs: { request: 'Please refund order 9999.' },
      expected: 'I could not find order 9999.',
      metadata: { expectedPath: ['getOrder'] },
    },
  ],
});

/** Whether the agent's answer says what the example expects. */
const answered: Evaluator = (context) => {
  const said = String((context.output as { state?: { answer?: string } })?.state?.answer ?? '');
  const passed = said.includes(String(context.example.expected));
  return { key: 'answer', score: passed ? 1 : 0, passed };
};

/** The answer, and the exact tools called, in order. */
export const shopEvaluators = [answered, trajectory({ mode: 'exact' })];

/** Each example's verdict, by evaluator. */
export const verdicts = (experiment: Experiment) =>
  Object.fromEntries(
    experiment.results.map((result) => [
      result.exampleId,
      result.scores.map((score) => `${score.key}:${score.passed}`),
    ]),
  );
