/**
 * ACP, durable and complete: a session paused on a question survives the agent's restart, and the
 * editor reopens it with `session/load`, sees the conversation replayed, and answers. A prompt carries
 * images and audio to the model. Through the editor bridge, the agent reads and writes files and runs
 * commands in the editor, only where the editor said it can and the person allowed it, and uses the
 * MCP servers the editor offered, started as real processes.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createAgent } from '../src/agent/create-agent.js';
import { appendList, lastValue } from '../src/graph/channels.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import { createGraph } from '../src/graph/graph.js';
import { MCP_PROTOCOL_VERSION } from '../src/mcp/protocol.js';
import { type AcpSessionStore, MemoryAcpSessionStore, storeAcpSessions } from '../src/protocols/acp.js';
import { acpEditor } from '../src/protocols/acp-editor.js';
import { SqliteStore } from '../src/sqlite/store.js';
import { END } from '../src/types/graph.js';
import type { CompletionRequest, Message } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import { acpEditor as editorDriving } from './acp-editor.js';

/** A graph that asks which branch to deploy, then deploys it. */
function deployer(checkpointer: MemoryGraphCheckpointer) {
  return createGraph({ channels: { messages: appendList<Message>(), answer: lastValue<string>('') } })
    .addNode('deploy', async (context) => {
      const branch = context.interrupt<string>({ reason: 'Which branch should I deploy?' });
      return { answer: `Deploying ${branch}`, messages: [{ role: 'assistant', content: `Deploying ${branch}` }] };
    })
    .setEntry('deploy')
    .addEdge('deploy', END)
    .compile({ checkpointer });
}

async function sessionStores(): Promise<Array<[string, AcpSessionStore]>> {
  const sqlite = new SqliteStore(new DatabaseSync(':memory:'));
  await sqlite.migrate();
  return [
    ['memory', new MemoryAcpSessionStore()],
    ['sqlite', storeAcpSessions(sqlite)],
  ];
}

test('a session paused on a question survives a restart, and the editor reopens and answers it', async () => {
  for (const [name, sessions] of await sessionStores()) {
    const checkpointer = new MemoryGraphCheckpointer();
    const first = editorDriving(deployer(checkpointer), undefined, { sessions });
    await first.request('initialize', { protocolVersion: 1 });
    const { result } = await first.request('session/new', { cwd: '/repo', mcpServers: [] });
    const sessionId = result.sessionId as string;
    const asked = await first.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Deploy the app' }],
    });
    assert.equal(asked.result.stopReason, 'end_turn', name);
    assert.match(JSON.stringify(first.updates.at(-1)), /Which branch should I deploy\?/, name);
    first.server.close();
    first.close();

    // The agent restarts. The editor reopens the session; the agent replays it and remembers the question.
    const second = editorDriving(deployer(checkpointer), undefined, { sessions });
    const init = await second.request('initialize', { protocolVersion: 1 });
    assert.equal(init.result.agentCapabilities.loadSession, true, name);
    const loaded = await second.request('session/load', { sessionId, cwd: '/repo', mcpServers: [] });
    assert.equal(loaded.result, null, name);
    assert.deepEqual(
      second.updates.map((update) => [update.sessionUpdate, (update.content as { text?: string })?.text]),
      [
        ['user_message_chunk', 'Deploy the app'],
        ['agent_message_chunk', 'Which branch should I deploy?'],
      ],
      `${name}: the conversation is replayed, and the question asked again`,
    );
    const answered = await second.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'main' }] });
    assert.equal(answered.result.stopReason, 'end_turn', name);
    assert.equal((second.updates.at(-1)?.content as { text?: string } | undefined)?.text, 'Deploying main', name);
    const unknown = await second.request('session/load', { sessionId: 'session-nope' });
    assert.equal(unknown.error.code, -32602, name);
    second.close();
  }
});

/** A model that records what it is sent, and answers in words. */
function listening() {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    client: {
      async complete(request: CompletionRequest) {
        requests.push(request);
        return {
          content: 'I see a cat and hear a bell.',
          role: 'assistant',
          finishReason: 'stop',
          meta: {},
        } as NexusResponse;
      },
    },
  };
}

test('a prompt carries images and audio to the model, and the stored session notes the audio', async () => {
  const { client, requests } = listening();
  const sessions = new MemoryAcpSessionStore();
  const editor = editorDriving(createAgent({ client, model: 'mock' }), undefined, { sessions });
  const init = await editor.request('initialize', { protocolVersion: 1 });
  assert.deepEqual(init.result.agentCapabilities.promptCapabilities, {
    image: true,
    audio: true,
    embeddedContext: true,
  });
  const { result } = await editor.request('session/new', { cwd: '/repo', mcpServers: [] });
  const audio = Buffer.from('RIFF....WAVEfmt ').toString('base64');
  await editor.request('session/prompt', {
    sessionId: result.sessionId,
    prompt: [
      { type: 'text', text: 'What is in these?' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
      { type: 'audio', mimeType: 'audio/wav', data: audio },
    ],
  });
  type Part = { type: string; text?: string; source: { format?: string; buffer: Uint8Array } };
  const sent = requests[0]?.messages.at(-1)?.content as unknown as Part[];
  assert.equal(sent[0]?.text, 'What is in these?');
  assert.deepEqual(sent[1], { type: 'image', source: { base64: 'iVBORw0KGgo=', mimeType: 'image/png' } });
  assert.equal(sent[2]?.type, 'audio');
  assert.equal(sent[2]?.source.format, 'wav');
  assert.equal(Buffer.from(sent[2]?.source.buffer as Uint8Array).toString(), 'RIFF....WAVEfmt ');
  const stored = (await sessions.get(result.sessionId))?.history[0]?.content as unknown as Part[];
  assert.deepEqual(stored[2], { type: 'text', text: '[audio the user sent]' }, 'audio is not kept as bytes');
  assert.equal(stored[1]?.type, 'image', 'images are kept');
  editor.close();
});

/** A model that reads a file, writes one, and runs a command, then reports what it learned. */
function working() {
  const steps = [
    { name: 'editor_read_file', args: { path: 'src/app.ts' } },
    { name: 'editor_write_file', args: { path: 'src/app.ts', content: 'fixed' } },
    { name: 'editor_run_command', args: { command: 'npm', args: ['test'] } },
    { name: 'docs_search', args: { query: 'deploy' } },
  ];
  const requests: CompletionRequest[] = [];
  return {
    requests,
    client: {
      async complete(request: CompletionRequest) {
        requests.push(request);
        const step = steps[requests.length - 1];
        if (step) {
          return {
            content: '',
            role: 'assistant',
            finishReason: 'tool_calls',
            toolCalls: [
              {
                id: `c${requests.length}`,
                type: 'function',
                function: { name: step.name, arguments: JSON.stringify(step.args) },
              },
            ],
            meta: {},
          } as unknown as NexusResponse;
        }
        const results = request.messages.filter((message) => message.role === 'tool').map((message) => message.content);
        return { content: results.join(' | '), role: 'assistant', finishReason: 'stop', meta: {} } as NexusResponse;
      },
    },
  };
}

/** A small MCP server, as a child process, that searches docs. */
const DOCS_SERVER = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result = {};
  if (m.method === 'initialize') result = { protocolVersion: '${MCP_PROTOCOL_VERSION}', capabilities: { tools: {} }, serverInfo: { name: 'docs', version: '1.0.0' } };
  else if (m.method === 'tools/list') result = { tools: [{ name: 'search', description: 'Searches the docs', inputSchema: { type: 'object' } }] };
  else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'docs: ' + m.params.arguments.query + ' in ' + process.cwd().length }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
});`;

test('through the editor bridge, the agent uses the editor’s files, terminal, and MCP servers', async (t) => {
  const bridge = acpEditor();
  const { client, requests } = working();
  const agent = createAgent({
    client,
    model: 'mock',
    toolSource: bridge.toolSource,
    interruptOn: { editor_write_file: true },
  });
  // A real directory, as an editor gives: the MCP server is started in it.
  const cwd = mkdtempSync(path.join(tmpdir(), 'nexus-acp-'));
  const appFile = path.join(cwd, 'src', 'app.ts');
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const files = new Map([[appFile, 'broken']]);
  const editor = editorDriving(
    agent,
    (method, params) => {
      switch (method) {
        case 'session/request_permission':
          return { outcome: { outcome: 'selected', optionId: 'allow_once' } };
        case 'fs/read_text_file':
          return { content: files.get(params.path) ?? '' };
        case 'fs/write_text_file':
          files.set(params.path, params.content);
          return null;
        case 'terminal/create':
          return { terminalId: 'term-1' };
        case 'terminal/wait_for_exit':
          return { exitCode: 0, signal: null };
        case 'terminal/output':
          return { output: '12 passing', truncated: false };
        default:
          return null;
      }
    },
    { editor: bridge },
  );
  t.after(async () => {
    editor.close();
    await bridge.close();
  });
  await editor.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
  });
  const { result } = await editor.request('session/new', {
    cwd,
    mcpServers: [{ name: 'docs', command: process.execPath, args: ['-e', DOCS_SERVER], env: [] }],
  });
  const done = await editor.request('session/prompt', {
    sessionId: result.sessionId,
    prompt: [{ type: 'text', text: 'Fix and test it' }],
  });
  assert.equal(done.result.stopReason, 'end_turn');
  assert.deepEqual(
    requests[0]?.tools?.map((item) => item.name),
    ['editor_read_file', 'editor_write_file', 'editor_run_command', 'docs_search'],
  );
  assert.equal(files.get(appFile), 'fixed', 'written through the editor, at an absolute path');
  const methods = editor.asked.map((item) => item.method);
  assert.deepEqual(methods, [
    'fs/read_text_file',
    'session/request_permission',
    'fs/write_text_file',
    'terminal/create',
    'terminal/wait_for_exit',
    'terminal/output',
    'terminal/release',
  ]);
  assert.ok(
    editor.asked.every((item) => item.method.startsWith('session/') || item.params.sessionId === result.sessionId),
  );
  assert.deepEqual(editor.asked[3]?.params, {
    sessionId: result.sessionId,
    command: 'npm',
    args: ['test'],
    cwd,
    outputByteLimit: 65_536,
  });
  const answer = String((editor.updates.at(-1)?.content as { text?: string } | undefined)?.text);
  assert.match(answer, /"broken"/, 'it read the file');
  assert.match(answer, /12 passing/, 'it ran the tests');
  assert.match(answer, /docs: deploy/, 'it searched the docs through the editor’s MCP server');
  await bridge.close();
  editor.close();

  // An editor that offers nothing gets an agent with no editor tools.
  const quiet = acpEditor();
  let detached = false;
  const stop = quiet.detach?.bind(quiet);
  quiet.detach = async () => {
    detached = true;
    await stop?.();
  };
  const { client: second, requests: seen } = working();
  const plain = editorDriving(
    createAgent({ client: second, model: 'mock', toolSource: quiet.toolSource, maxIterations: 1 }),
    undefined,
    {
      editor: quiet,
    },
  );
  await plain.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
  const opened = await plain.request('session/new', { cwd: '/repo', mcpServers: [] });
  await plain.request('session/prompt', { sessionId: opened.result.sessionId, prompt: [{ type: 'text', text: 'hi' }] });
  assert.equal(seen[0]?.tools, undefined, 'no tool is offered for what the editor cannot do');
  plain.close();
  await plain.server.closed;
  assert.equal(detached, true, 'when the editor closes its end, the bridge stops what it started');
});
