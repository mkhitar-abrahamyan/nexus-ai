import { OperationDuplicateError } from '../operations/errors.js';
import { assertSerializableRecord } from '../operations/serialization.js';
import {
  TERMINAL_OPERATION_STATUSES,
  type OperationRecord,
  type OperationStatus,
  type OperationStore,
  type OperationStoreFilter,
  type OperationStoreStats,
} from '../types/operations.js';
import {
  isSqliteUniqueViolation,
  quoteSqliteTable,
  type SqliteDatabaseLike,
  type SqliteLikeClient,
  toSqliteClient,
} from './client.js';

/** Options for the SQLite operation store. */
export interface SqliteOperationStoreOptions {
  /** Table name. Defaults to `nexus_operations`. */
  table?: string;
}

const DEFAULT_TABLE = 'nexus_operations';
const TERMINAL = TERMINAL_OPERATION_STATUSES.map((status) => `'${status}'`).join(', ');

/** The schema, as statements. Applied by `migrate()`, or by the application's own tooling. */
export function sqliteOperationStoreMigration(options: SqliteOperationStoreOptions = {}): string[] {
  const name = options.table ?? DEFAULT_TABLE;
  const table = quoteSqliteTable(name);
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  idempotency_key TEXT,
  lease_expires_at TEXT,
  kind TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  doc TEXT NOT NULL
)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "${name}_idempotency_key" ON ${table} (idempotency_key) WHERE idempotency_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS "${name}_recovery" ON ${table} (status, lease_expires_at)`,
  ];
}

/**
 * Operation records in SQLite: durable operations, and — through `OperationStoreCheckpointer` — graph
 * and workflow checkpoints, on one machine with no server to run.
 *
 * The same contract as the memory, Redis, and Postgres stores, checked by the same tests. Every update
 * is one `UPDATE … WHERE sequence = expected`, so two processes sharing the file cannot both win, and
 * idempotency keys are unique in the table.
 */
export class SqliteOperationStore<TResult = unknown> implements OperationStore<TResult> {
  private readonly client: SqliteLikeClient;
  private readonly table: string;

  constructor(
    database: SqliteLikeClient | SqliteDatabaseLike,
    private readonly options: SqliteOperationStoreOptions = {},
  ) {
    this.client = toSqliteClient(database);
    this.table = quoteSqliteTable(options.table ?? DEFAULT_TABLE);
  }

  /** Creates the table and indexes if they do not exist. Never runs implicitly. */
  async migrate(): Promise<void> {
    for (const statement of sqliteOperationStoreMigration(this.options)) await this.client.exec(statement);
  }

  /**
   * Inserts a new record. Throws `OperationDuplicateError` when its idempotency key is already
   * claimed. Refuses records carrying raw bytes.
   */
  async create(record: OperationRecord<TResult>): Promise<void> {
    assertSerializableRecord(record);
    try {
      await this.client.run(
        `INSERT INTO ${this.table} (id, status, sequence, idempotency_key, lease_expires_at, kind, created_at, updated_at, doc)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET status = excluded.status, sequence = excluded.sequence,
           idempotency_key = excluded.idempotency_key, lease_expires_at = excluded.lease_expires_at,
           kind = excluded.kind, created_at = excluded.created_at, updated_at = excluded.updated_at, doc = excluded.doc`,
        [
          record.id,
          record.status,
          record.sequence,
          record.idempotencyKey ?? null,
          record.lease?.expiresAt ?? null,
          record.kind ?? null,
          record.createdAt,
          record.updatedAt,
          JSON.stringify(record),
        ],
      );
    } catch (error) {
      if (record.idempotencyKey && isSqliteUniqueViolation(error)) {
        throw new OperationDuplicateError(record.idempotencyKey);
      }
      throw error;
    }
  }

  /** Reads a record. */
  async read(id: string): Promise<OperationRecord<TResult> | undefined> {
    return this.one(`SELECT doc FROM ${this.table} WHERE id = ?`, [id]);
  }

  /**
   * Writes a record when its stored sequence still equals `expectedSequence`, in one statement.
   * Resolves false when another writer got there first.
   */
  async update(record: OperationRecord<TResult>, expectedSequence: number): Promise<boolean> {
    assertSerializableRecord(record);
    const result = await this.client.run(
      `UPDATE ${this.table} SET status = ?, sequence = ?, lease_expires_at = ?, kind = ?, updated_at = ?, doc = ?
       WHERE id = ? AND sequence = ?`,
      [
        record.status,
        record.sequence,
        record.lease?.expiresAt ?? null,
        record.kind ?? null,
        record.updatedAt,
        JSON.stringify(record),
        record.id,
        expectedSequence,
      ],
    );
    return result.changes === 1;
  }

  /** Deletes a record. Resolves true when it existed. */
  async delete(id: string): Promise<boolean> {
    return (await this.client.run(`DELETE FROM ${this.table} WHERE id = ?`, [id])).changes > 0;
  }

  /**
   * Records whose lease has expired, or running records without one, up to `limit`, for another
   * worker to take over.
   */
  async claimExpired(now: string, limit: number): Promise<Array<OperationRecord<TResult>>> {
    return this.many(
      `SELECT doc FROM ${this.table}
       WHERE status NOT IN (${TERMINAL})
         AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
         AND (status = 'running' OR lease_expires_at IS NOT NULL)
       ORDER BY updated_at
       LIMIT ?`,
      [now, limit],
    );
  }

  /** Finds the record that claimed an idempotency key. */
  async findByIdempotencyKey(key: string): Promise<OperationRecord<TResult> | undefined> {
    return this.one(`SELECT doc FROM ${this.table} WHERE idempotency_key = ?`, [key]);
  }

  /** Every record, oldest first. */
  async list(): Promise<Array<OperationRecord<TResult>>> {
    return this.many(`SELECT doc FROM ${this.table} ORDER BY created_at, id`, []);
  }

  /** Queued records no worker holds, oldest first, in one indexed query. */
  async listQueued(limit: number, filter?: OperationStoreFilter): Promise<Array<OperationRecord<TResult>>> {
    const params: Array<string | number> = [new Date().toISOString()];
    let kind = '';
    if (filter?.kindPrefix) {
      params.push(filter.kindPrefix, filter.kindPrefix);
      kind = ' AND substr(kind, 1, length(?)) = ?';
    }
    params.push(limit);
    return this.many(
      `SELECT doc FROM ${this.table}
       WHERE status = 'queued' AND (lease_expires_at IS NULL OR lease_expires_at <= ?)${kind}
       ORDER BY created_at, id
       LIMIT ?`,
      params,
    );
  }

  /** Counts unfinished records by status in one grouped query. */
  async stats(now: string, filter?: OperationStoreFilter): Promise<OperationStoreStats> {
    const params: Array<string | number> = [now];
    let kind = '';
    if (filter?.kindPrefix) {
      params.push(filter.kindPrefix, filter.kindPrefix);
      kind = ' AND substr(kind, 1, length(?)) = ?';
    }
    const rows = (await this.client.all(
      `SELECT status, count(*) AS count,
         min(CASE WHEN status = 'queued' THEN created_at END) AS oldest,
         sum(CASE WHEN status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?) THEN 1 ELSE 0 END) AS lapsed
       FROM ${this.table}
       WHERE status NOT IN (${TERMINAL})${kind}
       GROUP BY status`,
      params,
    )) as Array<{ status: OperationStatus; count: number; oldest: string | null; lapsed: number }>;
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

  /** Deletes finished records last updated before a cutoff, returning how many went. */
  async prune(before: string): Promise<number> {
    return (
      await this.client.run(`DELETE FROM ${this.table} WHERE status IN (${TERMINAL}) AND updated_at < ?`, [before])
    ).changes;
  }

  private async one(sql: string, params: Array<string | number>): Promise<OperationRecord<TResult> | undefined> {
    const [row] = (await this.client.all(sql, params)) as Array<{ doc: string }>;
    return row ? (JSON.parse(row.doc) as OperationRecord<TResult>) : undefined;
  }

  private async many(sql: string, params: Array<string | number>): Promise<Array<OperationRecord<TResult>>> {
    const rows = (await this.client.all(sql, params)) as Array<{ doc: string }>;
    return rows.map((row) => JSON.parse(row.doc) as OperationRecord<TResult>);
  }
}
