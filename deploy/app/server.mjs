// @ts-check
/**
 * A self-hosted agent server, configured from the environment, for Docker, Compose, and Kubernetes.
 *
 * One image, three roles:
 *
 *   ROLE=all      accepts runs and executes them (the default; one process, or identical replicas)
 *   ROLE=api      accepts runs and queues them; serves reads, streams, and deployments
 *   ROLE=worker   claims queued runs and executes them; serves /health and /metrics for probes
 *
 * With REDIS_URL set, every replica shares threads, runs, events, the queue, deployments, and tenant
 * limits, so they behave as one server. Without it, state is in memory, which suits one process.
 *
 * Replace `assistants.mjs` with your own; nothing else here needs to change.
 */
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import {
  createAgentServer,
  fromStore,
  MemoryRunEventLog,
  MemoryServerStore,
  RedisRunEventLog,
  toNodeListener,
} from 'nexus-ai-pro/server';
import { Deployments, watchCanaries } from 'nexus-ai-pro/server/deployments';
import { MemoryTenantUsage, RedisTenantUsage, tenantLimits } from 'nexus-ai-pro/server/tenancy';
import { defineAssistants } from './assistants.mjs';

const env = process.env;
const role = env.ROLE ?? 'all';
if (!['all', 'api', 'worker'].includes(role)) throw new Error(`ROLE must be all, api, or worker, not "${role}"`);
const port = Number(env.PORT ?? 8080);
const concurrency = Number(env.CONCURRENCY ?? 4);
const drainTimeoutMs = Number(env.DRAIN_TIMEOUT_MS ?? 25_000);

/** The shared stores: Redis when configured, memory otherwise. */
async function stores() {
  if (!env.REDIS_URL) {
    const state = new MemoryServerStore();
    return {
      state,
      events: new MemoryRunEventLog(),
      operations: undefined,
      usage: new MemoryTenantUsage(),
      close: async () => {},
    };
  }
  // Loaded only when used, so a single-process deployment does not need the package.
  const { Redis } = await import('ioredis');
  const { RedisStore } = await import('nexus-ai-pro/store/redis');
  const { RedisOperationStore } = await import('nexus-ai-pro/operations/adapters');
  const { RedisRateLimitStore } = await import('nexus-ai-pro/ops/rate-limit-adapters');
  const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3 });
  return {
    state: fromStore(new RedisStore(redis)),
    events: new RedisRunEventLog(redis),
    operations: new RedisOperationStore(redis),
    usage: new RedisTenantUsage(redis),
    rates: new RedisRateLimitStore(redis),
    close: async () => {
      await redis.quit();
    },
  };
}

const shared = await stores();
const deployments = new Deployments({ state: shared.state });

/**
 * Who is calling. Set SERVER_TOKEN to require `Authorization: Bearer <token>`, which grants every
 * scope; replace this with your own identity provider for tenants and roles.
 */
function authenticate(/** @type {Request} */ request) {
  const token = env.SERVER_TOKEN;
  if (!token) return { userId: 'anonymous', scopes: ['admin'] };
  const presented = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (presented !== token) return undefined;
  return { userId: 'operator', tenantId: request.headers.get('x-tenant') ?? undefined, scopes: ['admin'] };
}

const server = createAgentServer({
  assistants: defineAssistants(deployments),
  state: shared.state,
  events: shared.events,
  operations: { store: shared.operations, retry: { maxAttempts: 2 } },
  queue: { concurrency, claim: role !== 'api', pollMs: Number(env.POLL_MS ?? 1_000) },
  deployments,
  tenants: tenantLimits({
    default: {
      ...(env.TENANT_MAX_ACTIVE_RUNS ? { maxActiveRuns: Number(env.TENANT_MAX_ACTIVE_RUNS) } : {}),
      ...(env.TENANT_RUNS_PER_MINUTE ? { rate: { runs: Number(env.TENANT_RUNS_PER_MINUTE), windowMs: 60_000 } } : {}),
      ...(env.TENANT_DAILY_BUDGET_USD ? { budget: { usd: Number(env.TENANT_DAILY_BUDGET_USD), period: 'day' } } : {}),
    },
    usage: shared.usage,
    rates: shared.rates,
  }),
  authenticate,
  // Probes and scrapers inside the cluster carry no token; keep /metrics off the public ingress.
  metrics: { public: env.METRICS_PUBLIC !== 'false' },
  replicaMetadata: { host: env.POD_NAME ?? hostname(), role, ...(env.IMAGE_TAG ? { image: env.IMAGE_TAG } : {}) },
  onError: (error) => console.error('server error', error),
});

await server.start();
const guard =
  env.CANARY_GUARD === 'true' ? watchCanaries({ deployments, steps: parseSteps(env.CANARY_STEPS) }) : undefined;
const http = createServer(toNodeListener(server)).listen(port, () => {
  console.log(`agent server (${role}) on :${port}${env.REDIS_URL ? ', shared through Redis' : ''}`);
});

// Kubernetes sends SIGTERM, then waits terminationGracePeriodSeconds. Drain within it: stop taking
// work, let runs finish, hand the rest to another worker, then exit.
let stopping = false;
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    guard?.stop();
    const { finished, released } = await server.drain({ timeoutMs: drainTimeoutMs });
    console.log(`drained: ${finished.length} finished, ${released.length} handed to another worker`);
    await server.stop();
    http.close();
    await shared.close();
    process.exit(0);
  });
}

/** `0.1,0.5` → `[0.1, 0.5]`: the shares a canary moves through before it is promoted. */
function parseSteps(/** @type {string | undefined} */ value) {
  return value
    ? value
        .split(',')
        .map(Number)
        .filter((step) => step > 0 && step < 1)
    : undefined;
}
