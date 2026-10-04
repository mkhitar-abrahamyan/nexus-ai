import {
  ROLLUP_LATENCY_BOUNDS_MS,
  type RollupKey,
  type RollupQuery,
  type RollupRow,
  type RollupStore,
  type RollupTotals,
} from '../tracing/rollups.js';
import type { MigrationResult, SchemaMigration } from '../utils/schema-migrations.js';
import { type PostgresLikeClient, quoteDerived, quoteTable } from './client.js';
import type { PostgresMigrateOptions } from './migrations.js';
import { SqlParams } from './sql.js';

/** Options for the Postgres rollup store. */
export interface PostgresRollupStoreOptions {
  /** Table name, optionally schema-qualified. Defaults to `nexus_rollups`. */
  table?: string;
}

const DEFAULT_TABLE = 'nexus_rollups';

/** The schema, as statements: every migration's, in order. */
export function rollupStoreMigration(options: PostgresRollupStoreOptions = {}): string[] {
  return rollupStoreMigrations(options).flatMap((migration) => [...migration.statements]);
}

/** The versioned schema, which `migrate()` and `nexus db migrate` apply. */
export function rollupStoreMigrations(options: PostgresRollupStoreOptions = {}): SchemaMigration[] {
  const name = options.table ?? DEFAULT_TABLE;
  const table = quoteTable(name);
  return [
    {
      component: `rollups:${name}`,
      version: 1,
      name: 'create the rollups table',
      statements: [
        `CREATE TABLE IF NOT EXISTS ${table} (
  hour text COLLATE "C" NOT NULL,
  kind text NOT NULL,
  name text NOT NULL,
  model text NOT NULL,
  provider text NOT NULL,
  tenant text NOT NULL,
  runs bigint NOT NULL,
  errors bigint NOT NULL,
  cost double precision NOT NULL,
  input_tokens bigint NOT NULL,
  output_tokens bigint NOT NULL,
  latency bigint[] NOT NULL,
  PRIMARY KEY (hour, kind, name, model, provider, tenant)
)`,
        `CREATE INDEX IF NOT EXISTS ${quoteDerived(name, 'tenant_hour')} ON ${table} (tenant, hour)`,
      ],
    },
  ];
}

/**
 * Rollup rows in Postgres, so a dashboard's totals live beside its traces and survive a restart.
 *
 * Adding to a row is one `INSERT … ON CONFLICT DO UPDATE` that sums every total, latency buckets
 * included, so two workers finishing runs in the same hour both count. A query reads only the rows
 * of its range: a month of one tenant is a few hundred rows, however many runs it held.
 */
export class PostgresRollupStore implements RollupStore {
  private readonly table: string;

  constructor(
    private readonly client: PostgresLikeClient,
    private readonly options: PostgresRollupStoreOptions = {},
  ) {
    this.table = quoteTable(options.table ?? DEFAULT_TABLE);
  }

  /**
   * Applies this store's pending migrations, recorded in `nexus_schema_migrations`, under a lock.
   * Never runs implicitly.
   */
  async migrate(options: PostgresMigrateOptions = {}): Promise<MigrationResult> {
    // Loaded when called, so an application that migrates elsewhere never imports the runner.
    const { applyPostgresMigrations } = await import('./migrations.js');
    return applyPostgresMigrations(this.client, rollupStoreMigrations(this.options), options);
  }

  /** Adds totals to the row for `key`, creating it, in one statement. */
  async add(key: RollupKey, totals: RollupTotals): Promise<void> {
    const t = this.table;
    await this.client.query(
      `INSERT INTO ${t} (hour, kind, name, model, provider, tenant, runs, errors, cost, input_tokens, output_tokens, latency)
       VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint, $9::double precision, $10::bigint, $11::bigint, $12::bigint[])
       ON CONFLICT (hour, kind, name, model, provider, tenant) DO UPDATE SET
         runs = ${t}.runs + EXCLUDED.runs,
         errors = ${t}.errors + EXCLUDED.errors,
         cost = ${t}.cost + EXCLUDED.cost,
         input_tokens = ${t}.input_tokens + EXCLUDED.input_tokens,
         output_tokens = ${t}.output_tokens + EXCLUDED.output_tokens,
         latency = ARRAY(
           SELECT coalesce(stored, 0) + coalesce(added, 0)
           FROM unnest(${t}.latency, EXCLUDED.latency) WITH ORDINALITY AS bucket(stored, added, position)
           ORDER BY position
         )`,
      [
        key.hour,
        key.kind,
        key.name,
        key.model,
        key.provider,
        key.tenant,
        totals.runs,
        totals.errors,
        totals.cost,
        totals.inputTokens,
        totals.outputTokens,
        `{${bucketsOf(totals.latency).join(',')}}`,
      ],
    );
  }

  /** Rows matching a query, oldest hour first, filtered as the in-memory store filters them. */
  async query(query: RollupQuery = {}): Promise<RollupRow[]> {
    const params = new SqlParams();
    const where: string[] = [];
    if (query.since) where.push(`hour >= ${params.add(hourOf(query.since))}`);
    if (query.until) where.push(`hour <= ${params.add(query.until)}`);
    if (query.kind !== undefined) {
      const kinds = Array.isArray(query.kind) ? query.kind : [query.kind];
      where.push(kinds.length ? `kind IN (${kinds.map((kind) => params.add(kind)).join(', ')})` : 'FALSE');
    }
    if (query.model !== undefined) where.push(`model = ${params.add(query.model)}`);
    if (query.provider !== undefined) where.push(`provider = ${params.add(query.provider)}`);
    if (query.tenant !== undefined) where.push(`tenant = ${params.add(query.tenant)}`);
    if (query.name !== undefined) where.push(`name = ${params.add(query.name)}`);
    const { rows } = await this.client.query(
      `SELECT hour, kind, name, model, provider, tenant, runs::text AS runs, errors::text AS errors, cost,
         input_tokens::text AS input_tokens, output_tokens::text AS output_tokens, latency::text AS latency
       FROM ${this.table}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY hour, kind, name, model, provider, tenant`,
      params.values,
    );
    return rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        hour: String(row.hour),
        kind: row.kind as RollupRow['kind'],
        name: String(row.name),
        model: String(row.model),
        provider: String(row.provider),
        tenant: String(row.tenant),
        runs: Number(row.runs),
        errors: Number(row.errors),
        cost: Number(row.cost),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        latency: String(row.latency).replace(/[{}]/g, '').split(',').filter(Boolean).map(Number),
      };
    });
  }
}

/** Latency counts padded to every bucket, so arrays of one table always line up. */
function bucketsOf(latency: readonly number[]): number[] {
  return Array.from({ length: ROLLUP_LATENCY_BOUNDS_MS.length + 1 }, (_, index) => Math.round(latency[index] ?? 0));
}

function hourOf(iso: string): string {
  const date = new Date(iso);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}
