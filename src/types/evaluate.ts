/**
 * Evaluation as one contract, whatever is being evaluated.
 *
 * The package already had two evaluators: `EvalRunner` for completions and `MediaEvalRunner` for
 * images. Both answer the same question — does this still work, and is the new version better — but
 * neither can evaluate an agent, a graph, or plain code, and neither stores a result that a later
 * run can be compared against. This is that question asked once: a dataset of examples, a target
 * that turns an example into an output, evaluators that score it, and a stored experiment.
 */

export interface DatasetExample<I = unknown, O = unknown> {
  id: string;
  inputs: I;
  /** What a correct answer looks like. Optional: some evaluators judge without a reference. */
  expected?: O;
  metadata?: Record<string, unknown>;
  /** `train`, `test`, a customer name — anything worth filtering by. */
  split?: string;
  tags?: string[];
  /** The trace run this example was built from, when it came from production. */
  sourceRunId?: string;
}

export interface Dataset<I = unknown, O = unknown> {
  name: string;
  /** Content version. Pinning it is what makes two experiments comparable. */
  version: string;
  description?: string;
  examples: Array<DatasetExample<I, O>>;
  tags?: string[];
  createdAt: string;
}

export interface DatasetStore {
  save(dataset: Dataset): Promise<void> | void;
  /** The named version, or the newest when no version is given. */
  get(name: string, version?: string): Promise<Dataset | undefined> | Dataset | undefined;
  list(): Promise<Array<{ name: string; versions: string[] }>> | Array<{ name: string; versions: string[] }>;
}

/** What an evaluator says about one output. */
export interface EvaluationScore {
  key: string;
  score: number;
  /** True or false when the metric is a judgement rather than a measurement. */
  passed?: boolean;
  comment?: string;
  metadata?: Record<string, unknown>;
}

export interface EvaluationContext<I = unknown, O = unknown> {
  example: DatasetExample<I, O>;
  output: unknown;
  /** Present when the target failed instead of producing an output. */
  error?: { name: string; message: string };
  latencyMs: number;
  cost?: number;
  /** Repetition index, for a target that is not deterministic. */
  run: number;
}

export type Evaluator<I = unknown, O = unknown> = (
  context: EvaluationContext<I, O>,
) =>
  | Promise<EvaluationScore | EvaluationScore[] | number | boolean>
  | EvaluationScore
  | EvaluationScore[]
  | number
  | boolean;

/** Scores an experiment as a whole: pass rate, distribution, anything per-example scores cannot say. */
export type SummaryEvaluator = (results: ExampleResult[]) => Promise<EvaluationScore[]> | EvaluationScore[];

export interface ExampleResult {
  exampleId: string;
  run: number;
  output?: unknown;
  error?: { name: string; message: string };
  latencyMs: number;
  cost?: number;
  scores: EvaluationScore[];
}

export interface MetricSummary {
  key: string;
  n: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
  /** Normal-approximation 95% interval for the mean. */
  ci95: [number, number];
  /** Share of scores whose evaluator reported a pass, when any did. */
  passRate?: number;
}

export interface Experiment {
  id: string;
  name: string;
  dataset: { name: string; version: string };
  startedAt: string;
  finishedAt: string;
  /** Examples that produced no output at all. */
  errors: number;
  results: ExampleResult[];
  metrics: MetricSummary[];
  summary: EvaluationScore[];
  metadata?: Record<string, unknown>;
}

export interface ExperimentStore {
  save(experiment: Experiment): Promise<void> | void;
  get(id: string): Promise<Experiment | undefined> | Experiment | undefined;
  /** Experiments, newest first, optionally for one dataset or one name. */
  list(filter?: { name?: string; dataset?: string; limit?: number }): Promise<Experiment[]> | Experiment[];
}
