export {
  type CompareOptions,
  compareExperiments,
  type ExampleComparison,
  type ExperimentComparison,
  formatComparison,
  type MetricComparison,
  scoreMap,
} from './compare.js';
export {
  contentVersion,
  createDataset,
  type CreateDatasetOptions,
  datasetFromTraces,
  FileDatasetStore,
  FileExperimentStore,
  type FromTracesOptions,
  MemoryDatasetStore,
  MemoryExperimentStore,
  readExperiment,
  splitOf,
} from './datasets.js';
export {
  completed,
  contains,
  embeddingSimilarity,
  exactMatch,
  mustNotMatch,
  pairwise,
  passRate,
  recallAtK,
  reciprocalRank,
  type RetrievalEvaluatorOptions,
  totalCost,
  trajectory,
  type TrajectoryOptions,
  underCost,
  underLatency,
} from './evaluators.js';
export {
  AnnotationQueue,
  type AnnotationQueueOptions,
  evaluateOnline,
  type OnlineEvaluationOptions,
  type OnlineEvaluationReport,
  type ReviewAnswer,
  type ReviewItem,
  type ReviewQuestion,
} from './review.js';
export {
  EvaluationBudgetError,
  evaluate,
  type EvaluateOptions,
  type EvaluationTarget,
  stats,
  summarize,
} from './run.js';
export {
  type CachedOutput,
  type EvaluationCache,
  evaluationCacheKey,
  fingerprintOf,
  MemoryEvaluationCache,
  type MemoryEvaluationCacheOptions,
} from './cache.js';
// File-system code of its own, so what reaches the cache helpers runs on any runtime.
export { FileEvaluationCache } from './file-cache.js';
export type {
  Dataset,
  DatasetExample,
  DatasetStore,
  EvaluationContext,
  EvaluationScore,
  EvaluationTrace,
  Evaluator,
  ExampleResult,
  Experiment,
  ExperimentStore,
  MediaPart,
  MetricSummary,
  SummaryEvaluator,
  TraceDocument,
  TraceMedia,
  TraceModelCall,
  TraceRetrieval,
  TraceToolCall,
} from '../types/evaluate.js';
export { mediaParts, traceEvidence } from './trace.js';
export { withProvenance } from './provenance.js';
