# Resilience and observability

<!-- covers: ./ops/circuit-breaker ./ops/circuit-store ./ops/rate-limit-adapters -->

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
- rate limiting

<!-- reference:start -->
## Reference

Generated from the doc comments by `npm run docs:update`. Each export is listed once, under the most
specific entry point that provides it.

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
| `MemoryRateLimitStore` | class | Process-local counters. |
| `RateLimitHit` | interface | A rate-limit window after counting one call. |
| `RateLimitStore` | interface | Where rate-limit counters live. |
| `RedisRateLimitLikeClient` | interface | The Redis commands the rate-limit store needs. |
| `RedisRateLimitStore` | class | Redis-backed counters, so one budget covers every process behind a load balancer. |
| `RedisRateLimitStoreOptions` | interface | Options for the Redis rate-limit store. |
<!-- reference:end -->
