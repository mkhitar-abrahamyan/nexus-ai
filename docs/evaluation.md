# Evaluation

<!-- covers: ./evaluate ./evals ./evals/judge -->

Evaluation from `nexus-ai-pro/evaluate`: run any target — a completion, an agent, a graph, an image operation, or plain code — over a dataset versioned by its content, score it, and compare experiments with a verdict rather than a difference of means. `nexus-ai-pro/evals` keeps the eval-case runner and the LLM judge.

## Overview

One entry point for evaluating anything: a completion, an agent, a graph, an image operation, or
plain code. A dataset of examples, a target that turns an example into an output, evaluators that
score it, and a stored experiment a later run can be compared against.

```ts
import { evaluate, createDataset, exactMatch, contains, trajectory, passRate } from 'nexus-ai-pro/evaluate';

const dataset = createDataset({
  name: 'support-questions',
  examples: [
    { id: 'refund', inputs: { question: 'how do I get a refund?' }, expected: 'Open the order and choose refund.' },
    { id: 'hours', inputs: { question: 'when are you open?' }, expected: 'Weekdays, nine to five.' },
  ],
});

const experiment = await evaluate(
  (inputs) => agent.invoke(agentInput(inputs.question)),
  dataset,
  [contains(['refund']), trajectory({ expected: ['search_orders'] })],
  { repetitions: 3, concurrency: 4, summary: [passRate()], store: experiments },
);
```

**A dataset is versioned by its content**, so two experiments are comparable only when they really
ran over the same examples. Change an example and the version changes with it.

**Datasets can come from production.** `datasetFromTraces({ store, query: { status: 'error' } })`
turns recorded runs into examples, each keeping the run it came from — the request that failed
yesterday becomes tomorrow's regression test.

**Evaluators are ordinary functions.** Bundled: `exactMatch`, `contains`, `mustNotMatch`, `completed`,
`underLatency`, `embeddingSimilarity` through any embedder, `pairwise` for side-by-side judgements,
and `trajectory`, which scores *how* an answer was reached — an agent that gets the right answer by
calling the refund tool three times is not working. The LLM judge from `nexus-ai-pro/evals/judge`
plugs in as one more evaluator.

**Cost is read from the output**: `meta.cost` on a completion or an image result, or a `cost` field on
anything else, and a `cost` option reads whatever a custom target returns. `underCost(0.05)` fails an
example that overspends, and `totalCost()` sums the experiment, so a quality gain that tripled the
bill is visible. `signal` cancels an evaluation without ever storing a partial experiment, and
`repetitions` can be a function when some examples are noisier than others.

### Was the change real?

```ts
import { compareExperiments, formatComparison } from 'nexus-ai-pro/evaluate';

const comparison = compareExperiments(baseline, candidate);
console.log(formatComparison(comparison));
if (comparison.regressed) process.exit(1);
```

A mean that moves from 0.81 to 0.83 says nothing on its own; with twenty examples that is noise, and
shipping on it makes a quality gate a coin toss. The verdict comes from a **paired bootstrap** over
the per-example differences, which assumes nothing about how the scores are distributed, and the
pairing removes the variation caused by the examples themselves. A metric whose interval spans zero
is reported as `unchanged`, not as an improvement. The bootstrap is seeded, so CI gives the same
verdict twice.

The report names the examples that moved most, the failures that are new, and the ones that were
fixed. A comparison across different dataset versions says so rather than pretending it is like for
like.

### In CI

```bash
nexus eval run eval.mjs --out candidate.json --baseline baseline.json --fail-on-regression
```

The module exports `{ target, dataset, evaluators, summary? }`. `nexus eval gate baseline.json
candidate.json` compares two stored experiments on its own. Either fails only when a metric got worse
beyond noise, a new failure appeared, or the datasets differ; `--allow-dataset-mismatch` accepts the
last. `FileExperimentStore` keeps experiments as files a pipeline can cache or commit, and
`PostgresExperimentStore` keeps them in a table.

`EvalRunner` and `MediaEvalRunner` run on `evaluate()` too, and their results carry the experiment
underneath, so an existing suite can be gated the same way without being rewritten.

### The runs you did not think of

```ts
import { evaluateOnline, AnnotationQueue } from 'nexus-ai-pro/evaluate';

const queue = new AnnotationQueue({
  rubric: [{ key: 'helpful', prompt: 'Did this answer the question?', type: 'boolean' }],
  consensus: 2,
});

await evaluateOnline({
  store: traceStore,
  evaluators: [mustNotMatch([/i cannot help/i])],
  sampleRate: 0.1,
  reviewQueue: queue,
  reviewWhen: (scores) => scores.some((score) => score.passed === false),
});
```

A dataset tells you whether a change works on the cases you thought of; online evaluation tells you
how it is doing on the rest. Scores are written back as feedback on the run, so an alert rule can
watch them, and anything uncertain goes to a person.

**The review queue keeps track of what people owe you.** Claims expire, so a reviewer who closes the
tab does not strand an item; `consensus` lets two reviewers see the same item when one opinion is not
enough; and `toExamples()` turns reviewed items into dataset examples, which closes the loop from a
production failure to a permanent regression test.

## LLM judges and eval cases

Use a plain assertion for small evals, or add an LLM judge when a rubric is more useful than exact matching:

```ts
import { LLMJudge } from 'nexus-ai-pro/evals';

const judge = new LLMJudge({
  client: ai,
  model: 'openai/gpt-4.1-mini',
  rubric: 'Score whether the answer is correct, concise, and grounded in the supplied context.',
  passThreshold: 0.7,
});

const run = await ai.runEvals([
  {
    name: 'support answer quality',
    request: {
      model: 'auto',
      messages: [{ role: 'user', content: 'Explain our refund policy.' }],
    },
    expected: 'Refunds are available within 30 days.',
    judge: judge.asEvalJudge(),
  },
]);
```

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/evals`

| Export | Kind | Summary |
| --- | --- | --- |
| `biasScore` | function | 1 when the text generalizes about a group by one of a few fixed patterns, otherwise 0. |
| `calculateEvalMetrics` | function | Computes every metric the inputs allow. |
| `contextualPrecision` | function | Average precision of a ranked retrieval against the relevant chunk ids. |
| `contextualRecall` | function | Share of the relevant chunk ids that the retrieval returned. |
| `EvalCase` | interface | One completion case: a request and how its response is checked. |
| `EvalClient` | interface | The one method `EvalRunner` needs from a client. |
| `EvalJudge` | type | Judges a response: `true`/`false`, or a full judgment with a score and rationale. |
| `EvalJudgment` | interface | A judge's verdict on one response. |
| `EvalMetrics` | interface | Every metric computed for one answer, grouped by kind. |
| `EvalResult` | interface | The outcome of one case. |
| `EvalRunner` | class | Runs completion cases and checks each response. |
| `EvalRunOptions` | interface | Options for one run. |
| `EvalRunResult` | interface | The outcome of a run of cases. |
| `exactMatch` | function | 1 when two texts are equal after normalizing case, punctuation, and whitespace, otherwise 0. |
| `f1Score` | function | Token-overlap F1 between two texts, from 0 to 1. |
| `faithfulness` | function | Share of the answer's factual statements that the contexts support lexically, from 0 to 1. |
| `MetricInputs` | interface | What `calculateEvalMetrics` needs. |
| `OperationalMetrics` | interface | How fast and expensive an answer was. |
| `passAtK` | function | 1 when any of the first `k` candidates passed, otherwise 0. |
| `perplexity` | function | Perplexity from token log-probabilities. |
| `policyAdherence` | function | Average of two checks: no forbidden term appears (1 or 0), and the share of required terms present. |
| `QualityMetrics` | interface | How close an answer is to the expected one. |
| `RagMetrics` | interface | How well a retrieval-augmented answer used its sources. |
| `refusalRate` | function | 1 when a safe prompt was answered with a refusal phrase, otherwise 0. |
| `SafetyMetrics` | interface | Heuristic safety signals. |
| `semanticSimilarity` | function | Cosine similarity of two texts under an embedder. |
| `tokensPerSecond` | function | Output tokens per second, or `undefined` when either input is missing or zero. |
| `toxicityScore` | function | Share of words in the text that appear on a short list of abusive terms. |

### `nexus-ai-pro/evals/judge`

| Export | Kind | Summary |
| --- | --- | --- |
| `createLLMJudgeEval` | function | Adapts a judge to an `EvalRunner` case. |
| `JudgeClient` | interface | The one method the judge needs from a client. |
| `LLMJudge` | class | Scores answers with a model against a rubric, asking for structured JSON and tolerating a judge that answers in prose. |
| `LLMJudgeInput` | interface | What the judge sees for one answer. |
| `LLMJudgeInputMapper` | type | Turns a response and its case into what the judge sees. |
| `LLMJudgeOptions` | interface | Configuration for an LLM judge. |
| `LLMJudgeResult` | interface | A judge's verdict. |
| `parseJudgeResponse` | function | Reads a judge's reply: JSON, fenced JSON, or a number in prose, clamped to the range, with `passed` from the reply or the threshold. |

### `nexus-ai-pro/evaluate`

| Export | Kind | Summary |
| --- | --- | --- |
| `AnnotationQueue` | class | Work waiting for a person. |
| `AnnotationQueueOptions` | interface | Configuration for an annotation queue. |
| `compareExperiments` | function | Compares two experiments and says whether the change is real. |
| `CompareOptions` | interface | Options for `compareExperiments()`. |
| `completed` | function | The example either produced an output or it did not. |
| `contains` | function | Whether the output contains every required phrase, case-insensitively by default. |
| `contentVersion` | function | A dataset version derived from its examples. |
| `createDataset` | function | Builds a dataset, versioned by its content. |
| `CreateDatasetOptions` | interface | Options for `createDataset()`. |
| `Dataset` | interface | A named, versioned set of examples. |
| `DatasetExample` | interface | One case to evaluate: what the target receives and, optionally, what a correct answer looks like. |
| `datasetFromTraces` | function | Builds a dataset from recorded production runs. |
| `DatasetStore` | interface | Where dataset versions are kept. |
| `embeddingSimilarity` | function | Cosine similarity against the expected answer, through any embedder. |
| `evaluate` | function | Runs a target over a dataset and scores it. |
| `evaluateOnline` | function | Scores production runs after the fact. |
| `EvaluateOptions` | interface | Options for `evaluate()`. |
| `EvaluationContext` | interface | What an evaluator receives for one example. |
| `EvaluationScore` | interface | What an evaluator says about one output. |
| `EvaluationTarget` | type | Turns one example into an output. |
| `Evaluator` | type | Scores one output: a number, a pass or fail, one named score, or several. |
| `exactMatch` | function | Exact equality against the example's expected output. |
| `ExampleComparison` | interface | How one example's score moved. |
| `ExampleResult` | interface | One run of one example. |
| `Experiment` | interface | A stored evaluation run: which dataset version it ran over, every result, and the summaries. |
| `ExperimentComparison` | interface | What changed between a baseline experiment and a candidate. |
| `ExperimentStore` | interface | Where experiments are kept, for later comparison. |
| `FileDatasetStore` | class | Datasets as JSON files in a directory, one file per version. |
| `FileExperimentStore` | class | Experiments as JSON files in a directory, one file per experiment. |
| `formatComparison` | function | A comparison as text, for a pull-request comment or a CI log. |
| `FromTracesOptions` | interface | Options for `datasetFromTraces()`. |
| `MemoryDatasetStore` | class | Datasets in memory, keyed by name and version. |
| `MemoryExperimentStore` | class | Experiments in memory, newest first. |
| `MetricComparison` | interface | How one metric moved between two experiments. |
| `MetricSummary` | interface | Distribution of one metric across an experiment. |
| `mustNotMatch` | function | Fails an output that matches any forbidden pattern: a leaked key, a refusal, a placeholder. |
| `OnlineEvaluationOptions` | interface | Options for `evaluateOnline()`. |
| `OnlineEvaluationReport` | interface | What an online evaluation pass did. |
| `pairwise` | function | Compares two outputs for the same example and says which is better. |
| `passRate` | function | Pass rate over every example, as a summary score for the experiment. |
| `readExperiment` | function | Reads an experiment file, or `undefined` when it is missing or is not an experiment. |
| `ReviewAnswer` | interface | One reviewer's answers to an item. |
| `ReviewItem` | interface | One item waiting for a person, with its claims and the answers it has. |
| `ReviewQuestion` | interface | One question a reviewer answers. |
| `scoreMap` | function | Summary scores as a map, for asserting on one in a test or a gate. |
| `splitOf` | function | Examples of one split, as a dataset in its own right. |
| `stats` | function | Count, mean, sample standard deviation, minimum, maximum, and 95% interval of the mean for a set of scores. |
| `summarize` | function | Mean, spread, and an interval per metric, so one lucky run is not mistaken for an improvement. |
| `SummaryEvaluator` | type | Scores an experiment as a whole: pass rate, distribution, anything per-example scores cannot say. |
| `totalCost` | function | Total cost of the experiment, so a quality gain that tripled the bill is visible. |
| `trajectory` | function | Scores how an answer was reached, not just what it said. |
| `TrajectoryOptions` | interface | Options for `trajectory()`. |
| `underCost` | function | Cost as a pass or fail, per example. |
| `underLatency` | function | Latency as a pass or fail, so a quality gate can hold a budget as well as a score. |
<!-- reference:end -->
