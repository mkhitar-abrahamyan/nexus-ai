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

## Datasets

A `Dataset` has a name, a content `version`, a description, tags, its creation time, and its
examples. Each `DatasetExample` has an `id` — which is what pairs results across experiments — the
`inputs` the target receives, an optional `expected` answer, metadata, a `split`, tags, and, for
an example built from production, the `sourceRunId` it came from.

`createDataset()` builds one from `CreateDatasetOptions`: the name, the examples (numbered `ex-1`,
`ex-2`, … when they have no id), a description, tags, and a version that defaults to
`contentVersion()`, a hash of the examples, so identical content is the same version.
`splitOf()` returns one split as a dataset of its own. `datasetFromTraces()` reads recorded runs
through `FromTracesOptions` — the store, a trace query, a `toExample` mapping (inputs and outputs by
default), and a limit of 100.

A `DatasetStore` saves versions, gets one by name and version (the newest when none is given), and
lists names with their versions. `MemoryDatasetStore` keeps them in memory and `FileDatasetStore` as
one JSON file per version; `PostgresDatasetStore` is in the [Postgres guide](./postgres.md).

## Targets, evaluators, and experiments

An `EvaluationTarget` turns an example's inputs into an output. An `Evaluator` receives an
`EvaluationContext` — the example, the output or the error, the latency, the cost, and which
repetition it was — and returns a number, a pass or fail, or one or more `EvaluationScore` values: a
key, the score, whether it passed, a comment, and metadata. Scores with the same key are summarized
and compared together. A `SummaryEvaluator` scores the experiment as a whole.

The bundled evaluators are `exactMatch()`, `contains()`, `mustNotMatch()`, `completed()`,
`underLatency()`, `underCost()`, `embeddingSimilarity()`, `pairwise()`, and `trajectory()`, which
takes `TrajectoryOptions`: the `expected` tool or node names, a `path` reader (the agent's tool calls
by default), a `mode` — `exact` for the same sequence, `subset` for each expected step appearing —
and the score `key`. `passRate()` is a summary evaluator.

For retrieval, `recallAtK()` scores the share of an example's relevant ids found in the output's top
`k`, and `reciprocalRank()` scores one over the rank of the first relevant one, whose mean over a
dataset is the mean reciprocal rank. The output is a ranked list of ids or chunks, such as a
retriever's results, and `expected` is the relevant id or a list of them; `RetrievalEvaluatorOptions`
sets `k` and the score `key`. Comparing two retrievers this way is how the
[retrieval guide](./retrieval.md) shows that hybrid search with reranking is a real improvement.

`EvaluateOptions` names the experiment and sets `concurrency` (4), `repetitions` (a number, or a
function of the example), `summary` evaluators, a `store`, metadata, a per-example `timeoutMs`, a
`signal`, a `cost` reader, `onResult` for progress, and a clock.

An `Experiment` records its id and name, the dataset and exact version it ran over, its start and
finish, the examples that produced no output, every `ExampleResult` — the example id, repetition,
output or error, latency, cost, and scores — a `MetricSummary` per metric (count, mean, standard
deviation, minimum, maximum, and the pass rate when the evaluator reported passes), the summary
scores, and metadata. `summarize()` computes the metric summaries, `stats()` is the arithmetic
underneath with a 95% interval of the mean, `scoreMap()` returns summary scores as a map for a test
or a gate, and `totalCost()` sums the experiment.

An `ExperimentStore` saves experiments, gets one by id, and lists them newest first, for one dataset
or name. `MemoryExperimentStore` keeps them in memory and `FileExperimentStore` as one file each;
`readExperiment()` reads a file, returning `undefined` for anything that is not an experiment.

## Comparisons in detail

`compareExperiments()` takes `CompareOptions`: the metrics where `lowerIsBetter`, such as latency or
cost, the bootstrap `resamples` (2,000), a `seed` for reproducible CI, and `topExamples` (10). It
returns an `ExperimentComparison`: both experiments, a dataset mismatch when there is one, a
`MetricComparison` per metric — the two means, the mean paired difference, and a verdict of
`better`, `worse`, or `unchanged` — the examples that regressed and improved most, each an
`ExampleComparison` whose `delta` is signed so positive always means better, the new and fixed
errors, and `regressed`. `formatComparison()` renders it as text for a pull request or a CI log.

## Online evaluation and review

`evaluateOnline()` takes `OnlineEvaluationOptions`: the trace `store`, the `evaluators`, a `query`
(finished model runs by default), a `sampleRate`, a `reviewQueue` with a `reviewWhen` test, whether
to `recordFeedback` on the runs (on by default), and a clock. It returns an
`OnlineEvaluationReport`: runs scanned, evaluated, and queued for review, and every score.

`AnnotationQueue` takes `AnnotationQueueOptions`: the `rubric` of `ReviewQuestion` values — a key,
the prompt, a type, and choices for a choice question — a claim `leaseMs` (15 minutes), `consensus`
(1), and a clock. `enqueue()` adds a `ReviewItem` — its subject, rubric, status (`pending`,
`claimed`, or `reviewed`), live claims, answers, creation time, and metadata — `claim()` hands the
next one to a reviewer, and `submit()` records a `ReviewAnswer`: the reviewer, their answers as
scores, a comment, and when.

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

## Eval cases in detail

`EvalRunner` runs `EvalCase` values through anything with `complete()` — the `EvalClient` contract.
A case has a name, the `request`, and an `assert` function, a `judge`, or both, with an `expected`
answer, a `metrics` function for `calculateEvalMetrics()`, and tags. An `EvalJudge` returns true or
false, or an `EvalJudgment`: a score from 0 to 1, whether it passed, a rationale, labels, the raw
output, and the judge's provider and model. `EvalRunOptions` names the run and sets `concurrency`
(1, in order), a `store`, and metadata. Each `EvalResult` says whether the case passed, how long it
took, and holds the response, metrics, judgment, or error; the `EvalRunResult` totals them and carries
the run as an `experiment`, so it can be compared and gated like any other.

`LLMJudge` takes `LLMJudgeOptions`: the `client` — anything with `complete()`, the `JudgeClient`
contract — the `model`, a `rubric`, a `systemPrompt` to replace the default, `passThreshold` (the
middle of the range by default), the `range` (0 to 1), `temperature` (0, for repeatable verdicts),
`maxTokens` (512), and metadata. It judges an `LLMJudgeInput` — the answer, a reference, the
question, a rubric for this answer, and source passages — and returns an `LLMJudgeResult` with the
score clamped to the range. `parseJudgeResponse()` reads the judge's reply, JSON or a number in
prose. `createLLMJudgeEval()` and `asEvalJudge()` adapt it to a case, with an
`LLMJudgeInputMapper` to turn a response and its case into what the judge sees.

## Metrics

`calculateEvalMetrics()` computes every metric its `MetricInputs` allow — the answer, and any of the
expected answer, the question, contexts, ranked retrieved chunks and the relevant ids, candidates
and which passed, token log-probabilities, latency and time to first token, token counts, cost, a
policy of forbidden and required terms, and an embedder — and returns `EvalMetrics` grouped by kind:

- `QualityMetrics`: `exactMatch()` after normalizing case, punctuation, and whitespace;
  `semanticSimilarity()` under the embedder; `passAtK()`; and `perplexity()` from log-probabilities.
  `f1Score()` gives token-overlap F1 on its own.
- `RagMetrics`: `faithfulness()`, the share of factual statements the contexts support lexically;
  `contextualPrecision()` and `contextualRecall()` of the ranked chunks; and answer relevancy.
- `SafetyMetrics`: hallucination rate (one minus faithfulness), `toxicityScore()`, `biasScore()`,
  `policyAdherence()`, and `refusalRate()`.
- `OperationalMetrics`: `tokensPerSecond()`, time to first token, latency, cost, and token counts.

The safety metrics are heuristics — short term lists and fixed patterns — suited to catching a
regression in a test, not to judging content in production; use a model judge for that.

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
| `recallAtK` | function | The share of an example's relevant ids found in the output's top `k`. |
| `reciprocalRank` | function | One over the rank of the first relevant id in the output's top `k`, or 0 when none is there. |
| `RetrievalEvaluatorOptions` | interface | Options for the retrieval evaluators. |
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
