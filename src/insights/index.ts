/**
 * Insights: finding problems in traces without being asked. Failing and slow runs clustered by
 * error, path, or meaning; regressions between time windows; and, opt-in, a proposed fix evaluated
 * against a dataset before a person is asked to promote it.
 */
export {
  type ClusterBy,
  type ClusterOptions,
  clusterRuns,
  errorSignature,
  type FindIssuesOptions,
  findIssues,
  type Issue,
  type RunCluster,
  trajectoryOf,
} from './clusters.js';
export {
  FileProposalStore,
  type FixCandidate,
  type FixModelClient,
  type FixProposal,
  type FixProposer,
  type FixRequest,
  type FixSubject,
  MemoryProposalStore,
  type ModelFixProposerOptions,
  modelFixProposer,
  ProposalInbox,
  type ProposalInboxOptions,
  type ProposalStore,
  type ProposeFixOptions,
  proposeFix,
  type PullRequestClient,
} from './proposals.js';
export {
  type CompareRunsOptions,
  compareRuns,
  type DetectRegressionsOptions,
  detectRegressions,
  type Regression,
  type RegressionMetric,
  type RunSample,
  type TimeWindow,
} from './regressions.js';
