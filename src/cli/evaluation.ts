import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { compareExperiments, type ExperimentComparison, formatComparison } from '../evaluate/compare.js';
import { createDataset, FileExperimentStore, readExperiment } from '../evaluate/datasets.js';
import { type EvaluateOptions, type EvaluationTarget, evaluate } from '../evaluate/run.js';
import type { Dataset, DatasetExample, Evaluator, Experiment, SummaryEvaluator } from '../types/evaluate.js';
import {
  CliUsageError,
  flagBool,
  isRecord,
  listFlag,
  loadModule,
  numberFlag,
  type ParsedArgs,
  printTable,
  stringFlag,
  writeJson,
} from './args.js';

/**
 * `nexus eval run | compare | gate`.
 *
 * A quality gate in CI without a bespoke script: run an evaluation module to an experiment file,
 * compare it with a baseline, and fail the build only when the difference is real.
 */
export async function runEvaluationCommand(subcommand: string, args: ParsedArgs): Promise<void> {
  if (subcommand === 'run') return run(args);
  if (subcommand === 'compare') return compare(args, false);
  if (subcommand === 'gate') return compare(args, true);
  throw new CliUsageError(`Unknown eval command "${subcommand}". Use run, compare, or gate.`);
}

/**
 * Runs an evaluation module: `export { target, dataset, evaluators, summary?, options? }`.
 *
 * `dataset` may be a dataset from `createDataset()` or a plain `{ name, examples }`, versioned here.
 */
async function run({ positionals, flags }: ParsedArgs): Promise<void> {
  const file = positionals[0];
  if (!file) throw new CliUsageError('nexus eval run needs an evaluation module, such as eval.mjs.');
  const loaded = await loadModule(file);

  const target = loaded.target;
  if (typeof target !== 'function') throw new CliUsageError(`${file} must export a \`target\` function.`);
  const dataset = toDataset(loaded.dataset, file);
  const evaluators = (loaded.evaluators ?? []) as Evaluator[];
  if (!Array.isArray(evaluators)) throw new CliUsageError(`${file}: \`evaluators\` must be an array.`);

  const moduleOptions = isRecord(loaded.options) ? (loaded.options as EvaluateOptions) : {};
  const experimentsDirectory = stringFlag(flags, 'experiments');
  const options: EvaluateOptions = {
    ...moduleOptions,
    ...(Array.isArray(loaded.summary) ? { summary: loaded.summary as SummaryEvaluator[] } : {}),
    ...(stringFlag(flags, 'name') ? { name: stringFlag(flags, 'name') } : {}),
    ...(numberFlag(flags, 'concurrency') === undefined ? {} : { concurrency: numberFlag(flags, 'concurrency') }),
    ...(numberFlag(flags, 'repetitions') === undefined ? {} : { repetitions: numberFlag(flags, 'repetitions') }),
    ...(numberFlag(flags, 'timeout-ms') === undefined ? {} : { timeoutMs: numberFlag(flags, 'timeout-ms') }),
    ...(experimentsDirectory ? { store: new FileExperimentStore(experimentsDirectory) } : {}),
  };

  const experiment = await evaluate(target as EvaluationTarget, dataset, evaluators, options);
  const out = stringFlag(flags, 'out');
  if (out) await writeFile(path.resolve(out), `${JSON.stringify(experiment, null, 2)}\n`, 'utf8');

  const baselineFile = stringFlag(flags, 'baseline');
  const comparison = baselineFile
    ? compareExperiments(await requireExperiment(baselineFile), experiment, compareOptions(flags))
    : undefined;
  const failed =
    comparison !== undefined && flagBool(flags, 'fail-on-regression') && gateFailures(comparison, flags).length > 0;

  if (flagBool(flags, 'json')) {
    writeJson({ experiment: summaryOf(experiment), ...(comparison ? { comparison } : {}), ...(out ? { out } : {}) });
  } else {
    printExperiment(experiment);
    if (out) console.log(`Wrote ${out}`);
    if (comparison) {
      console.log('');
      console.log(formatComparison(comparison));
    }
    if (failed) console.log(`\nFAIL ${gateFailures(comparison as ExperimentComparison, flags).join('; ')}`);
  }
  if (failed) process.exitCode = 1;
}

async function compare({ positionals, flags }: ParsedArgs, gate: boolean): Promise<void> {
  const [baselineFile, candidateFile] = positionals;
  if (!baselineFile || !candidateFile) {
    throw new CliUsageError(
      `nexus eval ${gate ? 'gate' : 'compare'} needs a baseline and a candidate experiment file.`,
    );
  }
  const comparison = compareExperiments(
    await requireExperiment(baselineFile),
    await requireExperiment(candidateFile),
    compareOptions(flags),
  );
  const failures = gate ? gateFailures(comparison, flags) : [];

  if (flagBool(flags, 'json')) {
    writeJson(gate ? { passed: failures.length === 0, failures, comparison } : comparison);
  } else {
    console.log(formatComparison(comparison));
    if (gate) console.log(failures.length ? `\nFAIL ${failures.join('; ')}` : '\nPASS no regression beyond noise');
  }
  if (failures.length > 0) process.exitCode = 1;
}

/** Why a gate fails: a metric worse beyond noise, a new failure, or a comparison across datasets. */
function gateFailures(comparison: ExperimentComparison, flags: ParsedArgs['flags']): string[] {
  const reasons = comparison.metrics
    .filter((metric) => metric.verdict === 'worse')
    .map((metric) => `${metric.key} got worse`);
  if (comparison.newErrors.length > 0) reasons.push(`new failures: ${comparison.newErrors.join(', ')}`);
  if (comparison.datasetMismatch && !flagBool(flags, 'allow-dataset-mismatch')) {
    reasons.push('the experiments ran over different dataset versions (pass --allow-dataset-mismatch to accept that)');
  }
  return reasons;
}

function compareOptions(flags: ParsedArgs['flags']) {
  return {
    ...(listFlag(flags, 'lower-is-better') ? { lowerIsBetter: listFlag(flags, 'lower-is-better') } : {}),
    ...(numberFlag(flags, 'resamples') === undefined ? {} : { resamples: numberFlag(flags, 'resamples') }),
    ...(numberFlag(flags, 'seed') === undefined ? {} : { seed: numberFlag(flags, 'seed') }),
  };
}

async function requireExperiment(file: string): Promise<Experiment> {
  const experiment = await readExperiment(path.resolve(file));
  if (!experiment) throw new CliUsageError(`${file} is not an experiment file. Write one with nexus eval run --out.`);
  return experiment;
}

function toDataset(value: unknown, file: string): Dataset {
  if (!isRecord(value) || typeof value.name !== 'string' || !Array.isArray(value.examples)) {
    throw new CliUsageError(`${file} must export a \`dataset\` with a name and examples.`);
  }
  if (typeof value.version === 'string') return value as unknown as Dataset;
  return createDataset({ name: value.name, examples: value.examples as Array<Omit<DatasetExample, 'id'>> });
}

function summaryOf(experiment: Experiment) {
  return {
    id: experiment.id,
    name: experiment.name,
    dataset: experiment.dataset,
    examples: new Set(experiment.results.map((result) => result.exampleId)).size,
    runs: experiment.results.length,
    errors: experiment.errors,
    metrics: experiment.metrics,
    summary: experiment.summary,
  };
}

function printExperiment(experiment: Experiment): void {
  const summary = summaryOf(experiment);
  console.log(
    `${experiment.name}: ${summary.examples} examples, ${summary.runs} runs, ${summary.errors} errors (dataset ${experiment.dataset.name} ${experiment.dataset.version})`,
  );
  printTable(
    experiment.metrics.map((metric) => ({
      metric: metric.key,
      mean: round(metric.mean),
      '95% CI': `${round(metric.ci95[0])}..${round(metric.ci95[1])}`,
      'pass rate': metric.passRate === undefined ? '' : `${Math.round(metric.passRate * 100)}%`,
      n: String(metric.n),
    })),
    ['metric', 'mean', '95% CI', 'pass rate', 'n'],
  );
  for (const score of experiment.summary) console.log(`${score.key}: ${round(score.score)}`);
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}
