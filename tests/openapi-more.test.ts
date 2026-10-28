/**
 * OpenAPI tools, further: each call sends the credentials its operation's security asks for, from an
 * API key to an OAuth 2.0 client-credentials token fetched once; a multipart form with files, text,
 * XML, and bytes are sent as the API takes them; a Swagger 2.0 document is read as the OpenAPI 3 one it
 * describes; references to other documents are followed where allowed; and what the API sends the
 * application, its webhooks and callbacks, is listed.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bundleOpenApiDocument,
  loadOpenApiTools,
  type OpenApiDocument,
  OpenApiError,
  openApiTools,
  swaggerToOpenApi,
} from '../src/agent/openapi.js';
import type { ToolDefinition } from '../src/types/messages.js';

/** A fetch that records each request and answers as `answer` says, JSON by default. */
function recorder(answer: (url: string, init: RequestInit) => Response | undefined = () => undefined) {
  const calls: Array<{ url: string; init: RequestInit; headers: Record<string, string> }> = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    return answer(url, init) ?? Response.json({ ok: true });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const run = (tools: { tools: ToolDefinition[] }, name: string, args: Record<string, unknown> = {}, context = {}) => {
  const found = tools.tools.find((item) => item.name === name);
  if (!found?.execute) throw new Error(`no tool ${name}`);
  return found.execute(args, context);
};

const refused = (code: OpenApiError['code'], message: RegExp) => (error: unknown) =>
  error instanceof OpenApiError && error.code === code && message.test(error.message);

const SECURED: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Vault' },
  servers: [{ url: 'https://vault.example/api' }],
  security: [{ bearer: [] }],
  paths: {
    '/default': { get: { operationId: 'byDefault', responses: { '200': { description: 'ok' } } } },
    '/public': { get: { operationId: 'open', security: [], responses: { '200': { description: 'ok' } } } },
    '/header': { get: { operationId: 'withHeader', security: [{ keyHeader: [] }], responses: {} } },
    '/query': { get: { operationId: 'withQuery', security: [{ keyQuery: [] }], responses: {} } },
    '/cookie': { get: { operationId: 'withCookie', security: [{ keyCookie: [], session: [] }], responses: {} } },
    '/basic': { get: { operationId: 'withBasic', security: [{ basic: [] }], responses: {} } },
    '/either': { get: { operationId: 'either', security: [{ oidc: [] }, { keyHeader: [] }], responses: {} } },
    '/oauth': { get: { operationId: 'withOauth', security: [{ oauth: ['vault:read'] }], responses: {} } },
    '/oauth-write': { put: { operationId: 'withOauthWrite', security: [{ oauth: ['vault:write'] }], responses: {} } },
    '/ghost': { get: { operationId: 'ghost', security: [{ ghost: [] }, { keyHeader: [] }], responses: {} } },
    '/negotiate': { get: { operationId: 'withNegotiate', security: [{ negotiate: [] }], responses: {} } },
    '/mtls': { get: { operationId: 'withMtls', security: [{ mtls: [] }], responses: {} } },
  },
  components: {
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer' },
      keyHeader: { type: 'apiKey', in: 'header', name: 'X-Api-Key' },
      keyQuery: { type: 'apiKey', in: 'query', name: 'api_key' },
      keyCookie: { type: 'apiKey', in: 'cookie', name: 'key' },
      session: { type: 'apiKey', in: 'cookie', name: 'sid' },
      basic: { type: 'http', scheme: 'basic' },
      negotiate: { type: 'http', scheme: 'Negotiate' },
      oidc: { type: 'openIdConnect', openIdConnectUrl: 'https://id.example/.well-known/openid-configuration' },
      oauth: {
        type: 'oauth2',
        flows: { clientCredentials: { tokenUrl: '/oauth/token', scopes: { 'vault:read': 'Read the vault' } } },
      },
      mtls: { type: 'mutualTLS' },
    },
  },
};

test('each call sends the credentials its operation’s security asks for, and fails before sending without them', async () => {
  let tokens = 0;
  const { fetch, calls } = recorder((url, init) => {
    if (url.endsWith('/oauth/token')) {
      tokens += 1;
      assert.equal(new URLSearchParams(String(init.body)).get('grant_type'), 'client_credentials');
      const scope = new URLSearchParams(String(init.body)).get('scope');
      return Response.json({ access_token: `t${tokens}`, ...(scope === 'vault:read' ? { expires_in: 3600 } : {}) });
    }
    return undefined;
  });
  const vault = openApiTools(SECURED, {
    fetch,
    credentials: {
      bearer: (request) => ({ token: `bearer-for-${request.context?.tenantId ?? 'nobody'}` }),
      keyHeader: 'h-key',
      keyQuery: { token: 'q-key' },
      keyCookie: 'c key',
      session: 's1',
      basic: { username: 'ana', password: 'p:ss' },
      oauth: { clientId: 'app', clientSecret: 'shh' },
      mtls: 'cert',
      ghost: 'boo',
      negotiate: 'abc',
    },
  });
  assert.deepEqual(vault.operations.find((item) => item.name === 'either')?.security, [
    { oidc: [] },
    { keyHeader: [] },
  ]);
  assert.deepEqual(
    vault.operations.find((item) => item.name === 'byDefault')?.security,
    [{ bearer: [] }],
    'the document’s own',
  );
  const last = () => calls.at(-1) as (typeof calls)[number];

  await run(vault, 'byDefault', {}, { tenantId: 'acme' });
  assert.equal(last().headers.authorization, 'Bearer bearer-for-acme', 'chosen per call, by its tenant');
  await run(vault, 'open');
  assert.equal(last().headers.authorization, undefined, 'an operation that asks for none is sent with none');
  await run(vault, 'withHeader');
  assert.equal(last().headers['x-api-key'], 'h-key');
  await run(vault, 'withQuery');
  assert.equal(new URL(last().url).searchParams.get('api_key'), 'q-key');
  await run(vault, 'withCookie');
  assert.equal(last().headers.cookie, 'key=c%20key; sid=s1', 'two schemes at once');
  await run(vault, 'withBasic');
  assert.equal(last().headers.authorization, `Basic ${Buffer.from('ana:p:ss').toString('base64')}`);
  await run(vault, 'either');
  assert.equal(last().headers['x-api-key'], 'h-key', 'the first alternative it can meet');
  await run(vault, 'ghost');
  assert.equal(last().headers['x-api-key'], 'h-key', 'a scheme the document does not declare is not met');
  await run(vault, 'withNegotiate');
  assert.equal(last().headers.authorization, 'Negotiate abc', 'an HTTP scheme sent by its own name');

  await run(vault, 'withOauth');
  const tokenCall = calls.find((call) => call.url.endsWith('/oauth/token'));
  assert.equal(tokenCall?.url, 'https://vault.example/oauth/token', 'the token URL, resolved against the API’s server');
  assert.equal(tokenCall?.headers.authorization, `Basic ${Buffer.from('app:shh').toString('base64')}`);
  assert.equal(new URLSearchParams(String(tokenCall?.init.body)).get('scope'), 'vault:read');
  assert.equal(last().headers.authorization, 'Bearer t1');
  await run(vault, 'withOauth');
  assert.equal(tokens, 1, 'the token is kept while it lasts');
  assert.equal(last().headers.authorization, 'Bearer t1');
  await run(vault, 'withOauthWrite');
  assert.equal(last().headers.authorization, 'Bearer t2', 'another scope, another token');
  await run(vault, 'withOauthWrite');
  assert.equal(tokens, 2, 'a token that says no lifetime is kept an hour');

  await assert.rejects(
    run(vault, 'withMtls'),
    refused('OPENAPI_UNSUPPORTED', /mtls is mutualTLS, which the tools do not send/),
  );

  const sent = calls.length;
  const partial = openApiTools(SECURED, { fetch, credentials: { keyQuery: 'q', keyCookie: 'c' } });
  await assert.rejects(
    run(partial, 'either'),
    refused('OPENAPI_INVALID', /either needs credentials for oidc, or keyHeader/),
  );
  await assert.rejects(
    run(partial, 'withCookie'),
    refused('OPENAPI_INVALID', /needs credentials for keyCookie and session/),
  );
  assert.equal(calls.length, sent, 'nothing was sent');
  // Without credentials, nothing is added, as before: the application's headers decide.
  const plain = openApiTools(SECURED, { fetch, headers: { authorization: 'Bearer by-hand' } });
  await run(plain, 'byDefault');
  assert.equal(last().headers.authorization, 'Bearer by-hand');
  const both = openApiTools(SECURED, {
    fetch,
    headers: { 'X-Api-Key': 'by-hand' },
    credentials: { keyHeader: 'h-key' },
  });
  await run(both, 'withHeader');
  assert.equal(last().headers['x-api-key'], 'h-key', 'the credential in place of the same header');
  // A token already held, for OAuth 2.0 or OpenID Connect, is sent as it is.
  const held = openApiTools(SECURED, { fetch, credentials: { oidc: 'id-token', oauth: { token: 'given' } } });
  await run(held, 'either');
  assert.equal(last().headers.authorization, 'Bearer id-token');
  const fetched = tokens;
  await run(held, 'withOauth');
  assert.deepEqual([last().headers.authorization, tokens], ['Bearer given', fetched]);
  const wrong = openApiTools(SECURED, {
    fetch,
    credentials: { basic: 'just-a-token', bearer: { username: 'x', password: 'y' } },
  });
  await assert.rejects(run(wrong, 'withBasic'), refused('OPENAPI_INVALID', /basic is \{ username, password \}/));
  await assert.rejects(run(wrong, 'byDefault'), refused('OPENAPI_INVALID', /bearer is a token/));

  const failing = recorder((url) =>
    url.endsWith('/oauth/token') ? Response.json({ error: 'invalid_client' }, { status: 401 }) : undefined,
  );
  const denied = openApiTools(SECURED, {
    fetch: failing.fetch,
    credentials: { oauth: { clientId: 'app', clientSecret: 'bad' } },
  });
  await assert.rejects(
    run(denied, 'withOauth'),
    refused('OPENAPI_REQUEST', /oauth's token URL answered 401: invalid_client/),
  );
});

const BODIES: OpenApiDocument = {
  openapi: '3.1.0',
  servers: [{ url: 'https://files.example' }],
  paths: {
    '/upload': {
      post: {
        operationId: 'upload',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  file: { type: 'string', format: 'binary', description: 'The scan' },
                  photo: { type: 'string', contentMediaType: 'image/png' },
                  thumb: { type: 'string', contentMediaType: 'image/png', contentEncoding: 'base64' },
                },
                required: ['file'],
              },
            },
          },
        },
        responses: {},
      },
    },
    '/note': {
      put: {
        operationId: 'note',
        requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } },
        responses: {},
      },
    },
    '/feed': { put: { operationId: 'feed', requestBody: { content: { 'application/atom+xml': {} } }, responses: {} } },
    '/blob': {
      put: { operationId: 'blob', requestBody: { content: { 'application/octet-stream': {} } }, responses: {} },
    },
    '/image': { put: { operationId: 'image', requestBody: { content: { 'image/*': {} } }, responses: {} } },
  },
};

test('a multipart form with files, text, XML, and bytes are sent as the API takes them', async () => {
  const { fetch, calls } = recorder();
  const files = openApiTools(BODIES, { fetch });
  const parameters = (name: string) =>
    (files.tools.find((item) => item.name === name)?.parameters ?? {}) as {
      properties: Record<string, Record<string, unknown>>;
      required?: string[];
    };
  assert.deepEqual(parameters('upload').required, ['file']);
  assert.deepEqual(
    parameters('upload').properties.file?.required,
    ['base64'],
    'a file is base64, with a name and type',
  );
  assert.equal(parameters('upload').properties.file?.description, 'The scan');
  assert.equal(parameters('upload').properties.title?.type, 'string');
  assert.equal(parameters('note').properties.body?.type, 'string');
  assert.deepEqual(parameters('blob').properties.body?.required, ['base64']);

  await run(files, 'upload', {
    title: 'Scan 7',
    file: { base64: Buffer.from('%PDF-1.7').toString('base64'), filename: 'scan.pdf', mimeType: 'application/pdf' },
    photo: Buffer.from('PNG').toString('base64'),
    thumb: 'UE5H',
  });
  const form = calls.at(-1)?.init.body as FormData;
  assert.ok(form instanceof FormData, 'a multipart form');
  assert.equal(calls.at(-1)?.headers['content-type'], undefined, 'its boundary is the platform’s to write');
  assert.equal(form.get('title'), 'Scan 7');
  const scan = form.get('file') as File;
  assert.deepEqual(
    [scan.name, scan.type, Buffer.from(await scan.arrayBuffer()).toString()],
    ['scan.pdf', 'application/pdf', '%PDF-1.7'],
  );
  const photo = form.get('photo') as File;
  assert.deepEqual(
    [photo.name, photo.type, Buffer.from(await photo.arrayBuffer()).toString()],
    ['photo', 'application/octet-stream', 'PNG'],
  );
  assert.equal(form.get('thumb'), 'UE5H', 'base64 text, as the API takes it');

  await run(files, 'note', { body: 'Remember the milk' });
  assert.deepEqual(
    [calls.at(-1)?.headers['content-type'], calls.at(-1)?.init.body],
    ['text/plain', 'Remember the milk'],
  );
  await run(files, 'feed', { body: '<feed/>' });
  assert.deepEqual(
    [calls.at(-1)?.headers['content-type'], calls.at(-1)?.init.body],
    ['application/atom+xml', '<feed/>'],
  );
  await run(files, 'blob', { body: Buffer.from([1, 2, 3]).toString('base64') });
  assert.equal(calls.at(-1)?.headers['content-type'], 'application/octet-stream');
  assert.deepEqual([...((calls.at(-1)?.init.body ?? new Uint8Array()) as Uint8Array)], [1, 2, 3]);
  await run(files, 'image', { body: { base64: Buffer.from('x').toString('base64'), mimeType: 'image/png' } });
  assert.equal(calls.at(-1)?.headers['content-type'], 'image/png', 'a wildcard type, the file’s own');
  await run(files, 'image', { body: Buffer.from('x').toString('base64') });
  assert.equal(calls.at(-1)?.headers['content-type'], 'application/octet-stream', 'or bytes, when it names none');
  await assert.rejects(
    run(files, 'blob', { body: 'not base64!' }),
    refused('OPENAPI_INVALID', /blob's body is not base64/),
  );
  await assert.rejects(
    run(files, 'blob', { body: { filename: 'x' } }),
    refused('OPENAPI_INVALID', /is a file: give its base64/),
  );
});

const SWAGGER = {
  swagger: '2.0',
  info: { title: 'Pet Store', version: '1.0' },
  host: 'pets.example',
  basePath: '/v1',
  schemes: ['https', 'http'],
  consumes: ['application/json'],
  produces: ['application/json'],
  securityDefinitions: {
    key: { type: 'apiKey', in: 'header', name: 'X-Key' },
    basic: { type: 'basic' },
    app: {
      type: 'oauth2',
      flow: 'application',
      tokenUrl: 'https://pets.example/token',
      scopes: { 'pets:write': 'Write' },
    },
  },
  security: [{ key: [] }],
  parameters: {
    petId: { name: 'petId', in: 'path', required: true, type: 'integer', format: 'int64' },
    caption: { name: 'caption', in: 'formData', type: 'string' },
  },
  responses: { Pets: { description: 'Pets', schema: { type: 'array', items: { $ref: '#/definitions/Pet' } } } },
  definitions: {
    Pet: {
      type: 'object',
      required: ['name'],
      properties: {
        id: { type: 'integer', readOnly: true },
        name: { type: 'string' },
        tags: { type: 'array', items: { $ref: '#/definitions/Tag' } },
      },
    },
    Tag: { type: 'object', properties: { label: { type: 'string' } } },
  },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        parameters: [{ name: 'limit', in: 'query', type: 'integer', collectionFormat: 'csv', description: 'How many' }],
        responses: { '200': { $ref: '#/responses/Pets' } },
      },
      post: {
        operationId: 'addPet',
        consumes: ['application/xml', 'application/json'],
        security: [{ app: ['pets:write'] }],
        parameters: [{ name: 'pet', in: 'body', required: true, schema: { $ref: '#/definitions/Pet' } }],
        responses: { '201': { description: 'made', schema: { $ref: '#/definitions/Pet' } } },
      },
    },
    '/pets/{petId}/photo': {
      parameters: [{ $ref: '#/parameters/petId' }, { $ref: '#/parameters/caption' }],
      post: {
        operationId: 'uploadPhoto',
        parameters: [{ name: 'photo', in: 'formData', type: 'file', required: true }],
        responses: { '200': { description: 'ok' } },
      },
    },
    '/pets/{petId}/tags': {
      post: {
        operationId: 'tagPet',
        consumes: ['multipart/form-data'],
        parameters: [{ $ref: '#/parameters/petId' }, { name: 'tag', in: 'formData', type: 'string' }],
        responses: {},
      },
      put: {
        operationId: 'notePet',
        parameters: [{ $ref: '#/parameters/petId' }, { name: 'note', in: 'formData', type: 'string' }],
        responses: {},
      },
    },
  },
};

test('a Swagger 2.0 document is read as the OpenAPI 3 document it describes, and its tools call the API', async () => {
  const converted = swaggerToOpenApi(SWAGGER);
  assert.equal(converted.openapi, '3.0.3');
  assert.deepEqual(converted.servers, [{ url: 'https://pets.example/v1' }]);
  assert.deepEqual(((converted.components?.securitySchemes ?? {}) as Record<string, unknown>).basic, {
    type: 'http',
    scheme: 'basic',
  });
  assert.deepEqual(((converted.components?.securitySchemes ?? {}) as Record<string, unknown>).app, {
    type: 'oauth2',
    flows: { clientCredentials: { tokenUrl: 'https://pets.example/token', scopes: { 'pets:write': 'Write' } } },
  });
  assert.throws(() => swaggerToOpenApi({ swagger: '1.2' }), refused('OPENAPI_UNSUPPORTED', /Swagger 1\.2 is not 2\.0/));
  assert.deepEqual(
    converted.paths?.['/pets/{petId}/photo']?.parameters,
    [{ $ref: '#/components/parameters/petId' }],
    'a shared form field is moved into the body',
  );
  assert.deepEqual(
    ((converted.paths?.['/pets']?.post ?? {}) as { parameters?: unknown }).parameters,
    [],
    'and the body parameter',
  );
  assert.deepEqual(swaggerToOpenApi({ swagger: '2.0', basePath: '/v2', paths: {} }).servers, [{ url: '/v2' }]);
  assert.deepEqual(swaggerToOpenApi({ swagger: '2.0', host: 'h.example', paths: {} }).servers, [
    { url: 'https://h.example' },
  ]);

  const { fetch, calls } = recorder((url) =>
    url.endsWith('/token')
      ? Response.json({ access_token: 'tok', expires_in: 60 })
      : Response.json({ id: 1, name: 'Rex' }),
  );
  const pets = openApiTools(SWAGGER as unknown as OpenApiDocument, {
    fetch,
    credentials: { key: 'k1', app: { clientId: 'c', clientSecret: 's' } },
  });
  assert.deepEqual(
    pets.tools.map((item) => item.name),
    ['listPets', 'addPet', 'uploadPhoto', 'notePet', 'tagPet'],
  );
  assert.equal(pets.baseUrl, 'https://pets.example/v1');
  const limit = ((pets.tools[0]?.parameters ?? {}) as { properties?: Record<string, unknown> }).properties?.limit;
  assert.deepEqual(limit, { type: 'integer', description: 'How many' });
  const add = pets.tools[1]?.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.deepEqual(Object.keys(add.properties), ['name', 'tags'], 'the body’s fields, the read-only id left out');
  assert.deepEqual(add.required, ['name']);
  assert.deepEqual(((pets.tools[2]?.parameters ?? {}) as { required?: string[] }).required, ['petId', 'photo']);
  assert.deepEqual(pets.results.uploadPhoto, { type: 'null' }, 'a response without a schema returns nothing');
  assert.deepEqual(
    (pets.results.listPets as { items: { properties: Record<string, unknown> } }).items.properties.tags,
    {
      type: 'array',
      items: { type: 'object', properties: { label: { type: 'string' } } },
    },
  );

  await run(pets, 'listPets', { limit: 5 });
  assert.equal(calls.at(-1)?.url, 'https://pets.example/v1/pets?limit=5');
  assert.equal(calls.at(-1)?.headers['x-key'], 'k1', 'the document’s security');
  await run(pets, 'addPet', { name: 'Rex' });
  assert.deepEqual(
    [calls.at(-1)?.headers.authorization, calls.at(-1)?.headers['content-type'], calls.at(-1)?.init.body],
    ['Bearer tok', 'application/json', '{"name":"Rex"}'],
    'JSON, of the types it consumes',
  );
  await run(pets, 'addPet', { name: 'Rex' });
  assert.equal(
    calls.filter((call) => call.url.endsWith('/token')).length,
    2,
    'a token that lasts a minute or less is fetched again',
  );
  await run(pets, 'uploadPhoto', { petId: 7, caption: 'At the park', photo: Buffer.from('jpg').toString('base64') });
  assert.equal(calls.at(-1)?.url, 'https://pets.example/v1/pets/7/photo');
  const form = calls.at(-1)?.init.body as FormData;
  assert.equal(form.get('caption'), 'At the park');
  assert.equal(Buffer.from(await (form.get('photo') as File).arrayBuffer()).toString(), 'jpg');
  await run(pets, 'tagPet', { petId: 7, tag: 'good' });
  assert.equal(
    ((calls.at(-1)?.init.body ?? new FormData()) as FormData).get('tag'),
    'good',
    'a multipart form, as it consumes',
  );
  await run(pets, 'notePet', { petId: 7, note: 'a b' });
  assert.deepEqual(
    [calls.at(-1)?.headers['content-type'], calls.at(-1)?.init.body],
    ['application/x-www-form-urlencoded', 'note=a+b'],
  );
});

test('references to other documents are followed where allowed, recursion described, and the rest refused', async () => {
  const documents: Record<string, unknown> = {
    'https://api.example/specs/common.json': {
      Order: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          lines: { type: 'array', items: { $ref: '#/Line' } },
          parent: { $ref: '#/Order' },
          total: { $ref: 'openapi.json#/components/schemas/Money' },
        },
      },
      Line: { type: 'object', properties: { sku: { $ref: 'shared/sku.json' } } },
    },
    'https://api.example/specs/shared/sku.json': { type: 'string', pattern: '^[A-Z]{3}-\\d+$' },
    'https://cdn.other.example/money.json': { type: 'number' },
  };
  const served: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    served.push(url);
    if (url === 'https://api.example/specs/openapi.json') return Response.json(MAIN);
    const found = documents[url];
    return found ? Response.json(found) : new Response('missing', { status: 404 });
  }) as typeof globalThis.fetch;
  const MAIN: OpenApiDocument = {
    openapi: '3.1.0',
    servers: [{ url: '/orders-api' }],
    components: { schemas: { Money: { type: 'number' } } },
    paths: {
      '/money': {
        get: {
          operationId: 'money',
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/Money', description: 'In cents' } },
              },
            },
          },
        },
      },
      '/orders': {
        get: {
          operationId: 'listOrders',
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: 'common.json#/Order', description: 'The orders' } } },
            },
          },
        },
      },
    },
  };
  const api = await loadOpenApiTools('https://api.example/specs/openapi.json', { fetch });
  assert.equal(api.baseUrl, 'https://api.example/orders-api');
  const order = api.results.listOrders as { properties: Record<string, Record<string, unknown>> };
  assert.deepEqual(order.properties.lines?.items, {
    type: 'object',
    properties: { sku: { type: 'string', pattern: '^[A-Z]{3}-\\d+$' } },
  });
  assert.deepEqual(order.properties.parent, { description: 'The same shape as Order, nested' });
  assert.equal(served.filter((url) => url.endsWith('common.json')).length, 1, 'each document read once');
  assert.deepEqual(order.properties.total, { type: 'number' }, 'a reference back into the first document');
  assert.equal((order as { description?: unknown }).description, 'The orders', 'what is written beside a reference');
  const documentUrl = 'https://api.example/specs/openapi.json';
  const bundled = await bundleOpenApiDocument(MAIN, { documentUrl, fetch });
  assert.match(
    JSON.stringify(bundled.paths?.['/money']),
    /"schema":\{"\$ref":"#\/components\/schemas\/Money","description":"In cents"\}/,
    'a reference within the document stays one, with what is written beside it',
  );
  assert.match(
    JSON.stringify(bundled.paths?.['/orders']),
    /"total":\{"\$ref":"#\/components\/schemas\/Money"\}/,
    'and one back into it becomes one',
  );

  const elsewhere: OpenApiDocument = {
    openapi: '3.1.0',
    paths: {
      '/price': {
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: { 'application/json': { schema: { $ref: 'https://cdn.other.example/money.json' } } },
            },
          },
        },
      },
    },
  };
  await assert.rejects(
    bundleOpenApiDocument(elsewhere, { documentUrl: 'https://api.example/specs/openapi.json', fetch }),
    refused('OPENAPI_UNSUPPORTED', /money\.json is not a document references may name here/),
  );
  const any = await bundleOpenApiDocument(elsewhere, {
    documentUrl: 'https://api.example/specs/openapi.json',
    fetch,
    references: 'any',
  });
  assert.deepEqual(openApiTools(any).results.get_price, { type: 'number' });
  const chosen = await bundleOpenApiDocument(elsewhere, {
    documentUrl: 'https://api.example/specs/openapi.json',
    fetch,
    references: (url) => url.startsWith('https://cdn.other.example/'),
  });
  assert.deepEqual(openApiTools(chosen).results.get_price, { type: 'number' });
  await assert.rejects(
    bundleOpenApiDocument(elsewhere, { documentUrl, fetch, references: () => false }),
    refused('OPENAPI_UNSUPPORTED', /money\.json is not a document references may name here/),
  );
  const local: OpenApiDocument = {
    openapi: '3.1.0',
    paths: {
      '/secret': {
        get: {
          responses: {
            '200': { description: 'ok', content: { 'application/json': { schema: { $ref: 'file:///etc/passwd' } } } },
          },
        },
      },
    },
  };
  await assert.rejects(
    bundleOpenApiDocument(local, { documentUrl, fetch, references: 'any' }),
    refused('OPENAPI_UNSUPPORTED', /file:\/\/\/etc\/passwd is not a document references may name here/),
  );
  assert.ok(!served.some((url) => url.startsWith('file:')), 'any URL is any web URL: nothing is read from a file');
  await assert.rejects(
    loadOpenApiTools(documentUrl, { fetch, maxDocuments: 1 }),
    refused('OPENAPI_INVALID', /more than 1 documents/),
  );
  await assert.rejects(
    loadOpenApiTools(documentUrl, { fetch, maxBytes: 64 }),
    refused(
      'OPENAPI_REQUEST',
      /The OpenAPI document at https:\/\/api\.example\/specs\/openapi\.json answered more than 64 bytes/,
    ),
  );
  const common = JSON.stringify(documents['https://api.example/specs/common.json']).length;
  await assert.rejects(
    bundleOpenApiDocument(MAIN, { documentUrl, fetch, maxBytes: common - 1 }),
    refused('OPENAPI_REQUEST', /common\.json answered more than/),
  );
  assert.ok(
    (await bundleOpenApiDocument(MAIN, { documentUrl, fetch, maxBytes: common })).paths,
    'a document of just the size allowed is read',
  );
  await assert.rejects(
    bundleOpenApiDocument(MAIN, { documentUrl: 'https://api.example/specs/openapi.json', fetch, maxDocuments: 2 }),
    refused('OPENAPI_INVALID', /more than 2 documents/),
  );
  const missing: OpenApiDocument = {
    ...MAIN,
    paths: {
      '/x': {
        get: {
          responses: {
            '200': { description: 'ok', content: { 'application/json': { schema: { $ref: 'gone.json' } } } },
          },
        },
      },
    },
  };
  await assert.rejects(
    bundleOpenApiDocument(missing, { documentUrl: 'https://api.example/specs/openapi.json', fetch }),
    refused('OPENAPI_REQUEST', /gone\.json answered 404/),
  );
});

test('what the API sends the application, its webhooks and its operations’ callbacks, is listed with each body', () => {
  const api = openApiTools({
    openapi: '3.1.0',
    webhooks: {
      orderPaid: {
        post: {
          requestBody: {
            content: {
              'application/json': { schema: { type: 'object', properties: { orderId: { type: 'string' } } } },
            },
          },
          responses: {},
        },
      },
    },
    paths: {
      '/subscribe': {
        post: {
          operationId: 'subscribe',
          callbacks: {
            onEvent: {
              '{$request.body#/callbackUrl}': {
                post: {
                  requestBody: { content: { 'application/json': { schema: { type: 'string' } } } },
                  responses: {},
                },
              },
            },
          },
          responses: {},
        },
      },
    },
  } as OpenApiDocument);
  assert.deepEqual(api.webhooks, [
    {
      name: 'orderPaid',
      source: 'webhook',
      method: 'POST',
      body: { type: 'object', properties: { orderId: { type: 'string' } } },
    },
    {
      name: 'subscribe.onEvent',
      source: 'callback',
      method: 'POST',
      expression: '{$request.body#/callbackUrl}',
      body: { type: 'string' },
    },
  ]);
});
