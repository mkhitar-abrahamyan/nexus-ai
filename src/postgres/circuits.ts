import type {
  CircuitObservation,
  CircuitStateStore,
  CircuitWindow,
  SharedCircuitState,
} from '../ops/circuit-breaker.js';
import type { MigrationResult, SchemaMigration } from '../utils/schema-migrations.js';
import { fromJson, type PostgresLikeClient, quoteTable } from './client.js';
import type { PostgresMigrateOptions } from './migrations.js';

/** Options for the Postgres circuit store. */
export interface PostgresCircuitStateStoreOptions {
  /** Table name, optionally schema-qualified. Defaults to `nexus_circuits`. */
  table?: string;
  /** Clock for probe leases. Defaults to `Date.now`, the same clock the breaker uses. */
  now?: () => number;
}

/** The schema, as statements: every migration's, in order. */
export function circuitStoreMigration(options: Pick<PostgresCircuitStateStoreOptions, 'table'> = {}): string[] {
  return circuitStoreMigrations(options).flatMap((migration) => [...migration.statements]);
}

/**
 * The versioned schema, which `migrate()` and `nexus db migrate` apply. Version 1 is the 2.0 table;
 * version 2 adds the shared failure window, so a breaker counts every worker's calls.
 */
export function circuitStoreMigrations(
  options: Pick<PostgresCircuitStateStoreOptions, 'table'> = {},
): SchemaMigration[] {
  const name = options.table ?? 'nexus_circuits';
  const component = `circuits:${name}`;
  return [
    {
      component,
      version: 1,
      name: 'create the circuits table',
      statements: [
        `CREATE TABLE IF NOT EXISTS ${quoteTable(name)} (
  provider text PRIMARY KEY,
  updated_at double precision,
  doc jsonb,
  probe_owner text,
  probe_expires_at double precision
)`,
      ],
    },
    {
      component,
      version: 2,
      name: 'add the shared failure window',
      statements: [
        `ALTER TABLE ${quoteTable(name)} ADD COLUMN IF NOT EXISTS failure_streak integer NOT NULL DEFAULT 0`,
        `CREATE TABLE IF NOT EXISTS ${quoteTable(`${name}_window`)} (
  provider text NOT NULL,
  bucket double precision NOT NULL,
  calls integer NOT NULL,
  failures integer NOT NULL,
  PRIMARY KEY (provider, bucket)
)`,
      ],
    },
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
  private readonly windowTable: string;
  private readonly now: () => number;

  constructor(
    private readonly client: PostgresLikeClient,
    private readonly options: PostgresCircuitStateStoreOptions = {},
  ) {
    this.table = quoteTable(options.table ?? 'nexus_circuits');
    this.windowTable = quoteTable(`${options.table ?? 'nexus_circuits'}_window`);
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Applies this store's pending migrations, recorded in `nexus_schema_migrations`, under a lock.
   * Never runs implicitly. Safe on a database an older release created: what exists is kept.
   */
  async migrate(options: PostgresMigrateOptions = {}): Promise<MigrationResult> {
    // Loaded when called, so an application that migrates elsewhere never imports the runner.
    const { applyPostgresMigrations } = await import('./migrations.js');
    return applyPostgresMigrations(this.client, circuitStoreMigrations(this.options), options);
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

  /**
   * Adds one worker's calls to a provider's shared window, then sums it. The add, the trim of buckets
   * that rolled out, and the streak update are one statement, so two workers reporting at once both
   * count. Needs version 2 of the schema.
   */
  async observe(providerName: string, observation: CircuitObservation): Promise<CircuitWindow> {
    const keepAfter = observation.now - observation.windowMs - observation.bucketMs;
    const { rows } = await this.client.query(
      `WITH added AS (
         INSERT INTO ${this.windowTable} AS stored (provider, bucket, calls, failures)
         SELECT $1, item.at, item.calls, item.failures
         FROM jsonb_to_recordset($2::jsonb) AS item(at double precision, calls integer, failures integer)
         ON CONFLICT (provider, bucket) DO UPDATE
           SET calls = stored.calls + EXCLUDED.calls, failures = stored.failures + EXCLUDED.failures
       ), trimmed AS (
         DELETE FROM ${this.windowTable} WHERE provider = $1 AND bucket <= $5::double precision
       )
       INSERT INTO ${this.table} AS circuit (provider, failure_streak) VALUES ($1, $3::integer)
       ON CONFLICT (provider) DO UPDATE SET failure_streak = CASE WHEN $4::integer = 1
         THEN EXCLUDED.failure_streak ELSE circuit.failure_streak + EXCLUDED.failure_streak END
       RETURNING failure_streak`,
      [
        providerName,
        JSON.stringify(observation.buckets),
        observation.trailingFailures,
        observation.succeeded ? 1 : 0,
        keepAfter,
      ],
    );
    const totals = await this.client.query(
      `SELECT coalesce(sum(calls), 0)::int AS calls, coalesce(sum(failures), 0)::int AS failures
       FROM ${this.windowTable}
       WHERE provider = $1 AND bucket > $2::double precision AND bucket >= $3::double precision`,
      [providerName, keepAfter, observation.since ?? -1],
    );
    const sums = totals.rows[0] as { calls: number | string; failures: number | string } | undefined;
    return {
      calls: Number(sums?.calls ?? 0),
      failures: Number(sums?.failures ?? 0),
      consecutiveFailures: Number((rows[0] as { failure_streak: number | string } | undefined)?.failure_streak ?? 0),
    };
  }
}
