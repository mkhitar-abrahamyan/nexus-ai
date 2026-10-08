# Contributing

Thanks for improving `nexus-ai-pro`.

## Development setup

Use Node.js 22 or 24 and the npm version declared in `package.json`.

```bash
npm ci
npm run check
```

Before opening a release-related change, also run:

```bash
npm run check:release
```

The tagged trusted-publishing procedure and one-time npm configuration are documented in
[RELEASING.md](./RELEASING.md).

Real-provider conformance tests are optional and require your own credentials:

```bash
npm run test:conformance:real
```

The vector store contract runs against real Qdrant, Pinecone, Weaviate, Chroma, and Redis servers
when their variables are set; the variables are listed at the top of `tests/vector-stores.live.ts`:

```bash
npm run test:vectors:live
```

Never commit provider keys, user data, generated tarballs, or local environment files.

## Generated files

These files are generated and committed. CI fails when one no longer matches its source, so
regenerate it in the change that edits the source.

| File | Generated from | Command |
| --- | --- | --- |
| `src/models/generated.ts` | `data/models/*.json` | `npm run registry:generate` |
| The reference at the end of each guide | The doc comments | `npm run docs:update` |
| `llms.txt` and `llms-full.txt` | The README and the guides | `npm run llms:generate`, which `docs:update` also runs |
| The size table in `docs/packaging.md` and the runtimes table in `docs/runtimes.md` | The built package's import graph | `npm run size:update`, before `docs:update` |


## Running real-provider tests

Mock conformance runs everywhere. Real-provider conformance is opt-in and needs your own keys.

The `live-providers` workflow runs it every week, and on demand, for each provider whose key is set
as a repository secret: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`,
`MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `COHERE_API_KEY`, and `OPENROUTER_API_KEY`. A provider without a key is skipped.
When a run fails, the workflow opens an issue, or comments on the open one, so a provider that changed
its API is caught before a release rather than by users. It never runs on pull requests, so forks never
see the keys.

```bash
npm run test:conformance:real
```

```powershell
$env:OPENAI_API_KEY="your_key"
$env:ANTHROPIC_API_KEY="your_key"
$env:GOOGLE_API_KEY="your_key"
$env:GROQ_API_KEY="your_key"
$env:MISTRAL_API_KEY="your_key"
$env:COHERE_API_KEY="your_key"
$env:OPENROUTER_API_KEY="your_key"
```

Local Ollama tests need a running server and a pulled model:

```bash
ollama serve
ollama pull llama3.2
```

Real conformance skips a provider whose credentials are missing rather than failing the suite.

## Adding a public feature

The automated checks catch a missing export but not a half-wired one, so work through this list:

- add the type and value exports to `src/index.ts`;
- add a `package.json` subpath when the feature is an optional integration, and keep it out of the
  root export so it stays opt-in;
- update `tests/api-contract.mjs`, `tests/package-smoke.mjs`, and `tests/type-consumer.mjs` when the
  public surface changes;
- add focused unit tests, including the smallest and largest realistic call;
- run `npm run size:update` when the import graph changes, and check the diff: a jump in an unrelated
  entry point means a shared module reached somewhere it should not have;
- keep the client, the kernel, the provider adapters, graphs, agents, and the agent protocols free of
  Node built-ins and Node globals. `npm run test:portable` checks every entry point's imports and
  runs the kernel's tests on Node.js and an edge runtime, and CI runs them on Deno and Bun as well;
- keep a graduated surface within its load and soak budgets: `npm run bench:surfaces`, which
  `check:release` runs. After a deliberate change to a hot path, record new budgets with
  `npm run bench:surfaces -- --update`, and say why in the change;
- document the feature once, in the most relevant README section, rather than in several places;
- record the change under `Unreleased` in `CHANGELOG.md`;
- follow `API_STABILITY.md`, and state any new guarantee there explicitly.

For a new provider family, start with provider-neutral request and response types, add a
deterministic mock and a conformance harness before any hosted adapter, and route the family through
`FamilyTelemetry` so it reports into the same metrics, audit log, and rate limiter as the rest.

## Manual smoke checklist

`npm run check:release` covers the automated gates. Before publishing, it is still worth exercising a
few paths by hand against real credentials:

- a direct completion, and one through `model: 'auto'` routing;
- a streamed response, and a strict JSON response format;
- a blocked prompt-injection input and a PII redaction in output;
- a long chat that triggers context-window compaction;
- an exact cache hit, and a semantic one if embeddings are configured;
- an embedding call, and a RAG answer with citations;
- an agent tool call that reaches its iteration cap;
- `ai.plan(...)` on an over-large prompt;
- imports from the package root and from a subpath.

## Changes

- Keep changes focused and add a regression test for behavior fixes.
- Add root exports only for broadly useful APIs; prefer a focused explicit subpath for optional integrations.
- Update the package smoke, API contract, and external type-consumer checks when the public surface changes.
- Document user-visible changes under `Unreleased` in `CHANGELOG.md`.
- Follow `API_STABILITY.md` when changing public types or behavior.

By contributing, you agree that your contribution is licensed under the MIT license used by this project.
