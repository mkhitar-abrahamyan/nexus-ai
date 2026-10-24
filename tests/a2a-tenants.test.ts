/**
 * One A2A handler serving several tenants, over JSON-RPC, HTTP+JSON, and gRPC: each request routed by
 * the tenant it names, each tenant's tasks and conversations its own, runs carrying the tenant on their
 * principal, and a caller that may not act for the tenant it names refused on every binding. A client
 * names its interface's tenant on every request. Over gRPC, a card's security schemes, requirements,
 * and signatures read as its JSON has them.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createAgent } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import {
  A2A_ERRORS,
  type A2aAgentCard,
  A2aError,
  type A2aHandler,
  type A2aTaskRecord,
  type A2aTaskStore,
  a2aClient,
  a2aHandler,
  MemoryA2aTaskStore,
  storeA2aTasks,
} from '../src/protocols/a2a.js';
import { a2aGrpcClient, a2aGrpcService } from '../src/protocols/a2a-grpc.js';
import { decodeA2a, encodeA2a } from '../src/protocols/a2a-proto.js';
import { MemoryStore } from '../src/store/memory.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

const meta = { provider: 'mock', model: 'mock', requestId: 'r', latencyMs: 1, timestamp: '2026-10-24T00:00:00.000Z' };

/** An agent that asks who it runs for, and answers with the tenant and how many turns the conversation has had. */
function whoAmIAgent() {
  return createAgent({
    client: {
      complete: async (request: CompletionRequest): Promise<NexusResponse> => {
        const said = request.messages.find((message) => message.role === 'tool');
        if (!said) {
          return {
            content: '',
            toolCalls: [{ id: 'c1', type: 'function', function: { name: 'whoami', arguments: '{}' } }],
            meta,
          } as unknown as NexusResponse;
        }
        const turns = request.messages.filter((message) => message.role === 'user').length;
        return {
          content: `for ${String(said.content).replace(/"/g, '')}, turn ${turns}`,
          meta,
        } as unknown as NexusResponse;
      },
    },
    tools: [
      tool({
        name: 'whoami',
        description: 'The tenant this run is for',
        parameters: { type: 'object' },
        execute: async (_args, context) => context?.principal?.tenantId ?? 'nobody',
      }),
    ],
  });
}

/** A Web handler over node:http, as an application mounts it. */
async function serve(handler: (request: Request) => Promise<Response>) {
  let origin = '';
  const server: Server = createServer(async (incoming: IncomingMessage, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const request = new Request(`${origin}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers as Record<string, string>,
      ...(incoming.method === 'GET' || incoming.method === 'DELETE' ? {} : { body: Buffer.concat(chunks) }),
    });
    const response = await handler(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body)
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) outgoing.write(chunk);
    outgoing.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Callers by key: each acts for its own tenant, and the operator, with its role, for any. */
const KEYS: Record<string, { tenantId?: string; roles: string[] }> = {
  'acme-key': { tenantId: 'acme', roles: [] },
  'globex-key': { tenantId: 'globex', roles: [] },
  'operator-key': { roles: ['operator'] },
};
const principalOf = (request: Request) => {
  const key = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  const found = KEYS[key];
  return found ? { userId: key, ...found } : undefined;
};
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

let handler: A2aHandler;
let http: Awaited<ReturnType<typeof serve>>;
let grpc: Awaited<ReturnType<ReturnType<typeof a2aGrpcService>['listen']>>;

before(async () => {
  let target: A2aHandler | undefined;
  http = await serve((request) => (target as A2aHandler)(request));
  grpc = await a2aGrpcService({
    call: (...args: Parameters<A2aHandler['call']>) => (target as A2aHandler).call(...args),
    authenticate: (request: Request) => (target as A2aHandler).authenticate(request),
  } as A2aHandler).listen(0);
  handler = a2aHandler(whoAmIAgent(), {
    card: { name: 'Who', description: 'Says who it runs for', version: '1.0.0', url: `${http.origin}/a2a`, skills: [] },
    principal: principalOf,
    tenants: true,
  });
  target = handler;
});
after(async () => {
  await http.close();
  await grpc.close();
});

const refusedWith = (code: number) => (error: unknown) => error instanceof A2aError && error.code === code;
const answerOf = (task: { artifacts?: Array<{ parts: Array<{ text?: string }> }> }) =>
  task.artifacts?.[0]?.parts.map((part) => part.text ?? '').join('') ?? '';

test('proof: one handler serves two tenants over every binding, each seeing only its own, and a caller acting for another is refused', async () => {
  const acmeRpc = a2aClient({ url: `${http.origin}/a2a`, headers: bearer('acme-key'), tenant: 'acme' });
  const globexRest = a2aClient({
    url: `${http.origin}/a2a`,
    binding: 'HTTP+JSON',
    headers: bearer('globex-key'),
    tenant: 'globex',
  });
  const acmeGrpc = a2aGrpcClient({ url: grpc.url, headers: bearer('acme-key'), tenant: 'acme' });
  try {
    // Two tenants talk in a conversation each calls "shared": each its own.
    const first = await acmeRpc.send('Hello', { contextId: 'shared' });
    assert.equal(answerOf(first), 'for acme, turn 1', 'the run is acme’s');
    const other = await globexRest.send('Hello', { contextId: 'shared' });
    assert.equal(answerOf(other), 'for globex, turn 1', 'globex’s own conversation, not acme’s second turn');
    const second = await acmeGrpc.send('Again', { contextId: 'shared' });
    assert.equal(answerOf(second), 'for acme, turn 2', 'acme’s conversation carries on, over gRPC');

    // Each tenant lists its own tasks, and another's is not found, by any route to it.
    assert.deepEqual((await acmeRpc.listTasks()).tasks.map((task) => task.id).sort(), [first.id, second.id].sort());
    assert.deepEqual(
      (await globexRest.listTasks()).tasks.map((task) => task.id),
      [other.id],
    );
    await assert.rejects(globexRest.getTask(first.id), refusedWith(A2A_ERRORS.taskNotFound));
    await assert.rejects(globexRest.cancel(first.id), refusedWith(A2A_ERRORS.taskNotFound));
    await assert.rejects(globexRest.send('Take it over', { taskId: first.id }), refusedWith(A2A_ERRORS.taskNotFound));
    await assert.rejects(acmeGrpc.getTask(other.id), refusedWith(A2A_ERRORS.taskNotFound));

    // A caller naming a tenant it is not of is refused on every binding, and nothing runs.
    const intruders = [
      a2aClient({ url: `${http.origin}/a2a`, headers: bearer('acme-key'), tenant: 'globex' }),
      a2aClient({ url: `${http.origin}/a2a`, binding: 'HTTP+JSON', headers: bearer('acme-key'), tenant: 'globex' }),
      a2aGrpcClient({ url: grpc.url, headers: bearer('acme-key'), tenant: 'globex' }),
    ];
    for (const intruder of intruders) {
      await assert.rejects(intruder.send('Let me in'), refusedWith(A2A_ERRORS.permissionDenied));
      await assert.rejects(intruder.listTasks(), refusedWith(A2A_ERRORS.permissionDenied));
    }
    await (intruders[2] as ReturnType<typeof a2aGrpcClient>).close();
    const forbidden = await fetch(`${http.origin}/a2a/globex/tasks`, { headers: bearer('acme-key') });
    assert.equal(forbidden.status, 403);
    assert.equal(((await forbidden.json()) as { error: { status: string } }).error.status, 'PERMISSION_DENIED');
    assert.deepEqual(
      (await globexRest.listTasks()).tasks.map((task) => task.id),
      [other.id],
      'no task started for globex by acme',
    );
    // Nobody authenticated may act for any tenant, and a request naming none is refused.
    await assert.rejects(
      a2aClient({ url: `${http.origin}/a2a`, tenant: 'acme' }).send('Hi'),
      refusedWith(A2A_ERRORS.permissionDenied),
    );
    await assert.rejects(
      a2aClient({ url: `${http.origin}/a2a`, headers: bearer('acme-key') }).send('Hi'),
      refusedWith(-32602),
    );
  } finally {
    await acmeGrpc.close();
  }
});

test('who may act for a tenant is the application’s to decide, and a handler may let a request name none', async () => {
  const runs: string[] = [];
  const flexible = a2aHandler(whoAmIAgent(), {
    card: { name: 'Who', description: 'd', version: '1', url: 'http://agent.test/a2a', skills: [] },
    principal: principalOf,
    tenants: {
      authorize: (tenant, principal) =>
        principal?.roles?.includes('operator') === true || principal?.tenantId === tenant,
      required: false,
    },
  });
  const client = (key: string, tenant?: string) =>
    a2aClient({
      url: 'http://agent.test/a2a',
      headers: bearer(key),
      ...(tenant ? { tenant } : {}),
      fetch: async (input, init) => flexible(new Request(input, init)),
    });
  // The operator acts for acme, and the run is acme's, its principal carrying the tenant it named.
  const forAcme = await client('operator-key', 'acme').send('Hello');
  runs.push(answerOf(forAcme));
  // A request naming no tenant is served, within no tenant: it sees none of acme's.
  const untenanted = await client('globex-key').send('Hello');
  runs.push(answerOf(untenanted));
  assert.deepEqual(runs, ['for acme, turn 1', 'for globex, turn 1']);
  assert.deepEqual(
    (await client('globex-key').listTasks()).tasks.map((task) => task.id),
    [untenanted.id],
  );
  await assert.rejects(client('globex-key').getTask(forAcme.id), refusedWith(A2A_ERRORS.taskNotFound));
  await assert.rejects(client('globex-key', 'acme').getTask(forAcme.id), refusedWith(A2A_ERRORS.permissionDenied));
  // Without tenants, a request's tenant is not read, as before.
  const single = a2aHandler(whoAmIAgent(), {
    card: { name: 'Who', description: 'd', version: '1', url: 'http://agent.test/a2a', skills: [] },
    principal: principalOf,
  });
  const plain = a2aClient({
    url: 'http://agent.test/a2a',
    headers: bearer('globex-key'),
    tenant: 'anything',
    fetch: async (input, init) => single(new Request(input, init)),
  });
  assert.equal(answerOf(await plain.send('Hello')), 'for globex, turn 1');
});

test('a store keeps each tenant’s tasks apart, and the handler does too, over a store that does not', async () => {
  const record = (id: string, tenant?: string): A2aTaskRecord => ({
    task: { id, contextId: 'c', status: { state: 'TASK_STATE_COMPLETED' } },
    history: [],
    updatedAt: '2026-10-24T00:00:00.000Z',
    ...(tenant ? { tenant } : {}),
  });
  for (const store of [new MemoryA2aTaskStore(), storeA2aTasks(new MemoryStore())] as A2aTaskStore[]) {
    await store.put(record('a1', 'acme'));
    await store.put(record('g1', 'globex'));
    await store.put(record('n1'));
    const listed = await store.list({ tenant: 'acme', limit: 10, offset: 0 });
    assert.deepEqual(
      listed.records.map((item) => item.task.id),
      ['a1'],
    );
  }
  // A tenant pages through its own tasks in full pages, each once, however many newer ones another
  // tenant has: the store is asked for the tenant's alone.
  const paged = new MemoryA2aTaskStore();
  for (let index = 0; index < 3; index += 1) {
    paged.put({ ...record(`a${index}`, 'acme'), updatedAt: `2026-10-24T00:00:0${index}.000Z` });
    paged.put({ ...record(`g${index}`, 'globex'), updatedAt: `2026-10-24T00:01:0${index}.000Z` });
  }
  const pager = a2aHandler(whoAmIAgent(), {
    card: { name: 'Who', description: 'd', version: '1', url: 'http://agent.test/a2a', skills: [] },
    principal: principalOf,
    tenants: true,
    store: paged,
  });
  const acme = a2aClient({
    url: 'http://agent.test/a2a',
    headers: bearer('acme-key'),
    tenant: 'acme',
    fetch: async (input, init) => pager(new Request(input, init)),
  });
  const firstPage = await acme.listTasks({ pageSize: 2 });
  assert.deepEqual(
    firstPage.tasks.map((task) => task.id),
    ['a2', 'a1'],
    'a full first page of acme’s, newest first',
  );
  const nextPage = await acme.listTasks({ pageSize: 2, pageToken: firstPage.nextPageToken });
  assert.deepEqual(
    nextPage.tasks.map((task) => task.id),
    ['a0'],
  );
  // A store of the application's own that ignores the tenant: the handler still lists only the caller's.
  const careless = new MemoryA2aTaskStore();
  const ignoring: A2aTaskStore = {
    get: (id) => careless.get(id),
    put: (item) => careless.put(item),
    list: ({ tenant: _tenant, ...query }) => careless.list(query),
    conversation: (id) => careless.conversation(id),
    saveConversation: (id, messages) => careless.saveConversation(id, messages),
  };
  careless.put(record('a1', 'acme'));
  careless.put(record('g1', 'globex'));
  const over = a2aHandler(whoAmIAgent(), {
    card: { name: 'Who', description: 'd', version: '1', url: 'http://agent.test/a2a', skills: [] },
    principal: principalOf,
    tenants: true,
    store: ignoring,
  });
  const listed = await a2aClient({
    url: 'http://agent.test/a2a',
    headers: bearer('globex-key'),
    tenant: 'globex',
    fetch: async (input, init) => over(new Request(input, init)),
  }).listTasks();
  assert.deepEqual(
    listed.tasks.map((task) => task.id),
    ['g1'],
  );
});

test('a client names its interface’s tenant on every request: in the params, in the path, and over gRPC', async () => {
  const seen: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const cardJson = {
    name: 'A',
    description: 'd',
    version: '1',
    supportedInterfaces: [
      { url: 'https://agents.example.com/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: 'acme' },
      {
        url: 'https://agents.example.com/a2a',
        protocolBinding: 'HTTP+JSON',
        protocolVersion: '1.0',
        tenant: 'acme/eu',
      },
    ],
  };
  const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith('agent-card.json')) return Response.json(cardJson);
    seen.push({ url, ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
    return url.includes('/tasks/')
      ? Response.json({ id: 't1', contextId: 'c', status: { state: 'TASK_STATE_COMPLETED' } })
      : Response.json({
          jsonrpc: '2.0',
          id: 1,
          result: { id: 't1', contextId: 'c', status: { state: 'TASK_STATE_COMPLETED' } },
        });
  }) as typeof fetch;
  const cardUrl = 'https://agents.example.com/.well-known/agent-card.json';
  /** The tenant the last JSON-RPC call named. */
  const named = () => (seen.at(-1)?.body?.params as { tenant?: string } | undefined)?.tenant;
  await a2aClient({ url: cardUrl, fetch: fetcher }).getTask('t1');
  assert.equal(named(), 'acme');
  await a2aClient({ url: cardUrl, binding: 'HTTP+JSON', fetch: fetcher }).getTask('t1');
  assert.equal(
    seen.at(-1)?.url,
    'https://agents.example.com/a2a/acme%2Feu/tasks/t1',
    'the tenant, encoded, before the route',
  );
  await a2aClient({ url: cardUrl, fetch: fetcher, tenant: 'globex' }).getTask('t1');
  assert.equal(named(), 'globex', 'the client’s own tenant wins');
  await a2aClient({ url: 'https://agents.example.com/a2a', fetch: fetcher }).getTask('t1');
  assert.equal(named(), undefined, 'none named, none sent');
  assert.ok(seen.at(-1)?.body, 'and the call was made');
  // Over gRPC, the tenant is the request message's own field.
  assert.deepEqual(decodeA2a('GetTaskRequest', encodeA2a('GetTaskRequest', { tenant: 'acme', id: 't1' })), {
    tenant: 'acme',
    id: 't1',
  });
});

test('over gRPC, a card’s security schemes, requirements, and signatures read as its JSON has them', async () => {
  const security: Pick<A2aAgentCard, 'securitySchemes' | 'securityRequirements' | 'signatures'> = {
    securitySchemes: {
      key: { apiKeySecurityScheme: { description: 'A key', location: 'header', name: 'X-Api-Key' } },
      bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'JWT' } },
      code: {
        oauth2SecurityScheme: {
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://auth.example.com/authorize',
              tokenUrl: 'https://auth.example.com/token',
              scopes: { 'tasks:read': 'Read tasks' },
              pkceRequired: true,
            },
          },
          oauth2MetadataUrl: 'https://auth.example.com/.well-known/oauth-authorization-server',
        },
      },
      machine: {
        oauth2SecurityScheme: {
          flows: {
            clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: { agents: 'Call agents' } },
          },
        },
      },
      device: {
        oauth2SecurityScheme: {
          flows: {
            deviceCode: {
              deviceAuthorizationUrl: 'https://auth.example.com/device',
              tokenUrl: 'https://auth.example.com/token',
              scopes: { agents: 'Call agents' },
            },
          },
        },
      },
      oidc: {
        openIdConnectSecurityScheme: { openIdConnectUrl: 'https://auth.example.com/.well-known/openid-configuration' },
      },
      mtls: { mtlsSecurityScheme: {} },
    },
    securityRequirements: [{ schemes: { bearer: { list: [] } } }, { schemes: { code: { list: ['tasks:read'] } } }],
    signatures: [{ protected: 'eyJhbGciOiJFUzI1NiJ9', signature: 'c2lnbmVk', header: { kid: 'key-1' } }],
  };
  const skills = [
    {
      id: 'mail',
      name: 'Mail',
      description: 'Sends mail',
      tags: ['mail'],
      securityRequirements: [{ schemes: { key: { list: [] } } }],
    },
  ];
  const secured = a2aHandler(whoAmIAgent(), {
    card: { name: 'Secured', description: 'd', version: '1', url: 'http://agent.test/a2a', skills, ...security },
    principal: principalOf,
    extendedCard: () => ({}),
  });
  const service = await a2aGrpcService(secured).listen(0);
  const client = a2aGrpcClient({ url: service.url, headers: bearer('acme-key') });
  try {
    const overGrpc = await client.extendedCard();
    assert.deepEqual(overGrpc.securitySchemes, security.securitySchemes, 'every scheme, every flow');
    assert.deepEqual(overGrpc.securityRequirements, security.securityRequirements);
    assert.deepEqual(overGrpc.signatures, security.signatures);
    assert.deepEqual(overGrpc.skills, skills, 'a skill’s own requirements too');
    assert.deepEqual(secured.card.securitySchemes, security.securitySchemes, 'and the card served as JSON has them');
  } finally {
    await client.close();
    await service.close();
  }
});
