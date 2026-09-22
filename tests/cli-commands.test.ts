import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDataset } from '../src/evaluate/datasets.js';
import { evaluate } from '../src/evaluate/run.js';
import { JsonlTraceStore } from '../src/tracing/stores.js';
import type { Experiment } from '../src/types/evaluate.js';

/** Runs the CLI from source, so these tests do not depend on a build having happened first. */
function nexus(args: string[], cwd = process.cwd()) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', path.resolve('src/cli.ts'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-cli-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const examples = Array.from({ length: 20 }, (_, index) => ({ id: `q${index}`, inputs: index }));

/** An experiment where the listed examples fail and every other one passes. */
async function experiment(name: string, failing: readonly number[], count = examples.length): Promise<Experiment> {
  return evaluate(
    (inputs: number) => inputs,
    createDataset({ name: 'support', examples: examples.slice(0, count) }),
    [(context) => ({ key: 'correct', score: failing.includes(context.output as number) ? 0 : 1 })],
    { name },
  );
}

async function writeExperiment(directory: string, file: string, value: Experiment): Promise<string> {
  const target = path.join(directory, file);
  await writeFile(target, JSON.stringify(value), 'utf8');
  return target;
}

test('nexus eval gate fails a seeded regression and passes noise of the same kind', async () => {
  await withDirectory(async (directory) => {
    const baseline = await writeExperiment(directory, 'baseline.json', await experiment('baseline', [3]));
    const noise = await writeExperiment(directory, 'noise.json', await experiment('noise', [3, 11]));
    const regression = await writeExperiment(
      directory,
      'regression.json',
      await experiment('regression', [3, 4, 5, 6, 7, 8, 9, 10, 12]),
    );

    const passing = nexus(['eval', 'gate', baseline, noise]);
    assert.equal(passing.status, 0, passing.stderr);
    assert.match(passing.stdout, /PASS no regression beyond noise/);

    const failing = nexus(['eval', 'gate', baseline, regression]);
    assert.equal(failing.status, 1);
    assert.match(failing.stdout, /FAIL correct got worse/);
    assert.match(failing.stdout, /correct: 0\.950 → 0\.550/);

    const json = nexus(['eval', 'gate', baseline, regression, '--json']);
    const parsed = JSON.parse(json.stdout) as { passed: boolean; comparison: { metrics: Array<{ verdict: string }> } };
    assert.equal(parsed.passed, false);
    assert.equal(parsed.comparison.metrics[0]?.verdict, 'worse');

    const compared = nexus(['eval', 'compare', baseline, regression]);
    assert.equal(compared.status, 0, 'compare reports; only gate fails the build');
  });
});

test('nexus eval gate refuses a comparison across different datasets unless told to accept it', async () => {
  await withDirectory(async (directory) => {
    // Versions come from content: dropping one example is a different dataset, whatever its name.
    const baseline = await writeExperiment(directory, 'a.json', await experiment('a', []));
    const other = await writeExperiment(directory, 'b.json', await experiment('b', [], 19));
    const refused = nexus(['eval', 'gate', baseline, other]);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /different dataset versions/);
    assert.equal(nexus(['eval', 'gate', baseline, other, '--allow-dataset-mismatch']).status, 0);
  });
});

test('nexus eval run evaluates a module, writes the experiment, and can gate against a baseline', async () => {
  await withDirectory(async (directory) => {
    const module = path.join(directory, 'eval.mjs');
    await writeFile(
      module,
      `export const dataset = { name: 'arithmetic', examples: [
  { id: 'one', inputs: 1, expected: 2 },
  { id: 'two', inputs: 2, expected: 4 },
  { id: 'three', inputs: 3, expected: 6 },
] };
export const target = (inputs) => inputs * Number(process.env.FACTOR ?? 2);
export const evaluators = [(context) => ({ key: 'exact', score: context.output === context.example.expected ? 1 : 0, passed: context.output === context.example.expected })];
export const summary = [(results) => [{ key: 'runs', score: results.length }]];
`,
      'utf8',
    );

    const out = path.join(directory, 'baseline.json');
    const baseline = nexus(['eval', 'run', module, '--out', out, '--name', 'baseline']);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /baseline: 3 examples, 3 runs, 0 errors/);
    assert.match(baseline.stdout, /exact\s+1\s/);
    const written = JSON.parse(await readFile(out, 'utf8')) as Experiment;
    assert.equal(written.name, 'baseline');
    assert.equal(written.summary[0]?.score, 3);

    const broken = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        path.resolve('src/cli.ts'),
        'eval',
        'run',
        module,
        '--baseline',
        out,
        '--fail-on-regression',
        '--json',
      ],
      { encoding: 'utf8', env: { ...process.env, FACTOR: '3' } },
    );
    assert.equal(broken.status, 1, broken.stderr);
    const report = JSON.parse(broken.stdout) as { comparison: { regressed: boolean }; experiment: { runs: number } };
    assert.equal(report.comparison.regressed, true);
    assert.equal(report.experiment.runs, 3);

    const experiments = path.join(directory, 'experiments');
    assert.equal(nexus(['eval', 'run', module, '--experiments', experiments, '--repetitions', '2']).status, 0);
  });
});

test('nexus traces lists, shows, and exports runs from a trace store', async () => {
  await withDirectory(async (directory) => {
    const file = path.join(directory, 'runs.jsonl');
    const store = new JsonlTraceStore({ file });
    await store.save({
      id: 'root',
      traceId: 't1',
      name: 'support-agent',
      kind: 'agent',
      status: 'error',
      startedAt: '2026-09-21T10:00:00.000Z',
      latencyMs: 1200,
      cost: 0.004,
    });
    await store.save({
      id: 'call',
      traceId: 't1',
      parentId: 'root',
      name: 'openai',
      kind: 'model',
      status: 'ok',
      startedAt: '2026-09-21T10:00:00.100Z',
      latencyMs: 900,
      model: 'gpt-5',
    });
    await store.save({
      id: 'other',
      traceId: 't2',
      name: 'batch',
      kind: 'chain',
      status: 'ok',
      startedAt: '2026-09-20T10:00:00.000Z',
    });

    const listed = nexus(['traces', 'list', '--store', file, '--status', 'error']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /support-agent/);
    assert.doesNotMatch(listed.stdout, /batch/);

    const json = JSON.parse(
      nexus(['traces', 'list', '--store', file, '--kind', 'model,agent', '--json']).stdout,
    ) as Array<{ id: string }>;
    assert.deepEqual(
      json.map((run) => run.id),
      ['call', 'root'],
    );

    const shown = nexus(['traces', 'show', 't1', '--store', file]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.match(shown.stdout, /support-agent[\s\S]*openai/);

    const exported = path.join(directory, 'export.jsonl');
    const exportRun = nexus([
      'traces',
      'export',
      '--store',
      file,
      '--since',
      '2026-09-21T00:00:00.000Z',
      '--out',
      exported,
    ]);
    assert.match(exportRun.stdout, /Wrote 2 runs/);
    assert.equal((await readFile(exported, 'utf8')).trim().split('\n').length, 2);

    const moduleStore = path.join(directory, 'store.mjs');
    await writeFile(
      moduleStore,
      `export const store = { async query() { return [{ id: 'm', traceId: 'tm', name: 'from-module', kind: 'chain', status: 'ok', startedAt: '2026-09-21T00:00:00.000Z' }]; }, async tree() { return undefined; } };\n`,
      'utf8',
    );
    assert.match(nexus(['traces', 'list', '--store', moduleStore]).stdout, /from-module/);
    assert.equal(nexus(['traces', 'show', 'missing', '--store', moduleStore]).status, 2);
  });
});

test('nexus db sql prints the schema for the chosen adapters and refuses unknown ones', () => {
  const traces = nexus(['db', 'sql', '--adapters', 'traces']);
  assert.equal(traces.status, 0, traces.stderr);
  assert.match(traces.stdout, /CREATE TABLE IF NOT EXISTS "nexus_runs"/);
  assert.doesNotMatch(traces.stdout, /nexus_operations/);

  assert.match(nexus(['db', 'sql', '--vector-dimensions', '1536']).stdout, /vector\(1536\)/);
  const refused = nexus(['db', 'sql', '--adapters', 'sessions']);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /Unknown adapter sessions/);
});

test('the original nexus eval command still runs case files, now on evaluate()', async () => {
  await withDirectory(async (directory) => {
    const module = path.join(directory, 'cases.mjs');
    await writeFile(
      module,
      `export const client = { async complete(request) { return { content: 'echo ' + request.messages[0].content }; } };
export const cases = [
  { name: 'echoes', request: { model: 'm', messages: [{ role: 'user', content: 'hello' }] }, expected: 'echo hello' },
  { name: 'wrong', request: { model: 'm', messages: [{ role: 'user', content: 'bye' }] }, expected: 'nope' },
];
`,
      'utf8',
    );
    const result = nexus(['eval', module]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Eval failed: 1\/2 passed/);
    assert.match(result.stdout, /PASS echoes/);
    assert.match(result.stdout, /FAIL wrong/);
    assert.match(nexus(['help']).stdout, /nexus eval gate/);
  });
});
