/**
 * The one method every Postgres adapter needs.
 *
 * Injected rather than imported, so no Postgres driver becomes a dependency of this package. `pg`'s
 * `Pool` and `Client`, `@neondatabase/serverless`, PGlite, and anything else whose `query(text,
 * values)` resolves to `{ rows }` satisfy it directly. `postgres.js` uses tagged templates instead;
 * `fromPostgresJs(sql)` adapts it.
 *
 * Adapters only ever pass strings, numbers, and `null` as parameters, and cast them in SQL, so a
 * driver's own conversion of arrays, objects, and dates never changes what is stored.
 */
export interface PostgresLikeClient {
  /** Runs a parameterized statement. */
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

/** The part of a `postgres.js` instance the adapter needs. */
export interface PostgresJsLike {
  /** Runs raw SQL with parameters. */
  unsafe(text: string, values?: never[]): PromiseLike<ArrayLike<unknown> & { count?: number }>;
}

/** Adapts a `postgres.js` instance to the client contract. */
export function fromPostgresJs(sql: PostgresJsLike): PostgresLikeClient {
  return {
    async query(text, values) {
      const rows = await sql.unsafe(text, (values ?? []) as never[]);
      return { rows: Array.from(rows), rowCount: rows.count ?? rows.length };
    },
  };
}

/** A table name, optionally schema-qualified, quoted for SQL. Anything else is refused. */
export function quoteTable(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}(\.[A-Za-z_][A-Za-z0-9_]{0,62})?$/.test(name)) {
    throw new RangeError(
      `"${name}" is not a valid table name: use letters, digits, and underscores, optionally schema.table`,
    );
  }
  return name
    .split('.')
    .map((part) => `"${part}"`)
    .join('.');
}

/** An index or constraint name derived from a table, quoted. */
export function quoteDerived(table: string, suffix: string): string {
  const base = table.split('.').pop() as string;
  return `"${`${base}_${suffix}`.slice(0, 63)}"`;
}

/**
 * A jsonb value selected as `::text`.
 *
 * Adapters always select jsonb as text and parse it here. Drivers disagree about jsonb — some parse
 * it, some return text — and a parsed JSON string is indistinguishable from unparsed text, so
 * reading text everywhere is the only way to get the same value from every driver.
 */
export function fromJson<T>(value: unknown): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

/** Runs migration statements one at a time, which every driver accepts. */
export async function runStatements(client: PostgresLikeClient, statements: readonly string[]): Promise<void> {
  for (const statement of statements) await client.query(statement);
}

/** Whether an error is Postgres refusing a duplicate key. */
export function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === '23505';
}
