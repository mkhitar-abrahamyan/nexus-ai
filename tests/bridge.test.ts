import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { migrateCheckpoint } from '../src/graph/checkpoint-migration.js';
import { modalitiesOf } from '../src/models/registry.js';
import { BaseProvider } from '../src/providers/base.js';
import { Router } from '../src/router/index.js';
import type { GraphCheckpoint } from '../src/types/graph.js';
import type { NexusAIConfig } from '../src/types/config.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse, NexusStream } from '../src/types/response.js';

// ── Modalities with a direction ────────────────────────────────────

test('modalitiesOf reads what a model accepts and produces, from either shape', () => {
  assert.deepEqual(modalitiesOf({ modalities: ['text', 'vision', 'pdf'] }), {
    input: ['text', 'image', 'pdf'],
    output: ['text'],
  });
  assert.deepEqual(modalitiesOf({ modalities: ['text', 'vision', 'image'] }), {
    input: ['text', 'image'],
    output: ['text', 'image'],
  });
  assert.deepEqual(
    modalitiesOf({ modalities: ['text'], inputModalities: ['text', 'audio'], outputModalities: ['audio', 'text'] }),
    { input: ['text', 'audio'], output: ['audio', 'text'] },
    'declared fields win over the old list',
  );
});

class QuietProvider extends BaseProvider {
  constructor(readonly info: { name: string; isLocal: boolean }) {
    super();
  }
  async complete(): Promise<NexusResponse> {
    throw new Error('not called');
  }
  stream(): NexusStream {
    return { async *[Symbol.asyncIterator]() {}, abort() {} };
  }
}

test('routing can require what a model accepts and what it produces, and the old list warns once', async () => {
  const providers = new Map<string, BaseProvider>([['google', new QuietProvider({ name: 'google', isLocal: false })]]);
  const request: CompletionRequest = { model: 'auto', messages: [{ role: 'user', content: 'draw a cat' }] };
  const route = (requiredCapabilities: NonNullable<NexusAIConfig['routing']>['requiredCapabilities']) =>
    new Router().route(
      request,
      {
        providers: { google: { apiKey: 'test' } },
        routing: {
          mode: 'auto',
          strategy: 'quality',
          candidateModels: ['gemini-2.5-flash', 'gemini-3-pro-image-preview'],
          requiredCapabilities,
        },
      } as NexusAIConfig,
      providers,
      [],
      [],
    );
  assert.equal(route({ outputModalities: ['image'] }).model, 'gemini-3-pro-image-preview');
  assert.equal(route({ inputModalities: ['pdf'] }).model, 'gemini-2.5-flash', 'only the general model takes PDFs');

  const warnings: string[] = [];
  const listener = (warning: Error & { code?: string }) => warnings.push(warning.code ?? '');
  process.on('warning', listener);
  try {
    assert.equal(route({ modalities: ['image'] }).model, 'gemini-3-pro-image-preview', 'the old list still works');
    route({ modalities: ['image'] });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', listener);
  }
  assert.deepEqual(warnings, ['NEXUS_DEP_REQUIRED_MODALITIES']);
});

// ── Checkpoints in the 2.0 schema ──────────────────────────────────

const base: GraphCheckpoint = {
  threadId: 'thread-1',
  step: 3,
  state: { count: 1 },
  next: ['review', 'notify'],
  status: 'running',
  createdAt: '2026-10-01T00:00:00.000Z',
};

test('migrateCheckpoint gives a 1.x checkpoint its id, its tasks, and every question in one list', () => {
  const plain = migrateCheckpoint(base);
  assert.equal(plain.version, 2);
  assert.equal(plain.id, 'thread-1:3');
  assert.deepEqual(plain.tasks, [
    { id: 'review', node: 'review' },
    { id: 'notify', node: 'notify' },
  ]);
  assert.deepEqual(plain.interrupts, []);
  assert.equal('interrupt' in plain, false);

  const question = { id: 'q', node: 'review', step: 3, index: 0, requestedAt: base.createdAt, reason: 'ok?' };
  const paused = migrateCheckpoint({ ...base, status: 'awaiting_input', interrupt: question });
  assert.deepEqual(paused.interrupts, [question]);
  const sent = migrateCheckpoint({ ...base, tasks: [{ id: 'review#3.0', node: 'review', input: 1 }] });
  assert.deepEqual(sent.tasks, [{ id: 'review#3.0', node: 'review', input: 1 }], 'explicit tasks are kept');
  assert.equal(migrateCheckpoint(plain), plain, 'a 2.0 checkpoint passes through');
});

// ── Root imports that move are flagged where they are written ──────

test('an editor marks a root import that moves in 2.0 as deprecated, and nothing else', () => {
  const root = path.resolve('src', 'index.ts');
  // The language service names files with forward slashes, on Windows too.
  const consumer = path.resolve('tests', '__bridge-consumer.ts').replace(/\\/g, '/');
  const text = [
    `import { MemoryVectorStore, NexusAI, tool } from '${root.replace(/\\/g, '/').replace(/\.ts$/, '.js')}';`,
    `import { MemoryVectorStore as FromSubpath } from '${path.resolve('src', 'rag', 'ingestion.js').replace(/\\/g, '/')}';`,
    'export const used = [MemoryVectorStore, NexusAI, tool, FromSubpath];',
  ].join('\n');
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  };
  const service = ts.createLanguageService({
    getScriptFileNames: () => [consumer],
    getScriptVersion: () => '1',
    getScriptSnapshot: (file) => {
      const content = file === consumer ? text : ts.sys.readFile(file);
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
    },
    getCurrentDirectory: () => process.cwd(),
    getCompilationSettings: () => options,
    getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
    fileExists: (file) => file === consumer || ts.sys.fileExists(file),
    readFile: (file) => (file === consumer ? text : ts.sys.readFile(file)),
  });
  const flagged = service
    .getSuggestionDiagnostics(consumer)
    .filter((diagnostic) => diagnostic.code === 6385)
    .map((diagnostic) => text.slice(diagnostic.start, (diagnostic.start ?? 0) + (diagnostic.length ?? 0)));
  assert.ok(flagged.length > 0, 'the moved root import is flagged');
  assert.ok(
    flagged.every((name) => name === 'MemoryVectorStore'),
    `only the moved name is flagged: ${flagged}`,
  );
});
