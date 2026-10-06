# The agent server (experimental)

<!-- covers: ./server ./server/auth ./server/remote -->

A self-hosted HTTP server for your assistants, from `nexus-ai-pro/server`: threads, background runs,
event streams you can resume, and cron jobs.

It is a thin layer over parts that already exist. A run is a durable operation, and a thread is a
graph thread. What the server adds is the HTTP surface, and the rules for a thread that is already
busy. `nexus-ai-pro/server/remote` is the client, so calling a deployed agent never loads the server.

## A server in fifteen lines

```ts
import { createServer } from 'node:http';
import { createAgentServer, graphAssistant, toNodeListener } from 'nexus-ai-pro/server';
import { jwtAuth } from 'nexus-ai-pro/server/auth';

const server = createAgentServer({
  assistants: { support: graphAssistant(supportGraph, { description: 'Answers support questions' }) },
  authenticate: jwtAuth({ jwks: 'https://login.example.com/.well-known/jwks.json', audience: 'agents-api' }),
  onBusy: 'enqueue',
});

await server.start();
createServer(toNodeListener(server)).listen(8080);
```

`createAgentServer()` returns an `AgentServer`:

| Member | What it does |
| --- | --- |
| `handle(request)` | Answers one `Request`. This is the whole HTTP surface. |
| `runs`, `cron` | The run manager and the scheduler behind it. |
| `start()` | Re-claims runs a crashed worker left, starts the scheduler and the worker loop, and starts heartbeating. |
| `stop()` | Stops all of that. Runs in flight finish. |
| `drain()` | Prepares the replica to shut down. See [Workers and the queue](#workers-and-the-queue). |
| `scaling()` | The numbers an autoscaler reads, as `GET /scaling` reports them. |

`AgentServerOptions` takes:

- the `assistants`, by id;
- everything the run manager takes: the state store, the event log, the operation runner's settings,
  the `queue`, `recoverEveryMs`, the `tenants` limits, the busy policy, and the timeouts;
- the HTTP settings: `basePath`, `authenticate`, `allowAnonymous`, `scopes`, `cron` with the jobs that
  exist from startup, and `heartbeatMs` for live streams;
- `metrics`, which controls `GET /metrics` and `GET /scaling`;
- `deployments` and `replicaMetadata`, for revisions and replica reports.

## The HTTP surface

| Route | What it does |
| --- | --- |
| `GET /health` | Readiness, and which worker answered. Answered without credentials; `503` while draining |
| `GET /assistants`, `GET /assistants/:id` | What this server serves, and what each one supports |
| `POST /threads`, `GET /threads`, `GET /threads/:id`, `DELETE /threads/:id` | Conversations |
| `GET /threads/:id/state` | The assistant's state for a thread |
| `POST /threads/:id/runs` | Run on a thread; `{ "resume": … }` answers an interrupt |
| `GET /threads/:id/runs` | That thread's runs |
| `POST /runs`, `GET /runs`, `GET /runs/:id` | Stateless runs |
| `POST /runs/:id/cancel` | Cancel, including a run another replica is executing |
| `GET /runs/:id/events` | The event stream, resumable with `Last-Event-ID` |
| `POST /crons`, `GET /crons`, `DELETE /crons/:id` | Scheduled runs |
| `GET /metrics`, `GET /scaling` | The queue and this replica, as Prometheus text and as JSON |
| `GET /usage` | The caller's tenant usage, when `tenants` is set |
| `/deployments`, `/replicas` | Revisions, traffic splits, and replicas, when `deployments` is set |

Mount them under a prefix with `basePath`. A run is accepted with `202` and a `RunRecord`; add
`"stream": true` (or `?stream=true`) to start it and stream it in one request instead. Add
`"revision"` to run one revision of an assistant that has several.

The last three rows are covered in the [deployments guide](./deployments.md).

## Assistants

An assistant is anything that streams events for an input. That is the `ServerAssistant` contract, and
its only required member is `stream`. Optional members are what a thread needs: `resume` to answer an
interrupt, `state` to report it, and `step` with `restore` for the rollback policy.

Two helpers build assistants:

- `graphAssistant()` serves a compiled graph. Server threads map to graph threads, so state,
  interrupts, and history are the graph's own. It needs only `GraphLike`, a structural slice, so the
  server entry point never imports the graph runtime. `GraphAssistantOptions` sets a `description`
  for the assistants endpoint, `metadata` recorded on every checkpoint, and `events`: projections
  of the graph's event stream, such as `['messages', 'tools']`, to record on each run, so a client
  following it sees model output and tool calls as they happen. The run's last event still carries
  its state and any question. A graph without a
  checkpointer still serves stateless runs, but cannot resume or roll back.
- `functionAssistant()` serves a plain function, which may return a value or yield events.

An assistant receives an `AssistantRunContext`: the run id, the thread, an abort signal, the principal,
the run's metadata, the attempt, the revision serving it, and a `control` that turns to draining
when the replica drains. Its `recordCost(usd)` records what the
run spent, such as a model call's cost:

```ts
const answer = await ai.complete(request);
await context.recordCost(answer.meta.cost?.amount ?? 0);
```

The amount is added to the run's `cost` and to its tenant's budget. A budget that stops runs in flight
cancels the run there.

An assistant can also have revisions. Its optional `route()` picks the revision for each run, and
`revision()` returns one revision's assistant. `Deployments.assistant()` builds both; see the
[deployments guide](./deployments.md).

## Runs are durable operations

`RunManager` submits every run through the operation runner, so leases, heartbeats, retries,
idempotency, dead-lettering, and webhooks are the operations family's, not the server's. It is
available as `server.runs` and usable on its own — `StartRunOptions` and `RunManagerOptions` configure
it, and `RunRecord` and `RunStatus` are what it reports.

- **Crash recovery.** A worker that dies leaves a record whose lease lapses. Another replica's
  `start()`, or `runs.recover()`, claims it as a new attempt. So allow more than one attempt:
  `operations: { retry: { maxAttempts: 2 } }`. A graph or workflow served by `graphAssistant()`
  continues from the last checkpoint that run wrote, so only the step in flight runs again. Any other
  assistant starts over. The assistant sees the attempt in `AssistantRunContext.attempt`; its optional
  `recover()` hook is what continues the run.
- **Idempotency.** `idempotencyKey` on a run replays the existing run instead of starting a second,
  which is what makes a retried request safe.
- **Cancellation.** `POST /runs/:id/cancel` aborts a local run at once and is observed by another
  replica through its heartbeat. A cancelled run stays cancelled even if its executor finishes later.
- **Timeouts.** `runTimeoutMs` expires a run that runs too long.

A `RunRecord` also records how the run went:

| Field | What it holds |
| --- | --- |
| `revision` | The revision that served it, its share of traffic, and why it was chosen. |
| `startedAt`, `finishedAt` | When a worker first started it, and when it finished. |
| `durationMs` | Time from the first start to the finish, across every attempt. |
| `cost` | US dollars recorded through `recordCost()`, across every attempt. |
| `worker`, `attempt` | The worker that ran its latest attempt, and which attempt that was. |

## Workers and the queue

By default, a run executes on the replica that accepted it. `queue` turns the replicas into a worker
pool instead. `RunQueueOptions` has three fields:

| Field | Default | What it does |
| --- | --- | --- |
| `concurrency` | 10 | Runs this replica executes at once. |
| `claim` | true | Whether this replica claims queued runs. `false` makes an API replica that only accepts them. |
| `pollMs` | 1 s | How often an idle worker looks for queued runs. |

A replica with room starts a new run itself. Otherwise the run waits in the operation store, and the
next free worker claims it. With a queue, each replica also takes over runs whose worker stopped, every
`recoverEveryMs` (30 seconds by default). Without a queue, set `recoverEveryMs` to get the same.

`GET /scaling` returns a `ScalingSnapshot`: queued and running runs across the deployment, their sum
as `load`, the oldest queued run's wait, lapsed leases, and the answering replica's
`ReplicaReport`. `GET /metrics` reports the same as Prometheus text, plus run counts and latency per
revision. Both need a read scope unless `metrics: { public: true }`; `metrics: false` turns them off.

`drain({ timeoutMs })` gets a replica ready to stop. `/health` answers `503`, the replica stops
claiming, and new runs it accepts are queued. Runs in flight get `timeoutMs` (25 seconds by default)
to finish. With a queue, the rest are handed back for another worker to continue. The `DrainResult`
lists the runs that finished and the runs that were handed off.

A client that reads a run's events slowly cannot make the server hold more: events go to the run's
event log, which keeps `maxEventsPerRun` per run, and each reader reads from it at its own pace.

A graph served through `graphAssistant()` does not wait for the timeout. With a queue, a drain sets
the run's `control` to draining, which the graph reads as its `RunControl`. It finishes the superstep
in flight, writes its checkpoint, and stops, and the run goes back to the queue at once. The next
worker continues from that checkpoint, so no step runs twice and none is cut off halfway. Call it on `SIGTERM`:

```ts
process.on('SIGTERM', async () => {
  await server.drain();
  await server.stop();
  process.exit(0);
});
```

## Handing a run off on a drain

When a replica drains with a queue to hand work to, it sets each run's `context.control.draining`. A
graph or a workflow served through `graphAssistant()` stops at its next boundary and is continued by
the next worker from its checkpoint. A function assistant does the same with three pieces of its
context:

- `context.control?.draining`, checked between its own steps;
- `context.saveProgress(details)`, which records how far it got — the last item finished, a cursor —
  and extends the run's lease, as a heartbeat does;
- `context.progress`, which the next attempt reads back.

Throwing `RunHandOffError` while draining puts the run back on the queue as its next attempt, at
once, instead of waiting for the drain's timeout; thrown when the replica is not draining, it fails
the run like any error.

```ts
const batch = functionAssistant(async (input, context) => {
  let next = typeof context.progress === 'number' ? context.progress : 0;
  for (; next < items.length; next += 1) {
    if (context.control?.draining) throw new RunHandOffError();
    await process(items[next]);
    await context.saveProgress?.(next + 1);
  }
  return { processed: next };
});
```

## A busy thread

One thread runs one thing at a time. `onBusy`, set per server or per run, decides what a second
request does, as `ThreadBusyPolicy`:

| Policy | Behaviour |
| --- | --- |
| `reject` | `409` with `THREAD_BUSY`. The default. |
| `enqueue` | Waits its turn behind the runs in flight, up to `queueTimeoutMs`, then runs; still busy then, it is refused with `THREAD_BUSY`. |
| `interrupt` | Cancels the run in flight and starts the new one. |
| `rollback` | Cancels it, puts the thread back to the step it was at before, and starts the new one. |

`rollback` needs an assistant with `restore`; `graphAssistant()` provides it by writing the earlier
checkpoint's state forward, so the history stays intact. An assistant without it is refused with
`AssistantCapabilityError` rather than silently doing something else.

The thread is claimed atomically. The claim is a record in the operation store under a unique
idempotency key, moved from run to run by compare-and-set, so of ten replicas starting runs on one
thread at the same moment exactly one proceeds and the rest meet the policy. Before 2.2 a thread's
busy check read and wrote separately, and replicas racing could all see it free. A custom operation
store without `findByIdempotencyKey` keeps that older behaviour.

## Streaming, and reconnecting

`GET /runs/:id/events` is a server-sent event stream. Every event carries the id it has in the run's
log, so a client that drops sends `Last-Event-ID` and gets exactly what it missed — no gaps, no
repeats. The stream ends on the event that reports a finished or awaiting-input run, and a run that
finished before a client attached still ends with its status.

Where the log lives decides how far that goes. `MemoryRunEventLog` is the default and covers one
replica; `RedisRunEventLog` shares the log, so a client can reconnect to any replica and resume.
`RunEventLog` is the contract, `RunEvent` the event, and `RedisEventLogLikeClient` the handful of
Redis commands the adapter needs. `MemoryRunEventLogOptions`, `RedisRunEventLogOptions`, and the
server's `heartbeatMs` bound memory use and keep idle connections open.

## Cron jobs

`CronScheduler` fires scheduled runs, configured at startup or through `POST /crons`. A schedule is
`{ everyMs }` or `{ cron }` — the five-field syntax, in UTC, parsed by `parseCron()`. `CronRecord` is
a job and `DueCronJob` is one that is due, carrying the `slot` it is due for.

Every replica ticks, and every firing is submitted with the idempotency key `<job>:<slot>`, so the
operation store decides which replica wins and the job runs once however many replicas are up. There
is no lock and no leader election. `CronSchedulerOptions` sets the tick interval, the store, and an
error hook; `tick()` can also be called directly, which is how an external scheduler or a test drives
it.

## Authentication and tenancy

`authenticate` turns a request into a `Principal`, which has these fields:
- `tenantId`, the tenant;
- `userId`, the subject;
- `roles` and `scopes`;
- `method`, how the caller was authenticated;
- `claims`, the verified claims.

Returning nothing refuses the request as unauthenticated; returning a `Response` answers it directly,
which is how a challenge or a redirect is returned. `allowAnonymous: false` refuses everything when
no hook is configured. `GET /health` is always answered, because a probe carries no credentials.

The principal goes everywhere the run goes:
- Its tenant scopes threads, runs, cron jobs, budgets, and the store.
- Its subject is recorded on what it creates and on every checkpoint, as `metadata.userId`, and in
  the run's trace.
- Graph nodes and workflow steps read it as `context.principal`.
- An agent passes it to every tool, middleware, and permission policy. A tool can therefore act as
  that user and no one else.

**Built-in hooks.** `nexus-ai-pro/server/auth` has three hooks, each an `AuthHook` that returns the
same `Principal`. They are built on Web Crypto, so they need no dependency.

`jwtAuth()` verifies a JSON Web Token, read from `Authorization: Bearer` unless `token` reads it from
elsewhere, such as a cookie. The key comes from one of three places:
- an identity provider's key set (`jwks`), which is cached; a token that names a new key fetches
  the set again, so a key rotation needs no restart;
- a public key, as PEM, a JWK, or a `CryptoKey`;
- a shared secret.

`JwtAuthOptions` extends `JwtVerifyOptions`:
- the `JwtAlgorithm`s accepted;
- the `issuer` and `audience`;
- clock tolerance;
- `maxAgeSec`;
- required claims;
- `JwtClaimNames`, which says where the tenant, roles, and scopes are. A dot reaches a nested
  claim, as in `realm_access.roles`.

A token must carry an expiry. `alg: none` is never accepted. A secret is never accepted for an
asymmetric algorithm, nor a public key for HMAC, so one cannot be passed off as the other. With a
key set, `audience` is required, because a provider signs tokens for every application it serves.
`audience: false` accepts any audience on purpose.

Responses:
- A request with no token is passed over.
- A refused token answers `401`, with a `WWW-Authenticate` challenge naming why.
- A valid token whose claims make no principal answers `403`.

```ts
import { anyAuth, apiKeyAuth, hashApiKey, jwtAuth } from 'nexus-ai-pro/server/auth';

const server = createAgentServer({
  assistants,
  authenticate: anyAuth(
    jwtAuth({
      jwks: 'https://login.example.com/.well-known/jwks.json',
      issuer: 'https://login.example.com/',
      audience: 'agents-api',
      claims: { tenant: 'org_id', roles: 'realm_access.roles' },
    }),
    apiKeyAuth({ keys: { [await hashApiKey(process.env.CI_KEY ?? '')]: { userId: 'ci', tenantId: 'acme', scopes: ['write'] } } }),
  ),
});
```

`createJwtVerifier()` is the verifier on its own, for a WebSocket handshake or a queue consumer. Its
`JwtVerifier.verify()` returns a `VerifiedJwt`: the `JwtHeader` and the `JwtPayload`, every claim
checked. Otherwise it throws a `JwtError`, whose `JwtErrorCode` says why: malformed, wrong algorithm,
no key, bad signature, expired, not yet valid, too old, another issuer, another audience, or a
missing claim.

`apiKeyAuth()` authenticates services and scripts by key. Keys are compared by their SHA-256 hash,
from `hashApiKey()`, so neither configuration nor a database holds a key itself.
`ApiKeyAuthOptions` takes the hashes with the principal each stands for, a `lookup` by hash, the
header, and a `prefix`. The prefix keeps a token in the same header for another hook. Without one,
anything shaped like a JWT is left alone. An unknown key answers `401`.

`trustedProxyAuth()` takes the caller from headers that an identity-aware proxy, a gateway, or a mesh
sets. Headers are only as trustworthy as the path the request took. So `TrustedProxyAuthOptions`
must give proof that the proxy sent the request: a shared `secret` header, compared in constant
time, a `trust` check of your own, or both. Without that proof the hook refuses to be built.
`TrustedProxyHeaders` names the user, tenant, roles, and scopes headers.

`anyAuth()` tries hooks in order and takes the first principal. When none accepts, the answer is the
first refusal any of them gave, so a caller learns why their credential failed.

`scopes` names the scope each group of routes requires:

| Scope | Routes |
| --- | --- |
| `read` | Reads, streams, `/usage`, and — unless public — `/metrics` and `/scaling`. |
| `write` | Creating threads, runs, and cron jobs, and cancelling runs. |
| `admin` | `/deployments` and `/replicas`. Defaults to a scope named `admin` whenever `authenticate` is set. |

`tenants` enforces per-tenant limits on active runs, rate, and budget. Its contract is `TenantGate`,
and `tenantLimits()` builds one. See the [deployments guide](./deployments.md#tenants).

Every thread, run, and cron job records its tenant, and a request only ever sees its own tenant's
resources. Another tenant's thread is a `404`, not a `403`, so the server does not even confirm it
exists.

Errors extend `ServerError` and have a stable code: `BadRequestError`, `UnauthorizedError`,
`ForbiddenError`, `NotFoundError`, `ThreadBusyError`, `AssistantCapabilityError`, and
`TenantLimitError`. An error with a `retryAfterSeconds` is answered with a `Retry-After` header.

## Where state lives

Threads, runs, and cron jobs are records in a `ServerStateStore`. A `ThreadRecord` is a conversation:
its assistant, tenant, creator, creation and last-run times, the run in flight, and the metadata it
was created with. `MemoryServerStore` is the default;
`fromStore()` puts them in any long-term store — `MemoryStore`, `RedisStore`, `PostgresStore`, or
`SqliteStore` —
which is what lets a second replica see the first replica's threads. `StoreLike` is the slice of the
store contract it uses. Point the operation store at the same backend and the server is stateless:

```ts
import { createAgentServer, fromStore, RedisRunEventLog } from 'nexus-ai-pro/server';
import { RedisStore } from 'nexus-ai-pro/store/redis';
import { RedisOperationStore } from 'nexus-ai-pro/operations/adapters';

const server = createAgentServer({
  assistants,
  state: fromStore(new RedisStore(redis)),
  events: new RedisRunEventLog(redis),
  operations: { store: new RedisOperationStore(redis), retry: { maxAttempts: 2 } },
  cron: { tickMs: 30_000 },
});
```

## Serving it

`toNodeListener()` adapts the server to Node's `http`, and to anything that uses its request and
response objects. Express and Fastify take it as middleware, and a Nest controller can call it from a
route handler. Streaming responses are passed through unbuffered, which keeps an event stream live.

`NodeListenerOptions` sets the origin used to build request URLs, and an error hook. `NodeRequestLike`
and `NodeResponseLike` are the structural slices it needs.

```ts
import express from 'express';
const app = express();
app.use('/agents', toNodeListener(server, { origin: 'https://agents.example.com' }));
```

The repository's `deploy/` folder has a server configured from the environment, and everything to
run it. `deploy/app` is one image that runs as an API, a worker, or both, shared through Redis.
`deploy/compose.yaml` runs API replicas, a worker pool, Redis, and an nginx gateway that leaves event
streams unbuffered. `deploy/kubernetes` and `deploy/helm` run the same on Kubernetes, with the worker
pool autoscaled on the queue. The [deployments guide](./deployments.md#kubernetes-and-helm) explains
them.

`ServerDeployments` is the contract the server needs from a deployments registry. `Deployments` from
`nexus-ai-pro/server/deployments` implements it.

## Calling a server

`createRemoteGraph()`, from `nexus-ai-pro/server/remote`, is the client; it returns a `RemoteGraph`,
whose `invoke()` and `stream()` mirror a compiled graph's. `invoke()` runs to
completion, `stream()` yields events and reconnects from the last one it saw, `resume()` answers an
interrupt, and `createThread()`, `state()`, and `cancel()` cover the rest. `RemoteGraphOptions`
configures the URL, assistant, headers, and timeouts; `RemoteRunResult` is what a run returns.

`asNode()` makes a deployed assistant a node in a local graph, so an orchestrating graph can call a
remote one as a subgraph without knowing it is remote:

```ts
const remote = createRemoteGraph({ url: 'https://agents.internal', assistant: 'research' });
const graph = createGraph({ channels })
  .addNode('research', remote.asNode())
  .addNode('write', writeNode)
  .setEntry('research')
  .addEdge('research', 'write');
```

## Limitations

- The family is experimental: it is new, and the shape of the HTTP surface may still gain routes.
- Recovery repeats the step a run died in — for graphs and workflows — or the whole run, for any
  other assistant. The repeated part should be idempotent — the run id makes a good key — or the run
  should be left at one attempt.
- The `enqueue` busy policy waits in the request that is queued, so a queued run holds a connection.
  The worker `queue` does not: a run waiting for a worker holds nothing.
- Cron resolution is one minute, and schedules are UTC.
- Authentication is a hook, not an implementation: there is no bundled token format, user store, or
  session handling.

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/server`

| Export | Kind | Summary |
| --- | --- | --- |
| `AgentServer` | interface | The server: one handler, with the pieces behind it available for tests and custom routes. |
| `AgentServerOptions` | interface | Options for `createAgentServer()`. |
| `AssistantCapabilityError` | class | Raised when an assistant cannot do what a request needs, such as resuming or rolling back. |
| `AssistantRunContext` | interface | What an assistant receives when the server runs it. |
| `BadRequestError` | class | Raised when a request is malformed: bad JSON, a missing field, or an unknown assistant. |
| `createAgentServer` | function | A self-hosted agent server: assistants, threads, runs, cron jobs, and resumable event streams. |
| `CronRecord` | interface | A scheduled run of an assistant. |
| `CronScheduler` | class | Fires scheduled runs. |
| `CronSchedulerOptions` | interface | Options for the cron scheduler. |
| `DrainResult` | interface | What `drain()` did with the runs this replica was executing. |
| `DueCronJob` | interface | A cron job that is due, with the slot it is due for. |
| `ForbiddenError` | class | Raised when a principal is known but not allowed to do this. |
| `fromStore` | function | Server state on top of a long-term store, so threads and runs live wherever memory already does. |
| `functionAssistant` | function | Serves a plain function as an assistant, for work that is not a graph. |
| `graphAssistant` | function | Serves a compiled graph as an assistant. |
| `GraphAssistantOptions` | interface | Options for `graphAssistant()`. |
| `GraphLike` | interface | The part of a compiled graph the adapter uses. |
| `MemoryRunEventLog` | class | Run events in process memory, with waiters woken as events arrive. |
| `MemoryRunEventLogOptions` | interface | Options for the in-memory run event log. |
| `MemoryServerStore` | class | Threads, runs, and cron jobs in process memory. |
| `NodeListenerOptions` | interface | Options for the Node adapter. |
| `NodeRequestLike` | interface | The part of Node's `IncomingMessage` the adapter reads. |
| `NodeResponseLike` | interface | The part of Node's `ServerResponse` the adapter writes. |
| `NotFoundError` | class | Raised when a request names something that does not exist, or belongs to another tenant. |
| `parseCron` | function | Parses the five-field cron syntax: `*`, numbers, `a-b` ranges, `a,b` lists, and `*​/n` steps. |
| `Principal` | interface | Who a request, a run, or a tool call is for. |
| `RedisEventLogLikeClient` | interface | The Redis commands the event log needs, in `ioredis` argument order. |
| `RedisRunEventLog` | class | Run events in Redis, so a client can reconnect to any replica and resume. |
| `RedisRunEventLogOptions` | interface | Options for the Redis run event log. |
| `RunEvent` | interface | One event of a run, as the event log stores it and the event stream sends it. |
| `RunEventLog` | interface | Where run events are kept so a disconnected client can catch up. |
| `RunHandOffError` | class | Thrown by an assistant to hand its run to another worker while this replica drains: the server puts the run back on the queue as its next attempt instead of failing it. |
| `RunManager` | class | Runs assistants, records threads and runs, and keeps the event log a client streams from. |
| `RunManagerOptions` | interface | Options for the run manager. |
| `RunQueueOptions` | interface | Runs in a queue that any replica's workers claim, instead of on the replica that accepted them. |
| `RunRecord` | interface | A run of an assistant, whether or not it belongs to a thread. |
| `RunStatus` | type | Where a run stands, as the server reports it. |
| `ScalingSnapshot` | interface | The numbers an autoscaler reads, from `GET /scaling`. |
| `ServerAssistant` | interface | Anything the server can run: a compiled graph, an agent, or a function. |
| `ServerDeployments` | interface | What the server needs from a deployments registry: its routes read and change deployments, and `start()` hands it a report of this replica to heartbeat. |
| `ServerError` | class | Base class for server errors. |
| `ServerStateStore` | interface | Where threads and runs are recorded. |
| `StartRunOptions` | interface | What a run needs to start. |
| `StoreLike` | interface | The part of a long-term `Store` the server state adapter uses. |
| `ThreadBusyError` | class | Raised when a thread is already running something and the busy policy is `reject`. |
| `ThreadBusyPolicy` | type | What happens when a run is requested for a thread that is already running one. |
| `ThreadRecord` | interface | A conversation, and the state an assistant keeps for it. |
| `toNodeListener` | function | Adapts the server to Node's `http`, and to anything that speaks its request and response objects. |
| `UnauthorizedError` | class | Raised when a request carries no usable credentials. |

### `nexus-ai-pro/server/auth`

| Export | Kind | Summary |
| --- | --- | --- |
| `anyAuth` | function | Tries hooks in order and takes the first principal: tokens for people and keys for services on one server. |
| `apiKeyAuth` | function | Authenticates requests by an API key, for services and scripts rather than people. |
| `ApiKeyAuthOptions` | interface | Options for `apiKeyAuth()`. |
| `AuthHook` | type | The `authenticate` hook of `createAgentServer()`. |
| `createJwtVerifier` | function | Builds a verifier for tokens from one issuer. |
| `hashApiKey` | function | The SHA-256 of an API key, as hex: what `apiKeyAuth({ keys })` is configured with. |
| `JwtAlgorithm` | type | The signature algorithms a token may use. |
| `jwtAuth` | function | Authenticates requests by a JSON Web Token: an identity provider's, through its key set, or your own, signed with a shared secret. |
| `JwtAuthOptions` | interface | Options for `jwtAuth()`. |
| `JwtClaimNames` | interface | Which claims a principal is read from. |
| `JwtError` | class | Thrown when a token is refused: malformed, signed wrongly, expired, or for someone else. |
| `JwtErrorCode` | type | Why a token was refused. |
| `JwtHeader` | interface | A token's header. |
| `JwtPayload` | interface | A token's claims, the registered ones typed. |
| `JwtVerifier` | interface | A reusable verifier: it keeps imported keys and the fetched key set between tokens. |
| `JwtVerifyOptions` | interface | Options for `createJwtVerifier()`. |
| `trustedProxyAuth` | function | Takes the caller from headers an authenticating proxy sets: an identity-aware proxy, an API gateway, a service mesh. |
| `TrustedProxyAuthOptions` | interface | Options for `trustedProxyAuth()`. |
| `TrustedProxyHeaders` | interface | The headers a proxy names the caller in. |
| `VerifiedJwt` | interface | A verified token. |

### `nexus-ai-pro/server/remote`

| Export | Kind | Summary |
| --- | --- | --- |
| `createRemoteGraph` | function | Creates a client for an assistant on a remote agent server. |
| `RemoteGraph` | interface | A graph running on another server, usable as a subgraph. |
| `RemoteGraphOptions` | interface | Options for `createRemoteGraph()`. |
| `RemoteRunResult` | interface | A run on a remote server, as the client reports it. |
<!-- reference:end -->
