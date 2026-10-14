/**
 * Paging runs, proved: every trace store orders runs the same way, newest first and then by id as
 * code units, and pages by cursor without repeating or skipping a run, however many share a start
 * time; and ten online-evaluation workers, reading 1,000 a page, schedule 4,000 runs that started in
 * one millisecond, among 1,000 that did not, each exactly once, on every store, and on a store of
 * the application's own that ignores the cursor.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { onlineEvaluationWorker } from '../src/evaluate/online.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import type { PostgresLikeClient } from '../src/postgres/client.js';
import { PostgresTraceStore } from '../src/postgres/traces.js';
import { applyQuery, isAfterCursor, JsonlTraceStore, MemoryTraceStore, runCursor } from '../src/tracing/stores.js';
import type { Run, RunCursor, RunQuery, TraceStore } from '../src/types/tracing.js';

const BURST = '2026-10-01T12:00:00.123Z';
// Ids whose code-unit order differs from a locale's: upper case sorts before `_`, which sorts before
// lower case, where a locale puts the underscore first and interleaves the cases.
const PREFIXES = ['a', 'B', '_', 'z', 'Z'];

/** 500 runs before the burst, 4,000 in one millisecond, and 500 after it. */
function burstRuns(): Run[] {
  const runs: Run[] = [];
  const at = (offsetMs: number) => new Date(Date.parse(BURST) + offsetMs).toISOString();
  for (let index = 0; index < 5_000; index += 1) {
    const startedAt = index < 500 ? at(-500 + index) : index < 4_500 ? BURST : at(index - 4_499);
    runs.push({
      id: `${PREFIXES[index % PREFIXES.length]}-${String(index).padStart(5, '0')}`,
      traceId: `trace-${index}`,
      name: 'support-agent',
      kind: 'model',
      status: 'ok',
      startedAt,
      inputs: { question: `question ${index}` },
      outputs: 'Here is your refund.',
    });
  }
  return runs;
}

let db: PGlite;
let directory: string;

before(async () => {
  db = new PGlite();
  await db.waitReady;
  directory = await mkdtemp(path.join(tmpdir(), 'nexus-paging-'));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

let tables = 0;
async function storesWith(runs: readonly Run[]): Promise<Array<[string, TraceStore]>> {
  const memory = new MemoryTraceStore({ maxRuns: runs.length + 10 });
  for (const run of runs) memory.save(run);
  const file = path.join(directory, `runs-${++tables}.jsonl`);
  await writeFile(file, runs.map((run) => `${JSON.stringify(run)}\n`).join(''), 'utf8');
  const postgres = new PostgresTraceStore(db as unknown as PostgresLikeClient, { table: `paging_runs_${tables}` });
  await postgres.migrate();
  await db.exec('BEGIN');
  for (const run of runs) await postgres.save(run);
  await db.exec('COMMIT');
  return [
    ['memory', memory],
    ['jsonl', new JsonlTraceStore({ file })],
    ['postgres', postgres],
  ];
}

/** A store of the application's own, written before `after` existed: it pages by offset only. */
function withoutCursor(store: TraceStore): TraceStore {
  return {
    save: (run) => store.save(run),
    get: (id) => store.get(id),
    tree: (id) => store.tree(id),
    addFeedback: (id, feedback) => store.addFeedback?.(id, feedback),
    query: (query: RunQuery = {}) => {
      const { after: _ignored, ...rest } = query;
      return store.query(rest);
    },
  };
}

test('every trace store orders runs alike, and pages by cursor through a burst without a repeat or a gap', async () => {
  const runs = burstRuns();
  const expected = applyQuery(runs, { limit: runs.length }).map((run) => run.id);
  assert.equal(new Set(expected).size, 5_000);
  // Newest first, then by id as code units from last to first: z, a, _, Z, B, where a locale would
  // put the underscore first and mix the cases.
  const startedAt = new Map(runs.map((run) => [run.id, run.startedAt]));
  const burst = expected.filter((id) => startedAt.get(id) === BURST);
  assert.equal(burst.length, 4_000);
  assert.deepEqual(burst.slice(0, 3), ['z-04498', 'z-04493', 'z-04488']);
  const groups = burst.map((id) => id[0]).filter((prefix, index, all) => prefix !== all[index - 1]);
  assert.deepEqual(groups, ['z', 'a', '_', 'Z', 'B']);

  for (const [name, store] of await storesWith(runs)) {
    const read: string[] = [];
    let cursor: RunCursor | undefined;
    for (let page = 0; page < 10; page += 1) {
      const runsOfPage = await store.query({ limit: 1_000, ...(cursor ? { after: cursor } : {}) });
      read.push(...runsOfPage.map((run) => run.id));
      if (runsOfPage.length < 1_000) break;
      cursor = runCursor(runsOfPage.at(-1) as Run);
      for (const run of runsOfPage)
        assert.equal(isAfterCursor(run, cursor), false, `${name}: a page ends at its last run`);
    }
    assert.deepEqual(read, expected, `${name} reads every run once, in the shared order`);
    // The cursor narrows a filtered query too, and keeps its other filters.
    const middle = runCursor({ id: expected[2_500] as string, startedAt: BURST });
    const narrowed = await store.query({ after: middle, until: BURST, limit: 5 });
    assert.deepEqual(
      narrowed.map((run) => run.id),
      expected.slice(2_501, 2_506),
      `${name} resumes inside the burst`,
    );
  }
});

/** Runs passes until one reads past the oldest run with nothing left to queue. */
async function sweep(worker: ReturnType<typeof onlineEvaluationWorker>): Promise<Set<string>> {
  const paging = new Set<string>();
  for (let pass = 0; pass < 200; pass += 1) {
    const result = await worker.schedule();
    paging.add(result.paging);
    if (result.exhausted && result.queued === 0) return paging;
  }
  throw new Error('the worker never read past the oldest run');
}

test('proof: ten workers reading 1,000 a page schedule 4,000 runs from one millisecond exactly once, on every store', async () => {
  const runs = burstRuns();
  const stores = await storesWith(runs);
  stores.push(['a store without the cursor', withoutCursor(stores[0]?.[1] as TraceStore)]);
  for (const [name, traces] of stores) {
    const operations = new MemoryOperationStore({ maxRecords: 20_000 });
    const workers = Array.from({ length: 10 }, (_, index) =>
      onlineEvaluationWorker({
        source: 'quality',
        traces,
        operations,
        evaluators: [() => ({ key: 'ok', score: 1 })],
        owner: `${name}-${index}`,
        scanLimit: 1_000,
        maxQueued: 10_000,
      }),
    );
    const paging = await Promise.all(workers.map(sweep));
    const records = operations.list().filter((record) => record.kind === 'online-evaluation:quality');
    const scheduled = records.map((record) => String(record.metadata?.runId));
    assert.equal(scheduled.length, 5_000, `${name}: one operation per run`);
    assert.equal(new Set(scheduled).size, 5_000, `${name}: no run twice`);
    const expected = name === 'a store without the cursor' ? 'offset' : 'cursor';
    for (const used of paging) assert.ok(used.has(expected), `${name} paged by ${expected}`);
    if (expected === 'cursor') for (const used of paging) assert.deepEqual([...used], ['cursor'], name);
  }
});

test('a scored burst is scored once per run, on a worker that drains it', async () => {
  const runs = burstRuns().slice(0, 2_600);
  const traces = new MemoryTraceStore({ maxRuns: 3_000 });
  for (const run of runs) traces.save(run);
  const operations = new MemoryOperationStore({ maxRecords: 10_000 });
  const report = await onlineEvaluationWorker({
    source: 'quality',
    traces,
    operations,
    evaluators: [() => ({ key: 'ok', score: 1 })],
    scanLimit: 500,
    maxQueued: 10_000,
    concurrency: 16,
    pollMs: 5,
  }).drain();
  assert.equal(report.stoppedBy, 'idle');
  assert.equal(report.scored, 2_600);
  for (const run of runs) {
    assert.equal((traces.get(run.id)?.feedback ?? []).length, 1, `${run.id} scored once`);
  }
});
