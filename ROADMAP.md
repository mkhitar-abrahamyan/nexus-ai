# nexus-ai-pro Roadmap

What comes next, and why. This is a design proposal, not a compatibility promise: what is stable and
what is experimental is defined in [API_STABILITY.md](./API_STABILITY.md), and what has shipped is in
[CHANGELOG.md](./CHANGELOG.md). Work leaves this page when it ships.

Status baseline: **2.8.0**. 176 export subpaths, each held to a size budget in CI, 12 completion
providers, 5 embedding providers, 2 completion batch providers and 2 embedding batch tiers, 3 image
providers plus a mock, 2 media providers plus a mock, and 98 completion registry models plus 60
aliases, verified against each provider's documentation on 2026-10-02. 1,109 unit tests and 30 studio
tests pass; coverage sits at **95.8% lines / 82.3% branches / 91.8% functions** against gates of
82/67/73. CI verifies lint, format, build, tests, coverage, registry drift, `llms.txt` drift,
per-subpath size, documentation and guide coverage, the root import, a graph benchmark with a
durability budget, runtime and memory-retention budgets, load and soak budgets for every graduated
surface, a gigabyte through each streaming asset store with flat memory, crash injection on five
checkpointers, an upgrade from the published 2.0.0, 2.1.0, 2.3.0, and 2.7.0 packages, ten-worker
races and tenant isolation on every shared store, ten writers racing on the same ids in every vector
store, ten replicas changing one deployment at once on every state store, sandbox conformance on the
reference sandbox and on a real container runtime, a permission policy in a real tool loop,
retrieval, tool-selection, and media-grounding experiments, 500 deferred tools on three providers, a
crash halfway through a 100,000-document ingestion and between submitting and collecting a
100,000-chunk embedding batch, crashes between a deep agent and its background helper, ten
online-evaluation workers through a crash, an adversarial dataset against an unguarded and a guarded
agent, the agent protocols driven from the other side of the wire and against the published 2.5.0 in
both directions, a tool's progress on every stream, every studio route called by every role and with
hostile input, the imports of every entry point for anything Node-only, the portable kernel on Node,
Deno, Bun, an edge runtime, and headless Chromium, mock conformance, packed-package smoke, API
contract, consumer type resolution, and clean install on Node 22 and 24. Every night, each agent
protocol is driven by the reference client of its own project. Every week, the vector stores run
their contract and graduation checklist against the real servers.

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
Most of each release goes to correctness, crash recovery, races, and proving what has shipped; a new
operation family is the exception, not the theme.

**Families share one model.** Agent protocols, realtime, media, and online evaluation are clients of
the same lifecycle, execution context, tenancy, operation store, and lease vocabulary. A family that
needs durability takes it from there, rather than becoming a runtime of its own.

**Only the next release is numbered.** The themes after it are listed in the order they are planned;
the grouping holds, the version each lands in does not.

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
- One lifecycle, one execution context, and one durability vocabulary of leases, heartbeats, and
  takeover. New work plugs into them instead of adding a parallel path.
- No breaking change before 3.0. New behaviour is opt-in, and defaults keep their meaning.

**What the 2.x line does not prioritize:** more completion providers, more vector databases, more
image providers, a second language runtime, a hosted service, more domain workflow templates, or
another orchestration abstraction. Provider count is not a measure: a provider is worth carrying when
it passes its conformance suite against the live service every week.

---

## Open gaps

Each gap is written down in a guide's limitations today, and each is closed by one release: 2.9, or
the theme after it that owns it.

| Gap | Where it shows | Closed in |
| --- | --- | --- |
| An online-evaluation worker reads one page of the runs that started in the same millisecond | Evaluation guide | 2.9 |
| A budget reservation held by a worker that dies stays charged for the period | Evaluation guide | 2.9 |
| A deep agent's count of the helpers it created is kept by its process | Deep agents guide | 2.9 |
| A media index does not remember which media it holds | Media guide | 2.9 |
| The Pinecone store has passed its graduation checks only against a stand-in | API stability | 2.9 |
| Images have not recorded live conformance on all three backends | API stability | 2.9 |
| The Gemini embedding batch tier has not run against Gemini | Embeddings guide | 2.9 |
| Media understanding has not passed its conformance suite against a vision model and the OCR service | Media guide | 2.9 |
| An A2A task working when its process stops is never taken over | Protocols guide | Durable conversations |
| An ACP turn in progress is lost with its process | Protocols guide | Durable conversations |
| Realtime reports through its own hooks, not the client's lifecycle | Realtime guide | Durable conversations |
| A realtime session dies with its process | Realtime guide | Durable conversations |
| An agent's files live in the sandbox that runs its code | Deep agents guide | Workspaces |
| A batch of spans the collector does not accept is dropped | Tracing guide | Observability that loses nothing |
| A deployment's quality evaluation sees a run's output, not its input | Deployments guide | Observability that loses nothing |
| OpenAI is the only realtime provider | Realtime guide | Realtime breadth |
| Twilio is the only telephony provider, SMS is not sent, and calls are neither recorded, conferenced, nor transferred | Telephony guide | Telephony breadth |
| Video is not generated | Images guide | Media in motion |

---

## 2.9.0: everything shipped, proven

A release that adds almost nothing: it proves the surfaces 2.x has shipped, and closes the places
where one of them can count wrong after a crash or under load.

**Live graduation.** The Pinecone store, images on all three backends, the Gemini embedding batch
tier, and media understanding against a vision model and the OCR service graduate when the scheduled
live workflow passes against each, published with their checklists. Each check is built and passes
against stand-ins; what stands in the way is the repository's live credentials.

**Online evaluation that counts every run.**
- Run pagination by a compound cursor, start time then id, part of the trace store's pagination
  contract so every backend orders and resumes identically: a page ends after a run, never after a
  timestamp. Proof: 4,000 runs started in one millisecond, read 1,000 a page by ten workers, are
  each scheduled exactly once, on every trace store.
- Budget reservations that outlive their worker. A reservation is reserved, settled, uncertain, or
  expired, and carries its operation and a lease. When a lease lapses, the reservation is settled
  from the operation's recorded cost if it finished, released if it never started, and otherwise
  marked uncertain, where a policy decides whether it stays charged. Proof: a worker killed holding a
  reservation, at each of those three points, leaves the budget where the provider's bill would.

**Durable counts in shipped features.**
- A deep agent's created helpers are recorded with its thread, not in its process. Proof: an agent
  that created its last allowed helper, killed and resumed elsewhere, cannot create another.
- A media index keeps a manifest: each medium's content hash, source, asset, pages, chunk ids,
  embedding model, and reader, so a medium is upserted, reindexed, deleted, and described by its id.
  Proof: indexing an unchanged medium writes nothing, a changed one replaces exactly its chunks, and a
  deleted one leaves none, crashed halfway through each.

---

## After 2.9

In the order they are planned. Each is a release's theme, with its proof; none has a version yet.

**1. Durable conversations.** One lease-and-takeover model for every conversation that runs on a
worker. An A2A task records its thread, run, owner, and lease, and when the lease lapses another
replica continues its run; an ACP turn does the same, from its last committed step. Realtime runs
through the client's lifecycle: tenant, principal, trace, budget, rate limits, provider health, and
audit. A realtime session keeps a durable conversation record (its configuration, turns, tool calls
and results, usage, and last committed turn), and a reconnect wraps a new transport around it; the
socket and the audio in flight are not recovered. A remote helper's ownership is leased the same way.
Proof: a crash-injection suite that kills the worker under each, and shows another take it over.

**2. Workspaces.** Where an agent's files live, separate from where untrusted code runs. A
`Workspace` contract (read, write, list, and optionally glob, grep, and delete) over memory, the
filesystem, the store, a sandbox, and a composite that routes paths among them. A sandbox is a
workspace that can also execute, and says how it is isolated; a deep agent takes each on its own.

**3. Observability that loses nothing.** An exporter wrapper that spools to the operation store a
batch the collector does not accept, retries it, and dead-letters what cannot be sent, under a bound,
reporting what it exported, retried, spooled, and dropped, and the age of the oldest pending batch.
Deployment evaluation reads a run's trace (its input, tool calls, retrieved documents, and media)
and runs through the online-evaluation worker rather than beside it. Evaluation subjects that are
media. Automation rules: when a score falls below a threshold over enough samples, open a review
item, send a webhook, or mark a deployment unhealthy. OTLP over gRPC.

**4. Realtime breadth.** A second provider on its own wire protocol, Gemini Live, behind the same
session, tools, and conversation record; video frames into a session; SIP calls answered by a
realtime agent; browser automation of a WebRTC session; and a published method and budget for turn
latency and session load.

**5. Telephony breadth.** A second provider on its own call-control protocol, Telnyx; messaging
(SMS) as an operation family on both providers; call recording kept in an asset store under a
retention policy; and conference and transfer.

**6. Media in motion.** Video generation through durable provider jobs, collected as a stream into an
asset store and priced per second, on Google Veo and on Runway; a media catalog; and media in the
evaluation suites.

---

## Unscheduled

Not yet placed, roughly in order of what applications ask for:

1. Multi-region execution.
2. Routing by residency: a request that requires a region is never routed outside it.
3. Credential vaults: a provider's key resolved per tenant at call time, from a secret manager.
4. Guardrail, routing, and budget policy as a versioned file the application supplies, checked by the
   command line.
5. A compatibility record for community adapters: the contract suite an adapter passed, against which
   version, with its benchmark, listed on one page.
6. Tools emulated by a model, for evaluation suites that should not call a payment provider or a
   production database.
7. A2A over its other bindings, and a webhook that receives each piece of streamed text.
8. ACP's editor MCP servers over SSE, with their tools' capabilities declared.

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
