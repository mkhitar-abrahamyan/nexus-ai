# Context hub

<!-- covers: ./context-hub -->

Everything an agent runs with, versioned together as one context bundle: the prompts it uses, its
instructions, the tools it is offered, its skills, and its settings.

You commit a bundle, label it, promote it through evaluation gates, diff it, roll it back, and export
it to another project. It is what the [prompt registry](./prompts.md) does for one prompt, applied to
the whole context around it.

```ts
import { PromptRegistry } from 'nexus-ai-pro/prompts/registry';
import { ContextHub, contextExperimentGate, evaluateContext } from 'nexus-ai-pro/context-hub';

const hub = new ContextHub({
  prompts: registry,
  gates: { production: [contextExperimentGate({ store: experiments, noRegression: true })] },
});

const bundle = await hub.commit(
  {
    name: 'support-agent',
    prompts: { answer: { name: 'support-answer', version: answer.version } },
    instructions: { policy: 'Never promise a refund.', tone: 'Be brief.' },
    tools: [{ name: 'lookup_order', description: 'Finds an order', parameters: orderSchema }],
    skills: { refunds: { description: 'Refund questions', instructions: 'Check the order first.' } },
    config: { model: 'gpt-5.4-mini' },
  },
  { message: 'Cite the order number', author: 'ana', label: 'staging' },
);

await evaluateContext(bundle, dataset, [correctness], runAgent, { store: experiments });
await hub.promote('support-agent', { from: 'staging', to: 'production', by: 'ana' });
```

## Bundles

A `ContextBundleDefinition` names the bundle and holds its parts, each optional:

- `prompts` pins prompts from the registry by role, each a `ContextPromptPin` of a prompt name and an
  exact content version, so a bundle never changes because a prompt label moved.
- `instructions` are named texts, such as a policy and a tone guide.
- `tools` are `ContextTool` definitions — a name, a description, and an argument schema. The bundle
  decides what the model may call; the implementations stay in code.
- `skills` are `ContextSkill` values: when a skill applies, how to do the task, and the reference
  material it needs.
- `config` holds settings the application reads, and `metadata` application data that is not part of
  the version.

`commit()` stores a definition as a `ContextBundle` under its content version: `c` and 12 hex digits
of a SHA-256 over every part but the metadata, which `contextVersion()` computes on its own. The same
content is always the same version, in any project, and committing unchanged content records
nothing. With a prompt registry, every pin must exist in it.

Using a bundle:

| Function | What it does |
| --- | --- |
| `get()` | Finds a version by content version, label, or `latest`. |
| `resolve()` | The same, with the `ContextReference` experiments and traces record. |
| `renderPrompt()` | Renders the prompt a bundle pins for a role, recording the bundle in the request's `metadata.context`. |
| `contextInstructions()` | Joins the instructions into one system text. |
| `bindTools()` | Turns the bundle's tools into callable tools, matching each to your implementation by name. An implementation the bundle does not offer is never exposed. |

```ts
const { bundle } = await hub.resolve('support-agent', 'production');
const agent = createAgent({
  client: ai,
  model: String(bundle.config?.model),
  systemPrompt: contextInstructions(bundle),
  tools: bindTools(bundle, { lookup_order: lookupOrder }),
});
```

## Labels, promotion, and history

Labels point at versions, and every change is recorded, as in the prompt registry.

| Method | What it does |
| --- | --- |
| `label()`, `unlabel()` | Point a label at a version without gates, or remove it. |
| `promote()` | Moves a label to a version — named directly, or whatever another label serves — once every gate agrees. Returns a `ContextPromotionResult` with each verdict. |
| `rollback()` | Moves a label back to where it pointed before. |
| `history()`, `versions()`, `labels()`, `names()` | Read the record. |

A refused promotion raises a `ContextPromotionError`, unless `force` is set; forcing is recorded in
the note. A `ContextLabel` and a `ContextHistoryEntry` have the same shapes as their prompt
counterparts.

A `ContextPromotionGate` is a function of a `ContextPromotionContext` — the bundle, the version being
promoted, the label, and what it serves now — that returns a verdict. Two come bundled:

- `contextExperimentGate()` refuses until an experiment has passed for the exact version, taking the
  same `ExperimentGateOptions` as the prompt gate: thresholds, a maximum number of failures, and
  `noRegression` against the version it would replace.
- `servedByContextGate()` requires another label, such as `staging`, to serve the version first.

`evaluateContext()` runs a bundle over a dataset. You give it a `ContextTarget`: your function that
builds a request from the bundle and runs it. The experiment records the bundle in
`metadata.context`, which is what the experiment gate looks for.

With an evaluation cache and no fingerprint, the bundle's version is the fingerprint. An unchanged
bundle is then scored from its stored outputs; see [evaluation](./evaluation.md#caching).

`ContextHubOptions` takes the `store`, the `prompts` registry, the `gates` by label, an `onChange`
callback for every recorded change, and a clock.

Errors are `ContextHubError` values with a stable code:

| Error | When |
| --- | --- |
| `ContextNotFoundError` | A bundle, version, or label does not exist. |
| `ContextConflictError` | A label moved while it was being changed. |
| `ContextDefinitionError` | A definition, pin, or import is invalid. |

## Diffs

`diff()` compares two versions or labels, and `diffContexts()` two bundles you already have. The
`ContextDiff` lists each `ContextChange` — an added, removed, or changed prompt pin, instruction,
tool, skill, or config key — with line diffs for text. `formatContextDiff()` writes it as text for a
terminal or a pull request.

## Moving bundles between projects

The hub keeps its state in a prompt store of its own, so every prompt adapter serves bundles:
`MemoryPromptStore`, Redis, Postgres, and `FilePromptStore`, which writes one reviewable JSON file per
version for version control.

`export()` writes a bundle version as one `ContextBundleExport` document, carrying every prompt
version it pins; `import()` commits those prompts into the other project's registry and then the
bundle. Each version is checked on the way in, so an export edited by hand is refused rather than
imported under a version that no longer describes it.

```ts
await writeFile('support-agent.json', JSON.stringify(await hub.export('support-agent', 'production')));
await otherHub.import(JSON.parse(await readFile('support-agent.json', 'utf8')), { label: 'staging' });
```

## Limitations

- A bundle pins prompt versions; it does not follow prompt labels. Commit a new bundle version to
  take a new prompt version, which is what makes a bundle reproducible.
- A bundle is versioned by its content, not signed. An import checks that the content is what was
  exported, not who exported it.
- A traced model call records the prompt version it was rendered from, but not the bundle's.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/context-hub`

| Export | Kind | Summary |
| --- | --- | --- |
| `bindTools` | function | A bundle's tools as tool definitions an agent can call: each definition from the bundle, each implementation from your code, matched by name. |
| `ContextBundle` | interface | A committed bundle version. |
| `ContextBundleDefinition` | interface | Everything an agent runs with, versioned together: pinned prompts, named instructions, tool definitions, skills, and configuration. |
| `ContextBundleExport` | interface | A bundle with the prompts it pins, as one document that moves between projects. |
| `ContextChange` | interface | One entry that differs between two bundle versions. |
| `ContextConflictError` | class | Raised when a label moved while it was being changed. |
| `ContextDefinitionError` | class | Raised when a bundle definition, a pin, or an import is invalid. |
| `ContextDiff` | interface | What changed between two versions of a bundle. |
| `contextExperimentGate` | function | Refuses a promotion until an experiment has passed for the exact bundle version being promoted, as `experimentGate()` does for prompts: an experiment counts when its `metadata.context` names the version, which `evaluateContext()` records. |
| `ContextHistoryEntry` | type | One recorded change to a bundle. |
| `ContextHub` | class | Versioned context bundles: prompts, instructions, tool sets, and skills versioned together, labelled, promoted through gates, diffed, rolled back, and exported to move between projects. |
| `ContextHubError` | class | Base class for context hub errors, each with a stable `code`. |
| `ContextHubOptions` | interface | Options for a `ContextHub`. |
| `contextInstructions` | function | A bundle's instructions joined into one system text, in the order the bundle lists them, or only the ones named in `include`, in that order. |
| `ContextLabel` | type | A label pointing at a bundle version. |
| `ContextNotFoundError` | class | Raised for a bundle, version, or label that does not exist. |
| `ContextPromotionContext` | interface | What a context promotion gate is asked to judge. |
| `ContextPromotionError` | class | Raised when a gate refuses a promotion. |
| `ContextPromotionGate` | type | Decides whether a bundle version may be promoted to a label. |
| `ContextPromotionResult` | interface | The outcome of a promotion. |
| `ContextPromptPin` | interface | A prompt a bundle uses, pinned to one content version of the prompt registry. |
| `ContextReference` | interface | Which bundle version is being used, as experiments and traces record it. |
| `ContextSkill` | interface | A skill: instructions for one kind of task, with the reference material it needs. |
| `ContextTarget` | type | Runs one example with a bundle: build the request from it, call the model or agent, return the output. |
| `ContextTool` | interface | A tool a bundle offers: its name, description, and argument schema. |
| `contextVersion` | function | The content version of a bundle: `c` and the first 12 hex digits of a SHA-256 over its name, description, prompts, instructions, tools, skills, and configuration. |
| `diffContexts` | function | Compares two versions of a bundle, entry by entry, with line diffs for text. |
| `evaluateContext` | function | Runs a bundle version over a dataset and scores it. |
| `formatContextDiff` | function | A diff as text, one line per change and `+`/`-` lines for text, for a terminal or a pull request. |
| `servedByContextGate` | function | Refuses a promotion unless the version is what another label serves now, such as `staging` before `production`. |
<!-- reference:end -->
