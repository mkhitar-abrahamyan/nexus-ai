import { assembleTree } from '../tracing/query.js';
import type { Run, RunFeedback, RunQuery, RunTree, TraceStore } from '../types/tracing.js';
import type { MigrationResult, SchemaMigration } from '../utils/schema-migrations.js';
import { fromJson, type PostgresLikeClient, quoteDerived, quoteTable } from './client.js';
import type { PostgresMigrateOptions } from './migrations.js';
import { jsonFieldEquals, SqlParams } from './sql.js';

/** Options for the Postgres trace store. */
export interface PostgresTraceStoreOptions {
  /** Table name, optionally schema-qualified. Defaults to `nexus_runs`. */
  table?: string;
}

const DEFAULT_TABLE = 'nexus_runs';

/** The schema, as statements: every migration's, in order. */
export function traceStoreMigration(options: PostgresTraceStoreOptions = {}): string[] {
  return traceStoreMigrations(options).flatMap((migration) => [...migration.statements]);
}

/**
 * The versioned schema, which `migrate()` and `nexus db migrate` apply. Version 1 is the 2.0 table;
 * version 2 indexes runs by `metadata.tenantId`, which a tenant-scoped trace store filters on.
 */
export function traceStoreMigrations(options: PostgresTraceStoreOptions = {}): SchemaMigration[] {
  const name = options.table ?? DEFAULT_TABLE;
  const table = quoteTable(name);
  const component = `traces:${name}`;
  return [
    { component, version: 1, name: 'create the runs table', statements: createStatements(name, table) },
    {
      component,
      version: 2,
      name: 'index runs by tenant',
      statements: [
        `CREATE INDEX IF NOT EXISTS ${quoteDerived(name, 'tenant_started')} ON ${table} ((doc #>> '{metadata,tenantId}'), started_at DESC)`,
      ],
    },
  ];
}

function createStatements(name: string, table: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
  id text PRIMARY KEY,
  trace_id text NOT NULL,
  parent_id text,
  name text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  started_at text COLLATE "C" NOT NULL,
  latency_ms double precision,
  cost double precision,
  model text,
  provider text,
  doc jsonb NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS ${quoteDerived(name, 'trace')} ON ${table} (trace_id)`,
    `CREATE INDEX IF NOT EXISTS ${quoteDerived(name, 'started')} ON ${table} (started_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ${quoteDerived(name, 'status_started')} ON ${table} (status, started_at DESC)`,
  ];
}

/**
 * Traces in Postgres.
 *
 * Every filter of a `RunQuery` — tags, metadata paths, and feedback keys included — becomes one SQL
 * condition, so paging happens in the database and a query means exactly what it means against the
 * in-memory store. Feedback is appended in one statement, so two evaluators scoring one run at the
 * same moment both land.
 */
export class PostgresTraceStore implements TraceStore {
  private readonly table: string;

  constructor(
    private readonly client: PostgresLikeClient,
    private readonly options: PostgresTraceStoreOptions = {},
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
    return applyPostgresMigrations(this.client, traceStoreMigrations(this.options), options);
  }

  /** Stores a run, replacing an earlier version with the same id. */
  async save(run: Run): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.table} (id, trace_id, parent_id, name, kind, status, started_at, latency_ms, cost, model, provider, doc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       ON CONFLICT (id) DO UPDATE SET trace_id = EXCLUDED.trace_id, parent_id = EXCLUDED.parent_id,
         name = EXCLUDED.name, kind = EXCLUDED.kind, status = EXCLUDED.status, started_at = EXCLUDED.started_at,
         latency_ms = EXCLUDED.latency_ms, cost = EXCLUDED.cost, model = EXCLUDED.model,
         provider = EXCLUDED.provider, doc = EXCLUDED.doc`,
      [
        run.id,
        run.traceId,
        run.parentId ?? null,
        run.name,
        run.kind,
        run.status,
        run.startedAt,
        run.latencyMs ?? null,
        run.cost ?? null,
        run.model ?? null,
        run.provider ?? null,
        JSON.stringify(run),
      ],
    );
  }

  /** Reads a run. */
  async get(runId: string): Promise<Run | undefined> {
    const { rows } = await this.client.query(`SELECT doc::text AS doc FROM ${this.table} WHERE id = $1`, [runId]);
    return rows[0] ? fromJson<Run>((rows[0] as { doc: unknown }).doc) : undefined;
  }

  /** Runs matching a query, filtered and ordered in SQL. */
  async query(query: RunQuery = {}): Promise<Run[]> {
    const params = new SqlParams();
    const where: string[] = [];
    // Truthiness mirrors the in-memory query: an empty string is no filter, not a filter for "".
    if (query.traceId) where.push(`trace_id = ${params.add(query.traceId)}`);
    if (query.kind !== undefined) {
      const kinds = Array.isArray(query.kind) ? query.kind : [query.kind];
      where.push(kinds.length ? `kind IN (${kinds.map((kind) => params.add(kind)).join(', ')})` : 'FALSE');
    }
    if (query.status) where.push(`status = ${params.add(query.status)}`);
    if (query.name) where.push(`name = ${params.add(query.name)}`);
    if (query.model) where.push(`model = ${params.add(query.model)}`);
    if (query.provider) where.push(`provider = ${params.add(query.provider)}`);
    if (query.tags?.length) where.push(`(doc -> 'tags') @> ${params.add(JSON.stringify(query.tags))}::jsonb`);
    if (query.minLatencyMs !== undefined) where.push(`coalesce(latency_ms, 0) >= ${params.add(query.minLatencyMs)}`);
    if (query.minCost !== undefined) where.push(`coalesce(cost, 0) >= ${params.add(query.minCost)}`);
    if (query.since) where.push(`started_at >= ${params.add(query.since)}`);
    if (query.until) where.push(`started_at <= ${params.add(query.until)}`);
    if (query.feedbackKey) {
      where.push(
        `EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(doc -> 'feedback', '[]'::jsonb)) AS item WHERE item ->> 'key' = ${params.add(query.feedbackKey)})`,
      );
    }
    for (const [field, expected] of Object.entries(query.metadata ?? {})) {
      // A tenant filter reads the expression the tenant index covers; the type check keeps the
      // in-memory meaning, where the number 7 is not the string "7".
      if (field === 'tenantId' && typeof expected === 'string') {
        where.push(
          `doc #>> '{metadata,tenantId}' = ${params.add(expected)} AND jsonb_typeof(doc #> '{metadata,tenantId}') = 'string'`,
        );
        continue;
      }
      where.push(jsonFieldEquals(`(doc -> 'metadata')`, field, expected, params));
    }

    const { rows } = await this.client.query(
      `SELECT doc::text AS doc FROM ${this.table}
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY started_at DESC, id
       LIMIT ${params.add(query.limit ?? 50)} OFFSET ${params.add(query.offset ?? 0)}`,
      params.values,
    );
    return rows.map((row) => fromJson<Run>((row as { doc: unknown }).doc));
  }

  /** A trace's runs, assembled into a tree. */
  async tree(traceId: string): Promise<RunTree | undefined> {
    const { rows } = await this.client.query(
      `SELECT doc::text AS doc FROM ${this.table} WHERE trace_id = $1 ORDER BY started_at, id`,
      [traceId],
    );
    return assembleTree(rows.map((row) => fromJson<Run>((row as { doc: unknown }).doc)));
  }

  /** Appends feedback to a run in one statement. */
  async addFeedback(runId: string, feedback: RunFeedback): Promise<void> {
    await this.client.query(
      `UPDATE ${this.table}
       SET doc = jsonb_set(doc, '{feedback}', coalesce(doc -> 'feedback', '[]'::jsonb) || jsonb_build_array($2::jsonb))
       WHERE id = $1`,
      [runId, JSON.stringify(feedback)],
    );
  }

  /** Deletes runs started before an ISO-8601 time, returning how many went. */
  async prune(before: string): Promise<number> {
    const result = await this.client.query(`DELETE FROM ${this.table} WHERE started_at < $1`, [before]);
    return result.rowCount ?? 0;
  }
}
