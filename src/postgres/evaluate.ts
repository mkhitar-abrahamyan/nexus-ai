import type { Dataset, DatasetStore, Experiment, ExperimentStore } from '../types/evaluate.js';
import { fromJson, type PostgresLikeClient, quoteDerived, quoteTable, runStatements } from './client.js';

/** Options for the Postgres evaluation stores. */
export interface PostgresEvaluationStoreOptions {
  /** Datasets table. Defaults to `nexus_datasets`. */
  datasetsTable?: string;
  /** Experiments table. Defaults to `nexus_experiments`. */
  experimentsTable?: string;
}

/** The schema for both tables, as statements. */
export function evaluationStoreMigration(options: PostgresEvaluationStoreOptions = {}): string[] {
  const datasetsName = options.datasetsTable ?? 'nexus_datasets';
  const experimentsName = options.experimentsTable ?? 'nexus_experiments';
  const datasets = quoteTable(datasetsName);
  const experiments = quoteTable(experimentsName);
  return [
    `CREATE TABLE IF NOT EXISTS ${datasets} (
  name text NOT NULL,
  version text NOT NULL,
  created_at text COLLATE "C" NOT NULL,
  doc jsonb NOT NULL,
  PRIMARY KEY (name, version)
)`,
    `CREATE TABLE IF NOT EXISTS ${experiments} (
  id text PRIMARY KEY,
  name text NOT NULL,
  dataset_name text NOT NULL,
  dataset_version text NOT NULL,
  started_at text COLLATE "C" NOT NULL,
  doc jsonb NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS ${quoteDerived(experimentsName, 'dataset')} ON ${experiments} (dataset_name, started_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ${quoteDerived(experimentsName, 'name')} ON ${experiments} (name, started_at DESC)`,
  ];
}

/**
 * Dataset versions in Postgres, keyed by name and content version.
 *
 * Saving the same version twice replaces it, which is safe because a version is derived from the
 * examples: the same version is the same content.
 */
export class PostgresDatasetStore implements DatasetStore {
  private readonly table: string;

  constructor(
    private readonly client: PostgresLikeClient,
    private readonly options: PostgresEvaluationStoreOptions = {},
  ) {
    this.table = quoteTable(options.datasetsTable ?? 'nexus_datasets');
  }

  /** Creates both evaluation tables if they do not exist. Never runs implicitly. */
  async migrate(): Promise<void> {
    await runStatements(this.client, evaluationStoreMigration(this.options));
  }

  /** Stores a dataset version, replacing one with the same name and version. */
  async save(dataset: Dataset): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.table} (name, version, created_at, doc) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (name, version) DO UPDATE SET created_at = EXCLUDED.created_at, doc = EXCLUDED.doc`,
      [dataset.name, dataset.version, dataset.createdAt, JSON.stringify(dataset)],
    );
  }

  /** Returns a version, or the newest when none is given. */
  async get(name: string, version?: string): Promise<Dataset | undefined> {
    const { rows } = version
      ? await this.client.query(`SELECT doc::text AS doc FROM ${this.table} WHERE name = $1 AND version = $2`, [
          name,
          version,
        ])
      : await this.client.query(
          `SELECT doc::text AS doc FROM ${this.table} WHERE name = $1 ORDER BY created_at DESC, version LIMIT 1`,
          [name],
        );
    return rows[0] ? fromJson<Dataset>((rows[0] as { doc: unknown }).doc) : undefined;
  }

  /** Every dataset name with its versions. */
  async list(): Promise<Array<{ name: string; versions: string[] }>> {
    const { rows } = await this.client.query(
      `SELECT name, version FROM ${this.table} ORDER BY name, created_at, version`,
    );
    const byName = new Map<string, string[]>();
    for (const row of rows as Array<{ name: string; version: string }>) {
      byName.set(row.name, [...(byName.get(row.name) ?? []), row.version]);
    }
    return [...byName.entries()].map(([name, versions]) => ({ name, versions }));
  }
}

/** Experiments in Postgres, newest first by start time. */
export class PostgresExperimentStore implements ExperimentStore {
  private readonly table: string;

  constructor(
    private readonly client: PostgresLikeClient,
    private readonly options: PostgresEvaluationStoreOptions = {},
  ) {
    this.table = quoteTable(options.experimentsTable ?? 'nexus_experiments');
  }

  /** Creates both evaluation tables if they do not exist. Never runs implicitly. */
  async migrate(): Promise<void> {
    await runStatements(this.client, evaluationStoreMigration(this.options));
  }

  /** Stores an experiment, replacing one with the same id. */
  async save(experiment: Experiment): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.table} (id, name, dataset_name, dataset_version, started_at, doc)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, dataset_name = EXCLUDED.dataset_name,
         dataset_version = EXCLUDED.dataset_version, started_at = EXCLUDED.started_at, doc = EXCLUDED.doc`,
      [
        experiment.id,
        experiment.name,
        experiment.dataset.name,
        experiment.dataset.version,
        experiment.startedAt,
        JSON.stringify(experiment),
      ],
    );
  }

  /** Reads an experiment by id. */
  async get(id: string): Promise<Experiment | undefined> {
    const { rows } = await this.client.query(`SELECT doc::text AS doc FROM ${this.table} WHERE id = $1`, [id]);
    return rows[0] ? fromJson<Experiment>((rows[0] as { doc: unknown }).doc) : undefined;
  }

  /** Experiments, newest first, filtered by name or dataset. Defaults to 50. */
  async list(filter: { name?: string; dataset?: string; limit?: number } = {}): Promise<Experiment[]> {
    const { rows } = await this.client.query(
      `SELECT doc::text AS doc FROM ${this.table}
       WHERE ($1::text IS NULL OR name = $1) AND ($2::text IS NULL OR dataset_name = $2)
       ORDER BY started_at DESC, id LIMIT $3`,
      [filter.name || null, filter.dataset || null, filter.limit ?? 50],
    );
    return rows.map((row) => fromJson<Experiment>((row as { doc: unknown }).doc));
  }
}
