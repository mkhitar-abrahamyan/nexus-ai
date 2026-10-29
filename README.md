# nexus-ai-pro

The typed AI framework for TypeScript. One API for provider routing and failover, agent graphs and
workflows that run branches in parallel and survive a restart, retrieval over any vector store, MCP,
durable background operations, guardrails, cost control, images, voice, and evals — with a studio a
team can share.

Import only what you use. The root import is the client and nothing else, and every other capability
has its own entry point with a size budget CI enforces; [the packaging guide](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/packaging.md)
publishes what each one costs. The package has no required dependencies: a graph-only application
loads 81 KB, and installs nothing but this package.
The client, the provider adapters, graphs, agents, and the agent protocols run on Node.js, Deno,
Bun, edge runtimes, and browsers; [the runtimes guide](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/runtimes.md)
lists the entry points that need Node.js, and why.

- NPM: https://www.npmjs.com/package/nexus-ai-pro
- GitHub: https://github.com/mkhitar-abrahamyan/nexus-ai
- Contributing, testing, and release procedure: [CONTRIBUTING.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/CONTRIBUTING.md)
- What is planned next: [ROADMAP.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/ROADMAP.md)
- For AI assistants: [llms.txt](https://raw.githubusercontent.com/mkhitar-abrahamyan/nexus-ai/main/llms.txt) indexes every guide, and [llms-full.txt](https://raw.githubusercontent.com/mkhitar-abrahamyan/nexus-ai/main/llms-full.txt) holds them all in one file

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

Everything else is optional too. Add what your code needs:

| Package | When |
| --- | --- |
| `@types/node` | A TypeScript project on Node. The client, graphs, and the lifecycle compile without it. |
| `zod` | You write schemas with zod. The package uses the zod your schema came from. |
| `ajv`, `ajv-formats` | A response format checks output against a JSON Schema object. |

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
- make ordinary async functions durable step by step, and recover a crashed run at the step it died on
- load files, web pages, sitemaps, and Git repositories into retrieval, over memory, Postgres, SQLite,
  Redis, Qdrant, Pinecone, Weaviate, or Chroma
- retrieve with hybrid keyword and vector search, reranking, and diversity, and measure it with evals
- reach tools from many MCP servers under one configuration, with allowlists and credentials from the
  environment
- version prompts, instructions, tools, and skills together, and promote them through evaluation gates
- find failing and slow runs, detect regressions, and review evaluated fix proposals in a shared studio
- serve assistants as revisions, with canaries that roll back on a regression, workers that scale on
  the queue under Kubernetes, and per-tenant quotas, rate limits, and budgets
- trip routing away from a failing provider, and share one rate-limit budget across workers
- reach the providers' half-price asynchronous batch tier behind one operation handle
- persist generated media to disk or S3 with tenant isolation, retention, and checksums
- build persistent realtime voice agents with interruption, live tools, and normalized conversation state
- authorize, budget, audit, and observe every call of every family in one place, with hooks that see
  each one finish
- pass images a tool made back to the model by reference, never as base64 text
- keep TypeScript types around every request and response

## Guides

Each feature has its own guide, covering every export of its entry points with a reference generated
from the doc comments. The guides live in the repository, so these links go to GitHub.

| Guide | Covers |
| --- | --- |
| [The client](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/core.md) | Requests, context windows, token optimization, cost checks, reasoning, prompt caching, streaming |
| [The lifecycle](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/lifecycle.md) | Authorization, a shared budget, hooks, audit, and metrics for every call of every family |
| [Providers and routing](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/providers.md) | The twelve completion providers, routing and failover, the model registry |
| [Guardrails](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/security.md) | Injection, PII, secrets, schema validation, output redaction |
| [Graphs](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/graphs.md) | Parallel branches, interrupts, checkpoints, time travel, subgraphs, caching, diagrams |
| [Agents and tools](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/agents.md) | Graph-based agents with approvals, capabilities and permission policies, a sandbox contract, the middleware catalog, and the simple tool loop |
| [The deep-agent preset](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/deep-agents.md) | Long, multi-step agents: a plan, a sandboxed workspace, helpers, skills, and a context that stays small |
| [Long-term memory](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/memory.md) | Namespaced memory with semantic search, in memory or Redis |
| [MCP](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/mcp.md) | Borrowing tools from MCP servers, a registry of many, and serving your own |
| [Agent protocols](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/protocols.md) | Serving an agent to user interfaces over AG-UI, to other agents over A2A, and to code editors over ACP, and calling remote agents as tools |
| [Traces](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/tracing.md) | Run trees, queries, feedback, comparison, and alerts |
| [Evaluation](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/evaluation.md) | Datasets, evaluators, experiments, comparisons with a verdict, review queues, LLM judges, and tools emulated by a model so an evaluation sends nothing |
| [Context hub](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/context-hub.md) | Prompts, instructions, tools, and skills versioned together, promoted through gates, and moved between projects |
| [Insights](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/insights.md) | Failing and slow runs clustered, regressions between time windows, and evaluated fix proposals |
| [Prompts](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/prompts.md) | Typed templates, content versions, gated promotion, rollback, A/B splits, serving through outages |
| [Postgres](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/postgres.md) | One adapter family for operations, memory, traces, evaluation, circuits, and prompts |
| [SQLite](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/sqlite.md) | Durable operations, checkpoints, and memory on one machine, over any SQLite driver |
| [Durable operations and jobs](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/operations.md) | Operations that survive a restart, webhooks, and in-process job helpers |
| [Resilience and observability](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/resilience.md) | Circuit breaking, distributed rate limits, metrics, logs, and audit |
| [Batch tiers](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/batch.md) | The providers' discounted batch APIs, resumable from any process |
| [Caching](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/caching.md) | Exact and semantic response caches, with memory, Redis, and SQLite adapters |
| [Grounding](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/grounding.md) | Retrieval, citations, verification, self-consistency, and knowledge graphs |
| [Loaders](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/loaders.md) | Files, Markdown, HTML, CSV, JSON, PDF, web pages, sitemaps, and Git repositories into retrieval |
| [Retrieval](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/retrieval.md) | Hybrid search, reranking, MMR, parent documents, and Redis, Pinecone, Weaviate, and Chroma stores |
| [Embeddings and retrieval](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/embeddings.md) | Embeddings as a routed operation family, and RAG helpers |
| [Media understanding](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/media.md) | Reading documents and images page by page, describing images, and answering questions about them, through any vision model or OCR |
| [Typed decisions](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/decisions.md) | A yes or no, a choice, or a score, answered with probabilities and a calibrated confidence, from TypeSafe AI's Jev or any model, so a graph, an approval, or a guardrail acts when it is sure and asks a person when not |
| [Video generation](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/video.md) | Videos from a prompt or a first frame, on Google Veo and Runway, as durable jobs streamed into an asset store and priced per second |
| [Images (experimental)](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/images.md) | Generation and masked edits over three backends, input safety, moderation, asset stores |
| [Voice](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/voice.md) | Transcription, speech, voice turns, and voice sessions |
| [Realtime voice](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/realtime.md) | Browser and server realtime sessions with barge-in, tools, and exports |
| [Telephony](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/telephony.md) | Calls, webhooks, phone numbers, and phone agents on realtime sessions |
| [Testing](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/testing.md) | Recording and replaying provider traffic, and conformance suites |
| [Adapter kit](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/adapter-kit.md) | Building a provider, store, or retriever outside this repository, verifying it against the same contracts, and its compatibility record on the [compatibility page](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/COMPATIBILITY.md) |
| [Studio](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/studio.md) | A shared UI for traces, threads, approvals, experiments, prompts, deployments, costs, and health, as a separate package |
| [Agent server](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/server.md) | Self-hosted HTTP server for assistants: threads, durable runs, resumable streams, cron, a worker queue, and metrics |
| [Deployments](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/deployments.md) | Revisions and canaries with automatic rollback, autoscaling on Kubernetes and Helm, and per-tenant limits |
| [Tenancy](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/tenancy.md) | One tenant model: a tenant's view of every store, tenant graph runs, and the isolation suite |
| [Policy](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/policy.md) | Guardrails, routing, budgets, residency, and credentials as one versioned file, validated as the client starts, checked by `nexus policy check` in CI, and recorded on every operation |
| [Regions and credentials](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/regions.md) | Agent servers across regions behind a gateway, residency rules that keep each tenant's requests, traces, and assets in its regions, and each tenant's provider keys from a secret manager |
| [Workflows](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/workflows.md) | Ready-made chains and domain workflows |
| [Command line](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/cli.md) | The `nexus` command |
| [Packaging and install weight](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/packaging.md) | Every entry point and what it costs |
| [Runtimes](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/runtimes.md) | The portable kernel, and running the client, providers, graphs, and agents on Deno, Bun, edge runtimes, and browsers |

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
`check:release` additionally holds the scheduling and runtime budgets — speed against a calibration
loop, and memory by retention — and verifies the dry-run tarball and a clean packed-package install.

`npm run docs:check` fails when any public export, or any public member of an exported class,
interface, or enum, has no doc comment, and `npm run docs:guides` fails when a guide does not name
every export of the entry points it covers, or its generated reference is stale. Both hold at 100%;
`--list` names what is missing, and `npm run docs:update` regenerates the references.

Real provider conformance, the vector store contract against real servers, and the experimental
families against their live services are opt-in:

```bash
npm run test:conformance:real
npm run test:vectors:live
npm run test:families:live
```

## Roadmap

See [ROADMAP.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/ROADMAP.md) for what is
planned, and [CHANGELOG.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/CHANGELOG.md) for what has shipped. It is a design proposal, not a compatibility promise; the guarantees
live in [API_STABILITY.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/API_STABILITY.md).

Shipped so far:

- completion controls and capability negotiation;
- durable operations, provider batch tiers, and distributed resilience, now including shared circuit
  state and a Postgres adapter family;
- embeddings, graphs, long-term memory, agents on graphs, and MCP;
- queryable traces, an evaluation platform, and a CI gate on top of it;
- record and replay of provider traffic;
- prompt versioning: typed templates, content versions, gated promotion, and serving through outages;
- a self-hosted agent server, and a local studio as a separate package;
- per-entry-point size budgets;
- vector stores behind one contract, and deprecation warnings at run time;
- durable functional workflows, step-level recovery in the server, SQLite persistence, and diagrams
  as images;
- document loaders, five more vector stores, hybrid retrieval with reranking, and an MCP registry;
- a shared studio with accounts, roles, an audit log, and comments; a context hub; insights with
  evaluated fix proposals; and evaluation caching;
- self-managed deployment at scale: revisions and canaries with automatic rollback, a worker queue
  that autoscales on Kubernetes, and per-tenant limits;
- the bridge to 2.0: every capability on a subpath of its own, everything 2.0 removes deprecated, and
  a codemod that moves your imports;
- 2.0 consolidation: one lifecycle for every call of every family, a shared spend budget, a root
  import that holds only the client, no required dependencies, and a model registry checked against
  every provider;
- 2.1 fault tolerance and crash-safe observability: checkpoints written on your terms, recovery after
  retries, idle timeouts and a clean drain, traces that survive a crash and reach any OpenTelemetry
  backend, one event stream, and dashboard rollups;
- 2.2 production scale and safe upgrades: versioned database migrations, queue claims and routing
  that cost the same at any size, a circuit breaker that counts across workers, one tenant model
  across every store, and `nexus doctor` to check a deployment before it serves traffic;
- 2.3 agents that act safely, on production retrieval: capabilities and permission policies, a
  sandbox contract, a middleware catalog, server authentication with one principal on every run,
  keyword search in Postgres and Elasticsearch with rerankers, durable ingestion, and a deep-agent
  preset;
- 2.4 graduation and interoperability: SQLite, loaders, retrievers, the MCP registry, the context
  hub, insights, and tenant limits out of experimental with published evidence; canaries judged with
  confidence and on quality; an adapter kit; AG-UI, A2A, and ACP; and a portable kernel, with the
  client, providers, graphs, and agents running on Deno, Bun, edge runtimes, and browsers;
- 2.5 graduation finished, and conversations evaluated: deployments that change atomically across
  replicas, revision worker pools, fair canaries judged on every run, and the studio out of
  experimental after a threat review; Postgres tenant usage; signed context named on every trace;
  simulated users and thread evaluators; and a doctor that knows the opt-in settings;
- 2.6 protocols complete, and progress on every stream: a tool's progress reaching the event stream,
  the protocols, traces, and the studio; AG-UI state deltas and frontend tools; A2A tasks and ACP
  sessions that survive a restart, with push notifications, `session/load`, and the editor's files,
  terminal, and MCP servers; and every protocol proven in a browser, against the previous release,
  and against its reference client;
- 2.7 agents that do more, and evaluation that runs on its own: workspace search and a multimodal
  workspace, a container sandbox, an interpreter, helpers that run in the background and survive a
  crash, and tool search on every provider; datasets generated from documents and from the
  guardrails' attacks; and online evaluation on workers, within a budget;
- 2.8 retrieval at production scale, and media that is understood: the Qdrant, Redis, Weaviate, and
  Chroma stores out of experimental after their checklist ran against the real servers; a shared
  embedding cache; images, audio, and documents as embedding input; a half-price embedding batch tier
  that ingestion survives a crash through; streaming asset stores; registry data you supply and
  refresh; and reading, describing, and searching media, with answers given the media themselves;
- 2.9 video, and everything shipped, proven: videos from a prompt or a first frame on Google Veo and
  Runway, as durable jobs another worker collects after a crash, streamed into an asset store and
  priced per second; online evaluation that reads every run however many share a millisecond, and
  budget reservations a dead worker leaves settled by what its call did; a deep agent's helper limit
  across processes; a media index that remembers what it holds; and the experimental families run
  against their live services every week;
- 2.10 durable conversations, and a second realtime provider: A2A tasks, ACP turns, and realtime
  sessions taken over by another worker when theirs dies, each proven killed at every write; realtime
  on the client's lifecycle; Gemini Live behind the same session, with video and images; phone calls
  answered over SIP; helpers on another server whose runs outlive their worker; and realtime over
  real WebRTC in a browser, with published budgets for turn latency and session load;
- 2.11 workspaces, and telephony in full: an agent's files apart from where its code runs, in memory,
  on disk, in any long-term store, read-only, or a composite of several; and a second phone provider,
  Telnyx, beside Twilio, both answering, transferring, conferencing, recording under a retention
  policy, and sending and receiving messages;
- 2.12 observability that loses nothing, and media you can evaluate: spans spooled through a collector
  outage, OTLP over gRPC, deployment evaluation that reads each run's whole trace, evaluators that
  read and judge images, documents, audio, and video, a catalog of every stored asset, and automation
  rules that roll a canary back when a score falls;
- 2.13 regions and residency, and credentials per tenant: agent servers across regions behind a
  gateway that fails over only within a tenant's regions, residency rules that keep each tenant's
  provider calls, traces, and assets in its regions, and each tenant's provider keys from a secret
  manager, rotated without a restart and kept out of every error;
- 2.14 policy you can review, and evaluation without side effects: guardrails, routing, budgets,
  residency, and credentials as one versioned file that `nexus policy check` compares with the version
  before it in CI and every operation records, tools emulated by a model so an evaluation sends
  nothing, and each tenant's key in every family;
- 2.15 a compatibility record for community adapters: `nexus adapters verify` seals the contract an
  adapter passed, against which release, with its benchmark; `nexus adapters recheck` turns a listed
  adapter red before a release that would break it; and one
  [page](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/COMPATIBILITY.md) lists them;
- 2.16 A2A over every binding: one agent served over JSON-RPC, HTTP+JSON, and gRPC from one task
  store, so a caller on any binding continues a task another started, and webhooks told the answer
  as it is written;
- 2.17 the editor's MCP servers over every transport, and video you can extend or edit: an ACP agent
  connects stdio, HTTP, and SSE servers and decides each tool by what its server says it does, and a
  video is extended from its own job or edited on Gemini Omni Flash, Veo, and Runway;
- 2.18 span events and links, as OpenTelemetry has them, media that knows its length from its own
  headers, a tenant's threads and runs listed and paged across all of its regions, MCP servers that
  reconnect and change their tools within a session, and videos made after reference videos;
- 2.19 typed decisions: a yes or no, a choice, or a score, answered with probabilities and a
  confidence, from TypeSafe AI's Jev or from any model's log probabilities, gated by thresholds a
  calibration chooses, so a graph's branch, an approval, or a guardrail acts when it is sure and asks
  a person when it is not;
- 2.20 tools read from a service's own OpenAPI document, which an agent calls or an emulator plays,
  an emulator that holds what a whole evaluation did so examples that build on each other are
  evaluated with nothing sent, and one A2A handler serving many tenants, each seeing only its own;
- 2.21 typed decisions about pictures, a yes or no, a choice, a score, or a box around something in
  one, from TypeSafe AI's Jev or any vision model; community adapters' compatibility records gathered
  from their own CI, a failing one turning red; and 3.0's defaults behind one switch today;
- 2.22 MCP over streamable HTTP both ways, with prompts, resources, and a server's questions back to
  the client; OpenAPI tools that send each operation's credentials; tokens, API keys, and sessions the
  server issues; and a studio that signs people in with your identity provider and serves many
  tenants, each seeing only its own.

Upgrading from 1.x: `npx nexus migrate src --write` moves your imports, and
[MIGRATING.md](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/MIGRATING.md) covers the rest.
Next, in 2.23, Pinecone, images, the Gemini embedding batch tier, media understanding, video, typed
decisions, Gemini Live, SIP, and both phone providers graduate once the live workflow passes against
each. The
[roadmap](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/ROADMAP.md) lists what comes after, in the order
applications ask for it.

## Before Production

Each guide ends with its limitations. The ones worth reading first: the
[client guide](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/core.md#in-production) on latency, traces,
and shared adapters; the [security guide](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/security.md#limitations)
on what guardrails do not replace; and the
[grounding guide](https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/docs/grounding.md#limitations) on embeddings
and verification. Voice, telephony, images, realtime, local models, and custom providers are optional
layers; enable only what you use.

## Donations

- USDT Tron: `TNbS2ub2Wys6j8yrv57bWg3Ke21ZNwt115`
