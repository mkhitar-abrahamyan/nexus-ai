# nexus-ai-pro

The typed AI framework for TypeScript. One API for provider routing and failover, agent graphs that
run branches in parallel and survive a restart, durable background operations, guardrails, cost
control, images, voice, and evals.

Import the whole runtime, or one piece: every capability has its own entry point with a size budget
CI enforces, and [the packaging guide](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/packaging.md) publishes what each one costs. A graph-only application loads 49 KB
and installs no third-party package at all.

- NPM: https://www.npmjs.com/package/nexus-ai-pro
- GitHub: https://github.com/mkhitar-abrahamyan/nexus-ai
- Contributing, testing, and release procedure: [CONTRIBUTING.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/CONTRIBUTING.md)
- Delivered work and what is planned next: [ROADMAP.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/ROADMAP.md)

## Install

```bash
npm install nexus-ai-pro
```

Requires Node.js 22 or newer. The package is authored as ESM and ships both an ESM and a CommonJS build,
so `import` and `require()` both work — including from NestJS and other apps compiled with
`"module": "commonjs"`. Types are shared between both builds.
The main Nexus pipeline is Node-oriented; the isolated realtime subpaths use portable structural
interfaces and can be bundled for modern browsers.

Install only the provider SDKs your app uses. The OpenAI SDK also powers OpenAI-compatible adapters such as OpenRouter, Groq, Mistral, DeepSeek, Azure OpenAI, LM Studio, and llama.cpp.

```bash
npm install openai @anthropic-ai/sdk ollama
```

The Google Gemini provider uses Node.js `fetch`, so it does not need an extra SDK.
Realtime transports use injected or platform WebRTC, WebSocket, and `fetch` interfaces and do not
require the OpenAI SDK.

## Quick Start

```ts
import { createNexus } from 'nexus-ai-pro';

const ai = createNexus({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-5.4-mini',
  security: 'standard',
});

const response = await ai.complete({
  model: 'auto',
  messages: [{ role: 'user', content: 'Explain RAG in 3 bullet points.' }],
});

console.log(response.content);
console.log(response.meta.providerUsed);
console.log(response.meta.modelUsed);
```

For a fuller typed config, use the builder:

```ts
import { createNexusConfig } from 'nexus-ai-pro';

const ai = createNexusConfig()
  .openai(process.env.OPENAI_API_KEY!)
  .anthropic(process.env.ANTHROPIC_API_KEY!)
  .deepseek(process.env.DEEPSEEK_API_KEY!)
  .lmstudio({ baseUrl: 'http://localhost:1234/v1' })
  .auto('quality')
  .security('standard')
  .retry({ enabled: true, maxRetries: 2 })
  .create();
```

You can still pass a plain `NexusAIConfig` to `new NexusAI(...)` when you want full object-literal control.

## Why Use It

`nexus-ai-pro` is useful when an app needs more than a direct SDK call:

- route across multiple providers and model aliases
- fail over on provider errors, timeouts, or unhealthy providers
- stream through one normalized interface
- protect inputs and outputs with guardrails
- compact long conversations before they hit model limits
- estimate tokens and cost before provider calls
- cache exact or semantically similar prompts
- add tools, agents, RAG context, evals, batch jobs, and queues
- embed text through the same routing, caching, batching, budget, retry, and metrics as a completion
- run long operations that survive a restart, with leases, retries, dead-lettering, and signed webhooks
- build stateful graphs with cycles, fan-out, subgraphs, human approval, and resumable checkpoints
- trip routing away from a failing provider, and share one rate-limit budget across workers
- reach the providers' half-price asynchronous batch tier behind one operation handle
- persist generated media to disk or S3 with tenant isolation, retention, and checksums
- build persistent realtime voice agents with interruption, live tools, and normalized conversation state
- keep TypeScript types around every request and response

## Guides

Each feature has its own guide, covering every export of its entry points with a reference generated
from the doc comments. The guides live in the repository, so these links go to GitHub.

| Guide | Covers |
| --- | --- |
| [The client](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/core.md) | Requests, context windows, token optimization, cost checks, reasoning, prompt caching, streaming |
| [Providers and routing](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/providers.md) | The twelve completion providers, routing and failover, the model registry |
| [Guardrails](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/security.md) | Injection, PII, secrets, schema validation, output redaction |
| [Graphs](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/graphs.md) | Parallel branches, interrupts, checkpoints, time travel, subgraphs, caching, diagrams |
| [Agents and tools](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/agents.md) | Graph-based agents with approvals and middleware, and the simple tool loop |
| [Long-term memory](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/memory.md) | Namespaced memory with semantic search, in memory or Redis |
| [MCP](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/mcp.md) | Borrowing tools from MCP servers and serving your own |
| [Traces](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/tracing.md) | Run trees, queries, feedback, comparison, and alerts |
| [Evaluation](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/evaluation.md) | Datasets, evaluators, experiments, comparisons with a verdict, review queues, LLM judges |
| [Prompts](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/prompts.md) | Typed templates, content versions, gated promotion, rollback, A/B splits, serving through outages |
| [Postgres](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/postgres.md) | One adapter family for operations, memory, traces, evaluation, circuits, and prompts |
| [Durable operations and jobs](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/operations.md) | Operations that survive a restart, webhooks, and in-process job helpers |
| [Resilience and observability](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/resilience.md) | Circuit breaking, distributed rate limits, metrics, logs, and audit |
| [Batch tiers](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/batch.md) | The providers' discounted batch APIs, resumable from any process |
| [Caching](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/caching.md) | Exact and semantic response caches, with memory, Redis, and SQLite adapters |
| [Grounding](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/grounding.md) | Retrieval, citations, verification, self-consistency, and knowledge graphs |
| [Embeddings and retrieval](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/embeddings.md) | Embeddings as a routed operation family, and RAG helpers |
| [Images (experimental)](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/images.md) | Generation and masked edits over three backends, input safety, moderation, asset stores |
| [Voice](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/voice.md) | Transcription, speech, voice turns, and voice sessions |
| [Realtime voice](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/realtime.md) | Browser and server realtime sessions with barge-in, tools, and exports |
| [Telephony](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/telephony.md) | Calls, webhooks, phone numbers, and phone agents on realtime sessions |
| [Testing](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/testing.md) | Recording and replaying provider traffic, and conformance suites |
| [Agent server](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/server.md) | Self-hosted HTTP server for assistants: threads, durable runs, resumable streams, cron |
| [Workflows](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/workflows.md) | Ready-made chains and domain workflows |
| [Command line](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/cli.md) | The `nexus` command |
| [Packaging and install weight](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/packaging.md) | Every entry point and what it costs |

## Examples

```bash
npm run example:minimal
npm run example:create-nexus
npm run example:config-builder
npm run example:custom-provider
npm run example:feature-flags
npm run example:basic
npm run example:security
npm run example:optimizer
npm run example:agent
npm run build && npx tsx examples/realtime-scheduling.ts
npx tsc -p tsconfig.examples.browser.json
```

Repository example files cover:

- OpenTelemetry with Node HTTP and Express
- BullMQ workers
- OCR/PDF ingestion
- persisted vector stores
- classifier calibration
- domain workflows
- custom providers
- deterministic realtime scheduling with tools, confirmation, metrics, and conversation exports
- import examples under `examples/exports`

## Test Commands

```bash
npm install
npm run check
npm run check:release
```

`check` runs formatting and lint gates, source/test/example type checks, the build, unit and mock
conformance tests, coverage thresholds, package import checks, and an external type-consumer test.
`check:release` additionally verifies the dry-run tarball and a clean packed-package install.

`npm run docs:check` fails when any public export, or any public member of an exported class,
interface, or enum, has no doc comment, and `npm run docs:guides` fails when a guide does not name
every export of the entry points it covers, or its generated reference is stale. Both hold at 100%;
`--list` names what is missing, and `npm run docs:update` regenerates the references.

Real provider conformance is opt-in:

```bash
npm run test:conformance:real
```

## Roadmap

See [ROADMAP.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/ROADMAP.md) for what has
shipped and what is planned. It is a design proposal, not a compatibility promise; the guarantees
live in [API_STABILITY.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/API_STABILITY.md).

Shipped so far:

- completion controls and capability negotiation;
- durable operations, provider batch tiers, and distributed resilience, now including shared circuit
  state and a Postgres adapter family;
- embeddings, graphs, long-term memory, agents on graphs, and MCP;
- queryable traces, an evaluation platform, and a CI gate on top of it;
- record and replay of provider traffic;
- prompt versioning: typed templates, content versions, gated promotion, and serving through outages;
- per-entry-point size budgets.

Next is a self-hosted agent server. The image family leaves experimental once recorded live
conformance passes on all three backends.

## Known Limitations

- Voice, telephony, images, local models, and custom providers are optional layers; enable only what
  you use.
- Audio and video preprocessing is limited, and provider modality support differs.
- Bundled model metadata is a routing and estimation convenience, not a pricing contract.
- Process-memory cache, queues, and asset storage are not enough for a distributed deployment; use
  the Redis, BullMQ, filesystem, or S3 adapters instead.
- Default hash embeddings suit tests and demos, not strong semantic search. Register a real
  embedding provider for production retrieval.
- NLI verification is an interface; bring a specialized verifier for high-confidence entailment.
- Guardrails reduce risk but do not replace application authorization, provider-side moderation, or
  human review of high-impact actions.
- Realtime sessions are not yet routed through the metrics, audit, and rate-limit path that every
  other family uses.
- The image adapters are verified against documented wire shapes; recorded live conformance for all
  three backends is still to come, which is why the family is experimental.

## Production Notes

- Use direct or rules-based routing when model choice is already known.
- Keep semantic cache, semantic security, and custom hooks off latency-sensitive routes unless needed.
- Disable response traces with `pipeline.includeTraceInResponse = false`.
- Use shared adapters for distributed apps instead of process memory.
- Treat bundled model pricing and context metadata as defaults, not financial truth.
- Keep server-side authorization and provider moderation around high-risk workflows.

## Donations

- USDT Tron: `TNbS2ub2Wys6j8yrv57bWg3Ke21ZNwt115`
