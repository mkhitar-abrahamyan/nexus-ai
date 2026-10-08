import type { TenantUsageStore } from '../server/tenancy.js';
import type { MigrationResult, SchemaMigration } from '../utils/schema-migrations.js';
import { type PostgresLikeClient, quoteTable } from './client.js';
import type { PostgresMigrateOptions } from './migrations.js';

/** Options for `PostgresTenantUsage`. */
export interface PostgresTenantUsageOptions {
  /** Table name, optionally schema-qualified. Defaults to `nexus_tenant_usage`. */
  table?: string;
  /** Clock for slot leases and spending periods, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

/** The schema, as statements: every migration's, in order. */
export function tenantUsageMigration(options: Pick<PostgresTenantUsageOptions, 'table'> = {}): string[] {
  return tenantUsageMigrations(options).flatMap((migration) => [...migration.statements]);
}

/** The versioned schema, which `migrate()` and `nexus db migrate` apply. */
export function tenantUsageMigrations(options: Pick<PostgresTenantUsageOptions, 'table'> = {}): SchemaMigration[] {
  const name = options.table ?? 'nexus_tenant_usage';
  return [
    {
      component: `tenancy:${name}`,
      version: 1,
      name: 'create the tenant usage table',
      statements: [
        `CREATE TABLE IF NOT EXISTS ${quoteTable(name)} (
  key text PRIMARY KEY,
  slots jsonb NOT NULL DEFAULT '{}'::jsonb,
  total double precision NOT NULL DEFAULT 0,
  reset_at double precision
)`,
      ],
    },
  ];
}

/**
 * Tenant usage in Postgres, shared by every replica, for a deployment that already runs Postgres
 * and not Redis. Pass it to `tenantLimits({ usage })`.
 *
 * Each key is one row: a tenant's active slots as a JSON map from run to lease expiry, or its spending
 * in the current period. Every step is a single statement on that row, and Postgres applies
 * concurrent updates of one row one at a time, re-checking each against the newest version. Two
 * replicas admitting runs for one tenant at the same moment therefore cannot both take its last slot.
 */
export class PostgresTenantUsage implements TenantUsageStore {
  private readonly table: string;
  private readonly now: () => number;

  constructor(
    private readonly client: PostgresLikeClient,
    private readonly options: PostgresTenantUsageOptions = {},
  ) {
    this.table = quoteTable(options.table ?? 'nexus_tenant_usage');
    this.now = options.now ?? Date.now;
  }

  /** Creates the table, or brings it up to date. */
  async migrate(options: PostgresMigrateOptions = {}): Promise<MigrationResult> {
    const { applyPostgresMigrations } = await import('./migrations.js');
    return applyPostgresMigrations(this.client, tenantUsageMigrations(this.options), options);
  }

  /** Takes a slot for `member` unless `max` live slots are held. Holding one already counts as taken. */
  async acquire(key: string, member: string, max: number, ttlMs: number): Promise<boolean> {
    const now = this.now();
    await this.client.query(`INSERT INTO ${this.table} (key) VALUES ($1) ON CONFLICT (key) DO NOTHING`, [key]);
    // The live slots, without the lapsed ones; written back only when the slot is taken.
    const live = `(SELECT COALESCE(jsonb_object_agg(slot.member, slot.expires), '{}'::jsonb)
      FROM jsonb_each(${this.table}.slots) AS slot(member, expires)
      WHERE (slot.expires #>> '{}')::double precision > $3)`;
    const { rows } = await this.client.query(
      `UPDATE ${this.table}
       SET slots = CASE WHEN ${live} ? $2 THEN ${live} ELSE ${live} || jsonb_build_object($2::text, $4::double precision) END
       WHERE key = $1 AND (${live} ? $2 OR (SELECT count(*) FROM jsonb_object_keys(${live})) < $5)
       RETURNING key`,
      [key, member, now, now + ttlMs, max],
    );
    return rows.length > 0;
  }

  /** Frees a slot. Freeing one that is not held does nothing. */
  async release(key: string, member: string): Promise<void> {
    await this.client.query(`UPDATE ${this.table} SET slots = slots - $2::text WHERE key = $1`, [key, member]);
  }

  /** Live slots held under a key. */
  async count(key: string): Promise<number> {
    const { rows } = await this.client.query(
      `SELECT count(*)::int AS held FROM ${this.table}, jsonb_each(${this.table}.slots) AS slot(member, expires)
       WHERE key = $1 AND (slot.expires #>> '{}')::double precision > $2`,
      [key, this.now()],
    );
    return Number((rows[0] as { held?: unknown } | undefined)?.held ?? 0);
  }

  /** Adds to a total that resets at `resetAt`, and resolves to the new total. */
  async add(key: string, amount: number, resetAt: number): Promise<number> {
    const { rows } = await this.client.query(
      `INSERT INTO ${this.table} (key, total, reset_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET
         total = CASE WHEN ${this.table}.reset_at IS NOT NULL AND ${this.table}.reset_at <= $4
           THEN EXCLUDED.total ELSE ${this.table}.total + EXCLUDED.total END,
         reset_at = EXCLUDED.reset_at
       RETURNING total`,
      [key, amount, resetAt, this.now()],
    );
    return Number((rows[0] as { total?: unknown } | undefined)?.total ?? 0);
  }

  /** A total, or 0 once its period has reset. */
  async total(key: string): Promise<number> {
    const { rows } = await this.client.query(
      `SELECT CASE WHEN reset_at IS NULL OR reset_at > $2 THEN total ELSE 0 END AS total FROM ${this.table} WHERE key = $1`,
      [key, this.now()],
    );
    return Number((rows[0] as { total?: unknown } | undefined)?.total ?? 0);
  }
}
