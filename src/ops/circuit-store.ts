import type { CircuitObservation, CircuitStateStore, CircuitWindow, SharedCircuitState } from './circuit-breaker.js';

export type {
  CircuitObservation,
  CircuitStateStore,
  CircuitWindow,
  SharedCircuitState,
} from './circuit-breaker.js';

/**
 * Shared circuit state in one process.
 *
 * For several `NexusAI` clients or workers inside one process, and for tests. Across processes use
 * `RedisCircuitStateStore` or the Postgres adapter.
 */
export class MemoryCircuitStateStore implements CircuitStateStore {
  private readonly states = new Map<string, SharedCircuitState>();
  private readonly probes = new Map<string, { owner: string; expiresAt: number }>();
  private readonly windows = new Map<
    string,
    { buckets: Map<number, { calls: number; failures: number }>; streak: number }
  >();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Adds one worker's calls to a provider's window and returns the window across every worker. */
  observe(providerName: string, observation: CircuitObservation): CircuitWindow {
    let window = this.windows.get(providerName);
    if (!window) {
      window = { buckets: new Map(), streak: 0 };
      this.windows.set(providerName, window);
    }
    for (const bucket of observation.buckets) {
      const stored = window.buckets.get(bucket.at) ?? { calls: 0, failures: 0 };
      stored.calls += bucket.calls;
      stored.failures += bucket.failures;
      window.buckets.set(bucket.at, stored);
    }
    window.streak = observation.succeeded ? observation.trailingFailures : window.streak + observation.trailingFailures;
    const keepAfter = observation.now - observation.windowMs - observation.bucketMs;
    const since = observation.since ?? Number.NEGATIVE_INFINITY;
    let calls = 0;
    let failures = 0;
    for (const [at, bucket] of window.buckets) {
      if (at <= keepAfter) window.buckets.delete(at);
      else if (at >= since) {
        calls += bucket.calls;
        failures += bucket.failures;
      }
    }
    return { calls, failures, consecutiveFailures: window.streak };
  }

  /** Every provider's shared circuit state. */
  read(): SharedCircuitState[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }

  /**
   * Writes a transition, unless a newer one is already stored. Releases the provider's probe claim.
   */
  write(state: SharedCircuitState): void {
    const current = this.states.get(state.providerName);
    if (current && current.updatedAt > state.updatedAt) return;
    this.states.set(state.providerName, { ...state });
    // A transition settles the probe it followed, so the next cooldown can be claimed afresh.
    this.probes.delete(state.providerName);
  }

  /**
   * Claims the right to probe a provider for `ttlMs`. Resolves true for the claimant, including
   * when it already holds the claim.
   */
  claimProbe(providerName: string, owner: string, ttlMs: number): boolean {
    const lease = this.probes.get(providerName);
    const now = this.now();
    if (lease && lease.expiresAt > now && lease.owner !== owner) return false;
    this.probes.set(providerName, { owner, expiresAt: now + ttlMs });
    return true;
  }
}

/**
 * The Redis commands the circuit store needs, in `ioredis` argument order.
 *
 * Structural, as with the other Redis adapters, so no Redis client becomes a dependency. A client
 * with a different `set` signature, such as `node-redis`, needs a one-line wrapper.
 */
export interface RedisCircuitLikeClient {
  /** Reads every hash field. */
  hgetall(key: string): Promise<Record<string, string> | null> | Record<string, string> | null;
  /** Reads a hash field. */
  hget(key: string, field: string): Promise<string | null> | string | null;
  /** Sets a hash field. */
  hset(key: string, field: string, value: string): Promise<unknown> | unknown;
  /** `SET key value PX ttl NX`, resolving to `'OK'` when the key was set. */
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<unknown> | unknown;
  /** Reads a key. */
  get(key: string): Promise<string | null> | string | null;
  /** Deletes a key. */
  del(key: string): Promise<unknown> | unknown;
  /** Optional atomic primitive. Strongly preferred; see the class note. */
  eval?(script: string, numKeys: number, ...args: string[]): Promise<unknown> | unknown;
}

const WRITE_SCRIPT = `
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current then
  local decoded = cjson.decode(current)
  if tonumber(decoded.updatedAt) > tonumber(ARGV[3]) then return 0 end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('DEL', KEYS[2])
return 1
`;

// KEYS: the provider's window hash. ARGV: succeeded (1 or 0), trailing failures, drop at or before,
// count from, expiry in ms, then (bucket, calls, failures) triples. Adds, trims, and sums in one step.
const OBSERVE_SCRIPT = `
local key = KEYS[1]
for i = 6, #ARGV, 3 do
  redis.call('HINCRBY', key, 'c:' .. ARGV[i], ARGV[i + 1])
  redis.call('HINCRBY', key, 'f:' .. ARGV[i], ARGV[i + 2])
end
local streak
if ARGV[1] == '1' then
  redis.call('HSET', key, 'streak', ARGV[2])
  streak = tonumber(ARGV[2])
else
  streak = tonumber(redis.call('HINCRBY', key, 'streak', ARGV[2]))
end
local keepAfter = tonumber(ARGV[3])
local since = tonumber(ARGV[4])
local calls, failures = 0, 0
local fields = redis.call('HGETALL', key)
for i = 1, #fields, 2 do
  local name = fields[i]
  local kind = string.sub(name, 1, 2)
  if kind == 'c:' or kind == 'f:' then
    local at = tonumber(string.sub(name, 3))
    if at <= keepAfter then
      redis.call('HDEL', key, name)
    elseif at >= since then
      if kind == 'c:' then calls = calls + tonumber(fields[i + 1]) else failures = failures + tonumber(fields[i + 1]) end
    end
  end
end
redis.call('PEXPIRE', key, ARGV[5])
return { calls, failures, streak }
`;

/** Options for the Redis circuit store. */
export interface RedisCircuitStateStoreOptions {
  /** Key prefix. Defaults to `nexus-ai-pro:circuits:`. */
  prefix?: string;
  /** Disables the Lua path even when the client exposes `eval`. */
  useEval?: boolean;
}

/**
 * Shared circuit state in Redis, so every worker behind a load balancer agrees on which providers
 * are down.
 *
 * Probe claims are `SET NX` with an expiry, which is atomic on every Redis. With `eval`, a
 * transition is written only when it is newer than the stored one, in one step; without it, the
 * store compares and writes separately, and a stale transition landing at the wrong moment can
 * briefly win. Workers heal that on their own — a stale "open" is probed and closed after one
 * cooldown — but prefer a client with `eval`.
 */
export class RedisCircuitStateStore implements CircuitStateStore {
  private readonly prefix: string;
  private readonly useEval: boolean;
  /**
   * Adds one worker's calls to a provider's shared window in one Lua call, and returns the window
   * across every worker. Present only when the client has `eval`, since the add and the sum must
   * happen together; without it, `shareObservations` has nothing to call and each worker counts
   * its own calls.
   */
  readonly observe?: (providerName: string, observation: CircuitObservation) => Promise<CircuitWindow>;

  constructor(
    private readonly client: RedisCircuitLikeClient,
    options: RedisCircuitStateStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'nexus-ai-pro:circuits:';
    this.useEval = options.useEval !== false && typeof client.eval === 'function';
    if (this.useEval) this.observe = (providerName, observation) => this.observeWithEval(providerName, observation);
  }

  private async observeWithEval(providerName: string, observation: CircuitObservation): Promise<CircuitWindow> {
    const reply = (await (this.client.eval as NonNullable<RedisCircuitLikeClient['eval']>)(
      OBSERVE_SCRIPT,
      1,
      `${this.prefix}window:${providerName}`,
      observation.succeeded ? '1' : '0',
      String(observation.trailingFailures),
      String(observation.now - observation.windowMs - observation.bucketMs),
      String(observation.since ?? -1),
      String(observation.windowMs * 2 + observation.bucketMs),
      ...observation.buckets.flatMap((bucket) => [String(bucket.at), String(bucket.calls), String(bucket.failures)]),
    )) as unknown[];
    const [calls, failures, streak] = (reply ?? []).map(Number);
    return { calls: calls ?? 0, failures: failures ?? 0, consecutiveFailures: streak ?? 0 };
  }

  /** Every provider's shared circuit state. Unreadable entries are skipped. */
  async read(): Promise<SharedCircuitState[]> {
    const all = (await this.client.hgetall(this.statesKey())) ?? {};
    const states: SharedCircuitState[] = [];
    for (const raw of Object.values(all)) {
      try {
        states.push(JSON.parse(raw) as SharedCircuitState);
      } catch {
        // A value another writer mangled is skipped rather than failing every worker's sync.
      }
    }
    return states;
  }

  /**
   * Writes a transition, unless a newer one is already stored. Releases the provider's probe claim.
   */
  async write(state: SharedCircuitState): Promise<void> {
    const encoded = JSON.stringify(state);
    if (this.useEval && this.client.eval) {
      await this.client.eval(
        WRITE_SCRIPT,
        2,
        this.statesKey(),
        this.probeKey(state.providerName),
        state.providerName,
        encoded,
        String(state.updatedAt),
      );
      return;
    }

    const current = await this.client.hget(this.statesKey(), state.providerName);
    if (current) {
      try {
        if ((JSON.parse(current) as SharedCircuitState).updatedAt > state.updatedAt) return;
      } catch {
        // Overwrite a value that cannot be read.
      }
    }
    await this.client.hset(this.statesKey(), state.providerName, encoded);
    await this.client.del(this.probeKey(state.providerName));
  }

  /**
   * Claims the right to probe a provider for `ttlMs`. Resolves true for the claimant, including
   * when it already holds the claim.
   */
  async claimProbe(providerName: string, owner: string, ttlMs: number): Promise<boolean> {
    const key = this.probeKey(providerName);
    const set = await this.client.set(key, owner, 'PX', Math.max(1, Math.round(ttlMs)), 'NX');
    if (set === 'OK') return true;
    return (await this.client.get(key)) === owner;
  }

  private statesKey(): string {
    return `${this.prefix}states`;
  }

  private probeKey(providerName: string): string {
    return `${this.prefix}probe:${providerName}`;
  }
}
