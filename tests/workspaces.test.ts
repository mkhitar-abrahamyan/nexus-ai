/**
 * Workspaces, held to one contract: every workspace the package ships passes the workspace
 * conformance suite: in memory, on disk, in each long-term store (memory, SQLite, Postgres, and
 * Redis), a process sandbox, read-only over another, and a composite of several. Then what only a
 * composite does: its mounts, their shadowing, read-only mounts, and search across mounts.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { processSandbox, SandboxPathError } from '../src/agent/sandbox.js';
import {
  compositeWorkspace,
  fileWorkspace,
  memoryWorkspace,
  readOnlyWorkspace,
  resolveWorkspacePath,
  runWorkspaceConformance,
  storeWorkspace,
  type Workspace,
  WorkspacePathError,
  WorkspaceReadOnlyError,
} from '../src/agent/workspace.js';
import type { PostgresLikeClient } from '../src/postgres/client.js';
import { PostgresStore } from '../src/postgres/store.js';
import { SqliteStore } from '../src/sqlite/store.js';
import { MemoryStore } from '../src/store/memory.js';
import { RedisStore } from '../src/store/redis.js';
import { FakeRedis } from './redis-fake.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'nexus-workspaces-'));
let pg: PGlite;
let redis: FakeRedis;
let sqlite: SqliteStore;
let postgres: PostgresStore;
let fresh = 0;
const next = () => {
  fresh += 1;
  return `w${fresh}`;
};

before(async () => {
  pg = new PGlite();
  await pg.waitReady;
  redis = await FakeRedis.create();
  sqlite = new SqliteStore(new DatabaseSync(':memory:'));
  await sqlite.migrate();
  postgres = new PostgresStore(pg as unknown as PostgresLikeClient, { table: 'workspaces' });
  await postgres.migrate();
});
after(async () => {
  await pg.close();
  redis.close();
  rmSync(scratch, { recursive: true, force: true });
});

const kinds: Array<[string, () => Workspace]> = [
  ['memory', () => memoryWorkspace()],
  ['file', () => fileWorkspace({ root: path.join(scratch, next()) })],
  ['store: memory', () => storeWorkspace(new MemoryStore(), { namespace: ['ws', next()] })],
  ['store: sqlite', () => storeWorkspace(sqlite, { namespace: ['ws', next()] })],
  ['store: postgres', () => storeWorkspace(postgres, { namespace: ['ws', next()] })],
  ['store: redis', () => storeWorkspace(new RedisStore(redis as never, { prefix: next() }), { namespace: ['ws'] })],
  ['process sandbox', () => processSandbox({ root: path.join(scratch, next()) })],
  [
    'composite',
    () =>
      compositeWorkspace({
        '/': memoryWorkspace(),
        notes: storeWorkspace(new MemoryStore(), { namespace: ['ws', next()] }),
      }),
  ],
];

test('proof: every workspace the package ships passes the workspace conformance suite', async () => {
  for (const [name, create] of kinds) {
    const report = await runWorkspaceConformance(create);
    const failed = report.checks.filter((check) => !check.ok);
    assert.deepEqual(failed, [], `${name}: ${failed.map((check) => `${check.name}: ${check.detail}`).join('; ')}`);
    assert.equal(report.checks.length, 7, `${name}: every check ran`);
    assert.equal(report.passed, true, name);
  }
});

test('a read-only workspace reads and searches, and refuses every write', async () => {
  const inner = memoryWorkspace({ files: { 'docs/guide.md': '# Guide\nTODO: write it' } });
  const docs = readOnlyWorkspace(inner);
  assert.equal(await docs.readFile('docs/guide.md'), '# Guide\nTODO: write it');
  assert.deepEqual(
    (await docs.grep?.('TODO'))?.map((match) => match.file),
    ['docs/guide.md'],
  );
  await assert.rejects(docs.writeFile('docs/guide.md', 'changed'), WorkspaceReadOnlyError);
  await assert.rejects(docs.removeFile?.('docs') ?? Promise.reject(), WorkspaceReadOnlyError);
  await assert.rejects(docs.writeBytes?.('x.bin', new Uint8Array(1)) ?? Promise.reject(), WorkspaceReadOnlyError);
  assert.equal(await inner.readFile('docs/guide.md'), '# Guide\nTODO: write it', 'nothing changed underneath');
});

test('a composite routes each path to its deepest mount, and lists and searches across them', async () => {
  const root = memoryWorkspace({
    files: { 'src/app.ts': 'export const app = 1; // TODO', 'notes/old.md': 'shadowed' },
  });
  const notes = storeWorkspace(new MemoryStore(), { namespace: ['notes'] });
  const docs = memoryWorkspace({ files: { 'guide.md': 'TODO: the guide' } });
  const workspace = compositeWorkspace({ '/': root, notes, docs: { workspace: docs, readOnly: true } });

  await workspace.writeFile('notes/today.md', 'TODO: call Ana');
  assert.equal(await notes.readFile('today.md'), 'TODO: call Ana', 'a write goes to its mount, at the mount path');
  assert.equal(await workspace.readFile('docs/guide.md'), 'TODO: the guide');
  await assert.rejects(workspace.writeFile('docs/guide.md', 'x'), WorkspaceReadOnlyError);
  await assert.rejects(workspace.removeFile?.('notes') ?? Promise.reject(), /is a mount of the workspace/);

  assert.deepEqual(await workspace.listFiles?.(), ['docs', 'notes', 'src'], 'mounts appear as directories');
  assert.deepEqual(
    await workspace.glob?.('**/*.md'),
    ['docs/guide.md', 'notes/today.md'],
    "a deeper mount shadows the root's files under it",
  );
  assert.deepEqual(
    (await workspace.grep?.('TODO'))?.map((match) => match.file),
    ['docs/guide.md', 'notes/today.md', 'src/app.ts'],
    'search spans every mount',
  );
  assert.deepEqual(
    (await workspace.grep?.('TODO', { cwd: 'notes' }))?.map((match) => match.file),
    ['notes/today.md'],
    'within one mount, its own search answers',
  );
  assert.deepEqual(await workspace.glob?.('*.md', { cwd: 'docs' }), ['docs/guide.md']);

  const onlyMounts = compositeWorkspace({ memories: memoryWorkspace() });
  await assert.rejects(onlyMounts.writeFile('elsewhere.txt', 'x'), WorkspacePathError);
  await onlyMounts.writeFile('memories/a.txt', 'a');
  assert.deepEqual(await onlyMounts.listFiles?.(), ['memories']);
  assert.throws(() => compositeWorkspace({ a: memoryWorkspace(), '/a/': memoryWorkspace() }), /mounts each path once/);
});

test('paths mean the same in every workspace, and leaving the root is refused', async () => {
  assert.equal(resolveWorkspacePath('/a/./b/../c.txt'), 'a/c.txt');
  assert.equal(resolveWorkspacePath('a\\b.txt'), 'a/b.txt');
  assert.equal(resolveWorkspacePath('/'), '');
  assert.throws(() => resolveWorkspacePath('../x'), WorkspacePathError);
  const sandbox = processSandbox({ root: path.join(scratch, next()) });
  const refused = await sandbox.writeFile('../escape.txt', 'x').catch((error: unknown) => error);
  assert.ok(refused instanceof SandboxPathError, 'a sandbox refuses with its own error');
  assert.ok(refused instanceof WorkspacePathError, 'which is a workspace path error too');
  const disk = fileWorkspace({ root: path.join(scratch, next()) });
  await disk.writeFile('/rooted.txt', 'at the root');
  assert.equal(await disk.readFile('rooted.txt'), 'at the root', 'a leading / names the root, on disk too');
});
