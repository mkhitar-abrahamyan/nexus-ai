/**
 * Online evaluation on workers, proved: ten workers over one operation store score 10,000 runs, each
 * exactly once for its source, while one of them crashes halfway, after writing a run's scores and
 * before recording that it had; the queue never grows far past its limit; the workers stop at their
 * budget and carry on in the next period without scoring anything twice; and sampling and sources
 * hold across workers.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDataset } from '../src/evaluate/datasets.js';
import { onlineEvaluationWorker } from '../src/evaluate/online.js';
import { EvaluationBudgetError, evaluate } from '../src/evaluate/run.js';
import { budgetLedger } from '../src/lifecycle/budget.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import type { Evaluator } from '../src/types/evaluate.js';
import type { OperationStore } from '../src/types/operations.js';
import type { Run, TraceStore } from '../src/types/tracing.js';

const base = Date.parse('2026-10-01T00:00:00.000Z');

function tracesWith(count: number): MemoryTraceStore {
  const traces = new MemoryTraceStore({ maxRuns: count + 10 });
  for (let index = 0; index < count; index += 1) {
    const run: Run = {
      id: `run-${index}`,
      traceId: `trace-${index}`,
      name: 'support-agent',
      kind: 'model',
      status: 'ok',
      startedAt: new Date(base + index).toISOString(),
      inputs: { question: `question ${index}` },
      outputs: index % 3 === 0 ? 'Sorry, no.' : 'Here is your refund.',
      latencyMs: 10,
    };
    traces.save(run);
  }
  return traces;
}

const polite: Evaluator = (context) => ({ key: 'polite', score: /sorry|please/i.test(String(context.output)) ? 1 : 0 });
const resolved: Evaluator = (context) => ({ key: 'resolved', score: /refund/i.test(String(context.output)) ? 1 : 0 });

/** A worker's view of the shared stores, which stops working the moment it is killed. */
function mortal<T extends object>(store: T, life: { dead: boolean }): T {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (life.dead) throw new Error('the worker died');
        return (value as (...inner: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** Each run's feedback from one source, counted per key. */
function scoredOnce(traces: MemoryTraceStore, source: string, runs: number, keys: string[]) {
  const problems: string[] = [];
  for (let index = 0; index < runs; index += 1) {
    const feedback = (traces.get(`run-${index}`)?.feedback ?? []).filter((entry) => entry.source === source);
    const byKey = feedback.map((entry) => entry.key).sort();
    if (JSON.stringify(byKey) !== JSON.stringify([...keys].sort())) problems.push(`run-${index}: ${byKey.join(',')}`);
  }
  return problems;
}

test('ten workers score 10,000 runs exactly once each, through a crash between a write and its record', async () => {
  const traces = tracesWith(10_000);
  const operations = new MemoryOperationStore({ maxRecords: 100_000 });
  const life = { dead: false };
  let written = 0;
  // Worker 3 dies right after writing the scores of its 10th run, before it can record the run done.
  const doomedTraces = mortal(
    {
      get: (id: string) => traces.get(id),
      query: (query: Parameters<TraceStore['query']>[0]) => traces.query(query),
      save: (run: Run) => traces.save(run),
      tree: (id: string) => traces.tree(id),
      addFeedback: (id: string, feedback: Parameters<NonNullable<TraceStore['addFeedback']>>[1]) => {
        traces.addFeedback(id, feedback);
        written += 1;
        if (written === 20) life.dead = true;
      },
    } as TraceStore,
    life,
  );
  const workers = Array.from({ length: 10 }, (_, index) =>
    onlineEvaluationWorker({
      source: 'quality',
      traces: index === 3 ? doomedTraces : traces,
      operations: index === 3 ? mortal(operations as OperationStore, life) : operations,
      evaluators: [polite, resolved],
      owner: `worker-${index}`,
      maxQueued: 500,
      scanLimit: 1_000,
      // One at a time, so its 20th write is the second score of its 10th run.
      concurrency: index === 3 ? 1 : 4,
      leaseMs: 300,
      pollMs: 20,
    }),
  );

  let peak = 0;
  const sampler = setInterval(() => {
    const stats = operations.stats(new Date().toISOString(), { kindPrefix: 'online-evaluation:quality' });
    peak = Math.max(
      peak,
      (stats.byStatus.queued ?? 0) + (stats.byStatus.running ?? 0) + (stats.byStatus.retrying ?? 0),
    );
  }, 5);
  const reports = await Promise.allSettled(workers.map((worker) => worker.drain()));
  clearInterval(sampler);

  assert.equal(life.dead, true, 'the doomed worker reached its crash');
  assert.equal(reports[3]?.status, 'rejected', 'the doomed worker died');
  const survivors = reports.flatMap((report) => (report.status === 'fulfilled' ? [report.value] : []));
  assert.equal(survivors.length, 9);
  for (const report of survivors) assert.equal(report.stoppedBy, 'idle');

  assert.deepEqual(scoredOnce(traces, 'quality', 10_000, ['polite', 'resolved']), [], 'every run scored once per key');
  const survivorsScored = survivors.reduce((sum, report) => sum + report.scored, 0);
  const already = survivors.reduce((sum, report) => sum + report.alreadyScored, 0);
  assert.ok(already >= 1, 'the run the dead worker scored but never recorded was run again, and not rescored');
  assert.equal(
    survivorsScored + (workers[3]?.report().scored ?? 0),
    10_000,
    'each run was scored by exactly one worker',
  );
  assert.ok(peak <= 500 + 10 * 25 + 10 * 4, `the queue stayed near its limit: peak ${peak}`);
  const records = operations.list().filter((record) => record.kind === 'online-evaluation:quality');
  assert.equal(records.length, 10_000, 'one operation per run');
  assert.equal(records.filter((record) => record.status === 'succeeded').length, 10_000);
});

test('workers stop at their budget, leave the rest queued, and carry on in the next period', async () => {
  const traces = tracesWith(200);
  const operations = new MemoryOperationStore({ maxRecords: 10_000 });
  let clock = Date.parse('2026-10-15T00:00:00.000Z');
  const now = () => new Date(clock);
  // Half a dollar, with room for the rounding of fifty one-cent reservations.
  const budget = budgetLedger({ limit: 0.505, period: 'month', now });
  const worker = (index: number) =>
    onlineEvaluationWorker({
      source: 'judged',
      traces,
      operations,
      evaluators: [polite],
      owner: `budget-${index}`,
      budget,
      estimate: 0.01,
      costOf: () => 0.01,
      maxQueued: 100,
      leaseMs: 300,
      pollMs: 10,
      now,
    });

  const first = await Promise.all([worker(0), worker(1), worker(2)].map((each) => each.drain()));
  for (const report of first) assert.equal(report.stoppedBy, 'budget');
  const scored = first.reduce((sum, report) => sum + report.scored, 0);
  assert.equal(scored, 50, 'fifty evaluations at a cent each fill a fifty-cent budget');
  assert.ok((await budget.spent('default')) <= 0.505);
  const paused = operations.stats(new Date(clock).toISOString(), { kindPrefix: 'online-evaluation:judged' });
  assert.ok((paused.byStatus.queued ?? 0) > 0, 'what the budget did not cover is still queued');
  assert.equal(
    operations.list().filter((record) => record.status === 'failed').length,
    0,
    'nothing was failed for the budget',
  );

  // The next month brings a new budget: new workers carry on for another fifty, and stop again, and
  // no run scored in October is scored again.
  clock = Date.parse('2026-11-02T00:00:00.000Z');
  const second = await Promise.all([worker(3), worker(4), worker(5), worker(6)].map((each) => each.drain()));
  for (const report of second) assert.equal(report.stoppedBy, 'budget');
  assert.equal(
    second.reduce((sum, report) => sum + report.scored, 0),
    50,
  );
  const counts = [...Array(200).keys()].map(
    (index) => (traces.get(`run-${index}`)?.feedback ?? []).filter((entry) => entry.source === 'judged').length,
  );
  assert.equal(counts.filter((count) => count === 1).length, 100, 'a hundred runs scored over two months');
  assert.ok(
    counts.every((count) => count <= 1),
    'none twice',
  );
});

test('sampling picks the same runs on every worker, and two sources share a store without crossing', async () => {
  const traces = tracesWith(1_000);
  const operations = new MemoryOperationStore({ maxRecords: 10_000 });
  const make = (source: string, owner: string, sampleRate: number) =>
    onlineEvaluationWorker({
      source,
      traces,
      operations,
      evaluators: [source === 'quality' ? polite : resolved],
      owner,
      sampleRate,
      leaseMs: 300,
      pollMs: 10,
    });
  await Promise.all([
    make('quality', 'q1', 0.3).drain(),
    make('quality', 'q2', 0.3).drain(),
    make('safety', 's1', 1).drain(),
    make('safety', 's2', 1).drain(),
  ]);
  const sampled = [...Array(1_000).keys()].filter((index) =>
    (traces.get(`run-${index}`)?.feedback ?? []).some((entry) => entry.source === 'quality'),
  );
  assert.ok(sampled.length > 240 && sampled.length < 360, `${sampled.length} of 1,000 sampled at 0.3`);
  for (let index = 0; index < 1_000; index += 1) {
    const feedback = traces.get(`run-${index}`)?.feedback ?? [];
    assert.equal(feedback.filter((entry) => entry.source === 'safety').length, 1);
    assert.ok(feedback.filter((entry) => entry.source === 'quality').length <= 1);
    assert.ok(
      feedback.every((entry) => (entry.source === 'quality' ? entry.key === 'polite' : entry.key === 'resolved')),
    );
  }
  // A third worker, sampling the same way, finds nothing new to score.
  const again = await make('quality', 'q3', 0.3).drain();
  assert.equal(again.scored, 0);
});

test('an experiment stops at its budget, and rejects with the results it paid for', async () => {
  const examples = Array.from({ length: 40 }, (_, index) => ({ id: `ex-${index}`, inputs: { n: index } }));
  const dataset = createDataset({ name: 'capped', examples });
  const budget = budgetLedger({ limit: 0.105 });
  let calls = 0;
  const target = async () => {
    calls += 1;
    return { answer: 'ok', cost: 0.01 };
  };
  const stopped = await evaluate(target, dataset, [() => 1], {
    budget: { ledger: budget, estimate: 0.01 },
    concurrency: 1,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(stopped instanceof EvaluationBudgetError);
  assert.equal(stopped.results.length, 10, 'ten example runs at a cent fit a ten-and-a-half-cent cap');
  assert.equal(calls, 10, 'no example started once the budget was spent');
  assert.equal(stopped.cause.name, 'BudgetExceededError');
  assert.ok((await budget.spent('default')) <= 0.105);

  // A budget large enough runs the whole dataset, as before.
  const experiment = await evaluate(target, dataset, [() => 1], {
    budget: { ledger: budgetLedger({ limit: 1 }), estimate: 0.01 },
  });
  assert.equal(experiment.results.length, 40);
});
