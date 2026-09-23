# The agent server (experimental)

<!-- covers: ./server ./server/remote -->

A self-hosted HTTP server for your assistants: threads, background runs, resumable event streams, and
cron jobs, from `nexus-ai-pro/server`. It is a thin layer over parts that already exist — a run is a
durable operation, a thread is a graph thread — so what it adds is the HTTP surface and the rules
around a thread that is already busy. `nexus-ai-pro/server/remote` is the client, so calling a
deployed agent never loads the server.

## A server in fifteen lines

```ts
import { createServer } from 'node:http';
import { createAgentServer, graphAssistant, toNodeListener } from 'nexus-ai-pro/server';

const server = createAgentServer({
  assistants: { support: graphAssistant(supportGraph, { description: 'Answers support questions' }) },
  authenticate: (request) => verifyToken(request.headers.get('authorization')),
  onBusy: 'enqueue',
});

await server.start();
createServer(toNodeListener(server)).listen(8080);
```

`createAgentServer()` returns an `AgentServer`: `handle(request)` answers one `Request`, and `runs`
and `cron` expose the pieces behind it. `start()` re-claims runs abandoned by a crashed worker and
starts the scheduler; `stop()` stops the scheduler and leaves runs in flight to finish.

## The HTTP surface

| Route | What it does |
| --- | --- |
| `GET /health` | Readiness, and which worker answered |
| `GET /assistants`, `GET /assistants/:id` | What this server serves, and what each one supports |
| `POST /threads`, `GET /threads`, `GET /threads/:id`, `DELETE /threads/:id` | Conversations |
| `GET /threads/:id/state` | The assistant's state for a thread |
| `POST /threads/:id/runs` | Run on a thread; `{ "resume": … }` answers an interrupt |
| `GET /threads/:id/runs` | That thread's runs |
| `POST /runs`, `GET /runs`, `GET /runs/:id` | Stateless runs |
| `POST /runs/:id/cancel` | Cancel, including a run another replica is executing |
| `GET /runs/:id/events` | The event stream, resumable with `Last-Event-ID` |
| `POST /crons`, `GET /crons`, `DELETE /crons/:id` | Scheduled runs |

Mount them under a prefix with `basePath`. A run is accepted with `202` and a `RunRecord`; add
`"stream": true` (or `?stream=true`) to start it and stream it in one request instead.

## Assistants

An assistant is anything that streams events for an input — the `ServerAssistant` contract, whose only
required member is `stream`. `graphAssistant()` serves a compiled graph, mapping threads to graph
threads so state, interrupts, and history are the graph's own; `GraphLike` is the structural slice it
needs, so the server entry point never imports the graph runtime. `functionAssistant()` serves a plain
function, which may return a value or yield events. Optional members are what a thread needs:
`resume` to answer an interrupt, `state` to report it, and `step` with `restore` for the rollback
policy. `AssistantRunContext` is what an assistant receives: the run id, the thread, an abort signal,
the principal, and the run's metadata.

## Runs are durable operations

`RunManager` submits every run through the operation runner, so leases, heartbeats, retries,
idempotency, dead-lettering, and webhooks are the operations family's, not the server's. It is
available as `server.runs` and usable on its own — `StartRunOptions` and `RunManagerOptions` configure
it, and `RunRecord` and `RunStatus` are what it reports.

- **Crash recovery.** A worker that dies leaves a record whose lease lapses. Another replica's
  `start()`, or `runs.recover()`, claims it and runs it again. Recovery re-runs an attempt, so allow
  more than one: `operations: { retry: { maxAttempts: 2 } }`. Leave it at one when a re-run would
  duplicate side effects.
- **Idempotency.** `idempotencyKey` on a run replays the existing run instead of starting a second,
  which is what makes a retried request safe.
- **Cancellation.** `POST /runs/:id/cancel` aborts a local run at once and is observed by another
  replica through its heartbeat. A cancelled run stays cancelled even if its executor finishes later.
- **Timeouts.** `runTimeoutMs` expires a run that runs too long.

## A busy thread

One thread runs one thing at a time. `onBusy`, set per server or per run, decides what a second
request does, as `ThreadBusyPolicy`:

| Policy | Behaviour |
| --- | --- |
| `reject` | `409` with `THREAD_BUSY`. The default. |
| `enqueue` | Waits for the run in flight, up to `queueTimeoutMs`, then runs. |
| `interrupt` | Cancels the run in flight and starts the new one. |
| `rollback` | Cancels it, puts the thread back to the step it was at before, and starts the new one. |

`rollback` needs an assistant with `restore`; `graphAssistant()` provides it by writing the earlier
checkpoint's state forward, so the history stays intact. An assistant without it is refused with
`AssistantCapabilityError` rather than silently doing something else.

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

`authenticate` turns a request into a `Principal`: a tenant, a user, and scopes. Returning nothing
refuses the request as unauthenticated; returning a `Response` answers it directly, which is how a
challenge or a redirect is returned. `allowAnonymous: false` refuses everything when no hook is
configured, and `scopes` names the scope a read or a write route requires.

Every thread, run, and cron job records its tenant, and a request only ever sees its own tenant's
resources — another tenant's thread is a `404`, not a `403`, so the server does not confirm that it
exists. Errors share `ServerError` and a stable code: `BadRequestError`, `UnauthorizedError`,
`ForbiddenError`, `NotFoundError`, `ThreadBusyError`, and `AssistantCapabilityError`.

## Where state lives

Threads, runs, and cron jobs are records in a `ServerStateStore`. `MemoryServerStore` is the default;
`fromStore()` puts them in any long-term store — `MemoryStore`, `RedisStore`, or `PostgresStore` —
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

`toNodeListener()` adapts the server to Node's `http`, and to anything that speaks its request and
response objects: Express and Fastify take it as middleware, and a Nest controller can call it from a
route handler. `NodeListenerOptions` sets the origin used to build request URLs and an error hook;
`NodeRequestLike` and `NodeResponseLike` are the structural slices it needs. Streaming responses are
piped through unbuffered, which is what keeps an event stream live.

```ts
import express from 'express';
const app = express();
app.use('/agents', toNodeListener(server, { origin: 'https://agents.example.com' }));
```

`deploy/Dockerfile` and `deploy/compose.yaml` in the repository run two replicas behind Redis and an
nginx gateway configured not to buffer event streams, which is the deployment the durability claims
above are about.

## Calling a server

`createRemoteGraph()`, from `nexus-ai-pro/server/remote`, is the client. `invoke()` runs to
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
- Recovery re-runs a whole run, not the step it died on. An assistant with side effects should be
  idempotent, or be left at one attempt.
- The `enqueue` policy waits in the request that is queued, so a queued run holds a connection.
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
| `Principal` | interface | Who is making a request, as the server's authentication hook reports them. |
| `RedisEventLogLikeClient` | interface | The Redis commands the event log needs, in `ioredis` argument order. |
| `RedisRunEventLog` | class | Run events in Redis, so a client can reconnect to any replica and resume. |
| `RedisRunEventLogOptions` | interface | Options for the Redis run event log. |
| `RunEvent` | interface | One event of a run, as the event log stores it and the event stream sends it. |
| `RunEventLog` | interface | Where run events are kept so a disconnected client can catch up. |
| `RunManager` | class | Runs assistants, records threads and runs, and keeps the event log a client streams from. |
| `RunManagerOptions` | interface | Options for the run manager. |
| `RunRecord` | interface | A run of an assistant, whether or not it belongs to a thread. |
| `RunStatus` | type | Where a run stands, as the server reports it. |
| `ServerAssistant` | interface | Anything the server can run: a compiled graph, an agent, or a function. |
| `ServerError` | class | Base class for server errors. |
| `ServerStateStore` | interface | Where threads and runs are recorded. |
| `StartRunOptions` | interface | What a run needs to start. |
| `StoreLike` | interface | The part of a long-term `Store` the server state adapter uses. |
| `ThreadBusyError` | class | Raised when a thread is already running something and the busy policy is `reject`. |
| `ThreadBusyPolicy` | type | What happens when a run is requested for a thread that is already running one. |
| `ThreadRecord` | interface | A conversation, and the state an assistant keeps for it. |
| `toNodeListener` | function | Adapts the server to Node's `http`, and to anything that speaks its request and response objects. |
| `UnauthorizedError` | class | Raised when a request carries no usable credentials. |

### `nexus-ai-pro/server/remote`

| Export | Kind | Summary |
| --- | --- | --- |
| `createRemoteGraph` | function | Creates a client for an assistant on a remote agent server. |
| `RemoteGraph` | interface | A graph running on another server, usable as a subgraph. |
| `RemoteGraphOptions` | interface | Options for `createRemoteGraph()`. |
| `RemoteRunResult` | interface | A run on a remote server, as the client reports it. |
<!-- reference:end -->
