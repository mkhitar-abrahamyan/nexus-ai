import type { CircuitStateStore, SharedCircuitState } from './circuit-breaker.js';

export type { CircuitStateStore, SharedCircuitState } from './circuit-breaker.js';

/**
 * Shared circuit state in one process.
 *
 * For several `NexusAI` clients or workers inside one process, and for tests. Across processes use
 * `RedisCircuitStateStore` or the Postgres adapter.
 */
export class MemoryCircuitStateStore implements CircuitStateStore {
  private readonly states = new Map<string, SharedCircuitState>();
  private readonly probes = new Map<string, { owner: string; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

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

  constructor(
    private readonly client: RedisCircuitLikeClient,
    options: RedisCircuitStateStoreOptions = {},
  ) {
    this.prefix = options.prefix ?? 'nexus-ai-pro:circuits:';
    this.useEval = options.useEval !== false && typeof client.eval === 'function';
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
