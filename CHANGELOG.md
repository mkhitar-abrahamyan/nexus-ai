# Changelog

Notable changes to this project are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases use semantic versioning.

## [Unreleased]

### Added

- **Spans that a collector being down cannot lose.** `spoolingExporter()`, on the new
  `nexus-ai-pro/tracing/spool`, keeps each batch the collector refuses in an operation store (the
  memory, Redis, Postgres, or SQLite one), retries it with backoff, and dead-letters it only once it is
  too old or has failed too often, under a bound on what waits. Every replica on the store drains the
  same spool, each batch once. `writeAhead` spools each batch before sending it. `stats()` reports
  what was exported, retried, spooled, dropped, and dead-lettered, and the age of the oldest batch
  waiting.
- `OtlpTraceExporter.send()`: sends runs as one batch now, and rejects when the collector refuses
  them.
- **A deployment judged by what its runs did.** An agent server given a `tracer` makes each run the
  root of a trace, with its input and output, and everything the assistant traces through the same
  tracer beneath it; the run records the trace as `RunRecord.traceId`. `Deployments.evaluate()`
  given those `traces` hands each evaluator the run's input and an `EvaluationTrace` of its tool
  calls, retrievals, model calls, and media, read by the new `traceEvidence()`, which `mediaParts()`
  backs. An assistant that traces itself is found by the run id it records.
- `Deployments.evaluationWorker()`: the online-evaluation worker over a deployment's runs, to start
  on every replica, scoring each run once between them as it finishes.
- `onlineEvaluationWorker()` takes `withTrace`, which gives evaluators `context.trace`, and
  `onScored`, which hears each run's scores once they are written, with `onError` for its failures.
- `traceRetriever()`: every retrieval as a `retriever` run, with the query and the documents.
- **OTLP over gRPC.** `OtlpGrpcTraceExporter`, on the new `nexus-ai-pro/tracing/otlp-grpc`, sends
  spans to a collector's port 4317 with no gRPC library: the trace service's `Export` call framed by
  hand over Node's HTTP/2 client, gzip-compressed, with metadata, a deadline, TLS options, one
  connection kept and reopened, and a failed call rejecting with an `OtlpGrpcError` so a spool keeps
  the batch. `OtlpTraceExporter` takes `protocol: 'http/protobuf'`, and both read a collector's
  partial success into an `OtlpPartialSuccessError` for `onError`. `encodeOtlpTraceRequest()` and
  `decodeOtlpTraceResponse()` are OTLP's protobuf encoding, written by hand, on any runtime.
- `Tracer.within()`: runs a function with a run started by `startRun()` in scope.

### Changed

- `Deployments.evaluate()` runs through the online-evaluation worker, drained once, instead of beside
  it. Replicas given one `operations` store score each run once between them, even calling at the
  same moment, where before two calls could score a run twice; it takes the worker's budget, review
  queue, and concurrency (4 at a time by default, one before), and `RunEvaluationReport` counts
  `failed` evaluations. Which runs a `sampleRate` picks is unchanged.

### Proof

- `tests/trace-spool.test.ts`: a collector stopped for an hour while a span finishes every second,
  and the process restarted halfway: every one of the 3,600 spans reaches it, once, on the memory,
  SQLite, Postgres, and Redis operation stores. The bound, dead letters, two replicas on one spool,
  and write-ahead through a process that dies mid-send. Without the spool, its bound, its claim, its
  dead letters, write-ahead, or taking over a lapsed lease, a test fails.
- `tests/otlp-grpc.test.ts`: the OpenTelemetry Collector itself, in a container, takes spans over
  gRPC and sends every one on as it came, ids, times, kinds, attributes, and status. Against a gRPC
  server of the test's, with a protobuf reader written apart from the encoder: compression and
  metadata, a refusal, a deadline, a partial success, a collector that is down, one that restarts
  under a live connection, and a spool that keeps what is refused. Without the compressed flag, the
  status, the deadline, the metadata, the parent span, the status message, typed values, the
  reconnection, or the retry on a dropped connection, a test fails.
- `tests/deployment-trace-evaluation.test.ts`: a traced server whose assistant retrieves a policy,
  calls a tool, and asks a model about a photo; its evaluators see the input, the tool call, the
  documents, the model call, and the photo once. Two replicas evaluating at once over one operation
  store score each of 40 runs once, where queues of their own score runs twice. A worker scores runs
  as they finish and hears each score once, and an assistant tracing itself is found. Without the
  trace, the input, the run scope, the shared queue, the fallback, the media deduplication, or the
  trace written before the run settles, a test fails.

## [2.11.0] - 2026-10-18

Workspaces, and telephony in full.

### Added

- **Workspaces: where an agent's files live, apart from where its code runs.** A `Workspace`, on
  the new `nexus-ai-pro/agent/workspace`, reads, writes, and lists files, and optionally searches
  them, removes them, and holds bytes, with paths that mean the same in every one. Five ship:
  `memoryWorkspace()`, `fileWorkspace()`, `storeWorkspace()` on any long-term `Store` (each file its
  contents and a small tree entry, so listing reads no contents), `readOnlyWorkspace()`, and
  `compositeWorkspace()`, which mounts several at paths of its own, read-only or not, and searches
  across them. `workspaceTools()` gives the file tools over any of them, and
  `runWorkspaceConformance()` holds any workspace to the contract. A `Sandbox` is now a workspace
  that can also run commands. A deep agent takes `workspace` apart from `sandbox`: its files, skills,
  instruction files, and offloaded results live in the workspace, and its commands run in the sandbox.
- `Workspace.writeBytes()`, optional, which the process sandbox now has.
- **Telephony in full, on a second provider.** `TelnyxTelephonyProvider`, on the new
  `nexus-ai-pro/telephony/telnyx`, on Telnyx's own call-control protocol: calls placed and answered
  by command, Ed25519-signed webhooks verified with Web Crypto, media streams that read as Twilio's
  do, phone numbers, and everything below. `TelephonyManager.answer()` answers a call webhook the same
  way on either provider: TwiML on Twilio, commands on Telnyx.
- **Transfer and conferences** on both: `transferCall()` and `joinConference()`, and a `dial` in a
  webhook answer, rendered as `<Dial>` on Twilio.
- **Call recordings kept on your terms.** `startRecording()`, `stopRecording()`,
  `parseRecordingCallback()`, `downloadRecording()`, and `deleteRecording()` on both, and
  `recordingKeeper()`, which keeps each finished recording in an `AssetStore` to expire under a
  `RecordingRetention`, deletes the provider's copy, keeps a retried callback's recording once, and
  sweeps what expired.
- **Messages, as their own operation family.** `sendMessage()` (SMS and MMS) and
  `parseMessageWebhook()` on both, running through the client's lifecycle as `messaging` operations.
- `NexusAI.telephony`, the client's telephony manager; `telnyxRealtimeAudioOptions()`;
  `TelephonyWebhookValidationRequest.publicKey`.
- The weekly live workflow runs a Gemini Live session that calls a tool, OpenAI's SIP call control,
  and the phone numbers of Twilio and Telnyx, where the repository's secrets are set.

### Fixed

- A realtime session's `whenIdle()` resolved while a tool it ran on its own was still running, so
  the tool's result could be missing from the record, and from the model, after it. It now waits for
  running tools and their results, though not for a call waiting on a person's confirmation.

### Changed

- A sandbox's file methods take a leading `/` as its root, as every workspace does: the process
  sandbox and the container sandbox refused such a path unless it was already under their root.
  `/etc/passwd` is now the workspace's own file, never the container's or the host's.
- The container sandbox rejects reading a missing file with `ENOENT`, as every workspace does, and
  passes the workspace conformance suite.
- The file tools describe their files as the workspace's, not the sandbox's.

### Proof

- `tests/workspaces.test.ts`: every workspace the package ships passes the workspace conformance
  suite: in memory, on disk, in the memory, SQLite, Postgres, and Redis stores, the process sandbox,
  and a composite. A composite's shadowing, read-only mounts, and search across mounts.
- `tests/phone-agent.test.ts`: one phone agent on Twilio and on Telnyx: answered the same way,
  recorded, streamed through the bridge to a realtime session that hears the caller, answers aloud,
  texts a receipt, and transfers the call; its recording kept in memory, on disk, and in S3, deleted
  at the provider, kept once on a retried callback, there the day before its retention ends and gone
  after the day after's sweep. Without the claim, the expiry, the provider delete, the answer by
  command, the messaging family, or `whenIdle()` waiting for tools, it fails.
- `tests/telephony-providers.test.ts`: both providers against stand-ins for their APIs, and Telnyx's
  webhooks verified with a real Ed25519 key pair: signed, altered, stale, and unsigned.
- `tests/deep-agent-workspaces.test.ts`: one deep agent does the same work over every workspace and
  each ends holding the same files; and an agent whose code is in a sandbox, notes in a store, and
  docs read-only finds each where it belongs. Without the composite's shadowing, its read-only
  mounts, the store's directory filter, or the agent taking its files from the workspace, a test
  fails.

## [2.10.0] - 2026-10-16

Durable conversations, and a second realtime provider.

### Added

- **A2A tasks that outlive their replica.** A working task's record now holds an `A2aTaskLease` and
  an `A2aTaskRun`. The lease names the replica running the task, which renews it every third of
  `lease.ms` (30 seconds); the run says what the task was asked to do. `a2aHandler()` returns an
  `A2aHandler`: the request handler, plus `recover()` and `close()`. `recover()` takes over working
  tasks whose lease lapsed, and carries each run on in one of three ways:
  - from the graph's last checkpoint;
  - by answering its questions again, when a resume never reached the graph;
  - from the start, when the run left no checkpoint.

  `recoverEveryMs` runs it on a timer. `A2aTaskStore.claim()` takes a lease in one step, so two
  replicas recovering at once take a task once. `MemoryA2aTaskStore` has it, and `storeA2aTasks()`
  builds it on `putIfVersion()`. A replica that finds its lease taken stops its run, and never
  records its result over the other's.
- **ACP turns that outlive the agent.** While a prompt runs, its session record holds an
  `AcpTurnRecord`. When the editor reopens the session with `session/load`, the agent carries the
  turn on, streaming its updates: from the graph's last checkpoint, by answering again, or from the
  start. A turn stopped while the editor was deciding an approval asks for it again.
- **Realtime on the client's lifecycle.** A session given `ai.lifecycle` runs as `realtime.session`,
  and each model turn as `realtime.turn`, carrying the session's `tenantId`, `userId` (the
  `principal`'s by default), and `traceContext`. A turn is admitted as it starts, rate-limited,
  authorized, and holding the average turn cost against the budget, and charged its cost when it
  finishes. A turn the lifecycle refuses is cancelled before the model runs it, and the session ends
  with `lifecycle_refused`. Connections are reported to the client's provider health and circuit
  breaker through the new `reportHealth()`, on `OperationLifecycleLike` and `OperationLifecycle`,
  with `ProviderHealthOutcome` and `LifecycleRuntime.providerHealth`.
- **Realtime conversations that outlive their process.** `conversationStore`, a
  `RealtimeConversationStore`, keeps the record after each committed turn:
  `MemoryRealtimeConversationStore`, or `storeRealtimeConversations()` on any `Store`. `resume`
  carries a conversation on, from its record or its id: same id, items, metrics, and metadata. On
  connecting, the provider is given what was said and what the tools returned before anything new,
  through `replayRealtimeConversation()`. Echoes carry `REALTIME_REPLAY_PREFIX` and are not recorded
  twice. `conversation.replayItems` caps the replay.
- **Gemini Live, behind the same realtime session.** `GeminiLiveTransport`, on the new
  `nexus-ai-pro/realtime/gemini-live`, speaks Gemini's Live API, and `GeminiLiveProvider`, on
  `nexus-ai-pro/realtime`, creates sessions on it for `createRealtimeAgent()`. The session's
  configuration becomes Gemini's setup; audio, messages, and tool results become its realtime input,
  turns, and tool responses; and its audio, transcripts, tool calls, interruptions, and usage become
  the events the session already reads. It takes an API key on a server or an ephemeral token
  anywhere, and reconnects a dropped socket with Gemini's latest resumption handle.
- **Helpers on another server, whose runs outlive their worker.** A `DeepSubagent` with `remote`, a
  `DeepRemoteHelper` such as `createRemoteGraph()` returns, runs on another agent server, as a run
  leased to the worker that runs it: when that worker stops, another takes it over. The agent starts
  the run under a key made from the call that started it, so delegating again or collecting it, in
  this process or another, finds the same run; a background task is marked on its thread first, so a
  run that never reached the server is started by the process that collects it. Its answer comes from
  a `DeepRemoteRunResult`.
- **Phone calls answered by a realtime agent, over SIP.** `answerOpenAISipCalls()`, on the new
  `nexus-ai-pro/realtime/openai-sip`, handles OpenAI's `realtime.call.incoming` webhook: it verifies
  each delivery, claims it so a retry answers its call once, and answers the call with the session
  `answer()` chooses from the caller, which attaches to the call and runs it with its tools,
  record, and lifecycle; or declines it with a SIP status. `OpenAISipCall` transfers and hangs up.
  The call control is on `nexus-ai-pro/realtime/openai-server` too: `acceptOpenAIRealtimeCall()`,
  `rejectOpenAIRealtimeCall()`, `referOpenAIRealtimeCall()`, `hangupOpenAIRealtimeCall()`, and
  `verifyOpenAIWebhook()`, on Web Crypto. `OpenAIWebSocketTransportOptions.callId` attaches a
  transport to a call.
- **A published method and budget for realtime turn latency and session load.** `npm run
  bench:realtime`, in the release gate, holds what a session adds to a message (under 5 ms at p99 for
  one call, under 20 ms with 250 calls at real time), that a turn late in a long call costs what an
  early one does, that 250 calls at real time keep up, the heap each session holds, and that ended
  sessions leave nothing. Budgets are in `realtime-budget.json`.
- **Realtime over real WebRTC in a browser.** `npm run test:browser:realtime`, in `npm test`, drives a
  session in headless Chromium against a peer connection in the page that plays the provider: real
  SDP, ICE, DTLS, and data channel, the microphone up, the model's voice down, a tool call, and a
  session with no microphone.
- `retainRawAudio` on a realtime conversation's options, `inPlace` on
  `RealtimeConversationReducerOptions`, and `addTransceiver()`, optional, on
  `RealtimePeerConnectionLike`.
- **Video and images in a realtime session.** `sendVideoFrame()` streams camera or screen frames:
  as realtime video on Gemini Live, as images in the conversation elsewhere, spaced by
  `RealtimeVideoOptions.minIntervalMs`. `sendImage()` adds an image, with text, to the conversation.
  `RealtimeTransport.sendVideo()`, optional, is what a transport with video input implements.
- `continueWith()` on a compiled graph: `continue()`, returning the final result.
  `ProtocolGraph.continueWith()` and `state()`, both optional, are what A2A and ACP carry a run on
  with.

### Fixed

- The WebRTC transport trimmed the SDP answer's final line break, and Chromium refuses a description
  whose last line has none, so a session in Chrome or Edge never connected.
- A WebRTC session that sent no microphone offered no audio to receive, so it never heard the model.
- A realtime session copied its whole conversation record twice for every event, so each event cost
  more as the call went on: a turn took 39 ms by the 500th, and 250 calls took half a core. It now
  applies events in place and copies the record only for a `conversation.updated` listener.
- An A2A `SendMessage` with `returnImmediately`, whose store failed while the task ran, raised an
  unhandled rejection, which ends a Node process by default. A store that cannot record a task's
  failure now leaves the task working, with its lease, for the replica that takes it over.
- A realtime session's usage and estimated cost are the sum of its responses'. Before, each
  response's usage replaced the last, so a session recorded, and settled, only its last turn.

### Proof

- `tests/conversation-crash.test.ts`: an A2A task, an ACP turn, and a realtime conversation are each
  killed at every write a clean run makes, and taken over elsewhere. Each ends as the clean run did,
  or its caller was told it never started; nothing is left half done, and nothing is recorded twice.
  The suite found three defects before they shipped, each fixed: an unhandled rejection from a
  failing store; a task submitted to a replica that stopped before starting it, which no replica
  would ever start; and a reopened session's save that dropped the turn it was about to carry on.
- `tests/deep-agent-remote-helpers.test.ts`: against two replicas of a real agent server, the agent's
  process and the worker running its remote helper both die; the second replica takes the run over,
  and the agent, resumed in a new process, collects that same run: one run, its answer, and the
  agent's note not written again. Without the key, the resumed agent starts a second run, and the
  proof fails.
- `tests/realtime-sip.test.ts`: a signed incoming-call delivery is accepted with the agent's session,
  chosen from the caller's number; the session attaches by the call's id, books a table through its
  tool when the caller asks, and hangs up. Forged, altered, and stale deliveries answer nothing; a
  retry after a failed accept answers the call, and a duplicate, on one replica or two, answers it
  once. Without the signature check, the claim, or the release, a test fails.
- `tests/realtime-gemini.test.ts`: one agent definition (instructions, a tool, conversation settings)
  runs on OpenAI's realtime API and on Gemini Live, each over its own scripted wire protocol. The two
  records match item for item: what the person asked, the tool call and its result, and what the model
  answered, with the same usage, and the tool runs once on each. Without the tool response, or with
  the request for a response not dropped after it, the proof fails.
- `tests/realtime-lifecycle.test.ts`: through a real client with a five-cent budget, two
  two-cent turns run, and the third is cancelled as it starts and ends the session; the budget holds
  four cents, and every operation names the tenant and user. Connection failures open the client's
  circuit. Without the admission at the turn's start, the proof fails.
- `tests/realtime-resume.test.ts`: a session's process is killed mid-conversation on the memory and
  SQLite stores. Another resumes it by id on a new transport, and gives the provider what was said
  before anything new. The conversation goes on under its own id with nothing recorded twice.
  Without the replay, or without skipping the echoes, the proof fails.
- `tests/a2a-takeover.test.ts`: a task whose replica dies halfway through a tool is taken over, on
  the memory, SQLite, Postgres, and Redis stores. The model call the dead replica finished is not
  made again, and the email it never sent is sent once. Two replicas recovering at the same moment
  take the task over once, and a lease renewed while a slow task works is never taken. Without the
  lease check, or carried on from the start instead of the checkpoint, the proof fails.
- `tests/acp-turns.test.ts`: an agent stopped halfway through a tool is started again and its
  session reopened; the turn goes on without repeating the finished model call, and sends the email
  once. A turn stopped during an approval asks again. Without the recovery on load, the proof fails.

## [2.9.0] - 2026-10-15

Video, and everything shipped, proven.

### Added

- **Video generation.** `nexus-ai-pro/video`: `VideoManager` makes videos from a prompt, a first or
  last frame, or reference images, through a provider's asynchronous job. `generate()` is a durable
  operation that records the job the moment it exists and each video as it is stored, so
  `recover()` in another worker collects a job whose process died, never submitting it twice, and
  streams each video into an asset store. Each generation runs in the lifecycle's new `video`
  family, and is priced per second by `priceVideo()` from `VIDEO_PRICES`, the Veo 3.1 list prices,
  or the account's own. `start()`, `resume()`, `status()`, `download()`, and `cancel()` work from a
  JSON `VideoJobRef` in any process. A request is checked against the model's capabilities before
  any job, and a failed job is submitted again only when the provider says that may help.
  - `GoogleVideoProvider` (`/video/google`): Veo through its long-running predictions, on the
    Gemini API, the video read from Google's URI with the key, or on Vertex AI, read from Cloud
    Storage or inline.
  - `RunwayVideoProvider` (`/video/runway`): Runway's task API, for its own models and the hosted
    ones it serves, Veo, Gemini Omni Flash, and Seedance among them; each video read from its signed
    URL without the secret.
  - `MockVideoProvider` (`/video/mock`), and `runVideoConformance()`, which all three pass.

  New guide `docs/video.md`. The family is experimental until Veo and Runway pass the conformance
  suite live. OpenAI's Videos API was removed on 2026-09-24, so there is no OpenAI adapter.
- **The experimental families, live.** `npm run test:families:live`, and a weekly *Family
  conformance* job beside the vector stores: media understanding's conformance suite against an
  OpenAI or Gemini vision model and Mistral's OCR, on a PDF and a PNG the script builds; a two-input
  batch through the Gemini embedding batch tier, waited on for 20 minutes and cancelled past that;
  and, when the repository variable `NEXUS_LIVE_VIDEO` is set, the video conformance suite on Veo 3.1
  Lite and Runway. Each check runs where its key is set, and what it measured is kept. These are the
  runs media, the Gemini batch tier, and video graduate on.
- **Paging by cursor.** `RunQuery.after` takes a `RunCursor`, the start time and id of a page's last
  run, and returns only the runs after it; `runCursor()` takes the cursor from a run, and
  `isAfterCursor()` is the test on its own, for a trace store of your own. Every bundled store
  honours it, and `applyQuery()` does for a store that filters in memory. A new Postgres trace store
  migration, version 3, indexes runs in query order.
- **Budget reservations that outlive their process.** Over a store that records reservations, a
  `budgetLedger()` holds each one as a `BudgetReservationRecord` under a lease (`leaseMs`, 10
  minutes), and moves it with its total in one step: `reserved`, then `settled`, `released`,
  `expired`, or `uncertain`. `recover(resolve)` settles reservations whose lease lapsed by what
  became of each operation, a `BudgetReservationOutcome`; `settle(id, outcome)` does it for one from
  any process; `renew()` extends a lease; and `uncertain: 'charge' | 'release'` says what an unknown
  outcome costs. `MemoryBudgetUsage`, `MemoryTenantUsage`, `RedisTenantUsage`, and
  `PostgresTenantUsage` all record them: Redis keeps a reservation in its total's Cluster slot, so one
  script moves both, and Postgres does it in one statement, in the reservations table of a new
  tenancy migration, version 2. A store of your own records them through five optional methods on
  `BudgetUsageStore`.
- **A media index that remembers what it holds.** `MediaIndexOptions.manifest`, any `Store`, with a
  `name`, keeps one `MediaIndexEntry` per medium: a hash of its content, source, metadata, and
  indexing options, where it is kept, its pages, its chunk ids, the embedding model, and the
  `MediaIndexReader` that read and described it. `add()` then skips a medium at the same version and
  replaces exactly the chunks and asset of one that changed, and `MediaIndex` gains `delete()`,
  `reindex()`, `describe()`, and `list()`. `MediaIndexReport.unchanged` counts what was skipped. A
  change is recorded as pending first, so a crash leaves nothing the next call cannot finish.

### Changed

- Runs that started in the same millisecond come by id, from last to first, compared as code units,
  on every trace store. The order of such runs was not defined before, and the memory and Postgres
  stores disagreed on it.

### Fixed

- An online-evaluation worker reads a backlog of runs that started in the same millisecond through,
  however many pages it spans. Before, it resumed each page at the last run's start time, so a page
  that ended among such runs was read again on every pass, and `drain()` never finished. On a trace
  store of your own that does not honour `RunQuery.after`, the worker pages by offset instead, and
  its `OnlineSchedulePass` says `paging: 'offset'`.
- A budget reservation held by an online-evaluation worker that dies no longer stays charged for the
  period. The worker records the reservation just before it calls its evaluators, and whoever takes
  over settles it: charged at what the scores cost if they were written, given back if the
  evaluators never ran, and by the ledger's `uncertain` policy if they ran and wrote nothing.
- An evaluation run again after a crash is reserved and charged. Its evaluators run again to find
  the scores still missing, and before, only a first run drew on the budget.
- A deep agent resumed after a crash counts the helpers it created before. With a checkpointer, each
  created helper is recorded, with its instructions, on `<thread>/helpers-created` before the call
  that created it returns, so the resumed agent cannot pass `createHelpers.max` and delegates to them
  again by name. Before, the count was kept by the process, and a resumed agent could create `max`
  more and no longer found the ones it had made.

### Proof

- `tests/video.test.ts`: the mock, Veo on the Gemini API and Vertex AI, and Runway pass the video
  conformance suite against stand-ins for their APIs. A request a model cannot make is refused
  before any job. A generation runs through the lifecycle, streams three megabytes into a
  filesystem store, and is priced per second. A generation whose process dies after submitting, or
  after storing its video, is collected by another worker with one submission and one stored video.
  If the recorded job is ignored, the job is submitted twice.
- `tests/online-evaluation-paging.test.ts`: the memory, JSONL, and Postgres trace stores order 5,000
  runs, 4,000 of them in one millisecond, identically, and page through them by cursor without a
  repeat or a gap. Ten workers reading 1,000 a page schedule each of them exactly once on every
  store, and on a store that ignores the cursor. The previous worker never reads past the burst.
- `tests/budget-reservations.test.ts`: on the memory, tenant memory, Redis, and Postgres stores a
  reservation moves with its total, is settled from another process by its operation's outcome, and
  of two processes settling it, one changes the total. An online-evaluation worker killed while
  holding a reservation, before its evaluator, during it, or after its scores, leaves the budget at
  what the judge billed once another worker takes over. With recovery switched off, the same test
  finds the dead worker's estimate still charged.
- `tests/media-rag.test.ts`: with a manifest, an unchanged medium is neither read nor written, a
  changed one keeps exactly its chunks and one asset, and a deleted one leaves none, with a crash at
  each write of a first index, a change, and a delete. Without the pending record, the crash proof
  fails.
- `tests/deep-agent-helpers.test.ts`: an agent that created its last allowed helper, killed and
  continued in another process, is refused a second and delegates to the first again by name. Without
  the record read back, the second is created.

## [2.8.0] - 2026-10-14

Retrieval at production scale, and media that is understood.

### Added

- **Graduation.** The Qdrant, Redis, Weaviate, and Chroma vector stores leave experimental status.
  Each passes its contract and the graduation checklist against the real server in the scheduled
  live workflow: ten writers racing on the same ids, what 2.7.0 wrote read by this release, tenant
  isolation, a load budget, and a soak. The evidence is in `API_STABILITY.md`, and the threat review
  in `SECURITY.md`. The Pinecone store passes the same checks against a stand-in, and graduates once
  the live workflow runs them against Pinecone.
- **A shared embedding cache.** `embeddings.cache.store` takes an `EmbeddingCacheStore`, which
  reads every input of a request in one `getMany()` and writes what was embedded in one `setMany()`.
  Keys are SHA-256 hashes from `embeddingCacheKey()`, so no text is a key, and vectors are packed
  float32. On `nexus-ai-pro/embeddings/cache`: `MemoryEmbeddingCache`, `RedisEmbeddingCache` (one
  `MGET` and one script a batch, or a command a key on Redis Cluster), `tieredEmbeddingCache()`, and
  `packVector()` with `unpackVector()`. `PostgresEmbeddingCache` is on
  `nexus-ai-pro/postgres/embedding-cache`, and `SqliteEmbeddingCache` on
  `nexus-ai-pro/sqlite/embedding-cache`, each with its versioned migrations and `purgeExpired()`.
- **Images, audio, and documents as embedding input.** An `EmbeddingInput` may hold `EmbeddingParts`:
  the text, image, audio, and document parts a message takes, embedded as one vector in the same
  space as text. A model takes the `EmbeddingModality` kinds its registry entry or adapter declares in
  `inputModalities`, and anything else is refused before any call; a fallback that cannot take the
  media is skipped. An adapter receives each input's parts in `EmbeddingProviderRequest.contents`,
  media already resolved to base64 or a URL. Google sends media inline or by a Files API URI, and
  writes `gemini-embedding-2`'s task as the text prefix that model reads instead of a task type; Cohere
  sends text and data-URI images as `inputs`. `gemini-embedding-2` joins the registry, with
  `costPerImage`, and `embed-v4.0` takes images. `MockEmbeddingProviderOptions.describeMedia` puts a
  medium and its caption in one space for tests.
- **A batch tier for embeddings**, on the new `nexus-ai-pro/embeddings/batch`: `EmbeddingBatchManager`
  submits, polls, collects, and prices at the provider's batch rate, usually half, with `submit()`,
  `start()`, `resume()`, `status()`, and `cancel()`. Adapters: `OpenAIEmbeddingBatchProvider` on
  `/openai`, `GoogleEmbeddingBatchProvider` (`asyncBatchEmbedContent`, media included) on `/google`,
  and `MockEmbeddingBatchProvider` on `/mock`. `batchEmbedder()` gives an ingestion pipeline a batch
  tier.
- **Ingestion through a batch tier.** `IngestionPipelineOptions.batchEmbed` takes a batch tier in
  place of `embed`. Chunks are gathered into windows, each one provider batch, with `batchesInFlight`
  (4) outstanding, and written in order. A durable run records each batch the moment it is
  submitted, and a retry collects it rather than submitting it again. `IngestionReport` counts
  `batches` and `batchesRecovered`.
- **Streaming asset stores.** `AssetStore` gains the optional `putStream()` and `getStream()`, and
  `putAssetStream()` with `readAssetStream()` stream through any store, falling back to `put()` and
  `get()`. The filesystem and S3 stores write a stream a chunk at a time, checking its size limit and
  checksum as it flows and leaving nothing behind when either fails, and read it back whole or by an
  `AssetByteRange`. `S3LikeClient` takes an optional `putObjectStream()` and `getObjectStream()`.
- **Registry data on its own**, on the new `nexus-ai-pro/models/data`: the model and embedding
  registries as a `RegistryData` file (`nexus-registry/1`) the application supplies.
  `checkRegistryData()` and `parseRegistryData()` name every problem with its path,
  `withRegistryData()` layers a file under the application's own entries and over the bundled ones,
  `bundledRegistryData()` exports the bundled data, and `diffRegistryData()` compares two files.
  `models.verifiedAt` measures freshness from the file, in `checkRegistryFreshness()` and `nexus
  doctor`, which takes the configuration as `models`. `nexus models export`, `check`, and `refresh`
  work with the file; `refresh` compares it with each provider's own model list.
- **Media understanding**, on the new `nexus-ai-pro/media`: `MediaManager` reads a document's or an
  image's text page by page, describes an image, and answers a question about media, routing each
  task to the provider named, its default, or the first that can, and running each call as one
  `media` operation of the client's lifecycle. `modelMediaProvider()` does all three through any
  vision model and the client's own `complete()`; `MistralOcrProvider`, on `/mistral`, reads PDFs,
  slides, and images into Markdown pages with their sizes and picture boxes; `MockMediaProvider`, on
  `/mock`, stands in for tests. `runMediaConformance()` checks any provider. `OperationFamily` gains
  `media`.
- **Media search and RAG**, on the new `nexus-ai-pro/media/rag`: `createMediaIndex()` keeps media in
  any vector store as their pages' text, captions, and, on a model that takes them, their own
  vectors, and keeps each medium in an asset store, or by its URL, so a hit can hand it back.
  `search()` returns each medium once at its best chunk, `resolve()` returns the medium, and
  `answerFromMedia()` hands the model the retrieved media themselves. `AssetProvenance.operation`
  takes `upload`, for media an application brings in.
- `ChromaVectorStoreOptions.filterFields`: the fields a search can filter on. Every write then sets
  each declared field, or removes it, so a replacement needs no read and stays whole under any race;
  a filter on another field is refused.

### Changed

- The Qdrant, Redis, Pinecone, Weaviate, and Chroma stores refuse a `topK` that is not a positive
  integer, before any request. An absent `topK`, or 0, still means 5.
- `RedisVectorStore` replaces a chunk with one atomic script instead of a delete and a write.
- An embedding `cache.adapter` is asked for every input at once, where it was asked for one input
  after another: a 2,000-text request made 2,000 sequential reads. Its keys are unchanged, so
  processes of this release and the last share entries during a rollout.

### Fixed

- `RedisVectorStore` failed on every command with an ioredis client, which also has a
  `sendCommand()` that takes its own command object; it now uses `call()` whenever a client has it.
  It also reads a search reply in RESP3, which ioredis 6 speaks by default, as well as RESP2.
- `WeaviateVectorStore` failed a search whose filter value had another type than its property, such
  as `'3'` on a number. It now chooses the operand from the collection's schema, read once, so such a
  filter matches nothing, as in every other store, and an `int` property gets `valueInt`.
- A `topK` from a request could change a Weaviate or Redis query, since both placed it in the query
  text.
- A replacement could keep a filter field the new version lacks, so a filter, such as a tenant's,
  still found the chunk by its old value. In Chroma, which merges metadata, it happened on every
  replacement, and kept a replaced `source` too; in Redis, when two writers raced.
- `BatchManager` submitted a batch again when a worker died after submitting it and before collecting
  it, so the provider ran, and billed, both. A submission now records its batch the moment it exists,
  and a later attempt collects that one.
- `OpenAIBatchProvider` read only the output file, so every request that failed was missing from the
  results; it now reads the error file too. It also refuses the `/v1/embeddings` endpoint its options
  offered, since it sent chat bodies there: embeddings are batched by `OpenAIEmbeddingBatchProvider`.
- After two writers replaced one object, Weaviate's filter index could return it for a value it no
  longer had. Every filtered hit is now checked against the object's own fields, and the store asks
  for more when a stale entry took a place.

### Proof

- `npm run test:vectors:live` runs the contract and the graduation checklist against each server,
  Redis over RESP3 and RESP2, and passes 35 of 35 checks locally against Qdrant, Weaviate 1.40.1,
  Chroma 1.0, and Redis Stack with ioredis 6.0.0. The scheduled workflow keeps its measurements.
- The stand-ins now fail as the servers do: an ioredis-shaped client, RESP3 replies, Weaviate's typed
  filter errors and stale filter entries, Chroma's merged metadata, and a seeded network delay that
  interleaves racing writers. Each failure above reproduces against them on the previous code.
- `tests/upgrade-remote-stores.test.ts` reads, with this release, what the published 2.7.0 wrote into
  each store.
- `tests/media-rag.test.ts`: with stand-in models, answers given the retrieved charts are right on
  every question, and answers from the same hits' text on none.
- `tests/media.test.ts`: the vision-model, Mistral OCR, and mock providers pass the media conformance
  suite, and the wire shapes each sends are asserted.
- `tests/registry-data.test.ts`: a price raised tenfold in a supplied file makes the next call cost
  ten times as much, for completions and embeddings alike.
- `npm run bench:streams`, a step of the release gate: a gigabyte goes through the filesystem and S3
  stores and back while memory grows by less than 128 MB.
- `tests/embedding-batch.test.ts`: an ingestion of 100,000 chunks through a batch tier dies while it
  collects its third window, and across both attempts each of its ten windows is submitted once;
  without the recorded batches, two are submitted twice.
- `tests/embeddings-media.test.ts`: a text query finds the image it describes through one vector
  space, and media never reaches a model that takes text only.
- `tests/embedding-cache.test.ts`: a second process embeds a 2,000-text batch with no provider call
  and one cache read, and every store keeps one contract, which the live suite also runs against
  Redis over RESP3 and RESP2.

## [2.7.0] - 2026-10-12

Agents that do more, and evaluation that runs on its own.

### Added

- **Workspace search.** A `Sandbox` may implement `glob()`, `grep()`, and `readBytes()`, with
  `SandboxGlobOptions`, `SandboxGrepOptions`, and `SandboxMatch`. `sandboxTools()` then offers
  `glob_files` and `grep_files`, bounded at 500 paths and 200 lines, each declaring the directory it
  reads. `processSandbox()` implements all three: its search follows no links, skips `.git` and
  `node_modules`, walks at most 20,000 entries, and skips files over 1 MB and binary files.
- **A multimodal workspace.** `read_media` reads an image, audio, or a PDF in the sandbox as content
  the model sees, as base64 so it survives a checkpoint, up to `SandboxToolsOptions.maxMediaBytes`
  (10 MB by default). A deep agent gets all three tools when its sandbox supports them.
- **Documents and audio reach the model.** The new `DocumentContent` part carries a document, such
  as a PDF, and `AudioContent` takes base64 text. Anthropic receives a document as a document block,
  inside a tool result too; OpenAI chat as a file, OpenAI Responses as an input file, and Google as
  inline data. Audio reaches Google, and OpenAI chat's audio models as `input_audio`. A tool's media
  follows its results on OpenAI and Google, as its images already did. Any other provider, or a
  source it cannot read, receives one line naming the part.
- **A container sandbox**, on the new `nexus-ai-pro/agent/sandbox/container`: `containerSandbox()`
  drives the `docker` or `podman` binary, with no dependency, one container per sandbox. By default
  the container has no network, drops every capability, cannot gain privileges, and is held to
  512 MB, one CPU, and 256 processes; nothing of the host is mounted. A command past its timeout is
  killed inside the container with everything it started. Files, glob, grep, and media work inside
  it. `ContainerSandboxOptions` sets the image, binary, working directory, network, and limits.
- **An interpreter contract**, on the new `nexus-ai-pro/agent/interpreter`. An `Interpreter` runs a
  snippet that calls the agent's tools as `await tools.<name>(args)`, so many calls take one step.
  `codeTool()` offers it to a model as `run_code`: it declares `code`, and the policy decides each
  call the code makes as it decides the model's own, refusing one it would ask a person about.
  `workerInterpreter()` is the JavaScript reference: a fresh worker per run, a 64 MB heap, a
  10-second timeout, and caps on calls and logs. It is not a security boundary.
  `runInterpreterConformance()` checks any interpreter. `DeepAgentOptions.interpreter` adds
  `run_code` over the deep agent's own tools, and its default policy then grants code.
- **Helpers beside the deep agent.**
  - `delegate` takes `background`: it returns a task id at once, and the new `collect_helper` tool
    returns the answer later, waiting up to `wait_seconds`. `maxBackgroundHelpers` (4) bounds how
    many work at once.
  - A background helper keeps checkpoints in the deep agent's checkpointer, on a thread named after
    the call that started it. After a crash, collecting the task, or repeating the call, carries the
    same helper on from its last checkpoint.
  - `createHelpers` lets the agent create a helper from instructions it writes, within
    `DeepHelperLimits`: the tools, model, model calls, and number per thread.
  - Streamed with `subgraphs: true`, a helper's events reach the agent's stream under its namespace,
    such as `tools/researcher@call-7`. `ToolContext.forward` lets any tool do the same for a run it
    starts.
- **Tool search.** `ToolDefinition.deferred` (and `tool({ deferred })`) loads a tool only once the
  model finds it. An agent with a deferred tool offers `search_tools`, which ranks the deferred tools
  by BM25 over their names, descriptions, and arguments, and answers with `ToolReferenceContent`
  parts. On Claude 4.5 and later every tool is sent, a deferred one with `defer_loading`, and a
  found tool loads through a `tool_reference` block, so the tool list never changes; every other
  model, OpenAI's and Google's included, is sent a deferred tool once it has been found.
  `toolSearchTool()`, `searchTools()`, and `TOOL_SEARCH_NAME` are on `nexus-ai-pro/agent`.
- **Datasets that grow**, on the new `nexus-ai-pro/evaluate/generate`:
  - `syntheticDataset()` writes examples from documents, from your function or a model. Each keeps
    a citation of the quote that supports it, checked against its passage; unsupported drafts and
    near-duplicate questions are dropped and counted.
  - `adversarialDataset()` grows attacks from the guardrails' own patterns, in the user's message, a
    document, or a tool's result, plain or disguised, each after a canary in the system prompt.
    `resistsAttack()` scores whether the canary stayed in.
  - `promoteIssue()` turns an insights issue's runs into examples that keep their run and the issue.
  - `attackSeeds()` on `nexus-ai-pro/security` returns each injection pattern's example attack.
- **Online evaluation on workers**, on the new `nexus-ai-pro/evaluate/online`.
  `onlineEvaluationWorker()` samples runs by a stable hash, queues one operation per run and source
  on a shared operation store, stops queuing at `maxQueued`, and scores what it claims within a
  budget ledger. Each score carries a mark naming its operation, so a retry after a crash writes
  only what is missing, and each run is scored exactly once per source.
- **A spend cap for experiments.** `evaluate()` takes `budget`. Each example run is reserved and
  reconciled, and once the budget runs out no further example starts; `evaluate()` rejects with the
  new `EvaluationBudgetError`, which carries the results it paid for.

### Fixed

- An operation whose store failed under it, such as a database going away while it recorded its
  result, left its handle pending forever, with an unhandled rejection; the handle now fails with
  the store's error, and the record's lease lapses for recovery.

### Changed

- A graph run's first checkpoint now carries the run's `metadata`, as every later checkpoint did.
- A deep agent with helpers offers `collect_helper` beside `delegate`, and its prompt says how to use
  both; its default policy allows `collect_helper`.

### Proof

- Glob and grep on the reference sandbox: alternatives, `**/` matching no directory, results relative
  to the root, a limit, a path outside the root refused, a link out of the root not followed, and
  binary, oversized, vendored, and past-the-line-limit matches skipped.
- An image, a PDF, and audio from a tool, after a JSON round trip, on the wire of Anthropic, OpenAI
  chat (with and without an audio model), OpenAI Responses, and Google.
- A deep agent that greps its workspace, finds a PDF, and reads it as a document.
- The container sandbox passes the sandbox conformance suite against a real Docker in CI, which now
  requires one. A command cannot find a host file anywhere in the container, cannot reach the host or
  the internet, while the same probe from a container with a network can; a command over a 64 MB
  limit is stopped; and a timeout leaves nothing it started running.
- The worker interpreter passes the interpreter conformance suite. An agent totals three orders and
  describes one from code in one model round trip, while the refund in the same code, which the
  policy asks about, never runs; a deep agent searches and reads its workspace from code, and a
  command its policy denies is denied from code too.
- A background helper answers after the agent has moved on, with its events in the agent's stream. A
  crash while the agent waits for it, and a crash before the agent saved the call that started it,
  each end with one lookup, one note, and one start of the helper.
- An agent with 500 deferred tools finishes all 40 tasks on Anthropic, OpenAI, and Google, with a
  model that calls a tool only once that provider's request has loaded it. Anthropic is sent all 501
  tools on every call with 500 deferred; OpenAI and Google never more than 11. The search ranks each
  of the 500 tools first for the step that describes it.
- A synthetic dataset written from all 39 guides cites, for every example, words that stand in its
  guide where the citation says; an invented quote and a repeated question are dropped every time.
  An adversarial dataset of 75 examples gets its canary out of an unguarded agent every time and
  never out of a guarded one, which still answers the benign examples. Each attack the guardrails
  block at the input is critical or high, and each medium one is redacted on the way out.
- Ten online-evaluation workers score 10,000 runs, each score exactly once, while one dies right
  after writing a run's scores and before recording them; that run is taken back and found already
  scored, and the queue stays near its limit. Workers on a budget stop at it, leave the rest queued,
  and carry on the next period without scoring any run twice. Two sources sharing one store never
  cross, and sampling picks the same runs on every worker. An experiment stops at its budget.

## [2.6.0] - 2026-10-11

Protocols complete, and progress on every stream.

### Added

- **Tool progress, end to end.**
  - A `ToolDefinition` can have `stream`: an async generator that yields progress and returns the
    result. `tool()` takes one instead of `execute`, and gives it an `execute` that runs the stream,
    so it works wherever a tool is executed. `ToolExecutor` runs a stream itself.
  - `ToolContext.progress` reports progress from any tool. An agent sets it, and turns each report
    into a `progress` tool event while the tool runs.
  - Progress reaches the event stream and the server's run events; AG-UI, as a `CUSTOM`
    `tool_progress` event; A2A, as a working status update with the progress as data; ACP, as an
    update of the tool call in progress; traces, in the tool run's `metadata.progress`; and the
    studio's run view.
  - MCP: `McpServer` runs `stream` tools and sends `notifications/progress` for a call that names a
    `progressToken`. `McpClient.callTool()` takes a `progress` listener, and the tools from
    `toNexusTools()` pass a remote tool's progress to the agent.

- **AG-UI, complete**, each part opt-in on `AgUiOptions`:
  - `stateDeltas` reports state as it changes: a `STATE_SNAPSHOT` after the first step, then a
    `STATE_DELTA` with an RFC 6902 JSON Patch after every step that changed it, appending to arrays
    item by item. `AgUiPatchOperation` is its type.
  - `messagesSnapshot` sends the whole transcript as `MESSAGES_SNAPSHOT` before the run finishes.
  - `frontendTools` offers the tools the frontend sends to the model. The frontend runs a call to one,
    and the next run's messages carry its result.
- **Tools the client runs.** An agent's input may carry `clientTools`, each a `ClientToolDefinition`.
  The model is offered them; a call to one ends the turn with the new `stopReason: 'client_tools'`
  once the agent's own calls of that step have run, and the client's result continues it. A client
  tool never replaces a tool of the agent's own.
- **Tools that depend on the run.** `CreateAgentOptions.toolSource` supplies tools per run, from a
  `ToolSourceContext`, offered and run like `tools`, under the same permission policy.
- **A2A, durable and complete.**
  - Tasks and conversations live in an `A2aTaskStore`: `MemoryA2aTaskStore` by default, or
    `storeA2aTasks()` over any long-term `Store`, so a task paused for an answer survives a restart
    and another replica finishes it.
  - `ListTasks` by context and state, a page at a time; `SubscribeToTask` on any replica; and a
    cancel that stands against the replica running the task.
  - Push notifications, with `pushNotifications`: each state change POSTed to a task's webhook,
    with the caller's token and signed as the server's operation webhooks are. A webhook must be
    `https` and not a private address, unless `allowPrivateNetworks` is set.
  - `GetExtendedAgentCard`, with `extendedCard`, for authenticated callers.
  - The client gains `extendedCard()`, `listTasks()`, `subscribe()`, `setPushNotification()`,
    `listPushNotifications()`, `deletePushNotification()`, and `push` and `returnImmediately` when
    sending.
- **ACP, durable and complete.**
  - Sessions live in an `AcpSessionStore`: `MemoryAcpSessionStore` by default, or
    `storeAcpSessions()` over any long-term `Store`. The agent offers `session/load`, replays the
    conversation, and asks again a question it was waiting on.
  - A prompt can carry images and audio, which reach the model as content parts.
  - `acpEditor()`, on the new `nexus-ai-pro/protocols/acp/editor`, gives an agent the editor's files,
    terminal, and MCP servers, as tools from its `toolSource`, each declaring what it touches.
    `serveAcp()` takes it as `editor`, and detaches it when the editor closes its end.
- **Interoperability, proven.**
  - A browser in CI: `npm run test:browser` serves the build to headless Chromium, which imports
    every kernel entry point and runs a graph, an agent, and AG-UI. It runs in `npm test`.
  - The previous minor on the other side of the wire: a 2.5 client against a 2.6 server, and the
    other way round, on the server's HTTP API and A2A, and one harness across both releases for
    AG-UI and ACP.
  - A nightly `Interoperability` workflow drives each protocol with its reference client:
    `@ag-ui/client`, `@a2a-js/sdk`, and `@agentclientprotocol/sdk`.
- **A `step` graph event.** `GraphRunOptions.onEvent` receives `step` after each superstep, with the
  state after it.

### Fixed

- AG-UI: a run that paused inside a node left that node's step open, so a strict client refused its
  `RUN_FINISHED`; and a node's tasks running side by side each started the same step. A node's tasks
  are now one step, and every step still open is finished before the run finishes or fails. Found by
  the reference client.
- A2A: `ListTasks` without a status filter, as the reference SDK sends it (`UNRECOGNIZED`), matched
  no task. An unset filter now filters nothing, and an unknown state is refused as invalid.
- MCP: the stdio transport's `close()` killed the server without waiting for it, so what the process
  held, such as its working directory, could outlive the close. It now waits up to two seconds for
  the process to exit.

### Proof

- Headless Chromium imports every kernel entry point and runs a graph, an agent with a streaming
  tool, and AG-UI. A 2.5 client and a 2.6 server pass the protocol suites in both directions, and the
  reference clients of AG-UI, A2A, and ACP each drive this release's servers through a whole run.
- An ACP session paused on a question survives the agent's restart, on memory and SQLite; the
  editor reopens it, sees the conversation replayed, and answers. An image and audio reach the model.
  Through the bridge, an agent reads, writes (after the person allows it), and runs the tests in the
  editor, and searches docs through an MCP server the editor offered, started as a real process.
- An A2A task paused for an approval survives a restart and is finished by another replica, sending
  its email once, on the memory, SQLite, Postgres, and Redis stores. A running task is followed where
  it runs and from another replica; a cancel on one replica stands against the other. Every state
  change reaches the webhook, signed and with the caller's token, and nine webhook URLs that point
  into the agent's own network or are not https are refused.
- An AG-UI client applying a run's snapshot and its deltas rebuilds the final state exactly, with
  each new message one `add`. A frontend tool is offered to the model beside the agent's own; the
  agent runs its own call, waits without calling the model again, and continues from the page's
  result in the next run. A page cannot shadow the agent's tool, and without the options the events
  are what they were.
- A tool that will not go on until a reader has seen its first report finishes on every stream: the
  event stream, the server's events, AG-UI, A2A, ACP, and MCP. Its reports arrive in order, after the
  call and before the result, and its traced run keeps them.

## [2.5.0] - 2026-10-09

Graduation finished, and conversations evaluated.

### Added

- **Deployment changes that are atomic across replicas.**
  - The long-term `Store` contract and the server's `ServerStateStore` gain an optional
    `putIfVersion()`. It writes a record only when the stored one's `version` is still the version
    the change was decided on, in one atomic step. The memory, Postgres, and SQLite stores, the server's
    memory store, and the Redis store (when its client has `eval`) have it, and `fromStore()` passes
    it on.
  - A deployment change uses it. A replica that loses the race decides again on the winner's record,
    so two changes made at once both land, in order. A change made on an `expectedVersion` is
    refused with `DEPLOYMENT_CONFLICT` instead. Two replicas starting at once seed one record.
  - `Deployments.atomicChanges` and `/scaling`'s `atomicChanges` say whether the state store
    offers this.
- **Tenant usage in Postgres**, on the new `nexus-ai-pro/postgres/tenancy`: `PostgresTenantUsage`, so
  every replica enforces one tenant limit without Redis. The `tenancy` adapter joins
  `postgresMigrations()` and `nexus db migrate`.
- **Revision worker pools.** A worker image carries some revisions of an assistant, and claims only
  the runs routed to them, so a new revision ships in a new image beside the old one.
  - A queued run's kind names its revision, as `assistant:<id>@<revision>`, and a worker claims with
    the kinds of the revisions it registered.
  - A run that will wait in the queue is routed over the revisions any fresh worker reports
    (`RevisionRequest.queued`), so the API replicas send traffic to a revision only a new image
    carries. `RevisionChoice.local` says whether the answering replica has it.
  - `/scaling` reports `queuedByRevision`, and `/metrics` `nexus_server_runs_queued_by_revision`, so an
    autoscaler starts the pool a waiting revision needs.
  - `OperationStoreFilter.kinds` filters by exact kinds on every operation store, and
    `OperationStoreStats.queuedByKind` counts queued records per kind. `claimQueued()` checks each
    candidate against the filter itself, for a store that ignores one.
- **Signed context bundles.**
  - A hub with a `signer` signs every new version with Ed25519, through Web Crypto, so on any
    runtime. The signature covers the bundle's content and its pinned prompts' content, under the
    full SHA-256 that `contextDigest()` computes, not the 12-digit version.
  - A hub with a `keyring` checks signatures with `verify()`. With `requireSignature`, it refuses a
    bundle without a trusted signature, with a `ContextSignatureError`, on `import()` and whenever
    `resolve()` or `renderPrompt()` serves one.
  - An import keeps the signatures that claim its content, and adds the importing hub's. That is how
    keys rotate.
  - `generateContextKey()`, `ed25519Signer()`, and `ed25519Keyring()` make and load keys, as JSON Web
    Keys or Web Crypto keys.
- **Canaries that stay fair.**
  - A deployment records a `bucketStrategy`. `hash-v2` mixes the thread id's hash with
    MurmurHash3's finalizer, so sequential ids such as `user-1` to `user-500` split as evenly as random
    ones. `fnv1a-v1` stays the default, and every deployment recorded before keeps it, so no thread
    moves through an upgrade. `Deployments.assistant()` takes `bucketStrategy`; `bucketing()` and a
    `bucketing` change switch a recorded deployment. `bucket()` takes the strategy.
  - Every replica counts the runs it finishes, per revision, in a rollup under the deployment version
    they were routed with: counts, latency in buckets 5% apart, and cost. `stats()` with `deployment`
    and `rollups()` sum them in one read, and `GET /deployments/:assistant` reports them.
  - `watchCanaries({ from: 'rollups' })` judges a canary on every run since the split last changed,
    instead of the latest 2,000 run records.
- **A doctor that knows the opt-in settings.** `nexus doctor` and `diagnose()` warn, in a new
  `settings` check, when a `RedisOperationStore` runs without `index: true`, and when a `Tracer`
  writes to a persistent store without `incremental`. Each warning names the setting that fixes it.
  Both stay opt-in through 2.x. `RedisOperationStore.indexed`, `Tracer.store`, and
  `Tracer.incremental` report the settings.
- **Graduation.** Deployments and the studio leave experimental status, each with its checklist and
  evidence in `API_STABILITY.md` and a threat review in `SECURITY.md`.
- **The studio's routes, listed.** `Studio.routes` gives every route's method, path, role, and audit
  action. `StudioOptions.maxBodyBytes` bounds a request body, and
  `MemoryStudioJournalOptions.maxComments` bounds the comments kept in memory.
- **Whole conversations, evaluated** (`nexus-ai-pro/evaluate/threads`).
  - `simulatedUser()` plays a user with a goal and a persona, driven by a model, and says when the goal
    was met or when it gives up. `scriptedUser()` follows a script, for deterministic tests.
  - `conversationTarget()` is an `evaluate()` target that holds a conversation per example and returns
    the `Thread`: every turn, how long each answer took, the messages the agent added, and how it
    ended. `graphThreadAgent()` drives an agent from `createAgent()`, which keeps its own tool calls
    from turn to turn.
  - Thread evaluators: `goalReached()`, `goalCompletion()` with a judge, `turnCount()`, and
    `turnScores()`, which scores every turn with an evaluator of single answers and names the turn
    where the conversation went wrong.
- **Context on every trace.** A traced model call records `metadata.context` beside
  `metadata.prompt`, so a trace query or an insight narrows by bundle version.

### Security

- **The studio**, from its threat review:
  - A request body is refused with `413` past `maxBodyBytes`, 1 MiB by default, as it arrives and
    before anyone is signed in. Before, a body was read whole into memory first.
  - With accounts, only a bearer `Authorization` header stands in for the page token. Before, any
    `Authorization` header did, and a browser adds Basic credentials to another site's request by
    itself, so a sign-in proxy that uses Basic authentication let another site make changes.
  - A change's body must be `application/json` (`415` otherwise) and a JSON object (`400`
    otherwise).
  - A change refused for want of the page token is recorded in the audit log.
  - Graphs and review queues are looked up among the application's own entries, so a name such as
    `constructor` no longer reaches the prototype.
  - Malformed percent-encoding in a path is a `400`, not a server error.
  - `limit`, `hours`, and `days` have ceilings: 1,000 items, 10,000 audit entries, 90 days of
    issues, and 366 days of costs.
  - The memory journal keeps at most 10,000 comments.
  - The server no longer sends an internal error's message, and logs it instead.
  - Only `http` and `https` pull-request links are rendered.
- **The agent server** refuses an assistant or revision named after a built-in property, such as
  `constructor`, with `400`. Before, such a run was accepted and failed when it ran.

### Fixed

- A worker that lacked the revision a run was routed to ran the assistant's live revision instead,
  and the run still recorded the revision it was routed to. A worker now claims only runs of revisions
  it carries.

### Proof

- The studio's threat review is a test: every route is called by every role and refuses the roles
  below its own, recording each refusal; over 2,000 requests with hostile paths, queries, and bodies
  all answer below `500`, and no prototype is polluted. 2,000 sign-in, read, and change cycles leave
  the heap flat, and 200 servers start and close with no handle left open.
- The doctor's seeded deployment warns about a Redis operation store without its index and a tracer
  writing to a persistent store at the end of each trace, and the same deployment with both settings
  turned on passes.
- Ten replicas make mixed changes to one deployment at once (canaries, splits, promotions,
  rollbacks, and a bucketing change), held until all ten arrive, on the memory server store and the
  memory, Redis, Postgres, and SQLite stores. Every change lands, each with a version of its own, and
  the history is one linear sequence.
- Over 48 sets of 500 sequential thread ids, `hash-v2` places a canary's share within 2.3 standard
  deviations of its weight, as random placement does; `fnv1a-v1` strays by up to 9.9. Over 10,000
  sequential ids, `hash-v2` is within half a point at every weight.
- A canary that fails 0.8% of the time against 0.5% is held by a guard over the latest 2,000 run
  records, and rolled back by a guard over rollups, which counts all 100,000 runs from three replicas
  in one read.
- A simulated user holds 50 conversations with each of two versions of a support agent built with
  `createAgent()`. The thread evaluators score every conversation, and `compareExperiments()` finds
  the second version better on goals met, the judge's verdict, turns taken, and per-turn scores, with
  no regression; the reverse comparison regresses. A conversation that failed names the turn where it
  went wrong.
- A signed bundle imports into a hub that requires signatures. It is refused there when it is unsigned,
  or edited after export even with its version recomputed. One edited where it is stored is refused
  when it is served. A re-import through a hub with a new key keeps both signatures, so the bundle
  stays trusted once the old key is retired. Every traced model call rendered from it names its
  context and prompt versions.
- Two worker images drain one queue, one carrying v1 and the other v1 and v2, with an API replica
  that carries only v1. Under a 50% canary, every run executes on the revision it was routed to, and
  only the image with v2 runs v2. A run for a pool scaled to zero waits, is counted per revision on
  `/scaling` and `/metrics`, and runs when that pool returns.
- Two replicas changing one deployment in the same instant both land, on the memory, Redis,
  Postgres, and SQLite stores. The race test holds both writers until both arrive, and the same race
  on a store without `putIfVersion()` loses a change. Of two changes made on one expected version,
  exactly one is refused.
- Ten workers spending one tenant budget lose nothing, and never over-grant a slot, on Postgres as
  on memory and Redis.

## [2.4.0] - 2026-10-08

Graduation and interoperability.

### Added

- **Canaries judged with confidence, and on quality.**
  - `watchCanaries({ confidence })` judges each metric the way an evaluation comparison judges a
    score: a seeded bootstrap interval that must not reach zero, and a minimum effect —
    `minErrorRateIncrease`, the latency and cost margins, and `minFeedbackDrop`. A real regression
    rolls back; noise and a trivially small change do not. `compareRuns()` takes the same options,
    and each `Regression` carries its `interval`.
  - `Deployments.evaluate()` scores an assistant's finished runs with evaluators from
    `nexus-ai-pro/evaluate`, and records the scores as run feedback. A canary that answers worse is
    then rolled back like one that fails more. Sampling is stable by run id, and a run is scored
    once per source.
  - Runs carry `feedback`. `POST /runs/:id/feedback` and `RunManager.addFeedback()` record a
    person's rating as well.
- **An adapter kit**, on the new `nexus-ai-pro/adapter-kit`, for building adapters outside this
  repository:
  - `defineProviderAdapter()`, `defineEmbeddingsAdapter()`, `defineVectorStoreAdapter()`,
    `defineRetrieverAdapter()`, and `defineStoreAdapter()`. Each takes a capability declaration
    and the range of releases the adapter supports, read as npm reads ranges.
  - Every instance normalizes its failures into an `AdapterError` with a code and `retryable`, and
    reports each call to an `onCall` telemetry hook.
  - `verify()` runs the adapter's contract suite, skipping only what it declares it cannot do, with
    a benchmark held to the p95 budgets it declares.
  - The vector-store, retriever, and store contracts ship as `runVectorStoreContract()`,
    `runRetrieverContract()`, and `runStoreContract()`, with no test framework needed.
- **Agent protocols**, each on its own entry point and with no dependency:
  - `nexus-ai-pro/protocols/ag-ui`: `agUiHandler()` serves a graph to any AG-UI frontend as
    Server-Sent Events: each step, text as it streams, tool calls with their results, and the final
    state. A run that needs approval finishes with an interrupt, and a resume entry on the same
    thread continues it. `agUiEvents()` yields the same events for any other transport.
  - `nexus-ai-pro/protocols/a2a`: `a2aHandler()` serves a graph as an A2A 1.0 agent: its card,
    `SendMessage`, `SendStreamingMessage`, `GetTask`, and `CancelTask`. A context is a
    conversation, and a task that needs approval asks for input and continues when a message answers
    it. `a2aClient()` calls any A2A agent, and `a2aTool()` makes one a tool that declares the
    host it reaches, so a permission policy decides it.
  - `nexus-ai-pro/protocols/acp`: `serveAcp()` puts a graph in a code editor over the Agent
    Client Protocol. The editor sees streamed text and thought, each tool call with its kind, file,
    and diff, and the plan from `write_todos`. It asks the person to approve calls, and keeps an
    always-allow or always-reject choice for the session.
- **A portable kernel**, on the new `nexus-ai-pro/runtime`: messages, responses, the provider and
  tool contracts, streaming, and capabilities, in one small import that reaches nothing Node-only.
  `runtimeInfo()` names the runtime the code is on.
- **The client, the provider adapters, graphs, agents, and the agent protocols run on Deno, Bun,
  edge runtimes, and browsers.**
  - Ids come from Web Crypto.
  - SHA-256 for node-cache keys and dataset versions is computed in plain JavaScript where the
    runtime has no synchronous native digest. The digests are identical, so existing cache keys
    still match.
  - Base64 and UTF-8 byte counts no longer need `Buffer`.
  - 125 of 157 entry points now run anywhere. The new runtimes guide lists the rest, each with
    exactly what it needs.
- The OpenAI, Anthropic, Google, and Cohere providers take a `fetch` option: a platform's bound
  fetch, a proxy, or a test stub.
- **Measured graduation.** These surfaces leave experimental status, each with evidence for every
  requirement of the graduation checklist, published in `API_STABILITY.md`:
  - the SQLite adapters;
  - the Postgres and SQLite vector stores;
  - the loaders and the retrievers;
  - the MCP registry;
  - the context hub and insights;
  - tenant limits and the server's worker queue.

  Deployments, images, the Qdrant, Redis, Pinecone, Weaviate, and Chroma vector stores, and the
  studio stay experimental, each with the requirement that remains named.
- `inheritEnv` on a local MCP server, in `StdioClientOptions` and in the registry's server
  configuration: which of this process's environment variables the server inherits.
- Load and soak budgets for every graduated surface, held in CI by `npm run bench:surfaces`. A soak
  fails on heap growth, on a handle left open, or on a timer never cleared, unref'd ones included.
- The scheduled live workflow records image conformance on every backend with a credential, and
  runs the vector store contract against real Qdrant, Chroma, Weaviate, and Redis servers.

### Security

Testing the security code to depth found these gaps, and each is closed:

- **The upload scanner trusted the caller.**
  - A declared `sizeBytes` could carry a larger file past `maxBytes`; the larger of the declared and
    actual sizes is now checked.
  - `run.exe.`, `run.exe ` (Windows drops the trailing dot or space), and a name with a control
    character such as `run.exe\0.txt` passed the extension block; names are now read as the file
    system reads them, and a control character is itself a critical finding.
  - Content given as bytes, which is how upload middleware delivers it, was never scanned; textual
    bytes are now decoded and scanned.
  - A file with no MIME type passed an allowlist; an allowlist now fails closed. Types are compared
    without parameters, so `text/plain; charset=utf-8` is `text/plain`.
- **File ingestion read what it never scanned.** Text an extractor returns from a PDF or an image is
  now scanned like a text file. A text file given as bytes is ingested rather than skipped.
- **The input guard put secrets in its findings.** A finding now carries a short preview, such as
  `ghp_… (40 characters)`, never the secret. The SSRF check also catches `[::1]`, all of
  `127.0.0.0/8`, and the Google and Alibaba metadata hosts.
- **Prompt hardening could be escaped.** User text holding the delimiter closed the block early; each
  occurrence inside the text is now broken apart. The text parts of multi-part messages are wrapped
  too.
- **The injection detectors read text as typed, not as the model reads it.** Both now fold
  full-width letters and drop zero-width characters first, so `ＩＧＮＯＲＥ previous instructions` and
  `ig​nore previous instructions` are found. `neutralize()` leaves clean text exactly as it was.
- **The PII detector and the output guard took any long number for a card or a phone.** A
  millisecond timestamp or an order id was masked, and in the output guard a card's last digits
  could survive because the phone pattern claimed the rest first. Card numbers must now pass Luhn,
  and phone numbers need 10 to 15 digits with a separator or a leading `+`. Cards are claimed before
  phones, and a span one kind has claimed is not reported again as another.
- **Retrieved context reads as data.** `withRagContext()` now tells the model that the context is
  data, not instructions.

The graduation reviews, published in `SECURITY.md`, found these, and each is closed:

- **The Git loader followed symbolic links.** A repository with a tracked link to a file of the host,
  such as `~/.ssh/id_rsa`, had that file loaded into a knowledge base. A link is now never followed,
  nor a path that leaves the checkout.
- **A gzipped sitemap could be a decompression bomb.** Inflation now stops at 50 MB, the sitemap
  protocol's maximum, and the loader reports the sitemap.
- **A local MCP server inherited this process's whole environment**, every API key and database URL
  included. It now starts with its `env` and only what a process needs to run: the path, the home
  and temporary directories, the locale, the Windows system variables, proxies, and certificates.
  Name what else a server needs in `env`, or set `inheritEnv`.
- **One caller's ratings could decide a canary.** Feedback was counted per rating, so a hundred low
  ratings of one run met the minimum sample alone, and could roll back a canary or keep a bad one
  alive. Each run now counts once per feedback key, as the mean of its ratings.
- **The file prompt store could lose a label move.** Its compare-and-set was a read and then a write,
  so two moves at once in one process could both succeed, the later erasing the earlier. Label
  writes to one file are now serialized across the process.
- **Two changes at once to one deployment, on one replica, could lose one**, such as a guard's
  rollback and an operator's promotion. They now apply in order. Changes from two replicas in the
  same instant still can, which keeps deployments experimental.

### Fixed

- The agent server's guide called the server experimental, though it has been stable since 2.0.
- Bundling the client for an edge runtime failed: it reached the file-based evaluation cache, which
  loads `node:fs`. `FileEvaluationCache` now lives in a module of its own, still exported from
  `nexus-ai-pro/evaluate`.
- `extractCitations()` and `validateCitations()` read a Markdown link `[text](url)` as a citation,
  and `[doc-1, doc-2]` as one id; links are ignored and lists are split.
- The semantic injection classifier embeds a request in one call instead of one per message, and
  `detectSync()` honours `enabled: false` as `detect()` did.

### Proof

- Grounding and verification, file ingestion, the upload scanner, the PII detector, and both
  injection detectors are tested to the package's own coverage:
  - grounding, the PII detector, prompt hardening, and the upload scanner at 100% of lines;
  - file ingestion, which no test loaded before, at 97%.
- Each security fix above is a test that names the attack it stops or the false positive it rules
  out.
- A canary seeded with a quality regression is rolled back. The proof runs on a real server: 300
  runs, online evaluation recording the scores, and the guard reading them. A canary whose quality
  differs only within the noise keeps its share. A difference that 20,000 runs make significant, but
  that is under the minimum effect, is not a regression either.
- A community-style adapter, built only from the kit, passes its contract suite. It is a vector store
  in plain JavaScript inside the clean-install test's consumer project, importing nothing but
  `nexus-ai-pro/adapter-kit` from the installed tarball. A deliberately broken store fails exactly the
  checks it breaks.
- A Nexus agent and a remote agent complete tasks over A2A in both directions:
  - A client that writes raw JSON-RPC, as the specification describes it, drives the served agent
    through a conversation, an approval, streaming, cancellation, and each error code.
  - The client and tool complete tasks against a stub agent written from the specification alone.
  - One Nexus agent calls another through the tool.
- A frontend renders a run through AG-UI with a plain `fetch` and Server-Sent Events parser, and
  no Nexus client code, approval and resume included.
- An editor's end of an ACP connection approves an edit, and sees the plan, the diff, and the
  answer.
- The kernel's tests pass on Node.js, Deno, Bun, and Vercel's edge runtime, and CI runs all four.
  The tests are written against web-standard APIs only, with no test framework and nothing of Node's,
  and they cover a provider over `fetch`, the client, a cached graph, an agent, and A2A and AG-UI.
  A check walks every entry point's imports, static and dynamic. It fails the build when the client,
  the kernel, a provider adapter, graphs, agents, or a protocol reaches anything Node-only.
- Every graduated surface passes its contract on every backend it supports. For the context hub,
  that is memory, files, Redis, and Postgres, with two hubs racing for one label and never both
  winning. For the retrievers, it is a vector retriever over memory, SQLite, and pgvector, besides
  the keyword and hybrid retrievers.
- What the published 2.3.0 package wrote, this release reads, and what it derived, this release
  derives the same: a SQLite file shared by a 2.3 and a 2.4 worker, a pgvector table, loader ids,
  retriever rankings, MCP configurations, context bundle versions and exports, insight proposals
  and error signatures, and canary routing, thread by thread.
- Each security fix has a test that names the attack, and fails on the code before it. The Git test
  runs on Linux, where links are tracked as links, and the race test holds both writers until both
  arrive, so it does not depend on timing.

## [2.3.0] - 2026-10-06

Agents that act safely, on production retrieval.

### Added

- **Capabilities and permission policies.** A tool declares what each call does —
  `filesystem:write:<path>`, `network:<host>`, `shell:<command>`, `code`, or an effect of the
  application's own — as a list or a function of its arguments. `permissionPolicy()`, on the new
  `nexus-ai-pro/agent/permissions`, grants filesystem globs, network hosts, and shell command
  prefixes, and decides each call: allow, deny, or ask. Paths are normalized before any grant sees
  them, and a command that chains, pipes, or substitutes is never granted by a prefix.
  `createAgent({ permissions })` enforces it before a tool runs: a denied call never runs, an `ask`
  interrupts as `interruptOn` does, and arguments an approver edits are decided again.
- **A sandbox contract**, on the new `nexus-ai-pro/agent/sandbox`: the `Sandbox` interface a
  container, VM, or hosted interpreter fills; `sandboxTools()`, whose calls declare exactly the
  command or path they use; `runSandboxConformance()`, which proves any sandbox against the
  contract; and `processSandbox()`, a reference for development that is never a security boundary
  and says so.
- **The linter reads capabilities.** `SENSITIVE_TOOL_WITHOUT_APPROVAL` reports a tool that writes, runs
  commands or code, or reaches the network with neither approval nor a policy;
  `UNDECLARED_TOOL_CAPABILITIES` a tool whose effects cannot be judged; and
  `SIDE_EFFECT_BEFORE_INTERRUPT` a node that declares `effects` and `interrupts`. An agent's graph
  describes its tools for it.
- **A middleware catalog**, on the new `nexus-ai-pro/agent/middleware`, each a separate import:
  `modelRetry()`, `modelFallback()` (to another model or another client), `dynamicModel()`,
  `toolRetry()` (which by default repeats only a call that cannot have changed anything),
  `toolSelector()` (by rule, embedding similarity, or both), `contextEditor()` (clears old tool
  results in batches, so a prompt cache keeps working), `piiMiddleware()` (validated card numbers
  and IBANs; redact, mask, hash, or block), `humanApproval()` (per call, in band or out of band),
  `modelCallLimit()` (per run and per thread, the thread count shared through the store), and
  `filesystemContext()` (instruction files in, large results out to a file). The three existing
  middleware are there too.
- **A wider middleware seam.** `wrapModelCall` wraps the model call itself, and may call `next()`
  again to retry or fall back. Every hook receives an `AgentMiddlewareContext`: the state, the
  store, the thread and tenant, the run's signal, and `interrupt()`. `context.stop()` ends a run
  with an answer and the new `stopReason: 'stopped'`. A `wrapToolCall` can pass `next()` changed
  arguments, which the permission policy decides again.
- **Server authentication**, on the new `nexus-ai-pro/server/auth`. It is built on Web Crypto, with no
  dependency:
  - `jwtAuth()` takes an identity provider's key set (cached, and refetched when a token names a new
    key), a public key, or a shared secret, and checks issuer, audience, expiry, and age. It refuses
    `alg: none` and key confusion, and requires an audience with a key set.
  - `apiKeyAuth()` compares keys by their SHA-256 hash, from `hashApiKey()`.
  - `trustedProxyAuth()` refuses to exist without proof that the proxy sent the request.
  - `anyAuth()` combines hooks.
  - `createJwtVerifier()` verifies tokens outside the server.
- **One Principal, everywhere a run goes.** It gains `roles`, `method`, and `claims`.
  - Graph and workflow runs take a `principal`, which nodes read as `context.principal`. Its tenant
    becomes the run's, and its subject is recorded on every checkpoint and in the run's trace.
  - `graphAssistant()` passes the authenticated caller on.
  - Tools receive a `ToolContext` as the second argument of `execute`: the principal, the thread
    and tenant, the run's signal, and the tenant's store.
  - Middleware and permission policies see the principal too.
- **Sparse retrieval as a contract.** A `SparseRetriever` is keyword search that takes writes, so it
  fuses with vector search and stays in step with a vector store. `KeywordIndex` is one. Two more
  ship:
  - `PostgresKeywordIndex` (`nexus-ai-pro/postgres/fulltext`) uses Postgres full-text search, with a
    GIN index and ranking in the database. With `shared`, it searches a pgvector table through a
    generated column, so hybrid search keeps one copy of the data.
  - `ElasticsearchKeywordIndex` (`nexus-ai-pro/rag/elasticsearch`) works with Elasticsearch or
    OpenSearch over the REST API, with no client library.
- **Rerankers**, on the new `nexus-ai-pro/rag/rerankers`, with no SDK:
  - `cohereReranker()`, `voyageReranker()`, and `jinaReranker()` for hosted APIs;
  - `teiReranker()` for a self-hosted cross-encoder;
  - `httpReranker()` for any other API;
  - `crossEncoderReranker()` for a model run in process.
- **Durable ingestion**, on the new `nexus-ai-pro/rag/pipeline`. `createIngestionPipeline()` keeps a
  manifest in any `Store`: each document's content version, its chunking, the embedding model, and
  each chunk's version. A run:
  - embeds only new and changed chunks; chunks are named by their text, so one that only moved keeps
    its embedding;
  - deletes the chunks and documents that are gone;
  - keeps keyword indexes in step;
  - writes to the stores before the manifest.

  `ingestionExecutor()` runs it as a durable operation, and a retry starts at the document the
  failed attempt stopped on.
- **A deep-agent preset**, on the new `nexus-ai-pro/deep-agent`. `createDeepAgent()` is
  `createAgent()` composed with:
  - a plan, kept in the transcript;
  - a sandboxed workspace, with `edit_file` for precise changes and commands granted by name;
  - helpers behind one `delegate` tool, which never get a tool that needs approval;
  - skills loaded on demand;
  - instruction files and context offloading;
  - context editing, optional tool selection, and a default permission policy.

  It returns the same compiled graph as any agent; it is not a new engine.
- `processSandbox()` loads Node's modules when first used, so `nexus-ai-pro/agent/sandbox`, and a
  deep agent over a container sandbox, import on any runtime.

### Fixed

- `MemoryStore` swept every item for expiry on every write, so writing n items took time
  proportional to n². It now sweeps only once an item has a time to live, and at most once a second.
  Expired items were already hidden from reads.

- `limitToolCalls()` counted calls in memory shared by every run of an agent, so one thread's calls
  used up another's limit, and the count never reset. It now counts per run from the transcript.
- A subgraph run through `asNode()` now runs for its parent's tenant, so its store is the tenant's
  view, as the parent's is.
- `sandboxTools()` file tools accept a path that names the mount, such as `/workspace/notes.txt`,
  as well as one relative to it, and say in their descriptions which to use.

### Proof

- In a real agent tool loop, a write outside the workspace and a request to an unlisted host are
  refused before their tools run, and a granted command that needs approval waits for a person.
- The process sandbox passes the conformance suite, and a sandbox that leaks the host's environment
  and writes outside its root fails exactly those two checks.
- An agent over 150 tools completes 40 tasks, a third of them needing two tools, with
  `toolSelector()` at equal quality: every task succeeds either way. Input tokens per task fall from
  about 64,000 to about 5,200, and latency by about 70%: the model's time computed from
  each request's size, plus the agent's own measured time. Two experiments, reported by
  `compareExperiments()`, show it.
- Each middleware is proved in a real agent loop. For example:
  - a charge that timed out is never retried;
  - an approver who raises a refund past what the policy allows has the edit refused;
  - two agents sharing a store share one thread budget;
  - a 45,000-character tool result reaches the transcript as a preview and a file.
- A JWT from a test identity provider is verified against its key set and reaches an agent's tool
  call as a `Principal` with its subject, tenant, roles, and scopes.
  - The tool's writes land in that tenant's view of the store.
  - The checkpoint records who ran the step.
  - Another tenant's token gets 404 for the thread.
  - Expired, wrong-audience, wrong-issuer, unsigned, and forged tokens are refused.
  - The provider rotates its key with one refetch.
- On the stored support dataset, on real Postgres with full-text search and pgvector, hybrid retrieval
  beats vector-only: recall@5 0.71 → 0.97 and mean reciprocal rank 0.51 → 0.71, both with a 95%
  interval above zero. A hosted reranker and a local cross-encoder, compared in the same experiment,
  each lift mean reciprocal rank to 0.97. One contract test runs against all four keyword indexes.
- An ingestion of 100,000 documents dies halfway inside a durable operation. Its retry starts at the
  document the first attempt stopped on, and embeds no chunk that had finished. A second run after
  ten documents are edited embeds exactly ten chunks and deletes their old versions.
- A deep agent completes a multi-step task on a fixture repository inside the reference sandbox. It
  plans, runs the failing test, reads and edits the bug, verifies the fix, has a helper review it,
  loads a skill, and records the change; the test then passes outside the agent. Along the way, a
  30,000-character log is offloaded to a file. The default policy refuses an unlisted command, a
  chained command, a write outside the workspace, and an ungranted tool.

## [2.2.0] - 2026-10-05

Production scale and safe upgrades. Every database schema is versioned, so an upgrade applies only
what changed, and a worker of the previous release keeps running beside the new one. A claim costs
the same however long the queue is, routing costs the same however many models are configured, a
circuit breaker counts every worker's failures, and work that several replicas race for is taken by
exactly one. One tenant model reaches every store, and a deployment can check itself. Nothing
changes until it is opted into, except races and leaks that are now closed.

### Added

- **Versioned migrations.** Every Postgres and SQLite adapter's schema is a list of numbered
  `SchemaMigration`s, recorded in `nexus_schema_migrations` with a checksum. `migrate()` applies what
  is pending, under a lock that holds through a connection pool, and refuses a migration whose
  statements changed after it ran (`SchemaMigrationError`). Version 1 is the schema 2.0 created, so an
  existing database is recognized as it is. `applyPostgresMigrations()`, `postgresMigrationStatus()`,
  `postgresMigrations()`, and their SQLite twins work on any list, from `nexus-ai-pro/postgres`,
  `nexus-ai-pro/sqlite`, and the new `nexus-ai-pro/postgres/migrations` and
  `nexus-ai-pro/sqlite/migrations`. `PostgresMigrateOptions.transaction` runs each migration in one
  transaction on one connection, and `postgresMigration({ record: true })` records what the script
  creates.
- **`nexus db status` and `nexus db migrate`**, through a module that exports your own client:
  applied, pending, changed, and newer migrations, `--check` for a deploy step, and `--dry-run`.
- **Indexed dispatch.** Version 2 of the Postgres and SQLite operation schemas indexes queued work by
  age, so a claim reads the oldest few rows instead of sorting the queue, and version 3 by tenant.
  `RedisOperationStore` takes `index: true`: queued work in a sorted set by age and leased work in one
  by lease expiry, kept in the same Lua call as the record, with `reindex()` to index what is already
  stored. A claim reads the same handful of records with 100,000 operations queued as with 1,000.
- **A circuit breaker that counts across workers.** `shareObservations: true` adds each worker's
  calls to a rolling window in the shared store, so nine failures over three workers count as nine
  and the circuit opens on all of them. Checks stay synchronous; a worker learns the shared count on
  its next sync. `CircuitStateStore.observe()` is implemented by the memory, Redis, and Postgres
  stores, and `CircuitSnapshot.shared` reports the window.
- **`PostgresRollupStore`**, on the new `nexus-ai-pro/postgres/rollups`: hourly rollups beside the
  traces, summed in one statement so two workers adding to one hour both count.
- **A routing index.** The auto-router plans once per configuration — candidates, allow and deny
  lists, capability requirements as bitmasks, and strategy scores — and a request pays only for open
  circuits and health. Over 1,000 models a warm route takes about 15 µs at p50 and 23 µs at p99.
- **One tenant model**, on the new `nexus-ai-pro/tenancy`: a tenant's view of every store —
  `tenantStore()`, `tenantTraceStore()`, `tenantOperationStore()`, `tenantPromptStore()` (and with it
  the context hub), `tenantDatasetStore()`, `tenantExperimentStore()`, `tenantVectorStore()`,
  `tenantCache()`, `tenantAssetStore()`, `tenantRollupStore()` — each implementing the store's own
  contract over any backend, and `tenantScope()` for all of them at once. Graph runs take a
  `tenantId`: recorded on every checkpoint, read as `context.tenantId`, scoping `context.store`, and
  refusing another tenant's resume, continue, fork, or edit. `graphAssistant()` passes the
  principal's tenant. Operations carry `tenantId`, and `OperationStoreFilter.tenantId` narrows queue
  reads. Model calls are traced with their `tenantId`, so rollups count model spend per tenant, and
  `rateLimit.key: 'tenantId'` gives each tenant its own share of a client's rate limit.
- **Cache namespaces and outcomes.** `cache.namespace` keeps responses apart by tenant, environment,
  model revision, and context version. Every response reports `meta.cache` — `hit`, `miss`, `stale`,
  `bypass`, or `error`, with its layer and reason — and the request's trace records it.
  `CompletionRequest.responseCache` skips the cache (`bypass`) or refreshes it (`refresh`).
- **`nexus doctor`**, and `diagnose()` on the new `nexus-ai-pro/doctor`: the Node.js version,
  optional packages, provider credentials (by name only), database connectivity and pending or
  changed migrations, Redis, lapsed leases and a stalled queue, the registry's age, stale provider
  health, and process-local stores behind several replicas. It exits 1 on a failure, or with
  `--strict` on a warning.
- **Runtime budgets.** `npm run bench:runtime`, part of the release gate, times fourteen paths — graph
  creation, a 1,000-node compile, `Send`, checkpoints, routing at three registry sizes, a
  20-middleware agent, traces, the event stream, server event fan-out, claims, and cache lookups —
  as ratios to a calibration loop, so a budget holds across machines, and checks that 100,000
  checkpoints and 10,000 runs leave the heap where it was.
- **Workflow steps have what graph nodes have.** `timeout: { runMs, idleMs }` with
  `context.heartbeat()`, an `onError` that decides once retries run out — recorded as `recovered`,
  so a resume repeats neither the step nor its recovery — `stepDefaults`, a `control` that drains
  between steps and ends in `GraphDrainedError`, and `tenantId`. A workflow the agent server serves
  is handed off on a drain like a graph.
- **A function assistant hands its run off on a drain**: it checks `context.control?.draining`,
  saves how far it got with `context.saveProgress()`, and throws `RunHandOffError`; the next worker
  reads `context.progress` and carries on.

### Changed

- `migrate()` on every Postgres and SQLite adapter resolves to a `MigrationResult` instead of
  nothing, records what it applied, and loads the migration runner only when called.
- `nexus db sql` and `postgresMigration()` include the rollups table and the new indexes by
  default; every statement stays idempotent.
- The root import grew by 11 KB, to 336 KB, with the routing plan, cache outcomes, and linked
  signals; `nexus-ai-pro/graph` by 5 KB, to 78 KB, with tenant runs; and
  `nexus-ai-pro/graph/functional` by 6 KB, to 32 KB, with step timeouts, recovery, drain, and
  tenants.

### Fixed

- **Two replicas could both start a run on one busy thread.** The busy check read and wrote
  separately. A thread is now claimed through the operation store under a unique key with
  compare-and-set, so exactly one run proceeds and the rest meet the busy policy. An `enqueue` start
  still busy when `queueTimeoutMs` runs out is refused instead of running beside the other.
- **Two submissions under one idempotency key could both run** on the in-memory and Redis operation
  stores, which overwrote the key's owner. Both now refuse a second record under a key another record
  holds, as Postgres and SQLite do, and Redis checks and writes in one Lua call.
- A circuit breaker's calls recorded before its shared-state module finished loading were not
  shared.
- **Security: the semantic response cache answered one tenant with another's response** when their
  questions were alike, because it compared every entry regardless of tenant. A semantic match is
  now kept to the request's tenant and cache namespace.
- A response cache that threw failed the request, and one that failed to store an answer failed it
  after the provider had answered. Both are now reported in `meta.cache`, and the request goes on.
- The auto-router rebuilt the model registry for every candidate on every request: over 1,000 models
  a request took most of a second.
- **Memory grew with every run that shared a signal.** `AbortSignal.any()`, which composed each task
  attempt's signal, keeps a reference per call for as long as any source lives in Node 22, so a
  server's or a worker's long-lived signal held about 5 KB per graph run, and every client operation
  with a deadline held one too. Signals are now linked and released when their work ends; 10,000
  runs leave the heap within 0.3 MB of where it started, down from 52 MB.

### Proof

- A database created by the published 2.0.0 package upgrades with 2.2's migrations, on Postgres and
  SQLite, and a published 2.1.0 worker and a 2.2 worker drain one queue together, nothing run twice.
- Ten workers race one thread, one idempotency key, one queue, one tenant's slots and budget, and one
  circuit, on every shared store, and every invariant holds.
- A Redis claim reads the same number of records at 1,000 and 100,000 queued; Postgres and SQLite
  plan a claim through the age index with no sort.
- The Redis stores' Lua runs for real in the tests, in a Lua VM over an in-memory Redis.
- The routing index decides exactly as the published 2.1.0 router on 300 random configurations, and
  a warm route over 1,000 models stays under 100 µs at p50 and 1 ms at p99.
- A tenant-isolation suite runs against every storage adapter — memory, Redis, Postgres, SQLite, and
  files — and fails on any cross-tenant get, list, search, delete, fork, resume, trace query, vector
  search, or cache hit.
- `nexus doctor` reports each misconfiguration a fixture deployment is seeded with — an old Node.js,
  no credentials, an old registry, pending migrations, an unreachable Redis, a lapsed lease and a
  stalled queue, stale health, and memory stores behind three replicas — and passes it once fixed.
- A workflow and a function assistant are each drained on one worker and finished on the next, with
  every step and every item run exactly once.

### Not in this release, and why

- **The migration lock is a row with a lease, not a session advisory lock.** A session lock does not
  hold through a connection pool or a serverless driver, where each statement may reach another
  connection; a lease row does, everywhere. Without a `transaction` function, statements run one at a
  time, which is safe because every bundled statement is idempotent.
- **The Redis dispatch index is opt-in**, since a 2.1 worker writes records without index entries;
  `stats()` on Redis still reads every record.
- **Consecutive failures across workers are counted as failures since any worker's last success.**
  Calls are reported in batches, so two workers' failures and successes in the same second may be
  ordered differently than they happened.
- **Tenant views scope by prefix and stamp, not by a column**, so they work over every backend
  unchanged; data written before a view was used is not the tenant's until it is copied under its
  prefix.
- **Runtime budgets compare ratios to a calibration loop**, which catches a cliff, not a 10% drift;
  the tolerance is three times the recorded ratio.

## [2.1.0] - 2026-10-04

Fault-tolerant graphs and crash-safe observability. A graph now chooses when its checkpoints are
written, recovers from a node whose retries ran out, tells a hung task from a slow one, and stops
cleanly when its worker has to go. Traces survive the process that wrote them and reach any
OpenTelemetry backend, every consumer of a run reads one event stream, and dashboards read hourly
totals instead of every trace. Nothing changes until it is opted into: the defaults keep their 2.0
meaning.

Two pieces planned for 2.3 come early: a rate limiter with no window edge to burst across, and
provider health that expires.

### Added

- **Durability modes.** `compile({ durability })` takes `sync` (the default), `async`, or `exit`.
  `async` writes checkpoints in the background, in order, while the next superstep runs, and waits
  for them before the run returns, pauses, fails, or drains. `maxPendingWrites` (8) bounds the writes
  in flight. `exit` writes only where the run stops. `flush()` waits for every run's writes.
- **Recovery after retries.** A node's `onError` receives a `NodeFailure` once its retries run out
  and returns an update or a `Command`, such as a route to a refund node. The decision is
  checkpointed, as `recovered` on the next checkpoint, before anything it routes to runs, so a crash
  after it resumes into the same path. `compile({ nodeDefaults })` sets retries, timeouts, and
  `onError` for every node.
- **Run and idle timeouts.** `timeout: { runMs, idleMs }` caps an attempt and the time between signs
  of progress. `context.heartbeat()`, `emit()`, and `report()` refresh the idle timer.
  `GraphNodeTimeoutError.kind` says which limit fired. A `Send` can override the timeout of the task
  it creates, and the override is checkpointed with the task.
- **Cooperative drain.** `RunControl`, passed as `control` to a run, stops it after its current
  superstep with its checkpoint written, ending in `GraphDrainedError`; `continue()` resumes it
  anywhere. The agent server drains its graph runs this way when a replica drains with a queue, so
  they are handed off at once instead of after the drain timeout.
- **`lintGraph()`** on the new `nexus-ai-pro/graph/lint`, and `nexus graph lint`: static cycles,
  retried nodes that are not `idempotent` or have no timeout, deferred durability with side effects,
  an in-process checkpointer under a deployment, unbounded concurrency, and unchecked routes. Nodes
  can declare `idempotent: true`, and `describe()` reports durability, the checkpointer, and each
  node's retries, timeouts, and recovery.
- **Progress that survives a retry.** An operation's `context.heartbeat(details)` stores `details` as
  `heartbeatDetails`, and the next attempt reads them as `context.previousHeartbeat`.
- A `task_failed` graph event, and a semantics table in the graph guide that says what each
  execution primitive repeats after a crash.
- **Crash-safe traces.** `new Tracer({ incremental: true })` writes each run when it starts and when it
  ends, so a crashed run stays in the store with every run beneath it that finished, and a live run
  can be watched. Sampling is decided at the root's start, and an unsampled trace is still kept whole
  when tail sampling wants it. `closeAbandonedRuns()` closes what a dead process left running, as a
  `RunAbandoned` error. `tracer.flush()` waits for writes and exports.
- **Traces across processes.** `handle.traceparent()` and `StartRunOptions.traceparent` carry a trace
  through a W3C `traceparent` header: an operation's `traceContext`, a remote call, any OpenTelemetry
  service. `w3cTraceId()` and `w3cSpanId()` give the ids every process derives alike.
- **OpenTelemetry export**, on the new `nexus-ai-pro/tracing/otlp`. `TracerOptions.exporters` takes any
  `TraceExporter`, and `OtlpTraceExporter` sends runs to a collector as OTLP/HTTP JSON with no SDK:
  model calls as `chat <model>` client spans with the GenAI semantic conventions, tools, agents, and
  graph nodes with theirs, and Nexus-only facts under `nexus.*`. `runToOtlpSpan()` is the conversion.
- **One event stream.** `graph.events()`, `resumeEvents()`, and `continueEvents()` run a graph as
  typed events with projections — `values`, `updates`, `messages`, `tools`, `tasks`, `checkpoints`,
  `custom` — read together or one at a time through `messages()`, `tools()`, `values()`, and
  `updates()`, with `result` for the outcome. Nodes stream model output with `context.message()`
  and report tool calls with `context.tool()`. Subgraph events come through with a `namespace` when
  asked, and `GraphRunOptions.subgraphEvents` does the same for `onEvent`.
- **Bounded readers.** Every reader of a stream has its own buffer (`maxBuffered`, 1,000), and the run
  waits for the slowest at each superstep. Within a step, `overflow` coalesces model chunks and state
  snapshots (the default), drops the oldest or newest, or fails with `GraphStreamOverflowError`.
  `streamStats()` reports the peak and what was merged or dropped.
- **Agents stream.** `createAgent()` reports its model's output and every tool call on the stream,
  token by token with `streamTokens` and a client with `stream()`. `traceGraph()` records the tool
  calls as `tool` runs inside their node. `graphAssistant(graph, { events })` records chosen
  projections on each server run.
- **Rollups**, on the new `nexus-ai-pro/tracing/rollups`: `rollupTraceStore()` adds every finished run
  to hourly rows per kind, model, provider, and tenant, in `MemoryRollupStore` or any `RollupStore`,
  with latency buckets for `rollupPercentile()` and `sumRollups()` to total them. The studio's costs
  view reads them when given `rollups`.
- **Timed replay.** `recordingFetch({ timing: true })` keeps each chunk of a response and when it came,
  and `replayFetch({ pace })` replays it at once, at the original pace, scaled, or released chunk by
  chunk by a function.
- **GCRA rate limiting.** `rateLimit.algorithm: 'gcra'` spreads calls at `maxRequests` per `windowMs`
  with at most `burst` at once, so a burst across a window edge can no longer pass twice the limit.
  Both stores decide it through `gcra()`; `RedisRateLimitStore` runs it as one Lua script on Redis's
  clock. `gcraDecide()` is the arithmetic, for a store of your own.
- **Health that expires.** `health.observationTtlMs` makes a provider with no recent calls `unknown`,
  routed to as one never seen instead of kept down by an old failure or up by an old success.
  Snapshots carry a `status` (`healthy`, `degraded`, `unhealthy`, `unknown`) and `stale`, and
  `ai.checkProviders({ staleOnly: true })` refreshes the unknown ones.
- **Evaluator provenance.** An experiment records each evaluator's position, name, the score keys it
  produced, and what `withProvenance()` declared — version, judge model, prompt version, temperature,
  and rubric — and the framework version that ran it. `LLMJudge.asEvaluator()` brings the judge to
  `evaluate()`, declaring its own provenance.
- A weekly `live-providers` workflow runs real conformance against every provider with a key in the
  repository's secrets, DeepSeek included, and opens an issue when one breaks.

### Fixed

- **A manual operation heartbeat no longer strands the result.** `context.heartbeat()` wrote the
  record behind the runner's back, so the runner's final write failed its sequence check and a
  successful result was not saved. Heartbeats now go through the runner, one at a time.
- `continue()` on a finished thread left it marked `running` with an empty result. It now leaves it
  completed and returns its state.
- A run started under a parent from another tracer, or another process, was never written: its trace
  waited for a root that was not there. It is now written as its trace's root in this process.

### Proof

- A crash-injection suite kills a run before, during, and after every checkpoint write and inside
  nodes, before and after their side effects, in `sync` and `async` mode, on the memory, operation
  store, SQLite, Postgres, and Redis checkpointers. A fresh process always reaches the state of an
  uninterrupted run.
- A saga test: a charge exhausts its retries, `onError` routes to a refund, the process dies during
  the refund, and the resumed run refunds without charging again.
- A property test generates 40 graphs with branches, loops, `Send`, retries, and interrupts, and
  replays each from every checkpoint of its history to the same state.
- The graph benchmark runs 50 supersteps against an 8 ms store: `async` finishes in about half the
  time of `sync`, in the same state, and CI fails if it stops beating it by a quarter.
- A long agent's process dies at its fourteenth step: a second process reads every finished step from
  the same JSONL store, and `closeAbandonedRuns()` closes the rest.
- A server and a worker each export to a local OTLP collector, and the collector receives one trace,
  the worker's run under the server's, with the GenAI attributes on the model call.
- A reader a hundred times slower than a node that streams 100,000 chunks never holds more than its
  buffer, under every overflow policy, and coalescing loses no text.
- The studio's costs view answers over a month of a million runs, held as rollups, in under 200 ms,
  reading the traces once.
- In the two milliseconds around a window's edge, fixed windows pass 199 calls of a 100-call limit and
  GCRA passes 100. A provider down on Monday and idle since is `unknown`, and routed to, on Wednesday.

## [2.0.0] - 2026-10-02

Consolidation. One lifecycle runs every call of every family, the root import holds the core client
and nothing else, and the package installs with no required dependency. Everything removed here was
deprecated in 1.x; [MIGRATING.md](./MIGRATING.md) covers each change with before-and-after code, and
`nexus migrate` rewrites the imports.

### Breaking

- **The root import keeps only the core**: the client, its config builders, its types, the errors it
  throws, the lifecycle, and the tool helpers. The 498 other names it re-exported are on their
  subpaths; `nexus migrate` moves 1.x imports there. Importing the root costs 323 KB, down from 572 KB.
- **`zod`, `ajv`, `ajv-formats`, and `@types/node` are optional peer dependencies.** A zod shape is
  checked through its own `safeParse`; a JSON Schema response format loads ajv on its first check, and
  says what to install when it is missing. A production install is 5.3 MB, the package alone, down
  from 12.3 MB.
- **A response's `estimatedCost` string is removed**, for the numeric `cost`. A plan's
  `estimatedCost` object stays.
- **Modalities say which way they flow.** `ModelCapabilities.inputModalities` and `outputModalities`
  are required on every entry, bundled or registered; `modalities`, the `Modality` type, and the
  `modalities` routing requirement are removed.
- **Checkpoint schema version 2.** A checkpoint has its `version`, an `id`, its `tasks` always, and its
  questions only in `interrupts`; `interrupt` is gone. Both checkpointers read version 1 for the whole
  2.x line, so threads 1.x left waiting resume. A checkpointer's `get()` and `history()` return a
  `StoredGraphCheckpoint` of either version.
- **Options that were never read are removed**: `GoogleProviderConfig.projectId`,
  `OllamaProviderConfig.timeout`, `MetricsConfig.prometheus`, `DensificationConfig.preserveMarkdown`,
  `HealthConfig.latencyHalfLife`, `InjectionDetectionConfig.sensitivity`, and
  `ToolPolicyConfig.requiresApproval`.
- **`ImageManagerConfig` is removed**, for `ImageConfig`.
- **`PipelineStepName` is a closed list.** A custom step is recorded as `customStep`, with its own name
  in `PipelineTraceStep.custom`. The `auditLog` step is replaced by the lifecycle's `audit`.
- **`ai.stream()` opens on its first read**, so authorization, rate-limit, guardrail, and budget errors
  come out of the loop rather than from the call.
- **What the lifecycle records changed**: metrics carry `family` and `operation` for every family, the
  image family is labelled `image`, audit events carry `family` and `operation` and add an `error`
  event, and `response.meta.requestId` is the operation's id.
- **The model registry is current as of 2026-10-02.** Models their providers shut down are removed:
  Claude 3.x and 4.0 to 4.1, `gpt-4.5-preview`, `o1-mini`, `gpt-5-codex`, Gemini 1.5 and 2.0 and the
  shut-down 3.x previews, Groq Compound, Llama 4 Scout, and Qwen3 32B, Mistral's 2024 models, Devstral,
  and Magistral, and DeepSeek's `deepseek-chat`, `deepseek-reasoner`, V3, and R1. Four names no
  provider served are gone too: `claude-sonnet-5-0`, `claude-haiku-5-0`, `claude-fable-5-0`, and
  `gemini-3.5-pro`. Cohere's `command-r` and `command-r-plus` are filed under their dated names, and
  `mistral-medium-3-5` under `mistral-medium-2604`. Every intent alias points at a current model.

### Added

- **One lifecycle for every operation.** Completions, streams, embeddings, voice, telephony, images,
  realtime sessions, graphs, agents, queued jobs, and provider batches pass through the same stages:
  validate, authorize, input policy, resolve assets, route, reserve budget, execute, output policy,
  persist, reconcile cost, and audit. `lifecycle` on the client configures what they share: an
  `authorize` callback that can refuse any call, a `budget` every family draws on, and `hooks` that see
  each call start and finish, cache hits included. `ai.lifecycle` makes graphs, agents, workflows,
  realtime sessions, job queues, and batches operations of the client too.
- **A shared spend budget**: `budgetLedger()` on the new `nexus-ai-pro/lifecycle` holds each call's
  estimate before it runs and charges what it cost after, per tenant and per period, so concurrent calls
  cannot overshoot together. It keeps totals in memory or in any tenant usage store, Redis included.
- **`ProviderCallContext`**, handed to every provider call of every family: the request id, the abort
  signal, the deadline, trace headers, and the idempotency key. The OpenAI and Anthropic adapters send
  the key and the headers on. Requests take `requestId`, `tenantId`, and `idempotencyKey`.
- **Mixed text-and-asset content.** `toolOutput()` lets a tool return text, images, and asset
  references, sent as the tool message itself instead of base64 JSON. An `asset` content part names an
  asset by reference, an image part can carry an asset, and a model that produces images returns them
  on `response.assets`.
- **Typed pipelines**: `PipelineContext` and the runner are generic over the request and response, with
  `PipelineShapes` for another family's types.
- **New models**: OpenAI GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna, GPT-5 Pro, o3-pro, and
  GPT-5.3 Codex; Claude Fable 5.1, Opus 5.5, Sonnet 5.5, Fable 5, Opus 5, Sonnet 5, and Sonnet 4.5;
  Gemini 3.8, 3.7, and 3.6 Flash, 3.5 Flash-Lite, 3.1 Flash-Lite, 3 Pro Image, and 3.1 Flash Image;
  Groq's Qwen3.8 27B and MiniMax M2.7; Mistral Medium 3.5 and Ministral 3 14B, 8B, and 3B; DeepSeek
  Flash and V4 Pro; and Cohere Command A Plus, North Mini Code, North Small Translate, and three Tiny
  Aya models.
- `ModelCapabilities.sampling`, false for a model that accepts only its default temperature and top-p.
  Negotiation drops a non-default value for it.
- `nexus migrate` lists each model name the 2.0 registry dropped, with what to use instead.
- Anthropic responses report thinking tokens in `usage.reasoningTokens`.
- **`llms.txt` and `llms-full.txt`** for AI assistants and coding agents: an index of every guide with
  the facts an assistant needs to recommend the package correctly, and the guides in one file.
  `llms.txt` ships in the package. Both are generated from the README and the guides, and CI fails
  when they fall behind.
- `toCheckpoint()` and `CheckpointDraft` for building a version 2 checkpoint by hand.
- A `cache_hits` metric, and `routingDecision.provider` and `.model` on a response.

### Changed

- Provider adapters, and the agent, verification, evaluation, workflow, semantic-cache, image, and
  embedding engines, load on first use, so importing the client never loads them.
- A context-window summary is an operation of its own, authorized, budgeted, and audited.
- `getCall()`, `listPhoneNumbers()`, and `updatePhoneNumber()` run through the lifecycle, so they are
  rate-limited and audited like `createCall()`.
- `nexus migrate` lists the options and model entries 2.0 removed, and keeps a single moved name on
  one line.
- **Prices and limits follow the providers.** GPT-5.6, GPT-5.2 Pro, Mistral Large 3, and Mistral
  Small 4 cost less. Gemini 3.5 Flash costs $1.50 and $9 per million tokens, not $0.10 and $0.40.
  Claude Opus 4.5 has a 200K context and 64K output, not 1M and 128K, and Codestral a 128K context.
  Models with an announced shutdown are `deprecated`, with the date and the replacement in their
  notes, and an alias that resolves to one is deprecated too.
- `toolChoice: false` now means a call cannot be forced: negotiation drops `required` or a named tool
  and lets `auto` and `none` through.

### Fixed

- **Claude 4.6 onward get adaptive thinking.** The Anthropic adapter sent every model a thinking
  budget, which Claude rejects after 4.6, so a request with `reasoning` failed on current models. It
  now sends adaptive thinking and `output_config.effort` from 4.6 on, and turns thinking off the way
  each model allows. It drops sampling values that Claude 4.7 and later reject, and leaves room for
  thinking when no output limit is set.
- **Tool calls reach providers whole.** The OpenAI chat and Responses, Anthropic, and Google adapters
  dropped a conversation's tool calls and the ids that link results to them, so a real tool loop could
  fail on its second turn. Each now sends both the way its API expects, images in results included.
- **Responses are priced on the model they were routed to.** A provider that echoed a dated snapshot
  name priced the call at nothing; Groq, Mistral, and Cohere models filed under a prefix did too.
- `resolveModel('google/gemini-2.5-flash')` found no capabilities for a provider-prefixed name. It now
  finds the entry filed without the prefix, when that entry belongs to the same provider.
- Streams honour the circuit breaker, the cost budget, audit, and metrics, as completions always did.
- A cache hit is audited and counted.
- The upload scanner's types no longer need Node's: `content` takes text or any `Uint8Array`.

## [1.25.0] - 2026-10-01

The bridge to 2.0. Everything 2.0 removes is deprecated now, every capability has a subpath of its
own, and the tools to migrate ship with it, so a codebase can move while it is still on 1.x.

### Added

- **A subpath for every capability.** What could only be imported from the root has an entry point
  of its own, each with no third-party dependency: `nexus-ai-pro/grounding` (grounded prompts,
  verification, self-consistency, knowledge graphs), `/connectors` (web tools), `/ops` (metrics,
  health, audit, OpenTelemetry export, rate limiting), `/pipeline`, `/router`, `/testing`
  (conformance suites), `/next` (the route handler), `/rag/files` (scanned file ingestion), and
  `/optimizer/cost` (cost estimates and budgets). Grounding alone is 15 KB, where it used to mean the
  584 KB root and its validators. `hardenPrompt()` joins `/security`, `Tokenizer` joins `/optimizer`, the
  registry's data joins `/models`, and the capability types join `/capabilities`.
- **`nexus migrate`**, a codemod that moves imports to the subpaths the 2.0 root keeps them on. It
  rewrites `import`, `import type`, `export … from`, and destructured `require()` in TypeScript,
  JavaScript, and Markdown code blocks, keeps local names when a name moved under another, and lists
  what it cannot rewrite safely. `--check` fails a CI job while anything is left.
- **`MIGRATING.md`**, shipped in the package: every change 2.0 makes, with before-and-after code.
- **Modalities with a direction**: `inputModalities` and `outputModalities` on a model's capabilities,
  `modalitiesOf()` on `nexus-ai-pro/models` to read either shape, and both as routing requirements.
- **The 2.0 checkpoint schema, readable now**: `migrateCheckpoint()` and `GraphCheckpointV2` on
  `nexus-ai-pro/graph`.

### Deprecated

- 499 exports of the root import, each in favour of the subpath that already provides it. 2.0 keeps
  only the core client, its config builders, its types, and the errors it throws on the root. Editors
  strike a deprecated import through and name the subpath; `nexus migrate` moves them.
- `ModelCapabilities.modalities` and `routing.requiredCapabilities.modalities`, for the directional
  fields. The routing requirement warns once per process.
- `GraphCheckpoint.interrupt`, for `interrupts`.

### Changed

- The guides' examples import from subpaths, as 2.0 requires.

### Fixed

- The agents guide pointed at `nexus-ai-pro/connectors`, which did not exist. It does now.
- `tenantLimits({ now })` drives the default usage and rate stores too. They kept the system clock, so
  a budget judged on a replaced clock reset when the real day ended.

## [1.24.0] - 2026-09-30

Deployment at scale, self-managed. Running assistants as a service without a hosted platform:
revisions and canaries, a worker pool that scales on its queue, and limits per tenant.

### Added

- **Revisions and canaries** on `nexus-ai-pro/server/deployments`. `Deployments.assistant()` serves
  several revisions of an assistant from one image; the traffic split is recorded in the server's
  state store and changed with `canary()`, `split()`, `promote()`, and `rollback()`, each kept in a
  history with who and why, and guarded by an expected version. New threads and stateless runs are
  split by a stable hash, a thread keeps its revision while that revision takes traffic, and every
  run records its revision, share, reason, and the deployment version.
- **A canary guard**: `watchCanaries()` compares each canary with the live revision over the same
  window, rolls it back when its error rate, latency, or cost regressed, and moves one that holds up
  through its `steps` to promotion. A latency rise must be at least `minLatencyChangeMs`, 50 ms by
  default, so noise on fast runs never rolls a canary back. `compareRuns()` on `nexus-ai-pro/insights`
  is the comparison, lifted out of `detectRegressions()`.
- **A worker queue** in the agent server: with `queue`, a replica runs at most `concurrency` runs and
  leaves the rest queued for the next free worker; `claim: false` makes an API replica. Replicas take
  over lapsed runs every `recoverEveryMs`. `drain()` answers `/health` with `503`, stops claiming, and
  hands runs still going after its timeout to another worker without using a retry.
- **Scaling signals**: `GET /scaling` as JSON and `GET /metrics` in Prometheus text — queued and running
  runs across the deployment, their load, the oldest wait, lapsed leases, each replica's capacity, and
  run counts and latency per revision. `metrics: { public: true }` serves them to in-cluster scrapers.
- **Kubernetes and Helm**: `deploy/app` is one image run as an API, a worker, or both, configured from
  the environment; `deploy/kubernetes` has the manifests with a KEDA `ScaledObject` and an HPA
  alternative; `deploy/helm/agent-server` is the chart. The clean-install test runs the template against
  the packed package.
- **Tenant limits** on `nexus-ai-pro/server/tenancy`: `tenantLimits()` holds each tenant to its active
  runs, its runs per window, and its spending per period, answered with `429` and `Retry-After`.
  `MemoryTenantUsage`, and `RedisTenantUsage` with atomic scripts so replicas share one set of limits.
  Assistants record spending with `context.recordCost()`; `GET /usage` reports it.
- **Replica health**: with `deployments`, each replica heartbeats its runs, capacity, drain state, and
  revisions, readable from `GET /replicas`.
- **A deployments view** in the studio: traffic splits and history, each revision's runs, error rate,
  and latency since the last change, replicas, the queue, and tenant usage, with canary, promote, and
  rollback for admins.
- **`nexus deploy`**: `status`, `canary`, `promote`, and `rollback` against a running server, for the
  pipeline that rolls out an image.
- Operation queues: `OperationRunner.enqueue()`, `claimQueued()`, and `release()`; `listQueued()` and
  `stats()` on every operation store, and `operationStats()`.
- Run records gain `revision`, `startedAt`, `finishedAt`, `durationMs`, `cost`, `worker`, and `attempt`.

### Changed

- `GET /health` is answered without authentication, so a load balancer's or Kubernetes' probe reaches
  it.
- A worker never takes over an operation whose lease another worker still holds.
- `RedisStoreLikeClient` declares `set()` with its expiry and `del()` with one key, the shapes an
  `ioredis` client satisfies as it is.
- The last nine guides are rewritten for readability.
- `nexus-ai-pro-studio` requires nexus-ai-pro 1.24 or newer.

### Fixed

- The deployment templates run. The Dockerfile started a file the build never produced, and the
  example server ignored `REDIS_URL`, so its replicas shared nothing.

## [1.23.0] - 2026-09-30

The team engineering platform. The studio becomes something a team shares, and it starts finding
problems on its own.

### Added

- **A shared studio.** Accounts through an authenticator — personal links, identity headers from a
  signing-in proxy, or bearer tokens verified by your function, such as OIDC — with four roles
  (viewer, reviewer, editor, admin), an audit log of every change and every refused attempt, comments
  on runs, review items, proposals, threads, and bundles, per-person page tokens for changes, and
  `Secure` cookies behind HTTPS. Local, token-only use stays the default. The CLI gains `--users` and
  `--journal`, and a config module may export `options`.
- **The context hub** on `nexus-ai-pro/context-hub`: prompts, instructions, tool sets, skills, and
  settings versioned together as bundles, committed by content, labelled, promoted through evaluation
  gates, diffed, rolled back, and exported with their prompts to move between projects. Bundles live in
  any prompt store. The studio shows them.
- **Insights** on `nexus-ai-pro/insights`: failing and slow runs clustered by error, trajectory, or
  meaning; regressions between two time windows; and, opt-in, a proposed fix — a candidate prompt or
  bundle version — evaluated against the dataset before it waits in the studio's inbox for a person
  to promote, with an optional pull request through an injected client.
- **Evaluation caching**: `evaluate()` reuses a target's outputs when the example and the target's
  fingerprint are unchanged, so a comparison re-runs only what changed; evaluators always run again.
  `MemoryEvaluationCache`, `FileEvaluationCache`, and `fingerprintOf()` on `nexus-ai-pro/evaluate`;
  `evaluatePrompt()` fingerprints the prompt version itself.

### Changed

- The guides are rewritten for readability: each says what its feature is for before its options,
  options and fields are in tables, and long sentences are split. Every export is still explained.
- `nexus-ai-pro-studio` requires nexus-ai-pro 1.23 or newer.
- The studio's development type paths map each entry point to the file it publishes, so studio tests
  exercise what the package ships.

## [1.22.0] - 2026-09-29

Retrieval and integration breadth. Getting documents in, finding the right ones, and reaching the
tools a team already runs, without a catalogue of dependencies.

### Added

- **Document loaders** on `nexus-ai-pro/loaders/*`, one entry point per format: text files and
  directories, Markdown with front matter, HTML, CSV, JSON and JSON Lines, PDF through a parser you
  inject, web pages and sitemaps through the SSRF-safe fetch, and Git repositories. Each streams
  documents, and `loadIntoStore()` splits them into chunks and adds them to one or more stores in
  batches.
- **Four more vector stores** behind the `VectorStore` contract, each through REST or an injected
  client: Redis with RediSearch (`nexus-ai-pro/rag/redis`), Pinecone, Weaviate, and Chroma
  (`nexus-ai-pro/rag/pinecone`, `/weaviate`, `/chroma`), plus `SqliteVectorStore` on
  `nexus-ai-pro/sqlite/vectors`, ranked in JavaScript or by sqlite-vec. All pass the same contract
  test, which now also checks that a filter matches a value's type.
- **Composable retrievers** on `nexus-ai-pro/rag/retrievers`: BM25 keyword search (`KeywordIndex`),
  hybrid search fused by reciprocal rank, reranking through any scorer or a chat model, maximal
  marginal relevance, parent-document retrieval, and multi-query retrieval.
- **Retrieval evaluators**: `recallAtK()` and `reciprocalRank()` on `nexus-ai-pro/evaluate`.
- **An MCP registry** on `nexus-ai-pro/mcp/registry`: many servers from one configuration file —
  including the file desktop MCP clients use — with per-server allow and deny lists, credentials from
  the environment by placeholder, health checks, and named tool bundles.

### Changed

- `SqliteValue` includes bytes, which the drivers bind as blobs.

### Fixed

- `ingestDocuments()` honours `overlap: 0`. It used the default overlap of 150 characters instead.

## [1.21.0] - 2026-09-29

Durable execution everywhere. Durability no longer requires drawing a graph, and a crash costs a
step rather than a run.

### Added

- **Functional workflows**, experimental, on `nexus-ai-pro/graph/functional`. `workflow()` makes an
  ordinary async function durable: each `step()` records its result, so a workflow that is resumed,
  continued, or recovered on another worker returns finished steps from its checkpoint and carries on
  from the first that did not finish. Steps run in parallel through `Promise.all`, bounded by
  `maxConcurrency`, with per-step retries and timeouts; `interrupt()` pauses for a person exactly as in
  a graph node; and the checkpoints are ordinary graph checkpoints, so every checkpointer stores
  them, `traceGraph()` records them, and `graphAssistant()` serves a workflow on the agent server.
- **Step-level recovery in the agent server.** A run recovered after its worker died continues from
  the last checkpoint that run wrote — for graphs and workflows served by `graphAssistant()` — so
  only the step in flight runs again. `AssistantRunContext.attempt` reports the attempt, and the new
  optional `ServerAssistant.recover()` hook is how an assistant continues.
- **SQLite persistence** on `nexus-ai-pro/sqlite`: `SqliteOperationStore` for durable operations and,
  through `OperationStoreCheckpointer`, graph and workflow checkpoints; and `SqliteStore` for
  long-term memory. Both take the database you open — `node:sqlite` and `better-sqlite3` directly,
  libSQL through `fromLibsql()` — so no driver is a dependency, and both pass the same contract tests as
  the memory, Redis, and Postgres stores.
- **Diagrams as images.** `toSvg()` on `nexus-ai-pro/graph/visualize` draws a graph as a standalone,
  escaped SVG document with no dependency. `layoutGraph()`, the layered layout underneath, moved from
  the studio into the core visualizer, so both draw the same diagram.

### Changed

- The server reads a streamed event's `output` before its `state` when it records a run's output, so a
  workflow's return value is the run's output.
- `nexus-ai-pro-studio` requires nexus-ai-pro 1.21 or newer, and re-exports `layoutGraph()` from the
  core visualizer.

### Fixed

- `guardrailPolicy()`, `GUARDRAIL_POLICIES`, `calibrateSemanticInjectionClassifier()`, and
  `SEMANTIC_INJECTION_CALIBRATION_SET` are exported from `nexus-ai-pro/security`, and the four domain
  workflows such as `supportTriageWorkflow()` from `nexus-ai-pro/workflows`, as their guides already
  showed. They were reachable only from the package root. A new docs check fails when a guide's
  example imports a name from an entry point that does not export it.

## [1.20.0] - 2026-09-28

Retrieval that scales past one process. Deprecated options now say so at run time, and every guide
explains every export it lists.

### Added

- **Vector stores for retrieval.** `VectorStore` is a shared contract — `add()`, which replaces a chunk
  whose id already exists, `search()`, `searchVector()` for a vector computed elsewhere, `delete()`,
  and an exact-match metadata `filter` — with three implementations checked by one contract test:
  - `PostgresVectorStore` on `nexus-ai-pro/postgres/vectors`, ranking with pgvector in the database,
    with an HNSW index by default or an exact scan. `vectorStoreMigration()` gives its schema, and
    `postgresMigration()` and `nexus db sql` include it when `vectors` is named.
  - `QdrantVectorStore` on `nexus-ai-pro/rag/qdrant`, through Qdrant's REST API with `fetch` and Web
    Crypto, so no Qdrant client is a dependency and it runs on edge runtimes. `migrate()` creates the
    collection and indexes filter fields; failures raise `QdrantError`.
  - `MemoryVectorStore`, which gains `searchVector()`, `delete()`, and the filter.
- Retrieval is reachable from `nexus-ai-pro/rag` — `MemoryVectorStore`, `createHashEmbeddings()`,
  `cosineSimilarity()`, `normalizeVector()`, `matchesMetadata()`, and the types — so an application
  that ingests and searches no longer loads the root import.
- **Deprecated options warn once per process** through Node's `DeprecationWarning` channel, with a
  `NEXUS_DEP_*` code each, so `--no-deprecation` silences them and `--throw-deprecation` fails a CI
  job on them: `GoogleProviderConfig.projectId`, `OllamaProviderConfig.timeout`,
  `MetricsConfig.prometheus`, `HealthConfig.latencyHalfLife`, `DensificationConfig.preserveMarkdown`,
  `InjectionDetectionConfig.sensitivity`, and `ToolPolicyConfig.requiresApproval`.

### Changed

- `MemoryVectorStore.add()` replaces a chunk whose id already exists instead of storing a second
  copy, so re-ingesting a document no longer duplicates its passages in search results.
- The guide check enforces that every export is explained in a guide's own text, not only named in
  its generated reference; the five remaining guides — operations, embeddings, evaluation, images,
  and realtime — now are. The README's limitations and production notes moved into the guides they
  belong to.

## [1.19.0] - 2026-09-28

A studio to look at it all. `nexus-ai-pro-studio` is a separate package — so the core install never
carries a UI — that shows what an application records, from its own stores, on the developer's
machine, with no hosted service.

### Added

- **`nexus-ai-pro-studio`**, experimental, with the `nexus-studio` command. Given a config module
  whose default export lists the application's stores, it serves eight views:
  - **Traces**: filtered run lists, run trees with inputs, outputs, cost, and latency, trace
    comparison, and feedback on a run.
  - **Threads**: each graph's diagram with the next nodes highlighted, state at any step, and fork,
    edit, and resume.
  - **Inbox**: every thread waiting for a human and every review item waiting for a grade.
  - **Experiments**: experiment and dataset lists, and comparisons with per-metric intervals and a
    verdict.
  - **Prompts**: versions, labels, history, diffs, gated promotion, rollback, and a playground.
  - **Costs**: cost per day and per model, the most expensive runs, and budgets.
  - **Health**: provider health, local and shared circuit state, metrics, and cache statistics.
  - **Operations**: the operation queue by status, and asset store totals.
- **Locked down for a local tool.** It binds `127.0.0.1`, requires a token that moves from the URL
  into an HTTP-only same-site cookie, requires the token in a header for every change, refuses
  non-loopback `Host` headers against DNS rebinding, and serves every page under a strict content
  security policy with every value inserted as text.
- `startStudio()` and `createStudio()` start it from code or mount it in an existing server.
- `npm run studio:demo` starts it on a demo application with something in every view.
- The operation-store checkpointer — the one behind Redis and Postgres — lists its threads through
  `threadIds()`, as the in-memory one already did, and `GraphCheckpointer` declares it as optional.

### Fixed

- **Secret detection on input now detects under every action.** It only scanned when the action
  was `mask`. Under the default action, `block`, and under `flag`, a request carrying a private
  key, a cloud or payment key, a token, or a secret assignment went out with no finding. Such a
  request is now blocked by default, at every level but `off`. Set `input.secrets.action` to `flag`
  to record secrets without blocking.
- The PII action `remove` deletes the matched data. It was accepted but behaved like `flag`, so the
  data stayed in the request.
- The semantic injection check no longer re-embeds its example attacks on every request.
- `McpServer` answers an unknown method with the JSON-RPC method-not-found code, and an unknown
  resource with invalid-params, instead of an internal error, so a client can tell an unsupported
  feature from a failure.
- `McpClient` requests made together before the handshake finished each sent `initialize`; they now
  share one handshake.
- `summarizeVerifyFormat()`'s verify step sent the summary to the model with no instruction, so the
  model answered the summary instead of restating it, and that reply was what got checked against
  the sources. It now asks for a restatement against the sources. The final format is applied only in
  the last step, and a verify step that was skipped is no longer recorded in `steps`.
- `traceModelClient()` records the model and provider that answered on the run itself. It recorded
  the model the request asked for — often `auto` — and left `provider` empty, so a `provider` query
  never matched a model run and per-model views showed `auto`. `FinishRunOptions` gains `model` and
  `provider` for the same purpose in your own instrumentation.

### Deprecated

- `InjectionDetectionConfig.sensitivity` and `ToolPolicyConfig.requiresApproval` have never been
  read. Both will be removed in 2.0; approval before a tool runs belongs to the agent loop.

### Changed

- Nineteen guides under `docs/` — agents, batch, caching, core, graphs, grounding, MCP, memory,
  Postgres, prompts, providers, resilience, security, server, telephony, testing, tracing, voice, and
  workflows — now explain each export they list in their text, not only in the generated reference.
  The security configuration's nested settings have doc comments.
- The documentation coverage check also covers the studio package's exports.

## [1.18.0] - 2026-09-25

A server you can host. Assistants get an HTTP surface — threads, background runs, resumable event
streams, and cron jobs — on top of the durability that already existed: a run is an operation, so it
outlives the request that started it and the worker that was running it.

### Added

- **The agent server** (`nexus-ai-pro/server`, experimental). `createAgentServer()` serves assistants,
  threads, runs, and cron jobs as one `Request`-to-`Response` handler. `toNodeListener()` runs it on
  Node's `http`, and as Express or Fastify middleware.
- **Assistants are structural.** `graphAssistant()` serves a compiled graph, mapping threads to graph
  threads; `functionAssistant()` serves a plain function. The entry point imports neither runtime.
- **Runs are durable operations**, so leases, heartbeats, retries, idempotency, dead-lettering, and
  webhooks come from the operations family. A run abandoned by a crashed worker is re-claimed by
  another replica through `start()` or `runs.recover()`.
- **Resumable streaming.** `GET /runs/:id/events` is a server-sent event stream whose events carry
  their log id, so a client reconnects with `Last-Event-ID` and gets exactly what it missed.
  `MemoryRunEventLog` covers one replica; `RedisRunEventLog` lets a client reconnect to any replica.
- **A busy thread is configurable**: `reject`, `enqueue`, `interrupt`, or `rollback`, per server or
  per run.
- **Cron jobs.** `CronScheduler` fires `{ everyMs }` or five-field cron schedules, parsed by
  `parseCron()`. Every replica ticks and every firing carries the idempotency key `<job>:<slot>`, so a
  job runs once however many replicas are up, with no lock and no leader election.
- **Authentication and tenancy hooks.** `authenticate` returns a `Principal`; threads, runs, and cron
  jobs record their tenant, and another tenant's resource is a `404`.
- **`createRemoteGraph()`** (`nexus-ai-pro/server/remote`), the client: `invoke()`, `stream()` with
  reconnection, `resume()`, and `asNode()`, which makes a deployed assistant a node in a local graph.
- **Deployment templates**: `deploy/Dockerfile`, `deploy/compose.yaml` for two replicas behind Redis,
  and an nginx configuration that does not buffer event streams. `examples/agent-server.ts` is a
  runnable server.

### Changed

- **Every feature's exports are documented in that feature's guide.** A guide can now claim exports by
  source directory, so features reachable only from the root — guardrails, grounding, workflows,
  metrics, conformance, routing — no longer pile into the client guide, which drops from 249 exports
  to 141. Retrieval, citations, and verification get a guide of their own, and the agents, batch,
  caching, and client guides now explain every export they cover.

### Fixed

- An operation whose record was settled by another worker — after its lease lapsed and the work was
  taken over — crashed the original worker with an unhandled `OperationTransitionError` from its
  heartbeat. The heartbeat now stops and fails its local run instead, and a heartbeat that throws for
  any other reason no longer becomes an unhandled rejection.

## [1.17.0] - 2026-09-23

Prompt versioning, and documentation you can navigate. Prompts are defined with typed variables,
versioned by their content, promoted between labels only after their gates agree, and served through
registry outages; every feature now has its own guide, and the README is an overview that links to them.

### Added

- **Prompt templates** (`nexus-ai-pro/prompts`). `definePrompt()` types a prompt's variables from its
  template text, so a missing or misspelled variable is a compile-time error. Templates support dot
  paths, partials, placeholders for whole messages, defaults, and a request configuration versioned
  with the prompt. `promptVersion()` derives a version from the content, identical in every runtime.
- **A prompt registry** (`nexus-ai-pro/prompts/registry`). `PromptRegistry` commits versions, points
  labels such as `staging` and `production` at them, and records every change. `promote()` runs the
  gates registered for the destination label: `experimentGate()` requires a passing experiment for
  the exact version, with thresholds and an optional no-regression check, and `servedByGate()` requires
  a version to be served by another label first. `rollback()`, `split()` for sticky A/B tests, and
  `diff()` with `formatPromptDiff()` complete it. Label writes are compare-and-set, and changes can be
  posted to signed webhooks, verified with `verifyPromptWebhook()`.
- **`evaluatePrompt()`**, the headless playground: runs a prompt version over a dataset and stores an
  experiment tagged with that version, which is what `experimentGate()` looks for.
- **A serving client** (`nexus-ai-pro/prompts/client`). `PromptClient` caches labels with a TTL and a
  stale-while-revalidate window, shares concurrent refreshes, keeps serving the last version seen when
  the registry is unreachable, falls back to prompts bundled in code on a cold start, and picks a
  sticky A/B arm per key.
- **Prompt stores**: `MemoryPromptStore`, `FilePromptStore` (`/prompts/file`), `RedisPromptStore`
  (`/prompts/redis`), and `PostgresPromptStore` (`/postgres/prompts`), all tested against one
  contract. `postgresMigration()` and `nexus db sql` include the prompt tables.
- A model call traced with `traceModelClient()` records the prompt name, version, label, and arm it
  was rendered from.
- **A guide for every feature**, under `docs/`. Each guide covers every export of its entry points and
  ends with a reference generated from the doc comments. `npm run docs:guides` fails when an export
  is not named in a guide or a reference is stale, and runs in `npm test`; `npm run docs:update`
  regenerates the references.
- `BinaryBuffer`: Node's `Buffer` when Node's types are loaded, otherwise `Uint8Array`.

### Changed

- The README is an overview that links to the guides; the moved sections live in `docs/`, and the
  size table is in `docs/packaging.md`.
- The combined Postgres migration creates three more tables, for prompts.

### Fixed

- The message types referred to Node's `Buffer` and `NodeJS.ReadableStream`, so a project without
  Node's type definitions, such as a browser app, failed to type-check anything that reached them.
  They now compile either way, and are unchanged for Node projects.

## [1.16.0] - 2026-09-22

Shared state and the command line. Everything that has to outlive a process or be shared between
workers now has a Postgres adapter, circuit decisions are shared across a fleet, the evaluation
platform has a CI gate, and suites that needed credentials can run from recorded provider traffic.

### Added

- **A Postgres adapter family** (`nexus-ai-pro/postgres`, with one subpath per adapter):
  `PostgresOperationStore`, `PostgresStore` (long-term memory, ranked by pgvector when
  `vectorDimensions` is set), `PostgresTraceStore`, `PostgresDatasetStore`, `PostgresExperimentStore`,
  and `PostgresCircuitStateStore`.
  - Each takes any client with `query(text, values)` — `pg`, `@neondatabase/serverless`, PGlite — and
    `fromPostgresJs()` adapts `postgres.js`. No driver becomes a dependency.
  - Nothing creates a schema at import: `migrate()`, `postgresMigration()`, and `nexus db sql` apply
    or print it.
  - Idempotency keys are unique in the operations table, so two workers racing to submit one key run
    the work once. Graph threads persist across workers through `OperationStoreCheckpointer`.
- **Shared circuit state.** `circuitBreaker.store` takes a `CircuitStateStore`: memory and Redis
  adapters in `nexus-ai-pro/ops/circuit-store`, Postgres in `/postgres/circuits`. A provider that
  fails in one worker is taken out of routing in all of them, and one worker at a time probes it when
  the cooldown ends. Checks stay synchronous; the coordination code loads only when a store is
  configured. `ai.syncCircuitBreaker()` loads shared state at startup.
- **Evaluation from the command line.** `nexus eval run`, `nexus eval compare`, and `nexus eval gate`
  run an evaluation module to an experiment file and fail a build only on a regression beyond noise,
  a new failure, or a dataset mismatch. `nexus traces list`, `show`, and `export` read a JSONL file or
  any trace store a module exports. `nexus db sql` prints the Postgres schema. Every command takes
  `--json`, and a usage error exits with 2.
- **Record and replay** (`nexus-ai-pro/testing/record`). `recordingFetch()` writes provider traffic
  to reviewable fixture files with credentials removed; `replayFetch()` serves it back with no network
  and throws `FixtureMissingError` for anything unrecorded; `fixtureFetch()` picks the mode from
  `NEXUS_FIXTURES`; `installFetch()` covers code that calls the global `fetch`. Multipart boundaries
  and key order do not break matching.
- **Image conformance from recordings.** `npm run conformance:images:record` records the image suite
  against every backend with credentials present; `npm run test:conformance:images` replays it in CI
  and reports any backend without recordings rather than counting it as a pass.
- **Graph input and output channels.** `createGraph({ channels, input, output })` restricts what a
  caller may pass in and what comes back, in the types and at run time. As a subgraph, a graph
  receives only its inputs and merges back only its outputs.
- **Per-node caching.** `addNode(name, fn, { cache: { key, ttlMs, store } })` reuses a node's result
  for the same state and input, in a bounded in-process map or any cache adapter
  (`compile({ cache })` sets a default). Failures, interrupts, human answers, and parent commands are
  never cached; a failing cache is a miss.
- **Evaluation additions.** `underCost()` per-example cost gate; `FileExperimentStore` and
  `readExperiment()`; `repetitions` may be a function per example; the target receives the abort
  signal.
- `EvalRunner.run()` and `MediaEvalRunner.evaluate()` return the experiment underneath their report,
  and accept options to name and store it.
- `OperationDuplicateError`, raised by stores that enforce unique idempotency keys.
- **Documentation coverage.** Every public export, and every public member of an exported class,
  interface, or enum, now has a doc comment: 4,651 declarations across 88 entry points.
  `npm run docs:check` enforces it and runs as part of `npm test`.

### Changed

- `EvalRunner` and `MediaEvalRunner` now run on `evaluate()`. Their results and errors are unchanged;
  `evaluate()` is loaded the first time they run, so neither entry point grew.
- A caller cancelling a request no longer counts against a provider's circuit.
- Circuit probe limits are enforced on every attempt through the failover executor, so concurrent
  requests go to a fallback instead of all probing a half-open provider.
- Comments are stripped from the emitted JavaScript and kept in the type declarations, where editors
  read them. Every entry point shrinks as a result: the root import is 572 KB, down from 612 KB, even
  after the breaker fixes, the `EvalRunner` rebuild, and duplicate-key handling. The published size
  table has the per-entry-point figures.
- The packed tarball is 666 KB and 4.1 MB unpacked, up from 3.5 MB, almost all of it the doc comments
  in the type declarations, which are shipped for both ESM and CommonJS.

### Fixed

- `evaluate()` ignored its `signal` option; aborting now stops new examples, reaches targets, and
  never stores a partial experiment.
- `evaluate()` never recorded cost, so `totalCost()` always reported 0. Cost is now read from
  completion and image results or from a `cost` option.
- A half-open probe slot was never released when an attempt's error did not count as a failure,
  leaving the circuit refusing traffic until it was reset.
- The breaker's documented `halfOpenMaxCalls` was not enforced on real requests: the client routed
  every request to a half-open provider.
- The context-window summary call could route to a provider whose circuit was open.
- `routing.fallback` was accepted but never applied. `onError` models are now tried after every
  route the router chose, `onTimeout` gives the first attempt its own timeout before its fallback,
  and `onRateLimit` retries a rate-limited first attempt before falling back.
- Privacy routing ignored a provider's own `isLocal` declaration, so an OpenAI-compatible server
  configured as local was still scored as hosted.

### Deprecated

These options were accepted but never read. They still type-check, do nothing, and will be removed
in 2.0.

- `GoogleProviderConfig.projectId`.
- `OllamaProviderConfig.timeout`.
- `MetricsConfig.prometheus`: Prometheus text is always available from `getPrometheusMetrics()`.
- `DensificationConfig.preserveMarkdown`: densification never rewrites Markdown structure.
- `HealthConfig.latencyHalfLife`: latency is averaged with a fixed weight.

## [1.15.0] - 2026-09-21

Evaluation. One entry point for evaluating anything, datasets versioned by their content, experiments
that can be compared with a verdict rather than a vibe, and the loop from a production failure back to
a permanent regression test.

### Added

- **`nexus-ai-pro/evaluate`.** `evaluate(target, dataset, evaluators, options)` accepts any target: a
  completion, an agent, a graph, an image operation, or plain code.
  - Examples run concurrently, with repetitions for a target that is not deterministic, a timeout per
    example, and per-metric statistics including a 95% interval.
  - A target that throws is recorded as a failed example; an evaluator that throws is recorded as a
    failed measurement. Neither voids the experiment.
- **Datasets versioned by content.** Change an example and the version changes with it, so two
  experiments are comparable only when they ran over the same data. `MemoryDatasetStore` and
  `FileDatasetStore` (one reviewable JSON file per version), plus `splitOf()` for train and test
  splits.
- **`datasetFromTraces()`.** Turns recorded runs into examples, each keeping the run it came from, so
  yesterday's production failure becomes tomorrow's regression test.
- **Bundled evaluators.** `exactMatch`, `contains`, `mustNotMatch`, `completed`, `underLatency`,
  `embeddingSimilarity` through any injected embedder, `pairwise` for side-by-side judgements, and
  `trajectory`, which scores how an answer was reached rather than only what it said. `passRate` and
  `totalCost` summarize a whole experiment.
- **`compareExperiments()` with a real verdict.** A paired bootstrap over per-example differences
  gives each metric a 95% interval; a metric whose interval spans zero is `unchanged` rather than an
  improvement. The bootstrap is seeded, so a CI gate cannot flip between runs. The report names the
  examples that moved most, the failures that are new, the ones that were fixed, and any dataset
  version mismatch. `formatComparison()` prints it for a pull request.
- **`evaluateOnline()`.** Scores sampled production runs, writes the scores back as trace feedback so
  alert rules can watch them, and sends uncertain results to people.
- **`AnnotationQueue`.** Review work with a rubric, claims that expire so nothing is stranded,
  consensus across several reviewers, and `toExamples()` to turn reviewed items into dataset examples.

## [1.14.0] - 2026-09-20

The memory, agent, and MCP work planned for 1.13.0 ships here together with tracing, so no 1.13.0 was
published.

Memory, agents, MCP, and traces. An agent is now a graph rather than a loop, so it inherits
approvals, parallel tool calls, and durability. A store gives it memory that outlives a thread, MCP
connects it to tools this package does not have to ship, and every run can be recorded as a tree you
can search, compare, and alert on.

### Added

- **`nexus-ai-pro/agent` and `createAgent()`.** Returns a compiled graph, so an agent gets
  checkpoints, resume, forks, events, and a diagram from the graph runtime rather than from code
  written twice.
  - Tool calls run as parallel tasks, bounded by `toolConcurrency`.
  - `interruptOn` makes a tool wait for a human. The approval is a checkpoint, so it can arrive days
    later from another process, and it can approve, refuse with a reason the model sees, or approve
    with corrected arguments.
  - Middleware wraps the model call (`beforeModel`, `afterModel`) and each tool call
    (`wrapToolCall`).
  - `stopReason` distinguishes a finished answer from one that ran out of iterations, and malformed
    tool arguments never reach a tool.
  - `AgentLoop` is unchanged, for the case that wants none of this.
- **`nexus-ai-pro/store`, long-term memory.** Namespaced tuples, `put`/`get`/`delete`/`search`/
  `listNamespaces`, TTLs, and field filters.
  - Semantic search ranks by any embedding function you inject, so the store never imports the
    embeddings runtime; without an index, a query matches text.
  - `MemoryStore` is bounded, like the graph's memory checkpointer. `RedisStore`
    (`nexus-ai-pro/store/redis`) shares memory across processes through a client-like interface.
  - `compile({ store })` hands it to every node as `context.store`.
- **`nexus-ai-pro/tracing`, run trees you can query.** Metrics say how it is going; a trace says what
  happened.
  - Every family has a run kind: model, tool, graph, node, agent, retriever, embedding, image, voice,
    realtime, operation. A run carries inputs, outputs, timing, tokens, cost, tags, and errors.
  - `traceGraph()` turns the graph's own event stream into a run tree, so nothing inside the graph
    knows about tracing and an untraced run pays nothing. `traceModelClient()` nests each model call
    inside the node that made it, with its tokens and cost.
  - Tail sampling keeps every error, slow run, and expensive run whatever the head rate is, because
    the decision is made when a trace finishes.
  - Redaction runs before storage: hidden fields are never written, and a `redact` hook gets the last
    word.
  - `MemoryTraceStore` is bounded; `JsonlTraceStore` appends to a file that survives a restart and can
    be read back, pruned, and rotated.
  - Queries filter by kind, status, name, model, tags, metadata, latency, cost, time, and feedback.
    `tree()` assembles a trace, `formatTree()` prints it, and `compareTraces()` reports what changed
    between two runs of the same shape.
  - `recordFeedback()` attaches scores from people or from evaluators.
  - `AlertEvaluator` runs rules over stored runs — error rate, latency percentiles, cost, count — and
    every alert carries the runs that tripped it. `createWebhookNotifier()` posts them.
- **Bundled agent middleware.** `summarizeHistory` keeps a long transcript from growing without
  bound, `redactMessages` keeps secrets out of provider requests and responses, and `limitToolCalls`
  caps how often a tool may run.
- **`agentAsTool()`.** Gives one agent to another as a tool, so a supervisor can delegate while
  keeping control. Each agent keeps its own memory, approvals, and thread.

- **`nexus-ai-pro/mcp`, both directions of the Model Context Protocol.** Implemented directly, with
  no protocol SDK dependency.
  - `McpClient` lists and calls tools, reads resources and prompts, and `toNexusTools()` turns a
    server's tools into tools an agent can call, with optional name prefixes.
  - `McpServer` exposes this application's tools and resources to other assistants.
  - Stdio and HTTP transports are included, and the transport is an interface, so a client and a
    server can be wired together in memory for a test.

## [1.12.0] - 2026-09-20

Graph control and introspection. A node can route itself, a run can pause at breakpoints and be
edited or forked, every task and custom event can be watched as it happens, and a graph can draw
itself.

### Added

- **`Command`.** A node returns `new Command({ update, goto })` to write state and choose its
  successors in one step, instead of splitting the decision into a separate router. `goto` takes node
  names or `Send`s. A route chosen by a task that finished before its step paused is kept on the
  checkpoint, so it is still followed when the step resumes.
- **`Command.PARENT`.** A node inside a subgraph hands control back to the graph that contains it. The
  subgraph's own writes and the update it addressed to the parent are reduced separately, in order,
  so neither overwrites the other.
- **Breakpoints.** `interruptBefore` and `interruptAfter`, per compile or per run, pause a run at
  chosen nodes with status `interrupted` and a `breakpoint` describing where. `continue()` carries on,
  and does not pause again at the breakpoint it resumes from.
- **Deferred nodes.** `addNode(name, fn, { defer: true })` holds a node until every other pending task
  has finished, so an aggregator after branches of different lengths runs once.
- **`updateState()`.** Merges a correction into a thread's latest checkpoint in place, keeping any
  pending question; with `asNode`, applies it as that node's output and continues along its edges.
- **`fork()`.** Copies a thread's history up to a step into a new thread, leaving the original
  untouched and runnable, and records `metadata.forkedFrom`.
- **`onEvent` and `context.emit()`.** A run can observe each task starting, retrying, and finishing
  with its update, every checkpoint written, and custom events a node emits, such as model tokens. A
  listener that throws never fails the run.
- **`describe()` and `nexus-ai-pro/graph/visualize`.** `describe()` returns a graph's nodes, edges, and
  run-time routes as plain JSON, including subgraphs. `toMermaid()` draws it, with optional
  highlighting of where a thread is; `toGraphJSON()` returns the data. The visualizer imports no
  runtime code.

### Fixed

- **Parallel copies of a subgraph node no longer share a thread.** `asNode()` keyed the subgraph's
  thread by node name, so two `Send` copies of one subgraph node in the same step wrote to the same
  thread. It is now keyed by task; a plain node's task id is its name, so existing threads are
  unaffected.

## [1.11.0] - 2026-09-18

Parallel graphs. A fan-out that looks parallel now runs in parallel, a graph can fan out over data it
discovers at run time, and a node can retry or time out on its own.

### Added

- **Concurrent supersteps.** Every task in a superstep starts together: four branches of 300 ms
  finish in about 310 ms, where they used to take 1,253 ms. `npm run bench:graph` measures it and
  fails if the gain disappears.
  - `maxConcurrency` bounds how many run at once. It defaults to 16, is settable per compile and per
    run, and `1` restores strictly sequential execution.
  - Writes are reduced in task order, never completion order, so timing cannot change the state a
    replay produces.
  - A superstep with a single task skips the scheduler, so a linear graph pays nothing for this.
- **`Send`, for fan-out over run-time data.** A router can return `new Send(node, input)` values,
  creating one task per value, each reading its own `context.input`. Fifty-seven URLs become
  fifty-seven tasks of one node in one superstep.
  - Each copy is checkpointed separately, so a resume re-runs only the copies that did not finish.
  - Task ids come from the step and the order produced, so a replay rebuilds the same tasks.
  - `addNode(name, fn, { ends })` declares `Send` targets, keeping reachability checks exact.
- **Per-node retries and timeouts.** `addNode(name, fn, { retry, timeoutMs })`, with
  `compile({ retry })` as the default for every node.
  - Retrying is off unless asked for, because only the application knows whether a node is
    idempotent. Interrupts, aborts, and validation errors are never retried.
  - `context.attempt` tells a node which try it is on, and step events report the attempts a task
    needed.
  - A timeout aborts the node's signal and fails that attempt with `GraphNodeTimeoutError`, even if
    the node ignores its signal.
- **`onNodeError`.** When a task fails, its siblings are aborted (`fail-fast`, the default) or left to
  finish (`settle`). Either way, what they already wrote is kept.
- **Several questions at once.** Parallel tasks can each interrupt. Paused checkpoints and results
  carry `interrupts`, and `resumeInterrupts()` answers any subset by id. A single question still works
  exactly as before through `resume()`.
- **Install weight is now measured honestly.** The size table only ever counted this package's own
  files, so a small entry point could quietly force a large dependency on the consumer.
  - `npm run size:check` follows bare imports too, and the README table gains a column for what each
    entry point makes you install. Most entry points force nothing: `/graph`, `/operations`,
    `/batch`, `/embeddings`, and every image subpath import no third-party package at all. The root
    import, `/core`, `/config`, and `/security` pull in 3.4 to 4.7 MB, because JSON-schema and Zod
    validation live there.
  - The clean-install test now measures and bounds the whole production install: 10.0 MB of
    `node_modules`, of which 3.0 MB is this package.

### Fixed

- **A retry no longer lets the process exit while it waits.** The backoff timer was unref'd, so a run
  waiting to retry could be abandoned by an otherwise idle process.

## [1.10.0] - 2026-09-16

Image portability. Three image backends now sit behind one contract: OpenAI, Google Imagen, and a
self-hosted ComfyUI server. Masked edits work on all three, and every input is validated before any
provider sees it. Visual moderation inspects both the request and the generated images. Image output
can be evaluated for alignment, rendered text, preservation, and safety. Each piece is its own subpath,
and none is loaded by the root import.

### Added

- **Google Imagen adapter** (`nexus-ai-pro/images/google`). It calls the `:predict` protocol on the
  Gemini API with an API key, or on Vertex AI with a bearer token, for generation and masked
  inpainting.
  - It differs from OpenAI, and negotiation says so. Output is sized by aspect ratio, so `dimensions`
    is refused. `seed` and `negativePrompt` are supported.
  - A seed disables the watermark, and the result reports that as a warning.
  - When Imagen filters some images in a batch, the images that passed are still returned.
- **ComfyUI adapter** (`nexus-ai-pro/images/comfyui`) for a self-hosted server.
  - It uploads inputs, queues a workflow, polls with backoff, and downloads saved outputs.
  - It records the seed it used, even when the caller chose none, so a good run can be reproduced.
  - It removes an abandoned or failed prompt from the queue and interrupts it, so the GPU is not left
    working on a result nobody is waiting for.
  - The workflow graph belongs to the application. Stock text-to-image and inpainting builders are
    included.
- **Mask conversion** (`nexus-ai-pro/images/transform`). You draw a mask once, with either polarity, and
  it becomes OpenAI's alpha channel or the white-is-editable greyscale that Imagen and ComfyUI read.
  - A size mismatch is refused unless `resizeMode` allows `stretch`, `contain`, or `cover`. Resampling
    is nearest-neighbour, so a binary mask gains no grey fringe, and `contain` padding is never
    editable.
  - Partly transparent pixels count as non-editable, so a soft brush edge never widens an edit.
  - The PNG codec loads on the first masked request. An application that never masks never pays for
    it.
  - `AssetTransformer` is an injection seam for applications that want JPEG or WebP masks.
- **Validated inputs** (`nexus-ai-pro/images/inputs`). `ImageInputResolver` applies the same checks to
  byte uploads, remote URLs, and stored assets, and plugs into `ImageConfig.inputResolver`.
  - The type is decided by the bytes. A declared or served MIME type that disagrees is refused rather
    than corrected.
  - Byte and pixel limits are enforced. The pixel limit is read from the header before decoding, so a
    small file claiming a huge canvas is refused without allocating anything.
  - Remote fetches get the web connector's SSRF protection: pinned DNS, redirect revalidation, and
    blocking of private networks and cloud metadata.
  - Refusals are `ImageInputError`s with a machine-readable `reason`.
- **Visual moderation** (`nexus-ai-pro/images/moderation`). `createOpenAIVisualModeration` screens the
  prompt, input and reference images, and every generated image, because an innocuous prompt can
  still produce an unsafe image.
  - Block and review thresholds can be set per category.
  - If the moderation call fails, the request is blocked unless `failOpen` is set.
  - A stored output that cannot be sent for moderation is routed to review.
  - `combineSafetyPolicies` runs several policies and keeps every finding.
- **Media evaluation** (`nexus-ai-pro/images/evals`). `MediaEvalRunner` checks four things:
  - prompt alignment, using an injected judge;
  - rendered text, using OCR and edit distance;
  - edit preservation, using a perceptual hash that survives re-encoding;
  - blocking behaviour, reported as false-positive and false-negative rates.

  Every case runs repeatedly and reports mean, spread, and a 95% interval, plus latency, cost, error,
  and failover figures. Scores inside a configured uncertainty band go to a `ReviewQueue` instead of
  being decided automatically.
- **A masked-edit conformance case.** It runs for every provider that declares `supportsMask`. The
  fixture is a literal PNG, so the testing entry point does not load the codec.

### Changed

- **OpenAI masked edits and transparency are enabled.** `OpenAIImageProvider` now declares
  `supportsMask` and `supportsTransparency`. `background: 'transparent'` is refused only with JPEG
  output.
- **A provider can explain missing images.** A blocking output finding marked `metadata.withheld`
  counts toward the requested image count, and it does not block the images that were returned. Any
  other blocking finding still blocks the whole result.
- **SSRF protection is shared.** It moved out of the web connector into one module that the connector
  and image inputs both use. The web connector behaves the same, and its security tests pass
  unchanged. Policy refusals are now a `UrlPolicyError`, with the same messages.
- **Graphs checkpoint by default, as the documentation always said.** `compile()` now uses an
  in-process `MemoryGraphCheckpointer` when none is given, so `interrupt()`, `state()`, and
  `history()` work without setup. The default keeps at most 1,000 threads, dropping the least recently
  written one, so a service that never resumes cannot grow without limit. `maxThreads` is configurable,
  and `checkpointer: false` turns checkpointing off. Before this fix, `compile()` created no
  checkpointer and `interrupt()` threw.
- **The whole-package size limit is higher.** The new modules are about 200 KB unpacked across both
  builds, so the tarball limit rose from 460 KB to 500 KB packed and from 2.85 MB to 3.1 MB unpacked.
  No existing import got heavier because of them. Each new module has its own per-subpath budget, and
  the root import loads none of them.

### Fixed

- **A failed graph step no longer re-runs the siblings that finished.** The failed checkpoint used to
  discard their writes, so `continue()` ran them again and repeated their side effects. It now keeps
  those writes, and `continue()` retries only the nodes that did not finish.
- **Finished siblings still route onward after a paused or failed step resumes.** The checkpoint
  carried only the unfinished nodes, so the outgoing edges of siblings that had already finished were
  lost. A new optional `completed` field on the checkpoint records those siblings.
- **A subgraph that asks a question now pauses its parent.** `asNode()` used to treat an interrupted
  subgraph as finished: the parent merged its partial state and carried on. The parent now interrupts
  with the same question, and resuming the parent passes the answer into the subgraph, which continues
  where it stopped. A subgraph that asks several questions works across several resumes.
- **Rewinding no longer leaves checkpoints from the abandoned timeline.** After `resumeFrom(step)`,
  both checkpointers kept the later steps, so `state()` could return a step that no longer existed.
  Writing a step now drops any stored steps at or after it.
- **`context.report()` works.** It did nothing. Progress now reaches the new
  `GraphRunOptions.onProgress` callback, and a callback that throws does not fail the node.
- **`CompileOptions.name` is used.** It was documented but never read. It is now recorded on every
  checkpoint as `metadata.graph`.
- **An unnamed graph run now reports its thread id.** `invoke()` without a `threadId` returned
  `threadId: ''` even though it had generated one, so the run could not be inspected or resumed.
- **`AgentLoop` no longer runs a tool with arguments the model did not send.** Malformed tool-call
  JSON, or arguments that are not an object, used to become `{}` and the tool ran anyway. The tool is
  now skipped, and the parse error goes back to the model as the tool result.
- **`AgentLoop` says why it stopped.** `AgentResult.stopReason` is `completed` or `max_iterations`, so
  a caller can tell a final answer from a run that hit the iteration limit.

## [1.9.0] - 2026-09-15

Install weight, made measurable and enforced. Every export subpath now has a size budget that
CI holds it to, the README publishes what each import costs, and enforcing a cost budget no
longer loads the model catalogue. No public API changed.

### Added

- **A per-subpath size budget, enforced in CI.** `npm run size:check` measures the transitive import
  graph of every one of the 70 export subpaths and fails when an entry point grows past its recorded
  budget. The package already budgeted the whole tarball, which is exactly why per-entry growth went
  unnoticed across three releases while the total budget was raised three times: a shared module
  pulled into an otherwise small entry point does not move the tarball at all, it only moves what a
  consumer pays to import one piece. `npm run size:update` rewrites the budgets and regenerates the
  README table.
- **A published size table.** The README now carries what each import actually costs, generated from
  the build rather than written by hand, and the check fails if it goes stale. The claim is now
  verifiable before installing.

### Changed

- **Enforcing a cost budget no longer loads the model catalogue.** `assertWithinCostBudget`,
  `CostBudgetError`, `formatCost`, and `DEFAULT_CURRENCY` moved to `optimizer/cost-budget.ts`, which
  has no registry dependency; `optimizer/cost.ts` re-exports all four, so no import changes and the
  error classes stay identical rather than becoming copies. Comparing two numbers had been dragging
  30 KB of chat-model data along with it.
- **`nexus-ai-pro/embeddings` is 29% smaller**, 129 KB down to 91 KB, and no longer reaches
  `types/providers.js` at all. A test pins that, not just the budget.

## [1.8.0] - 2026-09-14

Graphs. Nodes, edges, cycles, fan-out and subgraphs over typed state, with every superstep
checkpointed so a run is resumable, inspectable and interruptible by construction rather than
after opting in, on a subpath that costs 5% of the root import.

### Added

- **Typed state graphs.** `nexus-ai-pro/graph` adds nodes, edges, conditional edges, cycles, fan-out,
  and subgraphs over typed state channels: explicit nodes and edges, persistent graph state,
  checkpoint and resume, human-in-the-loop interrupts, and complex branching.
- **Durable by construction.** Every superstep is checkpointed, so a run is resumable without opting
  into a checkpointer first. `MemoryGraphCheckpointer` covers a single process;
  `OperationStoreCheckpointer` persists through the `OperationStore` that already backs durable
  operations, which makes a Redis-backed thread a one-line change and lets a different worker resume
  what another suspended. The store is imported as a type only, so the graph subpath stays small.
- **Human in the loop.** A node calls `context.interrupt()`; the graph checkpoints and reports
  `awaiting_input`, and `resume()` supplies the value. On replay the same call returns that value
  instead of throwing, keyed by node, step, and position, so one node can ask several questions
  across several resumes. A sibling branch that already completed is not re-run.
- **Channels with reducers** — `lastValue`, `appendList`, `appendSet`, `mergeObject`, `counter`, and
  `reducerChannel` — so two branches writing the same slot in one superstep combine rather than
  clobber.
- **Time travel.** `state()`, `history()`, and `resumeFrom(step)` read and rewind a thread.
- **Compile-time validation.** An edge to an unknown node, a node nothing routes to, a duplicate node
  name, and a reserved name are all refused at `compile()` rather than at run time.
- New subpath `nexus-ai-pro/graph`. It is deliberately absent from the root import, so a user who
  does not build graphs pays nothing for it.

## [1.7.0] - 2026-09-08

Batch economics, distributed limits, and durable assets: the rest of the theme *work that
outlives a process*. The half-price asynchronous tier is reachable, one rate-limit budget covers
every worker, a failing provider leaves routing until it recovers, generated media persists
outside the process, and every operation family reports into the same metrics and audit log.

### Added

- **Circuit breaking.** `CircuitBreaker` consumes the same attempt signals as `ProviderHealthMonitor`
  and trips routing away from a failing provider entirely, rather than merely ranking it lower. Two
  independent triggers: consecutive failures, and a failure rate over a rolling window that catches a
  provider failing half its calls without ever failing several in a row. After a cooldown the circuit
  admits a limited number of probes; a success closes it, a failure reopens it and restarts the
  cooldown. Exposed through `circuitBreaker` config, `ai.getCircuitBreakerStatus()`,
  `ai.resetCircuitBreaker()`, and the `nexus-ai-pro/ops/circuit-breaker` subpath.
- **Distributed rate limiting.** A `RateLimitStore` contract with `MemoryRateLimitStore` and
  `RedisRateLimitStore`, set through `rateLimit.store`, so one budget covers every worker instead of
  each process getting the full limit. The Redis store does the increment and the expiry in one
  atomic Lua call when the client exposes `eval`, and re-arms a missing TTL on the fallback path so a
  crash between `INCR` and `PEXPIRE` cannot block a key forever. Completions and embeddings share the
  limiter, so they share the budget.
- `NexusRateLimitError` now carries `resetAt` and a `retryAfterSeconds` accessor, so a gateway can
  answer with a real `Retry-After` header.
- New subpaths `nexus-ai-pro/ops/circuit-breaker` and `nexus-ai-pro/ops/rate-limit-adapters`.
- **Provider batch tiers.** `BatchManager` puts OpenAI Batch and Anthropic Message Batches behind one
  operation handle, reaching the roughly half-price asynchronous tier that local `runBatch()`
  concurrency cannot. Results are matched by a required `customId` rather than by position, since a
  batch provider does not guarantee output order; a duplicate id is refused before submission.
  Polling backs off up to a configurable ceiling, an idempotency key replays instead of submitting
  twice, and `resume()` collects a batch from its `BatchJobRef` alone so a restarted worker can
  finish what another submitted. Ships with a deterministic `MockBatchProvider`.
- **Filesystem and S3 asset stores.** `FilesystemAssetStore` and `S3AssetStore` implement the
  existing `AssetStore` contract, with tenant isolation, retention, SHA-256 checksums, and signing.
  A missing asset and one owned by another tenant are indistinguishable, because a distinguishable
  error leaks the existence of another tenant asset. Both write bytes and a JSON sidecar per asset
  rather than a shared index, so concurrent writers do not contend and a torn write loses at most
  one record. `S3LikeClient` is structural, so S3, R2, and MinIO all work without an SDK dependency.
- **Generated model registry.** `data/models/*.json` is now the versioned source of truth, and
  `scripts/generate-model-registry.mjs` emits `src/models/generated.ts` from it. The generator
  validates required fields, price signs, context bounds, status values, and dangling aliases;
  `npm run registry:check` runs inside `npm run check` so committed data and output cannot drift.
  The runtime still reads `KNOWN_MODELS`, and a test asserts the two match exactly. The generated
  module and its data are build-time artifacts and are not published: they duplicate `KNOWN_MODELS`
  exactly, so shipping them would add roughly 310KB to every install for data nothing reads.
- New subpaths `nexus-ai-pro/batch`, `batch/openai`, `batch/anthropic`, `batch/mock`, and
  `nexus-ai-pro/images/stores`.
- **Cross-family observability.** Image, voice, and telephony operations now report into the same
  metrics collector, audit log, and rate limiter as completions and embeddings, closing the gap where
  an application running phone agents and image generation had observability for only part of its
  spend. Metrics carry `family` and `operation` labels, and one rate-limit budget now covers every
  family. `FamilyTelemetry` is exported for a family an application adds itself.

### Changed

- `RateLimiter` gained `checkAsync()` for the store-aware path. `check()` keeps its synchronous
  signature and behavior, and the runtime only awaits when a store is configured, so a request
  without one pays no extra microtask.
- `ImageManager`, `VoiceManager`, and `TelephonyManager` accept an optional second constructor
  argument carrying the shared observability objects. It defaults to empty, so constructing one
  standalone is unchanged and simply records nothing.
- The shared asset contract, errors, and validation moved from `images/assets` to an internal
  `asset-support` module so the filesystem, S3, and memory stores cannot drift on what a valid asset
  is. `images/assets` re-exports all of it, so existing imports are unchanged.
- Documentation consolidated from nine files to seven. `NEXUS.md` and `EXPLANATION.md` were four
  releases stale and largely restated the README; their unique content moved to `CONTRIBUTING.md`
  (real-provider test setup, the public-feature checklist, the manual smoke checklist) and to a new
  README "Known Limitations" section. The published package now carries only `README.md`,
  `API_STABILITY.md`, `CHANGELOG.md`, `SECURITY.md`, and `LICENSE`; `ROADMAP.md` is a design proposal
  and stays on GitHub.
- `SECURITY.md` no longer names a specific supported version line. It claimed `0.9.x` while 1.6.0 was
  the published release, so the wording is now version-independent and cannot go stale again.
- `RouterContext` gained an optional `openCircuits`, and `Router.route()` an optional trailing
  parameter. When every candidate's circuit is open the router routes anyway: that usually means a
  shared dependency is down, and one attempt beats a certain failure with no attempt at all.

## [1.6.0] - 2026-09-03

Durable operations, the first half of the theme *work that outlives a process*. Long-running work now
runs through one lifecycle that survives a worker crash. Everything here is additive.

The rest of the theme — provider batch APIs, distributed rate limiting and circuit breaking,
filesystem and S3 asset stores, a generated model registry, and cross-family observability — moves to
1.7.0. The operation handle they all sit behind ships here, which is what unblocks them.

### Added

- **`OperationRunner` and a shared operation lifecycle.** `queued → running → succeeded | failed`,
  with `retrying`, `cancelling`, `cancelled`, and `expired` covering the rest, exposed through the
  new `nexus-ai-pro/operations` subpath. The runner persists a record before doing any work, claims
  a lease, heartbeats while the executor runs, retries with backoff and jitter, dead-letters what
  never succeeds, and emits signed webhooks.
- **Restart survival through leases rather than locks.** A worker that dies leaves a record whose
  lease lapses; another worker's `recover()` sweep resumes it. Every store write is a compare-and-set
  on the record's `sequence`, so two workers racing on one operation cannot both win, and the loser
  is told it lost instead of silently overwriting.
- **`RedisOperationStore` and `BullMQOperationDispatcher`.** Redis persists records, with the
  compare-and-set done in one Lua call when the client exposes `eval`. BullMQ dispatch queues the
  operation id and its routing metadata only, never a payload.
- **Idempotency keys.** A key matching an existing record replays that operation instead of starting
  a second one, so an ambiguous timeout cannot produce a duplicate charge.
- **Progress and cancellation.** An executor reports progress through `context.report()`, which
  reaches both `handle.events()` and the persisted record. `runner.cancel()` settles an operation
  owned by another worker, observed there through its heartbeat.
- **Signed webhooks, with the verifying half included.** Deliveries are HMAC-SHA256 over
  `${timestamp}.${body}`, so a captured delivery cannot be replayed indefinitely.
  `verifyOperationWebhook()` ships alongside `signOperationWebhook()` rather than leaving every
  receiver to hand-roll a constant-time comparison. A failed delivery is reported and never fails
  the operation it describes.
- **A binary-payload guard.** Persisting a result carrying a `Uint8Array`, `Buffer`, `Blob`, or
  stream throws `OperationSerializationError` naming the exact path and pointing at `AssetStore`.
  Base64 in a job payload inflates it by a third and most queue backends cap job size well below one
  image, so this fails loudly at the boundary instead of appearing later as a truncated job.
- New subpaths `nexus-ai-pro/operations`, `operations/adapters`, and `operations/webhooks`.

### Changed

- The operation lifecycle types moved from `types/images.ts` to a family-neutral `types/operations.ts`
  and are re-exported from their old home, so existing image imports resolve unchanged. The image
  family's private handle was replaced by the shared `LocalOperationHandle`, which is told to reject
  with `ImageOperationCancelledError` so callers catching that error see no difference.
- `OperationStatus` gained `retrying`; `OperationEvent` gained `progress` and `retrying` variants and
  an `attempt` field on `running`. Additive, but code switching exhaustively on either union should
  add the new members.

### Fixed

- A handle driven by the runner stayed in `queued` for the whole run, so no `running` event was
  emitted and every `context.report()` call was silently dropped. Found while testing the runner's
  event sequence; the handle now exposes `markRunning()` and the runner calls it before each attempt.

## [1.5.0] - 2026-08-31

Embeddings become a first-class operation. `ai.embed()` gets the routing, caching, batching, budget,
retry, audit, and metrics that until now only completions had, so embedding spend is visible next to
completion spend instead of leaving the platform entirely. Everything here is additive.

### Added

- **`ai.embed()` and `ai.embedOne()`.** A provider-neutral embeddings operation family behind
  `EmbeddingManager`, reached through `ai.embeddings` or the new `nexus-ai-pro/embeddings` subpath.
  The manager is built on first access, so a runtime that never embeds pays nothing for it.
- **Adapters for OpenAI, Google, Cohere, Mistral, and Ollama**, plus any OpenAI-compatible
  `/embeddings` server through `OpenAIEmbeddingProvider`'s `baseUrl` and `providerName`. They are
  registered automatically from the provider credentials already in `providers`, so a configured
  chat provider makes `ai.embedOne('text')` work with no embedding-specific configuration. Explicit
  registration through `registerEmbeddingProvider()` always wins, and auto-registration can be
  turned off with `embeddings.autoRegisterProviders: false`.
- **Batching, deduplication, and per-input caching.** A batch larger than the model's limit is split
  and run with bounded concurrency, and the vectors still come back in input order. Repeated texts
  within one request are answered by a single provider call, and caching is keyed per input, so a
  partially repeated batch only sends the texts it has not seen. `meta.batches`, `meta.cachedInputs`,
  and `meta.deduplicatedInputs` report what actually happened.
- **Structured usage and numeric cost for embeddings.** `meta.usage` and `meta.cost` reuse the same
  `TokenUsage` and `ResponseCost` shapes as completions, priced from a new embedding model registry.
  When a provider reports no token counts — Google's `batchEmbedContents` does not — tokens are
  estimated locally rather than reported as zero, so a call is never priced at nothing.
- **An embedding model registry** with dimensions, supported truncation sizes, input limits, batch
  limits, and prices for eleven models across five providers, with aliases (`auto`, `embed-fast`,
  `embed-quality`, `embed-multilingual`, `embed-local`) and full override through
  `embeddings.models.registry`. It is deliberately separate from `KNOWN_MODELS`, because completion
  routing scores models on context window, output price, and tool support, none of which an
  embedding model has.
- **Capability refusal.** An unsupported `dimensions`, `inputType`, `encodingFormat`, or `truncate`
  value throws `EmbeddingCapabilityError` before the provider call. Embeddings refuse rather than
  drop: a vector built with different dimensions is silently incompatible with the vectors already
  in a store, and the mismatch only surfaces later as unexplained retrieval quality loss. An option
  the registry says nothing about is still passed through, and `providerOptions` reaches the
  provider body untouched.
- **`toEmbeddingFunction()`**, which adapts the family to the plain `EmbeddingProvider` function that
  `MemoryVectorStore`, the semantic cache, and RAG ingestion already accept. An existing vector store
  gains routing, caching, retry, and metrics without changing its own contract.
- **`normalize`** for unit-length vectors, applied locally when the provider does not already return
  them, and reapplied after a locally truncated vector loses its length.
- **A deterministic `MockEmbeddingProvider`** and `runEmbeddingProviderConformance()`, which checks
  one vector per input, input order, consistent width, optional determinism, and an honored abort.
- New subpaths `nexus-ai-pro/embeddings`, `embeddings/adapters`, `embeddings/mock`, and
  `embeddings/models`.

### Changed

- `RateLimiter.check()` accepts the new structural `RateLimitedRequest` instead of a
  `CompletionRequest`, so one limiter instance and one budget cover every operation family.
  `CompletionRequest` still satisfies it, so no call site changes.
- Coverage rose from 82.6% lines / 68.9% branches / 78.2% functions to 85.7% / 70.9% / 80.8%, with
  65 new tests. `embeddings/providers.ts`, previously the weakest file in the package at 37% lines,
  is now at 99%.

### Notes

- Bundled embedding dimensions and prices are defaults, not financial truth; override them through
  `embeddings.models.registry` when exact numbers matter.
- Which concrete model an embedding alias resolves to can change in a minor release. Two targets do
  not produce interchangeable vectors, so pin a concrete model when a stored index must stay valid
  across upgrades.

## [1.4.0] - 2026-08-25

Request parity and cost truth: the completion request can now express what current models actually
do, and the response reports what the call really cost. Every addition is an optional field or a new
union member, so existing code is unaffected.

### Added

- **Provider prompt caching.** `CompletionRequest.cache` selects `off`, `auto`, or `explicit` mode
  with a `5m` or `1h` lifetime, and `Message.cache` / `ToolDefinition.cache` mark the end of a
  cacheable prefix. The Anthropic adapter translates marks into `cache_control` breakpoints,
  respecting the four-breakpoint limit by keeping the deepest marks, and every adapter reports what
  the provider actually reused.
- **Reasoning controls.** `CompletionRequest.reasoning` carries `effort`, `maxTokens`, and `summary`.
  These map to OpenAI `reasoning_effort` and the Responses `reasoning` field, Anthropic extended
  thinking with a token budget, and Gemini `thinkingConfig`. A new `'reasoning'` `StreamChunk`
  variant carries reasoning summaries, kept separate from `'text'` so existing consumers that switch
  on chunk type see no change.
- **Tool and sampling controls.** `toolChoice`, `parallelToolCalls`, `seed`, `topK`,
  `frequencyPenalty`, and `presencePenalty` on `CompletionRequest`, mapped per provider.
- **Structured usage and numeric cost.** `ResponseMeta.usage` reports input, output, cached-read,
  cached-write, and reasoning tokens; `ResponseMeta.cost` reports a numeric amount with a currency
  and an `estimated` or `reported` basis. Cached reads and cache writes are priced at their own
  rates, with a long-lived write costing more than a short-lived one. `models.cachePricing`
  overrides the bundled multipliers.
- **Capability negotiation.** `negotiateCompletionRequest()` reconciles a request against the routed
  model under a `strict`, `warn`, or `off` policy, set through `capabilities.policy` or per request
  through `capabilityPolicy`. Refused options are reported on `ResponseMeta.capabilityWarnings` and
  in `plan()` warnings. An option the registry does not mention is passed through: absence means
  unknown, not unsupported, so an application-registered model is never restricted by fields it does
  not declare, and `off` guarantees a newer provider feature is never blocked by stale metadata.
- **Registry provenance.** Model entries accept `verifiedAt` and `source`; `MODEL_ALIAS_METADATA`
  reports each alias's stage and whether its target floats between releases. `describeModel()`,
  `checkRegistryFreshness()`, and `assertRegistryFreshness()` make drift visible instead of silent.
- **Streamed usage on OpenAI.** `stream_options.include_usage` is requested for OpenAI and Azure, so
  a streamed response reports real tokens and cost rather than zeros. Other OpenAI-compatible
  servers opt in with the new `streamUsage` provider option.
- A `nexus-ai-pro/capabilities` subpath for the negotiation API.

### Fixed

- Claude 5 models were declared as non-reasoning. The registry decided extended-thinking support by
  looking for a `4` in the family name, which is absent from `claude-sonnet-5.0`, `claude-haiku-5.0`,
  and `claude-fable-5.0`. Support is now derived from the family version, so every release from 3.7
  onward is reported correctly, together with the thinking budget each model can accept.
- The Anthropic adapter priced every completion at a hardcoded $0.003/$0.015 per 1k tokens instead of
  using the model registry, so cost was wrong for every Claude model except one. All adapters now
  share one pricing path.
- Streamed Anthropic and Google responses reported zero tokens and `$0.00`. Both now carry the
  provider's own usage totals on the final chunk.
- Google reasoning summaries could be concatenated into visible output. Parts marked `thought` are
  excluded from content and emitted as `'reasoning'` chunks instead.
- A chat stream that ended without a finish reason produced no `done` chunk, leaving consumers
  without terminal metadata.

### Changed

- `ResponseMeta.estimatedCost` is deprecated in favor of the numeric `cost` object. It is still
  populated and stays until the next major release. The metrics path no longer parses money out of
  its own display string.
- `ResponseMeta.tokensInput` keeps its original meaning of every prompt token; the uncached share
  billed at the standard rate is `usage.inputTokens`. Adapters whose provider folds cached tokens
  into one prompt total subtract them so no token is priced twice.
- `resolveModel()` no longer merges the bundled and application registries into a new object on each
  call. It reads both maps directly, which removes a per-request allocation from the hot path;
  `getModelRegistry()` and `getModelAliases()` are unchanged as the merged views.
- Coverage gates raised from 70/60/60 to 82% lines, 67% branches, and 73% functions, with new tests
  for the agent loop, the rules router, the evaluation metric library, and the Google, Ollama, and
  Cohere adapters. The gates sit a couple of points below the lowest figure the supported Node
  versions report, because Node 22 and Node 24 do not count functions identically: the same suite
  measures 78.7% on Node 22 and 75.9% on Node 24. A gate set from one version alone fails on the
  other.

### Notes

Image operations keep their existing strict capability behavior. An unsupported image option changes
the artifact that comes back, so silently dropping one is worse than refusing the request; the
shared policy vocabulary is in place for a future release that revisits this.

## [1.3.0] - 2026-08-17

### Added

- SMS routing on `updatePhoneNumber`. `UpdatePhoneNumberRequest` now carries `smsUrl`, `smsMethod`,
  `smsFallbackUrl`, and `smsFallbackMethod`, and the Twilio provider maps them to `SmsUrl`,
  `SmsMethod`, `SmsFallbackUrl`, and `SmsFallbackMethod`. Only the voice leg could be repointed
  before, so an application holding SMS-enabled numbers had to drop to the provider SDK to say where
  inbound messages should be delivered.
- `TelephonyPhoneNumber` reports the number's current `smsUrl`, `smsMethod`, `smsFallbackUrl`, and
  `smsFallbackMethod`, so message routing can be verified the same way voice routing already is.

## [1.2.1] - 2026-08-10

### Fixed

- TypeScript consumers of the CommonJS build no longer resolve ESM declarations. The CommonJS build
  now emits its own `.d.ts` files, and each export subpath carries per-condition types, so `require()`
  resolves CommonJS declarations instead of reporting TS1479 against the ESM ones.
- Subpath types are discoverable under `moduleResolution: "node10"`, which ignores `exports` and is
  still the default for NestJS projects. A `typesVersions` map now points each subpath at its
  CommonJS declarations, so `nexus-ai-pro/telephony` and friends type-check without a consumer having
  to migrate its `tsconfig.json` to `node16`.

## [1.2.0] - 2026-08-10

### Added

- A `telephony/realtime-bridge` subpath joining a provider media stream to a realtime session:
  inbound-only caller audio forwarding, outbound audio framing in emission order, barge-in that clears
  provider-queued audio before cancelling the response, playback marks that resolve
  `markAudioPlayed()`, stream lifecycle, and custom stream parameters for tenant routing.
- `twilioRealtimeAudioOptions()` pinning both directions to 8 kHz G.711 mu-law so telephony audio
  reaches the model without transcoding.
- Call control and usage metering on `TelephonyProvider` and the Twilio adapter: `getCall`, `endCall`,
  and `parseStatusCallback`, surfaced on `NexusAI` as `getCall`, `endCall`, and
  `parseTelephonyStatusCallback`. Status callbacks carry the authoritative billable call duration.
- Phone-number management on `TelephonyProvider` and the Twilio adapter: `listPhoneNumbers` and
  `updatePhoneNumber`, so an app can point a number at its own voice webhook and status callback.

### Changed

- The package now ships parallel ESM and CommonJS builds. Every export subpath gained a `require`
  condition, so NestJS and other `"module": "commonjs"` consumers can load it without a dynamic-import
  shim. Types stay shared between both builds, and the packed-size guards were raised to account for the
  duplicated JS payload.

## [1.1.0] - 2026-07-28

### Added

- An experimental provider-neutral image operation family with portable asset locations,
  `ImageManager`, generation/editing, strict capability negotiation, runtime provider registration,
  visual-safety hooks, and cancellable local operation handles.
- Opt-in `images`, `images/assets`, `images/mock`, and `images/openai` subpaths with a deterministic
  mock provider and an OpenAI Image API adapter for one-shot generation and reference-based editing.
- An image-provider conformance harness covering normalized assets, metadata, generation, editing, and
  pre-aborted calls.
- A bounded tenant-isolated `MemoryAssetStore` with retention, defensive byte copies, computed SHA-256
  checksums, capacity enforcement, and optional HTTP(S) signing.

### Changed

- Reconciled the changelog and API stability policy with the tagged 1.0.0 release.

## [1.0.0] - 2026-07-17

### Added

- An opt-in realtime package family with `realtime`, `realtime/session`, `realtime/tools`,
  `realtime/conversation`, provider transport, server-helper, and deterministic mock subpaths. Realtime
  code is not added to the root or batch voice import graph.
- Framework-independent OpenAI WebRTC and WebSocket transports with injectable platform interfaces,
  secure server-owned WebRTC negotiation, microphone and remote-audio handling, cancellation, and
  reconnect support.
- A persistent `RealtimeSession` and higher-level `createRealtimeAgent()` API with normalized and raw
  events, barge-in, response cancellation, unheard-audio truncation, typed tools, confirmations,
  idempotency keys, bounded execution, and transcript/usage state.
- Immutable normalized conversations with JSON, OpenAI-event, text, and analytics exports, plus
  connection, first-audio, turn, tool, interruption, reconnect, token, audio-duration, and cost metrics.
- Realtime security controls for tool allowlists, transcript retention, PII hooks, and maximum session
  and audio duration, with structural OpenTelemetry-compatible tracing and metrics hooks.
- Opt-in safe-tool result caching, active-connection/audio-duration metrics, and an application-owned
  realtime cost estimator hook without bundled pricing tables.
- A network-free realtime scheduling example using the deterministic mock transport.

### Changed

- Realtime connections are documented as a separate opt-in operation family. Existing `VoiceSession`
  behavior remains the batch transcription -> completion/tools -> speech workflow.

## [0.9.0] - 2026-07-15

### Added

- Full JSON Schema validation through Ajv and standard format validation through `ajv-formats`.
- Node.js 22 and 24 CI gates for linting, builds, tests, consumer type checks, and packed-package installation.
- OIDC trusted publishing with npm provenance for tagged releases.
- API stability, security, and contribution policies.
- Biome formatting/lint gates, test/example type checks, and built-in Node.js coverage thresholds.

### Changed

- The supported runtime is now Node.js 22 or newer and the package is explicitly ESM-only.
- Provider, cache, and job entry points now use an explicit export map instead of wildcard exports.
- Published tarballs contain the runtime and essential package documentation, excluding repository examples and marketing assets.
- Provider peer dependency ranges are bounded to tested SDK lines.
- Build and publish scripts always clean and rebuild `dist` before packing.
- Security-enabled output streams validate the complete bounded response before yielding chunks.

### Fixed

- Blocking output policies now stop unsafe completions instead of returning blocked content as successful output.
- Streaming redaction protects values that cross provider chunk boundaries.
- Provider timeouts abort in-flight completion and streaming requests.
- URL fetching rejects unsafe private-network targets and limits response reads.
- CLI and audit findings no longer disclose detected secret values.

[Unreleased]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v2.11.0...HEAD
[2.11.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v2.10.0...v2.11.0
[2.10.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v2.9.0...v2.10.0
[2.9.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v2.8.0...v2.9.0
[2.8.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v2.7.0...v2.8.0
[2.7.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v2.6.0...v2.7.0
[2.6.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v2.5.0...v2.6.0
[2.5.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v2.4.0...v2.5.0
[2.4.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.25.0...v2.0.0
[1.25.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.24.0...v1.25.0
[1.24.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.23.0...v1.24.0
[1.23.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.22.0...v1.23.0
[1.22.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.21.0...v1.22.0
[1.21.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.20.0...v1.21.0
[1.20.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.19.0...v1.20.0
[1.19.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.18.0...v1.19.0
[1.18.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.17.0...v1.18.0
[1.17.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.16.0...v1.17.0
[1.16.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.15.0...v1.16.0
[1.15.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.14.0...v1.15.0
[1.14.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.12.0...v1.14.0
[1.12.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.11.0...v1.12.0
[1.11.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.10.0...v1.11.0
[1.10.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.9.0...v1.10.0
[1.9.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.8.0...v1.9.0
[1.8.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.7.0...v1.8.0
[1.7.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.2.1...v1.3.0
[1.2.1]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/releases/tag/v1.0.0
[0.9.0]: https://github.com/mkhitar-abrahamyan/nexus-ai/releases/tag/v0.9.0
