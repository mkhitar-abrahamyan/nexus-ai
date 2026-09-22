import type { CircuitStateStore, SharedCircuitState } from '../ops/circuit-breaker.js';
import { fromJson, type PostgresLikeClient, quoteTable, runStatements } from './client.js';

/** Options for the Postgres circuit store. */
export interface PostgresCircuitStateStoreOptions {
  /** Table name, optionally schema-qualified. Defaults to `nexus_circuits`. */
  table?: string;
  /** Clock for probe leases. Defaults to `Date.now`, the same clock the breaker uses. */
  now?: () => number;
}

/** The schema, as statements. */
export function circuitStoreMigration(options: Pick<PostgresCircuitStateStoreOptions, 'table'> = {}): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${quoteTable(options.table ?? 'nexus_circuits')} (
  provider text PRIMARY KEY,
  updated_at double precision,
  doc jsonb,
  probe_owner text,
  probe_expires_at double precision
)`,
  ];
}

/**
 * Shared circuit state in Postgres.
 *
 * Both operations the breaker needs to be atomic are single statements: a transition is written only
 * when it is at least as new as the stored one, and a probe is claimed only when no other worker holds
 * an unexpired claim. One row per provider, so a sync reads a handful of rows.
 */
export class PostgresCircuitStateStore implements CircuitStateStore {
  private readonly table: string;
  private readonly now: () => number;

  constructor(
    private readonly client: PostgresLikeClient,
    private readonly options: PostgresCircuitStateStoreOptions = {},
  ) {
    this.table = quoteTable(options.table ?? 'nexus_circuits');
    this.now = options.now ?? (() => Date.now());
  }

  /** Creates the table if it does not exist. Never runs implicitly. */
  async migrate(): Promise<void> {
    await runStatements(this.client, circuitStoreMigration(this.options));
  }

  /** Every provider's shared circuit state. */
  async read(): Promise<SharedCircuitState[]> {
    const { rows } = await this.client.query(`SELECT doc::text AS doc FROM ${this.table} WHERE doc IS NOT NULL`);
    return rows.map((row) => fromJson<SharedCircuitState>((row as { doc: unknown }).doc));
  }

  /**
   * Writes a transition, unless a newer one is already stored. Releases the provider's probe claim.
   */
  async write(state: SharedCircuitState): Promise<void> {
    // A transition settles the probe it followed, so the claim is released with it.
    await this.client.query(
      `INSERT INTO ${this.table} AS circuit (provider, updated_at, doc, probe_owner, probe_expires_at)
       VALUES ($1, $2, $3::jsonb, NULL, NULL)
       ON CONFLICT (provider) DO UPDATE SET updated_at = EXCLUDED.updated_at, doc = EXCLUDED.doc,
         probe_owner = NULL, probe_expires_at = NULL
       WHERE circuit.updated_at IS NULL OR circuit.updated_at <= EXCLUDED.updated_at`,
      [state.providerName, state.updatedAt, JSON.stringify(state)],
    );
  }

  /**
   * Claims the right to probe a provider for `ttlMs`, in one statement. Resolves true for the
   * claimant, including when it already holds the claim.
   */
  async claimProbe(providerName: string, owner: string, ttlMs: number): Promise<boolean> {
    const now = this.now();
    const { rows } = await this.client.query(
      `INSERT INTO ${this.table} AS circuit (provider, probe_owner, probe_expires_at) VALUES ($1, $2, $4)
       ON CONFLICT (provider) DO UPDATE SET probe_owner = EXCLUDED.probe_owner, probe_expires_at = EXCLUDED.probe_expires_at
       WHERE circuit.probe_owner IS NULL OR circuit.probe_expires_at <= $3 OR circuit.probe_owner = $2
       RETURNING provider`,
      [providerName, owner, now, now + ttlMs],
    );
    return rows.length > 0;
  }
}
