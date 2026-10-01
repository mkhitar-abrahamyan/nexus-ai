# Migrating to 2.0

2.0.0 removes what the 1.x line deprecated. Everything you need to get ready ships in 1.25, so you can
migrate while you are still on 1.x. Nothing below breaks before 2.0.

Start with the codemod. It rewrites what it can safely, and lists the rest:

```bash
npx nexus migrate src           # reports what would change
npx nexus migrate src --write   # rewrites the files
npx nexus migrate src --check   # exits 1 while anything is left, for CI
```

Then run your tests with `node --throw-deprecation`. Every deprecated option warns once per process,
so a clean run means nothing you call is going away.

| Change | The codemod | By hand |
| --- | --- | --- |
| [The root import keeps only the core](#the-root-import-keeps-only-the-core) | Rewrites the imports | Namespace and dynamic imports of the root |
| [`estimatedCost` is removed](#a-responses-estimatedcost-is-removed) | Lists each read | Read `cost.amount` |
| [`ImageManagerConfig` is removed](#imagemanagerconfig-is-removed) | Renames it | — |
| [Options that were never read are removed](#options-that-were-never-read-are-removed) | — | Delete them; each warns today |
| [Modalities say which way they flow](#modalities-say-which-way-they-flow) | — | Set the two new fields |
| [Checkpoints gain ids and lose `interrupt`](#checkpoints-gain-ids-and-lose-interrupt) | — | Read `interrupts` |
| [Validators and Node types become optional](#validators-and-node-types-become-optional) | — | Install what you use |
| [Planned, not yet final](#planned-not-yet-final) | — | Nothing yet |

## The root import keeps only the core

In 2.0, `nexus-ai-pro` exports the core client and nothing else. That is:

- `NexusAI`, `createNexus`, and the config builders;
- `tool()`, the streaming helpers, and the usage and pricing helpers for custom providers;
- the types of the client's configuration, requests, and responses;
- the errors the client throws: `NexusProviderError`, `NexusSecurityError`, `NexusRateLimitError`,
  `NexusCapabilityError`, `TokenBudgetError`, `CostBudgetError`, and `ResponseFormatError`.

Every other export is on its own subpath already. In 1.25 each one is deprecated on the root, and your
editor strikes it through with the subpath to use.

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
so it lists them. Import each name you use from its subpath instead. Every subpath and what it costs to
install is in the [packaging guide](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/packaging.md).

The smaller root is the point: an application that uses one family no longer loads the client, its
validators, or the model registry.

## A response's `estimatedCost` is removed

The formatted string on a response's metadata goes. Read the numeric cost and format it yourself:

```ts
// Before
console.log(response.meta.estimatedCost); // '$0.0012'

// After
const cost = response.meta.cost;
if (cost) console.log(new Intl.NumberFormat('en-US', { style: 'currency', currency: cost.currency }).format(cost.amount));
```

A plan's `estimatedCost`, from `ai.plan()`, is an object and stays.

## `ImageManagerConfig` is removed

It was an alias of `ImageConfig`. The codemod renames the import and keeps your local name.

## Options that were never read are removed

These were accepted and ignored. Each one already warns once per process when it is set.

| Option | Deprecated in |
| --- | --- |
| `GoogleProviderConfig.projectId` | 1.16.0 |
| `OllamaProviderConfig.timeout` | 1.16.0 |
| `MetricsConfig.prometheus` | 1.16.0 |
| `DensificationConfig.preserveMarkdown` | 1.16.0 |
| `HealthConfig.latencyHalfLife` | 1.16.0 |
| `InjectionDetectionConfig.sensitivity` | 1.19.0 |
| `ToolPolicyConfig.requiresApproval` | 1.19.0 |

Delete them. Nothing changes, because nothing read them.

## Modalities say which way they flow

A model's `modalities` list mixed inputs and outputs: `vision` meant an image in, and `image` meant an
image out. 2.0 replaces it with `inputModalities` and `outputModalities`, which 1.25 already reads.

```ts
// A model you define, before
models: { registry: { 'my-model': { modalities: ['text', 'vision'], /* … */ } } }

// After: keep modalities until 2.0, and add the two new fields
models: {
  registry: {
    'my-model': { modalities: ['text', 'vision'], inputModalities: ['text', 'image'], outputModalities: ['text'], /* … */ },
  },
}
```

Read either shape through `modalitiesOf()` from `nexus-ai-pro/models`. In routing requirements, replace
`modalities` with `inputModalities` or `outputModalities`; the old field warns once.

## Checkpoints gain ids and lose `interrupt`

The 2.0 checkpoint schema gives every checkpoint an id and its pending tasks, and keeps questions only
in `interrupts`. Both checkpointers keep reading 1.x checkpoints throughout 2.x, so stored threads
resume.

```ts
// Before
const question = checkpoint.interrupt;

// After
const [question] = checkpoint.interrupts ?? [];
```

To write code against the 2.0 shape today, read checkpoints through `migrateCheckpoint()` from
`nexus-ai-pro/graph`, which returns it from either schema.

## Validators and Node types become optional

`zod`, `ajv`, and `ajv-formats` become optional peer dependencies, and so does `@types/node`. The target is
that a graph-only application installs at most 3.5 MB, instead of about 10 MB today.

If you validate with schemas, or compile TypeScript against Node's types, add what you use:

```bash
npm install zod ajv ajv-formats
npm install --save-dev @types/node
```

The 2.0 release notes list exactly which calls need each one.

## Planned, not yet final

These are designed during the 2.0 cycle. This guide gains their before-and-after code when they land.

- **One lifecycle for every operation.** Completions, streams, embeddings, voice, images, jobs, graphs,
  and agents share authorization, budgets, hooks, audit, metrics, and tracing. Custom providers receive
  a `ProviderCallContext` with the abort signal, deadline, request id, trace context, and idempotency key.
- **Typed pipeline contexts.** `PipelineContext` becomes generic over its request and response, and
  `PipelineStepName` lists only the built-in steps.
- **Mixed outputs.** A tool result can carry asset references instead of base64 JSON.

## Runtime

2.0 runs on Node 22 and newer. If it ships after Node 22's end of life in April 2027, the floor moves to
Node 24.
