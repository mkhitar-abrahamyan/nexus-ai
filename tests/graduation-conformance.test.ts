/**
 * Conformance for the surfaces that leave experimental status in 2.4, on every backend each one
 * supports: the evidence the graduation checklist in `API_STABILITY.md` asks for under "Conformance"
 * and, for the context hub, "Concurrency".
 *
 * - Every retriever, and a vector retriever over each local vector store, passes the retriever
 *   contract from `nexus-ai-pro/adapter-kit`.
 * - The context hub keeps the same behaviour on memory, files, Redis, and Postgres. Two hubs racing
 *   for one label on the same store never both win.
 * - Insights finds the same issues in runs kept in memory and in Postgres.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { runRetrieverContract } from '../src/adapter-kit/contracts.js';
import { ContextConflictError, ContextHub } from '../src/context-hub/index.js';
import { createHashEmbeddings, MemoryVectorStore } from '../src/hallucination/retrieval.js';
import { findIssues } from '../src/insights/index.js';
import type { PostgresLikeClient } from '../src/postgres/client.js';
import { PostgresPromptStore } from '../src/postgres/prompts.js';
import { PostgresTraceStore } from '../src/postgres/traces.js';
import { PostgresVectorStore } from '../src/postgres/vectors.js';
import { FilePromptStore } from '../src/prompts/file.js';
import { RedisPromptStore } from '../src/prompts/redis.js';
import { PromptRegistry } from '../src/prompts/registry.js';
import { MemoryPromptStore } from '../src/prompts/memory.js';
import { hybridRetriever, KeywordIndex, vectorRetriever } from '../src/rag/retrievers.js';
import { SqliteVectorStore } from '../src/sqlite/vectors.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import type { RagChunk } from '../src/hallucination/rag.js';
import type { PromptStore } from '../src/types/prompts.js';
import type { Run, TraceStore } from '../src/types/tracing.js';
import { FakeRedis } from './redis-fake.js';

const work = mkdtempSync(path.join(tmpdir(), 'nexus-graduation-'));
let pg: PGlite;
let client: PostgresLikeClient;
let redis: FakeRedis;
let tables = 0;
before(async () => {
  pg = new PGlite({ extensions: { vector } });
  await pg.waitReady;
  client = pg as unknown as PostgresLikeClient;
  redis = await FakeRedis.create();
});
after(async () => {
  await pg.close();
  redis.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const DIMENSIONS = 256;
const embed = (texts: string[]) => createHashEmbeddings(texts, DIMENSIONS);

function assertPasses(name: string, checks: Array<{ name: string; ok: boolean; detail?: string; skipped?: boolean }>) {
  const failed = checks.filter((check) => !check.ok && !check.skipped);
  assert.deepEqual(
    failed.map((check) => `${check.name}: ${check.detail}`),
    [],
    `${name} fails the retriever contract`,
  );
  assert.ok(checks.filter((check) => check.ok).length >= 4, `${name} ran the contract`);
}

test('every retriever, and a vector retriever over every local vector store, passes the retriever contract', async () => {
  assertPasses('KeywordIndex', await runRetrieverContract(new KeywordIndex()));

  const memory = new MemoryVectorStore(embed);
  const sqlite = new SqliteVectorStore(new DatabaseSync(':memory:'), { dimensions: DIMENSIONS, embed });
  await sqlite.migrate();
  const postgres = new PostgresVectorStore(client, { dimensions: DIMENSIONS, embed, table: `retrieve_${++tables}` });
  await postgres.migrate();
  for (const [name, store] of [
    ['memory', memory],
    ['sqlite', sqlite],
    ['postgres', postgres],
  ] as const) {
    assertPasses(
      `vectorRetriever(${name})`,
      await runRetrieverContract(vectorRetriever(store), {
        capabilities: { writes: false },
        load: (passages: RagChunk[]) => store.add(passages),
      }),
    );
  }

  const keywords = new KeywordIndex();
  const dense = new MemoryVectorStore(embed);
  assertPasses(
    'hybridRetriever',
    await runRetrieverContract(hybridRetriever([keywords, vectorRetriever(dense)]), {
      capabilities: { writes: false },
      load: async (passages: RagChunk[]) => {
        keywords.add(passages);
        await dense.add(passages);
      },
    }),
  );
});

async function promptStores(): Promise<Array<[string, () => Promise<PromptStore>]>> {
  return [
    ['memory', async () => new MemoryPromptStore()],
    ['file', async () => new FilePromptStore(path.join(work, `hub-${++tables}`))],
    ['redis', async () => new RedisPromptStore(redis as never, { prefix: `hub-${++tables}` } as never)],
    [
      'postgres',
      async () => {
        const store = new PostgresPromptStore(client, { table: `hub_${++tables}` });
        await store.migrate();
        return store;
      },
    ],
  ];
}

test('the context hub behaves the same on memory, files, Redis, and Postgres', async () => {
  const prompts = new PromptRegistry();
  const answer = await prompts.commit({ name: 'answer', messages: [{ role: 'user', content: 'Answer {{q}}' }] });
  const bundle = (tone: string) => ({
    name: 'support',
    description: 'Answers billing questions',
    prompts: { answer: { name: 'answer', version: answer.version } },
    instructions: { policy: 'Never promise a refund.', tone },
    config: { model: 'gpt-5.4-mini' },
  });
  const results: string[] = [];
  for (const [name, open] of await promptStores()) {
    const store = await open();
    const hub = new ContextHub({ store, prompts });
    const first = await hub.commit(bundle('Be brief.'), { label: 'staging', author: 'ada' });
    const again = await hub.commit(bundle('Be brief.'));
    const second = await hub.commit(bundle('Be kind.'), { message: 'kinder' });
    assert.equal(again.version, first.version, `${name}: the same content is the same version`);
    assert.equal((await hub.get('support')).version, second.version, `${name}: latest`);
    assert.equal((await hub.get('support', 'staging')).version, first.version, `${name}: a label`);
    await hub.label('support', 'staging', second.version, { by: 'ada' });
    await hub.rollback('support', 'staging', { by: 'bob' });
    assert.equal((await hub.get('support', 'staging')).version, first.version, `${name}: a rollback`);
    assert.deepEqual(await hub.names(), ['support'], name);
    assert.equal((await hub.versions('support')).length, 2, name);
    const actions = (await hub.history('support')).map((entry) => entry.action);
    results.push(`${name}:${[...actions].sort().join(',')}`);

    // A second process on the same store reads what the first wrote.
    const other = new ContextHub({ store, prompts });
    assert.equal((await other.get('support', 'staging')).version, first.version, `${name}: another process`);

    // An export from this backend imports into a fresh one, as the same version.
    const imported = await new ContextHub({ prompts: new PromptRegistry() }).import(
      JSON.parse(JSON.stringify(await hub.export('support', 'staging'))),
    );
    assert.equal(imported.version, first.version, `${name}: export`);
  }
  assert.equal(
    new Set(results.map((entry) => entry.split(':')[1])).size,
    1,
    `one history on every backend: ${results}`,
  );
});

/** Resolves once `parties` callers have arrived. */
function barrier(parties: number): () => Promise<void> {
  let arrived: Array<() => void> = [];
  return () =>
    new Promise<void>((resolve) => {
      arrived.push(resolve);
      if (arrived.length === parties) {
        for (const release of arrived) release();
        arrived = [];
      }
    });
}

/** The store, with each label write held until the other racer's arrives too. */
function meetingAt(gate: () => Promise<void>, store: PromptStore): PromptStore {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === 'setLabel') {
        return async (...args: Parameters<PromptStore['setLabel']>) => {
          await gate();
          return target.setLabel(...args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('two hubs racing to move one label on one store never both win, on every backend', async () => {
  const prompts = new PromptRegistry();
  for (const [name, open] of await promptStores()) {
    const store = await open();
    const setup = new ContextHub({ store, prompts });
    const base = { name: 'race', instructions: { policy: 'base' } };
    const start = await setup.commit(base, { label: 'production' });
    const a = await setup.commit({ ...base, instructions: { policy: 'a' } });
    const b = await setup.commit({ ...base, instructions: { policy: 'b' } });
    // Both hubs reach the store's compare-and-set together, as two processes would at worst.
    const gate = barrier(2);
    const one = new ContextHub({ store: meetingAt(gate, store), prompts });
    const two = new ContextHub({ store: meetingAt(gate, store), prompts });
    const outcomes = await Promise.allSettled([
      one.label('race', 'production', a.version),
      two.label('race', 'production', b.version),
    ]);
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const lost = outcomes.filter((outcome) => outcome.status === 'rejected');
    const final = (await setup.get('race', 'production')).version;
    assert.notEqual(final, start.version, `${name}: someone moved the label`);
    if (won.length === 2) {
      // Both may succeed only when they did not overlap: then each saw the other's write first.
      const moves = (await setup.history('race', { label: 'production' })).filter(
        (entry) => entry.action === 'label' && [a.version, b.version].includes(String(entry.version)),
      );
      assert.equal(moves.length, 2, `${name}: two moves, each recorded`);
      // Moves that did not overlap form a chain; a lost update leaves both moving from the start.
      assert.deepEqual(
        moves.map((entry) => entry.previous).sort(),
        [start.version, final === a.version ? b.version : a.version].sort(),
        `${name}: the second move started from the first, not from where both began`,
      );
    } else {
      assert.equal(won.length, 1, name);
      assert.ok(
        (lost[0] as PromiseRejectedResult).reason instanceof ContextConflictError,
        `${name}: the loser is told`,
      );
    }
  }
});

test('ten writers upserting the same ids at once leave one row per id, each one writer’s whole version', async () => {
  const file = path.join(work, 'concurrent.db');
  const writers = 10;
  const ids = Array.from({ length: 25 }, (_, index) => `doc-${index}`);
  const opened: DatabaseSync[] = [];
  const stores = [
    [
      'sqlite',
      async () => {
        const db = new DatabaseSync(file);
        opened.push(db);
        db.exec('PRAGMA busy_timeout = 5000');
        const store = new SqliteVectorStore(db, { dimensions: DIMENSIONS, embed });
        await store.migrate();
        return store;
      },
    ],
    [
      'postgres',
      async () => {
        const store = new PostgresVectorStore(client, { dimensions: DIMENSIONS, embed, table: 'concurrent_vectors' });
        await store.migrate();
        return store;
      },
    ],
  ] as const;
  for (const [name, open] of stores) {
    // Each writer opens its own handle where the engine allows it, as separate processes would.
    const handles = await Promise.all(Array.from({ length: writers }, () => open()));
    await Promise.all(
      handles.map((store, writer) =>
        store.add(ids.map((id) => ({ id, content: `${id} written by writer ${writer}`, metadata: { writer } }))),
      ),
    );
    const found = await handles[0].search('written by writer', { topK: 1_000 });
    assert.equal(found.length, ids.length, `${name}: one row per id`);
    for (const row of found) {
      const writer = (row.metadata as { writer: number }).writer;
      assert.equal(
        row.content,
        `${row.id} written by writer ${writer}`,
        `${name}: a row is one writer’s whole version`,
      );
    }
  }
  for (const db of opened) db.close();
});

test('insights finds the same issues in runs kept in memory and in Postgres', async () => {
  const now = new Date('2026-10-01T12:00:00.000Z');
  const runs: Run[] = [];
  for (let index = 0; index < 60; index += 1) {
    runs.push({
      id: `run-${index}`,
      traceId: `run-${index}`,
      name: 'support-agent',
      kind: 'agent',
      startedAt: '2026-10-01T11:00:00.000Z',
      latencyMs: index % 10 === 0 ? 9_000 : 200,
      status: index % 6 === 0 ? 'error' : 'ok',
      ...(index % 6 === 0 ? { error: { name: 'Error', message: `Order ${index} has no total` } } : {}),
    } as Run);
  }
  const postgres = new PostgresTraceStore(client, { table: `insight_runs_${++tables}` });
  await postgres.migrate();
  const found: string[] = [];
  for (const store of [new MemoryTraceStore(), postgres] as TraceStore[]) {
    for (const run of runs) await store.save(run);
    const issues = await findIssues({ store, slowMs: 5_000, now: () => now });
    found.push(JSON.stringify(issues.map((issue) => [issue.kind, issue.cluster.count, issue.summary])));
  }
  assert.equal(found[0], found[1]);
  assert.match(found[0] ?? '', /failing/);
});
