# nexus-ai-pro Roadmap

What comes next, and why. This is a design proposal, not a compatibility promise: what is stable and
what is experimental is defined in [API_STABILITY.md](./API_STABILITY.md), and what has shipped is in
[CHANGELOG.md](./CHANGELOG.md). Work leaves this page when it ships.

Status baseline: **2.7.0**. 164 export subpaths, each held to a size budget in CI, 12 completion
providers, 5 embedding providers, 2 batch providers, 3 image providers plus a mock, and 98 completion
registry models plus 60 aliases, verified against each provider's documentation on 2026-10-02. 1,055
unit tests and 30 studio tests pass; coverage sits at **95.7% lines / 82.1% branches / 91.8%
functions** against gates of 82/67/73. CI verifies lint, format, build, tests, coverage, registry
drift, `llms.txt` drift, per-subpath size, documentation and guide coverage, the root import, a graph
benchmark with a durability budget, runtime and memory-retention budgets, load and soak budgets for
every graduated surface, crash injection on five checkpointers, an upgrade from the published 2.0.0,
2.1.0, and 2.3.0 packages, ten-worker races and tenant isolation on every shared store, ten replicas
changing one deployment at once on every state store, sandbox conformance on the reference sandbox
and on a real container runtime, a permission policy in a real tool loop, retrieval and
tool-selection experiments, 500 deferred tools on three providers, a crash halfway through a
100,000-document ingestion, crashes between a deep agent and its background helper, ten
online-evaluation workers through a crash, an adversarial dataset against an unguarded and a guarded
agent, the agent protocols driven from the other side of the wire and against the published 2.5.0 in
both directions, a tool's progress on every stream, every studio route called by every role and with
hostile input, the imports of every entry point for anything Node-only, the portable kernel on Node,
Deno, Bun, an edge runtime, and headless Chromium, mock conformance, packed-package smoke, API
contract, consumer type resolution, and clean install on Node 22 and 24. Every night, each agent
protocol is driven by the reference client of its own project.

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

- No required dependency, and a size budget on every entry point. Today the root import is 343 KB, and
  an entry point costs a fraction of it: `/agent` 33%, `/graph` 24%, `/operations` 16%, `/evaluate`
  13%, `/tracing` 9%, `/mcp` 6%, `/store` 2%. `npm run size:check` fails the build when an entry point
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
| The Qdrant, Redis, Weaviate, and Chroma stores have passed their contract only against stubs in CI | API stability | 2.8 |
| The Pinecone store has passed its contract only against a stub | API stability | when the live credential is set |
| Images have not recorded live conformance on all three backends | API stability | when the live credentials are set |
| Embeddings take text only, one call at a time, and their cache makes one round trip per input | Embeddings guide | 2.8 |
| Asset stores read and write whole byte arrays | Images guide | 2.8 |
| Prices and models move only with a runtime release | Providers guide | 2.8 |
| Reading a document, describing an image, and searching media are left to the application | Retrieval guide | 2.8 |

---

## 2.8.0: retrieval at production scale, and media that is understood

Four themes, each with a proof. Nothing here adds a required dependency or grows the root import.

**Live graduation.** The Qdrant, Redis, Weaviate, and Chroma stores leave experimental status with
the full checklist run against the real servers in the scheduled live workflow: the contract,
ten writers on the same ids, a soak, a load budget, tenant isolation, and an upgrade from 2.7. A
replacement in Redis becomes one atomic write, and every store refuses a `topK` that is not a
positive integer before it reaches a query. Pinecone and images graduate the same way once their
live credentials are set; nothing else stands in their way.

**Embeddings beyond text.**
- A shared embedding cache: an `EmbeddingCacheStore` that reads and writes a whole batch in one round
  trip, keys on a hash rather than the text, and keeps vectors as packed floats, on memory, Redis,
  Postgres, and SQLite. Proof: a second process embeds a 2,000-text batch with no provider call and
  one cache read.
- Images, audio, and documents as embedding input, on the models that take them, and refused on the
  ones that do not. Proof: a text query finds the image it describes through one vector space.
- A provider batch tier for embeddings at half price, on its own entry point, and an ingestion
  pipeline that submits, survives a crash, and collects. Proof: a 100,000-chunk ingestion through a
  batch tier, crashed between submit and collect, resumes without submitting twice.

**Streaming asset stores.** `putStream()` and `getStream()`, with byte ranges, on the filesystem, S3,
and memory stores, and a fallback for any store that has neither. The checksum and size limit are
enforced while the bytes flow. Proof: a gigabyte through each streaming store with flat memory.

**Registry data on its own.** The model and embedding registries as a versioned data file, which an
application supplies, layers over the bundled data, and checks with `nexus models check`. `nexus
models refresh` compares it with the providers the application has keys for. Nothing is fetched
from a central server. Proof: a price changed in a supplied file reaches the cost of the next call.

**Media understanding.** On a new entry point, reading a document's text page by page, describing an
image, and answering a question about either, through any vision model or a dedicated OCR service,
with one contract and a conformance suite. Media search and RAG index those pages, captions, and
image vectors, retrieve the asset behind each hit, and hand the model the image itself. Proof: an
experiment where answers grounded in the retrieved media beat answers from their text alone.

---

## Beyond 2.8

Not yet scheduled, roughly in order of what applications ask for:

1. Realtime follow-ons: a second provider, SIP and video transports, durable session recovery,
   browser compatibility automation, and a published method for latency and load benchmarks.
2. Telephony follow-ons: a second provider, outbound SMS and messaging as an operation family, call
   recording with a retention policy, and conference and transfer control.
3. Video generation through the same asynchronous operation, job, and asset contracts.
4. Multi-region deployment.
5. Policy-as-code presets versioned independently from the runtime, multi-tenant credential-vault
   adapters, and routing by provider residency.
6. OTLP export over gRPC.

**Held for 3.0.** Settings that 2.x keeps opt-in because turning them on changes what an upgrade
does. In 3.0 they become defaults, each with a migration note:
- incremental tracing on a persistent trace store;
- the Redis operation store's dispatch index;
- `hash-v2` bucketing for deployments created on 3.0. A deployment keeps the strategy it records.

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
