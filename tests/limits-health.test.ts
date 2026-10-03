import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderHealthMonitor } from '../src/ops/health.js';
import { MemoryRateLimitStore, RedisRateLimitStore, gcraDecide } from '../src/ops/rate-limit-adapters.js';
import { NexusRateLimitError, RateLimiter } from '../src/ops/rate-limiter.js';

// ── Health that expires ────────────────────────────────────────────

test('a provider with no recent calls is unknown, not kept down by an old failure', () => {
  let now = new Date('2026-10-05T09:00:00.000Z');
  const health = new ProviderHealthMonitor({ enabled: true, observationTtlMs: 60_000, now: () => now });

  for (let index = 0; index < 3; index += 1) health.recordFailure('openai', new Error('503'));
  assert.equal(health.snapshot('openai')[0]?.status, 'unhealthy');
  assert.equal(health.isHealthy('openai'), false);

  // Monday's outage, read on Wednesday.
  now = new Date('2026-10-07T09:00:00.000Z');
  const later = health.snapshot('openai')[0];
  assert.equal(later?.status, 'unknown');
  assert.equal(later?.stale, true);
  assert.equal(later?.healthy, true, 'routed to as a provider never seen');
  assert.equal(later?.score, 100);
  assert.equal(later?.lastError, '503', 'what happened is still on record');

  health.recordFailure('openai', new Error('503'));
  assert.equal(health.snapshot('openai')[0]?.consecutiveFailures, 1, 'an old streak does not carry over');
  health.recordSuccess('openai', 2_500);
  assert.equal(health.snapshot('openai')[0]?.status, 'healthy');
});

test('health reports degraded between healthy and unhealthy, and never expires without a TTL', () => {
  let now = new Date('2026-10-05T09:00:00.000Z');
  const health = new ProviderHealthMonitor({ enabled: true, now: () => now });
  assert.equal(health.snapshot('anthropic')[0]?.status, 'unknown', 'never called');
  health.recordSuccess('anthropic', 100);
  health.recordFailure('anthropic', new Error('timeout'));
  assert.equal(health.snapshot('anthropic')[0]?.status, 'degraded');
  now = new Date('2027-01-01T00:00:00.000Z');
  assert.equal(health.snapshot('anthropic')[0]?.status, 'degraded', 'without a TTL, figures keep');
});

// ── GCRA ───────────────────────────────────────────────────────────

test('fixed windows pass twice the limit across a window edge; GCRA does not', () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const burstAcrossEdge = (algorithm: 'fixed-window' | 'gcra') => {
      const limiter = new RateLimiter();
      const config = { enabled: true, maxRequests: 100, windowMs: 1_000, key: 'global' as const, algorithm };
      const tryMany = (count: number) => {
        let passed = 0;
        for (let index = 0; index < count; index += 1) {
          try {
            limiter.check({}, config);
            passed += 1;
          } catch {}
        }
        return passed;
      };
      now = 1_000_000; // one call opens the window
      tryMany(1);
      now = 1_000_999; // its last millisecond
      const before = tryMany(100);
      now = 1_001_001; // the first of the next
      return before + tryMany(100);
    };
    // In two milliseconds, a fixed window lets through nearly two windows' worth.
    assert.equal(burstAcrossEdge('fixed-window'), 199);
    assert.equal(burstAcrossEdge('gcra'), 100, 'GCRA holds the burst to its size');
  } finally {
    Date.now = realNow;
  }
});

test('GCRA spreads calls at the sustained rate after a burst, and says when to retry', () => {
  let now = 0;
  const store = new MemoryRateLimitStore(() => now);
  // 10 a second, 3 at once.
  const decide = () => store.gcra('k', 100, 3);
  assert.deepEqual([decide().allowed, decide().allowed, decide().allowed, decide().allowed], [true, true, true, false]);
  const refused = decide();
  assert.equal(refused.retryAt, 100, 'one slot back after one emission interval');
  now = 100;
  assert.equal(decide().allowed, true);
  assert.equal(decide().allowed, false);
  assert.deepEqual(gcraDecide(undefined, 50, 100, 1), { allowed: true, retryAt: 50, tat: 150 });
});

test('the limiter uses a store for GCRA, and refuses a store that cannot do it', async () => {
  let now = 0;
  const limiter = new RateLimiter();
  const store = new MemoryRateLimitStore(() => now);
  const config = { enabled: true, maxRequests: 2, windowMs: 1_000, algorithm: 'gcra' as const, burst: 1, store };
  await limiter.checkAsync({ userId: 'ada' }, config);
  await assert.rejects(
    () => limiter.checkAsync({ userId: 'ada' }, config),
    (error: unknown) => error instanceof NexusRateLimitError && error.resetAt === 500,
  );
  now = 500;
  await limiter.checkAsync({ userId: 'ada' }, config);
  await limiter.checkAsync({ userId: 'grace' }, config);

  await assert.rejects(
    () => limiter.checkAsync({}, { ...config, store: { hit: () => ({ count: 1, resetAt: 0 }) } }),
    /cannot decide GCRA/,
  );
});

test('the Redis store decides GCRA in one script on the server clock', async () => {
  const scripts: string[] = [];
  const values = new Map<string, number>();
  let serverNow = 5_000;
  // A stand-in for Redis that runs the script's arithmetic, so the test checks what is sent and read.
  const client = {
    incr: () => 0,
    pexpire: () => undefined,
    pttl: () => 0,
    eval(script: string, _keys: number, key: string, emission: string, burst: string) {
      scripts.push(script);
      const decided = gcraDecide(values.get(key), serverNow, Number(emission), Number(burst));
      if (!decided.allowed) return [0, decided.retryAt - serverNow];
      values.set(key, decided.tat);
      return [1, 0];
    },
  };
  const store = new RedisRateLimitStore(client);
  assert.equal((await store.gcra('global', 1_000, 1)).allowed, true);
  const refused = await store.gcra('global', 1_000, 1);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAt > Date.now() + 900, 'retry once the server-side interval passes');
  serverNow += 1_000;
  assert.equal((await store.gcra('global', 1_000, 1)).allowed, true);
  assert.match(scripts[0] ?? '', /redis\.call\('TIME'\)/, "the server's clock, so workers agree");
  assert.ok([...values.keys()].every((key) => key.startsWith('nexus-ai-pro:ratelimit:gcra:')));

  await assert.rejects(
    () => new RedisRateLimitStore({ incr: () => 0, pexpire: () => 0, pttl: () => 0 }).gcra('k', 1, 1),
    /needs a client with eval/,
  );
});
