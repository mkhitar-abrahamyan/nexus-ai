# Migrating

- [To 3.0](#migrating-to-30), from 2.x
- [To 2.0](#migrating-to-20), from 1.x

## Migrating to 3.0

3.0 turns on three defaults that 2.x kept opt-in, and removes two names 2.x deprecated. Nothing stored
changes: checkpoints, operation records, the server's state, and recorded deployments read as 2.x
wrote them. Most code compiles unchanged, but the three defaults change what a deployment does, so read
each before the upgrade reaches production.

To upgrade first and take the defaults later, keep 2.x's for now, on every replica:

```ts
import { useDefaults } from 'nexus-ai-pro/config';

useDefaults('2.x'); // before creating a tracer, an operation store, or a deployment
```

or set `NEXUS_DEFAULTS=2.x` in the environment. Then `npx nexus doctor --upgrade 3.0` says what turning
them on would change for your deployment, and `npx nexus migrate src` finds the removed names.

| Change | The codemod | By hand |
| --- | --- | --- |
| [A tracer on a durable store writes as it runs](#a-tracer-on-a-durable-store-writes-as-it-runs) | — | Expect twice the trace writes; close abandoned runs |
| [The Redis operation store keeps its index](#the-redis-operation-store-keeps-its-index) | — | Call `reindex()` once no worker without the index is left |
| [A new deployment places threads by `hash-v2`](#a-new-deployment-places-threads-by-hash-v2) | — | Give `bucket()` the deployment's strategy |
| [`OpenApiTools.skipped` is removed](#openapitoolsskipped-is-removed) | Lists each read | Delete it |
| [`GraphCheckpointV2` is removed](#graphcheckpointv2-is-removed) | Renames it | — |
| [`useDefaults('3.0')` changes nothing](#usedefaults30-changes-nothing) | Lists each call | Delete it |

### A tracer on a durable store writes as it runs

`TracerOptions.incremental` defaults to true on a store whose `durable` is not `false`. Each run is
written when it starts and again when it ends, so a run in a process that dies stays in the store with
every run beneath it that finished, and a run in progress can be watched. A store in memory, such as
`MemoryTraceStore`, still writes each trace when its root finishes.

- A store takes twice the writes, and a JSON Lines file twice the lines, the later one winning.
- A run a dead process left stays `running` until `closeAbandonedRuns()` closes it. Call it when a
  worker starts, or on a schedule.
- Sampling is decided when the root starts. A trace not sampled is held in memory and written at the
  end when tail sampling keeps it, so `keepErrors` still shows every failure.
- A store of your own that keeps runs only in memory says `durable: false`, and is written at the end.

```ts
// Before: 2.x wrote each trace when its root finished
const tracer = new Tracer({ store });

// After, to keep that
const tracer = new Tracer({ store, incremental: false });
```

### The Redis operation store keeps its index

`RedisOperationStore` keeps queued work in a sorted set by age, and leased work in one by lease expiry,
wherever its client has `zadd`, `zrem`, and `zrangebyscore`. A claim then reads the same few records
with 100,000 operations queued as with 1,000. A client without those commands is not refused: the store
reads every record, as 2.x did.

A worker without the index, as every 2.x worker is unless asked, writes records without index
entries, so work it queues is in the index only once `reindex()` adds it. Either way works:

- **Roll 3.0 out, then reindex.** While 2.x workers run, they claim what they queued. Once the last of
  them has stopped, call `reindex()` once, so the 3.0 workers find what was left. It is safe while
  workers are busy.
- **Turn the index on first, on 2.x.** On 2.2 or later, give every worker sharing the prefix
  `index: true`, or on 2.21 `useDefaults('3.0')`, and call `reindex()` once; 3.0 then changes nothing.

```ts
const operations = new RedisOperationStore(redis);
await operations.reindex(); // once no worker without the index shares the prefix
```

`index: false` keeps 2.x's behaviour.

### A new deployment places threads by `hash-v2`

A deployment first recorded on 3.0 places new threads and stateless runs by `hash-v2`, which spreads
sequential ids, such as `user-1` to `user-500`, as evenly as random ones. A deployment already recorded
keeps the strategy it records, `fnv1a-v1` before 3.0, so no thread moves through the upgrade;
`Deployments.bucketing()` moves one when you choose to.

`bucket()` still places a key by `fnv1a-v1` unless it is given a strategy, so code that predicts where a
thread lands passes the deployment's:

```ts
// Before
const onCanary = bucket(`support:${threadId}`) < 0.1;

// After
const deployment = await deployments.get('support');
const onCanary = bucket(`support:${threadId}`, deployment?.bucketStrategy) < 0.1;
```

`bucketStrategy: 'fnv1a-v1'` on `Deployments.assistant()` keeps 2.x's strategy for a deployment not
yet recorded. During a rolling upgrade, the replica that first records a deployment, by its first
canary or split, decides its strategy, and every replica of 2.5 or later then reads it from the record;
pass `bucketStrategy` to choose rather than leave it to the replica.

### `OpenApiTools.skipped` is removed

Every operation of an OpenAPI document becomes a tool since 2.22, its body sent whatever its type, so
`skipped` was always empty. Delete each read. The codemod lists them, in files that use the OpenAPI
tools.

### `GraphCheckpointV2` is removed

It was another name for `GraphCheckpoint`, kept since 1.25. The codemod renames it and keeps your local
name:

```ts
// Before
import type { GraphCheckpointV2 } from 'nexus-ai-pro/graph';

// After
import type { GraphCheckpoint as GraphCheckpointV2 } from 'nexus-ai-pro/graph';
```

### `useDefaults('3.0')` changes nothing

An application that previewed 3.0 with `useDefaults('3.0')` or `NEXUS_DEFAULTS=3.0` already runs as 3.0
does. The call and the variable change nothing now, and can go. `useDefaults('2.x')` and
`NEXUS_DEFAULTS=2.x` keep 2.x's three defaults through 3.x.

### What does not change

- Checkpoints of version 1 and 2 are read by both checkpointers and by `migrateCheckpoint()`.
- The server's state keys, sessions, API keys, operation records, and recorded deployments read as 2.x
  wrote them.
- Every other default, and every API this guide does not name.
- Node.js 22 or later.

## Migrating to 2.0

2.0.0 removes what the 1.x line deprecated, and runs every call of every family through one
lifecycle. Most applications change only their imports, and a codemod does that.

Start with the codemod. It rewrites what it can safely, and lists the rest:

```bash
npx nexus migrate src           # reports what would change
npx nexus migrate src --write   # rewrites the files
npx nexus migrate src --check   # exits 1 while anything is left, for CI
```

Run it while you are still on 1.25, where every name it moves already works on its subpath. Then
upgrade, and work through the table.

| Change | The codemod | By hand |
| --- | --- | --- |
| [The root import keeps only the core](#the-root-import-keeps-only-the-core) | Rewrites the imports | Namespace and dynamic imports of the root |
| [Validators and Node types are optional](#validators-and-node-types-are-optional) | — | Install what you use |
| [`estimatedCost` is removed](#a-responses-estimatedcost-is-removed) | Lists each read | Read `cost.amount` |
| [Modalities say which way they flow](#modalities-say-which-way-they-flow) | Lists entries that name `vision` or `pdf` | Write the two fields |
| [Checkpoints are version 2](#checkpoints-are-version-2) | — | Read `interrupts`; build checkpoints with `toCheckpoint()` |
| [Options that were never read are removed](#options-that-were-never-read-are-removed) | Lists each one | Delete them |
| [`ImageManagerConfig` is removed](#imagemanagerconfig-is-removed) | Renames it | — |
| [Pipeline step names are a closed list](#pipeline-step-names-are-a-closed-list) | — | Read a custom step's name from `custom` |
| [Streams open on their first read](#streams-open-on-their-first-read) | — | Catch errors around the loop |
| [Every call runs through the lifecycle](#every-call-runs-through-the-lifecycle) | — | Check dashboards, audit sinks, and rate limits |
| [Responses are priced on the routed model](#responses-are-priced-on-the-routed-model) | — | Expect costs that were 0 to be priced |
| [The model registry is current](#the-model-registry-is-current) | Lists each dropped model name, with its replacement | Choose the replacement; check what your aliases resolve to |
| [Claude 4.6 onward think adaptively](#claude-46-onward-think-adaptively) | — | Nothing |
| [Tool calls reach providers whole](#tool-calls-reach-providers-whole) | — | Nothing |

### The root import keeps only the core

In 2.0, `nexus-ai-pro` exports the core client and nothing else:

- `NexusAI`, `createNexus`, and the config builders;
- `tool()`, `toolOutput()`, the streaming helpers, and the usage and pricing helpers;
- the lifecycle: `OperationLifecycle`, its errors, and its types;
- the types of the client's configuration, requests, and responses;
- the errors the client throws: `NexusProviderError`, `NexusSecurityError`, `NexusRateLimitError`,
  `NexusCapabilityError`, `TokenBudgetError`, `CostBudgetError`, and `ResponseFormatError`.

Every other export is on its own subpath.

```ts
// Before
import { NexusAI, MemoryVectorStore, withRagContext, OperationRunner } from 'nexus-ai-pro';

// After
import { NexusAI } from 'nexus-ai-pro';
import { OperationRunner } from 'nexus-ai-pro/operations';
import { withRagContext } from 'nexus-ai-pro/grounding';
import { MemoryVectorStore } from 'nexus-ai-pro/rag';
```

The codemod does this for `import`, `import type`, `export … from`, and destructured `require()`. A
name that moved under another name keeps its local name through an alias:

```ts
// Before
import type { AgentModelClient } from 'nexus-ai-pro';
// After
import type { AgentLoopModelClient as AgentModelClient } from 'nexus-ai-pro/agent';
```

It cannot split a namespace import (`import * as nexus from 'nexus-ai-pro'`) or a dynamic `import()`,
so it lists them. Import each name you use from its subpath instead. Every subpath, and what it costs,
is in the [packaging guide](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/packaging.md).

The root import now costs about 325 KB, down from 572 KB.

### Validators and Node types are optional

`zod`, `ajv`, `ajv-formats`, and `@types/node` are optional peer dependencies. A production install
is the package alone, about 5.3 MB instead of 12.3 MB.

| You | Install |
| --- | --- |
| Compile TypeScript for Node | `npm install --save-dev @types/node` |
| Write schemas with zod | Nothing more: the package uses the zod your schema came from |
| Check output against a JSON Schema object | `npm install ajv ajv-formats` |

A JSON Schema response format without ajv fails with a `ResponseFormatError` that says what to
install. A zod shape is checked through each field's own `safeParse`.

The request check in the guardrails, `SchemaValidator`, no longer uses zod. It reports the same
fields by the same paths; the wording of its findings changed.

### A response's `estimatedCost` is removed

The formatted string on a response's metadata is gone. Read the numeric cost, and format it yourself:

```ts
// Before
console.log(response.meta.estimatedCost); // '$0.0012'

// After
const cost = response.meta.cost;
if (cost) console.log(new Intl.NumberFormat('en-US', { style: 'currency', currency: cost.currency }).format(cost.amount));
```

A plan's `estimatedCost`, from `ai.plan()`, is an object and stays. A custom provider that set the
string should drop it; `buildMeta()` fills `usage` and `cost`.

### Modalities say which way they flow

A model's `modalities` list mixed inputs and outputs: `vision` meant an image in, and `image` meant an
image out. 2.0 removes it, and the `Modality` type with it. Every entry declares `inputModalities` and
`outputModalities`, and both are required.

```ts
// Before
models: { registry: { 'my-model': { modalities: ['text', 'vision'], /* … */ } } }

// After
models: { registry: { 'my-model': { inputModalities: ['text', 'image'], outputModalities: ['text'], /* … */ } } }
```

| 1.x value | 2.0 |
| --- | --- |
| `text` | `text` in both lists |
| `vision` | `image` in `inputModalities` |
| `image` | `image` in `outputModalities` |
| `audio`, `video`, `pdf` | the same name in `inputModalities` |

In routing requirements, replace `modalities` with `inputModalities` or `outputModalities`.
`modalitiesOf()` still reads both lists, and now requires both.

### Checkpoints are version 2

A checkpoint 2.x writes has a `version` of 2, an `id`, its `tasks` always spelled out, and every
pending question in `interrupts`. The single `interrupt` field is gone.

```ts
// Before
const question = checkpoint.interrupt;

// After
const [question] = checkpoint.interrupts;
```

Threads stored by 1.x keep working. Both bundled checkpointers read version 1 for the whole 2.x line,
so a thread left waiting resumes after the upgrade.

| You | What to do |
| --- | --- |
| Read checkpoints through a graph | Nothing: `state()` and `history()` return version 2 |
| Wrote your own `GraphCheckpointer` | Its `get()` and `history()` may return either version, typed `StoredGraphCheckpoint`; the graph reads both |
| Read a store directly | Pass what you read to `migrateCheckpoint()` |
| Build a checkpoint by hand | Use `toCheckpoint()`, which fills in the version, id, tasks, and questions |
| Named `GraphCheckpointV2` | It still compiles; it is now another name for `GraphCheckpoint` |

### Options that were never read are removed

These were accepted and ignored, and warned once per process since they were deprecated. The codemod
lists each one it finds.

| Option | Deprecated in |
| --- | --- |
| `GoogleProviderConfig.projectId` | 1.16.0 |
| `OllamaProviderConfig.timeout` | 1.16.0 |
| `MetricsConfig.prometheus` | 1.16.0 |
| `DensificationConfig.preserveMarkdown` | 1.16.0 |
| `HealthConfig.latencyHalfLife` | 1.16.0 |
| `InjectionDetectionConfig.sensitivity` | 1.19.0 |
| `ToolPolicyConfig.requiresApproval` | 1.19.0 |

Delete them. Nothing changes, because nothing read them. Approval before a tool runs is
`interruptOn` on `createAgent()`.

### `ImageManagerConfig` is removed

It was another name for `ImageConfig`. The codemod renames the import and keeps your local name.

### Pipeline step names are a closed list

`PipelineStepName` lists the built-in stages only, so a `switch` over it can be exhaustive. A step you
add with `use()` is recorded as `customStep`, with its own name in `custom`.

```ts
// Before
const mine = response.meta.pipeline?.steps.find((step) => step.name === 'enrich');

// After
const mine = response.meta.pipeline?.steps.find((step) => step.custom === 'enrich');
```

The trace's `auditLog` step is gone: auditing is the lifecycle's `audit` stage. `authorize` and
`audit` appear when a lifecycle has work to do, and `reconcileCost` appears on every response.
Metrics for a custom step keep its own name as their `step` label.

`PipelineContext`, `PipelineMiddleware`, `PipelineStep`, `PipelineHooksConfig`, `PipelineConfig`, and
`PipelineRunner` are generic over the request and the response. Both default to a completion's, so
existing code compiles unchanged.

### Streams open on their first read

`ai.stream()` returns at once. Authorization, the rate limit, guardrails, routing, and the budget run
when the stream is first read, so their errors come out of the loop:

```ts
// Before: a blocked request threw here
const stream = ai.stream(request);

// After: it throws from the loop
try {
  for await (const chunk of ai.stream(request)) render(chunk);
} catch (error) {
  // NexusSecurityError, NexusRateLimitError, OperationDeniedError, BudgetExceededError, …
}
```

Streams now get what completions always had. They are audited and counted, the cost budget and the
circuit breaker apply, and the `done` chunk carries the request id and a cost priced on the routed
model.

### Every call runs through the lifecycle

Completions, streams, embeddings, voice, telephony, images, realtime sessions, graphs, agents, jobs,
and batches share one [lifecycle](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/lifecycle.md).
Nothing has to change in your code, but what the lifecycle records looks different:

| What | 1.x | 2.0 |
| --- | --- | --- |
| Metric labels | `model`, or `provider` and `model`, per family | `family`, `operation`, `provider`, and `model` for every family |
| The image family's label | `family=images` | `family=image` |
| Audit event family | in `metadata.family` | `family` and `operation` on the event |
| A call that fails after it starts | No event after `request` | An `error` event |
| A blocked request | `blocked`, with `metadata.findings` | `blocked`, with `metadata.error` and `metadata.findings` |
| `response.meta.requestId` | An id the adapter made up | The operation's id, the same on its audit events |
| A cache hit | Not audited or counted | Audited, counted, and seen by `onFinish` |
| A context-window summary | An unrecorded model call | Its own `summarize` operation |
| `getCall()`, `listPhoneNumbers()`, `updatePhoneNumber()` | Called directly | Rate-limited and audited like `createCall()` |

So check three things:

- dashboards and alerts that match an exact label set;
- audit sinks that read `metadata.family`, or that expect no event after a failed `request`;
- rate limits, which now also count streams and the telephony reads above.

To use the lifecycle, set `lifecycle` on the client: an `authorize` callback, a shared `budget`, and
`hooks`. Pass `ai.lifecycle` to graphs, agents, workflows, realtime sessions, queues, and batches to
make their runs operations of the client too.

### Responses are priced on the routed model

The client now prices each response on the model the request was routed to, as the registry names
it. Providers often answer with a dated snapshot name the registry does not file. In 1.x, pricing on
that echo cost the call nothing, so OpenAI responses could show a cost of 0, and so could Groq, Mistral,
DeepSeek, and Cohere models filed under a prefix. Expect those costs to be priced in 2.0, and budgets
to count them. A charge the provider reports, with `basis: 'reported'`, is kept as it is.

### The model registry is current

The bundled registry was checked against each provider's documentation on 2026-10-02.

- **Shut-down models are gone.** So are four names 1.x invented that no provider served:
  `claude-sonnet-5-0`, `claude-haiku-5-0`, `claude-fable-5-0`, and `gemini-3.5-pro`. The codemod lists
  each one it finds, with what to use instead.
- **Models with an announced shutdown stay,** marked `deprecated`. Their notes give the date and the
  replacement, and an alias that resolves to one is deprecated too.
- **Intent aliases point at current models.** For example, `anthropic/best` is `claude-fable-5-1`,
  `openai/fast` is `gpt-6-luna`, and `deepseek/best` is `deepseek/deepseek-v4-pro`. Pin the resolved
  model when a run must be reproducible.
- **Prices moved both ways.** GPT-5.6 and Mistral Large 3 cost less. Gemini 3.5 Flash costs more than
  1.x said, and the Gemini 3.6 to 3.8 Flash prices double on 2027-01-01.

`describeModel()` shows what a name resolves to and when its entry was verified.

### Claude 4.6 onward think adaptively

From the 4.6 generation on, Claude takes adaptive thinking and an effort level, not a thinking budget.
After 4.6 a budget is rejected, so 1.x requests with `reasoning` failed on those models. 2.0 sends what
each model accepts, and the [core guide](docs/core.md#reasoning) has the details. Nothing changes in
your code. From 4.7 on, Claude also rejects a non-default `temperature` or `topP`, so the client
drops one and records a capability warning.

### Tool calls reach providers whole

In 1.x the OpenAI, Anthropic, and Google adapters dropped a conversation's tool calls and the ids that
link results to them. A real tool loop could fail on its second turn. 2.0 sends both the way each API
expects. Nothing changes in your code.

Two things are new beside it. A tool can return `toolOutput()`, whose text, images, and asset
references go back as the tool message itself. And a model that produces images returns them on
`response.assets`.

### For provider authors

The provider contracts only grew:

- `BaseProvider.complete()` and `stream()` take a second, optional `ProviderCallContext`;
- voice and telephony provider methods take it too;
- `ImageProviderCallContext`, `EmbeddingProviderCallContext`, and `BatchProviderCallContext` extend it;
- `FamilyTelemetry.run()` hands its function the context, and takes an optional settle function.

A provider written for 1.x compiles unchanged.

### Runtime

2.0 runs on Node 22 and newer.
