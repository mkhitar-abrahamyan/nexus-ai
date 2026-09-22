import type { Dataset, DatasetExample, EvaluationScore, Experiment, ExperimentStore } from '../types/evaluate.js';
import type { CompletionRequest } from '../types/messages.js';
import type { EvalMetrics, MetricInputs } from './metrics.js';
import { calculateEvalMetrics } from './metrics.js';

/**
 * The one method `EvalRunner` needs from a client. A `NexusAI` client fits, and so does a test
 * double.
 */
export interface EvalClient<Response = unknown> {
  /** Runs one completion. */
  complete(request: CompletionRequest): Promise<Response>;
}

/** A judge's verdict on one response. */
export interface EvalJudgment {
  /** Score from 0 to 1. */
  score: number;
  /** Whether the response passed. */
  passed: boolean;
  /** Why the judge decided as it did. */
  rationale?: string;
  /** Labels the judge applied. */
  labels?: string[];
  /** The judge's raw output. */
  raw?: unknown;
  /** Provider the judge ran on. */
  providerUsed?: string;
  /** Model the judge ran on. */
  modelUsed?: string;
}

/**
 * Judges a response: `true`/`false`, or a full judgment with a score and rationale. The LLM judge
 * from `nexus-ai-pro/evals/judge` produces one.
 */
export type EvalJudge<Response = unknown> = (
  response: Response,
  testCase: EvalCase<Response>,
) => boolean | EvalJudgment | Promise<boolean | EvalJudgment>;

/** One completion case: a request and how its response is checked. */
export interface EvalCase<Response = unknown> {
  /** Names the case in reports. Duplicate names get a numbered suffix in the experiment. */
  name: string;
  /** The request to send. */
  request: CompletionRequest;
  /** Checks the response in code. */
  assert?: (response: Response) => boolean | Promise<boolean>;
  /** Judges the response, typically with a model. */
  judge?: EvalJudge<Response>;
  /** The expected answer, available to the judge and to metrics. */
  expected?: string;
  /** Computes metric inputs from the response, for `calculateEvalMetrics`. */
  metrics?: (response: Response) => MetricInputs | Promise<MetricInputs>;
  /** Labels for filtering. */
  tags?: string[];
}

/** The outcome of one case. */
export interface EvalResult<Response = unknown> {
  /** The case's name. */
  name: string;
  /** True when the assertion and the judge both passed. */
  passed: boolean;
  /** Time from the request to the last check, in milliseconds. */
  durationMs: number;
  /** The response, when the case did not error. */
  response?: Response;
  /** Metrics computed from the response. */
  metrics?: EvalMetrics;
  /** The judge's verdict. */
  judgment?: EvalJudgment;
  /**
   * Why the case failed to run: the provider failed, a check threw, or it had neither `assert` nor
   * `judge`.
   */
  error?: string;
  /** The case's tags. */
  tags?: string[];
}

/** The outcome of a run of cases. */
export interface EvalRunResult<Response = unknown> {
  /** True when every case passed. */
  passed: boolean;
  /** Cases run. */
  total: number;
  /** Cases that passed. */
  passedCount: number;
  /** Cases that failed. */
  failedCount: number;
  /** Total duration in milliseconds. */
  durationMs: number;
  /** Every case's outcome, in order. */
  results: EvalResult<Response>[];
  /**
   * The same run as an experiment, so it can be stored, compared with `compareExperiments()`, and
   * gated in CI like any other evaluation. Absent only for a run with no cases.
   */
  experiment?: Experiment;
}

/** Options for one run. */
export interface EvalRunOptions {
  /** Names the experiment. Defaults to `eval-runner` plus a timestamp. */
  name?: string;
  /** Cases run at once. Defaults to 1, which keeps them in order. */
  concurrency?: number;
  /** Stores the experiment, for a later comparison. */
  store?: ExperimentStore;
  /** Application data recorded on the experiment. */
  metadata?: Record<string, unknown>;
}

/**
 * Runs completion cases and checks each response.
 *
 * Built on `evaluate()`: cases become a dataset, the client is the target, and the assertion, judge,
 * and metrics become one evaluator. The result keeps the shape this runner has always returned and
 * adds the experiment underneath it.
 */
export class EvalRunner<Response = unknown> {
  constructor(private client: EvalClient<Response>) {}

  /**
   * Runs the cases, in order by default, and returns the results with the experiment underneath.
   */
  async run(cases: EvalCase<Response>[], options: EvalRunOptions = {}): Promise<EvalRunResult<Response>> {
    const started = Date.now();
    if (cases.length === 0) {
      return { passed: true, total: 0, passedCount: 0, failedCount: 0, durationMs: 0, results: [] };
    }
    // Loaded on first use, so importing the runner — and the root, which exports it — costs nothing extra.
    const [{ evaluate }, { contentVersion }] = await Promise.all([
      import('../evaluate/run.js'),
      import('../evaluate/version.js'),
    ]);
    const ids = uniqueIds(cases.map((testCase) => testCase.name));
    const caseStarted = new Map<string, number>();
    const outcomes = new Map<string, EvalResult<Response>>();

    const examples: Array<DatasetExample<EvalCase<Response>>> = cases.map((testCase, index) => ({
      id: ids[index] as string,
      inputs: testCase,
      ...(testCase.expected === undefined ? {} : { expected: testCase.expected }),
      ...(testCase.tags ? { tags: testCase.tags } : {}),
    }));
    const dataset: Dataset<EvalCase<Response>> = {
      name: 'eval-runner',
      version: contentVersion(examples as DatasetExample[]),
      examples,
      createdAt: new Date(started).toISOString(),
    };

    const experiment = await evaluate<EvalCase<Response>>(
      (testCase, { example }) => {
        caseStarted.set(example.id, Date.now());
        return this.client.complete(testCase.request);
      },
      dataset,
      [
        async (context): Promise<EvaluationScore[]> => {
          const testCase = context.example.inputs;
          const began = caseStarted.get(context.example.id) ?? started;
          const failed = (message: string): EvaluationScore[] => {
            outcomes.set(context.example.id, {
              name: testCase.name,
              passed: false,
              durationMs: Date.now() - began,
              error: message,
              tags: testCase.tags,
            });
            return [{ key: 'passed', score: 0, passed: false, comment: message }];
          };

          if (context.error) return failed(context.error.message);
          const response = context.output as Response;
          try {
            if (!testCase.assert && !testCase.judge) {
              throw new Error(`Eval case "${testCase.name}" requires assert or judge`);
            }
            const assertPassed = testCase.assert ? await testCase.assert(response) : true;
            const judgment = testCase.judge ? normalizeJudgment(await testCase.judge(response, testCase)) : undefined;
            const passed = assertPassed && (judgment?.passed ?? true);
            const metrics = testCase.metrics ? await calculateEvalMetrics(await testCase.metrics(response)) : undefined;
            outcomes.set(context.example.id, {
              name: testCase.name,
              passed,
              durationMs: Date.now() - began,
              response,
              metrics,
              judgment,
              tags: testCase.tags,
            });
            return [
              { key: 'passed', score: passed ? 1 : 0, passed },
              ...(judgment ? [{ key: 'judge', score: judgment.score, passed: judgment.passed }] : []),
            ];
          } catch (error) {
            return failed(error instanceof Error ? error.message : String(error));
          }
        },
      ],
      {
        name: options.name ?? `eval-runner ${new Date(started).toISOString()}`,
        concurrency: options.concurrency ?? 1,
        ...(options.store ? { store: options.store } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      },
    );

    const results = ids.map((id) => outcomes.get(id) as EvalResult<Response>);
    const passedCount = results.filter((result) => result.passed).length;
    return {
      passed: passedCount === results.length,
      total: results.length,
      passedCount,
      failedCount: results.length - passedCount,
      durationMs: Date.now() - started,
      results,
      experiment,
    };
  }
}

/** Case names as example ids, with a suffix where two cases share a name. */
function uniqueIds(names: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return count === 1 ? name : `${name}#${count}`;
  });
}

function normalizeJudgment(value: boolean | EvalJudgment): EvalJudgment {
  if (typeof value === 'boolean') {
    return {
      score: value ? 1 : 0,
      passed: value,
    };
  }

  return value;
}
