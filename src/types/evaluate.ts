/**
 * Evaluation as one contract, whatever is being evaluated.
 *
 * The package already had two evaluators: `EvalRunner` for completions and `MediaEvalRunner` for
 * images. Both answer the same question — does this still work, and is the new version better — but
 * neither can evaluate an agent, a graph, or plain code, and neither stores a result that a later
 * run can be compared against. This is that question asked once: a dataset of examples, a target
 * that turns an example into an output, evaluators that score it, and a stored experiment.
 */

/** One case to evaluate: what the target receives and, optionally, what a correct answer looks like. */
export interface DatasetExample<I = unknown, O = unknown> {
  /**
   * Identifies the example across dataset versions and experiments, which is what pairs results for
   * comparison.
   */
  id: string;
  /** What the target receives. */
  inputs: I;
  /** What a correct answer looks like. Optional: some evaluators judge without a reference. */
  expected?: O;
  /** Application data, available to evaluators. */
  metadata?: Record<string, unknown>;
  /** `train`, `test`, a customer name — anything worth filtering by. */
  split?: string;
  /** Labels for filtering. */
  tags?: string[];
  /** The trace run this example was built from, when it came from production. */
  sourceRunId?: string;
}

/** A named, versioned set of examples. */
export interface Dataset<I = unknown, O = unknown> {
  /** The dataset's name. */
  name: string;
  /** Content version. Pinning it is what makes two experiments comparable. */
  version: string;
  /** What the dataset is for. */
  description?: string;
  /** Its examples, in order. */
  examples: Array<DatasetExample<I, O>>;
  /** Labels for filtering. */
  tags?: string[];
  /** ISO-8601 time this version was created. */
  createdAt: string;
}

/** Where dataset versions are kept. */
export interface DatasetStore {
  /** Stores a version, replacing one with the same name and version. */
  save(dataset: Dataset): Promise<void> | void;
  /** The named version, or the newest when no version is given. */
  get(name: string, version?: string): Promise<Dataset | undefined> | Dataset | undefined;
  /** Every dataset name with its stored versions. */
  list(): Promise<Array<{ name: string; versions: string[] }>> | Array<{ name: string; versions: string[] }>;
}

/** What an evaluator says about one output. */
export interface EvaluationScore {
  /** The metric's name. Scores with the same key are summarized and compared together. */
  key: string;
  /** The measured value. */
  score: number;
  /** True or false when the metric is a judgement rather than a measurement. */
  passed?: boolean;
  /** A readable explanation, such as what was missing. */
  comment?: string;
  /** Evaluator-specific details. */
  metadata?: Record<string, unknown>;
}

/** What an evaluator receives for one example. */
export interface EvaluationContext<I = unknown, O = unknown> {
  /** The example the output was produced for. */
  example: DatasetExample<I, O>;
  /** What the target returned. */
  output: unknown;
  /** Present when the target failed instead of producing an output. */
  error?: { name: string; message: string };
  /** How long the target took, in milliseconds. */
  latencyMs: number;
  /** What the output cost, when it could be read from the output or the `cost` option. */
  cost?: number;
  /** Repetition index, for a target that is not deterministic. */
  run: number;
}

/** Scores one output: a number, a pass or fail, one named score, or several. */
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

/** One run of one example. */
export interface ExampleResult {
  /** The example's id. */
  exampleId: string;
  /** Which repetition, starting at 0. */
  run: number;
  /** What the target returned. */
  output?: unknown;
  /** Why the target failed, when it did. */
  error?: { name: string; message: string };
  /** How long it took, in milliseconds. */
  latencyMs: number;
  /** What it cost, when known. */
  cost?: number;
  /** Every score evaluators gave it. */
  scores: EvaluationScore[];
}

/** Distribution of one metric across an experiment. */
export interface MetricSummary {
  /** The metric's name. */
  key: string;
  /** Scores measured. */
  n: number;
  /** Their mean. */
  mean: number;
  /** Their sample standard deviation. */
  stddev: number;
  /** The smallest score. */
  min: number;
  /** The largest score. */
  max: number;
  /** Normal-approximation 95% interval for the mean. */
  ci95: [number, number];
  /** Share of scores whose evaluator reported a pass, when any did. */
  passRate?: number;
}

/** A stored evaluation run: which dataset version it ran over, every result, and the summaries. */
export interface Experiment {
  /** The experiment's id. */
  id: string;
  /** Its name, such as `baseline` or a commit hash. */
  name: string;
  /** The dataset and the exact version it ran over. */
  dataset: { name: string; version: string };
  /** ISO-8601 start time. */
  startedAt: string;
  /** ISO-8601 finish time. */
  finishedAt: string;
  /** Examples that produced no output at all. */
  errors: number;
  /** Every result, ordered by example and then repetition. */
  results: ExampleResult[];
  /** Per-metric summaries. */
  metrics: MetricSummary[];
  /** Scores from summary evaluators. */
  summary: EvaluationScore[];
  /** Application data, such as the model or prompt version under test. */
  metadata?: Record<string, unknown>;
}

/** Where experiments are kept, for later comparison. */
export interface ExperimentStore {
  /** Stores an experiment, replacing one with the same id. */
  save(experiment: Experiment): Promise<void> | void;
  /** Reads an experiment by id. */
  get(id: string): Promise<Experiment | undefined> | Experiment | undefined;
  /** Experiments, newest first, optionally for one dataset or one name. */
  list(filter?: { name?: string; dataset?: string; limit?: number }): Promise<Experiment[]> | Experiment[];
}
