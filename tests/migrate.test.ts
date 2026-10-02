import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { migrateFiles, migrateSource } from '../src/cli/migrate.js';
import { ROOT_MOVES } from '../src/cli/root-moves.js';

const migrate = (text: string, file = 'app.ts') => migrateSource(text, { file });

test('names the 2.0 root drops move to their subpaths, and the core stays', () => {
  const { text, changes } = migrate(
    "import { NexusAI, tool, MemoryVectorStore, OperationRunner } from 'nexus-ai-pro';\nnew NexusAI({});\n",
  );
  assert.equal(
    text,
    [
      "import { NexusAI, tool } from 'nexus-ai-pro';",
      "import { OperationRunner } from 'nexus-ai-pro/operations';",
      "import { MemoryVectorStore } from 'nexus-ai-pro/rag';",
      'new NexusAI({});',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    changes.map((change) => change.message),
    ["MemoryVectorStore: from 'nexus-ai-pro/rag'", "OperationRunner: from 'nexus-ai-pro/operations'"],
  );
});

test('a statement that moves entirely is replaced, and its layout, quotes, and semicolons are kept', () => {
  const source = 'import {\n  withRagContext,\n  type RagOptions,\n} from "nexus-ai-pro"\n';
  assert.equal(
    migrate(source).text,
    'import {\n  withRagContext,\n  type RagOptions,\n} from "nexus-ai-pro/grounding"\n',
  );
});

test('type-only imports, aliases, and names that moved under another name keep their local names', () => {
  const { text } = migrate(
    "import type { AgentModelClient, NexusAIConfig } from 'nexus-ai-pro';\nimport { AgentModelClient as Client } from 'nexus-ai-pro';\nimport { MemoryVectorStore as Store } from 'nexus-ai-pro';\n",
  );
  assert.equal(
    text,
    [
      "import type { NexusAIConfig } from 'nexus-ai-pro';",
      "import type { AgentLoopModelClient as AgentModelClient } from 'nexus-ai-pro/agent';",
      "import { AgentLoopModelClient as Client } from 'nexus-ai-pro/agent';",
      "import { MemoryVectorStore as Store } from 'nexus-ai-pro/rag';",
      '',
    ].join('\n'),
  );
});

test('deprecated aliases are replaced wherever they are imported from', () => {
  assert.equal(
    migrate("import type { ImageManagerConfig } from 'nexus-ai-pro/images';\n").text,
    "import type { ImageConfig as ImageManagerConfig } from 'nexus-ai-pro/images';\n",
  );
});

test('re-exports and CommonJS requires move too', () => {
  const { text } = migrate(
    "export { OperationRunner, NexusAI } from 'nexus-ai-pro';\nconst { runBatch, NexusAI: Client } = require('nexus-ai-pro');\n",
    'app.cjs',
  );
  assert.equal(
    text,
    [
      "export { NexusAI } from 'nexus-ai-pro';",
      "export { OperationRunner } from 'nexus-ai-pro/operations';",
      "const { NexusAI: Client } = require('nexus-ai-pro');",
      "const { runBatch } = require('nexus-ai-pro/jobs/batch');",
      '',
    ].join('\n'),
  );
});

test('what cannot be rewritten safely is reported with its line, and left alone', () => {
  const source = [
    "import * as nexus from 'nexus-ai-pro';",
    "const lazy = await import('nexus-ai-pro');",
    "const whole = require('nexus-ai-pro');",
    "export * from 'nexus-ai-pro';",
    'console.log(response.estimatedCost);',
  ].join('\n');
  const { text, changes, notes } = migrate(source);
  assert.equal(text, source);
  assert.equal(changes.length, 0);
  assert.deepEqual(
    notes.map((note) => note.line),
    [1, 4, 2, 3, 5],
  );
});

test('options and fields 2.0 removed are reported for a person to check', () => {
  const source = [
    "const google = { apiKey: 'k', projectId: 'p' };",
    'const health = { enabled: true, latencyHalfLife: 5 };',
    "const entry = { modalities: ['text', 'vision'], streaming: true };",
    "const tools = { requiresApproval: ['refund'] };",
    'const fine = { inputModalities: ["text"] };',
  ].join('\n');
  const { text, notes } = migrate(source);
  assert.equal(text, source, 'nothing is rewritten');
  assert.deepEqual(notes.map((note) => note.line).sort(), [1, 2, 3, 4]);
  assert.ok(notes.some((note) => /inputModalities/.test(note.message)));
});

test('model names the 2.0 registry dropped are reported with their replacement', () => {
  const source = [
    "const a = await ai.complete({ model: 'claude-3-5-sonnet-20241022', messages });",
    'const b = { defaultModel: "deepseek/deepseek-chat" };',
    "const c = { model: 'claude-sonnet-5-5' };",
    "const d = { model: 'deepseek/deepseek-chat-v2' };",
  ].join('\n');
  const { text, notes } = migrate(source);
  assert.equal(text, source, 'a different model changes behavior, so nothing is rewritten');
  assert.deepEqual(
    notes.map((note) => note.line),
    [1, 2],
  );
  assert.match(notes[0]?.message ?? '', /`claude-sonnet-5-5`/);
  assert.match(notes[1]?.message ?? '', /`deepseek\/deepseek-flash`/);
});

test('Markdown is migrated inside code blocks only, with lines counted from the top of the file', () => {
  const source = [
    '# Guide',
    '',
    "Mention `import { MemoryVectorStore } from 'nexus-ai-pro'` in prose stays as it is.",
    '',
    '```ts',
    "import { MemoryVectorStore } from 'nexus-ai-pro';",
    '```',
    '',
    '```bash',
    'echo "import { MemoryVectorStore } from \'nexus-ai-pro\';"',
    '```',
  ].join('\n');
  const { text, changes } = migrate(source, 'guide.md');
  assert.ok(text.includes("```ts\nimport { MemoryVectorStore } from 'nexus-ai-pro/rag';\n```"));
  assert.ok(text.includes('prose stays as it is'));
  assert.ok(
    text.includes('echo "import { MemoryVectorStore } from \'nexus-ai-pro\';"'),
    'other languages are left alone',
  );
  assert.equal(changes[0]?.line, 6);
});

test('Windows line endings are kept, and a second run changes nothing', () => {
  const source = "import {\r\n  NexusAI,\r\n  OperationRunner,\r\n} from 'nexus-ai-pro';\r\n";
  const once = migrate(source).text;
  assert.equal(
    once,
    "import { NexusAI } from 'nexus-ai-pro';\r\nimport { OperationRunner } from 'nexus-ai-pro/operations';\r\n",
  );
  assert.equal(migrate(once).text, once);
});

test('the map names only published entry points, and the guides already import from them', async () => {
  const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as { exports: Record<string, unknown> };
  const entries = Object.values(ROOT_MOVES);
  assert.ok(entries.length > 400);
  for (const [subpath] of entries) {
    assert.ok(packageJson.exports[subpath.replace('nexus-ai-pro', '.')], `${subpath} is a published entry point`);
  }
  // Every example in the guides uses the imports 2.0 keeps, so none teaches a root import that moves.
  const pending = (await migrateFiles(['docs', 'README.md'])).filter((result) => result.changed);
  assert.deepEqual(
    pending.map((result) => result.file),
    [],
  );
});

test('nexus migrate reports, checks, and writes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-migrate-'));
  try {
    const file = path.join(directory, 'app.ts');
    await writeFile(file, "import { NexusAI, OperationRunner } from 'nexus-ai-pro';\n");
    const run = (...args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), 'migrate', ...args], {
        encoding: 'utf8',
      });

    const report = run(directory);
    assert.equal(report.status, 0);
    assert.match(report.stdout, /would migrate/);
    assert.equal(run(directory, '--check').status, 1, 'a check fails while anything is left');
    assert.equal(
      (await readFile(file, 'utf8')).includes("from 'nexus-ai-pro/operations'"),
      false,
      'a report writes nothing',
    );

    const written = run(directory, '--write');
    assert.match(written.stdout, /Migrated 1 file/);
    assert.ok((await readFile(file, 'utf8')).includes("import { OperationRunner } from 'nexus-ai-pro/operations';"));
    assert.equal(run(directory, '--check').status, 0);
    assert.equal(run(directory, '--write', '--check').status, 2, 'conflicting flags are a usage error');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
