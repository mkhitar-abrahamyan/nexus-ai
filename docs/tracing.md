# Traces

<!-- covers: ./tracing -->

Queryable traces from `nexus-ai-pro/tracing`: run trees for graphs, agents, and model calls, stored in memory, in a JSONL file, or in Postgres, filterable by status, kind, model, tag, and metadata path, with feedback, trace comparison, and alert rules over stored runs. A model call rendered from a versioned prompt records which prompt ran, in `metadata.prompt`.

## Overview

Metrics say how it is going. A trace says what happened: the run tree of one request, with its
inputs, outputs, tokens, cost, and errors, stored where you can search it.

```ts
import { Tracer, MemoryTraceStore, traceGraph, traceModelClient } from 'nexus-ai-pro/tracing';

const tracer = new Tracer({
  store: new MemoryTraceStore(),               // or JsonlTraceStore, or PostgresTraceStore
  sampling: { rate: 0.05, keepErrors: true },  // 5% of traces, plus every failure
  redaction: { hideFields: ['apiKey', 'user.email'] },
});

const tracing = traceGraph(tracer, { name: 'support-agent', kind: 'agent' });
const agent = createAgent({ client: traceModelClient(ai, tracer, { parent: () => tracing.runFor('model') }) });

const run = await agent.invoke(agentInput(question), { threadId, ...tracing.runOptions });
await tracing.finish(run);
```

**Nothing inside the graph knows about tracing.** The graph already reports every task starting,
retrying, and finishing; a trace is that stream written down as a tree. An application that does not
trace creates no context, allocates nothing, and does no per-call work.

**Tail sampling keeps what matters.** A 5% rate still records every error, every run slower than a
threshold, and every run more expensive than one, because the decision is made when the trace
finishes rather than when it starts.

**Redaction happens before storage**, so a field you hide is never written, and a `redact` hook gets
the last word on every run.

**Then ask questions of it:**

```ts
const failures = await store.query({ status: 'error', kind: 'model', since: yesterday, minLatencyMs: 2000 });
const tree = await store.tree(failures[0].traceId);
console.log(formatTree(tree));

await tracer.recordFeedback(runId, { key: 'thumbs', score: 0, source: 'user' });
```

The same questions from a terminal: `nexus traces list --store runs.jsonl --status error`, then
`nexus traces show <traceId>` to print the tree.

`compareTraces(a, b)` lays two runs of the same shape side by side and reports what changed — the
step that got slower, the tool that stopped being called, the output that differs — which is how
"it worked yesterday" becomes an answerable question.

**Alerts** run the same queries on a timer, and carry the runs that tripped them:

```ts
import { AlertEvaluator, createWebhookNotifier } from 'nexus-ai-pro/tracing';

const alerts = new AlertEvaluator(
  store,
  [
    { name: 'error rate', metric: 'errorRate', threshold: 0.05, minRuns: 20 },
    { name: 'p95 latency', metric: 'latencyP95', threshold: 8000 },
    { name: 'hourly spend', metric: 'cost', threshold: 25, windowMs: 3_600_000 },
  ],
  { notifier: createWebhookNotifier({ url: process.env.ALERT_WEBHOOK! }) },
);

setInterval(() => void alerts.evaluate(), 60_000);
```

An alert names the rule, the measured value, and three runs that contributed, so the next step is
reading them rather than starting an investigation.

## Runs and trees

A `Run` is one unit of work: its id, the trace it belongs to and the run it ran inside, a name, a
`RunKind` — `chain`, `model`, `tool`, `graph`, `node`, `agent`, `retriever`, `embedding`, `image`,
`voice`, `realtime`, or `operation` — and a `RunStatus` of `running`, `ok`, or `error`. It carries
start and end times, latency, inputs and outputs after redaction, the error, tags, metadata you can
query by dot path, usage, cost, the model and provider for a model run, and its feedback. A `RunTree`
is a run with its `children`, in start order, which is how a trace is read.

`RunFeedback` is a judgement on a run — a `key` such as `helpful`, a numeric `score`, a non-numeric
`value`, a `comment`, and the `source` that left it — and `tracer.recordFeedback()` attaches it,
filling in the time.

## Recording

`Tracer` takes `TracerOptions`: the `store`, a `SamplingPolicy`, a `RedactionPolicy`, `tags` and
`metadata` added to every run (the deployment, the release), a clock, and `onError` — store errors
are swallowed so tracing never breaks a request, and the hook lets you notice them. The context
travels through `AsyncLocalStorage`, created only when a tracer exists.

- `startRun()` starts a run beneath the one in scope, or a new trace, and returns a `RunHandle`.
  `StartRunOptions` give the name, kind (`chain` by default), inputs, tags, metadata, model and
  provider, and a `parentId` or `traceId` to attach somewhere explicit.
- `handle.finish()` ends it. `FinishRunOptions` give the outputs, an `error` (whose presence marks the
  run failed), usage, cost, metadata merged into the run's, and the model and provider that actually
  ran. `handle.child()` starts a run beneath it without relying on the ambient context.
- `trace()` runs a function inside a new run and finishes it with the result or the error.
  `traceable()` wraps a function so every call becomes a run, recording its arguments as inputs.
- `current()` says which run is in scope.

A trace is written when its root finishes, which is what lets tail sampling decide with the whole
trace in hand. `SamplingPolicy.rate` keeps that share of traces, and `keepErrors`,
`keepSlowerThanMs`, and `keepCostlierThan` keep any trace with a failure, a slow run, or an expensive
one whatever the rate. `RedactionPolicy` drops inputs or outputs entirely, strips `hideFields` by dot
path, and hands each run to `redact` last. `stripFields()` is that dot-path removal on its own; it
copies rather than mutating what you pass.

## Graphs and model calls

`traceGraph()` records a graph or agent run: a root run with one child per task, retries included.
`GraphTracingOptions` names the root, labels it `graph` or `agent`, and adds tags, metadata, and
inputs. It returns `GraphTracing`: `runOptions` to spread into `invoke()`, the `root` handle,
`runFor(node)` for the run of a node in progress, and `finish()` to close the root with the result.

`traceModelClient()` wraps anything with `complete()` — the `ModelClientLike` contract — so every call
becomes a `model` run with its request, content and tool calls, token usage, cost, finish reason, the
model and provider that answered, and the prompt version when the request was rendered from a
registry. Its `parent` option decides where the call hangs; `() => tracing.runFor('model')` nests it
inside the node that made it.

## Storing and querying

`TraceStore` is the contract every store keeps: `save()`, `get()`, `query()`, and `tree()`, with
optional `addFeedback()` and `prune()`. Three are included:

- `MemoryTraceStore`, bounded by `MemoryTraceStoreOptions.maxRuns` (10,000 by default), for
  development, tests, and a single process.
- `JsonlTraceStore`, one JSON object per line in `JsonlTraceStoreOptions.file`, rewritten to its newer
  half once it passes `maxBytes` (64 MB by default). It is durable without a database and greppable,
  but a read loads the file, so it suits a service that writes far more than it queries.
- `PostgresTraceStore`, in the [Postgres guide](./postgres.md), which runs every filter in SQL.

`RunQuery` is the filter: a trace id, one kind or several, status, name, model, provider, tags (all
must be present), metadata by dot path, minimum latency and cost, a `since` and `until` window on the
start time, runs with feedback under a key, and `limit` (50 by default) and `offset`. Results come
newest first. `applyQuery()` and `assembleTree()` are the filtering and tree-building every store
shares, exported for a store of your own so a query means the same thing everywhere.

## Comparing traces

`compareTraces()` matches the runs of two trees by their path — `root/child#0/grandchild#1` — because
two runs of the same graph never share ids. The `TraceComparison` lists each matched pair with its
`RunDifference` values (a field added, removed, or changed, with both sides), the runs only one side
has, and the change in root latency and total cost. `formatTree()` prints a tree as indented text.

## Alerts

An `AlertRule` has a name, an `AlertMetric` — `errorRate`, `latencyP95`, `latencyP50`, `cost`, or
`count` — a threshold it fires above, a window (15 minutes by default), a `filter` to measure one
model, kind, or tag, and `minRuns` so a quiet window does not fire. `AlertEvaluator.evaluate()` checks
every rule once, returns an `AlertEvent` for each that fired — the value, the threshold, the run
count, the window, and up to three sample runs — and hands each to an `AlertNotifier`. `measure()`
computes a metric over runs on its own. `createWebhookNotifier()` posts to a URL, with
`WebhookNotifierOptions` for headers, a `fetch`, and a `body` builder; the default payload is the
`{ text }` shape chat webhooks accept, with the event beside it.

## Limitations

- Traces are written when the root finishes, so a process that dies mid-run loses that trace.
- An alert measures up to 1,000 runs in its window unless its filter sets a larger `limit`.
- Cost alerts sum every run in the window, so give a `filter` such as `{ kind: 'model' }` when
  parent runs also record cost.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/tracing`

| Export | Kind | Summary |
| --- | --- | --- |
| `AlertEvaluator` | class | Watches traces and reports when something crosses a line. |
| `AlertEvent` | interface | A rule that fired. |
| `AlertMetric` | type | What an alert measures: error rate, latency percentile, total cost, or run count. |
| `AlertNotifier` | interface | Where fired alerts are sent. |
| `AlertRule` | interface | A condition over recent runs that should fire an alert. |
| `applyQuery` | function | Filters and orders runs. |
| `assembleTree` | function | Assembles runs into a tree under their root, children ordered by start time. |
| `compareTraces` | function | Compares two traces structurally. |
| `createWebhookNotifier` | function | Posts alerts to a webhook. |
| `FinishRunOptions` | interface | Options for finishing a run. |
| `formatTree` | function | A run tree as indented text, for a terminal or a log. |
| `GraphTracing` | interface | Tracing for one graph run: a root run with one child per task. |
| `GraphTracingOptions` | interface | Options for `traceGraph()`. |
| `JsonlTraceStore` | class | Traces appended to a JSONL file. |
| `JsonlTraceStoreOptions` | interface | Options for the JSONL trace store. |
| `measure` | function | Computes a metric over a set of runs. |
| `MemoryTraceStore` | class | Traces in process memory. |
| `MemoryTraceStoreOptions` | interface | Options for the in-memory trace store. |
| `ModelClientLike` | interface | Any client with a `complete()` method. |
| `RedactionPolicy` | interface | What is removed from runs before they are stored, so a hidden field is never written anywhere. |
| `Run` | interface | One unit of work in a trace: a model call, a tool call, a graph node, or anything else worth timing. |
| `RunDifference` | interface | One field that differs between two matched runs. |
| `RunFeedback` | interface | A judgement attached to a run, by a person or an evaluator. |
| `RunHandle` | interface | A run in progress. |
| `RunKind` | type | What kind of work a run was, so a trace can be filtered and drawn by family. |
| `RunQuery` | interface | Filters for `TraceStore.query()`. |
| `RunStatus` | type | Where a run stands: still going, finished, or failed. |
| `RunTree` | interface | A run and the runs beneath it, which is how a trace is read rather than a flat list. |
| `SamplingPolicy` | interface | Which traces are kept. |
| `StartRunOptions` | interface | Options for starting a run. |
| `stripFields` | function | Removes fields by dot path, deeply, without mutating what the caller passed in. |
| `TraceComparison` | interface | How two traces differ. |
| `traceGraph` | function | Records a graph or agent run as a trace. |
| `traceModelClient` | function | Wraps a model client so every call becomes a run, with its tokens and cost. |
| `Tracer` | class | Records run trees. |
| `TracerOptions` | interface | Configuration for a tracer. |
| `TraceStore` | interface | Where runs are kept, for querying, trees, and feedback. |
| `WebhookNotifierOptions` | interface | Options for `createWebhookNotifier()`. |
<!-- reference:end -->
