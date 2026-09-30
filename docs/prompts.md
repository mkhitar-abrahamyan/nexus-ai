# Prompts: templates, versions, promotion, and serving

<!-- covers: ./prompts ./prompts/client ./prompts/registry ./prompts/file ./prompts/redis -->

Prompts that ship like code:

- **Templates** whose variables are typed from their text.
- **Versions** derived from their content.
- **Labels**, such as `staging` and `production`, that move only when their gates agree.
- **A serving client** that keeps answering through a registry outage.

The family is split by what a process does, so each process pays only for its part:

| Entry point | For | Size |
| --- | --- | --- |
| `nexus-ai-pro/prompts` | Defining and rendering prompts. | Smallest. |
| `nexus-ai-pro/prompts/client` | Serving prompts by label in an application. | Small. |
| `nexus-ai-pro/prompts/registry` | Committing, promoting, comparing, and evaluating, in CI and admin scripts. | Larger. |
| `nexus-ai-pro/prompts/file`, `/prompts/redis`, `nexus-ai-pro/postgres/prompts` | Where versions and labels live. | Each on its own. |

None of them imports a third-party package. `/prompts` and `/prompts/client` run without Node's APIs.

## Templates

`definePrompt()` compiles a prompt once. Its variables are read from the template text, so `render()`
is type-checked. A variable without a default is required, and a misspelled one is a compile-time
error, not a blank in production.

```ts
import { definePrompt } from 'nexus-ai-pro/prompts';

const summarize = definePrompt({
  name: 'summarize',
  messages: [
    { role: 'system', content: 'You summarize {{kind}} for {{audience}}. {{> tone}}' },
    { placeholder: 'history', optional: true },
    { role: 'user', content: '{{ticket.body}}' },
  ],
  partials: { tone: 'Keep it {{tone}}.' },
  defaults: { audience: 'engineers', tone: 'brief' },
  config: { model: 'gpt-5.4-mini', temperature: 0 },
});

const request = summarize.render({ kind: 'incident reports', ticket: { body: text } });
const response = await ai.complete(request);
```

| Syntax | What it does |
| --- | --- |
| `{{name}}`, `{{name.path}}` | Inserts a value. Objects render as JSON. |
| `{{> partial}}` | Includes a named fragment. Partials may include partials. |
| `{ placeholder: 'history' }` | Inserts whole messages, such as the conversation so far. Required unless `optional` is set. |

An unknown partial, a cycle, or a malformed tag fails when the prompt is defined, not when it is first
rendered. There is no escape syntax: to render a literal `{{`, pass it in through a variable.

- `config` holds any completion field: model, temperature, output format, tools. It is versioned with
  the prompt. `overrides` in the render options replace it for one call, and `model` supplies a model
  when neither names one.
- A missing variable throws `PromptRenderError`, naming every missing variable. `missing: 'empty'`
  renders it as an empty string, and `missing: 'keep'` leaves the tag in place.
- The rendered request records `metadata.prompt`: the name, and, from a registry, the version, label,
  and A/B arm.
- `TemplateVariables` gives the variable names of any template string. `PromptInput` gives a prompt's
  render input.

`compilePrompt()` and `renderCompiled()` are the two halves of `render()`, for code that manages its
own compiled cache.

## Versions

A version is derived from content. `promptVersion()` hashes the name, messages, partials,
configuration, and defaults. It hashes a canonical encoding, `canonicalJson()`, so key order never
changes it. Metadata is not part of it.

So the same prompt has the same version in a test, in CI, and in production. `prompt.version()` gives
the version a registry will assign, before anything is committed. Hashing uses Web Crypto, so the value
is the same in Node, a browser, and an edge runtime.

## The registry

`PromptRegistry`, from `nexus-ai-pro/prompts/registry`, stores versions and moves labels. It keeps no
state beyond a compiled cache, so any number of processes can share one store.

```ts
import { PromptRegistry, experimentGate, servedByGate } from 'nexus-ai-pro/prompts/registry';
import { PostgresPromptStore } from 'nexus-ai-pro/postgres/prompts';

const registry = new PromptRegistry({
  store: new PostgresPromptStore(pool),
  gates: {
    production: [
      servedByGate('staging'),
      experimentGate({ store: experiments, thresholds: { correctness: 0.9 }, noRegression: true }),
    ],
  },
});

const version = await registry.commit(summarize, { message: 'Tighter tone', author: 'ada', label: 'staging' });
await registry.promote('summarize', { from: 'staging', to: 'production', by: 'ada' });
```

| Method | What it does |
| --- | --- |
| `commit()` | Stores a definition under its content version. Unchanged content returns the existing version and records nothing, so a deploy can commit every prompt. |
| `get()` | Reads by version, by label, or `latest`. |
| `resolve()`, `render()` | The same, for serving. They choose an A/B arm by key. |
| `label()`, `unlabel()` | Point a label at a version without gates, or remove it. |
| `promote()` | Moves a label once every gate for the destination allows it. |
| `rollback()` | Moves a label back to where it pointed before its last change. |
| `split()` | Shares a label's traffic between versions, for an A/B test. The first arm is the control. |
| `history()` | Every change, newest first, optionally for one label. |
| `versions()`, `labels()`, `names()` | List the rest. |

A refused promotion throws `PromptPromotionError`, with each gate's verdict. `force: true` promotes
anyway and records which gates were overridden. `promote()` returns a `PromotionResult`, with
`changed: false` when the label already served the version.

`chooseVariant()` gives each key the same A/B arm every time.

Labels are written with compare-and-set. When another process moved a label in the meantime, the
change is refused with `PromptConflictError`, not overwritten.

### Hearing about changes

- `onChange` is called after each change.
- `webhooks` post changes — `promote`, `rollback`, and `split` by default — signed like operation
  webhooks. `deliverPromptWebhook()` sends one, and a receiver checks it with `verifyPromptWebhook()`.
- A failing receiver is reported to `onWebhookError`. It never fails the change.

### Errors

Every error extends `PromptError` and has a stable `code`:

| Error | When |
| --- | --- |
| `PromptDefinitionError` | A definition is malformed. |
| `PromptRenderError` | A variable is missing. |
| `PromptNotFoundError` | No prompt, version, or label by that name. |
| `PromptConflictError` | Another process moved the label first. |
| `PromptPromotionError` | A gate refused. Its `results` list each `GateResult`. |

## Promotion gates

A gate is a function of a `PromotionContext` that returns a `GateResult`. The context holds the
version, the label it goes to, the version that label serves now, and the registry. Two gates are
bundled:

- `experimentGate()` requires a passing experiment for the exact version being promoted, one whose
  `metadata.prompt` names it. `ExperimentGateOptions` can also require an experiment name or dataset.
  `thresholds` sets a minimum mean per metric, and `maxErrors` the examples that may fail outright.
  `noRegression` compares with the newest experiment for the version being replaced, and refuses a
  change that is worse beyond noise.
- `servedByGate()` requires the version to be what another label serves, such as staging before
  production.

Any function with the `PromotionGate` signature works as a gate: a human approval recorded elsewhere,
a check on the model's price, or a freeze window.

## Evaluating a version

`evaluatePrompt()` is the headless playground. It renders a prompt for each example, runs it through a
client, and scores it with ordinary evaluators. It returns an experiment tagged with the prompt's name
and version: the tag `experimentGate()` looks for.

```ts
import { evaluatePrompt } from 'nexus-ai-pro/prompts/registry';
import { createDataset, contains, FileExperimentStore } from 'nexus-ai-pro/evaluate';

const experiment = await evaluatePrompt(version, dataset, [contains(['refund'])], {
  client: ai,
  store: new FileExperimentStore('./experiments'),
  variables: (inputs) => ({ kind: 'support tickets', ticket: inputs }),
});
```

`EvaluatePromptOptions` accepts everything `evaluate()` does, plus two fields:

- `variables` maps an example's inputs to template variables.
- `render` passes render options, such as a model override. That is how one prompt is compared across
  models.

With an evaluation `cache` and no `fingerprint`, the prompt version and render options are the
fingerprint. So re-evaluating an unchanged version re-scores its stored outputs. Pass your own
fingerprint when the client or model changes. The evaluation runtime loads only when
`evaluatePrompt()` runs.

To version a prompt together with the instructions, tools, and skills around it, use the
[context hub](./context-hub.md). A bundle pins prompt versions from this registry, and is promoted the
same way.

## Comparing versions

`diff()` on the registry, or `diffPrompts()` on two versions, compares them. Messages are compared line
by line; partials, configuration, and defaults field by field. `formatPromptDiff()` renders the result
for a terminal or a pull-request comment, and `diffLines()` is the line diff underneath.

A `PromptDiff` holds a `PromptMessageDiff` per message, made of `PromptLineChange` lines, and a
`PromptFieldChange` per changed field.

## Serving

`PromptClient`, from `nexus-ai-pro/prompts/client`, serves prompts by label to application code.

```ts
import { PromptClient } from 'nexus-ai-pro/prompts/client';

const prompts = new PromptClient({
  source: new PostgresPromptStore(pool),
  label: 'production',
  ttlMs: 60_000,
  fallbacks: [summarize],
  onError: (error, name) => logger.warn({ error, name }, 'prompt refresh failed'),
});

const request = await prompts.render('summarize', { kind: 'tickets', ticket }, { key: user.id });
```

How it stays fast and up:

- A label is read from the source at most once per `ttlMs`.
- For `staleWhileRevalidateMs` after that, calls are answered from cache while the label refreshes in
  the background. Concurrent refreshes share one request.
- When the source is unreachable, the last version seen keeps serving, however old, unless
  `serveStaleOnError` is off.
- A process that starts during an outage serves its `fallbacks`: the definitions bundled in code.
- A split label picks its arm by `key`, so the same user sees the same version every time.

`get()` returns a `ServedPrompt`. It says which version was served, and whether it came from cache, a
stale cache, the source, or a fallback. `refresh()` rereads a label now, and `clear()` forgets
everything.

The source needs only `getLabel()` and `getVersion()`. Any `PromptStore` fits, or a `PromptSource` of
your own, such as an HTTP endpoint in front of the registry.

## Stores

A `PromptStore` holds versions, labels, and history. Versions are immutable and keyed by content, so
saving one twice is harmless. Labels are the only mutable state, and `setLabel()` compares before it
writes.

| Store | Entry point | Use it for |
| --- | --- | --- |
| `MemoryPromptStore` | `/prompts/registry` | Tests, and prompts defined in code in one process. |
| `FilePromptStore` | `/prompts/file` | Prompts in version control: one reviewable JSON file per version and label. |
| `RedisPromptStore` | `/prompts/redis` | Sharing between processes. Label compare-and-set is one Lua call when the client has `eval`. |
| `PostgresPromptStore` | `/postgres/prompts` | Sharing between processes, with the schema from `promptStoreMigration()`. |

`RedisPromptLikeClient` lists the Redis commands the adapter needs, in `ioredis` argument order, so no
Redis client becomes a dependency. `MemoryPromptStoreOptions`, `RedisPromptStoreOptions`, and
`PostgresPromptStoreOptions` set the history length, key prefixes, and table names.

## Traces

A model call wrapped with `traceModelClient()` from `nexus-ai-pro/tracing` records the rendered
request's `metadata.prompt` on its run. So a trace answers which prompt version produced an output, and
a trace query can filter on it.

## Types

| Type | What it is |
| --- | --- |
| `PromptDefinition` | Everything that defines a prompt. |
| `PromptVersion` | A committed prompt, with its version, variables, and provenance. |
| `PromptMessage` | A `PromptMessageTemplate`, or a `PromptMessagePlaceholder` whose variable holds `PlaceholderMessages`. |
| `PromptModelConfig` | The versioned request configuration. |
| `RenderOptions` | Configures one render. |
| `RenderedPrompt`, `PromptReference` | The result of a render, and the reference it records. |
| `PromptLabel`, `PromptVariant` | A label, and one arm of a split. |
| `PromptHistoryEntry`, `PromptHistoryAction` | One recorded change, and what kind it was. |
| `Prompt`, `PromptSpec` | What `definePrompt()` returns, and what it takes. |
| `CompiledPrompt`, `CompiledMessage` | What `compilePrompt()` produces. |
| `ResolvedPrompt` | What `resolve()` returns. |
| `PromptRegistryOptions`, `PromptWebhookConfig`, `PromptClientOptions` | Configure the registry, its webhooks, and the client. |

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/prompts`

| Export | Kind | Summary |
| --- | --- | --- |
| `canonicalJson` | function | JSON with object keys sorted, so the same content always encodes the same way. |
| `chooseVariant` | function | Picks an A/B arm for a key, the same arm every time for the same key, prompt, and label. |
| `CompiledMessage` | type | A message template reduced to text and variable lookups, with partials already inlined. |
| `CompiledPrompt` | interface | A definition compiled for rendering. |
| `compilePrompt` | function | Compiles a definition: parses every template, inlines partials, and lists the variables. |
| `definePrompt` | function | Defines a prompt, typing its variables from the template text. |
| `GateResult` | interface | The verdict of one promotion gate. |
| `PlaceholderMessages` | type | A message placeholder's content, as the variable must supply it. |
| `Prompt` | interface | A defined prompt, compiled once and rendered many times. |
| `PromptConflictError` | class | Raised when a label moved while it was being changed, so the change was not applied. |
| `PromptDefinition` | interface | Everything that defines a prompt. |
| `PromptDefinitionError` | class | Raised when a definition is invalid: an unknown or recursive partial, or a malformed placeholder. |
| `PromptError` | class | Base class for prompt errors, each with a stable `code`. |
| `PromptHistoryAction` | type | What happened to a prompt, as recorded in its history. |
| `PromptHistoryEntry` | interface | One recorded change to a prompt. |
| `PromptInput` | type | What `render()` takes for a prompt with variables `V`, placeholders `H`, and defaults `D`: every variable without a default is required, and placeholders take arrays of messages. |
| `PromptLabel` | interface | A label, such as `production` or `staging`, pointing at a version or splitting traffic between several. |
| `PromptMessage` | type | A message template or a placeholder for messages. |
| `PromptMessagePlaceholder` | interface | A slot filled with whole messages at render time, such as the conversation so far. |
| `PromptMessageTemplate` | interface | One message of a prompt template, whose content may contain `{{variable}}` and `{{> partial}}`. |
| `PromptModelConfig` | type | Request settings versioned with the prompt: model, temperature, output format, tools, and any other completion field except the messages the template renders. |
| `PromptNotFoundError` | class | Raised when a prompt, a version, or a label does not exist. |
| `PromptPromotionError` | class | Raised when a gate refuses a promotion. |
| `PromptReference` | interface | Which prompt a request was rendered from, as recorded on the request and in traces. |
| `PromptRenderError` | class | Raised when rendering is missing variables and `missing` is `error`, the default. |
| `PromptSpec` | interface | The input `definePrompt()` infers variable names from. |
| `PromptStore` | interface | Where prompt versions, labels, and history live. |
| `PromptVariant` | interface | One arm of an A/B split. |
| `promptVersion` | function | The content version of a definition: `p` and the first 12 hex digits of a SHA-256 over its name, messages, partials, configuration, and defaults. |
| `PromptVersion` | interface | A committed prompt: a definition with its content version and where it came from. |
| `renderCompiled` | function | Renders a compiled prompt into a completion request, recording `reference` in `metadata.prompt`. |
| `RenderedPrompt` | type | The rendered request, with the prompt it came from recorded in `metadata.prompt`. |
| `RenderOptions` | interface | Options for rendering a prompt. |
| `TemplateVariables` | type | The variables a template string uses, as a union of names: `'topic' \| 'user'` for `"Write about {{topic}} for {{user.name}}"`. |

### `nexus-ai-pro/prompts/client`

| Export | Kind | Summary |
| --- | --- | --- |
| `PromptClient` | class | Serves prompts by label to application code, fast and through outages. |
| `PromptClientOptions` | interface | Options for a prompt client. |
| `PromptSource` | type | The read side of a prompt store, which is all serving needs. |
| `ServedPrompt` | interface | A version chosen for one call, and how it was obtained. |

### `nexus-ai-pro/prompts/file`

| Export | Kind | Summary |
| --- | --- | --- |
| `FilePromptStore` | class | Prompts as files in a directory: one reviewable JSON file per version and per label, and one history log per prompt. |

### `nexus-ai-pro/prompts/redis`

| Export | Kind | Summary |
| --- | --- | --- |
| `RedisPromptLikeClient` | interface | The Redis commands the prompt store needs, in `ioredis` argument order. |
| `RedisPromptStore` | class | Prompt versions, labels, and history in Redis, shared by every process that serves prompts. |
| `RedisPromptStoreOptions` | interface | Options for the Redis prompt store. |

### `nexus-ai-pro/prompts/registry`

| Export | Kind | Summary |
| --- | --- | --- |
| `deliverPromptWebhook` | function | Posts one prompt change to a webhook. |
| `diffLines` | function | Line diff by longest common subsequence. |
| `diffPrompts` | function | Compares two versions of a prompt. |
| `evaluatePrompt` | function | Runs a prompt version over a dataset and scores it: the headless playground. |
| `EvaluatePromptOptions` | interface | Options for `evaluatePrompt()`: everything `evaluate()` takes, plus the model client and how inputs become variables. |
| `experimentGate` | function | Refuses a promotion until an experiment has passed for the exact version being promoted. |
| `ExperimentGateOptions` | interface | Options for `experimentGate()`. |
| `formatPromptDiff` | function | A diff as text, for a terminal, a log, or a pull-request comment. |
| `MemoryPromptStore` | class | Prompt versions, labels, and history in process memory. |
| `MemoryPromptStoreOptions` | interface | Options for the in-memory prompt store. |
| `PromotionContext` | interface | What a promotion gate is asked to judge. |
| `PromotionGate` | type | Decides whether a version may be promoted to a label. |
| `PromotionResult` | interface | The outcome of a promotion. |
| `PromptDiff` | interface | What changed between two versions of a prompt. |
| `PromptFieldChange` | interface | A field of partials, configuration, or defaults that differs. |
| `PromptLineChange` | interface | One line of a message diff: kept, added, or removed. |
| `PromptMessageDiff` | interface | How one message, by position, changed. |
| `PromptRegistry` | class | Versions prompts and moves labels between them. |
| `PromptRegistryOptions` | interface | Options for a prompt registry. |
| `PromptWebhookConfig` | interface | A webhook notified when prompts change, signed as operation webhooks are. |
| `ResolvedPrompt` | interface | A version resolved for serving, with the reference recorded on requests rendered from it. |
| `servedByGate` | function | Refuses a promotion unless the version is what another label serves now, such as requiring `staging` before `production`. |
| `verifyPromptWebhook` | function | Verifies a prompt webhook delivery against its `x-nexus-signature` header. |
<!-- reference:end -->
