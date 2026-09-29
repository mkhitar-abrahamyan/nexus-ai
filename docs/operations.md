# Durable operations and jobs

<!-- covers: ./operations ./operations/adapters ./operations/webhooks ./jobs ./jobs/batch ./jobs/durable-adapters ./jobs/queue -->

Background work that survives a restart, from `nexus-ai-pro/operations`. A submitted operation has an
id, a status, progress, cancellation, and a stream of events. Give it a store and a dispatcher, and
it survives a crash and can run on another worker.

When durability is not needed, the in-process helpers on `nexus-ai-pro/jobs` are lighter.

## Durable Operations

Long-running work — an image render, a batch, anything asynchronous — runs through one lifecycle:
`queued → running → succeeded | failed`, with `retrying`, `cancelling`, `cancelled`, and `expired`
covering the rest. `OperationRunner` owns it end to end, so a crashed worker does not lose work.

The default store is in-process, so the small case needs no infrastructure:

```ts
import { OperationRunner } from 'nexus-ai-pro/operations';

const runner = new OperationRunner<string>({ retry: { maxAttempts: 3, baseDelayMs: 500 } });

const handle = await runner.submit(async (context) => {
  context.report({ completed: 1, total: 3 });
  return doTheWork(context.signal);
});

for await (const event of handle.events()) {
  console.log(event.type, event.sequence);
}

const value = await handle.result();
```

Swapping the store makes the same code survive a restart. Nothing else changes:

```ts
import { OperationRunner } from 'nexus-ai-pro/operations';
import { BullMQOperationDispatcher, RedisOperationStore } from 'nexus-ai-pro/operations/adapters';

const runner = new OperationRunner({
  store: new RedisOperationStore(redis),
  dispatcher: new BullMQOperationDispatcher(queue),
  owner: process.env.HOSTNAME,
  leaseMs: 30_000,
  webhook: { url: 'https://app.example/hooks/operations', secret: process.env.HOOK_SECRET! },
});
```

**How restart survival actually works.** A worker claims a lease before running and heartbeats
while it works. If the process dies, the lease simply lapses; another worker's `recover()` sweep
finds the record and resumes it. There is no distributed lock — every store write is a
compare-and-set on the record's `sequence`, so two workers racing on the same operation cannot both
win.

```ts
// On startup, in each worker.
const resumed = await runner.recover(executor);
```

Recovery is deliberately conservative: a record past its `expiresAt` is **expired** rather than
re-run, and one that has used every attempt is **dead-lettered** and parked for inspection, so a
permanently failing operation cannot be recovered forever.

**Idempotency.** An `idempotencyKey` that matches an existing record replays that operation instead
of starting a second one, which is what stops an ambiguous timeout from double-charging:

```ts
const handle = await runner.submit(chargeAndRender, { idempotencyKey: `render:${orderId}` });
```

**Webhooks** are signed with HMAC-SHA256 over `${timestamp}.${body}`, so a captured delivery cannot
be replayed indefinitely. The verifying half ships too — a receiver should never have to hand-roll a
constant-time comparison:

```ts
import { OPERATION_WEBHOOK_SIGNATURE_HEADER, verifyOperationWebhook } from 'nexus-ai-pro/operations/webhooks';

app.post('/hooks/operations', (request, response) => {
  const ok = verifyOperationWebhook(
    request.rawBody,
    request.header(OPERATION_WEBHOOK_SIGNATURE_HEADER),
    process.env.HOOK_SECRET!,
  );
  response.sendStatus(ok ? 204 : 400);
});
```

A failed delivery is reported through `onWebhookError` and never turns a completed operation into a
failed one.

**Binary payloads are refused, not truncated.** Persisting a result that carries a `Uint8Array`,
`Buffer`, or `Blob` throws `OperationSerializationError` naming the exact path. Base64 in a job
payload inflates it by a third and most queue backends cap job size well below one image, so the
bytes belong in an `AssetStore` with only a reference on the record. The BullMQ dispatcher likewise
queues the operation id and nothing else.

The image family already runs on this lifecycle, so `ai.images.submit()` reports the same events —
through an in-process handle, not a store, so an image operation does not survive a restart.

## The lifecycle

An `OperationStatus` is one of `queued`, `running`, `retrying`, `succeeded`, `failed`, `cancelling`,
`cancelled`, or `expired`.

Four are final — succeeded, failed, cancelled, and expired — and `TERMINAL_OPERATION_STATUSES` lists
them. Nothing leaves a final status, so a late provider callback cannot bring a cancelled operation
back. One subtlety: `cancelling` can still reach `succeeded` or `failed`, because a cancel asks the
executor to stop but cannot promise it stopped in time.

| Function | Answers |
| --- | --- |
| `isTerminalOperationStatus()`, `isSettled()` | Is the status final? |
| `isClaimable()` | May a worker start it? True for `queued` and `retrying`. |
| `canTransition()` | Is a move allowed? |
| `assertTransition()` | The same, throwing `OperationTransitionError` when not. |
| `allowedTransitions()` | Every move from a status, for a custom store or runner. |

## Running operations

`OperationRunner` takes an `OperationRunnerConfig`:

| Option | Default | What it sets |
| --- | --- | --- |
| `store` | memory | Where records live. |
| `dispatcher` | none | Hands work to other workers. |
| `owner` | — | This worker's name, recorded on its leases. |
| `leaseMs`, `heartbeatMs` | 30 s, a third of it | How long a claim lasts, and how often it is renewed. |
| `timeoutMs` | none | A limit for a whole operation. |
| `retry` | one attempt | An `OperationRetryConfig`: attempts, first and longest delay, fixed or exponential backoff, jitter, and an `isRetryable` test. By default everything but a cancellation is retried. |
| `webhook`, `onWebhookError` | — | Notifications, and where delivery failures are reported. |
| id generator, clock | — | For tests. |

The runner has four methods:

| Method | What it does |
| --- | --- |
| `submit()` | Starts an operation. Takes an `OperationExecutor` and `OperationSubmitOptions`. |
| `read()` | Returns the stored record. |
| `cancel()` | Cancels by id, from any worker. |
| `recover()` | Resumes operations whose lease lapsed. Call it on each worker at startup. |

`OperationSubmitOptions` can set an id, a `kind` such as `image.generate`, an `idempotencyKey`,
`maxAttempts` and `timeoutMs` for this operation, an `expiresAt`, trace headers, metadata, and a signal.

The executor is a function of an `OperationContext`, which gives it:

- the id and the attempt number;
- a signal, aborted on cancellation, timeout, or a lost lease;
- `report()` for progress, and `heartbeat()` to extend the lease before a long step;
- the trace headers and metadata from submission.

`submit()` returns a `DurableOperationHandle`. It implements the `OperationHandle` contract — `id`,
`status()`, `result()`, `cancel()`, and `events()` — and adds `record()` for the stored snapshot and
`progress()`.

An `OperationProgress` has any of a ratio, a count done and a total, a message, and metadata. Show
what is present rather than assuming a percentage.

`LocalOperationHandle` is the in-process handle the runner builds on, for a family that needs a handle
without a store. `LocalOperationHandleOptions` sets its clock, the error a cancellation rejects with,
and an event listener.

## Events

Every `OperationEvent` carries the `OperationEventBase` fields: the operation id, the record's
sequence (for ordering and de-duplication), and a timestamp. `OperationEventType` names the kinds:

| Event | Extra fields |
| --- | --- |
| `queued` | — |
| `running` | The attempt. |
| `progress` | The progress. |
| `retrying` | The delay, and the error. |
| `cancelling`, `cancelled`, `expired` | — |
| `succeeded` | The result. |
| `failed` | The error, and whether it was dead-lettered. |

A failure is recorded as an `OperationErrorDescriptor`: the error's name, message, stable code, and
whether it was retryable. That shape survives a store and a webhook. `describeOperationError()` builds
one from any error.

## Records and stores

An `OperationRecord` is what a store keeps:

- the id, status, attempt, and attempt budget;
- the `sequence`, bumped on every write;
- when it was created, started, completed, and when it expires;
- the `OperationLease`: the owner, when it lapses, and the last heartbeat;
- progress, the result or error, and whether it was dead-lettered;
- the idempotency key, kind, trace headers, and metadata.

`assertSerializableRecord()` refuses a record that carries raw bytes, naming the path.

An `OperationStore` needs three methods: `create()`, `read()`, and `update()`. `update()` is a
compare-and-set: it returns `false` when another worker changed the record first. Optional methods add
`delete()`, `claimExpired()` for recovery, `findByIdempotencyKey()`, and `list()`.

| Store | Notes |
| --- | --- |
| `MemoryOperationStore` | The default. Evicts the oldest settled records beyond `MemoryOperationStoreOptions.maxRecords` (1,000). |
| `RedisOperationStore` | Takes a `RedisOperationLikeClient` (`hget`, `hset`, `hdel`, `hvals`, and optionally `eval`) and `RedisOperationStoreOptions` (a key `prefix` and `useEval`). With `eval`, the compare-and-set is one atomic Lua call. Without it, a read-then-write narrows the race but cannot close it. |
| `PostgresOperationStore` | See the [Postgres guide](./postgres.md). |
| `SqliteOperationStore` | See the [SQLite guide](./sqlite.md). |

An `OperationDispatcher` hands an accepted record to a worker. `BullMQOperationDispatcher` queues only
the id and routing metadata on a `BullMQLikeOperationQueue`. It uses the operation id as the job id, so
a duplicate dispatch is ignored. `BullMQOperationDispatcherOptions` sets the job name and options.

## Errors

Every operation error extends `OperationError` and has a stable code.

| Error | When | What to do |
| --- | --- | --- |
| `OperationCancelledError` | `result()` of a cancelled operation. | — |
| `OperationExpiredError` | `result()` of an expired operation. | — |
| `OperationConflictError` | A compare-and-set lost to another worker. | Reload the record; do not retry the write. |
| `OperationLeaseLostError` | Another worker took over the operation. | Stop working on it. |
| `OperationDuplicateError` | A store refused a second record with the same idempotency key. | The runner attaches to the existing operation. |
| `OperationNotFoundError` | No record has that id. | — |
| `OperationTransitionError` | The lifecycle forbids the move. | A bug in a runner or store. |
| `OperationSerializationError` | A result carries raw bytes. | Put the bytes in an asset store. |

## Webhooks in detail

`OperationWebhookConfig` has the `url`, the `secret`, the `events` to send (terminal ones by default),
extra headers, a `fetch`, and a timeout (10 seconds).

| Function | What it does |
| --- | --- |
| `deliverOperationWebhook()` | Sends one event. Throws on a failed delivery, which the runner reports and moves past. |
| `signOperationWebhook()` | Builds the `t=…,v1=…` signature over the timestamp and the body. |
| `verifyOperationWebhook()` | Checks a signature in constant time. Rejects a delivery older than `VerifyOperationWebhookOptions.toleranceSeconds` (300). |

## In-process jobs

`nexus-ai-pro/jobs` holds lighter helpers. None of them survives a restart the way an operation does.

```ts
import { runBatch } from 'nexus-ai-pro/jobs/batch';

const results = await runBatch(documents, (doc) => ai.complete(summarizeRequest(doc)), { concurrency: 4 });
```

| Helper | What it does |
| --- | --- |
| `runBatch()` | Runs a worker over items with bounded concurrency. Returns a `BatchItemResult` per item, in input order: its index, whether it succeeded, and the value or error. `BatchOptions` sets `concurrency` (3) and `stopOnError`, which stops starting items after the first failure. |
| `JobQueue` | Runs a worker over enqueued payloads, with `QueueOptions` for `concurrency` (1) and `maxAttempts` (1). Each `QueueJob` has an id, the payload, its attempts, a status (`queued`, `running`, `completed`, or `failed`), and the result or error. `list()` and `get()` read them. |
| `DurableQueueAdapter` | Storage for job records: `enqueue()`, `get()`, `update()`, and `list()`. It stores jobs; running them is up to your worker. |
| `RedisQueueAdapter` | That storage in Redis, through a `RedisQueueLikeClient` (`lpush`, `hset`, `hget`, `hvals`). |
| `BullMQQueueAdapter` | Hands jobs to an existing BullMQ queue through the `BullMQLikeQueue` slice. BullMQ's own workers run them, and it reads a job's result back by id. |

When work must survive a restart or run on another worker, use an operation instead.

## Limitations

- The in-memory operation store and `JobQueue` live in one process. `SqliteOperationStore` shares
  records between processes on one machine; a distributed deployment needs `RedisOperationStore` or
  `PostgresOperationStore` and a dispatcher such as BullMQ.
- Recovery re-runs a whole attempt, not the step it died on, so an executor with side effects should
  be idempotent, using the operation id or its idempotency key. To lose only a step, run the work as
  a graph or a [functional workflow](./graphs.md#functional-workflows), which checkpoints each step.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/jobs/batch`

| Export | Kind | Summary |
| --- | --- | --- |
| `BatchItemResult` | interface | The outcome of one batch item. |
| `BatchOptions` | interface | Options for `runBatch()`. |
| `runBatch` | function | Runs a worker over items with bounded concurrency, collecting a result per item in input order. |

### `nexus-ai-pro/jobs/durable-adapters`

| Export | Kind | Summary |
| --- | --- | --- |
| `BullMQLikeQueue` | interface | The part of a BullMQ `Queue` the adapter needs. |
| `BullMQQueueAdapter` | class | Hands jobs to an existing BullMQ queue, whose workers run them. |
| `DurableQueueAdapter` | interface | Where a job queue keeps its jobs so they survive a restart. |
| `RedisQueueAdapter` | class | Keeps queue jobs in Redis: one hash of jobs per queue, and a list of pending ids. |
| `RedisQueueLikeClient` | interface | The Redis commands the queue adapter needs, in `ioredis` argument order. |

### `nexus-ai-pro/jobs/queue`

| Export | Kind | Summary |
| --- | --- | --- |
| `JobQueue` | class | An in-process job queue with concurrency and retries. |
| `QueueJob` | interface | A job in an in-process queue. |
| `QueueOptions` | interface | Options for an in-process job queue. |

### `nexus-ai-pro/operations`

| Export | Kind | Summary |
| --- | --- | --- |
| `allowedTransitions` | function | Statuses reachable from `from`, for building a UI or validating a custom runner. |
| `assertSerializableRecord` | function | Refuses to persist a record carrying raw bytes. |
| `assertTransition` | function | Throws `OperationTransitionError` when an operation may not move from one status to another. |
| `canTransition` | function | Whether an operation may move from one status to another. |
| `describeOperationError` | function | Reduces any error to the name, code, message, and retryability an operation record stores. |
| `DurableOperationHandle` | interface | A durable handle, which can also report what a store knows about the operation. |
| `isClaimable` | function | True when a worker may claim the operation and start executing. |
| `isSettled` | function | True when the operation is finished and a worker should stop touching it. |
| `isTerminalOperationStatus` | function | Whether an operation has reached a status it can never leave. |
| `LocalOperationHandle` | class | A process-local operation handle: status, awaitable result, cancellation, and an event stream. |
| `LocalOperationHandleOptions` | interface | Options for a process-local operation handle. |
| `MemoryOperationStore` | class | In-process operation storage. |
| `MemoryOperationStoreOptions` | interface | Options for the in-memory operation store. |
| `OperationCancelledError` | class | Raised when work is attempted on a cancelled operation. |
| `OperationConflictError` | class | Raised when a compare-and-set update loses to another worker. |
| `OperationContext` | interface | What an executor receives. |
| `OperationDispatcher` | interface | Hands an accepted operation to a worker process. |
| `OperationDuplicateError` | class | Raised by a store that enforces unique idempotency keys when a second record claims one. |
| `OperationError` | class | Base class for durable-operation errors, each with a stable `code`. |
| `OperationErrorDescriptor` | interface | A failure, in a form that survives serialization into a store or a webhook. |
| `OperationEvent` | type | Everything an operation reports, as a discriminated union on `type`. |
| `OperationEventBase` | interface | Fields every operation event carries. |
| `OperationEventType` | type | The name of an operation event, such as `succeeded`. |
| `OperationExecutor` | type | The work an operation performs. |
| `OperationExpiredError` | class | Raised when an operation passes its expiry before completing. |
| `OperationHandle` | interface | A running or finished operation. |
| `OperationLease` | interface | Exclusive claim a worker holds while it executes an operation. |
| `OperationLeaseLostError` | class | Raised when a worker's lease on an operation was taken over by another worker. |
| `OperationNotFoundError` | class | Raised when an operation id is not in the store. |
| `OperationProgress` | interface | How far along a running operation is. |
| `OperationRecord` | interface | The persistable state of one operation. |
| `OperationRetryConfig` | interface | How an operation's failed attempts are retried. |
| `OperationRunner` | class | Runs operations against a durable store. |
| `OperationRunnerConfig` | interface | Configuration for `OperationRunner`: where records live, how work is dispatched, and how failures are retried. |
| `OperationSerializationError` | class | Raised when a result carrying raw bytes is about to be persisted. |
| `OperationStatus` | type | The operation lifecycle shared by every long-running family. |
| `OperationStore` | interface | Durable storage for operation records. |
| `OperationSubmitOptions` | interface | Options for one submitted operation. |
| `OperationTransitionError` | class | Raised when a transition would leave the lifecycle in an impossible state. |
| `OperationWebhookConfig` | interface | Sends signed operation events to a URL. |
| `TERMINAL_OPERATION_STATUSES` | constant | Statuses from which an operation can never move again. |

### `nexus-ai-pro/operations/adapters`

| Export | Kind | Summary |
| --- | --- | --- |
| `BullMQLikeOperationQueue` | interface | The part of a BullMQ `Queue` the dispatcher needs. |
| `BullMQOperationDispatcher` | class | Hands accepted operations to a BullMQ queue for a worker process to execute. |
| `BullMQOperationDispatcherOptions` | interface | Options for the BullMQ operation dispatcher. |
| `RedisOperationLikeClient` | interface | The Redis commands the operation store needs. |
| `RedisOperationStore` | class | Redis-backed operation storage, so a submitted operation survives a restart. |
| `RedisOperationStoreOptions` | interface | Options for the Redis operation store. |

### `nexus-ai-pro/operations/webhooks`

| Export | Kind | Summary |
| --- | --- | --- |
| `deliverOperationWebhook` | function | Delivers one operation event to a configured endpoint. |
| `OPERATION_WEBHOOK_SIGNATURE_HEADER` | constant | Header that carries a delivery's signature. |
| `signOperationWebhook` | function | Builds the signature for one delivery. |
| `verifyOperationWebhook` | function | Verifies a delivery signature. |
| `VerifyOperationWebhookOptions` | interface | Options for `verifyOperationWebhook()`. |
<!-- reference:end -->
