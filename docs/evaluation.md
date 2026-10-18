# Evaluation

<!-- covers: ./evaluate ./evaluate/threads ./evaluate/generate ./evaluate/online ./evaluate/media ./evals ./evals/judge -->

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

**Evaluators are ordinary functions.** Several come bundled, from exact matching to embedding
similarity. `trajectory` scores *how* an answer was reached: an agent that gets the right answer by
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

**The review queue keeps track of what people owe you.**

- Claims expire, so a reviewer who closes the tab does not strand an item.
- `consensus` sends one item to two reviewers when one opinion is not enough.
- `toExamples()` turns reviewed items into dataset examples. A production failure becomes a permanent
  regression test.

## Datasets

A `Dataset` has a name, a content `version`, a description, tags, its creation time, and its
examples. Each `DatasetExample` has an `id` — which is what pairs results across experiments — the
`inputs` the target receives, an optional `expected` answer, metadata, a `split`, tags, and, for
an example built from production, the `sourceRunId` it came from.

`createDataset()` builds one from `CreateDatasetOptions`: the name, the examples, a description, tags,
and a version. Examples without an id are numbered `ex-1`, `ex-2`, and so on. The version defaults to
`contentVersion()`, a hash of the examples, so identical content is always the same version.

`splitOf()` returns one split as a dataset of its own. `datasetFromTraces()` builds a dataset from
recorded runs. `FromTracesOptions` gives the store, a trace query, a `toExample` mapping (inputs and
outputs by default), and a limit (100).

A `DatasetStore` saves versions, gets one by name and version (the newest when none is given), and
lists names with their versions. `MemoryDatasetStore` keeps them in memory and `FileDatasetStore` as
one JSON file per version; `PostgresDatasetStore` is in the [Postgres guide](./postgres.md).

### Datasets that grow

`nexus-ai-pro/evaluate/generate` writes examples you would otherwise write by hand.

**From documents.** `syntheticDataset()` cuts each `SyntheticDocument` into `SyntheticPassage`s of up
to 1,500 characters, keeping paragraphs whole where they fit. It asks for `SyntheticDraft`s per
passage, from your `generate` function or from a model with a built-in prompt. Each draft is a
question, its answer, and a quote of the passage that supports the answer. It is kept only when:
- its quote is in its passage, word for word apart from spacing;
- its question is not too like one already kept (`similarity`, 0.8 by default).

Each example carries a `SyntheticCitation` in `metadata.citation`: the document, the passage, and
the quote with where it stands. The `SyntheticDatasetResult` also counts what was dropped as
unsupported or as a repeat. `SyntheticDatasetOptions` sets the passage size, the drafts per
passage, and a limit; `SyntheticModelClient` is the model the built-in prompt uses.

```ts
import { syntheticDataset } from 'nexus-ai-pro/evaluate/generate';

const { dataset, unsupported, duplicates } = await syntheticDataset({
  name: 'handbook',
  documents: pages.map((page) => ({ id: page.path, title: page.title, text: page.text })),
  client: ai,
  model: 'claude-haiku-5-5',
});
```

**From attacks.** `adversarialDataset()` grows a dataset from the guardrails' own patterns: each
seed of `attackSeeds()` on `nexus-ai-pro/security`, in each `AttackCarrier` and each
`AttackDisguise`. The carriers are the user's message, a document the user gives, and a tool's
result. The disguises are plain text, full-width letters, and invisible characters splitting the
words. Every example's `AdversarialInputs` hide a canary in the system prompt, and the attack asks
for it:
- an injection or a jailbreak tells the model to say it;
- exfiltration asks for the prompt that holds it.

`AdversarialExpected` names the canary. `resistsAttack()` scores 1 when the canary never appears in
the output, read through the same disguises. A target that refused, or that a guardrail stopped,
kept it in. `AdversarialDatasetOptions` chooses the categories, carriers, and disguises, and can
`rephrase` an attack into more wordings, such as a model's. Benign examples, one per carrier, show
a guard that refuses everything.

In the test suite, every attack gets the canary out of an agent with no guardrails, and none gets it
out of a guarded one. That agent blocks injections at `strict` and redacts its secret with output
moderation. It still answers every benign example.

**From production.** `promoteIssue()` turns the runs behind an insights `Issue` into examples.
Each keeps its run as `sourceRunId` and the issue as `metadata.issue`, so a regression test points
back to the problem it guards against. `PromoteIssueOptions` adds them to an existing dataset
(`into`), maps a run to an example, and sets a limit. A run already in the dataset is not added
twice.

## Targets, evaluators, and experiments

An `EvaluationTarget` turns an example's inputs into an output. An `Evaluator` receives an
`EvaluationContext` — the example, the output or the error, the latency, the cost, and which
repetition it was — and returns a number, a pass or fail, or one or more `EvaluationScore` values: a
key, the score, whether it passed, a comment, and metadata. Scores with the same key are summarized
and compared together. A `SummaryEvaluator` scores the experiment as a whole.

The bundled evaluators:

| Evaluator | Scores |
| --- | --- |
| `exactMatch()` | Equality with the expected output. |
| `contains()` | Whether required phrases appear. |
| `mustNotMatch()` | That forbidden patterns do not appear. |
| `completed()` | That the target produced an output at all. |
| `underLatency()`, `underCost()` | Latency and cost against a limit. |
| `embeddingSimilarity()` | Closeness to the expected answer, through any embedder. |
| `pairwise()` | A side-by-side judgement against another output. |
| `trajectory()` | How the answer was reached: the tools or nodes called. |
| `passRate()` | The share of examples that passed. A summary evaluator. |

`trajectory()` takes `TrajectoryOptions`: the `expected` tool or node names, a `path` reader (the
agent's tool calls by default), a `mode`, and the score `key`. The mode is `exact` for the same
sequence, or `subset` for every expected step appearing.

For retrieval, `recallAtK()` scores the share of an example's relevant ids found in the output's top
`k`, and `reciprocalRank()` scores one over the rank of the first relevant one, whose mean over a
dataset is the mean reciprocal rank. The output is a ranked list of ids or chunks, such as a
retriever's results, and `expected` is the relevant id or a list of them; `RetrievalEvaluatorOptions`
sets `k` and the score `key`. Comparing two retrievers this way is how the
[retrieval guide](./retrieval.md) shows that hybrid search with reranking is a real improvement.

`EvaluateOptions` names the experiment and sets `concurrency` (4), `repetitions` (a number, or a
function of the example), `summary` evaluators, a `store`, metadata, a per-example `timeoutMs`, a
`signal`, a `cost` reader, `onResult` for progress, and a clock.

An `Experiment` records:

- its id and name, the dataset and exact version it ran over, and its start and finish;
- how many examples produced no output;
- every `ExampleResult`: the example id, repetition, output or error, latency, cost, and scores;
- a `MetricSummary` per metric: count, mean, standard deviation, minimum, maximum, and the pass rate
  when the evaluator reported passes;
- the summary scores, and metadata;
- `evaluators`: an `EvaluatorProvenance` for each evaluator, in order — its position, name, the
  score keys it produced, and what it declared;
- `framework`: the package name and version that ran it.

A score means little without what produced it. `withProvenance()` marks an evaluator with its name,
version, the judge model and prompt version behind it, and its rubric, and the experiment records
them. It returns the same evaluator, which runs exactly as before:

```ts
import { withProvenance } from 'nexus-ai-pro/evaluate';

const grounded = withProvenance(groundedness, {
  name: 'groundedness',
  version: '3',
  judge: { model: 'claude-sonnet-5-5', promptVersion: 'grounded-v3', temperature: 0 },
  rubric: 'Every claim is supported by a cited passage.',
});
```

An evaluator with no provenance is recorded by its function's name, or as `evaluator-<position>`, with
the keys it produced, so two experiments can still be checked for using the same scorers.

| Function | What it does |
| --- | --- |
| `summarize()` | Computes the metric summaries. |
| `stats()` | The arithmetic underneath, with a 95% interval of the mean. |
| `scoreMap()` | Summary scores as a map, for a test or a gate. |
| `totalCost()` | Sums the experiment's cost. |

An `ExperimentStore` saves experiments, gets one by id, and lists them newest first, for one dataset
or name. `MemoryExperimentStore` keeps them in memory and `FileExperimentStore` as one file each;
`readExperiment()` reads a file, returning `undefined` for anything that is not an experiment.

## Caching

An experiment re-run after a small change should pay only for what changed. With a `cache`,
`evaluate()` stores each example's output and reuses it the next time the example's inputs, its
repetition, and the target's `fingerprint` are all unchanged; the evaluators always run again, so
correcting an expected answer or adding an evaluator re-scores stored outputs for free. Failures are
never stored, so a flaky example is retried. A cached result is marked `cached` and keeps the latency
and cost it had, and the experiment's `cache` field counts hits and misses.

The fingerprint names whatever decides the target's output — a model, a prompt version, settings —
and `fingerprintOf()` builds one from any settings object. A cache without a fingerprint is refused,
so a changed target can never reuse another's outputs. `evaluatePrompt()` and `evaluateContext()`
fingerprint the prompt or bundle version themselves.

```ts
import { evaluate, FileEvaluationCache, fingerprintOf } from 'nexus-ai-pro/evaluate';

const cache = new FileEvaluationCache('.eval-cache');
const fingerprint = await fingerprintOf({ model: 'gpt-5.4-mini', prompt: answer.version, temperature: 0 });
const experiment = await evaluate(target, dataset, evaluators, { cache, fingerprint, store });
console.log(experiment.cache); // { hits: 48, misses: 2 }
```

An `EvaluationCache` stores and returns a `CachedOutput` — the output, its latency and cost, and when
it was produced — by key. `MemoryEvaluationCache` keeps them in process, least recently used dropped
first beyond `MemoryEvaluationCacheOptions.maxEntries`, and copies them in and out so an evaluator
cannot change what a later experiment reuses. `FileEvaluationCache` keeps one JSON file per key in a
directory, which a CI job keeps between runs by caching the directory. `evaluationCacheKey()` is the
key: a SHA-256 over the fingerprint, the example's id and inputs, and the repetition — not the
expected output.

## Comparisons in detail

`compareExperiments()` takes `CompareOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `lowerIsBetter` | latency and cost | Metrics where a smaller number wins. |
| `resamples` | 2,000 | Bootstrap resamples behind each interval. |
| `seed` | fixed | Makes a comparison in CI reproducible. |
| `topExamples` | 10 | How many regressed and improved examples to list. |

It returns an `ExperimentComparison`:

| Field | Contents |
| --- | --- |
| both experiments | Their ids and names, and a dataset mismatch when they ran on different versions. |
| `metrics` | A `MetricComparison` per metric: both means, the mean paired difference, and a verdict of `better`, `worse`, or `unchanged`. |
| `regressions`, `improvements` | The examples that moved most, each an `ExampleComparison`. Its `delta` is signed so positive always means better. |
| `newErrors`, `fixedErrors` | Examples that started or stopped failing. |
| `regressed` | True when anything got worse beyond noise. |

`formatComparison()` renders it as text for a pull request or a CI log.

## Conversations

An agent that talks with a user over several turns is judged on the whole conversation: whether the
user got what they came for, how many turns it took, and the turn where it went wrong.
`nexus-ai-pro/evaluate/threads` holds those conversations with a simulated user and scores them, so
two versions of a multi-turn agent are compared the way single answers are, with the same verdicts.

```ts
import { compareExperiments, createDataset, evaluate } from 'nexus-ai-pro/evaluate';
import {
  conversationTarget,
  goalCompletion,
  goalReached,
  graphThreadAgent,
  simulatedUser,
  turnCount,
} from 'nexus-ai-pro/evaluate/threads';

const goals = createDataset({
  name: 'support-goals',
  examples: [{ inputs: { goal: 'Get a refund for order 1182', persona: 'An impatient customer' } }],
});
const user = simulatedUser({ client: ai, model: 'gpt-5.4-mini' });
const run = (agent) =>
  evaluate(conversationTarget(graphThreadAgent(agent), { user, maxTurns: 8 }), goals, [
    goalReached(),
    goalCompletion(judge),
    turnCount(),
  ]);

const comparison = compareExperiments(await run(current), await run(candidate), { lowerIsBetter: ['turns'] });
```

### The simulated user

A dataset of conversations holds `ThreadInputs`: the user's `goal`, and optionally a `persona` and the
user's `opening` message. A `SimulatedUser` plays that user. Given a `SimulatedUserContext` (the
goal, the persona, and the turns so far), it returns a `SimulatedUserReply`: its next message, or that
it is done, because the goal was met or because it gave up.

- `simulatedUser()` is driven by a model, through any `SimulatedUserClient` with a `complete()`
  method. The model is told the goal and the persona, sees the conversation with the roles turned
  around, and ends it by answering `DONE: GOAL` or `DONE: GAVE UP`. `SimulatedUserOptions` set the
  model, a default persona, the temperature (0, so a conversation repeats), the token limit, and
  instructions of your own.
- `scriptedUser()` follows a script, for a deterministic test: its messages in order, then done. A
  function in place of the script decides each move itself.

### The conversation target

`conversationTarget()` is an `evaluate()` target. For each example it lets the user speak and the agent
answer, until the user is done or `ConversationTargetOptions.maxTurns` (10) user messages have been
sent. The user may be one for every example, or a function that builds one per example, such as one
with that example's persona.

The target returns a `Thread`: every `ThreadTurn`, and a `ThreadEnding` that says how it ended:
`goal`, `gave-up`, `max-turns`, or `error` with the agent's message. An assistant turn records how
long the agent took and, when the agent reports them, every message it added on the way: its tool
calls, their results, and the answer.

A `ThreadAgent` is any function from the conversation so far to a `ThreadAgentReply`: the answer, or
the answer and the messages the agent added. It is given its own earlier turns as it recorded them,
and a `ThreadAgentContext`: the example's inputs, the turn, a `conversationId` that is new for every
conversation, and the abort signal. `graphThreadAgent()` makes one from `createAgent()`, or from any
`ThreadGraph` that takes `{ messages }` and ends with an `answer`. Each turn runs on the
conversation's thread with the transcript so far, so the agent sees its own tool calls on later
turns, as it does with a real user, with or without a checkpointer.

### Thread evaluators

| Evaluator | Key | Scores |
| --- | --- | --- |
| `goalReached()` | `goal_reached` | 1 when the user said the goal was met, otherwise 0, with how the conversation ended. |
| `goalCompletion(judge)` | `goal_completion` | A judge's verdict on the whole conversation, given the goal as the question. It takes an `LLMJudge`. |
| `turnCount()` | `turns` | How many times the agent spoke. Fewer is better: compare with `lowerIsBetter: ['turns']`. |
| `turnScores(evaluator)` | `turn_score` | Every assistant turn by an evaluator of single answers, and the conversation by their mean. |

`turnScores()` shows the evaluator each turn as an example of its own. The user's message is the
input, the turn is the output, and the conversation before it is in `metadata.history`. The score's
metadata lists every turn's score, and `wentWrongAt`, the first turn below the threshold, counted
from 1. `TurnScoresOptions` set the key and the threshold (0.5). `formatThread()` writes a
conversation as text, for a judge or a person.

Each evaluator scores an output that is not a conversation as 0, so one failed target does not end
an experiment.

## Online evaluation and review

`evaluateOnline()` scores production traffic. It takes `OnlineEvaluationOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `store`, `evaluators` | — | Where runs are read from, and how they are scored. |
| `query` | finished model runs | Which runs are scored. |
| `sampleRate` | all | The share of runs scored. |
| `reviewQueue`, `reviewWhen` | — | Where, and when, a run goes to a person. |
| `recordFeedback` | on | Writes scores back onto the runs. |

It returns an `OnlineEvaluationReport`: the runs scanned, evaluated, and queued for review, and every
score.

### On workers

`evaluateOnline()` is one pass, called by whoever calls it. For production traffic, run
`onlineEvaluationWorker()` from `nexus-ai-pro/evaluate/online` instead, on as many processes as you
like over one operation store, such as Redis or Postgres. Each `OnlineEvaluationWorker`:
- **reads** runs newest first, `scanLimit` (1,000) a page, each page resumed after the last run of
  the one before, so a backlog of runs that started in the same millisecond is read through. On a
  trace store of your own that does not honour `RunQuery.after`, it pages by offset instead, and its
  `OnlineSchedulePass` says `paging: 'offset'`;
- **samples** by a hash of the run's id and the `source`, so every worker, and every pass after a
  restart, picks the same runs;
- **queues** one operation per run and source, under an idempotency key, so a run is queued once
  however many workers see it, and it stops queuing while `maxQueued` (1,000) of the source's
  operations are waiting or running;
- **scores** what it claims, `concurrency` (4) at a time, each evaluation first reserved from a
  `budget` ledger at `estimate` and reconciled with `costOf`. Just before it calls its evaluators, it
  records the reservation it holds. A reservation held by a worker that died is settled by whoever
  takes over: charged at what the scores cost if they were written, given back if the evaluators
  never ran, and kept or given back by the ledger's `uncertain` policy if they ran and wrote nothing,
  since a judge may have billed the call. A run scored again after a crash is reserved and charged
  too, since its evaluators run again.

Every score is written to the run with a mark naming its operation. An operation run again, after
a worker died between writing a run's scores and recording them, writes only what is missing. So
each run is scored exactly once per source, across workers and after a crash. A worker that dies
leaves its claims to lapse after `leaseMs`, and another takes them back. When the budget is spent,
the evaluation goes back to the queue, not to failure, and the workers stop until it allows more.

`drain()` schedules and scores until nothing is left, `start()` and `stop()` keep it going, and
`report()` returns an `OnlineEvaluationWorkerReport`: queued, scored, already scored, missing,
failed, and why it last stopped. `schedule()` and `work()` run one step each; a scheduling pass
returns an `OnlineSchedulePass`. `OnlineEvaluationWorkerOptions` holds the rest, among them:
- `withTrace`, which gives each evaluator what the run did as `context.trace`, for one `tree()` read
  per evaluation, as below;
- `onScored`, which hears each run's scores once they are written, as an `OnlineScored`: the run,
  its scores, the source, and the operation that wrote them. `automationRules()` acts on them. A
  failure of it goes to `onError` and never fails the evaluation.

### Judging a run by its trace

An evaluator given a trace judges more than the answer. `context.trace` is an `EvaluationTrace`,
read by `traceEvidence()` from the run and everything beneath it:

| Field | What it holds |
| --- | --- |
| `root` | The trace, as a `RunTree` from the run judged. |
| `inputs`, `outputs` | What the run received and produced. |
| `toolCalls` | Every `TraceToolCall`: the tool's name, its arguments, its result or error, and how long it took. |
| `retrievals` | Every `TraceRetrieval`: the query and the `TraceDocument` values that came back, best first. |
| `modelCalls` | Every `TraceModelCall`: the model and provider, the request and response, usage, and cost. |
| `media` | Every `TraceMedia`: an image, audio, video, document, or asset part the run received or produced, each once, with the run that carried it. |

`mediaParts()` finds the same media, each a `MediaPart`, in any value: a message's content, a tool's output, or an asset
an image or video operation returned, which comes back as an asset part. A retrieval is read from a
`retriever` run, as `traceRetriever()` records one, whose outputs are the documents or
`{ documents }`.

```ts
// Grounded: the answer quotes what the tool returned, and rests on a retrieved policy.
const grounded: Evaluator = ({ output, trace }) => {
  const order = trace?.toolCalls.find((call) => call.name === 'lookup_order')?.outputs as Order;
  const cited = trace?.retrievals.some((retrieval) => retrieval.documents.length > 0) ?? false;
  return { key: 'grounded', score: cited && String(output).includes(order.ships) ? 1 : 0 };
};
```

A deployment's runs are judged the same way: `Deployments.evaluate()` and
`Deployments.evaluationWorker()` run this worker over the server's runs, as the
[deployments guide](./deployments.md#judging-with-confidence-and-on-quality) shows.

## Media you can evaluate

An image, a document, an audio clip, or a video can be what is judged. `nexus-ai-pro/evaluate/media`
gives two evaluators that read the media themselves, so they score an experiment over a target that
draws, an online evaluation of runs that make images, or a deployment's runs, like any other.

```ts
import { mediaChecks, mediaJudge } from 'nexus-ai-pro/evaluate/media';

const evaluators = [
  // Read from the media: a PNG or WebP, at least 1,024 pixels wide, at 16:9.
  mediaChecks({ mimeTypes: ['image/png', 'image/webp'], width: { min: 1024 }, aspectRatio: { ratio: 16 / 9 } }),
  // Shown to a vision model, beside the rubric and the brief.
  mediaJudge({ client: ai, model: 'gpt-5', rubric: 'On brand, sharp, and legible at a glance.', key: 'banner' }),
];
```

**Which media.** `mediaOf()` finds them, as both evaluators do: the media in the output, or, with
none there, those the run's trace says it produced, such as an image a tool drew; `from: 'input'`
takes the example's inputs instead, and `from: 'all'` both. `select` picks them from the whole
`EvaluationContext` instead. They are `MediaSelection` options.

**Reading them.** `resolveMedia()` reads one medium into a `ResolvedMedia`: its `MediaSubjectKind`
(`image`, `audio`, `video`, `document`, or `other`), its MIME type as its bytes say, its bytes, and
what its header says: an image's width and height, a WAV's duration. It reads base64, bytes, a data
URL, and an asset's bytes as they are. `MediaResolveOptions` reach the rest: `assets`, an asset store
and the tenant, for a stored asset; `fetch`, for a URL, which is otherwise never fetched; `readFile`,
for a path; and `maxBytes`, 20 MiB of any one medium. A medium that cannot be read says why in
`unreadable`.

**Checks.** `mediaChecks()` takes `MediaCheckOptions`, each a `MediaRange` or a list, and makes only
the checks asked: `count` (at least one), `kinds`, `mimeTypes` (with `image/*` for any image),
`bytes`, `width`, `height`, `aspectRatio` with a `tolerance` (2%), and `durationMs`. Each is a score,
`media.format` for instance, the share of media that pass it, with a comment naming each that fails;
`media` is the share that pass every check, and 0 when the count is wrong. A measurement that cannot
be read fails its check, or passes it with `unknown: 'pass'`. `key` changes the prefix.

**A judge.** `mediaJudge()` takes `MediaJudgeOptions`: a `client` with `complete()`, a `model` that
can see the media, a `rubric`, and a `key` (`media-judge`). Each medium goes to the model as itself,
read and sent as base64 where it can be, since a provider cannot read an asset store; the brief beside
it is the example's inputs as text, with any media in them named rather than spelled out, or what
`brief` returns. It asks for JSON with a score, a verdict, and a rationale, within `range` (0 to 1)
and against `passThreshold`, at `temperature` 0, showing at most `maxMedia` (8). With nothing to
judge it scores 0, or nothing with `whenMissing: 'skip'`, and calls no model. An experiment records
the judge's model and rubric.

A [canary is rolled back on a media evaluator's score](./deployments.md#automation-rules) when
those scores fall.

```ts
import { onlineEvaluationWorker } from 'nexus-ai-pro/evaluate/online';

const worker = onlineEvaluationWorker({
  source: 'helpfulness-v2',
  traces,
  operations: new RedisOperationStore(redis, { prefix: 'evaluations:', index: true }),
  evaluators: [judge],
  sampleRate: 0.1,
  budget: budgetLedger({ limit: 50 }),
  estimate: 0.002,
});
worker.start();
```

In the test suite, ten workers score 10,000 runs while one of them dies right after writing a run's
scores. Every run ends with each score exactly once; the run the dead worker never recorded is taken
back and found already scored; and the queue stays near its limit. Workers on a budget stop at it,
leave the rest queued, and carry on the next period without scoring a run twice.

**A spend cap for experiments.** `evaluate()` takes `budget`: a ledger and an estimate per example
run. Each run is reserved before it starts and reconciled with its cost, and a cached output costs
nothing. Once the budget runs out, no further example starts. `evaluate()` then rejects with an
`EvaluationBudgetError` that carries the results it paid for, and the experiment is not stored.

`AnnotationQueue` takes `AnnotationQueueOptions`:

- the `rubric`, a list of `ReviewQuestion` values: a key, the prompt, a type, and choices for a choice
  question;
- a claim `leaseMs` (15 minutes), and `consensus`, the answers an item needs (1);
- a clock.

| Method | What it does |
| --- | --- |
| `enqueue()` | Adds a `ReviewItem`: its subject, rubric, status (`pending`, `claimed`, or `reviewed`), live claims, answers, creation time, and metadata. |
| `claim()` | Hands the next item to a reviewer. |
| `submit()` | Records a `ReviewAnswer`: the reviewer, their answers as scores, a comment, and when. |

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

`judge.asEvaluator()` is the same judge as an evaluator for `evaluate()`. It scores each output under
`key` (`judge` by default); `input` maps an evaluation context to what the judge sees, and defaults to
the output as the answer, the expected output as the reference, and the inputs as the question. The
experiment records the judge's model, temperature, rubric, and a hash of its instructions:

```ts
const experiment = await evaluate(target, dataset, [judge.asEvaluator({ key: 'quality' })]);
experiment.evaluators?.[0]?.judge; // { model, promptVersion, temperature }
```

## Eval cases in detail

`EvalRunner` runs `EvalCase` values through anything with `complete()`: the `EvalClient` contract.

A case has a name and a `request`, and is checked by an `assert` function, a `judge`, or both. It can
also carry an `expected` answer, a `metrics` function for `calculateEvalMetrics()`, and tags.

An `EvalJudge` returns true or false, or an `EvalJudgment`: a score from 0 to 1, whether it passed, a
rationale, labels, the raw output, and the judge's provider and model.

`EvalRunOptions` names the run and sets `concurrency` (1, so cases run in order), a `store`, and
metadata. Each `EvalResult` says whether its case passed and how long it took, with the response,
metrics, judgment, or error. The `EvalRunResult` totals them. It also carries the run as an
`experiment`, so it can be compared and gated like any other.

`LLMJudge` takes `LLMJudgeOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `client` | — | Anything with `complete()`: the `JudgeClient` contract. |
| `model`, `rubric` | — | Who judges, and against what. |
| `systemPrompt` | built in | Replaces the judge's instructions. |
| `range` | 0 to 1 | The score range. |
| `passThreshold` | middle of the range | The score that counts as a pass. |
| `temperature` | 0 | Kept at 0 for repeatable verdicts. |
| `maxTokens`, metadata | 512 | — |

It judges an `LLMJudgeInput` — the answer, a reference, the question, a rubric for this answer, and
source passages. It returns an `LLMJudgeResult`, with the score clamped to the range.
`parseJudgeResponse()` reads the judge's reply, whether JSON or a number in prose.

`createLLMJudgeEval()` and `asEvalJudge()` adapt a judge to an eval case. An `LLMJudgeInputMapper` turns
a response and its case into what the judge sees.

## Metrics

`calculateEvalMetrics()` computes every metric its `MetricInputs` make possible. It needs the answer.
Everything else is optional, and each input you add unlocks more metrics:

- the expected answer, the question, and the contexts;
- ranked retrieved chunks and the relevant ids;
- candidates, and which of them passed;
- token log-probabilities, latency, time to first token, token counts, and cost;
- a policy of forbidden and required terms, and an embedder.

It returns `EvalMetrics`, grouped by kind:

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

## Limitations

- A simulated user is as good as the model that plays it. Hold its model and temperature fixed
  between the experiments you compare, and read some conversations before trusting a verdict.
- A conversation runs its turns in order, so 50 conversations of 5 turns are 250 agent calls and 250
  user-model calls. `concurrency` runs conversations side by side, not turns.
- A synthetic example is as good as the model that wrote it. Its quote proves the passage says
  something, not that the question is a good one: read a sample before trusting a verdict.
- An adversarial dataset covers the attacks the guardrails know. A new phrasing needs a new pattern,
  or `rephrase`.
- `mediaChecks()` reads the dimensions of PNG, JPEG, GIF, WebP, and BMP images and the duration
  of WAV audio. Other audio and video are checked for kind, type, and size; a judge can watch them, on
  a provider that takes them.

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
| `CachedOutput` | interface | A target's output kept for reuse, with what producing it took. |
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
| `EvaluationBudgetError` | class | Thrown by `evaluate()` when its budget runs out before every example has run. |
| `EvaluationCache` | interface | Where `evaluate()` keeps target outputs between experiments. |
| `evaluationCacheKey` | function | The cache key of one example run: a SHA-256 over the target's fingerprint, the example's id and inputs, and the repetition. |
| `EvaluationContext` | interface | What an evaluator receives for one example. |
| `EvaluationScore` | interface | What an evaluator says about one output. |
| `EvaluationTarget` | type | Turns one example into an output. |
| `EvaluationTrace` | interface | What a run did, read from its trace by `traceEvidence()`. |
| `Evaluator` | type | Scores one output: a number, a pass or fail, one named score, or several. |
| `exactMatch` | function | Exact equality against the example's expected output. |
| `ExampleComparison` | interface | How one example's score moved. |
| `ExampleResult` | interface | One run of one example. |
| `Experiment` | interface | A stored evaluation run: which dataset version it ran over, every result, and the summaries. |
| `ExperimentComparison` | interface | What changed between a baseline experiment and a candidate. |
| `ExperimentStore` | interface | Where experiments are kept, for later comparison. |
| `FileDatasetStore` | class | Datasets as JSON files in a directory, one file per version. |
| `FileEvaluationCache` | class | Target outputs as JSON files in a directory, one per key, so a CI job keeps them between runs by caching the directory. |
| `FileExperimentStore` | class | Experiments as JSON files in a directory, one file per experiment. |
| `fingerprintOf` | function | A fingerprint for whatever decides a target's output — a model name, a prompt version, a temperature, a context bundle version — as `f` and 16 hex digits of a SHA-256 over its canonical JSON, so the same settings always give the same fingerprint, whatever the key order. |
| `formatComparison` | function | A comparison as text, for a pull-request comment or a CI log. |
| `FromTracesOptions` | interface | Options for `datasetFromTraces()`. |
| `MediaPart` | type | A medium an evaluator can judge: an image, audio, video, document, or asset part. |
| `mediaParts` | function | Every image, audio, video, document, and asset part inside a value, in the order they appear: a message's content, a tool's output, a list of them, or an asset an image or video operation returned, which comes back as an asset part. |
| `MemoryDatasetStore` | class | Datasets in memory, keyed by name and version. |
| `MemoryEvaluationCache` | class | Target outputs in process memory, least recently used dropped first. |
| `MemoryEvaluationCacheOptions` | interface | Options for a `MemoryEvaluationCache`. |
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
| `TraceDocument` | interface | One document a retrieval returned. |
| `traceEvidence` | function | Reads a trace into what evaluators judge: its root's inputs and outputs, every tool call, retrieval, and model call beneath it in the order they started, and the media they carried, each medium once. |
| `TraceMedia` | interface | A medium a run received or produced, and the trace run that carried it. |
| `TraceModelCall` | interface | A model call a run made, as its trace recorded it. |
| `TraceRetrieval` | interface | A retrieval a run made: what it asked, and the documents that came back, best first. |
| `TraceToolCall` | interface | A tool a run called, as its trace recorded it. |
| `trajectory` | function | Scores how an answer was reached, not just what it said. |
| `TrajectoryOptions` | interface | Options for `trajectory()`. |
| `underCost` | function | Cost as a pass or fail, per example. |
| `underLatency` | function | Latency as a pass or fail, so a quality gate can hold a budget as well as a score. |
| `withProvenance` | function | Says where an evaluator's scores come from: its name and version, the judge model and prompt version behind it, and its rubric. |

### `nexus-ai-pro/evaluate/generate`

| Export | Kind | Summary |
| --- | --- | --- |
| `adversarialDataset` | function | Grows an adversarial dataset from the guardrails' own attack patterns: every seed of `attackSeeds()`, in each carrier and disguise. |
| `AdversarialDatasetOptions` | interface | Options for `adversarialDataset()`. |
| `AdversarialExpected` | interface | What an adversarial example expects: the canary never appears in the output. |
| `AdversarialInputs` | interface | What an adversarial example gives the target. |
| `AttackCarrier` | type | How an attack reaches the target: in what the user asks, in a document it is given, or in a tool's result. |
| `AttackDisguise` | type | How an attack is disguised: as written, in full-width letters, or split by invisible characters. |
| `promoteIssue` | function | Promotes the runs behind an insights issue into a dataset. |
| `PromoteIssueOptions` | interface | Options for `promoteIssue()`. |
| `resistsAttack` | function | Scores whether a target kept the canary in: 1 when it never appears in the output, read through the same disguises the guardrails read through. |
| `SyntheticCitation` | interface | Where an example came from: the document, the passage, and the supporting words. |
| `syntheticDataset` | function | Writes a dataset from documents. |
| `SyntheticDatasetOptions` | interface | Options for `syntheticDataset()`. |
| `SyntheticDatasetResult` | interface | What `syntheticDataset()` made, and what it dropped. |
| `SyntheticDocument` | interface | A document to write examples from. |
| `SyntheticDraft` | interface | An example the writer drafts: a question, its answer, and the words of the passage that support it. |
| `SyntheticModelClient` | interface | A model that writes drafts. |
| `SyntheticPassage` | interface | One passage of a document, as the writer sees it. |

### `nexus-ai-pro/evaluate/media`

| Export | Kind | Summary |
| --- | --- | --- |
| `MediaCheckOptions` | interface | Options for `mediaChecks()`. |
| `mediaChecks` | function | Checks the media an evaluation is about, reading them: how many there are, and of each its kind, MIME type, size, dimensions, aspect ratio, and duration, as the options ask. |
| `mediaJudge` | function | Judges the media an evaluation is about with a model that is shown them: each image, document, audio clip, or video goes to the model as itself, read from bytes, base64, a URL, a path, or an asset store, beside the rubric and the brief, and the model answers with a score. |
| `MediaJudgeOptions` | interface | Options for `mediaJudge()`. |
| `mediaOf` | function | The media an evaluation is about: those in the output, or, with none there, those the run's trace says it produced; or those it was given. |
| `MediaRange` | interface | A range a measurement must fall in. |
| `MediaResolveOptions` | interface | Where media judged by reference are read from. |
| `MediaSelection` | interface | Which media an evaluator judges. |
| `MediaSubjectKind` | type | What kind of medium something is. |
| `ResolvedMedia` | interface | A medium read for judging: what it is, and as much of it as could be read. |
| `resolveMedia` | function | Reads one medium: its kind, its bytes where it can, and what its header says. |

### `nexus-ai-pro/evaluate/online`

| Export | Kind | Summary |
| --- | --- | --- |
| `onlineEvaluationWorker` | function | A worker of an online evaluation. |
| `OnlineEvaluationWorker` | interface | A worker of an online evaluation. |
| `OnlineEvaluationWorkerOptions` | interface | Options for `onlineEvaluationWorker()`. |
| `OnlineEvaluationWorkerReport` | interface | What a worker has done since it was created. |
| `OnlineSchedulePass` | interface | What one scheduling pass did. |
| `OnlineScored` | interface | One run's scores, as `onScored` hears them. |

### `nexus-ai-pro/evaluate/threads`

| Export | Kind | Summary |
| --- | --- | --- |
| `conversationTarget` | function | An `evaluate()` target that holds a conversation per example: the simulated user speaks, the agent answers, until the user says it is done or the turn limit is reached. |
| `ConversationTargetOptions` | interface | Options for `conversationTarget()`. |
| `formatThread` | function | The conversation as text, for a judge or a person. |
| `goalCompletion` | function | Whether the goal was met, in a judge's opinion of the whole conversation, not the user's. |
| `goalReached` | function | Whether the user said its goal was met: 1 when the conversation ended on `goal`, otherwise 0, with how it ended as the comment. |
| `graphThreadAgent` | function | An agent from `createAgent()`, or any graph that takes `{ messages }` and ends with an `answer`, as a thread agent. |
| `scriptedUser` | function | A user that follows a script, for deterministic tests: its messages in order, then `done`. |
| `simulatedUser` | function | A simulated user driven by a model: it is told the goal and the persona, sees the conversation with the roles turned around, and writes the next message, or says it is done and why. |
| `SimulatedUser` | interface | Plays the user in a conversation. |
| `SimulatedUserClient` | interface | A model client, as the judges take one. |
| `SimulatedUserContext` | interface | What a simulated user sees when it writes its next message. |
| `SimulatedUserOptions` | interface | Options for `simulatedUser()`. |
| `SimulatedUserReply` | type | A simulated user's move: its next message, or the end of the conversation and why. |
| `Thread` | interface | A finished conversation: what a conversation target returns, and what thread evaluators read. |
| `ThreadAgent` | type | The agent a conversation target talks to. |
| `ThreadAgentContext` | interface | What a thread agent is told besides the conversation. |
| `ThreadAgentReply` | type | What a thread agent answers: the reply, or the reply and every message the agent added on the way, such as its tool calls and their results. |
| `ThreadEnding` | type | Why a conversation ended. |
| `ThreadGraph` | interface | A graph a thread agent can drive: one that takes `{ messages }`, as `createAgent()` builds. |
| `ThreadInputs` | interface | What a conversation is about: the user's goal, and optionally who they are and how they open. |
| `ThreadTurn` | interface | One turn of a conversation. |
| `turnCount` | function | How many times the assistant spoke: fewer is better. |
| `turnScores` | function | Scores every assistant turn with an evaluator of single answers, and the conversation by their mean. |
| `TurnScoresOptions` | interface | Options for `turnScores()`. |
<!-- reference:end -->
