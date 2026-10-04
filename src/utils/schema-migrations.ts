/**
 * Versioned schema migrations, shared by the Postgres and SQLite adapters.
 *
 * Each adapter's tables form a component, such as `operations:nexus_operations`, with numbered
 * migrations. The database records which ran, with a checksum of their statements, so an upgrade
 * applies only what is new and an edited migration is refused instead of silently ignored.
 */

/** One numbered schema change to one adapter's tables. */
export interface SchemaMigration {
  /**
   * The tables it belongs to, such as `operations:nexus_operations`. Versions count per component,
   * so two operation stores on two tables migrate independently.
   */
  component: string;
  /** Its number, from 1, in the order it applies. */
  version: number;
  /** What it does, in a few words. */
  name: string;
  /**
   * Its statements, in order. Every bundled statement is idempotent (`IF NOT EXISTS`), so a migration
   * interrupted between statements on a database without transactional DDL runs again safely.
   */
  statements: readonly string[];
}

/** A migration the database has recorded as applied. */
export interface AppliedMigration {
  /** Its component. */
  component: string;
  /** Its version. */
  version: number;
  /** Its name when it ran. */
  name: string;
  /** The checksum of its statements when it ran. */
  checksum: string;
  /** ISO-8601 time it was applied. */
  appliedAt: string;
}

/** Where a database stands against the migrations this code knows. */
export interface MigrationStatus {
  /** Recorded migrations, oldest first. */
  applied: AppliedMigration[];
  /** Known migrations not yet applied, in the order `migrate()` would apply them. */
  pending: SchemaMigration[];
  /**
   * Applied migrations whose statements have changed since: an edited migration, or adapter options,
   * such as a vector width, that differ from those it ran with. `migrate()` refuses to run while any
   * remain.
   */
  changed: Array<{ migration: SchemaMigration; applied: AppliedMigration }>;
  /**
   * Recorded migrations this code does not know, written by a newer release. Expected while a rollout
   * runs two versions side by side, since every migration only adds.
   */
  unknown: AppliedMigration[];
  /** True when nothing is pending or changed. */
  current: boolean;
}

/** What one `migrate()` call did, or with `dryRun`, would do. */
export interface MigrationResult {
  /** Migrations applied, or with `dryRun`, pending. */
  applied: SchemaMigration[];
  /** The statements run, or with `dryRun`, that would run, in order. */
  statements: string[];
  /** Whether nothing was written. */
  dryRun: boolean;
}

/** Raised when migrations cannot run safely: a changed migration, a bad list, or a lock held too long. */
export class SchemaMigrationError extends Error {
  /** A stable code: `MIGRATION_CHANGED`, `MIGRATION_INVALID`, or `MIGRATION_LOCKED`. */
  readonly code: 'MIGRATION_CHANGED' | 'MIGRATION_INVALID' | 'MIGRATION_LOCKED';

  constructor(code: SchemaMigrationError['code'], message: string) {
    super(message);
    this.name = 'SchemaMigrationError';
    this.code = code;
  }
}

/** The default table that records applied migrations. */
export const MIGRATIONS_TABLE = 'nexus_schema_migrations';

/**
 * A checksum of a migration's statements: cyrb53, a fast 53-bit hash, as 14 hex digits.
 *
 * It detects a migration edited after it ran; it is not a security boundary, so it needs no crypto
 * module and runs anywhere a driver does. Line endings are normalized, so a checkout on Windows
 * computes the same value as one on Linux.
 */
export function migrationChecksum(migration: Pick<SchemaMigration, 'statements'>): string {
  const text = migration.statements.map((statement) => statement.replace(/\r\n/g, '\n').trim()).join('\n;\n');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** @internal Refuses a list with a gap, a duplicate, or an empty migration, before anything runs. */
export function validateMigrations(migrations: readonly SchemaMigration[]): void {
  const versions = new Map<string, number[]>();
  for (const migration of migrations) {
    if (!migration.component) throw new SchemaMigrationError('MIGRATION_INVALID', 'A migration has no component');
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new SchemaMigrationError(
        'MIGRATION_INVALID',
        `${migration.component} has version ${migration.version}; versions are integers from 1`,
      );
    }
    if (migration.statements.length === 0) {
      throw new SchemaMigrationError('MIGRATION_INVALID', `${label(migration)} has no statements`);
    }
    const list = versions.get(migration.component) ?? [];
    if (list.includes(migration.version)) {
      throw new SchemaMigrationError('MIGRATION_INVALID', `${label(migration)} is listed twice`);
    }
    list.push(migration.version);
    versions.set(migration.component, list);
  }
  for (const [component, list] of versions) {
    const sorted = [...list].sort((a, b) => a - b);
    sorted.forEach((version, index) => {
      if (version !== index + 1) {
        throw new SchemaMigrationError('MIGRATION_INVALID', `${component} skips version ${index + 1}`);
      }
    });
  }
}

/** @internal Compares known migrations with recorded ones. */
export function planMigrations(
  known: readonly SchemaMigration[],
  applied: readonly AppliedMigration[],
): MigrationStatus {
  validateMigrations(known);
  const recorded = new Map(applied.map((row) => [`${row.component}@${row.version}`, row]));
  const knownKeys = new Set(known.map((migration) => `${migration.component}@${migration.version}`));
  const pending: SchemaMigration[] = [];
  const changed: MigrationStatus['changed'] = [];
  for (const migration of known) {
    const row = recorded.get(`${migration.component}@${migration.version}`);
    if (!row) pending.push(migration);
    else if (row.checksum !== migrationChecksum(migration)) changed.push({ migration, applied: row });
  }
  // Components apply in the order they are first listed, and versions in order within each.
  const order = new Map<string, number>();
  for (const migration of known) if (!order.has(migration.component)) order.set(migration.component, order.size);
  pending.sort(
    (a, b) => (order.get(a.component) as number) - (order.get(b.component) as number) || a.version - b.version,
  );
  const sortedApplied = [...applied].sort(
    (a, b) => a.appliedAt.localeCompare(b.appliedAt) || a.component.localeCompare(b.component) || a.version - b.version,
  );
  return {
    applied: sortedApplied,
    pending,
    changed,
    unknown: sortedApplied.filter((row) => !knownKeys.has(`${row.component}@${row.version}`)),
    current: pending.length === 0 && changed.length === 0,
  };
}

/** @internal Refuses to migrate while an applied migration has changed. */
export function assertUnchanged(status: MigrationStatus): void {
  if (status.changed.length === 0) return;
  const names = status.changed.map(({ migration }) => label(migration)).join(', ');
  throw new SchemaMigrationError(
    'MIGRATION_CHANGED',
    `${names} changed after it was applied. A migration is never edited once it runs; add a new one, or check the adapter options (a table or vector width) match those it ran with.`,
  );
}

/** @internal A SQL string literal. Values here are component names and checksums, never user input. */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** @internal */
export function label(migration: Pick<SchemaMigration, 'component' | 'version' | 'name'>): string {
  return `${migration.component} v${migration.version} (${migration.name})`;
}

/** @internal Waits, for lock polling. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
