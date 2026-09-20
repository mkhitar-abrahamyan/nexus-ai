import { randomBytes } from 'node:crypto';
import type {
  Dataset,
  DatasetExample,
  EvaluationContext,
  EvaluationScore,
  Evaluator,
  ExampleResult,
  Experiment,
  ExperimentStore,
  MetricSummary,
  SummaryEvaluator,
} from '../types/evaluate.js';

/** Turns one example into an output. A completion, an agent run, a graph, or plain code. */
export type EvaluationTarget<I = unknown> = (
  inputs: I,
  context: { example: DatasetExample<I>; run: number },
) => Promise<unknown> | unknown;

export interface EvaluateOptions {
  /** Names the experiment. Defaults to the dataset name plus a timestamp. */
  name?: string;
  /** Examples evaluated at once. Defaults to 4; `1` runs them in order. */
  concurrency?: number;
  /** Times each example is run. Above 1 for a target that is not deterministic. */
  repetitions?: number;
  summary?: SummaryEvaluator[];
  store?: ExperimentStore;
  metadata?: Record<string, unknown>;
  /** Stops an example that hangs. */
  timeoutMs?: number;
  signal?: AbortSignal;
  onResult?: (result: ExampleResult) => void;
  now?: () => Date;
}

/**
 * Runs a target over a dataset and scores it.
 *
 * One entry point for every kind of target, because the question is always the same: for each
 * example, produce an output, score it, and keep the result somewhere a later run can be compared
 * against. Everything that differs — how an output is produced, what counts as good — is a function
 * the caller supplies.
 */
export async function evaluate<I = unknown, O = unknown>(
  target: EvaluationTarget<I>,
  dataset: Dataset<I, O>,
  evaluators: Array<Evaluator<I, O>>,
  options: EvaluateOptions = {},
): Promise<Experiment> {
  if (dataset.examples.length === 0) throw new RangeError(`Dataset "${dataset.name}" has no examples`);

  const now = options.now ?? (() => new Date());
  const repetitions = Math.max(1, options.repetitions ?? 1);
  const startedAt = now().toISOString();
  const results: ExampleResult[] = [];

  const jobs = dataset.examples.flatMap((example) =>
    Array.from({ length: repetitions }, (_, run) => ({ example, run })),
  );

  await runConcurrently(jobs, options.concurrency ?? 4, async ({ example, run }) => {
    const result = await evaluateOne(target, example, run, evaluators, options);
    results.push(result);
    options.onResult?.(result);
  });

  // Ordered by example, then repetition, so two experiments over one dataset line up row by row.
  const order = new Map(dataset.examples.map((example, index) => [example.id, index]));
  results.sort((a, b) => (order.get(a.exampleId) ?? 0) - (order.get(b.exampleId) ?? 0) || a.run - b.run);

  const summary: EvaluationScore[] = [];
  for (const evaluator of options.summary ?? []) summary.push(...(await evaluator(results)));

  const experiment: Experiment = {
    id: `exp-${randomBytes(6).toString('hex')}`,
    name: options.name ?? `${dataset.name} ${startedAt}`,
    dataset: { name: dataset.name, version: dataset.version },
    startedAt,
    finishedAt: now().toISOString(),
    errors: results.filter((result) => result.error).length,
    results,
    metrics: summarize(results),
    summary,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };

  await options.store?.save(experiment);
  return experiment;
}

async function evaluateOne<I, O>(
  target: EvaluationTarget<I>,
  example: DatasetExample<I, O>,
  run: number,
  evaluators: Array<Evaluator<I, O>>,
  options: EvaluateOptions,
): Promise<ExampleResult> {
  const started = Date.now();
  let output: unknown;
  let error: { name: string; message: string } | undefined;

  try {
    const call = Promise.resolve(target(example.inputs, { example, run }));
    output = options.timeoutMs === undefined ? await call : await withTimeout(call, options.timeoutMs, example.id);
  } catch (caught) {
    error =
      caught instanceof Error
        ? { name: caught.name, message: caught.message }
        : { name: 'Error', message: String(caught) };
  }

  const context: EvaluationContext<I, O> = {
    example,
    output,
    ...(error ? { error } : {}),
    latencyMs: Date.now() - started,
    run,
  };

  const scores: EvaluationScore[] = [];
  for (const evaluator of evaluators) {
    try {
      scores.push(...normalizeScores(await evaluator(context), evaluator as Evaluator));
    } catch (caught) {
      // An evaluator that throws is a failed measurement, not a failed example: record it and move
      // on, so one broken scorer cannot void a whole experiment.
      scores.push({
        key: 'evaluator-error',
        score: 0,
        passed: false,
        comment: caught instanceof Error ? caught.message : String(caught),
      });
    }
  }

  return {
    exampleId: example.id,
    run,
    ...(output === undefined ? {} : { output }),
    ...(error ? { error } : {}),
    latencyMs: context.latencyMs,
    scores,
  };
}

function normalizeScores(value: Awaited<ReturnType<Evaluator>>, evaluator: Evaluator): EvaluationScore[] {
  if (typeof value === 'number') return [{ key: nameOf(evaluator), score: value }];
  if (typeof value === 'boolean') return [{ key: nameOf(evaluator), score: value ? 1 : 0, passed: value }];
  return Array.isArray(value) ? value : [value];
}

function nameOf(evaluator: Evaluator): string {
  return evaluator.name && evaluator.name !== 'anonymous' ? evaluator.name : 'score';
}

/** Mean, spread, and an interval per metric, so one lucky run is not mistaken for an improvement. */
export function summarize(results: ExampleResult[]): MetricSummary[] {
  const byKey = new Map<string, EvaluationScore[]>();
  for (const result of results) {
    for (const score of result.scores) byKey.set(score.key, [...(byKey.get(score.key) ?? []), score]);
  }

  return [...byKey.entries()].map(([key, scores]) => {
    const values = scores.map((score) => score.score);
    const judged = scores.filter((score) => score.passed !== undefined);
    return {
      key,
      ...stats(values),
      ...(judged.length > 0 ? { passRate: judged.filter((score) => score.passed).length / judged.length } : {}),
    };
  });
}

export function stats(values: number[]): Omit<MetricSummary, 'key' | 'passRate'> {
  const n = values.length;
  const mean = n === 0 ? 0 : values.reduce((total, value) => total + value, 0) / n;
  const variance = n > 1 ? values.reduce((total, value) => total + (value - mean) ** 2, 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  const margin = n > 1 ? (1.96 * stddev) / Math.sqrt(n) : 0;
  return {
    n,
    mean,
    stddev,
    min: n === 0 ? 0 : Math.min(...values),
    max: n === 0 ? 0 : Math.max(...values),
    ci95: [mean - margin, mean + margin],
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, exampleId: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Example "${exampleId}" exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runConcurrently<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const bound = Math.max(1, Math.min(Math.floor(limit), items.length));
  if (bound === 1) {
    for (const item of items) await worker(item);
    return;
  }
  let cursor = 0;
  await Promise.all(
    Array.from({ length: bound }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        await worker(items[index] as T);
      }
    }),
  );
}
