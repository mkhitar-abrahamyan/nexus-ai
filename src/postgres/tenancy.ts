import type { BudgetReservationChange } from '../lifecycle/reservations.js';
import type { TenantUsageStore } from '../server/tenancy.js';
import type { BudgetReservationRecord } from '../types/lifecycle.js';
import type { MigrationResult, SchemaMigration } from '../utils/schema-migrations.js';
import { type PostgresLikeClient, quoteDerived, quoteTable } from './client.js';
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

/**
 * The versioned schema, which `migrate()` and `nexus db migrate` apply. Version 1 is the usage table;
 * version 2 adds the budget reservations table beside it, `<table>_reservations`.
 */
export function tenantUsageMigrations(options: Pick<PostgresTenantUsageOptions, 'table'> = {}): SchemaMigration[] {
  const name = options.table ?? 'nexus_tenant_usage';
  const reservations = `${name}_reservations`;
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
    {
      component: `tenancy:${name}`,
      version: 2,
      name: 'record budget reservations',
      statements: [
        `CREATE TABLE IF NOT EXISTS ${quoteTable(reservations)} (
  id text PRIMARY KEY,
  key text NOT NULL,
  store_key text NOT NULL,
  reset_at double precision NOT NULL,
  amount double precision NOT NULL,
  charged double precision NOT NULL,
  operation_id text NOT NULL,
  family text,
  operation text,
  status text NOT NULL,
  leased_until double precision NOT NULL,
  created_at double precision NOT NULL,
  actual double precision,
  settled_at double precision
)`,
        `CREATE INDEX IF NOT EXISTS ${quoteDerived(reservations, 'lapsing')} ON ${quoteTable(reservations)} (leased_until) WHERE status = 'reserved'`,
        `CREATE INDEX IF NOT EXISTS ${quoteDerived(reservations, 'lapsing_operation')} ON ${quoteTable(reservations)} (operation, leased_until) WHERE status = 'reserved'`,
      ],
    },
  ];
}

const RESERVATION_COLUMNS =
  'id, key, store_key, reset_at, amount, charged, operation_id, family, operation, status, leased_until, created_at, actual, settled_at';

function reservationOf(row: Record<string, unknown>): BudgetReservationRecord {
  return {
    id: String(row.id),
    key: String(row.key),
    storeKey: String(row.store_key),
    resetAt: Number(row.reset_at),
    amount: Number(row.amount),
    charged: Number(row.charged),
    operationId: String(row.operation_id),
    ...(row.family === null || row.family === undefined
      ? {}
      : { family: String(row.family) as BudgetReservationRecord['family'] }),
    ...(row.operation === null || row.operation === undefined ? {} : { operation: String(row.operation) }),
    status: String(row.status) as BudgetReservationRecord['status'],
    leasedUntil: Number(row.leased_until),
    createdAt: Number(row.created_at),
    ...(row.actual === null || row.actual === undefined ? {} : { actual: Number(row.actual) }),
    ...(row.settled_at === null || row.settled_at === undefined ? {} : { settledAt: Number(row.settled_at) }),
  };
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
  private readonly reservations: string;
  private readonly now: () => number;
  private purgedAt = 0;

  constructor(
    private readonly client: PostgresLikeClient,
    private readonly options: PostgresTenantUsageOptions = {},
  ) {
    this.table = quoteTable(options.table ?? 'nexus_tenant_usage');
    this.reservations = quoteTable(`${options.table ?? 'nexus_tenant_usage'}_reservations`);
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

  /** Records a budget reservation and adds it to its total, in one statement. */
  async hold(record: BudgetReservationRecord): Promise<number> {
    const { rows } = await this.client.query(
      `WITH held AS (
         INSERT INTO ${this.reservations} (${RESERVATION_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reserved', $10, $11, NULL, NULL)
       )
       INSERT INTO ${this.table} (key, total, reset_at) VALUES ($3, $6, $4)
       ON CONFLICT (key) DO UPDATE SET
         total = CASE WHEN ${this.table}.reset_at IS NOT NULL AND ${this.table}.reset_at <= $11
           THEN EXCLUDED.total ELSE ${this.table}.total + EXCLUDED.total END,
         reset_at = EXCLUDED.reset_at
       RETURNING total`,
      [
        record.id,
        record.key,
        record.storeKey,
        record.resetAt,
        record.amount,
        record.charged,
        record.operationId,
        record.family ?? null,
        record.operation ?? null,
        record.leasedUntil,
        record.createdAt,
      ],
    );
    return Number((rows[0] as { total?: unknown } | undefined)?.total ?? 0);
  }

  /**
   * Moves a budget reservation and its total together, in one statement, if it stands where
   * `change.from` allows. The row is locked as it is read, so of two processes settling one
   * reservation at once, the second finds it moved and changes nothing.
   */
  async settle(id: string, change: BudgetReservationChange): Promise<boolean> {
    const { rows } = await this.client.query(
      `WITH old AS (
         SELECT id, store_key, reset_at, charged FROM ${this.reservations}
         WHERE id = $1 AND status = ANY($2::text[]) FOR UPDATE
       ), moved AS (
         UPDATE ${this.reservations} AS reservation
         SET status = $3, charged = $4, settled_at = $5, actual = COALESCE($6, reservation.actual)
         FROM old WHERE reservation.id = old.id
         RETURNING old.store_key, old.reset_at, $4::double precision - old.charged AS delta
       ), totals AS (
         UPDATE ${this.table} AS usage SET total = usage.total + moved.delta
         FROM moved WHERE usage.key = moved.store_key AND moved.delta <> 0 AND moved.reset_at > $5
         RETURNING usage.key
       )
       SELECT (SELECT count(*) FROM moved)::int AS moved, (SELECT count(*) FROM totals)::int AS totals`,
      [id, [...change.from], change.status, change.charged, change.at, change.actual ?? null],
    );
    return Number((rows[0] as { moved?: unknown } | undefined)?.moved ?? 0) > 0;
  }

  /** Extends a reserved budget reservation's lease. */
  async renew(id: string, leasedUntil: number): Promise<boolean> {
    const { rows } = await this.client.query(
      `UPDATE ${this.reservations} SET leased_until = $2 WHERE id = $1 AND status = 'reserved' RETURNING id`,
      [id, leasedUntil],
    );
    return rows.length > 0;
  }

  /**
   * Reserved budget reservations whose lease lapsed by `now`, soonest lapsed first. At most once a
   * minute it also deletes what no report can change any more: reservations a day past their period,
   * and those settled, released, or expired an hour ago.
   */
  async lapsed(now: number, limit: number, operation?: string): Promise<BudgetReservationRecord[]> {
    if (now - this.purgedAt >= 60_000) {
      this.purgedAt = now;
      await this.client.query(
        `DELETE FROM ${this.reservations} WHERE id IN (
           SELECT id FROM ${this.reservations} WHERE status <> 'reserved'
             AND (reset_at + 86400000 < $1 OR (status <> 'uncertain' AND settled_at + 3600000 < $1))
           LIMIT 1000)`,
        [now],
      );
    }
    const { rows } = await this.client.query(
      `SELECT ${RESERVATION_COLUMNS} FROM ${this.reservations}
       WHERE status = 'reserved' AND leased_until <= $1 ${operation === undefined ? '' : 'AND operation = $3'}
       ORDER BY leased_until LIMIT $2`,
      operation === undefined ? [now, limit] : [now, limit, operation],
    );
    return rows.map((row) => reservationOf(row as Record<string, unknown>));
  }

  /** One budget reservation, while it is kept. */
  async reservation(id: string): Promise<BudgetReservationRecord | undefined> {
    const { rows } = await this.client.query(`SELECT ${RESERVATION_COLUMNS} FROM ${this.reservations} WHERE id = $1`, [
      id,
    ]);
    return rows[0] ? reservationOf(rows[0] as Record<string, unknown>) : undefined;
  }
}
