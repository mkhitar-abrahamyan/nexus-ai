# Deployments: revisions, canaries, scaling, and tenants

<!-- covers: ./server/deployments ./server/tenancy -->

Run the agent server as a service you operate yourself. This guide covers four things:

- **Revisions.** Ship several versions of an assistant in one image. Move traffic between them without a
  redeploy.
- **Canaries.** Send a share of traffic to a new revision. A guard rolls it back when it regresses.
- **Scaling.** Workers claim runs from a shared queue. An autoscaler sizes the pool from the queue.
- **Tenants.** The server holds each tenant to its active runs, its rate, and its budget.

Everything here builds on the [agent server](./server.md). The Kubernetes manifests, Helm chart, and
Compose file are in the repository's `deploy/` folder.

```ts
import { createAgentServer, graphAssistant } from 'nexus-ai-pro/server';
import { Deployments, watchCanaries } from 'nexus-ai-pro/server/deployments';
import { tenantLimits } from 'nexus-ai-pro/server/tenancy';

const deployments = new Deployments({ state });
const server = createAgentServer({
  assistants: {
    support: deployments.assistant('support', {
      '2026-09-01': graphAssistant(supportV1),
      '2026-09-30': graphAssistant(supportV2),
    }),
  },
  deployments,
  tenants: tenantLimits({ default: { maxActiveRuns: 10, budget: { usd: 50, period: 'day' } } }),
  queue: { concurrency: 4 },
  state,
  events,
  operations: { store: operationStore },
});
await server.start();

await deployments.canary('support', '2026-09-30', 0.1); // a tenth of new traffic
watchCanaries({ deployments, steps: [0.25, 0.5] }); // rolls back or promotes on its own
```

## Revisions

A revision is one version of an assistant's code. `Deployments.assistant()` takes the revisions by id
and returns an assistant, which goes into `createAgentServer()` like any other. The server asks it
which revision should serve each run.

```ts
const support = deployments.assistant(
  'support',
  { '2026-09-01': graphAssistant(v1), '2026-09-30': graphAssistant(v2) },
  { live: '2026-09-01', description: 'Answers support questions' },
);
```

`RevisionedAssistantOptions` has two fields:

| Field | What it does |
| --- | --- |
| `live` | The revision that takes all traffic until a deployment is recorded. Defaults to the last one declared. |
| `description` | What the assistant is, for the assistants endpoint. |

Once a deployment is recorded, the stored record decides, not the code. So a new revision in a new image
takes no traffic until you give it some. The server records each assistant's default when it starts.

### How a run gets its revision

The server calls the assistant's `route()` with a `RevisionRequest`: the run, its thread, the thread's
last revision, and any revision the request named. The answer is a `RevisionChoice`, which is a
`RunRevision` plus the revision's code. `RevisionReason` says why it was chosen:

| Reason | When |
| --- | --- |
| `requested` | The request named a revision, as `"revision": "2026-09-30"` in the run body. |
| `thread` | The run is on a thread whose revision still takes traffic, so the thread stays put. |
| `split` | Everything else: the traffic split chose, by a stable hash of the thread or run id. |

`bucket()` is that hash. It maps a key to a fixed place between 0 and 1. Canaries take the start of the
range and the live revision the rest. So raising a canary's share only adds threads to it, and a
thread never flips back and forth.

Every run records its `RunRevision`: the revision, its share, the deployment version, and the reason.
The thread records its revision too, which is how a rolled-back canary sends its threads home.

### Changing the split

Every change is a `DeploymentChange`, applied by `change()` or one of its shortcuts:

| Method | What it does |
| --- | --- |
| `canary(assistant, revision, weight)` | Gives one revision a share, from 0 to 1, and the live revision the rest. |
| `split(assistant, traffic)` | Sets several shares at once. They add up to at most 1; the live revision takes the rest. |
| `promote(assistant, revision)` | Makes a revision live, with all the traffic. |
| `rollback(assistant, options)` | Pulls a canary. With no canary, undoes the last promotion. `to` names a revision instead. |

Each shortcut takes `by` and `reason`, recorded in the history. `change()` also takes
`expectedVersion`. It refuses the change with `DEPLOYMENT_CONFLICT` when someone moved the deployment
first, so two people cannot undo each other without noticing.

Changes are atomic across replicas when the state store has `putIfVersion()`. The memory, Redis,
Postgres, and SQLite stores have it, and `fromStore()` passes it on. A change is then written only if
the version it was decided on is still the stored one. A replica that loses the race decides again
on what the winner wrote, so a guard rolling a canary back and an operator promoting at the same
moment both land, in order. A change made on an `expectedVersion` is refused instead.
`Deployments.atomicChanges` and the `atomicChanges` field of `/scaling` say whether a deployment has
this. Without it, changes on one replica still apply in order, but two replicas can lose one.

```ts
await deployments.canary('support', '2026-09-30', 0.1, { by: 'ada', reason: 'new retrieval' });
await deployments.change('support', { action: 'promote', revision: '2026-09-30', expectedVersion: 1 });
await deployments.rollback('support', { reason: 'answers got longer' });
```

A `DeploymentRecord` is what gets stored: the live revision, the shares, the version, when a canary
began, and the last 50 changes. Each change is a `DeploymentChangeRecord`. `get()` reads one record,
`list()` reads them all, and `history()` reads one record's changes.

### Reading what each revision did

`stats()` summarizes each revision's runs from the server's own run records. Each `RevisionStats` has
the run count, successes, failures, error rate, p50 and p95 latency, and mean cost. Pass `since` to
limit it to a window, such as the time of the last change.

`samples()` returns one revision's finished runs in the shape `compareRuns()` from
`nexus-ai-pro/insights` reads. `revisions()` lists the revisions known for an assistant: the ones
registered in this process, and the ones fresh replicas report.

### `DeploymentsOptions`

| Option | Default | What it does |
| --- | --- | --- |
| `state` | memory | Where deployments and heartbeats live. Use the server's state store, so every replica shares them. |
| `heartbeatMs` | 10 s | How often a replica reports itself. |
| `replicaTtlMs` | 3 heartbeats | How long a report counts as fresh. |
| `cacheMs` | 2 s | How long routing reuses a read. A change elsewhere reaches every replica within this time. |
| `historyLimit` | 50 | Changes kept per deployment. |
| `onError` | — | Hears heartbeat failures, which never stop the server. |
| `now` | the clock | Replaces the clock, for tests. |

The same object works without any assistants. Build it on the same store in a studio or a script, and
it reads and changes what the servers record.

## Canary guard

`watchCanaries()` judges every canary on a timer and acts on the result. It returns a `CanaryGuard`
with `check()`, which judges now, and `stop()`.

```ts
const guard = watchCanaries({
  deployments,
  minRuns: 50,
  steps: [0.25, 0.5],
  onDecision: (decision) => console.log(decision.action, decision.assistant, decision.regressions),
});
```

Each check compares a canary with the live revision over the same window: the runs since the split
last changed. It uses the same statistics as the insights' regression detection:

- an error rate counts when its rise passes a two-proportion z-test at 95%;
- p95 latency, and mean cost if you ask for it, count when they rise by a relative margin, a quarter by
  default. A latency rise must also be at least 50 ms.

A regressed canary is rolled back at once. The reason in the history names what got worse. A canary
that holds up moves to its next step, and is promoted after the last one. Without `steps`, it stays
where it is until a person promotes it.

### Judging with confidence, and on quality

Raw rates mislead in both directions. A few unlucky runs can roll back a good canary, and with enough
traffic a trivially small change still clears a significance test. `confidence` judges every metric
the way an evaluation comparison judges a score. Each metric is resampled by bootstrap, and it
regresses only when both of these hold:
- its interval at that confidence does not reach zero;
- the change is at least the metric's minimum effect.

| Metric | Minimum effect |
| --- | --- |
| error rate | `minErrorRateIncrease`, 0.02: two points |
| p95 latency | `latencyIncrease`, a quarter, and at least `minLatencyChangeMs` |
| mean cost | `costIncrease`, a quarter |
| a feedback score | `minFeedbackDrop`, 0.05 |

`resamples` sets the bootstrap's size, 1,000 by default. The resampling is seeded, so the same runs
always get the same verdict, and the rollback reason quotes the interval.

Quality comes from online evaluation. `Deployments.evaluate()` scores each finished run of an
assistant with evaluators from `nexus-ai-pro/evaluate`, such as an LLM judge, and records the scores
as the run's feedback. Name those keys in `feedback`, and a canary that answers worse is rolled back
like one that fails more. A person can leave feedback on a run too, through
`POST /runs/:runId/feedback`.

```ts
// Every few minutes: score new runs, then judge the canary on quality as well as errors and speed.
await deployments.evaluate('support', { evaluators: [helpfulnessJudge], sampleRate: 0.2 });
watchCanaries({ deployments, confidence: 0.95, minRuns: 50, feedback: ['helpfulness'] });
```

`RunEvaluationOptions` sets:
- the `evaluators`;
- `since`, the start of a canary for instance;
- one `revision`;
- a `sampleRate`, chosen by run id so every replica scores the same runs;
- how many runs are read (`limit`);
- the `source` the scores are recorded under. A run already scored by that source is skipped.

`RunEvaluationReport` counts the runs scored and skipped, and lists every score. Evaluators judge a run
by its output, since a run record does not keep its input.

`CanaryGuardOptions`:

| Option | Default | What it does |
| --- | --- | --- |
| `deployments` | — | The registry to watch, and where runs are read. |
| `assistants` | all | Only watch these. |
| `everyMs` | 1 minute | How often to judge. |
| `minRuns` | 20 | Finished runs each side needs before a canary is judged. |
| `metrics` | error rate, latency | What is compared. Add `cost` to compare mean cost. |
| `latencyIncrease`, `costIncrease` | 0.25 | The relative rise that counts. |
| `minLatencyChangeMs` | 50 | The smallest latency rise that counts, so noise on fast runs never rolls a canary back. |
| `steps` | none | Shares to move through while the canary holds up, before promotion. |
| `samples` | run records | Where runs come from, each with its feedback. Give it traced runs to judge on their feedback instead. |
| `feedback` | none | Feedback keys to compare, such as the ones `Deployments.evaluate()` records. |
| `confidence` | none | Judges each metric by a bootstrap interval and a minimum effect, as below. |
| `minErrorRateIncrease`, `minFeedbackDrop`, `resamples` | 0.02, 0.05, 1,000 | The minimum effects and the bootstrap size under `confidence`. |
| `by` | `guard` | Who the history says made the change. |
| `onDecision`, `onError` | — | Hear each decision, and each failure. |

Each `CanaryDecision` names the assistant, the canary, the live revision, the action, the regressions,
the samples on each side, and the canary's share afterwards. The action is `rollback`, `advance`,
`promote`, or `hold`. A hold means a side is still short of `minRuns`, or the canary holds up without
steps.

A guard on every replica is safe. Each change carries the version it was judged on, so the first guard
to act wins and the others find the deployment already moved.

## Queues and autoscaling

By default, a run executes on the replica that accepted it. With `queue`, the server runs a worker pool
instead:

```ts
createAgentServer({ ..., queue: { concurrency: 4 } });                 // accepts and runs
createAgentServer({ ..., queue: { claim: false } });                   // an API replica: accepts only
createAgentServer({ ..., queue: { concurrency: 8, pollMs: 500 } });    // a worker
```

A replica runs at most `concurrency` runs at once. While it has room, it starts a new run itself, so an
idle deployment adds no latency. The rest wait in the operation store, and the next free worker claims
them. Each claim is a compare-and-set, so no run executes twice. A worker also takes over runs whose
worker stopped, every 30 seconds by default.

### What the autoscaler reads

`GET /scaling` returns the numbers as JSON, and `GET /metrics` returns them as Prometheus text:

| JSON field | Metric | Meaning |
| --- | --- | --- |
| `queued` | `nexus_server_runs_queued` | Runs waiting for a worker. |
| `running` | `nexus_server_runs_running` | Runs executing or retrying. |
| `load` | `nexus_server_queue_load` | Queued plus running: what to size the pool by. |
| `oldestQueuedSeconds` | `nexus_server_queue_oldest_seconds` | How long the oldest queued run has waited. |
| `lapsedLeases` | `nexus_server_leases_lapsed` | Runs a stopped worker left, until another takes them over. |
| `replica` | `nexus_server_worker_*` | The answering replica: its runs, capacity, and whether it is draining. |

Size the pool as `load` divided by each worker's `concurrency`. The deployment-wide numbers read the
same on every replica, so aggregate them with `max()` in PromQL, never `sum()`.

The metrics also count runs per revision and status, run duration, queue wait, hand-offs, and tenant
refusals. Pass `metrics: { public: true }` to answer both routes without credentials, for a scraper
inside the cluster. Keep them off the public ingress then.

### Draining

On `SIGTERM`, call `drain()` and then `stop()`:

```ts
process.on('SIGTERM', async () => {
  await server.drain({ timeoutMs: 25_000 });
  await server.stop();
  process.exit(0);
});
```

A draining replica answers `/health` with `503`, so the load balancer stops sending to it. It stops
claiming, and new runs it accepts go to the queue. Runs in flight get `timeoutMs` to finish. Any still
running are handed back to the queue, and another worker continues them from their last checkpoint.
The hand-off does not count against the retry budget. `drain()` resolves to the runs that finished and
the runs it handed off.

### Kubernetes and Helm

The repository's `deploy/` folder has everything to run it:

| Path | What it is |
| --- | --- |
| `deploy/app` | The server: one image, run as `ROLE=api`, `worker`, or `all`, configured from the environment. |
| `deploy/kubernetes` | An API Deployment, a worker Deployment, a KEDA `ScaledObject`, an HPA alternative, and a demo Redis. |
| `deploy/helm/agent-server` | The same as a Helm chart, with autoscaling by KEDA, HPA, or neither. |
| `deploy/compose.yaml` | Two API replicas, a worker pool, Redis, and an nginx gateway. |

KEDA reads `/scaling` directly, so it needs no Prometheus. Readiness probes use `/health`, which answers
`503` while draining. Liveness probes use a TCP check, so a draining pod is never restarted for it.
Set the worker's `terminationGracePeriodSeconds` longer than its drain timeout.

## Tenants

`tenantLimits()` holds each tenant to its limits. Give the result to `createAgentServer({ tenants })`.

```ts
import { RedisTenantUsage, tenantLimits } from 'nexus-ai-pro/server/tenancy';
import { RedisRateLimitStore } from 'nexus-ai-pro/ops/rate-limit-adapters';

const tenants = tenantLimits({
  default: { maxActiveRuns: 5, rate: { runs: 60, windowMs: 60_000 } },
  tenants: { acme: { maxActiveRuns: 50, budget: { usd: 200, period: 'month', stopRuns: true } } },
  usage: new RedisTenantUsage(redis),
  rates: new RedisRateLimitStore(redis),
});
```

`TenantLimits` has three limits, each optional:

| Limit | What it does |
| --- | --- |
| `maxActiveRuns` | Runs the tenant may have accepted and unfinished at once, queued ones included. |
| `rate` | Runs the tenant may start per window. |
| `budget` | US dollars per period. `stopRuns` also cancels runs in flight once it is spent. |

A `BudgetPeriod` is `hour`, `day`, `week`, or `month` in UTC, or `{ windowMs }`. Weeks start on
Monday. Spending comes from what runs record through `recordCost()` on their `AssistantRunContext`.

### What happens when a run arrives

The server calls the gate when it accepts a run. The gate checks three things in order:

1. The budget. A spent budget refuses the run until the period resets.
2. The rate window. It counts the run, and refuses it past the limit.
3. An active slot. It takes one, and refuses the run when all are taken.

A refusal is a `TenantLimitError`: a `429` with the code `TENANT_BUDGET`, `TENANT_RATE_LIMITED`, or
`TENANT_CONCURRENCY`. `TenantLimit` names which limit refused. `Retry-After` says how long to wait when
that is known. The slot is freed when the run ends, on whichever worker ran it.

`TenantGate` is the contract the server calls: `admit()`, `release()`, `spend()`, and `usage()`.
`tenantLimits()` returns a `TenantLimiter`, which adds `report()` for several tenants at once.

### `TenantLimitsOptions`

| Option | Default | What it does |
| --- | --- | --- |
| `default` | none | Limits for tenants without their own, and for requests without a tenant. |
| `tenants` | none | Limits per tenant id, or a function that looks them up. It runs once per admitted run. |
| `usage` | memory | Where active runs and spending are counted. |
| `rates` | memory | Where rate windows are counted, as a `RateLimitStore`. |
| `slotTtlMs` | 1 hour | How long a slot lasts if its release never comes. Set it above the longest run. |
| `now` | the clock | Replaces the clock, for tests. |

### Where usage is counted

A `TenantUsageStore` has five operations: take a slot, free it, count slots, add to a total, and read a
total. Two are included:

- `MemoryTenantUsage` counts in the process. It suits one replica.
- `RedisTenantUsage` shares the counts across replicas. Each operation is one atomic script, so two
  replicas can never both take a tenant's last slot. It needs only `eval`, the
  `RedisTenantUsageLikeClient`; `RedisTenantUsageOptions` sets the key prefix.
- `PostgresTenantUsage`, from `nexus-ai-pro/postgres/tenancy`, shares them through Postgres, for a
  deployment that runs Postgres and not Redis. The [Postgres guide](./postgres.md#tenant-usage)
  covers it.

`GET /usage` returns the caller's `TenantUsage`: its limits, active runs, and spending this period.

## Replicas

When the server has `deployments`, each replica heartbeats a `ReplicaReport`. The report has its id,
start time, runs in flight, capacity, whether it claims and whether it is draining, the revisions it
has, and any `replicaMetadata` you add, such as the host. `replicas()` returns the fresh ones.

## The HTTP routes

| Route | Scope | What it does |
| --- | --- | --- |
| `GET /deployments` | admin | Every deployment. |
| `GET /deployments/:assistant` | admin | One deployment, with each revision's stats since the last change. |
| `POST /deployments/:assistant` | admin | A `DeploymentChange`, with `expectedVersion` if you like. |
| `GET /replicas` | admin | Fresh replica reports. |
| `GET /scaling`, `GET /metrics` | read, or public | The queue and this replica. |
| `GET /usage` | read | The caller's tenant usage. |

The admin scope is `admin` unless `scopes.admin` names another. It applies whenever the server
authenticates callers. The studio's deployments view and `nexus deploy` use these routes. So does a
pipeline that rolls out an image and then moves traffic onto it:

```bash
nexus deploy canary support 2026-09-30 10 --url https://agents.internal --reason "build 412"
nexus deploy status support --url https://agents.internal
nexus deploy promote support 2026-09-30 --url https://agents.internal
```

## Limitations

- Revisions and canaries are experimental. With a state store that has no `putIfVersion()`, two
  replicas changing one deployment in the same instant can lose one change: give the server one of
  the included stores, or pass `expectedVersion` and retry a conflict. Tenant limits and the worker
  queue are stable.
- `bucket()` places random thread ids, which the server gives by default, evenly. Ids that differ
  only in their last characters, such as `user-1` to `user-500`, spread unevenly over a few hundred
  threads, so a canary's share of them drifts from its weight. Its output is part of the stability
  promise, so threads keep their place through an upgrade.
- A revision's code must be in every replica's image. A replica serves only the revisions it has, so
  roll out an image before you give its new revision traffic.
- `stats()` and the guard read recent run records, 2,000 by default, so a very busy assistant is judged
  on its latest runs.
- The Redis operation store reads every record to find queued work. Postgres and SQLite do it in one
  indexed query, so prefer them for large queues.
