import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareExperiments } from '../src/evaluate/compare.js';
import { createDataset, FileExperimentStore, MemoryExperimentStore, readExperiment } from '../src/evaluate/datasets.js';
import { totalCost, underCost } from '../src/evaluate/evaluators.js';
import { evaluate } from '../src/evaluate/run.js';
import { EvalRunner } from '../src/evals/runner.js';
import { MediaEvalRunner } from '../src/images/evals.js';
import type { ImageResult } from '../src/types/images.js';

const dataset = () =>
  createDataset({
    name: 'priced',
    examples: [
      { id: 'a', inputs: 1 },
      { id: 'b', inputs: 2 },
      { id: 'c', inputs: 3 },
    ],
  });

test('evaluate() reads cost from the shapes the package produces, so totalCost is no longer always zero', async () => {
  const outputs: Record<number, unknown> = {
    1: { content: 'x', meta: { cost: { amount: 0.25, currency: 'USD', basis: 'estimated' } } },
    2: { assets: [], meta: { cost: 0.5 } },
    3: { answer: 'y', cost: 1 },
  };
  const experiment = await evaluate((inputs: number) => outputs[inputs], dataset(), [underCost(0.6)], {
    summary: [totalCost()],
  });

  assert.deepEqual(
    experiment.results.map((result) => result.cost),
    [0.25, 0.5, 1],
  );
  assert.equal(experiment.summary.find((score) => score.key === 'total-cost')?.score, 1.75);
  assert.deepEqual(
    experiment.results.map((result) => result.scores[0]?.passed),
    [true, true, false],
  );

  const custom = await evaluate((inputs: number) => ({ price: inputs * 10 }), dataset(), [], {
    cost: (output) => (output as { price: number }).price,
    summary: [totalCost()],
  });
  assert.equal(custom.summary[0]?.score, 60);
});

test('evaluate() honours its abort signal and never stores a partial experiment', async () => {
  const store = new MemoryExperimentStore();
  const already = new AbortController();
  already.abort(new Error('stopped before it started'));
  await assert.rejects(
    evaluate(() => 'x', dataset(), [], { signal: already.signal, store }),
    /stopped before it started/,
  );

  const controller = new AbortController();
  const seen: number[] = [];
  const signals: Array<AbortSignal | undefined> = [];
  await assert.rejects(
    evaluate(
      (inputs: number, context) => {
        seen.push(inputs);
        signals.push(context.signal);
        if (inputs === 1) controller.abort(new Error('cancelled mid-run'));
        return inputs;
      },
      dataset(),
      [],
      { signal: controller.signal, concurrency: 1, store },
    ),
    /cancelled mid-run/,
  );
  assert.deepEqual(seen, [1], 'no example starts after the signal fires');
  assert.equal(signals[0], controller.signal, 'targets receive the signal so they can stop too');
  assert.equal(store.list().length, 0);
});

test('evaluate() takes a per-example repetition count and rejects a count below one', async () => {
  const experiment = await evaluate((inputs: number) => inputs, dataset(), [], {
    repetitions: (example) => (example.id === 'b' ? 3 : 1),
  });
  assert.deepEqual(
    experiment.results.map((result) => `${result.exampleId}${result.run}`),
    ['a0', 'b0', 'b1', 'b2', 'c0'],
  );
  await assert.rejects(
    evaluate((inputs: number) => inputs, dataset(), [], { repetitions: () => 0 }),
    /at least once/,
  );
});

test('FileExperimentStore keeps experiments as files a CI job can cache and compare', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-experiments-'));
  try {
    const store = new FileExperimentStore(directory);
    const first = await evaluate((inputs: number) => inputs, dataset(), [], {
      name: 'baseline',
      store,
      now: () => new Date('2026-09-01T00:00:00Z'),
    });
    const second = await evaluate((inputs: number) => inputs, dataset(), [], {
      name: 'candidate',
      store,
      now: () => new Date('2026-09-02T00:00:00Z'),
    });

    assert.deepEqual(
      (await store.list()).map((experiment) => experiment.name),
      ['candidate', 'baseline'],
    );
    assert.equal((await store.get(first.id))?.name, 'baseline');
    assert.equal((await store.list({ name: 'baseline' })).length, 1);
    assert.equal((await readExperiment(path.join(directory, `${second.id}.json`)))?.id, second.id);
    assert.equal(await readExperiment(path.join(directory, 'missing.json')), undefined);
    assert.deepEqual(await new FileExperimentStore(path.join(directory, 'absent')).list(), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('EvalRunner keeps its result shape and adds an experiment that compareExperiments accepts', async () => {
  const answers: Record<string, string> = { refund: 'Choose refund on the order.', hours: 'We never close.' };
  const client = {
    async complete(request: { messages: Array<{ content: unknown }> }) {
      const question = String(request.messages[0]?.content);
      if (question === 'broken') throw new Error('provider down');
      return { content: answers[question] ?? '' };
    },
  };
  const cases = [
    { name: 'refund', request: { model: 'm', messages: [{ role: 'user' as const, content: 'refund' }] } },
    { name: 'hours', request: { model: 'm', messages: [{ role: 'user' as const, content: 'hours' }] } },
    { name: 'broken', request: { model: 'm', messages: [{ role: 'user' as const, content: 'broken' }] } },
    { name: 'no-check', request: { model: 'm', messages: [{ role: 'user' as const, content: 'refund' }] } },
  ].map((testCase) =>
    testCase.name === 'no-check'
      ? testCase
      : { ...testCase, assert: (response: { content: string }) => /refund|open/i.test(response.content) },
  );

  const runner = new EvalRunner<{ content: string }>(client as never);
  const baseline = await runner.run(cases, { name: 'baseline' });

  assert.equal(baseline.total, 4);
  assert.equal(baseline.passedCount, 1);
  assert.deepEqual(
    baseline.results.map((result) => [result.name, result.passed, result.error]),
    [
      ['refund', true, undefined],
      ['hours', false, undefined],
      ['broken', false, 'provider down'],
      ['no-check', false, 'Eval case "no-check" requires assert or judge'],
    ],
  );
  assert.equal(baseline.results[0]?.response?.content, 'Choose refund on the order.');
  assert.equal(baseline.results[3]?.response, undefined, 'a case that errors keeps no response, as before');
  assert.equal(baseline.experiment?.name, 'baseline');
  assert.equal(baseline.experiment?.errors, 1);

  answers.hours = 'We are open weekdays.';
  const candidate = await runner.run(cases, { name: 'candidate' });
  const comparison = compareExperiments(baseline.experiment as never, candidate.experiment as never);
  assert.equal(comparison.datasetMismatch, undefined, 'the same cases are the same dataset version');
  assert.equal(comparison.improvements[0]?.exampleId, 'hours');

  const empty = await runner.run([]);
  assert.deepEqual([empty.passed, empty.total, empty.experiment], [true, 0, undefined]);
});

test('EvalRunner gives duplicate case names distinct example ids', async () => {
  const runner = new EvalRunner({ complete: async () => 'ok' });
  const request = { model: 'm', messages: [{ role: 'user' as const, content: 'x' }] };
  const result = await runner.run([
    { name: 'same', request, assert: () => true },
    { name: 'same', request, assert: () => false },
  ]);
  assert.deepEqual(
    result.results.map((item) => item.passed),
    [true, false],
  );
  assert.deepEqual(
    result.experiment?.results.map((item) => item.exampleId),
    ['same', 'same#2'],
  );
});

test('MediaEvalRunner returns an experiment with per-case repetitions and comparable latency', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  let calls = 0;
  const target = async (): Promise<ImageResult> => {
    calls += 1;
    return {
      assets: [{ id: `a${calls}`, mimeType: 'image/png', location: { kind: 'bytes', data: png } }],
      meta: { latencyMs: 100 + calls, cost: 0.02, route: ['mock'] },
    } as unknown as ImageResult;
  };

  const report = await new MediaEvalRunner(target).evaluate(
    [
      { id: 'hero', operation: 'generate', request: { prompt: 'a' }, runs: 2 },
      {
        id: 'edit',
        operation: 'edit',
        request: {
          prompt: 'b',
          input: { location: { kind: 'bytes', data: Buffer.from(png) }, mimeType: 'image/png' },
        } as never,
        runs: 1,
      },
    ],
    { name: 'media-baseline' },
  );

  assert.equal(calls, 3);
  assert.equal(report.operational.runs, 3);
  assert.deepEqual(
    report.cases.map((item) => item.runs.length),
    [2, 1],
  );
  assert.equal(report.experiment?.name, 'media-baseline');
  assert.deepEqual(
    report.experiment?.results.map((result) => `${result.exampleId}${result.run}`),
    ['hero0', 'hero1', 'edit0'],
  );
  const keys = new Set(report.experiment?.results.flatMap((result) => result.scores.map((score) => score.key)));
  assert.ok(keys.has('latency') && keys.has('cost') && keys.has('passed'));
  assert.equal(report.experiment?.results[0]?.cost, 0.02, 'image cost flows into the experiment');
  assert.match(report.experiment?.dataset.version ?? '', /^v[0-9a-f]{12}$/);
});
