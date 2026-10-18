/**
 * Evaluation as one contract, whatever is being evaluated.
 *
 * The package already had two evaluators: `EvalRunner` for completions and `MediaEvalRunner` for
 * images. Both answer the same question — does this still work, and is the new version better — but
 * neither can evaluate an agent, a graph, or plain code, and neither stores a result that a later
 * run can be compared against. This is that question asked once: a dataset of examples, a target
 * that turns an example into an output, evaluators that score it, and a stored experiment.
 */

import type { AssetContent, AudioContent, DocumentContent, ImageContent, VideoContent } from './messages.js';
import type { RunKind, RunTree } from './tracing.js';

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
  /**
   * What the run did, read from its trace, when the evaluation reads traces: online evaluation with
   * `withTrace`, and a deployment's evaluation of a server that traces its runs.
   */
  trace?: EvaluationTrace;
}

/** A medium an evaluator can judge: an image, audio, video, document, or asset part. */
export type MediaPart = ImageContent | AudioContent | VideoContent | DocumentContent | AssetContent;

/** A tool a run called, as its trace recorded it. */
export interface TraceToolCall {
  /** The tool's name. */
  name: string;
  /** What it was called with. */
  inputs?: unknown;
  /** What it returned. */
  outputs?: unknown;
  /** Why it failed, when it did. */
  error?: { name: string; message: string };
  /** How long it took, in milliseconds. */
  latencyMs?: number;
  /** The trace run that recorded it. */
  runId: string;
}

/** A model call a run made, as its trace recorded it. */
export interface TraceModelCall {
  /** The model that answered. */
  model?: string;
  /** The provider that answered. */
  provider?: string;
  /** The request. */
  inputs?: unknown;
  /** The response's content and tool calls. */
  outputs?: unknown;
  /** Why it failed, when it did. */
  error?: { name: string; message: string };
  /** Token counts. */
  usage?: Record<string, number>;
  /** What it cost. */
  cost?: number;
  /** How long it took, in milliseconds. */
  latencyMs?: number;
  /** The trace run that recorded it. */
  runId: string;
}

/** One document a retrieval returned. */
export interface TraceDocument {
  /** The document's id, when it has one. */
  id?: string;
  /** Its text. */
  content: string;
  /** Its retrieval score. */
  score?: number;
  /** Where it came from. */
  source?: string;
  /** Its metadata. */
  metadata?: Record<string, unknown>;
}

/** A retrieval a run made: what it asked, and the documents that came back, best first. */
export interface TraceRetrieval {
  /** The query, when the trace recorded one. */
  query?: string;
  /** The documents. */
  documents: TraceDocument[];
  /** Why it failed, when it did. */
  error?: { name: string; message: string };
  /** The trace run that recorded it. */
  runId: string;
}

/** A medium a run received or produced, and the trace run that carried it. */
export interface TraceMedia {
  /** The medium. */
  part: MediaPart;
  /** Whether it was among the run's inputs or its outputs. */
  direction: 'input' | 'output';
  /** The trace run that carried it first. */
  runId: string;
  /** That run's kind. */
  kind: RunKind;
}

/** What a run did, read from its trace by `traceEvidence()`. */
export interface EvaluationTrace {
  /** The trace, as a tree from the run judged. */
  root: RunTree;
  /** What the run received. */
  inputs?: unknown;
  /** What it produced. */
  outputs?: unknown;
  /** Every tool it called, in the order they started. */
  toolCalls: TraceToolCall[];
  /** Every retrieval it made. */
  retrievals: TraceRetrieval[];
  /** Every model call it made. */
  modelCalls: TraceModelCall[];
  /** Every medium it received or produced, each once, in the order the trace carried them. */
  media: TraceMedia[];
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
  /**
   * True when the output came from the evaluation cache rather than a run of the target. Its latency
   * and cost are the ones recorded when it was produced.
   */
  cached?: boolean;
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
  /** Example runs answered from the evaluation cache, and runs of the target, when a cache was used. */
  cache?: { hits: number; misses: number };
  /** Where each evaluator's scores came from, in the order the evaluators were given. */
  evaluators?: EvaluatorProvenance[];
  /** The framework that ran the experiment. */
  framework?: { name: string; version: string };
}

/**
 * Where one evaluator's scores came from. `position`, `name`, and `keys` are always recorded; the
 * rest is what the evaluator declared through `withProvenance()`, or what an `LLMJudge` declares for
 * itself.
 */
export interface EvaluatorProvenance {
  /** Its place among the evaluators passed to `evaluate()`, from 0. */
  position: number;
  /** What it is called: as declared, its function's name, or `evaluator-<position>`. */
  name: string;
  /** The score keys it produced in this experiment. */
  keys: string[];
  /** Its version, as declared. */
  version?: string;
  /** The model behind a judge, and how it was called. */
  judge?: {
    /** The judge model. */
    model: string;
    /** The provider, when known. */
    provider?: string;
    /** Identifies the judge's instructions: a version, or a hash of its prompt. */
    promptVersion?: string;
    /** Its sampling temperature. */
    temperature?: number;
  };
  /** What a good answer looks like, as the evaluator was told. */
  rubric?: string;
  /** Anything else worth recording. */
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
