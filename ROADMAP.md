# nexus-ai-pro Roadmap

What comes next, and why. This is a design proposal, not a compatibility promise: what is stable and
what is experimental is defined in [API_STABILITY.md](./API_STABILITY.md), and what has shipped is in
[CHANGELOG.md](./CHANGELOG.md). Work leaves this page when it ships.

Status baseline: **2.12.0**. 189 export subpaths, each held to a size budget in CI, 12 completion
providers, 5 embedding providers, 2 completion batch providers and 2 embedding batch tiers, 3 image
providers plus a mock, 2 media providers plus a mock, 2 video providers plus a mock, 2 realtime
providers plus a mock, 2 telephony providers, 5 workspaces, OTLP over HTTP and gRPC, and 98
completion registry models plus 60 aliases, verified against each provider's documentation on
2026-10-02. 1,220 unit tests and 30 studio tests pass; coverage sits at **96.0% lines / 82.1%
branches / 92.0% functions** against gates of 82/67/73. CI verifies lint,
format, build, tests, coverage, registry drift, `llms.txt` drift, per-subpath size, documentation
and guide coverage, the root import, a graph benchmark with a durability budget, runtime and
memory-retention budgets, turn-latency and session-load budgets for realtime, load and soak budgets
for every graduated surface, a gigabyte through each streaming asset store with flat memory, crash
injection on five checkpointers, an upgrade from the published 2.0.0, 2.1.0, 2.3.0, and 2.7.0
packages, ten-worker races and tenant isolation on every shared store, ten writers racing on the
same ids in every vector store, ten replicas changing one deployment at once on every state store,
sandbox conformance on the reference sandbox and on a real container runtime, workspace conformance
on every workspace and every long-term store, one deep agent doing the same work over each, a permission policy
in a real tool loop, retrieval, tool-selection, and media-grounding experiments, 500 deferred tools
on three providers, a crash halfway through a 100,000-document ingestion and between submitting and
collecting a 100,000-chunk embedding batch, crashes between a deep agent and its background helper,
a remote helper's worker killed on two replicas of an agent server, a deep agent resumed past its
helper limit, a media index crashed at each of its writes, a video generation collected by another
worker after its process dies, an A2A task, an ACP turn, and a realtime conversation each killed at
every write and taken over elsewhere, one agent definition holding the same conversation on two
realtime providers, a phone call answered from a signed SIP webhook, a realtime session over real
WebRTC in headless Chromium, one phone agent on two telephony providers whose recording expires on
schedule from every asset store, a collector stopped for an hour losing no span on every operation
store, the OpenTelemetry Collector taking spans over gRPC, a media catalog on every long-term store,
a canary rolled back on a media evaluator's score across two replicas, ten online-evaluation workers
through a crash and through 4,000 runs started in one millisecond on every trace store, a worker killed holding a budget reservation at
each point of its call on every usage store, an adversarial dataset against an unguarded and a
guarded agent, the agent protocols driven from the other side of the wire and against the published
2.5.0 in both directions, a tool's progress on every stream, every studio route called by every role
and with hostile input, the imports of every entry point for anything Node-only, the portable kernel
on Node, Deno, Bun, an edge runtime, and headless Chromium, mock conformance, packed-package smoke,
API contract, consumer type resolution, and clean install on Node 22 and 24. Every night, each agent
protocol is driven by the reference client of its own project. Every week, the vector stores run
their contract and graduation checklist against the real servers, and media understanding, the
Gemini embedding batch tier, and video run their conformance suites against the live services.

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
Most of each release goes to correctness, crash recovery, races, and proving what has shipped, and
every release also delivers one capability an application did not have before: gaps are never shipped
alone.

**Families share one model.** Agent protocols, realtime, media, and online evaluation are clients of
the same lifecycle, execution context, tenancy, operation store, and lease vocabulary. A family that
needs durability takes it from there, rather than becoming a runtime of its own.

**Only the next release is numbered.** The themes after it are listed in the order they are planned;
the grouping holds, the version each lands in does not.

**What every release protects:**

- No required dependency, and a size budget on every entry point. Today the root import is 349 KB, and
  an entry point costs a fraction of it: `/agent` 33%, `/graph` 23%, `/operations` 16%, `/evaluate`
  15%, `/tracing` 9%, `/mcp` 5%, `/store` 2%. `npm run size:check` fails the build when an entry point
  grows past its budget or picks up a dependency.
- A runtime and memory budget. `npm run bench:runtime` fails the release gate when a measured path
  slows past its budget, relative to the machine it runs on, or when a run leaves memory behind.
- An upgrade path. Every schema change is a numbered migration that only adds, and a worker of the
  previous minor runs beside the new one during a rollout.
- Structural adapter contracts. A vector store, database client, Redis client, or transport is an
  interface the application fills, never a bundled SDK.
- TypeScript first, and self-hosted by default. Nothing phones home, model data included.
- One lifecycle, one execution context, and one durability vocabulary of leases, heartbeats, and
  takeover. New work plugs into them instead of adding a parallel path.
- No breaking change before 3.0. New behaviour is opt-in, and defaults keep their meaning.

**What the 2.x line does not prioritize:** more completion providers, more vector databases, more
image providers, a second language runtime, a hosted service, more domain workflow templates, or
another orchestration abstraction. Provider count is not a measure: a provider is worth carrying when
it passes its conformance suite against the live service every week.

---

## Open gaps

Each gap is written down in a guide's limitations today, and each is closed by one release: 2.13, or
the theme after it that owns it.

| Gap | Where it shows | Closed in |
| --- | --- | --- |
| The Pinecone store has passed its graduation checks only against a stand-in | API stability | 2.13 |
| Images have not recorded live conformance on all three backends | API stability | 2.13 |
| The Gemini embedding batch tier has not run against Gemini | Embeddings guide | 2.13 |
| Media understanding has not passed its conformance suite against a vision model and the OCR service | Media guide | 2.13 |
| Video generation has not passed its conformance suite against Veo and Runway | Video guide | 2.13 |
| Gemini Live and SIP calls have been verified against their protocols, not against the live services | Realtime guide | 2.13 |
| Calls and messages have been verified against stand-ins for Twilio's and Telnyx's APIs | Telephony guide | 2.13 |

---

## 2.13.0: Regions and residency, and credentials per tenant

**Carried: live graduation.** The Pinecone store, images, the Gemini embedding batch tier, media
understanding, video, Gemini Live, SIP call control, and both phone providers graduate when the
scheduled live workflow passes against each, published with their checklists. Every check runs
there now; what stands in the way is the repository's live credentials, and for video, the variable
that lets it spend seconds of video.

**Regions and residency.** Multi-region execution: an agent server's runs placed in the region of
their tenant or thread, a queue per region, and failover between regions that keeps a run where its
data may live. Routing by residency: a request that requires a region is never sent to a provider,
replica, trace store, or asset store outside it, and a refusal says which rule held it back.

**Credentials per tenant.** A provider's key resolved per tenant at call time, from a secret manager
the application supplies, cached for a bounded time, rotated without a restart, and never written to
a trace, a log, or an error. Proof: a tenant pinned to a region never reaches anything outside it
across a regional failover, and a key rotated in the middle of a run is the one the next call uses.

---

## Unscheduled

Not yet placed, roughly in order of what applications ask for:

1. Guardrail, routing, and budget policy as a versioned file the application supplies, checked by the
   command line.
2. A compatibility record for community adapters: the contract suite an adapter passed, against which
   version, with its benchmark, listed on one page.
3. Tools emulated by a model, for evaluation suites that should not call a payment provider or a
   production database.
4. A2A over its other bindings, and a webhook that receives each piece of streamed text.
5. ACP's editor MCP servers over SSE, with their tools' capabilities declared.
6. Video extension and video as an input, and Gemini Omni Flash on Google's own Interactions API.
7. Span events and links, and media checks that read the duration of compressed audio and video.

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
