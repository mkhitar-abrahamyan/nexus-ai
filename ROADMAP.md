# nexus-ai-pro Roadmap

What comes next, and why. This is a design proposal, not a compatibility promise: what is stable and
what is experimental is defined in [API_STABILITY.md](./API_STABILITY.md), and what has shipped is in
[CHANGELOG.md](./CHANGELOG.md). Work leaves this page when it ships.

Status baseline: **2.1.0**. 138 export subpaths, each held to a size budget in CI, 12 completion
providers, 5 embedding providers, 2 batch providers, 3 image providers plus a mock, and 98 completion
registry models plus 60 aliases, verified against each provider's documentation on 2026-10-02. 819
unit tests pass; coverage sits at **94.3% lines / 80.0% branches / 89.6% functions** against gates of
82/67/73. CI verifies lint, format, build, tests, coverage, registry drift, `llms.txt` drift,
per-subpath size, documentation and guide coverage, the root import, a graph benchmark with a
durability budget, crash injection on five checkpointers, mock conformance, packed-package smoke, API
contract, consumer type resolution, and clean install on Node 22 and 24.

---

## How releases are planned

**Fewer, bigger releases.** Each one closes a group of gaps, about as many as 2.1.0 did: the work of
two or three themes, shipped together, each with a proof. A release is not cut to ship one feature.

**Every release ships proof.** A gap counts as closed when a test fails if it reopens: a
crash-injection test, a race test, a benchmark with a budget, or a conformance suite. Every primitive
a release touches gets its line in the semantics tables, saying what can repeat after a crash, what is
durable, and what a side effect must do.

**The 2.x line hardens before it widens.** The package is broad already; what remains is how it
behaves under a crash, a slow database, a rolling deploy, a thousand workers, or a hostile tool call.

**What every release protects:**

- No required dependency, and a size budget on every entry point. Today the root import is 325 KB, and
  an entry point costs a fraction of it: `/agent` 27%, `/graph` 22%, `/operations` 14%, `/evaluate`
  12%, `/tracing` 9%, `/mcp` 5%, `/store` 2%. `npm run size:check` fails the build when an entry point
  grows past its budget or picks up a dependency.
- Structural adapter contracts. A vector store, database client, Redis client, or transport is an
  interface the application fills, never a bundled SDK.
- TypeScript first, and self-hosted by default. Nothing phones home, model data included.
- One lifecycle and one execution context. New work plugs into them instead of adding a parallel path.
- No breaking change before 3.0. New behaviour is opt-in, and defaults keep their meaning.

**What the 2.x line does not prioritize:** more completion providers, more vector databases, more
image providers, a second language runtime, a hosted service, more domain workflow templates, or
another orchestration abstraction.

---

## Open gaps

Each gap is written down in a guide's limitations today, and each is closed by one release.

| Gap | Where it shows | Closed in |
| --- | --- | --- |
| A Postgres migration creates what is missing but never alters an existing table | Postgres guide | 2.2 |
| The Redis operation store scans every record to find queued work | deployments guide | 2.2 |
| Circuit-breaker failure counts stay per worker even with a shared store | resilience guide | 2.2 |
| The auto-router ranks every candidate on every request | providers guide | 2.2 |
| Tenants are scoped by the server and budgets, not by stores, traces, or cache keys | server and caching guides | 2.2 |
| Nothing checks a deployment's settings before they fail in production | — | 2.2 |
| Runtime speed and memory have no budget in CI, only import size | packaging guide | 2.2 |
| Rollups come only in memory | tracing guide | 2.2 |
| Functional workflow steps have no idle timeout, `onError`, or drain | graph guide | 2.2 |
| A function assistant waits for the drain timeout; only graphs hand off at a boundary | server guide | 2.2 |
| Three agent middleware ship: summarize, redact, and limit tool calls | agents guide | 2.3 |
| Tool safety is by tool name; there are no capabilities, permissions, or sandbox contract | security guide | 2.3 |
| The server's `auth` hook has no standard implementations | server guide | 2.3 |
| Keyword search is an in-memory index; reranking means an LLM call | retrieval guide | 2.3 |
| Ingestion has no versions, hashes, incremental refresh, or resume | loaders guide | 2.3 |
| The linter cannot see a side effect before an interrupt, or a sensitive tool without approval | graph guide | 2.3 |
| Ten surfaces are experimental in production readiness, with no measurable way out | API stability | 2.4 |
| Images have never passed live conformance | images guide | 2.4 |
| A canary is rolled back on raw rates, without sample sizes or confidence | deployments guide | 2.4 |
| A community adapter has no kit to build and verify itself against | — | 2.4 |
| No agent protocol beyond MCP, and the client pipeline is Node-only | README | 2.4 |
| Grounding, ingestion, and the PII and injection classifiers are the least-tested code | coverage report | 2.4 |

---

## 2.2.0: production scale and safe upgrades

The scaling cliffs the guides document go, upgrades become safe, and a deployment can check itself.

**Versioned migrations.** Each Postgres and SQLite adapter ships numbered migrations, recorded in a
`nexus_schema_migrations` table with checksums. `nexus db status`, `nexus db migrate --dry-run`, and
`migrate()` apply them in order under an advisory lock, in a transaction where the database allows.
Schema changes follow expand and contract: a column is added in one minor, written by the next, and
removed only in a major.

**Indexed dispatch.** The Redis operation store keeps queued work in a sorted set by ready time and
claims it atomically, so a claim costs O(log N) instead of a scan. The operation store stays the
source of truth; the dispatch index only says what is ready.

**A breaker that counts across workers.** Circuit-breaker observations move into the shared store as
a rolling window, so nine failures across three workers count as nine.

**A routing index.** Capability requirements become a bitmask, and the candidate shortlist for a
normalized set of requirements is cached. Only health, budget, price overrides, and latency are
evaluated per request.

**One tenant model.** `tenantId` joins the execution context, and stores, trace stores, operations,
asset stores, datasets, prompts, the context hub, budgets, rate limits, rollups, and cache keys scope
by it. Cache keys gain a namespace (tenant, environment, model revision, context version), and cache
outcomes (hit, miss, stale, bypass, error) are traced with their reason.

**`nexus doctor`.** One command checks the Node version, optional peers, provider credentials,
database and Redis connectivity, pending migrations, stuck leases, registry age, stale provider
health, and settings that cannot work together, such as a memory checkpointer or a process-local
tenant store behind several server replicas.

**Runtime budgets.** CI tracks speed and memory the way it tracks import size, with tolerances: graph
creation and an empty node, a 1,000-node compile, `Send` throughput, checkpoint latency per backend,
routing over 10, 100, and 1,000 models, a 20-middleware chain, trace events, the event stream, SSE
fan-out, operation claims, and cache lookups. Long-running tests watch for listener,
`AbortController`, and closure retention over 100,000 checkpoints and 10,000 threads.

**What 2.1 left.** A Postgres `RollupStore`, so dashboards keep their totals beside their traces.
Functional workflow steps gain idle timeouts, `onError`, and drain, as graph nodes have. A function
assistant can take the server's drain switch and hand its run off as a graph does.

**Proof.**
- A database created by 2.0.0 upgrades to 2.2.0 with `nexus db migrate`, and a 2.1 worker and a 2.2
  worker run side by side during the rollout.
- Ten workers race the same thread, operation, tenant budget, and circuit, and every invariant holds.
- A claim stays flat from 1,000 to 100,000 queued operations.
- A warm routing plan answers in under 100 µs at p50 and under 1 ms at p99 over 1,000 models.
- A tenant-isolation suite runs against every storage adapter and fails on any cross-tenant get,
  list, search, delete, fork, resume, trace query, vector search, or cache hit.
- `nexus doctor` reports each misconfiguration a fixture deployment is seeded with.

---

## 2.3.0: agents that act safely, on production retrieval

Agents get a complete middleware kit and a real security boundary, and the retrieval they read from
works at production scale.

**A middleware catalog**, each its own import on `nexus-ai-pro/agent/middleware`:
`modelRetry()`, `toolRetry()`, `modelFallback()`, `dynamicModel()`, `toolSelector()`,
`contextEditor()`, `piiMiddleware()`, `humanApproval()`, `modelCallLimit()`, and
`filesystemContext()`. `toolSelector()` sends a model only the tools relevant to the turn, by rule or
by embedding similarity, so an agent with 150 MCP tools sends a dozen schemas instead of 150.

**Capabilities and permissions.** A tool declares the capabilities it needs, such as
`network:api.github.com` or `filesystem:write`. A permission policy grants filesystem paths, network
hosts, and shell commands, and decides each call: allow, deny, or interrupt for approval. Danger is a
property of what a tool does, not of its name. The linter reads capabilities, and reports a sensitive
tool with no approval and a side effect before an interrupt.

**A sandbox contract.** Code and shell tools run through a `Sandbox` interface the application fills:
a container, a VM, a remote interpreter. The package ships the contract, a conformance suite, and a
process-level reference for development only.

**A deep-agent preset.** `nexus-ai-pro/deep-agent` composes `createAgent()` with planning, a
filesystem, subagents, skills, context offloading, the tool selector, and permissions. It is a preset
over the existing agent and graph runtime, not a third engine.

**Server authentication.** `jwtAuth()`, `apiKeyAuth()`, and `trustedProxyAuth()` fill the server's
`auth` hook. All three return one `Principal` (subject, tenant, roles, scopes), which reaches runs,
traces, budgets, tools, the store, audit, and deployments.

**Sparse retrieval and reranking as contracts.** `SparseRetriever` lets external keyword search take
part in hybrid retrieval, with references for Postgres full-text search and one search engine through
the same structural-client approach as the vector stores. `Reranker` takes a query and documents and
returns them ranked, with adapters for hosted rerank APIs and a local cross-encoder and no SDK
dependency. `KeywordIndex` and `modelReranker()` stay for small corpora and LLM judgement.

**Durable ingestion.** An ingestion pipeline on durable operations tracks each source's version and
content hash, each chunk's version, and the embedding model. It refreshes only what changed,
propagates deletions, writes idempotently, and resumes after a crash at the document it stopped on.

**Proof.**
- An agent over 150 tools completes a benchmark task set with `toolSelector()` at equal quality and a
  measured cut in tokens and latency, reported by an experiment.
- The permission policy refuses a write outside the workspace and a request to an unlisted host, and
  interrupts on a granted-with-approval command, in a test that drives a real tool loop.
- A deep agent completes a multi-step task on a fixture repository inside the reference sandbox.
- A JWT from a test identity provider reaches a tool call as a `Principal`, scoped to its tenant.
- Hybrid retrieval over Postgres full-text and pgvector beats vector-only on the stored dataset, with a
  hosted reranker and a local one compared in one experiment.
- An ingestion of 100,000 documents killed halfway resumes without re-embedding finished chunks, and a
  second run after editing ten documents re-embeds only those.

---

## 2.4.0: graduation and interoperability

The experimental surfaces leave experimental with evidence, and the package speaks the protocols the
agent ecosystem uses.

**Measured graduation.** Every experimental surface works through the checklist in
[How an item graduates](#how-an-item-graduates): the studio, deployments with tenant limits and the
worker queue, the context hub, insights, loaders, vector stores, retrievers, the MCP registry, SQLite,
and images. Images record live conformance on all three backends first. A surface leaves experimental
when every item has evidence, not on a date, and its evidence is published in `API_STABILITY.md`.

**Deployment statistics.** Canary guards reuse the evaluation verdict: a minimum run count, a
confidence level, a minimum effect size, and quality from online evaluation alongside errors, cost,
and latency. A revision that regresses quality rolls back automatically.

**An adapter kit.** `defineVectorStoreAdapter()`, `defineProviderAdapter()`, `defineRetrieverAdapter()`,
and their siblings, each with contract tests, a capability declaration, version compatibility,
benchmark fixtures, error normalization, and telemetry requirements. A community package can be built
and verified without entering this repository.

**Agent protocols**, each on its own subpath and out of the root:

- `nexus-ai-pro/protocols/ag-ui`: a graph's event stream as a frontend-neutral protocol;
- `nexus-ai-pro/protocols/a2a`: a Nexus agent calling, and serving, remote agents;
- `nexus-ai-pro/protocols/acp`: for coding-agent interoperability.

**A portable kernel.** `nexus-ai-pro/runtime` holds messages, the provider and tool contracts,
streaming, capabilities, and fetch-based adapters, with no `fs`, `net`, `child_process`, or Node-only
crypto. It runs on edge runtimes, Deno, Bun, and in browsers. Operations, Postgres, SQLite, the
server, the studio, and telephony stay Node-only, and say so.

**Test depth where it is thinnest.** Grounding and verification, file ingestion, and the PII and
semantic-injection classifiers get tests to the package's own coverage, since security and grounding
claims rest on them.

**Proof.**
- Each graduated surface's checklist is published with its evidence.
- A canary with a seeded quality regression is rolled back, and one with noise under the minimum
  effect size is not.
- A community-style adapter built only from the kit passes its contract suite.
- A Nexus agent and a remote agent complete a task over A2A in both directions, and a frontend renders
  a run through AG-UI with no Nexus client code.
- The kernel's tests pass on Node, Deno, Bun, and an edge runtime in CI.

---

## Beyond 2.4

Not yet scheduled, roughly in order of what applications ask for:

1. Embeddings beyond text: a provider batch tier for large ingestion jobs, image and multimodal
   embeddings, and a distributed vector cache shared across processes.
2. Model registry data released on its own, as a versioned package or a file the application
   supplies, refreshed from provider sources, so prices can move faster than the runtime. Never
   fetched from a central server.
3. Realtime follow-ons: a second provider, SIP and video transports, durable session recovery,
   browser compatibility automation, and a published method for latency and load benchmarks.
4. Telephony follow-ons: a second provider, outbound SMS and messaging as an operation family, call
   recording with a retention policy, and conference and transfer control.
5. Video generation through the same asynchronous operation, job, and asset contracts.
6. OCR, captioning, visual question answering, image embeddings, and media search and RAG.
7. Revision-specific worker pools, so a deployment revision maps to an image digest instead of every
   image carrying every revision; and multi-region deployment.
8. Context hub hardening beyond graduation: signed bundles, and a content digest recorded on every
   trace so a production run names the exact context that produced it.
9. Evaluation follow-ons: multi-turn thread evaluation, adversarial and synthetic datasets, evaluation
   budgets, and asynchronous online-evaluation workers.
10. Policy-as-code presets versioned independently from the runtime, multi-tenant credential-vault
    adapters, and routing by provider residency.
11. Streaming reads and writes for the filesystem and S3 asset stores, and OTLP export over gRPC.

**Deliberately not planned:** a hosted service, a large third-party integration catalogue (MCP and the
adapter kit cover breadth), and a second language runtime.

---

## Design notes

Decisions that still hold, and that new work is checked against.

**Media stays a separate operation family.** Text completions and generated assets have different
request shapes, response lifecycles, costs, safety checks, storage needs, and retry semantics. Image
generation is `ai.images.generate()`, not another `complete()` mode.

**Aliases, not model names, are the durable API.** `auto` and family aliases resolve through
versioned, verified entries so a model name never becomes part of the public contract.

**Portable media types.** Prefer `Uint8Array`, `Blob`, URLs, and web streams in public types; keep
Node `Buffer` as a convenience input. Use discriminated asset locations — `{ kind: 'bytes' }`,
`{ kind: 'url' }`, `{ kind: 'stored' }` — rather than several optional fields.

**Idempotency is not caching.** An idempotency key replays the same accepted operation. Generative
caching stays opt-in and keys on model version, policy version, parameters, and source-asset hashes.

**Budget is reserved and reconciled**, using provider-appropriate pricing: per token, per image, per
megapixel, or compute time.

**Nothing runs exactly once.** Every primitive says what it repeats after a crash, and a side effect
is made safe by an idempotency key on the call that makes it, not by the runtime promising more than
it can.

---

## How an item graduates

A new surface starts this way:

1. Provider-neutral types and a deterministic mock land first.
2. One real adapter proves the contract; conformance fixtures cover it.
3. A second adapter on a different wire protocol proves portability.
4. Packed-package, clean-install, and consumer type-resolution tests pass on every supported Node
   line.
5. Evaluation appropriate to the modality covers the supported capability matrix.

It leaves experimental status in [API_STABILITY.md](./API_STABILITY.md) only when every item below has
evidence, published with the graduation:

| Requirement | Evidence |
| --- | --- |
| API stability | Covered by the 2.x compatibility rules, with no planned breaking change |
| Conformance | Passes its contract suite on every supported backend |
| Crash recovery | Crash-injection tests at each durable boundary, where it has one |
| Concurrency | Race tests with several processes on the same records |
| Load | A published benchmark with a budget in CI |
| Tenant isolation | The isolation suite, where it stores tenant data |
| Security | A written threat review, with its findings closed |
| Upgrade | A migration test from the previous minor |
| Soak | A long-running test with flat memory and no leaked handles |
