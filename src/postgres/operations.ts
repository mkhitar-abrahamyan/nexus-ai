import { OperationDuplicateError } from '../operations/errors.js';
import { assertSerializableRecord } from '../operations/serialization.js';
import type {
  OperationRecord,
  OperationStatus,
  OperationStore,
  OperationStoreFilter,
  OperationStoreStats,
} from '../types/operations.js';
import { TERMINAL_OPERATION_STATUSES } from '../types/operations.js';
import type { MigrationResult, SchemaMigration } from '../utils/schema-migrations.js';
import { fromJson, isUniqueViolation, type PostgresLikeClient, quoteDerived, quoteTable } from './client.js';
import type { PostgresMigrateOptions } from './migrations.js';

/** Options for the Postgres operation store. */
export interface PostgresOperationStoreOptions {
  /** Table name, optionally schema-qualified. Defaults to `nexus_operations`. */
  table?: string;
}

const DEFAULT_TABLE = 'nexus_operations';
const TERMINAL = TERMINAL_OPERATION_STATUSES.map((status) => `'${status}'`).join(', ');

/** The schema, as statements: every migration's, in order. For `nexus db sql` or the application's own tooling. */
export function operationStoreMigration(options: PostgresOperationStoreOptions = {}): string[] {
  return operationStoreMigrations(options).flatMap((migration) => [...migration.statements]);
}

/**
 * The versioned schema, which `migrate()` and `nexus db migrate` apply. Version 1 is the 2.0 table;
 * version 2 indexes queued work by age, so a claim reads the oldest few rows instead of sorting the
 * queue; version 3 indexes queued work by tenant.
 */
export function operationStoreMigrations(options: PostgresOperationStoreOptions = {}): SchemaMigration[] {
  const name = options.table ?? DEFAULT_TABLE;
  const table = quoteTable(name);
  const component = `operations:${name}`;
  return [
    { component, version: 1, name: 'create the operations table', statements: createStatements(name, table) },
    {
      component,
      version: 2,
      name: 'index queued work by age',
      statements: [
        `CREATE INDEX IF NOT EXISTS ${quoteDerived(name, 'queued')} ON ${table} (created_at, id) WHERE status = 'queued'`,
      ],
    },
    {
      component,
      version: 3,
      name: 'index queued work by tenant',
      statements: [
        `CREATE INDEX IF NOT EXISTS ${quoteDerived(name, 'tenant_queued')} ON ${table} ((doc ->> 'tenantId'), created_at, id) WHERE status = 'queued'`,
      ],
    },
  ];
}

function createStatements(name: string, table: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
  id text PRIMARY KEY,
  status text NOT NULL,
  sequence integer NOT NULL,
  idempotency_key text,
  lease_expires_at text COLLATE "C",
  kind text,
  created_at text COLLATE "C" NOT NULL,
  updated_at text COLLATE "C" NOT NULL,
  doc jsonb NOT NULL
)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${quoteDerived(name, 'idempotency_key')} ON ${table} (idempotency_key) WHERE idempotency_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS ${quoteDerived(name, 'recovery')} ON ${table} (status, lease_expires_at)`,
  ];
}

/**
 * Operation records in Postgres.
 *
 * Every update is one `UPDATE … WHERE sequence = expected`, which is atomic without a transaction,
 * so lease stealing is prevented exactly rather than narrowed. Idempotency keys are unique in the
 * table: when two workers race to create the same operation, the loser gets
 * `OperationDuplicateError` and the runner attaches it to the winner's operation instead of running
 * the work twice. That is also what makes graph checkpoints durable across workers when this store
 * backs an `OperationStoreCheckpointer`.
 *
 * Timestamps are ISO strings in `C`-collated text, which compares exactly as the in-memory store's
 * string comparison does.
 */
export class PostgresOperationStore<TResult = unknown> implements OperationStore<TResult> {
  private readonly table: string;

  constructor(
    private readonly client: PostgresLikeClient,
    private readonly options: PostgresOperationStoreOptions = {},
  ) {
    this.table = quoteTable(options.table ?? DEFAULT_TABLE);
  }

  /**
   * Applies this store's pending migrations, recorded in `nexus_schema_migrations`, under a lock.
   * Never runs implicitly. Safe on a database an older release created: what exists is kept.
   */
  async migrate(options: PostgresMigrateOptions = {}): Promise<MigrationResult> {
    // Loaded when called, so an application that migrates elsewhere never imports the runner.
    const { applyPostgresMigrations } = await import('./migrations.js');
    return applyPostgresMigrations(this.client, operationStoreMigrations(this.options), options);
  }

  /**
   * Inserts a new record. Throws `OperationDuplicateError` when its idempotency key is already
   * claimed. Refuses records carrying raw bytes.
   */
  async create(record: OperationRecord<TResult>): Promise<void> {
    assertSerializableRecord(record);
    try {
      await this.client.query(
        `INSERT INTO ${this.table} (id, status, sequence, idempotency_key, lease_expires_at, kind, created_at, updated_at, doc)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, sequence = EXCLUDED.sequence,
           idempotency_key = EXCLUDED.idempotency_key, lease_expires_at = EXCLUDED.lease_expires_at,
           kind = EXCLUDED.kind, created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at, doc = EXCLUDED.doc`,
        this.columns(record),
      );
    } catch (error) {
      if (record.idempotencyKey && isUniqueViolation(error)) throw new OperationDuplicateError(record.idempotencyKey);
      throw error;
    }
  }

  /** Reads a record. */
  async read(id: string): Promise<OperationRecord<TResult> | undefined> {
    const { rows } = await this.client.query(`SELECT doc::text AS doc FROM ${this.table} WHERE id = $1`, [id]);
    return rows[0] ? fromJson<OperationRecord<TResult>>((rows[0] as { doc: unknown }).doc) : undefined;
  }

  /**
   * Writes a record when its stored sequence still equals `expectedSequence`, in one statement.
   * Resolves false when another worker got there first.
   */
  async update(record: OperationRecord<TResult>, expectedSequence: number): Promise<boolean> {
    assertSerializableRecord(record);
    // Every parameter is referenced: Postgres refuses one whose type it cannot infer. The
    // idempotency key is fixed when the operation is created, as in every other store.
    const result = await this.client.query(
      `UPDATE ${this.table} SET status = $2, sequence = $3, lease_expires_at = $4, kind = $5,
         updated_at = $6, doc = $7::jsonb
       WHERE id = $1 AND sequence = $8`,
      [
        record.id,
        record.status,
        record.sequence,
        record.lease?.expiresAt ?? null,
        record.kind ?? null,
        record.updatedAt,
        JSON.stringify(record),
        expectedSequence,
      ],
    );
    return (result.rowCount ?? 0) === 1;
  }

  /** Deletes a record. Resolves true when it existed. */
  async delete(id: string): Promise<boolean> {
    const { rows } = await this.client.query(`DELETE FROM ${this.table} WHERE id = $1 RETURNING id`, [id]);
    return rows.length > 0;
  }

  /**
   * Records whose lease has expired, or running records without one, up to `limit`, for another
   * worker to take over.
   */
  async claimExpired(now: string, limit: number): Promise<Array<OperationRecord<TResult>>> {
    const { rows } = await this.client.query(
      `SELECT doc::text AS doc FROM ${this.table}
       WHERE status NOT IN (${TERMINAL})
         AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
         AND (status = 'running' OR lease_expires_at IS NOT NULL)
       ORDER BY updated_at
       LIMIT $2`,
      [now, limit],
    );
    return rows.map((row) => fromJson<OperationRecord<TResult>>((row as { doc: unknown }).doc));
  }

  /** Finds the record that claimed an idempotency key. */
  async findByIdempotencyKey(key: string): Promise<OperationRecord<TResult> | undefined> {
    const { rows } = await this.client.query(`SELECT doc::text AS doc FROM ${this.table} WHERE idempotency_key = $1`, [
      key,
    ]);
    return rows[0] ? fromJson<OperationRecord<TResult>>((rows[0] as { doc: unknown }).doc) : undefined;
  }

  /** Every record, oldest first. */
  async list(): Promise<Array<OperationRecord<TResult>>> {
    const { rows } = await this.client.query(`SELECT doc::text AS doc FROM ${this.table} ORDER BY created_at, id`);
    return rows.map((row) => fromJson<OperationRecord<TResult>>((row as { doc: unknown }).doc));
  }

  /** Queued records no worker holds, oldest first, in one indexed query. */
  async listQueued(limit: number, filter?: OperationStoreFilter): Promise<Array<OperationRecord<TResult>>> {
    const params: unknown[] = [new Date().toISOString(), limit];
    const narrowed = filterSql(filter, params);
    const { rows } = await this.client.query(
      `SELECT doc::text AS doc FROM ${this.table}
       WHERE status = 'queued' AND (lease_expires_at IS NULL OR lease_expires_at <= $1)${narrowed}
       ORDER BY created_at, id
       LIMIT $2`,
      params,
    );
    return rows.map((row) => fromJson<OperationRecord<TResult>>((row as { doc: unknown }).doc));
  }

  /** Counts unfinished records by status in one grouped query. */
  async stats(now: string, filter?: OperationStoreFilter): Promise<OperationStoreStats> {
    const params: unknown[] = [now];
    const narrowed = filterSql(filter, params);
    const { rows } = await this.client.query(
      `SELECT status, count(*)::int AS count,
         min(created_at) FILTER (WHERE status = 'queued') AS oldest,
         count(*) FILTER (WHERE status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= $1))::int AS lapsed
       FROM ${this.table}
       WHERE status NOT IN (${TERMINAL})${narrowed}
       GROUP BY status`,
      params,
    );
    return statsFromRows(rows as StatsRow[]);
  }

  /**
   * Deletes finished records last updated before a cutoff, returning how many went. The in-memory
   * store evicts on its own; a table needs a retention job to call this.
   */
  async prune(before: string): Promise<number> {
    const result = await this.client.query(
      `DELETE FROM ${this.table} WHERE status IN (${TERMINAL}) AND updated_at < $1`,
      [before],
    );
    return result.rowCount ?? 0;
  }

  private columns(record: OperationRecord<TResult>): unknown[] {
    return [
      record.id,
      record.status,
      record.sequence,
      record.idempotencyKey ?? null,
      record.lease?.expiresAt ?? null,
      record.kind ?? null,
      record.createdAt,
      record.updatedAt,
      JSON.stringify(record),
    ];
  }
}

/**
 * The conditions a store filter adds, with their parameters appended. The tenant is read as
 * `doc ->> 'tenantId'`, the expression the tenant index of queued work covers.
 */
function filterSql(filter: OperationStoreFilter | undefined, params: unknown[]): string {
  let sql = '';
  if (filter?.kindPrefix) {
    params.push(filter.kindPrefix);
    sql += ` AND substr(kind, 1, char_length($${params.length})) = $${params.length}`;
  }
  if (filter?.tenantId !== undefined) {
    params.push(filter.tenantId);
    sql += ` AND doc ->> 'tenantId' = $${params.length}`;
  }
  return sql;
}

/** One row of the grouped stats query. */
interface StatsRow {
  status: OperationStatus;
  count: number | string;
  oldest: string | null;
  lapsed: number | string;
}

/** Folds the grouped stats query into the store-neutral shape. */
function statsFromRows(rows: readonly StatsRow[]): OperationStoreStats {
  const byStatus: Partial<Record<OperationStatus, number>> = {};
  let oldestQueuedAt: string | undefined;
  let lapsedLeases = 0;
  for (const row of rows) {
    byStatus[row.status] = Number(row.count);
    if (row.oldest && (!oldestQueuedAt || row.oldest < oldestQueuedAt)) oldestQueuedAt = row.oldest;
    lapsedLeases += Number(row.lapsed);
  }
  return { byStatus, ...(oldestQueuedAt ? { oldestQueuedAt } : {}), lapsedLeases };
}
