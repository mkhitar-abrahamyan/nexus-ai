/**
 * Deployment statistics: a canary judged as an evaluation comparison judges a score, with a minimum
 * run count, a confidence level, and a minimum effect size, and with quality from online evaluation
 * beside errors, latency, and cost.
 *
 * The proof: a canary seeded with a quality regression is rolled back, and one whose difference is
 * noise under the minimum effect is not.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareRuns, type RunSample } from '../src/insights/regressions.js';
import { functionAssistant } from '../src/server/assistant.js';
import { Deployments, watchCanaries } from '../src/server/deployments.js';
import { createAgentServer } from '../src/server/server.js';
import { MemoryServerStore, RUNS_NAMESPACE } from '../src/server/state.js';
import type { RunRecord, ServerAssistant } from '../src/types/server.js';

/** Runs whose `count` entries fail `failures` times in a fixed, evenly spread pattern. */
function runs(count: number, failures: number, latency: (index: number) => number = () => 100): RunSample[] {
  return Array.from({ length: count }, (_, index) => ({
    status: Math.floor(((index + 1) * failures) / count) > Math.floor((index * failures) / count) ? 'error' : 'success',
    latencyMs: latency(index),
    cost: 0.01,
  }));
}
const scored = (count: number, score: (index: number) => number): RunSample[] =>
  Array.from({ length: count }, (_, index) => ({
    status: 'success',
    feedback: [{ key: 'quality', score: score(index) }],
  }));

test('a run counts once per feedback key, so one caller rating one run many times moves nothing', () => {
  const good = scored(40, () => 0.9);
  // One run on the canary rated 0 a hundred times, beside runs as good as the baseline.
  const flooded: RunSample[] = [
    { status: 'success', feedback: Array.from({ length: 100 }, () => ({ key: 'quality', score: 0 })) },
    ...scored(39, () => 0.9),
  ];
  for (const options of [{}, { confidence: 0.95 }]) {
    assert.deepEqual(compareRuns(good, flooded, { feedback: ['quality'], ...options }), [], JSON.stringify(options));
  }
  // Nor can a hundred ratings of one run meet the minimum sample by themselves.
  const alone: RunSample[] = [
    { status: 'success', feedback: Array.from({ length: 100 }, () => ({ key: 'quality', score: 0 })) },
  ];
  assert.deepEqual(compareRuns(good, alone, { feedback: ['quality'] }), []);
  // A run rated by several people counts as the mean of their scores.
  const mixed: RunSample[] = Array.from({ length: 40 }, () => ({
    status: 'success',
    feedback: [
      { key: 'quality', score: 0.2 },
      { key: 'quality', score: 0.4 },
    ],
  }));
  const [fell] = compareRuns(good, mixed, { feedback: ['quality'] });
  assert.match(fell?.summary ?? '', /fell from 0.90 to 0.30/);
});

test('under a confidence level, a metric regresses only past both its interval and its minimum effect', () => {
  const judged = { confidence: 0.95, metrics: ['error-rate', 'latency', 'cost'] as const };

  // A real rise in errors: 2% to 12% over 200 runs each.
  const [errors] = compareRuns(runs(200, 4), runs(200, 24), judged);
  assert.equal(errors?.metric, 'error-rate');
  assert.ok((errors?.interval?.[0] ?? 0) > 0, 'the interval is above zero');
  assert.match(errors?.summary ?? '', /error rate rose from 2\.0% to 12\.0% \(95% interval 0\.\d+ to 0\.\d+\)/);

  // Noise: 5% against 6% is inside the interval and under the minimum effect.
  assert.deepEqual(compareRuns(runs(200, 10), runs(200, 12), judged), []);
  // Certain but trivial: 20,000 runs each make 1.0% against 1.5% significant, yet it is under 2 points.
  assert.deepEqual(compareRuns(runs(20_000, 200), runs(20_000, 300), judged), []);
  assert.equal(compareRuns(runs(20_000, 200), runs(20_000, 300), { ...judged, minErrorRateIncrease: 0.004 }).length, 1);

  // Latency: a clear 40% rise in p95 counts; the same distribution shuffled does not.
  const steady = (index: number) => 100 + (index % 10) * 5;
  const slower = (index: number) => 140 + (index % 10) * 7;
  const latency = compareRuns(runs(200, 0, steady), runs(200, 0, slower), { ...judged, minLatencyChangeMs: 20 });
  assert.deepEqual(
    latency.map((item) => item.metric),
    ['latency-p95'],
  );
  assert.match(latency[0]?.summary ?? '', /interval \+\d+% to \+\d+%/);
  assert.deepEqual(
    compareRuns(
      runs(200, 0, steady),
      runs(200, 0, (index) => steady(199 - index)),
      judged,
    ),
    [],
  );
  assert.deepEqual(
    compareRuns(runs(200, 0, steady), runs(200, 0, slower), { ...judged, minLatencyChangeMs: 1_000 }),
    [],
    'a confident rise of a few tens of milliseconds is under the absolute minimum',
  );

  // Cost.
  const pricier = runs(100, 0).map((run) => ({ ...run, cost: 0.02 }));
  assert.deepEqual(
    compareRuns(runs(100, 0), pricier, judged).map((item) => item.metric),
    ['cost'],
  );

  // Quality, from feedback: a fall past the minimum counts, a small one does not.
  const good = scored(80, (index) => 0.85 + (index % 5) * 0.03);
  const worse = scored(80, (index) => 0.55 + (index % 5) * 0.03);
  const slightlyWorse = scored(80, (index) => 0.83 + (index % 5) * 0.03);
  const quality = compareRuns(good, worse, { ...judged, metrics: [], feedback: ['quality'] });
  assert.equal(quality[0]?.metric, 'feedback:quality');
  assert.ok((quality[0]?.interval?.[1] ?? 0) < 0);
  assert.deepEqual(compareRuns(good, slightlyWorse, { ...judged, metrics: [], feedback: ['quality'] }), []);

  // Too few runs are never judged, and the same seed always gives the same interval.
  assert.deepEqual(compareRuns(runs(10, 0), runs(10, 9), judged), []);
  const first = compareRuns(runs(200, 4), runs(200, 24), judged)[0]?.interval;
  assert.deepEqual(compareRuns(runs(200, 4), runs(200, 24), judged)[0]?.interval, first);
  assert.notDeepEqual(compareRuns(runs(200, 4), runs(200, 24), { ...judged, seed: 7 })[0]?.interval, undefined);
  assert.throws(() => compareRuns(runs(20, 0), runs(20, 0), { confidence: 1.5 }), /between 0 and 1/);
});

/**
 * An assistant that gives a bad answer once in every `badEvery` of its own calls. Counting its own
 * calls, not the request index, makes each revision's quality exact whichever threads the split
 * sends it, so the verdict never depends on which runs landed where.
 */
function answering(name: string, badEvery: number): ServerAssistant {
  let calls = 0;
  return functionAssistant((input) => {
    calls += 1;
    return { answer: `${name}:${(input as { index: number }).index}`, good: calls % badEvery !== 0 };
  });
}

async function serve(canary: ServerAssistant) {
  const state = new MemoryServerStore();
  const deployments = new Deployments({ state });
  const app = createAgentServer({
    assistants: {
      support: deployments.assistant('support', { stable: answering('stable', 20), canary }, { live: 'stable' }),
    },
    state,
  });
  await deployments.canary('support', 'canary', 0.5);
  for (let index = 0; index < 300; index += 1) {
    await app
      .handle(
        new Request('http://server.test/threads', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assistant: 'support' }),
        }),
      )
      .then(async (response) => {
        const thread = (await response.json()) as { id: string };
        await app.handle(
          new Request(`http://server.test/threads/${thread.id}/runs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ input: { index } }),
          }),
        );
      });
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const all = state.list<RunRecord>(RUNS_NAMESPACE, { limit: 10_000 });
    if (all.length >= 300 && all.every((run) => run.status === 'succeeded')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Online evaluation scores every finished run, and records the score on it.
  const quality = ({ output }: { output: unknown }) => ({
    key: 'quality',
    score: (output as { good: boolean }).good ? 1 : 0,
  });
  const report = await deployments.evaluate('support', { evaluators: [quality] });
  return { app, state, deployments, report };
}

test('a canary seeded with a quality regression is rolled back, and one within the noise is not', async () => {
  // Seeded: the canary's answers are bad one time in three, the live revision's one in twenty.
  const regressed = await serve(answering('canary', 3));
  assert.equal(regressed.report.evaluated, 300);
  assert.equal(
    (await regressed.deployments.evaluate('support', { evaluators: [] })).skipped,
    300,
    'a run is scored once',
  );
  const guard = watchCanaries({
    deployments: regressed.deployments,
    minRuns: 50,
    confidence: 0.95,
    feedback: ['quality'],
  });
  const [decision] = await guard.check();
  guard.stop();
  assert.equal(decision?.action, 'rollback');
  assert.equal(decision?.regressions[0]?.metric, 'feedback:quality');
  assert.ok((decision?.samples.canary ?? 0) >= 50 && (decision?.samples.live ?? 0) >= 50);
  const deployment = await regressed.deployments.get('support');
  assert.deepEqual(deployment?.traffic, { stable: 1 });
  assert.match(
    deployment?.history[0]?.reason ?? '',
    /quality fell from 0\.9\d to 0\.6\d \(95% interval -0\.\d+ to -0\.\d+\)/,
  );

  // Noise: one bad answer in eighteen against one in twenty is under the five-point minimum effect.
  const noisy = await serve(answering('canary', 18));
  const patient = watchCanaries({
    deployments: noisy.deployments,
    minRuns: 50,
    confidence: 0.95,
    feedback: ['quality'],
  });
  const [held] = await patient.check();
  patient.stop();
  assert.equal(held?.action, 'hold');
  assert.deepEqual(held?.regressions, []);
  assert.equal((await noisy.deployments.get('support'))?.traffic.canary, 0.5, 'the canary keeps its share');

  // Feedback a person leaves through the API lands on the run beside the evaluator's.
  const [run] = noisy.state.list<RunRecord>(RUNS_NAMESPACE, { limit: 1 });
  const response = await noisy.app.handle(
    new Request(`http://server.test/runs/${run?.id}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'helpful', score: 1, comment: 'great' }),
    }),
  );
  assert.equal(response.status, 201);
  const stored = noisy.state.get<RunRecord>(RUNS_NAMESPACE, run?.id as string);
  assert.deepEqual(
    stored?.feedback?.map((item) => [item.key, item.source]),
    [
      ['quality', 'online-evaluation'],
      ['helpful', 'api'],
    ],
  );
  const refused = await noisy.app.handle(
    new Request(`http://server.test/runs/${run?.id}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'helpful', score: 'great' }),
    }),
  );
  assert.equal(refused.status, 400);
  // Sampling is stable by run id: half the runs, the same half every time.
  const sampled = await noisy.deployments.evaluate('support', {
    evaluators: [() => 1],
    source: 'sampler',
    sampleRate: 0.5,
  });
  const again = await noisy.deployments.evaluate('support', {
    evaluators: [() => 1],
    source: 'sampler',
    sampleRate: 0.5,
  });
  assert.ok(sampled.evaluated > 100 && sampled.evaluated < 200);
  assert.equal(again.evaluated, 0);
  assert.equal(again.skipped, sampled.evaluated);
});
