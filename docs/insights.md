# Insights

<!-- covers: ./insights -->

Finding problems in traces without being asked: failing and slow runs grouped by what went wrong,
metrics that got worse between two time windows, and — opt-in — a proposed fix that is evaluated
against your dataset before a person is asked to promote it.

```ts
import { detectRegressions, findIssues, proposeFix, modelFixProposer, ProposalInbox } from 'nexus-ai-pro/insights';

const issues = await findIssues({ store: traces, slowMs: 8000 });
const regressions = await detectRegressions({
  store: traces,
  current: { since: yesterday },
  baseline: { since: lastWeek, until: yesterday },
});
```

## Clusters and issues

`clusterRuns()` groups runs that failed or behaved the same way, each group a `RunCluster` with its
runs, a stable id, what they share, the run names and models among them, and when they were first
and last seen. `ClusterOptions` picks what to group `by` — a `ClusterBy` of:

- `error`: the run name and the error message, normalized by `errorSignature()`, which takes out ids,
  numbers, quoted values, and addresses so the same failure reads the same every time.
- `trajectory`: the path a run took, the steps `trajectoryOf()` reads from its trace tree.
- `meaning`: the run's text, embedded with the function you pass and joined to the first cluster
  whose leader is similar enough — for failures whose messages differ but mean the same.

`findIssues()` reads a window of traces and returns the problems in it, most common first: each
`Issue` is a cluster of failing runs — or of slow runs, when `slowMs` is set — with the share of the
window it covers and a readable summary. `FindIssuesOptions` sets the window, a query to narrow the
runs, whether to count only root runs (one per request, the default), how many runs to read, and the
smallest cluster that counts; the clustering options pass through, and clustering by trajectory
reads each run's trace tree.

## Regressions

`detectRegressions()` compares a current window with a baseline window, each a `TimeWindow`, per run
name, model, or provider, and reports each `Regression` — the metric, both values, the change, and
the sample sizes. `DetectRegressionsOptions` chooses the `RegressionMetric` values to compare:

- an error rate counts when the rise passes a two-proportion z-test at 95%;
- p95 latency and mean cost when they rise by a relative margin, a quarter by default;
- a feedback score, for the keys you name, when its mean falls by more than twice its standard error.

A group without `minRuns` in both windows — 20 by default — is not judged, so a quiet endpoint does
not raise alarms on noise.

## Proposed fixes

`proposeFix()` answers an issue with a candidate and measures it before anyone is asked:

1. A `FixProposer` is given a `FixRequest` — the issue, the version its label serves, and some runs
   that show it — and returns a `FixCandidate`: a new definition and why it should help.
2. The candidate is committed without a label, to the prompt registry or the context hub named by
   the `FixSubject`.
3. Your `evaluate` function scores the current version and the candidate over your dataset, and the
   comparison decides the verdict.
4. An improvement becomes a `pending` `FixProposal` for a person; anything else is `discarded`, with
   the evidence kept.

`ProposeFixOptions` also takes `compare` options, the `store` proposals are kept in, and a
`pullRequest` setting that opens a pull request for an improving fix through a `PullRequestClient`
you inject — a small interface over your forge, so none is a dependency. `modelFixProposer()` is a
proposer over a chat model, a `FixModelClient`: it rewrites a prompt's messages or a bundle's
instructions from the issue and example runs, with `ModelFixProposerOptions` naming the model.

```ts
const proposal = await proposeFix({
  issue: issues[0],
  subject: { kind: 'prompt', registry, name: 'support-answer', label: 'production' },
  propose: modelFixProposer(ai, { model: 'gpt-5.4' }),
  evaluate: (version) => evaluatePrompt(version, dataset, [correctness], { client: ai, store: experiments, cache }),
  store: proposals,
});
```

With an evaluation cache, the current version's outputs are reused across proposals, so each one
pays only for the candidate.

A `ProposalStore` keeps proposals: `MemoryProposalStore` in process, or `FileProposalStore` as one
JSON file each. `ProposalInbox` is what a person acts on — the pending proposals, `promote()` through
the label's gates as any promotion, and `reject()` — and `ProposalInboxOptions` gives it the store,
the registry, and the hub. The [studio](./studio.md) shows it in its inbox, behind roles.

## Limitations

- Insights are experimental.
- Clustering by meaning embeds every run's text; bound the window and `limit` on a busy store.
- A proposed fix is only as good as the dataset it is evaluated on. Nothing is promoted without a
  person, and promotion still runs the label's gates.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/insights`

| Export | Kind | Summary |
| --- | --- | --- |
| `ClusterBy` | type | How runs are grouped: by what went wrong, by the path they took, or by what their text means. |
| `ClusterOptions` | interface | Options for `clusterRuns()`. |
| `clusterRuns` | function | Groups runs that failed or behaved the same way. |
| `detectRegressions` | function | Compares a current window of traces with a baseline window and reports what got worse, per run name, model, or provider. |
| `DetectRegressionsOptions` | interface | Options for `detectRegressions()`. |
| `errorSignature` | function | An error message with what varies between occurrences taken out — ids, numbers, quoted values, addresses — so the same failure reads the same every time it happens. |
| `FileProposalStore` | class | Proposals as one JSON file each in a directory, so a shared studio keeps them across restarts. |
| `findIssues` | function | Finds the problems in a window of traces: failing runs, and slow runs when `slowMs` is set, each clustered the way `by` asks, most common first. |
| `FindIssuesOptions` | interface | Options for `findIssues()`. |
| `FixCandidate` | interface | A proposed new definition, and why it should fix the issue. |
| `FixModelClient` | interface | A client that runs one completion — a `NexusAI` instance, or anything with the same `complete()`. |
| `FixProposal` | interface | A proposed fix: the candidate, how it scored against the current version, and what a person decided. |
| `FixProposer` | type | Proposes a fix, or `undefined` when it has none: `modelFixProposer()`, or your own code. |
| `FixRequest` | interface | What a fix proposer is given: the issue, the version the label serves, and some runs that show it. |
| `FixSubject` | type | What a fix changes: a prompt in a registry, or a context bundle in a hub, served by a label. |
| `Issue` | interface | A problem found in recent runs: a cluster of failing or slow runs, and how common it is. |
| `MemoryProposalStore` | class | Proposals in process memory. |
| `modelFixProposer` | function | A fix proposer over a chat model: it is shown the issue, the current prompt's messages or the bundle's instructions, and example runs, and asked for replacements as JSON. |
| `ModelFixProposerOptions` | interface | Options for `modelFixProposer()`. |
| `ProposalInbox` | class | The proposals waiting for a person, and the two decisions they can make. |
| `ProposalInboxOptions` | interface | Options for a `ProposalInbox`. |
| `ProposalStore` | interface | Where proposals are kept. |
| `proposeFix` | function | Proposes a fix for an issue and measures it before anyone is asked: the proposer writes a new definition, it is committed without a label, the current version and the candidate are both scored over your dataset, and the comparison decides. |
| `ProposeFixOptions` | interface | Options for `proposeFix()`. |
| `PullRequestClient` | interface | Opens a pull request. |
| `Regression` | interface | A metric that got worse between the baseline window and the current one. |
| `RegressionMetric` | type | A metric `detectRegressions()` can compare. |
| `RunCluster` | interface | Runs that failed, or behaved, the same way. |
| `TimeWindow` | interface | A span of time, as ISO-8601 bounds. |
| `trajectoryOf` | function | The steps a run tree took, depth first in start order: each descendant as `kind:name`. |
<!-- reference:end -->
