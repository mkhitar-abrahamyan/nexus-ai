import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareExperiments, formatComparison } from '../src/evaluate/compare.js';
import {
  contentVersion,
  createDataset,
  datasetFromTraces,
  FileDatasetStore,
  MemoryDatasetStore,
  MemoryExperimentStore,
  splitOf,
} from '../src/evaluate/datasets.js';
import {
  completed,
  contains,
  embeddingSimilarity,
  exactMatch,
  mustNotMatch,
  passRate,
  trajectory,
  underLatency,
} from '../src/evaluate/evaluators.js';
import { AnnotationQueue, evaluateOnline } from '../src/evaluate/review.js';
import { evaluate } from '../src/evaluate/run.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import type { Experiment } from '../src/types/evaluate.js';
import type { Run } from '../src/types/tracing.js';

const qaDataset = () =>
  createDataset<{ question: string }, string>({
    name: 'support-questions',
    examples: [
      { id: 'refund', inputs: { question: 'how do I get a refund?' }, expected: 'Open the order and choose refund.' },
      { id: 'hours', inputs: { question: 'when are you open?' }, expected: 'Weekdays, nine to five.', split: 'test' },
      { id: 'ship', inputs: { question: 'do you ship abroad?' }, expected: 'Yes, to most countries.' },
    ],
  });

// ── Datasets ───────────────────────────────────────────────────────

test('a dataset is versioned by its content, and a split is a dataset of its own', () => {
  const dataset = qaDataset();
  assert.match(dataset.version, /^v[0-9a-f]{12}$/);
  assert.equal(dataset.examples.length, 3);

  // The same examples produce the same version; a change produces a different one.
  assert.equal(createDataset({ name: 'other', examples: dataset.examples }).version, dataset.version);
  const edited = createDataset({
    name: 'support-questions',
    examples: [...dataset.examples.slice(1), { id: 'refund', inputs: { question: 'refunds?' }, expected: 'changed' }],
  });
  assert.notEqual(edited.version, dataset.version);

  const test_ = splitOf(dataset, 'test');
  assert.equal(test_.examples.length, 1);
  assert.equal(test_.name, 'support-questions:test');
  assert.equal(contentVersion(test_.examples), test_.version);
});

test('dataset stores keep versions, in memory and on disk', async (context) => {
  const dataset = qaDataset();
  const memory = new MemoryDatasetStore();
  memory.save(dataset);
  memory.save({ ...dataset, version: 'v-old', createdAt: '2020-01-01T00:00:00.000Z' });

  assert.equal(memory.get('support-questions')?.version, dataset.version, 'the newest version by default');
  assert.equal(memory.get('support-questions', 'v-old')?.version, 'v-old');
  assert.deepEqual(memory.list(), [{ name: 'support-questions', versions: [dataset.version, 'v-old'] }]);

  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-datasets-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const files = new FileDatasetStore(directory);
  await files.save(dataset);
  assert.equal((await files.get('support-questions'))?.examples.length, 3);
  assert.deepEqual(await files.list(), [{ name: 'support-questions', versions: [dataset.version] }]);
  assert.equal(await files.get('missing'), undefined);
});

test('a dataset can be built from recorded runs, keeping the run each example came from', async () => {
  const store = new MemoryTraceStore();
  const run: Run = {
    id: 'run-1',
    traceId: 't1',
    name: 'answer',
    kind: 'model',
    status: 'error',
    startedAt: '2026-09-20T10:00:00.000Z',
    inputs: { question: 'why did this fail?' },
    outputs: undefined,
  };
  store.save(run);
  store.save({ ...run, id: 'run-2', traceId: 't2', status: 'ok', outputs: 'a good answer' });

  const dataset = await datasetFromTraces({ name: 'production-failures', store, query: { status: 'error' } });
  assert.equal(dataset.examples.length, 1);
  assert.equal(dataset.examples[0]?.sourceRunId, 'run-1');
  assert.deepEqual(dataset.examples[0]?.inputs, { question: 'why did this fail?' });
});

// ── Running an evaluation ──────────────────────────────────────────

test('evaluate runs a target over a dataset and summarizes every metric', async () => {
  const dataset = qaDataset();
  const experiments = new MemoryExperimentStore();

  const experiment = await evaluate(
    (inputs: { question: string }) =>
      inputs.question.includes('refund') ? 'Open the order and choose refund.' : 'I do not know.',
    dataset,
    [exactMatch(), completed(), contains(['refund'], { key: 'mentions-refund' })],
    { name: 'baseline', store: experiments, summary: [passRate()] },
  );

  assert.equal(experiment.results.length, 3);
  assert.equal(experiment.errors, 0);
  assert.equal(experiment.dataset.version, dataset.version);

  const exact = experiment.metrics.find((metric) => metric.key === 'exact-match');
  assert.equal(exact?.n, 3);
  assert.ok(Math.abs((exact?.mean ?? 0) - 1 / 3) < 1e-9);
  assert.ok(Math.abs((exact?.passRate ?? 0) - 1 / 3) < 1e-9);
  assert.equal(experiment.summary[0]?.key, 'pass-rate');
  assert.equal(experiments.get(experiment.id)?.name, 'baseline');
  assert.equal(experiments.list({ dataset: 'support-questions' }).length, 1);
});

test('a target that throws is recorded as an error rather than failing the experiment', async () => {
  const dataset = qaDataset();
  const experiment = await evaluate(
    (inputs: { question: string }) => {
      if (inputs.question.includes('ship')) throw new Error('shipping service is down');
      return 'fine';
    },
    dataset,
    [completed()],
  );

  assert.equal(experiment.errors, 1);
  const failed = experiment.results.find((result) => result.error);
  assert.equal(failed?.exampleId, 'ship');
  assert.match(String(failed?.error?.message), /shipping service is down/);
  assert.equal(experiment.metrics.find((metric) => metric.key === 'completed')?.passRate, 2 / 3);

  const broken = await evaluate(() => 'ok', dataset, [
    () => {
      throw new Error('evaluator exploded');
    },
  ]);
  assert.equal(broken.errors, 0, 'a broken evaluator is not a failed example');
  assert.equal(broken.metrics[0]?.key, 'evaluator-error');
});

test('repetitions and concurrency are honoured, and a hanging example times out', async () => {
  const dataset = createDataset({ name: 'tiny', examples: [{ inputs: 1 }, { inputs: 2 }] });
  let inFlight = 0;
  let peak = 0;

  const experiment = await evaluate(
    async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return 'ok';
    },
    dataset,
    [completed()],
    { repetitions: 3, concurrency: 2 },
  );

  assert.equal(experiment.results.length, 6, 'two examples, three runs each');
  assert.equal(peak, 2);
  assert.deepEqual(
    experiment.results.map((result) => `${result.exampleId}:${result.run}`),
    ['ex-1:0', 'ex-1:1', 'ex-1:2', 'ex-2:0', 'ex-2:1', 'ex-2:2'],
  );

  const slow = await evaluate(() => new Promise((resolve) => setTimeout(resolve, 200)), dataset, [completed()], {
    timeoutMs: 20,
  });
  assert.equal(slow.errors, 2);
  assert.match(String(slow.results[0]?.error?.message), /exceeded 20ms/);
});

// ── Evaluators ─────────────────────────────────────────────────────

test('the bundled evaluators score text, latency, forbidden content, and trajectories', async () => {
  const dataset = createDataset({
    name: 'checks',
    examples: [{ id: 'one', inputs: 'q', expected: 'the answer', metadata: { expectedPath: ['search', 'summarize'] } }],
  });

  const experiment = await evaluate(
    () => ({
      state: {
        messages: [
          { toolCalls: [{ function: { name: 'search' } }] },
          { toolCalls: [{ function: { name: 'summarize' } }] },
        ],
      },
      answer: 'the answer',
    }),
    dataset,
    [
      contains(['answer']),
      mustNotMatch([/sk-[a-z0-9]+/i]),
      underLatency(5_000),
      trajectory(),
      trajectory({ expected: ['search', 'summarize', 'verify'], key: 'strict-path', mode: 'exact' }),
      embeddingSimilarity({
        embed: async (texts) => texts.map((text) => [text.length, text.includes('answer') ? 1 : 0]),
        threshold: 0.9,
      }),
    ],
  );

  const scores = Object.fromEntries(experiment.results[0]?.scores.map((score) => [score.key, score]) ?? []);
  assert.equal(scores.contains?.passed, true);
  assert.equal(scores['must-not-match']?.passed, true);
  assert.equal(scores.latency?.passed, true);
  assert.equal(scores.trajectory?.passed, true, 'both expected tools were called');
  assert.equal(scores['strict-path']?.passed, false);
  assert.match(String(scores['strict-path']?.comment), /expected search → summarize → verify/);
  assert.ok((scores.similarity?.score ?? 0) > 0.9);

  const leaked = await evaluate(() => 'here is sk-abc123', dataset, [mustNotMatch([/sk-[a-z0-9]+/i])]);
  assert.equal(leaked.results[0]?.scores[0]?.passed, false);
});

// ── Comparing experiments ──────────────────────────────────────────

function experimentWith(name: string, scores: Record<string, number>, options: { errors?: string[] } = {}): Experiment {
  const results = Object.entries(scores).map(([exampleId, score]) => ({
    exampleId,
    run: 0,
    latencyMs: 10,
    scores: [{ key: 'quality', score, passed: score >= 0.5 }],
    ...(options.errors?.includes(exampleId) ? { error: { name: 'Error', message: 'failed' } } : {}),
  }));
  return {
    id: `exp-${name}`,
    name,
    dataset: { name: 'd', version: 'v1' },
    startedAt: '2026-09-20T10:00:00.000Z',
    finishedAt: '2026-09-20T10:01:00.000Z',
    errors: options.errors?.length ?? 0,
    results,
    metrics: [],
    summary: [],
  };
}

test('a real improvement is reported as better, and noise as unchanged', () => {
  const baseline = experimentWith(
    'baseline',
    Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`ex${i}`, 0.4])),
  );
  const clearlyBetter = experimentWith(
    'candidate',
    Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`ex${i}`, 0.9])),
  );

  const improved = compareExperiments(baseline, clearlyBetter);
  const quality = improved.metrics.find((metric) => metric.key === 'quality');
  assert.equal(quality?.verdict, 'better');
  assert.ok((quality?.ci95[0] ?? 0) > 0, 'the interval excludes zero');
  assert.equal(improved.regressed, false);
  assert.equal(improved.improvements.length, 10, 'the biggest movers are listed');

  // One example moves a little, the rest do not: not enough to call it a change.
  const noisy = experimentWith('noisy', {
    ...Object.fromEntries(Array.from({ length: 19 }, (_, i) => [`ex${i}`, 0.4])),
    ex19: 0.5,
  });
  const unchanged = compareExperiments(baseline, noisy);
  assert.equal(unchanged.metrics.find((metric) => metric.key === 'quality')?.verdict, 'unchanged');
  assert.equal(unchanged.regressed, false);
});

test('a regression is caught, new failures are named, and the verdict is reproducible', () => {
  const baseline = experimentWith(
    'baseline',
    Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`ex${i}`, 0.9])),
  );
  const worse = experimentWith(
    'candidate',
    { ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`ex${i}`, 0.3])) },
    { errors: ['ex3'] },
  );

  const comparison = compareExperiments(baseline, worse);
  assert.equal(comparison.metrics.find((metric) => metric.key === 'quality')?.verdict, 'worse');
  assert.equal(comparison.regressed, true);
  assert.deepEqual(comparison.newErrors, ['ex3']);
  assert.equal(comparison.regressions[0]?.delta < 0, true);

  // Same inputs, same verdict: a gate in CI must not flip between runs.
  const again = compareExperiments(baseline, worse);
  assert.deepEqual(again.metrics, comparison.metrics);

  const report = formatComparison(comparison);
  assert.match(report, /▼ quality/);
  assert.match(report, /new failures: ex3/);

  const mismatched = compareExperiments(baseline, { ...worse, dataset: { name: 'd', version: 'v2' } });
  assert.deepEqual(mismatched.datasetMismatch, { baseline: 'v1', candidate: 'v2' });
  assert.match(formatComparison(mismatched), /dataset differs/);
});

// ── Review queues and online evaluation ────────────────────────────

test('an annotation queue leases items, collects consensus, and becomes a dataset', () => {
  let now = new Date('2026-09-20T12:00:00.000Z');
  const queue = new AnnotationQueue({
    rubric: [{ key: 'helpful', prompt: 'Was the answer helpful?', type: 'boolean' }],
    leaseMs: 60_000,
    consensus: 2,
    now: () => now,
  });

  const item = queue.enqueue({ inputs: { question: 'refund?' }, output: 'no idea', runId: 'run-9' });
  assert.equal(item.status, 'pending');

  const claimed = queue.claim('alice');
  assert.equal(claimed?.id, item.id);
  assert.equal(queue.claim('bob')?.id, item.id, 'consensus of two means a second reviewer may claim it too');

  queue.submit(item.id, { reviewer: 'alice', scores: [{ key: 'helpful', score: 0 }] });
  assert.equal(queue.list('reviewed').length, 0, 'one answer is not consensus');
  queue.submit(item.id, { reviewer: 'bob', scores: [{ key: 'helpful', score: 1 }] });
  assert.equal(queue.list('reviewed').length, 1);
  assert.deepEqual(queue.consensusScores(item.id), [{ key: 'helpful', score: 0.5, metadata: { reviewers: 2 } }]);

  const examples = queue.toExamples();
  assert.equal(examples[0]?.sourceRunId, 'run-9');
  const reviewMetadata = examples[0]?.metadata as { review?: Record<string, number> } | undefined;
  assert.deepEqual(reviewMetadata?.review, { helpful: 0.5 });

  // An abandoned claim returns to the queue once its lease expires.
  const second = queue.enqueue({ inputs: 'x', output: 'y' });
  queue.claim('carol');
  assert.equal(queue.claim('dave')?.id, second.id, 'a different reviewer may take an unclaimed item');
  now = new Date(now.getTime() + 120_000);
  assert.equal(queue.claim('erin')?.id, second.id, 'the expired claim was reclaimed');
  assert.throws(() => queue.submit('nope', { reviewer: 'x', scores: [] }), RangeError);
});

test('online evaluation scores production runs, writes feedback, and sends the uncertain ones to people', async () => {
  const store = new MemoryTraceStore();
  const base: Run = {
    id: 'r1',
    traceId: 't1',
    name: 'answer',
    kind: 'model',
    status: 'ok',
    startedAt: '2026-09-20T10:00:00.000Z',
    latencyMs: 50,
    inputs: { question: 'refund?' },
    outputs: 'Open the order and choose refund.',
  };
  store.save(base);
  store.save({ ...base, id: 'r2', traceId: 't2', outputs: 'I do not know.' });

  const queue = new AnnotationQueue({ rubric: [{ key: 'helpful', prompt: 'Helpful?', type: 'boolean' }] });
  const report = await evaluateOnline({
    store,
    evaluators: [contains(['refund'], { key: 'mentions-refund' })],
    reviewQueue: queue,
    reviewWhen: (scores) => scores.some((score) => score.passed === false),
  });

  assert.equal(report.scanned, 2);
  assert.equal(report.evaluated, 2);
  assert.equal(report.queuedForReview, 1);
  assert.equal(queue.list('pending')[0]?.subject.runId, 'r2');

  const scored = store.get('r1');
  assert.equal(scored?.feedback?.[0]?.key, 'mentions-refund');
  assert.equal(scored?.feedback?.[0]?.score, 1);
  assert.equal(scored?.feedback?.[0]?.source, 'online-evaluation');
  // Feedback makes the run findable, which is how a bad sample becomes a dataset example.
  assert.deepEqual(store.query({ feedbackKey: 'mentions-refund' }).length, 2);
});
