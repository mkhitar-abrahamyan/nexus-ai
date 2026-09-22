import type { PromptHistoryEntry, PromptLabel, PromptStore, PromptVersion } from '../types/prompts.js';
import { fromJson, type PostgresLikeClient, quoteDerived, quoteTable, runStatements } from './client.js';

/** Options for the Postgres prompt store. */
export interface PostgresPromptStoreOptions {
  /** Table name prefix, optionally schema-qualified. Defaults to `nexus_prompt`, for `nexus_prompt_versions` and so on. */
  table?: string;
}

function tables(options: PostgresPromptStoreOptions) {
  const base = options.table ?? 'nexus_prompt';
  return { base, versions: `${base}_versions`, labels: `${base}_labels`, history: `${base}_history` };
}

/** The schema for the prompt store, as statements. */
export function promptStoreMigration(options: PostgresPromptStoreOptions = {}): string[] {
  const names = tables(options);
  return [
    `CREATE TABLE IF NOT EXISTS ${quoteTable(names.versions)} (
  name text NOT NULL,
  version text NOT NULL,
  created_at text COLLATE "C" NOT NULL,
  doc jsonb NOT NULL,
  PRIMARY KEY (name, version)
)`,
    `CREATE INDEX IF NOT EXISTS ${quoteDerived(names.versions, 'newest')} ON ${quoteTable(names.versions)} (name, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS ${quoteTable(names.labels)} (
  name text NOT NULL,
  label text NOT NULL,
  version text NOT NULL,
  doc jsonb NOT NULL,
  PRIMARY KEY (name, label)
)`,
    `CREATE TABLE IF NOT EXISTS ${quoteTable(names.history)} (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  label text,
  doc jsonb NOT NULL
)`,
    `CREATE INDEX IF NOT EXISTS ${quoteDerived(names.history, 'name')} ON ${quoteTable(names.history)} (name, id DESC)`,
  ];
}

/**
 * Prompt versions, labels, and history in Postgres.
 *
 * Label compare-and-set is a single statement — an insert that does nothing on conflict, or an update
 * that matches only the expected version — so two workers promoting at once cannot both win.
 */
export class PostgresPromptStore implements PromptStore {
  private readonly versions: string;
  private readonly labels: string;
  private readonly history: string;

  constructor(
    private readonly client: PostgresLikeClient,
    private readonly options: PostgresPromptStoreOptions = {},
  ) {
    const names = tables(options);
    this.versions = quoteTable(names.versions);
    this.labels = quoteTable(names.labels);
    this.history = quoteTable(names.history);
  }

  /** Creates the prompt tables if they do not exist. Never runs implicitly. */
  async migrate(): Promise<void> {
    await runStatements(this.client, promptStoreMigration(this.options));
  }

  /** Stores a version, unless one with the same content version exists. */
  async saveVersion(version: PromptVersion): Promise<void> {
    await this.client.query(
      `INSERT INTO ${this.versions} (name, version, created_at, doc) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING`,
      [version.name, version.version, version.createdAt, JSON.stringify(version)],
    );
  }

  /** Reads a version. */
  async getVersion(name: string, version: string): Promise<PromptVersion | undefined> {
    const { rows } = await this.client.query(
      `SELECT doc::text AS doc FROM ${this.versions} WHERE name = $1 AND version = $2`,
      [name, version],
    );
    return rows[0] ? fromJson<PromptVersion>((rows[0] as { doc: unknown }).doc) : undefined;
  }

  /** Versions of a prompt, newest first. Defaults to 50. */
  async listVersions(name: string, options: { limit?: number } = {}): Promise<PromptVersion[]> {
    const { rows } = await this.client.query(
      `SELECT doc::text AS doc FROM ${this.versions} WHERE name = $1 ORDER BY created_at DESC, version DESC LIMIT $2`,
      [name, options.limit ?? 50],
    );
    return rows.map((row) => fromJson<PromptVersion>((row as { doc: unknown }).doc));
  }

  /** Reads a label. */
  async getLabel(name: string, label: string): Promise<PromptLabel | undefined> {
    const { rows } = await this.client.query(
      `SELECT doc::text AS doc FROM ${this.labels} WHERE name = $1 AND label = $2`,
      [name, label],
    );
    return rows[0] ? fromJson<PromptLabel>((rows[0] as { doc: unknown }).doc) : undefined;
  }

  /** Every label of a prompt, sorted by name. */
  async listLabels(name: string): Promise<PromptLabel[]> {
    const { rows } = await this.client.query(
      `SELECT doc::text AS doc FROM ${this.labels} WHERE name = $1 ORDER BY label`,
      [name],
    );
    return rows.map((row) => fromJson<PromptLabel>((row as { doc: unknown }).doc));
  }

  /** Writes a label when it still points at `expected`, in one statement. */
  async setLabel(label: PromptLabel, expected?: string | null): Promise<boolean> {
    const values = [label.name, label.label, label.version, JSON.stringify(label)];
    if (expected === null) {
      const { rows } = await this.client.query(
        `INSERT INTO ${this.labels} (name, label, version, doc) VALUES ($1, $2, $3, $4::jsonb) ON CONFLICT DO NOTHING RETURNING label`,
        values,
      );
      return rows.length > 0;
    }
    if (typeof expected === 'string') {
      const { rows } = await this.client.query(
        `UPDATE ${this.labels} SET version = $3, doc = $4::jsonb WHERE name = $1 AND label = $2 AND version = $5 RETURNING label`,
        [...values, expected],
      );
      return rows.length > 0;
    }
    await this.client.query(
      `INSERT INTO ${this.labels} (name, label, version, doc) VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (name, label) DO UPDATE SET version = EXCLUDED.version, doc = EXCLUDED.doc`,
      values,
    );
    return true;
  }

  /** Removes a label. Resolves true when it existed. */
  async deleteLabel(name: string, label: string): Promise<boolean> {
    const { rows } = await this.client.query(
      `DELETE FROM ${this.labels} WHERE name = $1 AND label = $2 RETURNING label`,
      [name, label],
    );
    return rows.length > 0;
  }

  /** Records a change. */
  async appendHistory(entry: PromptHistoryEntry): Promise<void> {
    await this.client.query(`INSERT INTO ${this.history} (name, label, doc) VALUES ($1, $2, $3::jsonb)`, [
      entry.name,
      entry.label ?? null,
      JSON.stringify(entry),
    ]);
  }

  /** A prompt's history, newest first, optionally for one label. Defaults to 100. */
  async listHistory(name: string, options: { label?: string; limit?: number } = {}): Promise<PromptHistoryEntry[]> {
    const { rows } = await this.client.query(
      `SELECT doc::text AS doc FROM ${this.history} WHERE name = $1 AND ($2::text IS NULL OR label = $2) ORDER BY id DESC LIMIT $3`,
      [name, options.label ?? null, options.limit ?? 100],
    );
    return rows.map((row) => fromJson<PromptHistoryEntry>((row as { doc: unknown }).doc));
  }

  /** Every prompt name, sorted. */
  async listNames(): Promise<string[]> {
    const { rows } = await this.client.query(`SELECT DISTINCT name FROM ${this.versions} ORDER BY name`);
    return rows.map((row) => (row as { name: string }).name);
  }
}
