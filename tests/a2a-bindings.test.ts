/**
 * A2A over every binding: JSON-RPC, HTTP+JSON, and gRPC, from one handler over one task store.
 *
 * One agent asks before it sends an email. A task started over gRPC is answered over HTTP+JSON and
 * read over JSON-RPC, and every binding reads the same task with the same history. A webhook told to
 * receive the answer's text as it is written receives, piece by piece, the same text a stream does.
 * Errors carry the protocol's codes on each binding, and the gRPC messages are read and written as
 * the specification's proto numbers them.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createAgent } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { A2aError, type A2aHandler, type A2aStreamEvent, a2aClient, a2aHandler } from '../src/protocols/a2a.js';
import { a2aGrpcClient, a2aGrpcService } from '../src/protocols/a2a-grpc.js';
import { a2aStatusReason, decodeA2a, encodeA2a, encodeA2aStatus } from '../src/protocols/a2a-proto.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse, StreamChunk } from '../src/types/response.js';

const meta = { provider: 'mock', model: 'mock', requestId: 'r', latencyMs: 1, timestamp: '2026-10-20T00:00:00.000Z' };

/** An agent that asks before it sends an email, then says it sent it. */
function emailAgent(sent: string[]) {
  const client = {
    complete: async (request: CompletionRequest): Promise<NexusResponse> =>
      (request.messages.some((message) => message.role === 'tool')
        ? { content: 'Sent.', meta }
        : {
            content: '',
            toolCalls: [
              { id: 'c1', type: 'function', function: { name: 'send_email', arguments: '{"to":"ceo@example.test"}' } },
            ],
            meta,
          }) as unknown as NexusResponse,
  };
  return createAgent({
    client,
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
}

/** An agent that streams its answer word by word. */
function streamingAgent(words: readonly string[]) {
  const client = {
    complete: async () => ({ content: words.join(''), meta }) as unknown as NexusResponse,
    async *stream(): AsyncIterable<StreamChunk> {
      for (const word of words) yield { type: 'text', content: word } as StreamChunk;
      yield { type: 'done', meta } as StreamChunk;
    },
  };
  return createAgent({ client, streamTokens: true });
}

/** A Web handler served over node:http, as an application would mount it. */
async function serve(handler: (request: Request) => Promise<Response>) {
  let origin = '';
  const server: Server = createServer(async (incoming: IncomingMessage, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const controller = new AbortController();
    outgoing.on('close', () => controller.abort());
    const request = new Request(`${origin}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers as Record<string, string>,
      ...(incoming.method === 'GET' || incoming.method === 'DELETE' ? {} : { body: Buffer.concat(chunks) }),
      signal: controller.signal,
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

/** A webhook that records every delivery. */
async function webhook() {
  const deliveries: Array<{ body: Record<string, unknown>; authorization?: string }> = [];
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    deliveries.push({
      body: JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>,
      ...(incoming.headers.authorization ? { authorization: incoming.headers.authorization } : {}),
    });
    outgoing.writeHead(200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
    deliveries,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const until = async (check: () => boolean, ms = 5_000) => {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const card = (url: string) => ({ name: 'Mailer', description: 'Sends mail', version: '1.0.0', url, skills: [] });

let sent: string[] = [];
let handler: A2aHandler;
let http: Awaited<ReturnType<typeof serve>>;
let grpc: Awaited<ReturnType<ReturnType<typeof a2aGrpcService>['listen']>>;
let hook: Awaited<ReturnType<typeof webhook>>;

before(async () => {
  sent = [];
  hook = await webhook();
  // The handler's URL and the gRPC address are known once both listen; the card is built after.
  let target: A2aHandler | undefined;
  http = await serve((request) => (target as A2aHandler)(request));
  const service = a2aGrpcService({
    call: (...args: Parameters<A2aHandler['call']>) => (target as A2aHandler).call(...args),
    authenticate: (request: Request) => (target as A2aHandler).authenticate(request),
  } as A2aHandler);
  grpc = await service.listen(0);
  handler = a2aHandler(emailAgent(sent), {
    card: card(`${http.origin}/a2a`),
    interfaces: [{ url: grpc.url, protocolBinding: 'GRPC' }],
    pushNotifications: { allowPrivateNetworks: true },
    principal: (request) =>
      request.headers.get('authorization') === 'Bearer partner' ? { id: 'partner', roles: [], scopes: [] } : undefined,
    extendedCard: () => ({ description: 'Sends mail, for partners' }),
  });
  target = handler;
});
after(async () => {
  await http.close();
  await grpc.close();
  await hook.close();
});

test('proof: one agent over three bindings reaches the same task, with the same history, from any of them', async () => {
  const overGrpc = a2aGrpcClient({ url: grpc.url, cardUrl: `${http.origin}/.well-known/agent-card.json` });
  const overHttpJson = a2aClient({ url: `${http.origin}/.well-known/agent-card.json`, binding: 'HTTP+JSON' });
  const overJsonRpc = a2aClient({ url: `${http.origin}/.well-known/agent-card.json` });
  try {
    // The card names all three.
    const listed = (await overGrpc.card()).supportedInterfaces.map((item) => [item.protocolBinding, item.url]);
    assert.deepEqual(listed, [
      ['JSONRPC', `${http.origin}/a2a`],
      ['HTTP+JSON', `${http.origin}/a2a`],
      ['GRPC', grpc.url],
    ]);

    // Started over gRPC, the task waits for approval.
    const paused = await overGrpc.send('Email the CEO');
    assert.equal(paused.status.state, 'TASK_STATE_INPUT_REQUIRED');
    assert.deepEqual(sent, [], 'nothing sent before approval');

    // Answered over HTTP+JSON, it completes.
    const done = await overHttpJson.send('yes', { taskId: paused.id });
    assert.equal(done.status.state, 'TASK_STATE_COMPLETED');
    assert.deepEqual(sent, ['ceo@example.test']);

    // Read over each: the same task, with the same history.
    const [rpc, rest, binary] = await Promise.all([
      overJsonRpc.getTask(paused.id, 10),
      overHttpJson.getTask(paused.id, 10),
      overGrpc.getTask(paused.id, 10),
    ]);
    assert.equal(rpc.history?.length, 3, 'the request, the answer, and the reply');
    assert.deepEqual(rest, rpc, 'HTTP+JSON reads what JSON-RPC does');
    assert.deepEqual(binary, rpc, 'gRPC reads what JSON-RPC does');
    assert.deepEqual(
      rpc.history?.map((message) => [message.role, message.parts.find((part) => part.text)?.text]),
      [
        ['ROLE_USER', 'Email the CEO'],
        ['ROLE_USER', 'yes'],
        ['ROLE_AGENT', 'Sent.'],
      ],
    );

    // Listed over gRPC and HTTP+JSON, filtered by state.
    for (const client of [overGrpc, overHttpJson]) {
      const page = await client.listTasks({ status: 'TASK_STATE_COMPLETED' });
      assert.ok(
        page.tasks.some((task) => task.id === paused.id),
        'the task is listed',
      );
      assert.equal(page.pageSize, 50);
    }
  } finally {
    await overGrpc.close();
  }
});

test('a webhook receives the answer’s text as it is written, the same text a stream does', async () => {
  const words = ['It ', 'is ', 'sunny ', 'in ', 'Yerevan.'];
  const receiver = await webhook();
  const streaming = a2aHandler(streamingAgent(words), {
    card: card('https://agents.example.test/a2a'),
    pushNotifications: { allowPrivateNetworks: true, text: true },
  });
  const server = await serve(streaming);
  try {
    const client = a2aClient({ url: `${server.origin}/a2a` });
    const streamed: A2aStreamEvent[] = [];
    for await (const event of client.stream('Weather?', { push: { url: receiver.url, token: 't' } }))
      streamed.push(event);
    const pieces = (events: A2aStreamEvent[]) =>
      events.flatMap((event) =>
        'artifactUpdate' in event ? event.artifactUpdate.artifact.parts.map((part) => part.text ?? '') : [],
      );
    assert.equal(pieces(streamed).join(''), words.join(''));

    await until(() =>
      receiver.deliveries.some(
        (delivery) =>
          (delivery.body.statusUpdate as { status?: { state?: string } })?.status?.state === 'TASK_STATE_COMPLETED',
      ),
    );
    const pushed = receiver.deliveries.map((delivery) => delivery.body as unknown as A2aStreamEvent);
    assert.deepEqual(pieces(pushed), pieces(streamed), 'piece by piece, the same text');
    const kinds = pushed.map((event) => Object.keys(event)[0]);
    assert.equal(kinds.at(-1), 'statusUpdate', 'the state that ends it comes after the text');
    assert.ok(
      kinds.indexOf('artifactUpdate') > kinds.indexOf('statusUpdate'),
      'the working state comes before the text',
    );
    const last = pushed.filter((event) => 'artifactUpdate' in event).at(-1) as {
      artifactUpdate: { lastChunk?: boolean };
    };
    assert.equal(last.artifactUpdate.lastChunk, true);
  } finally {
    await server.close();
    await receiver.close();
  }

  // Gathered: fewer deliveries, the same text.
  const gathering = await webhook();
  const gathered = a2aHandler(streamingAgent(words), {
    card: card('https://agents.example.test/a2a'),
    pushNotifications: { allowPrivateNetworks: true, text: { everyMs: 1_000 } },
  });
  const outcome = await gathered.call('SendMessage', {
    message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Weather?' }] },
    configuration: { taskPushNotificationConfig: { url: gathering.url } },
  });
  assert.ok('result' in outcome);
  await until(() =>
    gathering.deliveries.some(
      (delivery) =>
        (delivery.body.statusUpdate as { status?: { state?: string } })?.status?.state === 'TASK_STATE_COMPLETED',
    ),
  );
  const texts = gathering.deliveries.filter((delivery) => 'artifactUpdate' in delivery.body);
  assert.equal(texts.length, 1, 'the pieces written within the second, in one delivery');
  assert.equal(
    (texts[0]?.body.artifactUpdate as { artifact: { parts: Array<{ text: string }> } } | undefined)?.artifact.parts[0]
      ?.text,
    words.join(''),
  );
  await gathering.close();

  // Without `text`, only changes of state are pushed.
  const quiet = await webhook();
  const plain = a2aHandler(streamingAgent(words), {
    card: card('https://agents.example.test/a2a'),
    pushNotifications: { allowPrivateNetworks: true },
  });
  await plain.call('SendMessage', {
    message: { messageId: 'm2', role: 'ROLE_USER', parts: [{ text: 'Weather?' }] },
    configuration: { taskPushNotificationConfig: { url: quiet.url } },
  });
  await until(() => quiet.deliveries.length >= 2);
  assert.ok(quiet.deliveries.every((delivery) => 'statusUpdate' in delivery.body));
  await quiet.close();
});

test('the stream of a task reads the same over gRPC and HTTP+JSON as over JSON-RPC', async () => {
  const words = ['One ', 'two ', 'three.'];
  const streaming = a2aHandler(streamingAgent(words), { card: card('https://agents.example.test/a2a') });
  const server = await serve(streaming);
  const service = await a2aGrpcService(streaming).listen(0);
  const overGrpc = a2aGrpcClient({ url: service.url });
  try {
    const text = async (events: AsyncIterable<A2aStreamEvent>) => {
      let said = '';
      const states: string[] = [];
      for await (const event of events) {
        if ('artifactUpdate' in event)
          said += event.artifactUpdate.artifact.parts.map((part) => part.text ?? '').join('');
        if ('statusUpdate' in event) states.push(event.statusUpdate.status.state);
        if ('task' in event) states.push(`task:${event.task.status.state}`);
      }
      return { said, states };
    };
    const rpc = await text(a2aClient({ url: `${server.origin}/a2a` }).stream('Count'));
    const rest = await text(a2aClient({ url: `${server.origin}/a2a`, binding: 'HTTP+JSON' }).stream('Count'));
    const binary = await text(overGrpc.stream('Count'));
    assert.deepEqual(rpc, {
      said: 'One two three.',
      states: ['task:TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_COMPLETED'],
    });
    assert.deepEqual(rest, rpc);
    assert.deepEqual(binary, rpc);

    // A client still connected does not hold the server open.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      service.close().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 2_000);
      }),
    ]);
    clearTimeout(timer);
    assert.equal(closed, true, 'the service closes with a client connected');
  } finally {
    await overGrpc.close();
    await service.close();
    await server.close();
  }
});

test('errors carry the protocol’s codes on every binding', async () => {
  const overGrpc = a2aGrpcClient({ url: grpc.url });
  const overHttpJson = a2aClient({ url: `${http.origin}/a2a`, binding: 'HTTP+JSON' });
  const overJsonRpc = a2aClient({ url: `${http.origin}/a2a` });
  try {
    for (const client of [overGrpc, overHttpJson, overJsonRpc]) {
      await assert.rejects(client.getTask('task-missing'), (error: unknown) => {
        assert.ok(error instanceof A2aError, `an A2A error: ${String(error)}`);
        assert.equal(error.code, -32001, 'task not found');
        assert.match(error.message, /Task task-missing was not found/);
        return true;
      });
      await assert.rejects(
        client.extendedCard(),
        (error: unknown) => error instanceof A2aError && error.code === -32007,
      );
    }

    // HTTP+JSON: AIP-193's JSON, with the ErrorInfo.
    const missing = await fetch(`${http.origin}/a2a/tasks/task-missing`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: {
        code: 404,
        status: 'NOT_FOUND',
        message: 'Task task-missing was not found',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TASK_NOT_FOUND', domain: 'a2a-protocol.org' },
        ],
      },
    });
    const version = await fetch(`${http.origin}/a2a/tasks`, { headers: { 'a2a-version': '2.0' } });
    assert.equal(version.status, 400);
    assert.equal(
      ((await version.json()) as { error: { details: Array<{ reason: string }> } }).error.details[0]?.reason,
      'VERSION_NOT_SUPPORTED',
    );
    const broken = await fetch(`${http.origin}/a2a/message:send`, { method: 'POST', body: '{' });
    assert.equal(broken.status, 400);
    assert.equal((await fetch(`${http.origin}/a2a/nothing-here`)).status, 404);

    // gRPC: a status, and the ErrorInfo in grpc-status-details-bin.
    const raw = async (path: string, body: Uint8Array, headers: Record<string, string> = {}) => {
      const session = http2.connect(`http://${grpc.url}`);
      try {
        const request = session.request({
          ':method': 'POST',
          ':path': path,
          'content-type': 'application/grpc',
          te: 'trailers',
          ...headers,
        });
        const framed = new Uint8Array(5 + body.length);
        new DataView(framed.buffer).setUint32(1, body.length);
        framed.set(body, 5);
        request.end(framed);
        const status: Record<string, unknown> = {};
        request.on('response', (head) => Object.assign(status, head));
        request.on('trailers', (trailers) => Object.assign(status, trailers));
        for await (const _chunk of request) {
          // drained
        }
        return status;
      } finally {
        session.close();
      }
    };
    const notFound = await raw('/lf.a2a.v1.A2AService/GetTask', encodeA2a('GetTaskRequest', { id: 'task-missing' }));
    assert.equal(notFound['grpc-status'], '5');
    assert.deepEqual(a2aStatusReason(Buffer.from(String(notFound['grpc-status-details-bin']), 'base64')), {
      message: 'Task task-missing was not found',
      reason: 'TASK_NOT_FOUND',
    });
    assert.equal((await raw('/lf.a2a.v1.A2AService/Nope', new Uint8Array()))['grpc-status'], '12', 'unimplemented');
    const wrongVersion = await raw('/lf.a2a.v1.A2AService/GetTask', encodeA2a('GetTaskRequest', { id: 'x' }), {
      'a2a-version': '2.0',
    });
    assert.equal(wrongVersion['grpc-status'], '12');
    assert.equal(
      a2aStatusReason(Buffer.from(String(wrongVersion['grpc-status-details-bin']), 'base64')).reason,
      'VERSION_NOT_SUPPORTED',
    );

    // The caller is read from gRPC metadata by the handler's own principal.
    const partner = a2aGrpcClient({ url: grpc.url, headers: { authorization: 'Bearer partner' } });
    try {
      assert.equal((await partner.extendedCard()).description, 'Sends mail, for partners');
    } finally {
      await partner.close();
    }
  } finally {
    await overGrpc.close();
  }
});

test('push configs as protocol 1.0 shapes them, on every binding, with their authentication', async () => {
  const overHttpJson = a2aClient({ url: `${http.origin}/a2a`, binding: 'HTTP+JSON' });
  const overGrpc = a2aGrpcClient({ url: grpc.url });
  try {
    const paused = await overHttpJson.send('Email the CEO');
    const config = await overHttpJson.setPushNotification(paused.id, {
      url: hook.url,
      authentication: { scheme: 'Bearer', credentials: 'hook-secret' },
    });
    assert.equal(config.url, hook.url);
    assert.deepEqual(config.authentication, { scheme: 'Bearer', credentials: 'hook-secret' });
    assert.deepEqual(
      (await overGrpc.listPushNotifications(paused.id)).map((item) => item.id),
      [config.id],
      'read over gRPC what HTTP+JSON wrote',
    );
    // Raw HTTP+JSON: flat, with the task's id.
    const listed = (await (await fetch(`${http.origin}/a2a/tasks/${paused.id}/pushNotificationConfigs`)).json()) as {
      configs: Array<Record<string, unknown>>;
    };
    assert.deepEqual(listed.configs[0], { taskId: paused.id, ...config });
    // JSON-RPC 1.0 names, and the drafts' nested shape beside the flat one.
    const got = await handler.call('GetTaskPushNotificationConfig', { taskId: paused.id, id: config.id });
    assert.ok('result' in got);
    assert.deepEqual(got.result, { taskId: paused.id, ...config, pushNotificationConfig: config });

    // A delivery carries its authentication.
    hook.deliveries.length = 0;
    await overHttpJson.send('yes', { taskId: paused.id });
    await until(() => hook.deliveries.length > 0);
    assert.equal(hook.deliveries[0]?.authorization, 'Bearer hook-secret');

    await overGrpc.deletePushNotification(paused.id, config.id as string);
    assert.deepEqual(await overHttpJson.listPushNotifications(paused.id), []);
  } finally {
    await overGrpc.close();
  }
});

test('the gRPC codec reads and writes the specification’s messages', () => {
  const task = {
    id: 'task-1',
    contextId: 'ctx-1',
    status: {
      state: 'TASK_STATE_INPUT_REQUIRED',
      timestamp: '2026-10-20T08:30:01.123Z',
      message: {
        messageId: 'm1',
        role: 'ROLE_AGENT',
        parts: [
          { text: '' },
          { data: { interrupts: [{ id: 'i1', count: 2, ok: true, none: null }], ratio: 0.25 } },
          { raw: 'AAEC/w==', mediaType: 'application/octet-stream', filename: 'blob.bin' },
          { url: 'https://example.test/a.pdf' },
        ],
        metadata: { nested: { list: ['a', 1, false] } },
        referenceTaskIds: ['t0'],
      },
    },
    artifacts: [{ artifactId: 'a1', name: 'answer', parts: [{ text: 'hi' }] }],
    history: [{ messageId: 'm0', role: 'ROLE_USER', parts: [{ text: 'hello' }] }],
    metadata: { tenant: 'acme' },
  };
  assert.deepEqual(decodeA2a('Task', encodeA2a('Task', task)), task, 'every field round-trips');

  // proto3 defaults are left out; an optional field at its default is kept.
  assert.deepEqual(decodeA2a('GetTaskRequest', encodeA2a('GetTaskRequest', { id: 'x', historyLength: 0 })), {
    id: 'x',
    historyLength: 0,
  });
  assert.deepEqual(
    decodeA2a(
      'ListTasksResponse',
      encodeA2a('ListTasksResponse', { tasks: [], nextPageToken: '', pageSize: 50, totalSize: -1 }),
    ),
    { tasks: [], pageSize: 50, totalSize: -1 },
    'a list the specification requires is read as empty',
  );
  // A field the agent does not know, such as a card's security schemes, is read past.
  const known = encodeA2a('AgentCard', { name: 'A', version: '1' });
  const unknown = Uint8Array.from([...known, 0x42, 0x03, 0x0a, 0x01, 0x78]);
  assert.deepEqual(decodeA2a('AgentCard', unknown), {
    name: 'A',
    version: '1',
    supportedInterfaces: [],
    defaultInputModes: [],
    defaultOutputModes: [],
    skills: [],
  });
  // The bytes the specification's proto gives a Message.
  assert.deepEqual(
    [...encodeA2a('Message', { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'hi' }] })],
    [0x0a, 0x01, 0x6d, 0x20, 0x01, 0x2a, 0x04, 0x0a, 0x02, 0x68, 0x69],
  );
  assert.deepEqual(a2aStatusReason(encodeA2aStatus(5, 'gone', 'TASK_NOT_FOUND')), {
    message: 'gone',
    reason: 'TASK_NOT_FOUND',
  });
  assert.throws(() => decodeA2a('Task', Uint8Array.from([0x0a, 0x05, 0x61])), /ended inside a field/);
});
