# Migrating to 2.0

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

## The root import keeps only the core

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

The root import now costs about 320 KB, down from 572 KB.

## Validators and Node types are optional

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

## A response's `estimatedCost` is removed

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

## Modalities say which way they flow

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

## Checkpoints are version 2

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

## Options that were never read are removed

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

## `ImageManagerConfig` is removed

It was another name for `ImageConfig`. The codemod renames the import and keeps your local name.

## Pipeline step names are a closed list

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

## Streams open on their first read

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

## Every call runs through the lifecycle

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

## Responses are priced on the routed model

The client now prices each response on the model the request was routed to, as the registry names
it. Providers often answer with a dated snapshot name the registry does not file. In 1.x, pricing on
that echo cost the call nothing, so OpenAI responses could show a cost of 0, and so could Groq, Mistral,
DeepSeek, and Cohere models filed under a prefix. Expect those costs to be priced in 2.0, and budgets
to count them. A charge the provider reports, with `basis: 'reported'`, is kept as it is.

## The model registry is current

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

## Claude 4.6 onward think adaptively

From the 4.6 generation on, Claude takes adaptive thinking and an effort level, not a thinking budget.
After 4.6 a budget is rejected, so 1.x requests with `reasoning` failed on those models. 2.0 sends what
each model accepts, and the [core guide](docs/core.md#reasoning) has the details. Nothing changes in
your code. From 4.7 on, Claude also rejects a non-default `temperature` or `topP`, so the client
drops one and records a capability warning.

## Tool calls reach providers whole

In 1.x the OpenAI, Anthropic, and Google adapters dropped a conversation's tool calls and the ids that
link results to them. A real tool loop could fail on its second turn. 2.0 sends both the way each API
expects. Nothing changes in your code.

Two things are new beside it. A tool can return `toolOutput()`, whose text, images, and asset
references go back as the tool message itself. And a model that produces images returns them on
`response.assets`.

## For provider authors

The provider contracts only grew:

- `BaseProvider.complete()` and `stream()` take a second, optional `ProviderCallContext`;
- voice and telephony provider methods take it too;
- `ImageProviderCallContext`, `EmbeddingProviderCallContext`, and `BatchProviderCallContext` extend it;
- `FamilyTelemetry.run()` hands its function the context, and takes an optional settle function.

A provider written for 1.x compiles unchanged.

## Runtime

2.0 runs on Node 22 and newer.
