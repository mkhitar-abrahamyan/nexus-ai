import assert from 'node:assert/strict';
import test from 'node:test';
import { CircuitBreaker, type CircuitStateChange } from '../src/ops/circuit-breaker.js';
import {
  MemoryRateLimitStore,
  RedisRateLimitStore,
  type RedisRateLimitLikeClient,
} from '../src/ops/rate-limit-adapters.js';
import { NexusRateLimitError, RateLimiter } from '../src/ops/rate-limiter.js';
import { AutoRouter } from '../src/router/auto-router.js';
import type { RouterContext } from '../src/router/types.js';
import type { NexusAIConfig } from '../src/types/config.js';
import type { BaseProvider } from '../src/providers/base.js';

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

// ── Circuit breaker ────────────────────────────────────────────────

test('a disabled breaker allows everything and reports closed', () => {
  const breaker = new CircuitBreaker();
  for (let i = 0; i < 20; i += 1) breaker.recordFailure('openai', new Error('down'));

  assert.equal(breaker.allowRequest('openai'), true);
  assert.equal(breaker.state('openai'), 'closed');
  assert.deepEqual(breaker.openProviders(), []);
});

test('consecutive failures open the circuit and block traffic', () => {
  const breaker = new CircuitBreaker({ enabled: true, failureThreshold: 3 });

  breaker.recordFailure('openai', new Error('boom'));
  breaker.recordFailure('openai', new Error('boom'));
  assert.equal(breaker.state('openai'), 'closed', 'below the threshold the circuit stays closed');

  breaker.recordFailure('openai', new Error('boom'));
  assert.equal(breaker.state('openai'), 'open');
  assert.equal(breaker.allowRequest('openai'), false);
  assert.deepEqual(breaker.openProviders(), ['openai']);
});

test('a success resets the consecutive failure count', () => {
  const breaker = new CircuitBreaker({ enabled: true, failureThreshold: 3 });
  breaker.recordFailure('openai', new Error('a'));
  breaker.recordFailure('openai', new Error('b'));
  breaker.recordSuccess('openai');
  breaker.recordFailure('openai', new Error('c'));
  breaker.recordFailure('openai', new Error('d'));

  assert.equal(breaker.state('openai'), 'closed');
});

test('a failure rate opens a circuit that never fails consecutively', () => {
  // Alternating success and failure never trips a consecutive counter, but a provider failing half
  // its calls is still broken.
  const breaker = new CircuitBreaker({
    enabled: true,
    failureThreshold: 100,
    failureRateThreshold: 0.5,
    minimumThroughput: 10,
  });

  for (let i = 0; i < 6; i += 1) {
    breaker.recordSuccess('flaky');
    breaker.recordFailure('flaky', new Error('intermittent'));
  }

  assert.equal(breaker.state('flaky'), 'open');
});

test('the failure rate is ignored below the minimum throughput', () => {
  const breaker = new CircuitBreaker({
    enabled: true,
    failureThreshold: 100,
    failureRateThreshold: 0.5,
    minimumThroughput: 10,
  });

  breaker.recordFailure('new-provider', new Error('one'));
  breaker.recordFailure('new-provider', new Error('two'));
  assert.equal(breaker.state('new-provider'), 'closed', 'two calls are not evidence of a pattern');
});

test('the rolling window forgets old failures', () => {
  const time = clock();
  const breaker = new CircuitBreaker({
    enabled: true,
    failureThreshold: 100,
    failureRateThreshold: 0.5,
    minimumThroughput: 4,
    windowMs: 1_000,
    now: time.now,
  });

  breaker.recordFailure('p', new Error('old'));
  breaker.recordFailure('p', new Error('old'));
  time.advance(2_000);
  breaker.recordSuccess('p');
  breaker.recordSuccess('p');
  breaker.recordSuccess('p');
  breaker.recordSuccess('p');

  assert.equal(breaker.state('p'), 'closed');
  assert.equal(breaker.snapshot('p')[0]?.windowFailures, 0);
});

test('an open circuit becomes half-open after the cooldown', () => {
  const time = clock();
  const breaker = new CircuitBreaker({ enabled: true, failureThreshold: 1, resetTimeoutMs: 5_000, now: time.now });

  breaker.recordFailure('p', new Error('down'));
  assert.equal(breaker.state('p'), 'open');

  time.advance(4_999);
  assert.equal(breaker.state('p'), 'open', 'the cooldown has not elapsed');

  time.advance(2);
  assert.equal(breaker.state('p'), 'half-open');
});

test('half-open admits a limited number of probes', () => {
  const time = clock();
  const breaker = new CircuitBreaker({
    enabled: true,
    failureThreshold: 1,
    resetTimeoutMs: 1_000,
    halfOpenMaxCalls: 1,
    now: time.now,
  });

  breaker.recordFailure('p', new Error('down'));
  time.advance(1_500);

  assert.equal(breaker.allowRequest('p'), true, 'the first probe is admitted');
  assert.equal(breaker.allowRequest('p'), false, 'a second concurrent probe is not');
});

test('a successful probe closes the circuit', () => {
  const time = clock();
  const breaker = new CircuitBreaker({ enabled: true, failureThreshold: 1, resetTimeoutMs: 1_000, now: time.now });

  breaker.recordFailure('p', new Error('down'));
  time.advance(1_500);
  breaker.allowRequest('p');
  breaker.recordSuccess('p');

  assert.equal(breaker.state('p'), 'closed');
  assert.equal(breaker.allowRequest('p'), true);
});

test('a failed probe reopens the circuit and restarts the cooldown', () => {
  const time = clock();
  const breaker = new CircuitBreaker({ enabled: true, failureThreshold: 1, resetTimeoutMs: 1_000, now: time.now });

  breaker.recordFailure('p', new Error('down'));
  time.advance(1_500);
  breaker.allowRequest('p');
  breaker.recordFailure('p', new Error('still down'));

  assert.equal(breaker.state('p'), 'open');
  time.advance(500);
  assert.equal(breaker.state('p'), 'open', 'the cooldown restarted from the failed probe');
  time.advance(600);
  assert.equal(breaker.state('p'), 'half-open');
});

test('successThreshold requires several probes before closing', () => {
  const time = clock();
  const breaker = new CircuitBreaker({
    enabled: true,
    failureThreshold: 1,
    resetTimeoutMs: 1_000,
    halfOpenMaxCalls: 3,
    successThreshold: 2,
    now: time.now,
  });

  breaker.recordFailure('p', new Error('down'));
  time.advance(1_500);
  breaker.allowRequest('p');
  breaker.recordSuccess('p');
  assert.equal(breaker.state('p'), 'half-open', 'one probe is not enough');

  breaker.allowRequest('p');
  breaker.recordSuccess('p');
  assert.equal(breaker.state('p'), 'closed');
});

test('state changes are reported once per transition', () => {
  const time = clock();
  const changes: CircuitStateChange[] = [];
  const breaker = new CircuitBreaker({
    enabled: true,
    failureThreshold: 1,
    resetTimeoutMs: 1_000,
    now: time.now,
    onStateChange: (event) => changes.push(event),
  });

  breaker.recordFailure('p', new Error('down'));
  time.advance(1_500);
  breaker.state('p');
  breaker.allowRequest('p');
  breaker.recordSuccess('p');

  assert.deepEqual(
    changes.map((change) => `${change.from}->${change.to}`),
    ['closed->open', 'open->half-open', 'half-open->closed'],
  );
  assert.equal(changes[0]?.reason, 'consecutive failure threshold reached');
});

test('isFailure can exclude errors that are not the provider fault', () => {
  const breaker = new CircuitBreaker({
    enabled: true,
    failureThreshold: 2,
    // A caller cancelling says nothing about provider health.
    isFailure: (error) => !(error instanceof Error && error.name === 'AbortError'),
  });

  const abort = new Error('aborted');
  abort.name = 'AbortError';
  breaker.recordFailure('p', abort);
  breaker.recordFailure('p', abort);
  assert.equal(breaker.state('p'), 'closed');

  breaker.recordFailure('p', new Error('real'));
  breaker.recordFailure('p', new Error('real'));
  assert.equal(breaker.state('p'), 'open');
});

test('reset forces a circuit closed', () => {
  const breaker = new CircuitBreaker({ enabled: true, failureThreshold: 1 });
  breaker.recordFailure('a', new Error('x'));
  breaker.recordFailure('b', new Error('x'));
  assert.equal(breaker.openProviders().length, 2);

  breaker.reset('a');
  assert.deepEqual(breaker.openProviders(), ['b']);
  breaker.reset();
  assert.deepEqual(breaker.openProviders(), []);
});

test('a snapshot reports the retry time while open', () => {
  const time = clock();
  const breaker = new CircuitBreaker({ enabled: true, failureThreshold: 1, resetTimeoutMs: 30_000, now: time.now });
  breaker.recordFailure('p', new Error('down'));

  const [snapshot] = breaker.snapshot('p');
  assert.equal(snapshot?.state, 'open');
  assert.equal(snapshot?.lastError, 'down');
  assert.ok(snapshot?.retryAt);
  assert.equal(new Date(snapshot.retryAt).getTime(), time.now() + 30_000);
});

// ── Router integration ─────────────────────────────────────────────

function routerContext(openCircuits: string[]): RouterContext {
  const config: NexusAIConfig = {
    providers: {},
    routing: {
      mode: 'auto',
      strategy: 'quality',
      candidateModels: ['gpt-5.4-mini', 'claude-sonnet-4.5'],
    },
  };
  const providers = new Map<string, BaseProvider>([
    ['openai', {} as BaseProvider],
    ['anthropic', {} as BaseProvider],
  ]);
  return {
    request: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] },
    config,
    providers,
    openCircuits,
  };
}

test('routing skips a provider whose circuit is open', () => {
  const router = new AutoRouter();
  const decision = router.route(routerContext(['openai']));

  assert.equal(decision.providerName, 'anthropic');
  assert.equal(
    decision.fallbacks.some((fallback) => fallback.providerName === 'openai'),
    false,
    'an open provider is not offered as a fallback either',
  );
});

test('routing still picks something when every circuit is open', () => {
  // All circuits open usually means a shared dependency is down, and one attempt beats a certain
  // failure with no attempt at all.
  const router = new AutoRouter();
  const decision = router.route(routerContext(['openai', 'anthropic']));

  assert.ok(['openai', 'anthropic'].includes(decision.providerName));
});

test('routing is unchanged when no circuit is open', () => {
  const router = new AutoRouter();
  const withNone = router.route(routerContext([]));
  const withUndefined = router.route({ ...routerContext([]), openCircuits: undefined });

  assert.equal(withNone.providerName, withUndefined.providerName);
  assert.equal(withNone.fallbacks.length, withUndefined.fallbacks.length);
});

// ── Rate limit stores ──────────────────────────────────────────────

test('the memory store counts within a window and resets after it', () => {
  const time = clock();
  const store = new MemoryRateLimitStore(time.now);

  assert.equal(store.hit('k', 1_000).count, 1);
  assert.equal(store.hit('k', 1_000).count, 2);

  time.advance(1_001);
  assert.equal(store.hit('k', 1_000).count, 1, 'a new window starts fresh');
});

test('the limiter enforces a budget through a store', async () => {
  const limiter = new RateLimiter();
  const store = new MemoryRateLimitStore();
  const config = { enabled: true, maxRequests: 2, windowMs: 60_000, key: 'global' as const, store };

  await limiter.checkAsync({ userId: 'a' }, config);
  await limiter.checkAsync({ userId: 'b' }, config);
  await assert.rejects(() => limiter.checkAsync({ userId: 'c' }, config), NexusRateLimitError);
});

test('one store shares a budget across limiter instances', async () => {
  // The point of a distributed store: two workers must not each get the full budget.
  const store = new MemoryRateLimitStore();
  const config = { enabled: true, maxRequests: 2, windowMs: 60_000, key: 'global' as const, store };
  const workerA = new RateLimiter();
  const workerB = new RateLimiter();

  await workerA.checkAsync({}, config);
  await workerB.checkAsync({}, config);
  await assert.rejects(() => workerA.checkAsync({}, config), NexusRateLimitError);
});

test('checkAsync without a store matches the synchronous path', async () => {
  const limiter = new RateLimiter();
  const config = { enabled: true, maxRequests: 1, windowMs: 60_000, key: 'global' as const };

  await limiter.checkAsync({}, config);
  await assert.rejects(() => limiter.checkAsync({}, config), NexusRateLimitError);
});

test('a disabled limiter never counts or throws', async () => {
  const limiter = new RateLimiter();
  const store = new MemoryRateLimitStore();
  const config = { enabled: false, maxRequests: 1, windowMs: 60_000, store };

  for (let i = 0; i < 5; i += 1) await limiter.checkAsync({}, config);
  assert.equal(store.hit('global', 60_000).count, 1, 'the store was never touched');
});

test('the rate limit error carries a retry-after hint', async () => {
  const limiter = new RateLimiter();
  const config = { enabled: true, maxRequests: 1, windowMs: 60_000, key: 'global' as const };

  await limiter.checkAsync({}, config);
  await assert.rejects(
    () => limiter.checkAsync({}, config),
    (error: unknown) =>
      error instanceof NexusRateLimitError && typeof error.resetAt === 'number' && (error.retryAfterSeconds ?? 0) > 0,
  );
});

test('keys separate budgets per user and per model', async () => {
  const limiter = new RateLimiter();
  const store = new MemoryRateLimitStore();
  const perUser = { enabled: true, maxRequests: 1, windowMs: 60_000, key: 'userId' as const, store };

  await limiter.checkAsync({ userId: 'alice' }, perUser);
  await limiter.checkAsync({ userId: 'bob' }, perUser);
  await assert.rejects(() => limiter.checkAsync({ userId: 'alice' }, perUser), NexusRateLimitError);
});

// ── Redis rate limit store ─────────────────────────────────────────

function fakeRedis(withEval: boolean): RedisRateLimitLikeClient {
  const counters = new Map<string, number>();
  const ttls = new Map<string, number>();
  const client: RedisRateLimitLikeClient = {
    incr: (key) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    pexpire: (key, ms) => void ttls.set(key, ms),
    pttl: (key) => ttls.get(key) ?? -1,
    del: (key) => {
      counters.delete(key);
      ttls.delete(key);
    },
  };
  if (withEval) {
    client.eval = (_script, _numKeys, key, windowMs) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      if (next === 1) ttls.set(key, Number(windowMs));
      return [next, ttls.get(key) ?? Number(windowMs)];
    };
  }
  return client;
}

test('the Redis store counts through the Lua path when eval exists', async () => {
  const store = new RedisRateLimitStore(fakeRedis(true));

  assert.equal((await store.hit('k', 1_000)).count, 1);
  assert.equal((await store.hit('k', 1_000)).count, 2);
  const third = await store.hit('k', 1_000);
  assert.equal(third.count, 3);
  assert.ok(third.resetAt > Date.now());
});

test('the Redis store falls back to INCR and PEXPIRE without eval', async () => {
  const store = new RedisRateLimitStore(fakeRedis(false));

  assert.equal((await store.hit('k', 1_000)).count, 1);
  assert.equal((await store.hit('k', 1_000)).count, 2);
});

test('the fallback re-arms a missing expiry rather than blocking the key forever', async () => {
  const counters = new Map<string, number>();
  let pexpireCalls = 0;
  const store = new RedisRateLimitStore({
    incr: (key) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    pexpire: () => {
      pexpireCalls += 1;
    },
    // A key left without a TTL, as a crash between INCR and PEXPIRE would produce.
    pttl: () => -1,
  });

  await store.hit('k', 1_000);
  const second = await store.hit('k', 1_000);

  assert.equal(second.count, 2);
  assert.equal(pexpireCalls, 2, 'the missing TTL was restored');
  assert.ok(second.resetAt > Date.now());
});

test('the Redis store namespaces keys with its prefix', async () => {
  const seen: string[] = [];
  const store = new RedisRateLimitStore(
    {
      incr: (key) => {
        seen.push(key);
        return 1;
      },
      pexpire: () => undefined,
      pttl: () => 1_000,
    },
    { prefix: 'tenant-a:' },
  );

  await store.hit('user:alice', 1_000);
  assert.deepEqual(seen, ['tenant-a:user:alice']);
});

test('the limiter rejects once a Redis budget is exhausted', async () => {
  const limiter = new RateLimiter();
  const store = new RedisRateLimitStore(fakeRedis(true));
  const config = { enabled: true, maxRequests: 2, windowMs: 60_000, key: 'global' as const, store };

  await limiter.checkAsync({}, config);
  await limiter.checkAsync({}, config);
  await assert.rejects(() => limiter.checkAsync({}, config), NexusRateLimitError);
});
