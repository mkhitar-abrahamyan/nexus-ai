#!/usr/bin/env node
/**
 * Each agent protocol against the reference client of its own project: `@ag-ui/client` drives the
 * AG-UI handler, `@a2a-js/sdk` the A2A agent over each of its three bindings, and for several tenants, and
 * `@agentclientprotocol/sdk` an ACP agent it starts as an editor would, offering it MCP servers built
 * with `@modelcontextprotocol/sdk` over stdio, HTTP, and SSE. Run nightly, against the clients' latest releases, so a change on their side
 * shows up before a user finds it.
 *
 *   node scripts/interop/run.mjs                       # installs the latest clients in a fresh directory
 *   node scripts/interop/run.mjs --clients <directory> # uses clients already installed there
 *
 * Needs `npm run build`. The clients are third-party code, so they are installed with
 * `--ignore-scripts` in a directory of their own, and only imported from there.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const given = args.includes('--clients') ? args[args.indexOf('--clients') + 1] : undefined;
const CLIENTS = ['@ag-ui/client', '@a2a-js/sdk', '@agentclientprotocol/sdk', '@modelcontextprotocol/sdk'];
// What `@a2a-js/sdk`'s gRPC transport needs beside it, as its peers.
const PEERS = ['@grpc/grpc-js', '@bufbuild/protobuf'];

let directory = given;
if (!directory) {
  directory = mkdtempSync(path.join(tmpdir(), 'nexus-interop-'));
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'interop-clients', private: true }));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const installed = spawnSync(
    npm,
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...[...CLIENTS, ...PEERS].map((name) => `${name}@latest`),
    ],
    { cwd: directory, stdio: 'inherit', shell: process.platform === 'win32' },
  );
  if (installed.status !== 0) throw new Error('Could not install the reference clients');
}
const resolve = createRequire(path.join(directory, 'package.json')).resolve;
const load = async (specifier) => import(pathToFileURL(resolve(specifier)).href);
// Read from the file: a package need not export its package.json.
const versionOf = (name) =>
  JSON.parse(readFileSync(path.join(directory, 'node_modules', ...name.split('/'), 'package.json'), 'utf8')).version;

const { createAgent, tool } = await import('../../dist/agent/index.js');
const { agUiHandler } = await import('../../dist/protocols/ag-ui.js');
const { a2aHandler, canonicalA2aCard, verifyA2aCard } = await import('../../dist/protocols/a2a.js');
const { a2aGrpcService } = await import('../../dist/protocols/a2a-grpc.js');
const { mcpSdk, mcpTools } = await import('./mcp-server.mjs');

/**
 * Drives an ACP agent as an editor, as the SDK builds one: from 2.0, an app with a handler per method
 * and the calls made inside `connectWith()`; before it, a `ClientSideConnection` over the editor.
 */
function driveEditor(acp, stream, editor, calls) {
  if (typeof acp.client === 'function') {
    let app = acp
      .client()
      .onRequest('session/request_permission', ({ params }) => editor.requestPermission(params))
      .onNotification('session/update', ({ params }) => editor.sessionUpdate(params));
    if (editor.readTextFile) app = app.onRequest('fs/read_text_file', ({ params }) => editor.readTextFile(params));
    if (editor.writeTextFile) app = app.onRequest('fs/write_text_file', ({ params }) => editor.writeTextFile(params));
    return app.connectWith(stream, (agent) => calls((method, params) => agent.request(method, params)));
  }
  const connection = new acp.ClientSideConnection(() => editor, stream);
  const named = {
    initialize: 'initialize',
    'session/new': 'newSession',
    'session/prompt': 'prompt',
    'session/load': 'loadSession',
  };
  return calls((method, params) => connection[named[method]](params));
}

/** Serves a `Request` → `Response` handler over real HTTP, streaming its body. */
async function serve(handler) {
  const server = createServer(async (incoming, outgoing) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(key, value);
    const response = await handler(
      new Request(`http://${incoming.headers.host}${incoming.url}`, {
        method: incoming.method,
        headers,
        ...(body && incoming.method !== 'GET' ? { body } : {}),
      }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) outgoing.write(chunk);
    outgoing.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) };
}

/** An agent that sends one email after a person approves, then reports it. */
function mailer() {
  return createAgent({
    client: {
      async complete(request) {
        const last = request.messages.at(-1);
        if (last?.role !== 'tool') {
          return {
            content: '',
            role: 'assistant',
            finishReason: 'tool_calls',
            meta: {},
            toolCalls: [
              {
                id: `call-${request.messages.length}`,
                type: 'function',
                function: { name: 'send_email', arguments: '{"to":"ana"}' },
              },
            ],
          };
        }
        return { content: `Sent: ${last.content}`, role: 'assistant', finishReason: 'stop', meta: {} };
      },
    },
    model: 'mock',
    tools: [
      tool({
        name: 'send_email',
        description: 'Sends an email',
        parameters: { type: 'object' },
        async *stream() {
          yield 'drafting';
          return 'delivered';
        },
      }),
    ],
    interruptOn: { send_email: true },
  });
}

const failures = [];
const check = (label, condition, detail = '') => {
  if (!condition) failures.push(`${label}${detail ? `: ${detail}` : ''}`);
};

// ── AG-UI ──────────────────────────────────────────────────────────

{
  const { HttpAgent } = await load('@ag-ui/client');
  const server = await serve(agUiHandler(mailer(), { stateDeltas: true, messagesSnapshot: true }));
  try {
    const agent = new HttpAgent({ url: server.url, threadId: 'interop-thread' });
    agent.addMessage({ id: 'm1', role: 'user', content: 'Email Ana' });
    const types = [];
    const onEvent = ({ event }) => types.push(event.type);
    await agent.runAgent({ runId: 'r1' }, { onEvent });
    check(
      'AG-UI: a run starts and finishes',
      types[0] === 'RUN_STARTED' && types.at(-1) === 'RUN_FINISHED',
      types.join(','),
    );
    const interrupt = agent.pendingInterrupts?.[0];
    check('AG-UI: the run paused for approval', Boolean(interrupt));
    const resumed = await agent.runAgent(
      { runId: 'r2', ...(interrupt ? { resume: [{ interruptId: interrupt.id, status: 'resolved' }] } : {}) },
      { onEvent },
    );
    check('AG-UI: state deltas apply in the client', types.includes('STATE_DELTA'));
    const answer = JSON.stringify(resumed.result ?? agent.state?.answer);
    check('AG-UI: the paused run resumes and answers', answer.includes('Sent'), answer);
    check(
      'AG-UI: the client rebuilt the state from its deltas',
      agent.state?.answer === 'Sent: "delivered"',
      JSON.stringify(agent.state?.answer),
    );
    check('AG-UI: the transcript arrived', agent.messages.length >= 2, String(agent.messages.length));
  } catch (error) {
    failures.push(`AG-UI: ${error?.stack ?? error}`);
  } finally {
    await server.close();
  }
}

// ── A2A ────────────────────────────────────────────────────────────

{
  const { ClientFactory, ClientFactoryOptions } = await load('@a2a-js/sdk/client');
  const { GrpcTransportFactory } = await load('@a2a-js/sdk/client/grpc');
  const { ListTaskPushNotificationConfigsRequest, ListTasksRequest, Message, Task, TaskPushNotificationConfig } =
    await load('@a2a-js/sdk');
  let handler;
  // What each binding was asked, to be sure the client spoke it.
  const routes = new Set();
  const overGrpc = new Set();
  const server = await serve((request) => {
    routes.add(new URL(request.url).pathname);
    return handler(request);
  });
  const grpc = await a2aGrpcService({
    call: (method, params, context) => {
      overGrpc.add(method);
      return handler.call(method, params, context);
    },
    authenticate: (request) => handler.authenticate(request),
  }).listen(0);
  handler = a2aHandler(mailer(), {
    card: { name: 'Interop mailer', description: 'Sends mail', version: '1.0.0', url: `${server.url}/a2a`, skills: [] },
    interfaces: [{ url: grpc.url, protocolBinding: 'GRPC' }],
    pushNotifications: { allowPrivateNetworks: true },
  });
  try {
    const clients = {};
    for (const binding of ['JSONRPC', 'HTTP+JSON', 'GRPC']) {
      const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new GrpcTransportFactory()],
        preferredTransports: [binding],
      });
      clients[binding] = await new ClientFactory(options).createFromUrl(server.url);
    }
    const message = (text, taskId) =>
      Message.fromJSON({
        messageId: `m-${Math.random()}`,
        role: 'ROLE_USER',
        parts: [{ text }],
        ...(taskId ? { taskId } : {}),
      });
    const asJson = (result) => Task.toJSON(result.task ?? result.payload?.value ?? result);
    for (const [binding, client] of Object.entries(clients)) {
      const paused = asJson(await client.sendMessage({ message: message('Email Ana') }));
      check(
        `A2A ${binding}: a task pauses for approval`,
        paused.status?.state === 'TASK_STATE_INPUT_REQUIRED',
        JSON.stringify(paused.status),
      );
      const done = asJson(await client.sendMessage({ message: message('yes', paused.id) }));
      check(
        `A2A ${binding}: the answer completes it`,
        done.status?.state === 'TASK_STATE_COMPLETED',
        JSON.stringify(done.status),
      );
      const read = Task.toJSON(await client.getTask({ id: paused.id }));
      check(`A2A ${binding}: the task reads back`, read.id === paused.id);
      const listed = await client.listTasks(ListTasksRequest.fromJSON({}));
      check(`A2A ${binding}: tasks are listed`, (listed.tasks ?? []).length >= 1);
      const events = [];
      for await (const event of client.sendMessageStream({ message: message('Email Rui') })) events.push(event);
      check(`A2A ${binding}: a task streams`, events.length >= 2, String(events.length));
      const config = await client.createTaskPushNotificationConfig(
        TaskPushNotificationConfig.fromJSON({ taskId: paused.id, url: 'http://127.0.0.1:9/hook', token: binding }),
      );
      const configs = await client.listTaskPushNotificationConfig(
        ListTaskPushNotificationConfigsRequest.fromJSON({ taskId: paused.id }),
      );
      check(
        `A2A ${binding}: a webhook is set and listed`,
        (configs.configs ?? []).some((item) => item.id === config.id && item.token === binding),
        JSON.stringify(configs),
      );
    }
    check('A2A: JSON-RPC was spoken', routes.has('/a2a'), [...routes].join(','));
    check('A2A: HTTP+JSON was spoken', routes.has('/a2a/message:send'), [...routes].join(','));
    check('A2A: gRPC was spoken', overGrpc.has('SendMessage'), [...overGrpc].join(','));

    // One task across the three: started over gRPC, answered over HTTP+JSON, read over each.
    const started = asJson(await clients.GRPC.sendMessage({ message: message('Email Ana') }));
    const finished = asJson(await clients['HTTP+JSON'].sendMessage({ message: message('yes', started.id) }));
    check(
      'A2A: a task started over gRPC is answered over HTTP+JSON',
      finished.id === started.id && finished.status?.state === 'TASK_STATE_COMPLETED',
      JSON.stringify(finished.status),
    );
    const reads = await Promise.all(
      Object.values(clients).map(async (client) =>
        Task.toJSON(await client.getTask({ id: started.id, historyLength: 10 })),
      ),
    );
    const histories = reads.map((read) => JSON.stringify(read.history));
    check(
      'A2A: every binding reads the same history',
      reads[0].history?.length === 3 && histories.every((history) => history === histories[0]),
      histories.join(' | '),
    );
  } catch (error) {
    failures.push(`A2A: ${error?.stack ?? error}`);
  } finally {
    await server.close();
    await grpc.close();
  }
}

// ── A2A card signatures ────────────────────────────────────────────

// The reference SDK and this package compute one canonical form of a card, and each verifies the
// other's signature: a card this package's handler signs, a tenant's included, and one the SDK signs.
{
  const sdk = await load('@a2a-js/sdk');
  const { subtle } = globalThis.crypto;
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  // Without the label Web Crypto writes, which jose holds a key to as strictly as its algorithm.
  const { alg: _private, ...privateJwk } = await subtle.exportKey('jwk', pair.privateKey);
  const { alg: _public, ...publicJwk } = await subtle.exportKey('jwk', pair.publicKey);
  let handler;
  const server = await serve((request) => handler(request));
  handler = a2aHandler(mailer(), {
    card: { name: 'Signed mailer', description: 'Sends mail', version: '1.0.0', url: `${server.url}/a2a`, skills: [] },
    sign: { key: privateJwk, alg: 'ES256', kid: 'interop' },
    tenants: { required: false, authorize: () => true },
  });
  try {
    for (const [label, path] of [
      ['its card', '/.well-known/agent-card.json'],
      ['a tenant’s card', '/acme/.well-known/agent-card.json'],
    ]) {
      const served = await (await fetch(`${server.url}${path}`)).json();
      check(
        `A2A signatures: the SDK and this package write ${label} in one canonical form`,
        sdk.canonicalizeAgentCard(served) === canonicalA2aCard(served),
      );
      const verified = await sdk
        .verifyAgentCardSignature(async () => publicJwk)(served)
        .then(
          () => '',
          (error) => String(error?.message ?? error),
        );
      check(`A2A signatures: the SDK verifies ${label}, signed here`, verified === '', verified);
    }
    const { signatures: _signatures, ...unsigned } = await (
      await fetch(`${server.url}/.well-known/agent-card.json`)
    ).json();
    const signedBySdk = await sdk.generateAgentCardSignature(privateJwk, { alg: 'ES256', kid: 'sdk', typ: 'JOSE' })(
      unsigned,
    );
    const ours = await verifyA2aCard(signedBySdk, () => publicJwk).then(
      (result) => result.kid,
      (error) => String(error?.message ?? error),
    );
    check('A2A signatures: this package verifies a card the SDK signed', ours === 'sdk', ours);
  } catch (error) {
    failures.push(`A2A signatures: ${error?.stack ?? error}`);
  } finally {
    await server.close();
  }
}

// ── A2A, for several tenants ───────────────────────────────────────

// One handler serving tenants: the reference client reads a tenant's own card, whose every interface
// names the tenant, and calls as that tenant over each binding; a tenant it may not act for is refused.
// The card is resolved relative to the URL the client is given, so a tenant's ends in a slash.
{
  const { ClientFactory, ClientFactoryOptions } = await load('@a2a-js/sdk/client');
  const { GrpcTransportFactory } = await load('@a2a-js/sdk/client/grpc');
  const { ListTasksRequest, Message, Task } = await load('@a2a-js/sdk');
  let handler;
  const routes = new Set();
  const overGrpc = new Set();
  const server = await serve((request) => {
    routes.add(new URL(request.url).pathname);
    return handler(request);
  });
  const grpc = await a2aGrpcService({
    call: (method, params, context) => {
      if (typeof params?.tenant === 'string') overGrpc.add(params.tenant);
      return handler.call(method, params, context);
    },
    authenticate: (request) => handler.authenticate(request),
  }).listen(0);
  handler = a2aHandler(mailer(), {
    card: {
      name: 'Tenant mailer',
      description: 'Sends mail for its tenants',
      version: '1.0.0',
      url: `${server.url}/a2a`,
      skills: [],
    },
    interfaces: [{ url: grpc.url, protocolBinding: 'GRPC' }],
    // Nobody is authenticated here: the stand-in lets anyone act for acme, and no other tenant.
    tenants: { authorize: (tenant) => tenant === 'acme' },
  });
  const clientFor = (where, binding) =>
    new ClientFactory(
      ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
        transports: [new GrpcTransportFactory()],
        preferredTransports: [binding],
      }),
    ).createFromUrl(where);
  const message = (text, taskId) =>
    Message.fromJSON({
      messageId: `m-${Math.random()}`,
      role: 'ROLE_USER',
      parts: [{ text }],
      ...(taskId ? { taskId } : {}),
    });
  const asJson = (result) => Task.toJSON(result.task ?? result.payload?.value ?? result);
  const refusal = async (send) => {
    try {
      await send();
      return '';
    } catch (error) {
      return String(error?.message ?? error);
    }
  };
  try {
    const started = [];
    for (const binding of ['JSONRPC', 'HTTP+JSON', 'GRPC']) {
      const acme = await clientFor(`${server.url}/acme/`, binding);
      const paused = asJson(await acme.sendMessage({ message: message('Email Ana') }));
      const done = asJson(await acme.sendMessage({ message: message('yes', paused.id) }));
      check(
        `A2A tenants ${binding}: a task runs as the tenant its card names`,
        done.id === paused.id && done.status?.state === 'TASK_STATE_COMPLETED',
        JSON.stringify(done.status),
      );
      started.push(paused.id);
      const globex = await clientFor(`${server.url}/globex/`, binding);
      const refused = await refusal(() => globex.sendMessage({ message: message('Email Rui') }));
      check(`A2A tenants ${binding}: a tenant it may not act for is refused`, refused !== '', 'it answered');
      const untenanted = await clientFor(server.url, binding);
      const unnamed = await refusal(() => untenanted.sendMessage({ message: message('Email Rui') }));
      check(`A2A tenants ${binding}: a call naming no tenant is refused`, unnamed !== '', 'it answered');
    }
    const listed = await (await clientFor(`${server.url}/acme/`, 'HTTP+JSON')).listTasks(ListTasksRequest.fromJSON({}));
    const ids = (listed.tasks ?? []).map((task) => task.id);
    check(
      'A2A tenants: the tenant lists the tasks it started over every binding, and only those',
      started.every((id) => ids.includes(id)) && ids.length === started.length,
      ids.join(','),
    );
    check(
      'A2A tenants: HTTP+JSON named the tenant in the path',
      routes.has('/a2a/acme/message:send'),
      [...routes].join(','),
    );
    check('A2A tenants: gRPC named the tenant', overGrpc.has('acme'), [...overGrpc].join(','));
  } catch (error) {
    failures.push(`A2A tenants: ${error?.stack ?? error}`);
  } finally {
    await server.close();
    await grpc.close();
  }
}

// ── ACP ────────────────────────────────────────────────────────────

{
  const acp = await load('@agentclientprotocol/sdk');
  const child = spawn(process.execPath, [path.join(here, 'acp-agent.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });
  try {
    const updates = [];
    const files = new Map([['/work/notes.md', 'draft']]);
    const editor = {
      async requestPermission(params) {
        return { outcome: { outcome: 'selected', optionId: params.options[0].optionId } };
      },
      async sessionUpdate(params) {
        updates.push(params.update);
      },
      async readTextFile(params) {
        return { content: files.get(params.path) ?? '' };
      },
      async writeTextFile(params) {
        files.set(params.path, params.content);
        return {};
      },
    };
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    await driveEditor(acp, stream, editor, async (request) => {
      const init = await request('initialize', {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      });
      check('ACP: the agent can load sessions', init.agentCapabilities?.loadSession === true);
      const session = await request('session/new', { cwd: '/work', mcpServers: [] });
      const turn = await request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Review notes.md' }],
      });
      check('ACP: the turn ends', turn.stopReason === 'end_turn', turn.stopReason);
      check('ACP: the agent wrote through the editor, after asking', files.get('/work/notes.md') === 'reviewed');
      const said = updates
        .filter((update) => update.sessionUpdate === 'agent_message_chunk')
        .map((update) => update.content.text);
      check(
        'ACP: the agent reported what it did',
        said.some((text) => text.includes('draft')),
        said.join(' '),
      );
      updates.length = 0;
      await request('session/load', { sessionId: session.sessionId, cwd: '/work', mcpServers: [] });
      check(
        'ACP: a loaded session replays its conversation',
        updates.some((update) => update.sessionUpdate === 'user_message_chunk'),
      );
    });
  } catch (error) {
    failures.push(`ACP: ${error?.stack ?? error}`);
  } finally {
    child.kill();
  }
}

// ── ACP, with the editor's MCP servers ─────────────────────────────

{
  const acp = await load('@agentclientprotocol/sdk');
  const sdk = await mcpSdk(directory);
  const work = mkdtempSync(path.join(tmpdir(), 'nexus-interop-mcp-'));
  const localLog = path.join(work, 'local.log');
  writeFileSync(localLog, '');
  const called = { remote: [], streamed: [] };
  const listen = async (server) => {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    return `http://127.0.0.1:${server.address().port}`;
  };
  // Streamable HTTP without sessions: a server and a transport per request, as the SDK shows it.
  const http = createServer(async (incoming, outgoing) => {
    const server = mcpTools(new sdk.McpServer({ name: 'remote', version: '1.0.0' }), 'remote', (tool) =>
      called.remote.push(tool),
    );
    const transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    outgoing.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    await transport.handleRequest(incoming, outgoing, body ? JSON.parse(body) : undefined);
  });
  // HTTP with Server-Sent Events: a stream per connection, and messages posted where it says.
  const streams = new Map();
  const sse = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url, 'http://localhost');
    if (incoming.method === 'GET' && url.pathname === '/sse') {
      const transport = new sdk.SSEServerTransport('/messages', outgoing);
      streams.set(transport.sessionId, transport);
      const server = mcpTools(new sdk.McpServer({ name: 'streamed', version: '1.0.0' }), 'streamed', (tool) =>
        called.streamed.push(tool),
      );
      await server.connect(transport);
      return;
    }
    const transport = streams.get(url.searchParams.get('sessionId'));
    if (incoming.method === 'POST' && transport) return transport.handlePostMessage(incoming, outgoing);
    outgoing.writeHead(404).end();
  });
  const httpUrl = `${await listen(http)}/mcp`;
  const sseUrl = `${await listen(sse)}/sse`;
  const child = spawn(process.execPath, [path.join(here, 'acp-agent.mjs'), '--mcp'], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const updates = [];
    const editor = {
      async requestPermission(params) {
        return { outcome: { outcome: 'selected', optionId: params.options[0].optionId } };
      },
      async sessionUpdate(params) {
        updates.push(params.update);
      },
    };
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
    await driveEditor(acp, stream, editor, async (request) => {
      const init = await request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      check(
        'ACP: the agent connects MCP servers over HTTP and SSE',
        init.agentCapabilities?.mcpCapabilities?.http === true && init.agentCapabilities?.mcpCapabilities?.sse === true,
        JSON.stringify(init.agentCapabilities?.mcpCapabilities),
      );
      // The stdio server runs in the session's directory: not the one removed afterwards, which a
      // server still stopping would hold on Windows.
      const session = await request('session/new', {
        cwd: here,
        mcpServers: [
          {
            name: 'local',
            command: process.execPath,
            args: [path.join(here, 'mcp-server.mjs'), directory, 'local', localLog],
            env: [],
          },
          { type: 'http', name: 'remote', url: httpUrl, headers: [] },
          { type: 'sse', name: 'streamed', url: sseUrl, headers: [] },
        ],
      });
      const turn = await request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Tidy the records' }],
      });
      check('ACP with MCP: the turn ends', turn.stopReason === 'end_turn', turn.stopReason);
    });
    const local = readFileSync(localLog, 'utf8').split('\n').filter(Boolean);
    for (const [name, calls] of [
      ['stdio', local],
      ['HTTP', called.remote],
      ['SSE', called.streamed],
    ]) {
      check(
        `ACP with MCP: the ${name} server's tool that reads ran, and its destructive one never`,
        calls.join() === 'lookup',
        calls.join(),
      );
    }
    const said = updates
      .filter((update) => update.sessionUpdate === 'agent_message_chunk')
      .map((update) => update.content.text)
      .join('');
    check(
      'ACP with MCP: the agent heard from all three servers, and was refused the rest by its policy',
      ['local found it', 'remote found it', 'streamed found it'].every((text) => said.includes(text)) &&
        said.split('Permission denied').length === 4,
      said,
    );
  } catch (error) {
    failures.push(`ACP with MCP: ${error?.stack ?? error}`);
  } finally {
    child.kill();
    for (const server of [http, sse]) {
      server.closeAllConnections();
      server.close();
    }
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

const versions = [...CLIENTS, ...PEERS].map((name) => `${name}@${versionOf(name)}`).join(', ');
if (!given) rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
if (failures.length) {
  console.error(`Interoperability failed against ${versions}:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`Interoperable with ${versions}: AG-UI, A2A, and ACP, each driven by its reference client.`);
