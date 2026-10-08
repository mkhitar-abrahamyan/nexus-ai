# nexus-ai-pro Roadmap

What comes next, and why. This is a design proposal, not a compatibility promise: what is stable and
what is experimental is defined in [API_STABILITY.md](./API_STABILITY.md), and what has shipped is in
[CHANGELOG.md](./CHANGELOG.md). Work leaves this page when it ships.

Status baseline: **2.4.0**. 157 export subpaths, each held to a size budget in CI, 12 completion
providers, 5 embedding providers, 2 batch providers, 3 image providers plus a mock, and 98 completion
registry models plus 60 aliases, verified against each provider's documentation on 2026-10-02. 966
unit tests pass; coverage sits at **95.4% lines / 81.7% branches / 91.2% functions** against gates of
82/67/73. CI verifies lint, format, build, tests, coverage, registry drift, `llms.txt` drift,
per-subpath size, documentation and guide coverage, the root import, a graph benchmark with a
durability budget, runtime and memory-retention budgets, load and soak budgets for every graduated
surface, crash injection on five checkpointers, an upgrade from the published 2.0.0, 2.1.0, and 2.3.0
packages, ten-worker races and tenant isolation on every shared store, sandbox conformance, a
permission policy in a real tool loop, retrieval and tool-selection experiments, a crash halfway
through a 100,000-document ingestion, the agent protocols driven from the other side of the wire, the
imports of every entry point for anything Node-only, the portable kernel on Node, Deno, Bun, and an
edge runtime, mock conformance, packed-package smoke, API contract, consumer type resolution, and
clean install on Node 22 and 24.

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

- No required dependency, and a size budget on every entry point. Today the root import is 341 KB, and
  an entry point costs a fraction of it: `/agent` 31%, `/graph` 24%, `/operations` 16%, `/evaluate`
  13%, `/tracing` 9%, `/mcp` 5%, `/store` 2%. `npm run size:check` fails the build when an entry point
  grows past its budget or picks up a dependency.
- A runtime and memory budget. `npm run bench:runtime` fails the release gate when a measured path
  slows past its budget, relative to the machine it runs on, or when a run leaves memory behind.
- An upgrade path. Every schema change is a numbered migration that only adds, and a worker of the
  previous minor runs beside the new one during a rollout.
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
| Two replicas changing one deployment in the same instant can lose a change: the state store has no compare-and-set | deployments guide | not yet scheduled |
| Images have not recorded live conformance on all three backends | API stability | not yet scheduled |
| The Qdrant, Redis, Pinecone, Weaviate, and Chroma stores have passed their contract only against stubs in CI | API stability | not yet scheduled |
| The studio and its accounts have no threat review and no soak | API stability | not yet scheduled |

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
