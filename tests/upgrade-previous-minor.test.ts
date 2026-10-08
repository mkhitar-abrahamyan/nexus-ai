/**
 * The upgrade from the previous minor, for every surface that leaves experimental status in 2.4: what
 * the published 2.3.0 package wrote, this release reads, and what 2.3.0 derived — ids, versions,
 * rankings, traffic buckets — this release derives the same. 2.3.0 is the real package from npm,
 * installed as a development alias, so nothing here imitates what it does.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import * as v23context from 'nexus-ai-pro-2-3/context-hub';
import * as v23insights from 'nexus-ai-pro-2-3/insights';
import * as v23loaders from 'nexus-ai-pro-2-3/loaders/csv';
import * as v23html from 'nexus-ai-pro-2-3/loaders/html';
import * as v23json from 'nexus-ai-pro-2-3/loaders/json';
import * as v23markdown from 'nexus-ai-pro-2-3/loaders/markdown';
import * as v23registry from 'nexus-ai-pro-2-3/mcp/registry';
import * as v23operations from 'nexus-ai-pro-2-3/operations';
import * as v23pgvectors from 'nexus-ai-pro-2-3/postgres/vectors';
import * as v23prompts from 'nexus-ai-pro-2-3/prompts/registry';
import * as v23retrievers from 'nexus-ai-pro-2-3/rag/retrievers';
import * as v23deployments from 'nexus-ai-pro-2-3/server/deployments';
import * as v23sqlite from 'nexus-ai-pro-2-3/sqlite';
import { ContextHub, contextVersion } from '../src/context-hub/index.js';
import { createHashEmbeddings } from '../src/hallucination/retrieval.js';
import { errorSignature, FileProposalStore } from '../src/insights/index.js';
import { collectDocuments } from '../src/loaders/index.js';
import { loadCsv } from '../src/loaders/csv.js';
import { loadHtml } from '../src/loaders/html.js';
import { loadJson } from '../src/loaders/json.js';
import { loadMarkdown } from '../src/loaders/markdown.js';
import { validateMcpConfig } from '../src/mcp/registry.js';
import { OperationRunner } from '../src/operations/runner.js';
import { PostgresVectorStore } from '../src/postgres/vectors.js';
import { PromptRegistry } from '../src/prompts/registry.js';
import { KeywordIndex, reciprocalRankFusion } from '../src/rag/retrievers.js';
import { bucket, Deployments } from '../src/server/deployments.js';
import { MemoryServerStore } from '../src/server/state.js';
import {
  applySqliteMigrations,
  SqliteOperationStore,
  SqliteStore,
  SqliteVectorStore,
  sqliteMigrations,
  sqliteMigrationStatus,
} from '../src/sqlite/index.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'nexus-upgrade-2-3-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const DIMENSIONS = 16;
const embed = (texts: string[]) => createHashEmbeddings(texts, DIMENSIONS);
const passages = [
  { id: 'refunds', content: 'Refunds reach the card in five days', metadata: { tenant: 'acme', kind: 'policy' } },
  { id: 'declined', content: 'A declined card returns error E4012', metadata: { tenant: 'acme', kind: 'error' } },
  { id: 'shipping', content: 'Shipping takes two days in the city', metadata: { tenant: 'globex', kind: 'policy' } },
];

test('SQLite: a 2.3 file upgrades in place, keeps what 2.3 wrote, and a 2.3 worker shares its queue', async () => {
  const file = path.join(scratch, 'previous.db');
  const open = () => {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  };
  const old = open();
  const oldQueue = new v23sqlite.SqliteOperationStore<string>(old as never);
  await oldQueue.migrate();
  const oldMemory = new v23sqlite.SqliteStore(old as never);
  await oldMemory.migrate();
  await oldMemory.put(['users', 'ada'], 'preferences', { tone: 'brief' });
  const oldVectors = new v23sqlite.SqliteVectorStore(old as never, { dimensions: DIMENSIONS, embed });
  await oldVectors.migrate();
  await oldVectors.add(passages);
  const oldRunner = new v23operations.OperationRunner<string>({ store: oldQueue });
  const seeded: string[] = [];
  for (let index = 0; index < 8; index += 1) seeded.push((await oldRunner.enqueue({ kind: 'job' })).id);

  const current = open();
  const migrations = sqliteMigrations();
  await applySqliteMigrations(current, migrations);
  assert.equal((await sqliteMigrationStatus(current, migrations)).current, true);

  // What 2.3 wrote reads the same.
  assert.deepEqual((await new SqliteStore(current).get(['users', 'ada'], 'preferences'))?.value, { tone: 'brief' });
  const vectors = new SqliteVectorStore(current, { dimensions: DIMENSIONS, embed });
  const found = await vectors.search('declined card error', { topK: 1, filter: { tenant: 'acme' } });
  assert.equal(found[0]?.id, 'declined');
  assert.deepEqual(found[0]?.metadata, { tenant: 'acme', kind: 'error' });

  // The rollout: a 2.3 worker and a current one drain one queue, each operation exactly once.
  const queue = new SqliteOperationStore<string>(current);
  const workers = [
    { name: '2.3', runner: oldRunner as unknown as OperationRunner<string> },
    { name: '2.4', runner: new OperationRunner<string>({ store: queue }) },
  ];
  for (const worker of workers) seeded.push((await worker.runner.enqueue({ kind: 'job' })).id);
  const ran: Array<{ id: string; by: string }> = [];
  for (let turn = 0; ; turn += 1) {
    const order = turn % 2 === 0 ? workers : [...workers].reverse();
    const claims = await Promise.all(
      order.map((worker) =>
        worker.runner.claimQueued(async ({ operationId }) => {
          ran.push({ id: operationId, by: worker.name });
          return 'done';
        }, 2),
      ),
    );
    if (claims.flat().length === 0) break;
    await Promise.all(claims.flat().map((handle) => handle.result()));
  }
  assert.equal(ran.length, seeded.length);
  assert.equal(new Set(ran.map((entry) => entry.id)).size, seeded.length, 'no operation ran twice');
  assert.ok(ran.some((entry) => entry.by === '2.3') && ran.some((entry) => entry.by === '2.4'));
  for (const id of seeded) assert.equal((await queue.read(id))?.status, 'succeeded');
  old.close();
  current.close();
});

test('pgvector: a 2.3 table is read, searched, and filtered by this release', async () => {
  const db = new PGlite({ extensions: { vector } });
  await db.waitReady;
  try {
    const old = new v23pgvectors.PostgresVectorStore(db as never, { dimensions: DIMENSIONS, embed, table: 'kb' });
    await old.migrate();
    await old.add(passages);
    const current = new PostgresVectorStore(db as never, { dimensions: DIMENSIONS, embed, table: 'kb' });
    await current.migrate();
    const found = await current.search('refunds card days', { topK: 1, filter: { kind: 'policy', tenant: 'acme' } });
    assert.equal(found[0]?.id, 'refunds');
    assert.equal(found[0]?.content, 'Refunds reach the card in five days');
  } finally {
    await db.close();
  }
});

test('loaders: the same files give the same document ids and content in both releases', async () => {
  const inputs = {
    markdown: {
      source: 'docs/refunds.md',
      content: '---\nteam: billing\n---\n# Refunds\n\nFive **days**.\n\n## Cards\n\nE4012.',
    },
    csv: {
      source: 'faq.csv',
      content: 'id,question,answer\nq1,Refunds?,Five days\nq2,Shipping?,"Two days, in the city"',
    },
    json: {
      source: 'orders.json',
      content: JSON.stringify([
        { id: 'o1', total: 10 },
        { id: 'o2', total: 20 },
      ]),
    },
    html: {
      source: 'https://kb.example/page',
      content: '<html><title>KB</title><body><h1>Help</h1><p>Refunds take five days.</p></body></html>',
    },
  };
  const now = await collectDocuments(
    loadMarkdown(inputs.markdown),
    loadCsv(inputs.csv, { idColumn: 'id' }),
    loadJson(inputs.json),
    loadHtml(inputs.html),
  );
  const before = await collectDocuments(
    v23markdown.loadMarkdown(inputs.markdown) as never,
    v23loaders.loadCsv(inputs.csv, { idColumn: 'id' }) as never,
    v23json.loadJson(inputs.json) as never,
    v23html.loadHtml(inputs.html) as never,
  );
  assert.ok(now.length >= 6);
  assert.deepEqual(
    now.map((document) => [document.id, document.text, document.source]),
    before.map((document) => [document.id, document.text, document.source]),
  );
});

test('retrievers: the same corpus ranks the same way in both releases', async () => {
  const corpus = Array.from({ length: 60 }, (_, index) => ({
    id: `d${index}`,
    content: `${['refund', 'card', 'shipping', 'invoice', 'password'][index % 5]} policy number ${index} ${index % 7 === 0 ? 'declined' : ''}`,
    metadata: { tenant: index % 2 ? 'acme' : 'globex' },
  }));
  const now = new KeywordIndex();
  now.add(corpus);
  const before = new v23retrievers.KeywordIndex();
  before.add(corpus);
  for (const query of ['refund policy', 'declined card', 'shipping 12', 'password']) {
    const ids = async (index: {
      retrieve(query: string, options: object): Promise<Array<{ id: string; score: number }>>;
    }) =>
      (await index.retrieve(query, { topK: 8, filter: { tenant: 'acme' } })).map((hit) => [
        hit.id,
        Number(hit.score.toFixed(10)),
      ]);
    assert.deepEqual(await ids(now), await ids(before as never), query);
  }
  const lists = [
    [
      { id: 'a', score: 3 },
      { id: 'b', score: 2 },
    ],
    [
      { id: 'b', score: 9 },
      { id: 'c', score: 1 },
    ],
  ];
  assert.deepEqual(reciprocalRankFusion(lists as never), v23retrievers.reciprocalRankFusion(lists as never) as never);
});

test('MCP registry: a 2.3 configuration reads the same in this release', () => {
  const config = {
    mcpServers: {
      github: {
        command: 'github-mcp',
        args: ['--read-only'],
        env: { TOKEN: 'from-env' },
        allowTools: ['list_*'],
        denyTools: ['delete_*'],
      },
      docs: { url: 'https://docs.example/mcp', headers: { authorization: 'Bearer x' }, prefix: false },
      old: { command: 'old', enabled: false },
    },
    bundles: { support: ['github', 'docs'] },
  };
  assert.deepEqual(validateMcpConfig(config), v23registry.validateMcpConfig(config) as never);
  assert.throws(() => validateMcpConfig({ servers: { bad: {} } }));
  assert.throws(() => v23registry.validateMcpConfig({ servers: { bad: {} } }));
});

test('context hub: a bundle has the same version in both releases, and a 2.3 export imports here', async () => {
  const oldPrompts = new v23prompts.PromptRegistry();
  const prompt = await oldPrompts.commit({ name: 'answer', messages: [{ role: 'user', content: 'Answer {{q}}' }] });
  const bundle = {
    name: 'support',
    description: 'Answers billing questions',
    prompts: { answer: { name: 'answer', version: prompt.version } },
    instructions: { policy: 'Never promise a refund.' },
    tools: [{ name: 'lookup_order', description: 'Finds an order', parameters: { type: 'object' } }],
    config: { model: 'gpt-5.4-mini' },
  };
  const oldHub = new v23context.ContextHub({ prompts: oldPrompts });
  const committed = await oldHub.commit(bundle);
  assert.equal(await contextVersion(bundle as never), committed.version);
  const exported = JSON.parse(JSON.stringify(await oldHub.export('support')));
  assert.equal(exported.format, 'nexus-context-bundle');
  const hub = new ContextHub({ prompts: new PromptRegistry() });
  const imported = await hub.import(exported, { label: 'production', by: 'upgrade' });
  assert.equal(imported.version, committed.version);
  const rendered = await hub.renderPrompt(imported, 'answer', { q: 'Where is my refund?' });
  assert.equal(rendered.messages[0]?.content, 'Answer Where is my refund?');
});

test('insights: a 2.3 proposal reads here, and errors group under the same signature', async () => {
  const directory = path.join(scratch, 'proposals');
  const proposal = {
    id: 'fix-1',
    status: 'pending',
    createdAt: '2026-10-01T10:00:00.000Z',
    issue: { kind: 'failing', summary: '6 failing runs', signature: 'Error: Order <n> has no total' },
    change: { prompt: { name: 'answer', version: 'p000000000001' } },
  };
  await new v23insights.FileProposalStore(directory).save(proposal as never);
  const read = await new FileProposalStore(directory).get('fix-1');
  assert.equal(read?.id, 'fix-1');
  assert.deepEqual(read, (await new v23insights.FileProposalStore(directory).get('fix-1')) as never);
  for (const message of [
    'Order 12 has no total',
    'Timeout after 3021 ms calling https://api.example/v1/orders/99',
    'id 6f1c2a9e-1b2c-4d3e-8f90-123456789abc missing',
  ]) {
    assert.equal(errorSignature(message), v23insights.errorSignature(message), message);
  }
});

test('deployments: a 2.3 replica’s deployment routes the same here, and every thread keeps its bucket', async () => {
  const state = new MemoryServerStore();
  const assistant = (name: string) => ({ run: async () => ({ answer: name }) });
  const old = new v23deployments.Deployments({ state: state as never });
  old.assistant('support', { v1: assistant('v1'), v2: assistant('v2') } as never, { live: 'v1' });
  await old.canary('support', 'v2', 0.25, { by: 'ada', reason: 'rollout' });
  const current = new Deployments({ state });
  current.assistant('support', { v1: assistant('v1'), v2: assistant('v2') } as never, { live: 'v1' });
  const record = await current.get('support');
  assert.deepEqual(record?.traffic, { v1: 0.75, v2: 0.25 }, 'the split 2.3 recorded');
  assert.deepEqual(record, (await old.get('support')) as never);
  // Random thread ids, as a graph gives a thread by default, and sequential ones, which both releases
  // must place alike even though they spread less evenly over a small population.
  const threads = [
    ...Array.from({ length: 500 }, () => globalThis.crypto.randomUUID()),
    ...Array.from({ length: 200 }, (_, index) => `thread-${index}`),
  ];
  const chosen: Record<string, number> = {};
  for (const [index, threadId] of threads.entries()) {
    const request = { runId: `run-${index}`, threadId };
    const here = await current.route('support', request);
    const there = await old.route('support', request);
    assert.ok(here && there);
    assert.deepEqual([here.id, here.weight, here.deployment], [there.id, there.weight, there.deployment], threadId);
    if (index < 500) chosen[here.id] = (chosen[here.id] ?? 0) + 1;
    assert.equal(bucket(threadId), v23deployments.bucket(threadId));
  }
  // A quarter of 500 random threads is 125, give or take 10.
  assert.ok((chosen.v2 ?? 0) > 80 && (chosen.v2 ?? 0) < 170, `the canary takes its share: ${JSON.stringify(chosen)}`);
  // A change made by this release reads back through 2.3, so a mixed fleet agrees.
  await current.promote('support', 'v2', { by: 'ada' });
  assert.equal((await old.get('support'))?.live, 'v2');
});
