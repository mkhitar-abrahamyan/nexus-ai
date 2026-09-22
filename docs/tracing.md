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
