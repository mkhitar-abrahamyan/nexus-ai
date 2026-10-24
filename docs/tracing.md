# Traces

<!-- covers: ./tracing ./tracing/otlp ./tracing/otlp-grpc ./tracing/spool ./tracing/rollups -->

Traces you can search, from `nexus-ai-pro/tracing`. Each request becomes a tree of runs — the graph,
its nodes, its model and tool calls — stored in memory, a JSONL file, or Postgres. You can filter
them, leave feedback on them, compare two of them, and alert on them. A model call rendered from a
versioned prompt records which prompt ran, in `metadata.prompt`, and one rendered from a context
bundle records which bundle version, in `metadata.context`.

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

A `Run` is one unit of work.

| Field | Contents |
| --- | --- |
| id, trace id, parent id | Which trace it belongs to, and the run it ran inside. |
| name, kind | A `RunKind`: `chain`, `model`, `tool`, `graph`, `node`, `agent`, `retriever`, `embedding`, `image`, `voice`, `realtime`, `operation`, or `decision`, a typed decision with its answers. |
| status | A `RunStatus`: `running`, `ok`, or `error`. |
| times, latency | When it started and ended. |
| inputs, outputs, error | After redaction. |
| tags, metadata | Metadata can be queried by dot path. |
| usage, cost, model, provider | For model runs. |
| feedback | Judgements left on it. |
| events, dropped events | What happened inside it, each a `RunEvent` at its time, and how many past the cap were counted. |
| links | The runs it came from beside its parent, each a `RunLink`. |

A `RunTree` is a run with its `children` in start order. That is how a trace is read.

`RunFeedback` is a judgement on a run: a `key` such as `helpful`, a numeric `score`, a non-numeric
`value`, a `comment`, and the `source` that left it. `tracer.recordFeedback()` attaches one and fills
in the time.

## Recording

`Tracer` takes `TracerOptions`:

| Option | What it sets |
| --- | --- |
| `store` | Where finished traces are written. |
| `sampling` | A `SamplingPolicy`, below. |
| `redaction` | A `RedactionPolicy`, below. |
| `tags`, `metadata` | Added to every run, such as the deployment or release. |
| `onError` | Store errors are swallowed so tracing never breaks a request; this hook lets you notice them. |
| `maxEventsPerRun` | The events one run keeps (128); the rest are counted as its `droppedEvents`. |
| clock | For tests. |

The current run travels through `AsyncLocalStorage`, which is created only when a tracer exists.

| Method | What it does |
| --- | --- |
| `startRun()` | Starts a run beneath the one in scope, or a new trace. Returns a `RunHandle`. |
| `handle.finish()` | Ends the run. |
| `handle.child()` | Starts a run beneath it, without relying on the ambient context. |
| `trace()` | Runs a function inside a new run, and finishes it with the result or error. |
| `traceable()` | Wraps a function so every call becomes a run, with its arguments as inputs. |
| `within()` | Runs a function with a run started by `startRun()` in scope, so what it traces nests beneath that run, which its handle still finishes. |
| `current()` | The run in scope. |
| `event()` | Records an event on the run in scope, and says whether there was one. |
| `handle.event()`, `handle.link()` | Records an event on that run; returns a link to it, for another run to name. |

`StartRunOptions` give the name, kind (`chain` by default), inputs, tags, metadata, model, and
provider. A `parentId` or `traceId` attaches the run somewhere explicit.

`FinishRunOptions` give the outputs, usage, cost, metadata to merge, and the model and provider that
actually ran. Passing an `error` marks the run failed.

### Events and links

An event is something that happened inside a run, at a moment: a retry, a guardrail's verdict, a
tool's progress, the cache's answer. A `RunEvent` has a `name`, an ISO-8601 `time`, and
`attributes`, each a `RunAttributeValue`: a string, a number, or a boolean. A link names a run this
one came from, beside its parent: a branch a joined step gathers, the run that queued a job, or a span
in another process's trace. A `RunLink` has the linked run's `traceId` and `runId`, and attributes
that say why.

```ts
await tracer.trace({ name: 'job', links: [{ traceparent: request.headers.traceparent }] }, async (run) => {
  tracer.event('cache', { outcome: 'miss' });
  run.event('checkpoint', { step: 3 });
});
```

`StartRunOptions.links` takes `RunLinkInput` values: a `RunLink`, or a W3C `traceparent` header,
read as the trace and span it names; one that cannot be read is skipped. `FinishRunOptions` also take
`links`, and `events` as `RunEventInput` values, for what a run learns only as it ends, each
recorded at its own time and read in order with the rest. Once a run finishes, it records nothing
more, so an exporter holding it sees what it ended with. Redaction's `redact` hook sees the events
and links too.

The studio shows a run's events, each at its time with its attributes, and its links, each opening
the run it names, in the trace it belongs to. A trace's address, `#/traces/<trace>/<run>`, opens that
run of the trace, so a link can be shared.

### Writing as it runs

By default a trace is written when its root finishes. That lets sampling decide with the whole trace
in hand, but a process that dies mid-run takes its trace with it — the trace you most needed.
`TracerOptions.incremental` writes each run when it starts and again when it ends instead:

```ts
const tracer = new Tracer({ store, incremental: true });
```

A crash then leaves the run in the store with every run beneath it that finished, and a run in
progress can be watched while it goes. Each trace's writes are chained, so a run's end never lands
before its start. Sampling is decided when the root starts. A trace not sampled is still held in
memory and written at the end when tail sampling keeps it, so `keepErrors` still shows every
failure.

A run a dead process left behind stays `running` until something closes it. `closeAbandonedRuns()`
does that: every run still running after `olderThanMs` (`CloseAbandonedRunsOptions`) is saved as an
error named `RunAbandoned`, with `metadata.abandoned`, keeping what it recorded. Call it when a worker
starts, or on a schedule. `tracer.flush()` waits for every write and export handed over so far.

### Across processes

A run can continue a trace another process started. `handle.traceparent()` returns the run as a W3C
`traceparent` header, and `StartRunOptions.traceparent` joins it on the other side:

```ts
// On the server, when it queues work:
await runner.submit(work, { traceContext: { traceparent: request.traceparent() } });

// In the worker:
const job = tracer.startRun({ name: 'summarize', traceparent: context.traceContext?.traceparent });
```

The run joins the trace under the span the header names, and keeps its sampling decision. The same
header works with any OpenTelemetry service. `w3cTraceId()` and `w3cSpanId()` turn a tracer's ids
into the 32 and 16 hex digits W3C and OpenTelemetry use, the same way in every process.

### Sampling and redaction

Without `incremental`, a trace is written when its root finishes, so sampling decides with the whole
trace in hand.
`SamplingPolicy.rate` keeps that share of traces. Three options keep a trace whatever the rate:
`keepErrors`, `keepSlowerThanMs`, and `keepCostlierThan`.

`RedactionPolicy` can drop inputs or outputs entirely, and strips `hideFields` by dot path. Its `redact`
hook sees each run last. `stripFields()` is the dot-path removal on its own; it copies rather than
changing what you pass.

## Graphs and model calls

`traceGraph()` records a graph or agent run: a root run with one child per task, retries included,
each retry a `retry` event of its task's run with the attempt that failed and why. Each tool call is
a run inside its node's. A tool that reports progress has each report as a `progress` event, and
keeps them in the run's `metadata.progress` too: each report with when it came, the latest 50. A task
that follows a step of several tasks, such as the join after a fan-out, links to each of them.
`GraphTracingOptions` names the root, labels it `graph` or `agent`, and adds tags, metadata, and
inputs. It returns `GraphTracing`:

- `runOptions`, to spread into `invoke()`;
- `root`, the root run's handle;
- `runFor(node)`, the run of a node in progress;
- `finish()`, which closes the root with the result.

`traceModelClient()` wraps anything with a `complete()` method — the `ModelClientLike` contract — so
every call becomes a `model` run. The run records the request, the content and tool calls, token usage,
cost, finish reason, the model and provider that answered, and the prompt and context versions when the
request came from a registry or a context hub. Its `parent` option decides where the call hangs: `() => tracing.runFor('model')`
nests it inside the node that made it. What the response reports becomes the run's events:
- each attempt that failed before it, from the response's `failedAttempts`, as `retry` when it went
  to the provider that answered and `failover` when it went to another, at the time it failed;
- each guardrail applied, as `guardrail`;
- the cache's answer, as `cache`;
- each capability warning, as `capability_warning`.

A tool call an agent reports — `createAgent()` reports every one — becomes a `tool` run inside the
node that made it, with the arguments as inputs and the result or the error.

`traceRetriever()` wraps anything with a `retrieve()` method — the `RetrieverLike` contract, which
every retriever in `nexus-ai-pro/rag` meets — so every retrieval becomes a `retriever` run, holding
the query and the options asked as inputs and `{ documents }` as outputs. Every other member of the
retriever is its own, so a wrapped keyword index still takes writes. It takes `parent` and `name`, as
`traceModelClient()` does.

An agent server given a `tracer` traces each run itself: each attempt is the root of a trace, an
`agent` run named after the assistant, with the input as inputs and the output as outputs, and
`metadata.nexus` naming the run, the assistant, the attempt, the revision, and the thread, queryable
as `{ metadata: { 'nexus.run': runId } }`. Whatever the assistant traces through the same tracer, a
model call or a retrieval, lands beneath it. The run records the trace's id as `traceId`, which
[a deployment's evaluation](./deployments.md#judging-with-confidence-and-on-quality) reads.

## Exporting to OpenTelemetry

`TracerOptions.exporters` hands every finished run the tracer keeps, after redaction, to each
`TraceExporter`: an object with `export(run)` and an optional `flush()`. An exporter that fails is
reported through `onError` and never fails the run.

`OtlpTraceExporter` from `nexus-ai-pro/tracing/otlp` sends runs to any OpenTelemetry collector over
OTLP/HTTP, with no SDK to install. A run's events become its span's events, an `OtlpSpanEvent` each,
and its links the span's links, an `OtlpSpanLink` each, in JSON, in protobuf, and over gRPC:

```ts
import { OtlpTraceExporter } from 'nexus-ai-pro/tracing/otlp';

const tracer = new Tracer({
  store,
  exporters: [new OtlpTraceExporter({ endpoint: 'http://localhost:4318', serviceName: 'support-agent' })],
});
```

`OtlpTraceExporterOptions` sets the collector's base URL (spans go to `/v1/traces`), headers such as an
API key, the `service.name`, more resource attributes, the batch size (100) and how long a span waits
to batch (2 seconds), a `fetch` of your own, and an `onError`. `protocol` chooses the encoding:
`http/json` by default, or `http/protobuf`, OTLP's binary encoding, which is smaller and quicker for a
collector to read. On its own, a batch the collector refuses is dropped; `send()` sends runs as one
batch and rejects when the collector refuses them, which is what the spool below sends through. A
collector that takes a batch but rejects some of its spans says so in a partial success, which
reaches `onError` as an `OtlpPartialSuccessError` with the `rejectedSpans` and the collector's
`errorMessage`; sending them again would change nothing, so it is not a refusal.

`encodeOtlpTraceRequest()` writes an `OtlpExportRequest`, the spans grouped by resource and scope,
each attribute an `OtlpKeyValue` holding an `OtlpAttributeValue`, in that encoding, and
`decodeOtlpTraceResponse()` reads the `OtlpPartialSuccess` from a collector's answer. Both run
anywhere.

### OTLP over gRPC

`OtlpGrpcTraceExporter`, from `nexus-ai-pro/tracing/otlp-grpc`, sends the same spans over gRPC, port
4317, for a collector or a backend that takes only that. It needs no gRPC library: it frames the
trace service's `Export` call itself, over Node's own HTTP/2 client, so it runs on Node.js only.

```ts
import { OtlpGrpcTraceExporter } from 'nexus-ai-pro/tracing/otlp-grpc';

const exporter = new OtlpGrpcTraceExporter({
  endpoint: 'https://collector.internal:4317',
  headers: { 'x-api-key': process.env.OTEL_KEY ?? '' },
});
const tracer = new Tracer({ store, exporters: [exporter] });
// On shutdown: send what is waiting, and close the connection.
await exporter.close();
```

`OtlpGrpcTraceExporterOptions` takes everything `OtlpTraceExporterOptions` does but `fetch` and
`protocol`. An `http://` endpoint connects without TLS, and an `https://` one with it; the headers
are the call's metadata. `gzip` compresses each batch (on by default), `timeoutMs` is each call's
deadline (10 seconds), and `connect` passes options such as a `ca`, a client `cert` and `key`, or
`servername` to `http2.connect()`. One connection is kept, opened again when it drops, and it never
keeps the process alive while no call is in flight. A connection that dropped without a word, as when
a collector dies, fails the first call made on it before anything reaches a collector; that call is
made once more, on a new connection, as gRPC clients do. A call the collector answers with a status other
than OK rejects `send()` with an `OtlpGrpcError`, carrying the gRPC `code`, such as 14 for
`UNAVAILABLE`, and the collector's `details`, so a spool keeps the batch.

In the test suite, the OpenTelemetry Collector itself, in a container, takes the spans over gRPC and
sends them on as OTLP/HTTP JSON, and every one arrives with its ids, times, kind, attributes, and
status as it was sent.

### Spans that a collector being down cannot lose

`spoolingExporter()`, from `nexus-ai-pro/tracing/spool`, wraps any `TraceBatchSender` (something with
a `send(runs)` that rejects when the receiver refuses them, such as `OtlpTraceExporter`) in a
`SpoolingExporter` that keeps what the collector refuses. A refused batch is written to an operation
store, the memory, Redis, Postgres, or SQLite one, and tried again with backoff each `drainEveryMs`
(15 seconds). Every replica on the same store drains the same spool; each batch is claimed before it
is tried, so it is sent once, and one a stopped replica was sending is taken over when its lease
lapses.

```ts
import { OtlpTraceExporter } from 'nexus-ai-pro/tracing/otlp';
import { spoolingExporter } from 'nexus-ai-pro/tracing/spool';

const exporter = spoolingExporter({
  sender: new OtlpTraceExporter({ endpoint: 'https://collector.internal:4318' }),
  store: operationStore,                 // shared by every replica
  maxPendingBatches: 10_000,
  maxAgeMs: 24 * 3_600_000,
});
const tracer = new Tracer({ store, exporters: [exporter] });
```

`SpoolingExporterOptions` bounds what it keeps: at most `maxPendingBatches` (10,000) wait, and
spooling one more drops the oldest; a batch older than `maxAgeMs` (24 hours), or tried `maxAttempts`
times (1,000), is dead-lettered: marked failed in the store and never sent. The backoff runs from
`baseDelayMs` (1 second) to `maxDelayMs` (5 minutes). With `writeAhead`, every batch is written to the
spool before it is sent and removed once sent, so a process that stops in the middle of a send loses
nothing either, for a store write per batch.

`stats()` resolves to `SpoolStats`, counted in runs: how many were exported, of those how many were
retried from the spool, how many were spooled, dropped, and dead-lettered, and how many batches wait
now, across every replica, with the age of the oldest. `drain()` tries what is due now and resolves to
a `SpoolDrainReport`; `close()` flushes and stops the timers, leaving the spool for any replica.

In the test suite, a collector stops for an hour while a span finishes every second, and the process
restarts halfway through. When the collector comes back, every one of the 3,600 spans reaches it,
once, on the memory, SQLite, Postgres, and Redis operation stores.

Each run becomes an `OtlpSpan` with the GenAI semantic conventions, so Grafana Tempo, Jaeger,
Honeycomb, Datadog, New Relic, or any OTLP backend reads it like the rest of the application:

| Run | Span |
| --- | --- |
| `model` | A client span named `chat <model>`, with `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model` (`metadata.requestedModel` when routing chose), `gen_ai.response.model`, and `gen_ai.usage.input_tokens` and `output_tokens` |
| `embedding` | The same, with the `embeddings` operation |
| `tool` | `execute_tool <name>`, with `gen_ai.tool.name` |
| `agent` | `invoke_agent <name>`, with `gen_ai.agent.name` |
| `node` | `nexus.graph.node` and `nexus.graph.step` |
| Any | `nexus.run.kind`, `nexus.run.id`, `nexus.cost.usd`, a `nexus.tag.*` per tag, and `error.type` and an error status when it failed |

Span and trace ids are the W3C ids `traceparent()` propagates, so a trace that crossed processes
arrives as one trace. `runToOtlpSpan()` is the conversion on its own.

## Rollups for dashboards

A trace is the forensic record of one run. A chart of a week's cost needs none of that, only sums,
and reading every trace in the window to draw it is how a dashboard slows down as the service grows.
`nexus-ai-pro/tracing/rollups` keeps hourly totals instead.

```ts
import { MemoryRollupStore, rollupTraceStore, sumRollups } from 'nexus-ai-pro/tracing/rollups';

const rollups = new MemoryRollupStore();
const tracer = new Tracer({ store: rollupTraceStore(traceStore, rollups) });

const week = sumRollups(await rollups.query({ since: weekAgo }));
```

`rollupTraceStore()` wraps any trace store. Reads go to it unchanged; every run saved finished is also
added to a rollup. A run is counted once: a save of a run still running is not counted, and neither is
feedback. `RollupTraceStoreOptions.include` picks what counts, by default root runs and every model
and embedding run.

| Piece | What it is |
| --- | --- |
| `RollupKey` | What a row is counted by: the hour, kind, root name, model, provider, and `metadata.tenantId`. `rollupKeyOf()` reads it from a run. |
| `RollupTotals` | Runs, errors, cost, input and output tokens, and latency counts per bucket. |
| `RollupRow` | A key and its totals. |
| `RollupQuery` | An hour range, kinds, a model, a provider, a tenant, or a name. |
| `RollupStore` | `add()` and `query()`. `MemoryRollupStore` keeps rows in memory, and `PostgresRollupStore`, from `nexus-ai-pro/postgres/rollups`, beside your traces; any database can implement it. |
| `ROLLUP_LATENCY_BOUNDS_MS` | The latency buckets, from 10 ms to 10 minutes. |
| `rollupPercentile()` | A percentile from the buckets, exact to the bucket. |
| `sumRollups()` | Rows summed into one total. |

A million runs a month for three models is about two thousand rows. The [studio](./studio.md) reads
them for its cost view when you give it `rollups`.

## Storing and querying

A `TraceStore` has `save()`, `get()`, `query()`, and `tree()`, and optionally `addFeedback()` and
`prune()`. Three stores are included:

| Store | Best for |
| --- | --- |
| `MemoryTraceStore` | Development, tests, and one process. Bounded by `MemoryTraceStoreOptions.maxRuns` (10,000). |
| `JsonlTraceStore` | Durable without a database: one JSON object per line in `JsonlTraceStoreOptions.file`, trimmed to its newer half past `maxBytes` (64 MB). A read loads the file, so it suits a service that writes far more than it queries. |
| `PostgresTraceStore` | Production queries, with every filter in SQL. See the [Postgres guide](./postgres.md). |

A `RunQuery` filters runs. Results come newest first, and runs that started in the same millisecond
come by id, from last to first, compared as code units: every store orders them the same way.

| Filter | Matches |
| --- | --- |
| trace id, kind (one or several), status, name, model, provider | Exactly. |
| tags | Runs with all of them. |
| metadata | By dot path. |
| minimum latency, minimum cost | Runs at least that slow or expensive. |
| `since`, `until` | A window on the start time. |
| feedback key | Runs with feedback under that key. |
| `limit`, `offset` | Paging. `limit` defaults to 50. |
| `after` | Runs after a `RunCursor`, the start time and id of the last run of the page before. |

Page by `after` rather than `offset` when runs keep arriving: an offset shifts as new runs push
older ones down, and `until` cannot split runs that share a start time, so a page that ends among
them would end the same way again. `runCursor()` takes the cursor from a page's last run.

```ts
import { type Run, type RunCursor, runCursor } from 'nexus-ai-pro/tracing';

let after: RunCursor | undefined;
for (;;) {
  const page = await store.query({ kind: 'model', limit: 500, ...(after ? { after } : {}) });
  for (const run of page) handle(run);
  if (page.length < 500) break;
  after = runCursor(page[page.length - 1] as Run);
}
```

`applyQuery()` and `assembleTree()` are the filtering and tree-building every store shares. They are
exported for a store of your own, so a query means the same everywhere; `isAfterCursor()` is the
cursor test on its own, for a store that filters elsewhere.

## Comparing traces

`compareTraces()` matches the runs of two trees by path, such as `root/child#0/grandchild#1`, because
two runs of the same graph never share ids. It returns a `TraceComparison`:

- each matched pair, with its `RunDifference` values: a field added, removed, or changed, with both
  sides;
- the runs only one side has;
- the change in root latency and total cost.

`formatTree()` prints a tree as indented text.

## Alerts

An `AlertRule` watches one metric.

| Field | Meaning |
| --- | --- |
| name | What the alert says. |
| metric | An `AlertMetric`: `errorRate`, `latencyP95`, `latencyP50`, `cost`, or `count`. |
| threshold | It fires above this. |
| window | How far back it looks. Defaults to 15 minutes. |
| `filter` | Measures one model, kind, or tag. |
| `minRuns` | So a quiet window does not fire. |

`AlertEvaluator.evaluate()` checks every rule once. Each rule that fires produces an `AlertEvent` —
the value, the threshold, the run count, the window, and up to three sample runs — which goes to an
`AlertNotifier`. `measure()` computes a metric over runs on its own.

`createWebhookNotifier()` posts events to a URL. `WebhookNotifierOptions` sets headers, a `fetch`, and
a `body` builder. By default it sends the `{ text }` shape chat webhooks accept, with the event beside
it.

An alert answers a question you asked in advance. To find problems you did not expect — failing and
slow runs grouped by what went wrong, and metrics that got worse than the week before — use
[insights](./insights.md) over the same trace store.

## Limitations

- Without `incremental`, traces are written when the root finishes, so a process that dies mid-run
  loses that trace.
- With `incremental`, a run is written twice, so a store pays twice the writes. A run left by a dead
  process stays `running` until `closeAbandonedRuns()` closes it.
- `OtlpGrpcTraceExporter` runs on Node.js only. On another runtime, send OTLP/HTTP with
  `OtlpTraceExporter`, in JSON or protobuf.
- A run keeps at most `maxEventsPerRun` events; the rest are counted, not kept. A model run's events
  from its response, other than failed attempts, carry the time the response came back.
- Without `writeAhead`, the runs waiting to be batched, at most `flushIntervalMs` of them, are lost
  with a process that stops before it sends them; what the collector refused is not. Rollups come as `MemoryRollupStore` and `PostgresRollupStore`; another database's is a
  `RollupStore` of your own.
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
| `closeAbandonedRuns` | function | Closes runs a process left running when it ended, so a crash shows as a failure rather than as work that is still going. |
| `CloseAbandonedRunsOptions` | interface | Options for `closeAbandonedRuns()`. |
| `compareTraces` | function | Compares two traces structurally. |
| `createWebhookNotifier` | function | Posts alerts to a webhook. |
| `FinishRunOptions` | interface | Options for finishing a run. |
| `formatTree` | function | A run tree as indented text, for a terminal or a log. |
| `GraphTracing` | interface | Tracing for one graph run: a root run with one child per task. |
| `GraphTracingOptions` | interface | Options for `traceGraph()`. |
| `isAfterCursor` | function | Whether a run comes after a cursor in query order: older, or as old with a smaller id. |
| `JsonlTraceStore` | class | Traces appended to a JSONL file. |
| `JsonlTraceStoreOptions` | interface | Options for the JSONL trace store. |
| `measure` | function | Computes a metric over a set of runs. |
| `MemoryTraceStore` | class | Traces in process memory. |
| `MemoryTraceStoreOptions` | interface | Options for the in-memory trace store. |
| `ModelClientLike` | interface | Any client with a `complete()` method. |
| `RedactionPolicy` | interface | What is removed from runs before they are stored, so a hidden field is never written anywhere. |
| `RetrieverLike` | interface | Anything with a `retrieve()` method, such as every retriever in `nexus-ai-pro/rag`. |
| `Run` | interface | One unit of work in a trace: a model call, a tool call, a graph node, or anything else worth timing. |
| `RunAttributeValue` | type | A value an event or a link can carry, as OpenTelemetry's attributes take them. |
| `runCursor` | function | A run's place in query order, for `RunQuery.after`: the next page starts after it. |
| `RunCursor` | interface | A run's place in query order, newest first and then by id from last to first: what a page resumes after. |
| `RunDifference` | interface | One field that differs between two matched runs. |
| `RunEvent` | interface | Something that happened inside a run, at a moment: a retry, a guardrail's verdict, a tool's progress, a cache's answer. |
| `RunEventInput` | interface | An event to record: its time defaults to now. |
| `RunFeedback` | interface | A judgement attached to a run, by a person or an evaluator. |
| `RunHandle` | interface | A run in progress. |
| `RunKind` | type | What kind of work a run was, so a trace can be filtered and drawn by family. |
| `RunLink` | interface | A run this one came from, beside its parent: a branch a joined step gathers, the run that queued a job, or a span in another trace. |
| `RunLinkInput` | type | A run to link to: by its trace and id, or by a W3C `traceparent` header from another process. |
| `RunQuery` | interface | Filters for `TraceStore.query()`. |
| `RunStatus` | type | Where a run stands: still going, finished, or failed. |
| `RunTree` | interface | A run and the runs beneath it, which is how a trace is read rather than a flat list. |
| `SamplingPolicy` | interface | Which traces are kept. |
| `StartRunOptions` | interface | Options for starting a run. |
| `stripFields` | function | Removes fields by dot path, deeply, without mutating what the caller passed in. |
| `TraceComparison` | interface | How two traces differ. |
| `TraceExporter` | interface | Receives every finished run a tracer keeps, after redaction, to send somewhere else: an OpenTelemetry collector, a log pipeline, a metrics rollup. |
| `traceGraph` | function | Records a graph or agent run as a trace. |
| `traceModelClient` | function | Wraps a model client so every call becomes a run, with its tokens and cost. |
| `Tracer` | class | Records run trees. |
| `traceRetriever` | function | Wraps a retriever so every retrieval becomes a run of kind `retriever`, holding the query and the documents that came back, so an evaluator reading the trace sees what an answer rested on. |
| `TracerOptions` | interface | Configuration for a tracer. |
| `TraceStore` | interface | Where runs are kept, for querying, trees, and feedback. |
| `w3cSpanId` | function | A run id as the 16 hex digits of a W3C span id. |
| `w3cTraceId` | function | A trace id as the 32 hex digits W3C trace context and OpenTelemetry use. |
| `WebhookNotifierOptions` | interface | Options for `createWebhookNotifier()`. |

### `nexus-ai-pro/tracing/otlp`

| Export | Kind | Summary |
| --- | --- | --- |
| `decodeOtlpTraceResponse` | function | Reads an `ExportTraceServiceResponse` in the protobuf encoding: its partial success, or nothing when the collector took every span. |
| `encodeOtlpTraceRequest` | function | An export request in OTLP's protobuf encoding, as a collector takes it over gRPC or OTLP/HTTP with `content-type: application/x-protobuf`. |
| `OtlpAttributeValue` | type | A typed attribute value, in OTLP's JSON encoding. |
| `OtlpExportRequest` | interface | An `ExportTraceServiceRequest` in OTLP's JSON encoding: spans grouped by resource and scope. |
| `OtlpKeyValue` | interface | One attribute, in OTLP's JSON encoding. |
| `OtlpPartialSuccess` | interface | What a collector says it rejected of an export it otherwise took, from OTLP's partial success. |
| `OtlpPartialSuccessError` | class | Thrown to `onError` when a collector took a batch but rejected some of its spans. |
| `OtlpSpan` | interface | One span in OTLP's JSON encoding. |
| `OtlpSpanEvent` | interface | A span event in OTLP's JSON encoding. |
| `OtlpSpanLink` | interface | A span link in OTLP's JSON encoding. |
| `OtlpTraceExporter` | class | Sends finished runs to any OpenTelemetry collector as OTLP/HTTP JSON, with no SDK to install. |
| `OtlpTraceExporterOptions` | interface | Options for `OtlpTraceExporter`. |
| `runToOtlpSpan` | function | Turns one finished run into an OpenTelemetry span, with the GenAI semantic conventions. |

### `nexus-ai-pro/tracing/otlp-grpc`

| Export | Kind | Summary |
| --- | --- | --- |
| `OtlpGrpcError` | class | Thrown when the collector answers an export with a gRPC status other than OK. |
| `OtlpGrpcTraceExporter` | class | Sends finished runs to any OpenTelemetry collector as OTLP over gRPC, port 4317, in OTLP's protobuf encoding: the same spans, batching, and GenAI attributes as `OtlpTraceExporter`, for a collector or backend that takes gRPC only. |
| `OtlpGrpcTraceExporterOptions` | interface | Options for `OtlpGrpcTraceExporter`. |

### `nexus-ai-pro/tracing/rollups`

| Export | Kind | Summary |
| --- | --- | --- |
| `MemoryRollupStore` | class | Rollup rows in process memory. |
| `ROLLUP_LATENCY_BOUNDS_MS` | constant | Upper bounds of the latency buckets, in milliseconds; a last bucket holds everything slower. |
| `RollupKey` | interface | What one rollup row is counted by. |
| `rollupKeyOf` | function | The rollup row a finished run belongs to. |
| `rollupPercentile` | function | The latency at percentile `p`, 0 to 1, from rollup buckets: the bound of the bucket it falls in. |
| `RollupQuery` | interface | Which rows to read. |
| `RollupRow` | interface | One rollup row: its key and its totals. |
| `RollupStore` | interface | Where rollup rows live. |
| `RollupTotals` | interface | The totals of one rollup row. |
| `rollupTraceStore` | function | Wraps a trace store so every run that finishes is also added to a rollup. |
| `RollupTraceStoreOptions` | interface | Options for `rollupTraceStore()`. |
| `sumRollups` | function | Rows summed across their keys: a total over a day, a model, or a whole range. |

### `nexus-ai-pro/tracing/spool`

| Export | Kind | Summary |
| --- | --- | --- |
| `SpoolDrainReport` | interface | What one `drain()` did. |
| `spoolingExporter` | function | Wraps a receiver of traces, such as `OtlpTraceExporter`, so that nothing it refuses is lost. |
| `SpoolingExporter` | interface | A trace exporter that spools what its receiver refuses, from `spoolingExporter()`. |
| `SpoolingExporterOptions` | interface | Options for `spoolingExporter()`. |
| `SpoolStats` | interface | What a spooling exporter has done, counted in runs. |
| `TraceBatchSender` | interface | Sends finished runs to a receiver, and rejects when the receiver did not take them. |
<!-- reference:end -->
