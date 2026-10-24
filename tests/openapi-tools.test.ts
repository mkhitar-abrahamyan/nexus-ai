/**
 * Tools read from an OpenAPI document: named, described, and shaped as the API is, declaring what
 * each does, and, given where the API lives, calling it with the path encoded, the query and body
 * placed, and the application's headers sent.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { loadOpenApiTools, type OpenApiDocument, OpenApiError, openApiTools } from '../src/agent/openapi.js';
import { SHOP_DOCUMENT, startShop } from './openapi-shop.js';

let shop: Awaited<ReturnType<typeof startShop>>;
before(async () => {
  shop = await startShop();
});
after(() => shop.close());

const byName = (api: ReturnType<typeof openApiTools>, name: string) => {
  const found = api.tools.find((item) => item.name === name);
  assert.ok(found, `a tool named ${name}`);
  return found;
};
const refused = (code: OpenApiError['code'], pattern: RegExp) => (error: unknown) =>
  error instanceof OpenApiError && error.code === code && pattern.test(error.message);

test('an OpenAPI document becomes one tool per operation, named, described, and shaped as the API is', () => {
  const api = openApiTools(SHOP_DOCUMENT);
  assert.equal(api.name, 'corner-shop', 'named by its title');
  assert.equal(api.baseUrl, undefined, 'a relative server with nothing to read it against');
  assert.deepEqual(
    api.tools.map((item) => item.name),
    ['listOrders', 'getOrder', 'createRefund'],
  );
  assert.ok(
    api.tools.every((item) => item.execute === undefined),
    'with nowhere to send them, the tools describe the API and run nowhere',
  );
  const getOrder = byName(api, 'getOrder');
  assert.equal(getOrder.description, 'Looks an order up: its status and its total in US dollars.');
  assert.deepEqual(getOrder.parameters, {
    type: 'object',
    properties: { orderId: { type: 'string', description: 'The order’s number' } },
    required: ['orderId'],
    additionalProperties: false,
  });
  assert.deepEqual(getOrder.capabilities, ['api.read:corner-shop/getOrder']);
  // The body's fields are the tool's own parameters; the refund's id, which only the shop sets, is not one.
  assert.deepEqual(byName(api, 'createRefund').parameters, {
    type: 'object',
    properties: { orderId: { type: 'string' }, amount: { type: 'number', exclusiveMinimum: 0 } },
    required: ['orderId', 'amount'],
    additionalProperties: false,
  });
  assert.deepEqual(byName(api, 'createRefund').capabilities, ['api.write:corner-shop/createRefund']);
  assert.deepEqual(byName(api, 'listOrders').parameters, {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['shipped', 'delivered', 'refunded'] },
      limit: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  });
  // What each returns, every reference followed.
  assert.deepEqual(api.results.getOrder, {
    type: 'object',
    required: ['id', 'status', 'total'],
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['shipped', 'delivered', 'refunded'] },
      total: { type: 'number', description: 'In US dollars' },
    },
  });
  assert.equal((api.results.listOrders as { type?: string }).type, 'array');
  assert.deepEqual(
    api.operations.map((operation) => `${operation.method} ${operation.path} ${operation.access}`),
    ['GET /orders read', 'GET /orders/{orderId} read', 'POST /refunds write'],
  );
});

test('names: by id, or by method and path; repeated, prefixed, and filtered; a DELETE is destructive, and a body not sent is skipped', () => {
  const document: OpenApiDocument = {
    openapi: '3.0.3',
    info: { title: 'Notes' },
    paths: {
      '/notes/{noteId}': {
        get: { responses: { '200': { description: 'ok' } } },
        delete: { operationId: 'remove', tags: ['admin'], responses: { '204': { description: 'gone' } } },
      },
      '/notes': {
        post: { operationId: 'remove', responses: {} },
        put: {
          operationId: 'upload',
          requestBody: { content: { 'multipart/form-data': { schema: { type: 'object' } } } },
          responses: {},
        },
      },
    },
  };
  const api = openApiTools(document);
  assert.deepEqual(
    api.tools.map((item) => item.name),
    ['get_notes_noteId', 'remove', 'remove_2'],
  );
  assert.deepEqual(api.skipped, [
    {
      method: 'PUT',
      path: '/notes',
      reason: 'its request body is multipart/form-data; only JSON and form bodies are sent',
    },
  ]);
  assert.deepEqual(byName(api, 'remove').capabilities, ['api.destructive:notes/remove']);
  assert.deepEqual(api.results.remove, { type: 'null' }, 'nothing comes back');
  // A filtered-out operation frees its name, so the rest keep theirs whatever the filter.
  const admin = openApiTools(document, { include: (operation) => !operation.tags.includes('admin'), prefix: 'notes' });
  assert.deepEqual(
    admin.tools.map((item) => item.name),
    ['notes_get_notes_noteId', 'notes_remove'],
  );
  assert.deepEqual(byName(admin, 'notes_remove').capabilities, ['api.write:notes/notes_remove']);
});

test('schemas: references followed, a recursive one described, 3.0 keywords converted, and what cannot be read refused', () => {
  const document: OpenApiDocument = {
    openapi: '3.0.3',
    paths: {
      '/trees/{orderId}': {
        post: {
          operationId: 'plant',
          parameters: [
            { name: 'orderId', in: 'path', required: true, schema: { type: 'string' } },
            { name: 'Authorization', in: 'header', schema: { type: 'string' } },
            { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
            { name: 'session', in: 'cookie', schema: { type: 'string' } },
          ],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { orderId: { type: 'string' }, root: { $ref: '#/components/schemas/Node' } },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Node: {
          type: 'object',
          properties: {
            name: { type: 'string', nullable: true, example: 'oak' },
            children: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
          },
        },
      },
    },
  };
  const api = openApiTools(document);
  const properties = (byName(api, 'plant').parameters as { properties: Record<string, Record<string, unknown>> })
    .properties;
  // A body field named as a parameter keeps the body whole; the Authorization header is the client's own.
  assert.deepEqual(Object.keys(properties), ['orderId', 'X-Trace', 'body']);
  const node = api.results.plant as { properties: Record<string, Record<string, unknown>> };
  assert.deepEqual(node.properties.name, { type: ['string', 'null'], examples: ['oak'] });
  assert.deepEqual((node.properties.children as { items: unknown }).items, {
    description: 'The same shape as Node, nested',
  });

  assert.throws(
    () => openApiTools({ swagger: '2.0' } as unknown as OpenApiDocument),
    refused('OPENAPI_UNSUPPORTED', /Swagger 2\.0 .* OpenAPI 3/),
  );
  assert.throws(
    () => openApiTools('openapi: 3.1.0'),
    refused('OPENAPI_INVALID', /not JSON; parse a YAML document first/),
  );
  assert.throws(
    () => openApiTools({ openapi: '2.9' } as OpenApiDocument),
    refused('OPENAPI_INVALID', /names its version/),
  );
  const outside = (ref: string): OpenApiDocument => ({
    openapi: '3.1.0',
    paths: {
      '/a': {
        get: {
          responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: ref } } } } },
        },
      },
    },
  });
  assert.throws(
    () => openApiTools(outside('./common.yaml#/Order')),
    refused('OPENAPI_UNSUPPORTED', /outside the document/),
  );
  assert.throws(
    () => openApiTools(outside('#/components/schemas/Missing')),
    refused('OPENAPI_INVALID', /names nothing/),
  );
  assert.throws(() => openApiTools(SHOP_DOCUMENT, { baseUrl: '/api' }), refused('OPENAPI_INVALID', /absolute URL/));
});

test('a tool calls the API where it lives: the path encoded, the query and body placed, and the application’s headers sent', async () => {
  shop.reset();
  const api = await loadOpenApiTools(`${shop.url}/openapi.json`, {
    headers: ({ operation, context }) => ({ authorization: `Bearer ${context?.tenantId ?? 'none'}:${operation.name}` }),
  });
  assert.equal(api.baseUrl, `${shop.url}/api`, 'the relative server, read against where the document came from');
  const host = new URL(shop.url).host;
  assert.deepEqual(byName(api, 'getOrder').capabilities, ['api.read:corner-shop/getOrder', `network:${host}`]);
  const run = (name: string, args: Record<string, unknown>, tenantId = 'acme') =>
    (byName(api, name).execute as NonNullable<ReturnType<typeof byName>['execute']>)(args, { tenantId });

  assert.deepEqual(await run('getOrder', { orderId: '1042' }), { id: '1042', status: 'delivered', total: 59 });
  assert.equal(shop.headers.at(-1)?.authorization, 'Bearer acme:getOrder', 'chosen per tenant and operation');
  await assert.rejects(run('getOrder', { orderId: 'a b/c' }), (error: unknown) => {
    assert.ok(error instanceof OpenApiError && error.status === 404, 'the API refused it');
    assert.equal(error.message, 'getOrder answered 404: no such order', 'in the API’s own words');
    return true;
  });
  assert.equal(shop.requests.at(-1), 'GET /api/orders/a%20b%2Fc', 'the path parameter encoded, slash and all');
  const sent = shop.requests.length;
  for (const orderId of ['..', '.', '']) {
    await assert.rejects(run('getOrder', { orderId }), refused('OPENAPI_INVALID', /cannot be|needs "orderId"/));
  }
  assert.equal(shop.requests.length, sent, 'nothing sent for a segment that would leave the path, or none');

  assert.deepEqual(await run('listOrders', { status: 'delivered', limit: 1 }), [
    { id: '1042', status: 'delivered', total: 59 },
  ]);
  assert.equal(shop.requests.at(-1), 'GET /api/orders?status=delivered&limit=1');
  assert.deepEqual(await run('createRefund', { orderId: '1042', amount: 59 }), {
    refundId: 'r-1042',
    orderId: '1042',
    amount: 59,
  });
  assert.equal(shop.requests.at(-1), 'POST /api/refunds {"orderId":"1042","amount":59}');
  assert.equal(shop.headers.at(-1)?.['content-type'], 'application/json');
  await assert.rejects(
    run('createRefund', { orderId: '1042', amount: 59 }),
    /createRefund answered 409: already refunded/,
  );
});

test('a call redirected, too large, too slow, or not JSON fails with its reason; a header the model sets yields to the application’s', async () => {
  const document: OpenApiDocument = {
    openapi: '3.1.0',
    paths: {
      '/thing': {
        get: {
          operationId: 'thing',
          parameters: [{ name: 'X-Tenant', in: 'header', schema: { type: 'string' } }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
  const seen: RequestInit[] = [];
  const answering = (response: () => Response) =>
    openApiTools(document, {
      baseUrl: 'https://api.example.com/v1',
      headers: { 'x-tenant': 'from-the-application' },
      maxResponseBytes: 16,
      timeoutMs: 50,
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(init);
        return response();
      }) as typeof fetch,
    }).tools[0]?.execute as NonNullable<ReturnType<typeof openApiTools>['tools'][number]['execute']>;

  await assert.rejects(
    answering(() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/steal' } }))({}),
    /redirected to https:\/\/elsewhere\.example\/steal, which is not followed/,
  );
  assert.equal(seen.at(-1)?.redirect, 'manual');
  await assert.rejects(
    answering(() => new Response('x'.repeat(17), { headers: { 'content-type': 'text/plain' } }))({}),
    /answered more than 16 bytes/,
  );
  await assert.rejects(
    answering(() => new Response('{not json', { headers: { 'content-type': 'application/json' } }))({}),
    /JSON that does not parse/,
  );
  assert.equal(await answering(() => new Response(null, { status: 204 }))({}), null, 'no content is null');
  assert.equal(
    await answering(() => new Response('plain', { headers: { 'content-type': 'text/plain' } }))({}),
    'plain',
  );
  await answering(() => new Response('{}', { headers: { 'content-type': 'application/json' } }))({
    'X-Tenant': 'from-the-model',
  });
  assert.equal((seen.at(-1)?.headers as Record<string, string> | undefined)?.['x-tenant'], 'from-the-application');

  // A service that never answers: held open by a timer of its own, as a real request's socket holds the process.
  let sentSlow = 0;
  const slow = openApiTools(document, {
    baseUrl: 'https://api.example.com',
    timeoutMs: 50,
    fetch: ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        sentSlow += 1;
        if (init.signal?.aborted) return reject(init.signal.reason);
        const held = setTimeout(() => reject(new Error('never answered')), 10_000);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(held);
          reject(init.signal?.reason);
        });
      })) as typeof fetch,
  }).tools[0]?.execute as NonNullable<ReturnType<typeof openApiTools>['tools'][number]['execute']>;
  await assert.rejects(slow({}), /could not be reached: no answer within 50 ms/);
  const stopped = new AbortController();
  stopped.abort(new Error('the caller stopped'));
  await assert.rejects(slow({}, { signal: stopped.signal }), /the caller stopped/);
  assert.equal(sentSlow, 1, 'a call stopped before it starts is never sent');
});
