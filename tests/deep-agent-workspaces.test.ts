/**
 * One deep agent, run over every workspace: in memory, on disk, in each long-term store, a process
 * sandbox, and a composite of a sandbox, a store, and read-only docs. The same agent definition and
 * the same scripted model do the same work in each: read the AGENTS.md it is given, find files by
 * glob and a TODO by grep, edit the code, load a skill from a file, look at an image, have a large
 * result offloaded, and write its notes. Every workspace ends holding the same files.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { agentInput } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { processSandbox } from '../src/agent/sandbox.js';
import {
  compositeWorkspace,
  fileWorkspace,
  memoryWorkspace,
  storeWorkspace,
  type Workspace,
} from '../src/agent/workspace.js';
import { createDeepAgent } from '../src/deep-agent/index.js';
import type { PostgresLikeClient } from '../src/postgres/client.js';
import { PostgresStore } from '../src/postgres/store.js';
import { SqliteStore } from '../src/sqlite/store.js';
import { MemoryStore } from '../src/store/memory.js';
import { RedisStore } from '../src/store/redis.js';
import type { CompletionRequest, Message } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';
import { FakeRedis } from './redis-fake.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'nexus-deep-workspaces-'));
let pg: PGlite;
let redis: FakeRedis;
before(async () => {
  pg = new PGlite();
  await pg.waitReady;
  redis = await FakeRedis.create();
});
after(async () => {
  await pg.close();
  redis.close();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// A 1x1 PNG.
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),
  (char) => char.charCodeAt(0),
);
const SEED: Record<string, string | Uint8Array> = {
  'AGENTS.md': 'House rule: write your notes to notes/summary.md.',
  'src/app.ts': 'export const status = "TODO";\n',
  'src/util.ts': 'export const id = (x: unknown) => x;\n',
  'docs/guide.md': '# Guide\nThe app reports its status.\n',
  'skills/style.md': 'Write notes as one line per finding.',
  'assets/logo.png': PNG,
};

let ids = 0;
const call = (name: string, args: unknown) => ({
  id: `call-${++ids}`,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (partial: Partial<NexusResponse>): NexusResponse =>
  ({ content: '', role: 'assistant', finishReason: 'stop', meta: {} as never, ...partial }) as NexusResponse;
const textOf = (message: Message | undefined) =>
  typeof message?.content === 'string'
    ? message.content
    : Array.isArray(message?.content)
      ? message.content.map((part) => ('text' in part ? part.text : `[${part.type}]`)).join(' ')
      : '';

/** The work, step by step: each step reacts to what the last one returned. */
function scriptedModel() {
  const seen = { included: false, glob: '', grep: '', skill: '', image: false, offloaded: '' };
  const model = {
    complete: async (request: CompletionRequest): Promise<NexusResponse> => {
      const results = request.messages.filter((message) => message.role === 'tool');
      // A tool's text result reaches the model as JSON.
      const raw = textOf(results.at(-1));
      const last = (() => {
        try {
          const value = JSON.parse(raw);
          return typeof value === 'string' ? value : raw;
        } catch {
          return raw;
        }
      })();
      seen.included ||= request.messages.some((message) => textOf(message).includes('House rule: write your notes'));
      switch (results.length) {
        case 0:
          return reply({ toolCalls: [call('glob_files', { pattern: '**/*.ts' })] });
        case 1:
          seen.glob = last;
          return reply({ toolCalls: [call('grep_files', { pattern: 'TODO', glob: '**/*.ts' })] });
        case 2:
          seen.grep = last;
          return reply({
            toolCalls: [call('edit_file', { path: '/workspace/src/app.ts', old_text: '"TODO"', new_text: '"DONE"' })],
          });
        case 3:
          return reply({ toolCalls: [call('load_skill', { name: 'style' })] });
        case 4:
          seen.skill = last;
          return reply({ toolCalls: [call('read_media', { path: 'assets/logo.png' })] });
        case 5:
          seen.image = (results.at(-1)?.content as unknown[] | undefined)?.some?.(
            (part) => (part as { type?: string }).type === 'image',
          ) as boolean;
          return reply({ toolCalls: [call('audit_log', {})] });
        case 6:
          seen.offloaded = /\.context\/[\w.-]+?\.txt/.exec(last)?.[0] ?? '';
          return reply({
            toolCalls: [
              call('write_file', {
                path: 'notes/summary.md',
                content: `${seen.grep.split('\n')[0]}\nfixed: src/app.ts\nstyle: ${seen.skill}`,
              }),
            ],
          });
        default:
          return reply({ content: 'Done: the status is fixed and the notes are written.' });
      }
    },
  };
  return { model, seen };
}

/** A tool whose result is far too large for the transcript, so the agent offloads it. */
const auditLog = tool({
  name: 'audit_log',
  description: 'Returns the full audit log',
  parameters: { type: 'object' },
  capabilities: [],
  execute: () => `audit\n${'entry\n'.repeat(5_000)}`,
});

async function seed(workspace: Workspace, files = SEED) {
  for (const [file, content] of Object.entries(files)) {
    if (typeof content === 'string') await workspace.writeFile(file, content);
    else await workspace.writeBytes?.(file, content);
  }
}

let fresh = 0;
const next = () => {
  fresh += 1;
  return `run${fresh}`;
};

async function workspaces(): Promise<Array<[string, Workspace, () => Promise<void>]>> {
  const sqlite = new SqliteStore(new DatabaseSync(':memory:'));
  await sqlite.migrate();
  const postgres = new PostgresStore(pg as unknown as PostgresLikeClient, { table: `deep_ws_${next()}` });
  await postgres.migrate();
  const notes = storeWorkspace(new MemoryStore(), { namespace: ['agents', 'notes'] });
  const docs = memoryWorkspace({ files: { 'guide.md': SEED['docs/guide.md'] as string } });
  const sandbox = processSandbox({ root: path.join(scratch, next()) });
  const composite = compositeWorkspace({ '/': sandbox, notes, docs: { workspace: docs, readOnly: true } });
  const { 'docs/guide.md': _guide, ...rest } = SEED;
  return [
    ['memory', memoryWorkspace(), () => Promise.resolve()],
    ['file', fileWorkspace({ root: path.join(scratch, next()) }), () => Promise.resolve()],
    ['store: memory', storeWorkspace(new MemoryStore()), () => Promise.resolve()],
    ['store: sqlite', storeWorkspace(sqlite), () => Promise.resolve()],
    ['store: postgres', storeWorkspace(postgres), () => Promise.resolve()],
    ['store: redis', storeWorkspace(new RedisStore(redis as never, { prefix: next() })), () => Promise.resolve()],
    ['process sandbox', processSandbox({ root: path.join(scratch, next()) }), () => Promise.resolve()],
    // The composite's docs are read-only, so they are seeded underneath it.
    ['composite', composite, async () => seed(composite, rest)],
  ];
}

test('proof: one deep agent does the same work over every workspace, which ends holding the same files', async () => {
  const endings: Array<[string, Record<string, string>]> = [];
  for (const [name, workspace, seedComposite] of await workspaces()) {
    if (name === 'composite') await seedComposite();
    else await seed(workspace);
    const { model, seen } = scriptedModel();
    const agent = createDeepAgent({
      client: model,
      planning: false,
      workspace,
      tools: [auditLog],
      skills: [{ name: 'style', description: 'How notes are written', file: 'skills/style.md' }],
      permissions: false,
    });
    const run = await agent.invoke(agentInput('Fix the status and write notes'), { threadId: `ws-${name}` });
    assert.equal(run.state.answer, 'Done: the status is fixed and the notes are written.', name);

    assert.ok(seen.included, `${name}: the model was given AGENTS.md`);
    assert.equal(seen.glob, 'src/app.ts\nsrc/util.ts', `${name}: glob`);
    assert.equal(seen.grep, 'src/app.ts:1: export const status = "TODO";', `${name}: grep`);
    assert.equal(seen.skill, 'Write notes as one line per finding.', `${name}: the skill's file`);
    assert.ok(seen.image, `${name}: the model saw the image`);
    assert.match(seen.offloaded, /^\.context\//, `${name}: the large result was offloaded`);
    const offloaded = await workspace.readFile(seen.offloaded);
    assert.ok(offloaded.length > 20_000, `${name}: and kept whole in the workspace`);

    endings.push([
      name,
      {
        'src/app.ts': await workspace.readFile('src/app.ts'),
        'notes/summary.md': await workspace.readFile('notes/summary.md'),
        'docs/guide.md': await workspace.readFile('docs/guide.md'),
      },
    ]);
  }
  const [first] = endings;
  assert.deepEqual(first?.[1], {
    'src/app.ts': 'export const status = "DONE";\n',
    'notes/summary.md':
      'src/app.ts:1: export const status = "TODO";\nfixed: src/app.ts\nstyle: Write notes as one line per finding.',
    'docs/guide.md': '# Guide\nThe app reports its status.\n',
  });
  for (const [name, files] of endings) assert.deepEqual(files, first?.[1], `${name} ends as the others do`);
});

test("a deep agent's files and commands live apart: its notes in a store, its code in a sandbox", async () => {
  const store = new MemoryStore();
  const sandbox = processSandbox({ root: path.join(scratch, next()) });
  await sandbox.writeFile(
    'test.js',
    "console.log(require('fs').readFileSync('src/app.ts', 'utf8').includes('DONE') ? 'PASS' : 'FAIL')",
  );
  await sandbox.writeFile('src/app.ts', 'export const status = "TODO";\n');
  const workspace = compositeWorkspace({
    '/': sandbox,
    memories: storeWorkspace(store, { namespace: ['agents', 'ana'] }),
    docs: { workspace: memoryWorkspace({ files: { 'policy.md': 'Never deploy on Friday.' } }), readOnly: true },
  });
  const outputs: string[] = [];
  const model = {
    complete: async (request: CompletionRequest): Promise<NexusResponse> => {
      const results = request.messages.filter((message) => message.role === 'tool');
      outputs.push(textOf(results.at(-1)));
      switch (results.length) {
        case 0:
          return reply({ toolCalls: [call('edit_file', { path: 'src/app.ts', old_text: 'TODO', new_text: 'DONE' })] });
        case 1:
          return reply({ toolCalls: [call('run_command', { command: 'node test.js' })] });
        case 2:
          return reply({
            toolCalls: [call('write_file', { path: 'memories/today.md', content: 'Fixed the status.' })],
          });
        case 3:
          return reply({ toolCalls: [call('write_file', { path: 'docs/policy.md', content: 'Deploy any day.' })] });
        default:
          return reply({ content: 'done' });
      }
    },
  };
  const agent = createDeepAgent({
    client: model,
    planning: false,
    workspace,
    sandbox,
    commands: ['node'],
    permissions: false,
  });
  await agent.invoke(agentInput('Fix it, test it, remember it'), { threadId: 'apart' });
  assert.match(outputs[2] ?? '', /PASS/, "the command saw the agent's edit: the sandbox is the workspace's root");
  assert.equal(
    (await store.get<{ text: string }>(['agents', 'ana', 'blobs'], 'today.md'))?.value.text,
    'Fixed the status.',
  );
  assert.match(outputs[4] ?? '', /read-only/, 'the read-only docs refused the write, and the model was told');
  assert.equal(await workspace.readFile('docs/policy.md'), 'Never deploy on Friday.');
});
