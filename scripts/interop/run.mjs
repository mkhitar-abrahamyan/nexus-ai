#!/usr/bin/env node
/**
 * Each agent protocol against the reference client of its own project: `@ag-ui/client` drives the
 * AG-UI handler, `@a2a-js/sdk` the A2A agent, and `@agentclientprotocol/sdk` an ACP agent it starts
 * as an editor would. Run nightly, against the clients' latest releases, so a change on their side
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
const CLIENTS = ['@ag-ui/client', '@a2a-js/sdk', '@agentclientprotocol/sdk'];

let directory = given;
if (!directory) {
  directory = mkdtempSync(path.join(tmpdir(), 'nexus-interop-'));
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'interop-clients', private: true }));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const installed = spawnSync(
    npm,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...CLIENTS.map((name) => `${name}@latest`)],
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
const { a2aHandler } = await import('../../dist/protocols/a2a.js');

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
  const { ClientFactory } = await load('@a2a-js/sdk/client');
  const { ListTasksRequest, Message, Task } = await load('@a2a-js/sdk');
  let server;
  server = await serve((request) => handler(request));
  const handler = a2aHandler(mailer(), {
    card: { name: 'Interop mailer', description: 'Sends mail', version: '1.0.0', url: `${server.url}/a2a`, skills: [] },
  });
  try {
    const client = await new ClientFactory().createFromUrl(server.url);
    const message = (text, taskId) =>
      Message.fromJSON({
        messageId: `m-${Math.random()}`,
        role: 'ROLE_USER',
        parts: [{ text }],
        ...(taskId ? { taskId } : {}),
      });
    const asJson = (result) => Task.toJSON(result.task ?? result.payload?.value ?? result);
    const paused = asJson(await client.sendMessage({ message: message('Email Ana') }));
    check(
      'A2A: a task pauses for approval',
      paused.status?.state === 'TASK_STATE_INPUT_REQUIRED',
      JSON.stringify(paused.status),
    );
    const done = asJson(await client.sendMessage({ message: message('yes', paused.id) }));
    check('A2A: the answer completes it', done.status?.state === 'TASK_STATE_COMPLETED', JSON.stringify(done.status));
    const read = Task.toJSON(await client.getTask({ id: paused.id }));
    check('A2A: the task reads back', read.id === paused.id);
    const listed = await client.listTasks(ListTasksRequest.fromJSON({}));
    check('A2A: tasks are listed', (listed.tasks ?? []).length >= 1);
    const events = [];
    for await (const event of client.sendMessageStream({ message: message('Email Rui') })) events.push(event);
    check('A2A: a task streams', events.length >= 2, String(events.length));
  } catch (error) {
    failures.push(`A2A: ${error?.stack ?? error}`);
  } finally {
    await server.close();
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
    // The editor, as the SDK builds one: from 2.0, an app with a handler per method and the calls made
    // inside `connectWith()`; before it, a `ClientSideConnection` over the editor object.
    const asEditor = async (calls) => {
      if (typeof acp.client === 'function') {
        const app = acp
          .client()
          .onRequest('session/request_permission', ({ params }) => editor.requestPermission(params))
          .onNotification('session/update', ({ params }) => editor.sessionUpdate(params))
          .onRequest('fs/read_text_file', ({ params }) => editor.readTextFile(params))
          .onRequest('fs/write_text_file', ({ params }) => editor.writeTextFile(params));
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
    };
    await asEditor(async (request) => {
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

const versions = CLIENTS.map((name) => `${name}@${versionOf(name)}`).join(', ');
if (!given) rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
if (failures.length) {
  console.error(`Interoperability failed against ${versions}:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log(`Interoperable with ${versions}: AG-UI, A2A, and ACP, each driven by its reference client.`);
