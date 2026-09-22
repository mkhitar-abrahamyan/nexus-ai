import assert from 'node:assert/strict';
import test from 'node:test';
import { CircuitBreaker, type CircuitStateChange, type SharedCircuitState } from '../src/ops/circuit-breaker.js';
import {
  MemoryCircuitStateStore,
  RedisCircuitStateStore,
  type RedisCircuitLikeClient,
} from '../src/ops/circuit-store.js';
import { BaseProvider } from '../src/providers/base.js';
import { NexusProviderError } from '../src/providers/errors.js';
import { FailoverExecutor } from '../src/router/failover.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse, NexusStream } from '../src/types/response.js';

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function response(provider: string): NexusResponse {
  return {
    content: provider,
    role: 'assistant',
    finishReason: 'stop',
    meta: {
      requestId: 'r',
      providerUsed: provider,
      modelUsed: `${provider}/m`,
      latencyMs: 0,
      tokensInput: 1,
      tokensOutput: 1,
      tokensSaved: 0,
      estimatedCost: '$0.00',
      cacheHit: false,
      guardrailsApplied: [],
    },
  };
}

class GatedProvider extends BaseProvider {
  calls = 0;
  release: (() => void) | undefined;
  constructor(readonly info: { name: string; isLocal: boolean }) {
    super();
  }
  async complete(): Promise<NexusResponse> {
    this.calls += 1;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    return response(this.info.name);
  }
  stream(): NexusStream {
    return { async *[Symbol.asyncIterator]() {}, abort() {} };
  }
}

class InstantProvider extends BaseProvider {
  calls = 0;
  constructor(readonly info: { name: string; isLocal: boolean }) {
    super();
  }
  async complete(): Promise<NexusResponse> {
    this.calls += 1;
    return response(this.info.name);
  }
  stream(): NexusStream {
    return { async *[Symbol.asyncIterator]() {}, abort() {} };
  }
}

// ── Probe slots, enforced where requests actually go ───────────────

test('a half-open circuit admits one probe; concurrent requests fall back instead of piling on', async () => {
  const time = clock();
  const breaker = new CircuitBreaker({ enabled: true, failureThreshold: 1, resetTimeoutMs: 1_000, now: time.now });
  breaker.recordFailure('primary', new Error('down'));
  time.advance(1_000);

  const primary = new GatedProvider({ name: 'primary', isLocal: true });
  const backup = new InstantProvider({ name: 'backup', isLocal: true });
  const providers = new Map<string, BaseProvider>([
    ['primary', primary],
    ['backup', backup],
  ]);
  const executor = new FailoverExecutor();
  const hooks = {
    allowAttempt: (name: string) => breaker.allowRequest(name),
    onAttemptSuccess: (name: string) => breaker.recordSuccess(name),
    onAttemptFailure: (name: string, error: unknown) => breaker.recordFailure(name, error),
  };
  const route = {
    providerName: 'primary',
    model: 'primary/m',
    reason: 'test',
    fallbacks: [{ providerName: 'backup', model: 'backup/m' }],
  };
  const request: CompletionRequest = { model: 'primary/m', messages: [{ role: 'user', content: 'hi' }] };

  const probe = executor.complete(request, route, providers, hooks);
  const second = await executor.complete(request, route, providers, hooks);
  assert.equal(second.content, 'backup', 'the probe slot was taken, so the second request fell back');
  assert.equal(primary.calls, 1);

  primary.release?.();
  assert.equal((await probe).content, 'primary');
  assert.equal(breaker.state('primary'), 'closed');
});

test('an attempt that does not count still releases its probe slot', () => {
  const time = clock();
  const breaker = new CircuitBreaker({
    enabled: true,
    failureThreshold: 1,
    resetTimeoutMs: 1_000,
    isFailure: (error) => !(error instanceof Error && error.message === 'bad request'),
    now: time.now,
  });
  breaker.recordFailure('p', new Error('down'));
  time.advance(1_000);

  assert.equal(breaker.allowRequest('p'), true);
  breaker.recordFailure('p', new Error('bad request'));
  assert.equal(breaker.state('p'), 'half-open');
  assert.equal(breaker.allowRequest('p'), true, 'the slot came back; before, the circuit refused traffic forever');
});

test('a caller cancelling a request does not count against the provider', () => {
  const breaker = new CircuitBreaker({ enabled: true, failureThreshold: 1 });
  breaker.recordFailure(
    'p',
    new NexusProviderError({ message: 'cancelled', provider: 'p', model: 'm', category: 'abort' }),
  );
  breaker.recordFailure('p', Object.assign(new Error('aborted'), { name: 'AbortError' }));
  assert.equal(breaker.state('p'), 'closed');
  breaker.recordFailure('p', new Error('real failure'));
  assert.equal(breaker.state('p'), 'open');
});

// ── Shared state ───────────────────────────────────────────────────

function sharedPair(time = clock()) {
  const store = new MemoryCircuitStateStore(time.now);
  const changes: Record<string, CircuitStateChange[]> = { a: [], b: [] };
  const make = (id: 'a' | 'b') =>
    new CircuitBreaker({
      enabled: true,
      failureThreshold: 2,
      resetTimeoutMs: 1_000,
      syncIntervalMs: 0,
      store,
      workerId: id,
      now: time.now,
      onStateChange: (change) => changes[id]?.push(change),
    });
  return { time, store, a: make('a'), b: make('b'), changes };
}

test('a provider that fails in one worker is taken out of routing in another', async () => {
  const { a, b, changes } = sharedPair();
  a.recordFailure('flaky', new Error('503'));
  a.recordFailure('flaky', new Error('503'));
  await a.flush();

  assert.deepEqual(b.openProviders(), [], 'checks never wait on the network');
  await b.sync();
  assert.deepEqual(b.openProviders(), ['flaky']);
  assert.match(changes.b?.[0]?.reason ?? '', /opened by a: consecutive failure threshold reached/);
  assert.equal(b.snapshot('flaky')[0]?.lastError, '503');
});

test('when the cooldown ends only one worker probes, and its result settles it for both', async () => {
  const { time, a, b } = sharedPair();
  a.recordFailure('flaky', new Error('503'));
  a.recordFailure('flaky', new Error('503'));
  await a.flush();
  await b.sync();

  time.advance(1_000);
  await a.sync();
  await b.sync();
  const probers = [a, b].filter((breaker) => breaker.state('flaky') === 'half-open');
  assert.equal(probers.length, 1, 'exactly one worker holds the probe');
  const waiting = probers[0] === a ? b : a;
  assert.equal(waiting.state('flaky'), 'open');

  assert.equal(probers[0]?.allowRequest('flaky'), true);
  probers[0]?.recordSuccess('flaky');
  await probers[0]?.flush();
  await waiting.sync();
  assert.equal(waiting.state('flaky'), 'closed', 'the probe that succeeded closed the circuit everywhere');
});

test('a failed probe restarts the cooldown for every worker', async () => {
  const { time, a, b } = sharedPair();
  a.recordFailure('flaky', new Error('503'));
  a.recordFailure('flaky', new Error('503'));
  await a.flush();
  time.advance(1_000);
  await a.sync();
  assert.equal(a.state('flaky'), 'half-open');

  a.allowRequest('flaky');
  a.recordFailure('flaky', new Error('still down'));
  await a.flush();
  await b.sync();
  time.advance(500);
  await b.sync();
  assert.equal(b.state('flaky'), 'open', 'half a cooldown after the failed probe, b still waits');
});

test('reset is published, so an operator override closes the circuit everywhere', async () => {
  const { a, b } = sharedPair();
  a.recordFailure('flaky', new Error('x'));
  a.recordFailure('flaky', new Error('x'));
  await a.flush();
  await b.sync();
  assert.equal(b.state('flaky'), 'open');

  a.reset('flaky');
  await a.flush();
  await b.sync();
  assert.equal(b.state('flaky'), 'closed');
});

test('a store that is down leaves each worker deciding for itself, never stuck open', async () => {
  const time = clock();
  const errors: unknown[] = [];
  const breaker = new CircuitBreaker({
    enabled: true,
    failureThreshold: 1,
    resetTimeoutMs: 1_000,
    syncIntervalMs: 0,
    now: time.now,
    onStoreError: (error) => errors.push(error),
    store: {
      read: () => {
        throw new Error('store down');
      },
      write: () => {
        throw new Error('store down');
      },
      claimProbe: () => {
        throw new Error('store down');
      },
    },
  });
  breaker.recordFailure('p', new Error('503'));
  await breaker.flush();
  time.advance(1_000);
  await breaker.sync();
  assert.equal(breaker.state('p'), 'half-open', 'without a reachable store the local cooldown applies');
  assert.ok(errors.length >= 2);
});

test('an older transition never replaces a newer one in the memory store', () => {
  const store = new MemoryCircuitStateStore();
  const base: SharedCircuitState = { providerName: 'p', state: 'closed', updatedAt: 200, updatedBy: 'b' };
  store.write(base);
  store.write({ ...base, state: 'open', openedAt: 100, updatedAt: 100, updatedBy: 'a' });
  assert.equal(store.read()[0]?.state, 'closed');
  assert.equal(store.claimProbe('p', 'a', 1_000), true);
  assert.equal(store.claimProbe('p', 'b', 1_000), false);
  assert.equal(store.claimProbe('p', 'a', 1_000), true, 'the holder may renew its own claim');
});

// ── Redis adapter ──────────────────────────────────────────────────

function fakeRedis(options: { eval: boolean }): RedisCircuitLikeClient & { hashes: Map<string, Map<string, string>> } {
  const hashes = new Map<string, Map<string, string>>();
  const strings = new Map<string, string>();
  const hash = (key: string) => {
    let found = hashes.get(key);
    if (!found) {
      found = new Map();
      hashes.set(key, found);
    }
    return found;
  };
  const client: RedisCircuitLikeClient & { hashes: typeof hashes } = {
    hashes,
    hgetall: (key) => Object.fromEntries(hash(key)),
    hget: (key, field) => hash(key).get(field) ?? null,
    hset: (key, field, value) => {
      hash(key).set(field, value);
    },
    set: (key, value) => {
      if (strings.has(key)) return null;
      strings.set(key, value);
      return 'OK';
    },
    get: (key) => strings.get(key) ?? null,
    del: (key) => {
      strings.delete(key);
    },
  };
  if (options.eval) {
    // Emulates the write script: compare updatedAt, write, release the probe.
    client.eval = (_script, _keys, statesKey, probeKey, field, encoded, updatedAt) => {
      const current = hash(statesKey as string).get(field as string);
      if (current && (JSON.parse(current) as SharedCircuitState).updatedAt > Number(updatedAt)) return 0;
      hash(statesKey as string).set(field as string, encoded as string);
      strings.delete(probeKey as string);
      return 1;
    };
  }
  return client;
}

for (const useEval of [true, false]) {
  test(`the Redis store keeps the newest transition and one probe holder (${useEval ? 'eval' : 'fallback'})`, async () => {
    const client = fakeRedis({ eval: useEval });
    const store = new RedisCircuitStateStore(client);
    await store.write({ providerName: 'p', state: 'open', openedAt: 10, updatedAt: 10, updatedBy: 'a' });
    await store.write({ providerName: 'p', state: 'closed', updatedAt: 5, updatedBy: 'b' });
    assert.equal((await store.read())[0]?.state, 'open', 'the stale close lost');

    assert.equal(await store.claimProbe('p', 'a', 1_000), true);
    assert.equal(await store.claimProbe('p', 'b', 1_000), false);
    assert.equal(await store.claimProbe('p', 'a', 1_000), true);

    await store.write({ providerName: 'p', state: 'closed', updatedAt: 20, updatedBy: 'a' });
    assert.equal(await store.claimProbe('p', 'b', 1_000), true, 'a transition releases the probe');

    client.hashes.get('nexus-ai-pro:circuits:states')?.set('broken', '{not json');
    assert.equal((await store.read()).length, 1, 'a mangled value is skipped');
  });
}
