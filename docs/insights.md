# Insights

<!-- covers: ./insights -->

Insights find problems in your traces without being asked. They do three things:

- **Group failures.** Failing and slow runs are grouped by what went wrong.
- **Spot regressions.** A metric that got worse between two sets of runs is reported.
- **Propose fixes.** Opt-in: a fix is written, evaluated on your dataset, and waits for a person.

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

`clusterRuns()` groups runs that failed, or behaved, the same way. `ClusterOptions` picks what to
group `by`. That is a `ClusterBy`:

| Value | Groups runs by |
| --- | --- |
| `error` | The run name and the error message. `errorSignature()` normalizes the message first: it takes out ids, numbers, quoted values, and addresses. |
| `trajectory` | The path a run took: the steps `trajectoryOf()` reads from its trace tree. |
| `meaning` | The run's text, embedded with the function you pass. Use it when messages differ but mean the same. |

Each group is a `RunCluster`: its runs, a stable id, what they share, their run names and models, and
when the group was first and last seen.

`findIssues()` reads a window of traces and returns its problems, most common first. Each `Issue` is a
cluster of failing runs, or of slow runs when `slowMs` is set. It also gives the share of the window it
covers and a readable summary.

```ts
const issues = await findIssues({ store: traces, since: lastHour, by: 'error', minCount: 3 });
for (const issue of issues) console.log(issue.summary);
```

`FindIssuesOptions` sets:

- the window, and a query to narrow the runs;
- whether to count only root runs, one per request, which is the default;
- how many runs to read, and the smallest cluster that counts;
- the clustering options, which pass through. Clustering by trajectory reads each run's trace tree.

## Regressions

`detectRegressions()` compares two time windows, each a `TimeWindow`. It judges each run name, model,
or provider on its own, and reports each `Regression`: the metric, both values, the change, and the
sample sizes.

`DetectRegressionsOptions` chooses the `RegressionMetric` values to compare:

| Metric | Counts as worse when |
| --- | --- |
| error rate | The rise passes a two-proportion z-test at 95%. |
| p95 latency | It rises by a relative margin, a quarter by default. |
| mean cost | It rises by a relative margin, a quarter by default. |
| a feedback score | Its mean falls by more than twice its standard error. You name the keys. |

A group needs `minRuns` in both windows before it is judged, 20 by default. So a quiet endpoint does
not raise alarms on noise.

### Comparing any two sets of runs

`compareRuns()` applies the same tests to two lists of runs you already have. It is what
`detectRegressions()` runs for each group, and what the [canary guard](./deployments.md#canary-guard)
runs to compare a canary with the live revision.

```ts
import { compareRuns } from 'nexus-ai-pro/insights';

const regressions = compareRuns(liveRuns, canaryRuns, { group: 'support@v2', metrics: ['error-rate', 'latency'] });
```

Each run is a `RunSample`: a `status` (`error` counts as a failure), and optionally `latencyMs`,
`cost`, and `feedback`. A traced `Run` already fits. `CompareRunsOptions` has the group name for the
summaries, the metrics, the feedback keys, `minRuns`, and the latency and cost margins.

With `confidence`, such as 0.95, each metric is judged instead by a seeded bootstrap. A metric then
regresses only when its interval does not reach zero and the change is at least its minimum effect:
- `minErrorRateIncrease` for the error rate;
- the latency and cost margins;
- `minFeedbackDrop` for a feedback score.

So neither noise nor a trivially small change counts. `resamples` and `seed` control the bootstrap,
and each `Regression` then carries its `interval`. The
[canary guard](./deployments.md#judging-with-confidence-and-on-quality) judges canaries this way.
`minLatencyChangeMs` sets the smallest latency rise that counts, in milliseconds, which keeps noise on
fast runs from reading as a regression. `detectRegressions()` takes it too.

## Proposed fixes

`proposeFix()` answers an issue with a candidate fix, and measures it before anyone is asked. It takes
four steps:

1. A `FixProposer` gets a `FixRequest`: the issue, the version its label serves, and some runs that
   show it. It returns a `FixCandidate`: a new definition, and why it should help.
2. The candidate is committed without a label, to the prompt registry or context hub the
   `FixSubject` names.
3. Your `evaluate` function scores the current version and the candidate on your dataset. The
   comparison decides the verdict.
4. An improvement becomes a `pending` `FixProposal` for a person. Anything else is `discarded`, with
   its evidence kept.

```ts
const proposal = await proposeFix({
  issue: issues[0],
  subject: { kind: 'prompt', registry, name: 'support-answer', label: 'production' },
  propose: modelFixProposer(ai, { model: 'gpt-5.4' }),
  evaluate: (version) => evaluatePrompt(version, dataset, [correctness], { client: ai, store: experiments, cache }),
  store: proposals,
});
```

With an evaluation cache, the current version's outputs are reused across proposals. Each proposal
then pays only for its candidate.

`ProposeFixOptions` also takes:

| Option | What it does |
| --- | --- |
| `compare` | Options for the comparison that decides the verdict. |
| `store` | Where proposals are kept. |
| `pullRequest` | Opens a pull request for an improving fix, through a `PullRequestClient` you inject. It is a small interface over your forge, so no forge is a dependency. |

`modelFixProposer()` is a proposer over a chat model, a `FixModelClient`. It rewrites a prompt's
messages, or a bundle's instructions, from the issue and example runs. `ModelFixProposerOptions`
names the model.

### Keeping proposals, and acting on them

A `ProposalStore` keeps proposals. `MemoryProposalStore` keeps them in process, and
`FileProposalStore` as one JSON file each.

`ProposalInbox` is what a person acts on. It lists the pending proposals. `promote()` moves one
through the label's gates, like any promotion, and `reject()` turns it down. `ProposalInboxOptions`
gives the inbox its store, registry, and hub. The [studio](./studio.md) shows the inbox, behind roles.

## Limitations

- Insights are experimental.
- Clustering by meaning embeds every run's text. On a busy store, bound the window and the `limit`.
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
| `compareRuns` | function | Compares two sets of runs and reports what got worse in the second, with the same tests `detectRegressions()` applies to time windows: a two-proportion z-test at 95% for the error rate, a relative margin for p95 latency and mean cost, and twice the standard error for a feedback score. |
| `CompareRunsOptions` | interface | Options for `compareRuns()`: what is compared, and how large a change must be to count. |
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
| `RunSample` | interface | The part of a run `compareRuns()` reads. |
| `TimeWindow` | interface | A span of time, as ISO-8601 bounds. |
| `trajectoryOf` | function | The steps a run tree took, depth first in start order: each descendant as `kind:name`. |
<!-- reference:end -->
