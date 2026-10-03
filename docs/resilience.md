# Resilience and observability

<!-- covers: ./ops ./ops/circuit-breaker ./ops/circuit-store ./ops/rate-limit-adapters -->
<!-- sources: src/ops -->

Staying up when providers do not: health-aware routing, a circuit breaker whose state can be shared across workers through `nexus-ai-pro/ops/circuit-store`, rate limits that hold across processes through `nexus-ai-pro/ops/rate-limit-adapters`, and the metrics, traces, audit log, and logger that show what happened.

## Resilience: Circuit Breaking and Distributed Limits

Health monitoring ranks a struggling provider lower. A circuit breaker is the stronger step: while a
circuit is open the provider is removed from routing entirely, so a hard-down provider stops
absorbing one failed attempt per request.

```ts
const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! }, anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! } },
  health: { enabled: true },
  circuitBreaker: {
    enabled: true,
    failureThreshold: 5,        // consecutive failures that open the circuit
    failureRateThreshold: 0.5,  // or half the calls failing in the window
    minimumThroughput: 10,
    resetTimeoutMs: 30_000,     // cooldown before a probe
    halfOpenMaxCalls: 1,
    onStateChange: (event) => logger.warn('circuit', event),
  },
});

ai.getCircuitBreakerStatus();   // state, failure rate, retryAt per provider
ai.resetCircuitBreaker('openai');
```

Two independent triggers, because they catch different failures. A consecutive count catches a
provider that is hard down. A failure *rate* catches one that fails half its calls without ever
failing several in a row — invisible to a consecutive counter. The rate is only considered once
`minimumThroughput` calls have been seen, since one failure out of two is not evidence of anything.

After the cooldown the circuit goes half-open and admits a limited number of probes. A successful
probe closes it; a failed probe reopens it and restarts the cooldown. If *every* circuit is open the
router routes anyway — that usually means a shared dependency is down, and one attempt beats a
certain failure with no attempt at all.

A request the caller cancelled never counts against the provider. `isFailure` keeps anything else
that is not the provider's fault out of the calculation:

```ts
circuitBreaker: {
  enabled: true,
  isFailure: (error) => !(error instanceof NexusProviderError && error.category === 'bad-response'),
}
```

Probe limits hold on every attempt, retries included: while a probe is in flight, other requests go
to the next provider instead of piling onto one that has only just come back.

**Sharing circuit state across workers.** By default each worker learns on its own. Give the breaker
a store and a provider that fails in one worker is taken out of routing in all of them, and when the
cooldown ends only one worker probes it:

```ts
import { RedisCircuitStateStore } from 'nexus-ai-pro/ops/circuit-store';

const ai = new NexusAI({
  providers,
  circuitBreaker: { enabled: true, store: new RedisCircuitStateStore(redis), workerId: process.env.HOSTNAME },
});
await ai.syncCircuitBreaker(); // optional: learn what is open elsewhere before the first request
```

Only decisions are shared — open, closed, and who may probe. Each worker still counts its own
failures, and every check stays synchronous: shared state is refreshed in the background at most once
a second, so the breaker never puts a network call in front of a request. If the store is
unreachable, each worker decides for itself rather than holding circuits open. `PostgresCircuitStateStore`
does the same in Postgres, and the coordination code loads only when a store is configured.

**Distributed rate limiting.** The built-in limiter is process-local, which multiplies the real
limit by the number of workers. Pointing it at a shared store fixes that, and the same budget then
covers completions and embeddings alike:

```ts
import { RedisRateLimitStore } from 'nexus-ai-pro/ops/rate-limit-adapters';

const ai = new NexusAI({
  providers: { openai: { apiKey: process.env.OPENAI_API_KEY! } },
  rateLimit: {
    enabled: true,
    maxRequests: 100,
    windowMs: 60_000,
    key: 'userId',
    store: new RedisRateLimitStore(redis),
  },
});
```

Prefer a client exposing `eval`: the increment and the expiry then happen in one atomic round trip.
Without it the store falls back to `INCR` plus `PEXPIRE` and re-arms any missing TTL it sees, so a
crash between the two calls cannot block a key forever.

`NexusRateLimitError` carries `resetAt` and `retryAfterSeconds`, so a gateway can answer with a
real `Retry-After` header:

```ts
catch (error) {
  if (error instanceof NexusRateLimitError) {
    response.setHeader('Retry-After', String(error.retryAfterSeconds ?? 60));
  }
}
```

Omitting `store` keeps the original synchronous in-memory path, which costs no extra microtask per
request.

## Observability and Reliability

```ts
const response = await ai.complete({
  model: 'auto',
  messages: [{ role: 'user', content: 'Trace this request.' }],
});

console.log(response.meta.pipeline?.steps);
console.log(ai.getMetricsSnapshot());
console.log(ai.getPrometheusMetrics());
console.log(await ai.checkProviders());
```

Structured logging can be injected without replacing audit logs or metrics:

```ts
const ai = createNexusConfig()
  .openai(process.env.OPENAI_API_KEY!)
  .direct('gpt-5.4-mini')
  .logger({
    console: false,
    sink: (event) => myLogger.info(event),
  })
  .create();
```

Production controls include:

- request timeouts
- provider retries
- health-aware routing
- estimated cost budgets
- pipeline traces
- Prometheus metrics
- OpenTelemetry metrics and trace export helpers
- audit log sink
- structured logger sink

## The circuit breaker in detail

`CircuitBreakerConfig` is the client's `circuitBreaker` option. A circuit moves between three
`CircuitState` values — `closed`, `open`, and `half-open` — and these settings decide when:

| Option | Default | Meaning |
| --- | --- | --- |
| `failureThreshold` | 5 | Consecutive failures that open a circuit. |
| `failureRateThreshold` | — | Or a share of failing calls, over `windowMs`. |
| `windowMs` | 60 s | The rolling window for the failure rate. |
| `minimumThroughput` | 10 | Calls needed in the window before the rate counts. |
| `resetTimeoutMs` | 30 s | How long a circuit stays open. |
| `halfOpenMaxCalls` | 1 | Probe calls allowed while half-open. |
| `successThreshold` | 1 | Probe successes that close it again. |
| `isFailure` | — | Which errors count as failures. |
| `onStateChange` | — | Receives every `CircuitStateChange`: the provider, the states it moved from and to, when, and why. |

For sharing state between workers:

| Option | Default | Meaning |
| --- | --- | --- |
| `store` | — | The shared `CircuitStateStore`. |
| `workerId` | — | This worker's name in the store. |
| `syncIntervalMs` | 1 s | How often shared state is pulled. |
| `probeLeaseMs` | 30 s | How long one worker holds the right to probe. |
| `onStoreError` | — | Receives store failures. |

`now` replaces the clock in tests.

`CircuitBreaker` also works on its own, around any call:

| Method | What it does |
| --- | --- |
| `allowRequest()` | May this call go? |
| `recordSuccess()`, `recordFailure()` | Report how it went. |
| `state()`, `isOpen()`, `openProviders()` | Read the circuits. |
| `snapshot()` | A `CircuitSnapshot` per provider: state, consecutive failures, calls and failures in the window, failure rate, when it opened, when it will probe, and the last error. |
| `reset()` | Closes one circuit, or all of them. |
| `sync()`, `flush()` | With a store: pull shared state, and wait for pending writes before shutting down. |

A `CircuitStateStore` holds only the decisions every worker must agree on. It has three methods:

| Method | What it does |
| --- | --- |
| `read()` | Every `SharedCircuitState`: a provider, `open` or `closed`, when it opened, when and by which worker it was last written, and why. |
| `write()` | Records one provider's state. |
| `claimProbe()` | Lets exactly one worker probe an open circuit, for a lease. |

Two stores are included:

- `MemoryCircuitStateStore` shares state within one process, for tests and for several clients in one
  process.
- `RedisCircuitStateStore` shares it between processes. It takes a `RedisCircuitLikeClient` — `hgetall`,
  `hget`, `hset`, `set` with `PX` and `NX`, `get`, `del`, and optionally `eval`, in `ioredis` argument
  order — and `RedisCircuitStateStoreOptions`: a key `prefix`, and `useEval: false` to skip Lua.

With `eval`, a change is written only when it is newer than the stored one, in one step. Without it, a
stale change can briefly win; it heals after one cooldown.

## Rate limits in detail

`RateLimiter` counts calls keyed per user, per model, or globally as the client's `rateLimit.key`
says, from a `RateLimitedRequest` (the model and user). `check()` counts in memory, synchronously;
`checkAsync()` counts through the configured store. Both throw `NexusRateLimitError` once a bucket
is full, with `resetAt` set to when a call would pass again.

`rateLimit.algorithm` decides how calls are counted:

| Algorithm | Counts | At a window's edge |
| --- | --- | --- |
| `fixed-window` (the default) | Calls per window of `windowMs` | A burst at the end of one window and another at the start of the next pass nearly twice the limit in a moment |
| `gcra` | The token-bucket algorithm, kept as one timestamp per key: `maxRequests` per `windowMs` on average, and at most `burst` at once | There is no edge: two milliseconds earn back a fifth of a call at 100 a second |

```ts
rateLimit: { enabled: true, maxRequests: 100, windowMs: 1_000, algorithm: 'gcra', burst: 20, store }
```

`burst` defaults to `maxRequests`. With a store, GCRA needs the store's `gcra()`, which returns a
`RateLimitDecision`: whether the call may go, and from when a refused one would. Both bundled stores
have it. `RedisRateLimitStore` runs it as one Lua script on Redis's own clock, so every worker agrees
on the time and two cannot both take the last slot; it needs a client with `eval`. `gcraDecide()` is
the arithmetic on its own, for a store of your own.

A `RateLimitStore` has `hit(key, windowMs)`, which returns a `RateLimitHit`: the count in the current
window, and when the window resets. It may also have `reset()`, and `gcra()` for the GCRA algorithm.

- `MemoryRateLimitStore` keeps counters in the process, with `reset()` and `clear()`.
- `RedisRateLimitStore` shares them between processes. It takes a `RedisRateLimitLikeClient` (`incr`,
  `pexpire`, `pttl`, and optionally `eval`) and `RedisRateLimitStoreOptions` (a key `prefix` and
  `useEval`).

## Health

`HealthConfig` turns on provider health tracking. A provider is unhealthy after `failureThreshold`
consecutive failures (3), or when its score drops below `minScore` (20). The router ranks an unhealthy
provider lower.

The score starts at 100. It loses 20 per consecutive failure, up to 60, and 1 per second of average
latency, up to 30.

`ProviderHealthMonitor` does the tracking. `recordSuccess()` takes a latency and `recordFailure()` the
error; `score()`, `isHealthy()`, `isUnknown()`, and `snapshot()` read the result. Each
`ProviderHealthSnapshot` has the counts, consecutive failures, average latency, last error, score, a
`status`, and whether it is `stale`.

A `ProviderHealthStatus` is `unknown` with nothing recent to judge by, `unhealthy` past the failure
threshold or under the minimum score, `degraded` when calls fail or are slow but not enough to stop
routing to it, and `healthy` otherwise.

**Health that expires.** Health moves only with traffic. Without a limit, a provider that failed on
Monday and got no calls since is still unhealthy on Wednesday, and one that worked last week is still
healthy after it broke. `observationTtlMs` bounds how long an outcome counts. A provider whose last
call is older is `unknown` and `stale`, and is routed to as a provider never seen, with its last error
still on record. `ai.checkProviders({ staleOnly: true })` runs the health check of every unknown
provider; run it on a schedule to keep an idle provider current.

## Metrics and export

`MetricsConfig` turns metrics on, with a `prefix` for names (`nexus_ai` by default) and a `sink`. A
`MetricsSink` takes counters (`increment()`), histograms (`observe()`), and optionally gauges.
`InMemoryMetrics`, the default, keeps them for `getMetricsSnapshot()` and renders Prometheus text for
`getPrometheusMetrics()`. `MetricsCollector` is what the client records through: requests,
responses with latency and cost, errors, cache hits, and each pipeline step.

Every family records through the same collector, under the same labels: `family`, `operation`, and
the provider and model once routing chose them. So one query covers completions, embeddings, images,
voice, calls, and graph runs alike. `cache_hits` counts operations a cache answered without a provider.

OpenTelemetry is reached through structural interfaces, so no OpenTelemetry package is a dependency.

| Piece | What it does |
| --- | --- |
| `OpenTelemetryMetricsSink` | Sends metrics through an `OpenTelemetryLikeMeter` — anything with `createCounter()` and `createHistogram()` — creating each instrument on first use. |
| `OpenTelemetryTraceExporter` | Turns a pipeline trace into spans: one for the pipeline, and one per step with its timing, outcome, and metadata as attributes. It uses an `OpenTelemetryLikeTracer` (`startSpan()`) and `OpenTelemetryLikeSpan` (`setAttribute()` and `end()`). |

```ts
import { metrics, trace } from '@opentelemetry/api';
import { OpenTelemetryMetricsSink, OpenTelemetryTraceExporter } from 'nexus-ai-pro/ops';

const ai = new NexusAI({ providers, metrics: { enabled: true, sink: new OpenTelemetryMetricsSink(metrics.getMeter('app')) } });
const exporter = new OpenTelemetryTraceExporter(trace.getTracer('app'));

const response = await ai.complete(request);
if (response.meta.pipeline) exporter.exportTrace(response.meta.pipeline, { 'app.route': '/chat' });
```

## Audit log

`AuditLogger` writes the client's audit events to the `auditLog.sink`, or to the console without
one. Values are redacted — secrets, tokens, credentials, and personal data — unless
`includeSensitiveData` is set, and that is refused without an explicit sink, so raw data never lands
on a console by accident.

Every operation writes a `request` event when it is admitted. Then it writes one more: a `response`,
a `blocked` when a check refused it, or an `error` when it failed after it started. A `blocked` event
carries the guardrail findings that caused it.

## Other families

`FamilyTelemetry` runs an image, voice, or telephony call through the client's
[lifecycle](./lifecycle.md): its authorization, budget, hooks, rate limit, audit log, and metrics.
`run()` takes a `FamilyCallDescriptor` — the operation, provider, model, user, tenant, request id,
metadata, signal, idempotency key, and an estimate for the budget — and a function that receives the
call's `ProviderCallContext`. `FamilyRuntime` is the wiring the client hands down: its lifecycle, or
the collector, audit logger, rate limiter, and rate-limit settings to build one from. A family reports
cost only when it can price the call in dollars.

## Limitations

- The breaker's failure counts are per worker even with a shared store; only open, closed, and who
  may probe are shared.
- The default fixed windows let a burst straddling a window boundary reach twice the limit for a
  moment; `algorithm: 'gcra'` does not. GCRA through Redis needs `eval`.
- Health comes from calls. Without `observationTtlMs`, a provider that receives no traffic keeps its last
  score; with it, an idle provider is `unknown` until a call or `checkProviders()` says more.
- rate limiting

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

### `nexus-ai-pro/ops`

| Export | Kind | Summary |
| --- | --- | --- |
| `AuditLogger` | class | Writes audit events to the configured sink, redacting sensitive data unless told otherwise. |
| `FamilyCallDescriptor` | interface | What one family call is, for authorization, metrics labels, the audit log, and the rate limit. |
| `FamilyRuntime` | interface | Shared observability wiring handed to an operation family. |
| `FamilyTelemetry` | class | Runs one family call through the client's lifecycle: authorization, the rate limit, the budget, the audit log, metrics, and hooks. |
| `HealthConfig` | interface | Health tracking for providers, used to route around unhealthy ones. |
| `InMemoryMetrics` | class | Keeps metrics in memory, for a snapshot or a Prometheus scrape. |
| `MetricsCollector` | class | Records request, response, error, and pipeline-step metrics for a client, when metrics are enabled. |
| `MetricsConfig` | interface | Metrics collection for a client. |
| `MetricsSink` | interface | Where metrics go: counters, histograms, and gauges, labelled. |
| `NexusRateLimitError` | class | Raised when a caller exceeds its rate limit. |
| `OpenTelemetryLikeMeter` | interface | The part of an OpenTelemetry meter the metrics sink uses. |
| `OpenTelemetryLikeSpan` | interface | The part of an OpenTelemetry span the exporter uses. |
| `OpenTelemetryLikeTracer` | interface | The part of an OpenTelemetry tracer the exporter uses. |
| `OpenTelemetryMetricsSink` | class | Sends metrics to OpenTelemetry through a meter. |
| `OpenTelemetryTraceExporter` | class | Exports pipeline traces as OpenTelemetry spans: one for the pipeline and one per step. |
| `ProviderHealthMonitor` | class | Tracks provider health from call outcomes and scores each provider for routing. |
| `ProviderHealthSnapshot` | interface | One provider's health, as tracked from real calls. |
| `ProviderHealthStatus` | type | Where a provider stands, by what its recent calls say. |
| `RateLimitedRequest` | interface | The parts of a request the limiter buckets on. |
| `RateLimiter` | class | Rate limiting per user, per model, or globally, in memory or through a shared store, by fixed windows or by GCRA. |

### `nexus-ai-pro/ops/circuit-breaker`

| Export | Kind | Summary |
| --- | --- | --- |
| `CircuitBreaker` | class | Trips routing away from a provider that is failing. |
| `CircuitBreakerConfig` | interface | Configuration for the circuit breaker. |
| `CircuitSnapshot` | interface | One circuit's state, for a health endpoint or dashboard. |
| `CircuitState` | type | Where a circuit stands: `closed` lets traffic through, `open` refuses it, `half-open` admits probes. |
| `CircuitStateChange` | interface | A circuit changing state. |
| `CircuitStateStore` | interface | Where shared circuit decisions live. |
| `SharedCircuitState` | interface | A circuit decision as every worker sees it. |

### `nexus-ai-pro/ops/circuit-store`

| Export | Kind | Summary |
| --- | --- | --- |
| `MemoryCircuitStateStore` | class | Shared circuit state in one process. |
| `RedisCircuitLikeClient` | interface | The Redis commands the circuit store needs, in `ioredis` argument order. |
| `RedisCircuitStateStore` | class | Shared circuit state in Redis, so every worker behind a load balancer agrees on which providers are down. |
| `RedisCircuitStateStoreOptions` | interface | Options for the Redis circuit store. |

### `nexus-ai-pro/ops/rate-limit-adapters`

| Export | Kind | Summary |
| --- | --- | --- |
| `gcraDecide` | function | GCRA on one key's theoretical arrival time: the time the key would be idle again at the allowed rate. |
| `MemoryRateLimitStore` | class | Process-local counters. |
| `RateLimitDecision` | interface | The verdict on one call under GCRA. |
| `RateLimitHit` | interface | A rate-limit window after counting one call. |
| `RateLimitStore` | interface | Where rate-limit counters live. |
| `RedisRateLimitLikeClient` | interface | The Redis commands the rate-limit store needs. |
| `RedisRateLimitStore` | class | Redis-backed counters, so one budget covers every process behind a load balancer. |
| `RedisRateLimitStoreOptions` | interface | Options for the Redis rate-limit store. |
<!-- reference:end -->
