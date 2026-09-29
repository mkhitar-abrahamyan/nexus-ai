/**
 * The three operations every SQLite adapter needs.
 *
 * Injected rather than imported, so no SQLite driver becomes a dependency of this package. Each may
 * answer synchronously or with a promise, which is what lets one contract cover both the synchronous
 * drivers — `node:sqlite` and `better-sqlite3` — and the asynchronous libSQL client.
 */
export interface SqliteLikeClient {
  /** Runs a statement that returns no rows, reporting how many rows it changed. */
  run(sql: string, params?: readonly SqliteValue[]): { changes: number } | Promise<{ changes: number }>;
  /** Runs a query and returns its rows as objects keyed by column name. */
  all(sql: string, params?: readonly SqliteValue[]): unknown[] | Promise<unknown[]>;
  /** Runs one or more statements with no parameters, such as a migration. */
  exec(sql: string): unknown;
}

/**
 * A value bound to a SQLite parameter. Adapters only ever bind these; bytes are bound as a blob, which
 * is how the vector store keeps embeddings compact.
 */
export type SqliteValue = string | number | null | Uint8Array;

/**
 * The part of a synchronous SQLite handle the adapters need: `node:sqlite`'s `DatabaseSync` and
 * `better-sqlite3`'s `Database` both provide it.
 */
export interface SqliteDatabaseLike {
  /** Prepares a statement. */
  prepare(sql: string): {
    run(...params: SqliteValue[]): { changes: number | bigint };
    all(...params: SqliteValue[]): unknown[];
  };
  /** Runs statements with no parameters. */
  exec(sql: string): unknown;
}

/** The part of a libSQL client the adapters need: `execute()` with positional arguments. */
export interface LibsqlLikeClient {
  /** Runs one statement. */
  execute(statement: { sql: string; args: SqliteValue[] }): Promise<{ rows: unknown[]; rowsAffected: number }>;
  /** Runs statements with no parameters. */
  executeMultiple(sql: string): Promise<unknown>;
}

/**
 * Adapts a synchronous handle — `new DatabaseSync(path)` from `node:sqlite`, or `new Database(path)`
 * from `better-sqlite3` — to the client contract. Prepared statements are cached per SQL text, so a
 * statement an adapter runs on every call is compiled once.
 */
export function fromSqliteDatabase(db: SqliteDatabaseLike): SqliteLikeClient {
  const statements = new Map<string, ReturnType<SqliteDatabaseLike['prepare']>>();
  const prepared = (sql: string) => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };
  return {
    run(sql, params = []) {
      return { changes: Number(prepared(sql).run(...params).changes) };
    },
    all(sql, params = []) {
      return prepared(sql).all(...params);
    },
    exec(sql) {
      return db.exec(sql);
    },
  };
}

/** Adapts a libSQL or Turso client to the client contract. */
export function fromLibsql(client: LibsqlLikeClient): SqliteLikeClient {
  return {
    async run(sql, params = []) {
      return { changes: (await client.execute({ sql, args: [...params] })).rowsAffected };
    },
    async all(sql, params = []) {
      return (await client.execute({ sql, args: [...params] })).rows;
    },
    exec(sql) {
      return client.executeMultiple(sql);
    },
  };
}

/** Accepts either a client or a synchronous handle, so the common case needs no adapter call. */
export function toSqliteClient(source: SqliteLikeClient | SqliteDatabaseLike): SqliteLikeClient {
  return 'prepare' in source && typeof source.prepare === 'function'
    ? fromSqliteDatabase(source as SqliteDatabaseLike)
    : (source as SqliteLikeClient);
}

/** A table name, quoted. Letters, digits, and underscores only, so a table option can never inject SQL. */
export function quoteSqliteTable(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) {
    throw new RangeError(`"${name}" is not a valid table name: use letters, digits, and underscores`);
  }
  return `"${name}"`;
}

/** Whether an error is SQLite refusing a duplicate key. */
export function isSqliteUniqueViolation(error: unknown): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  return (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    (typeof message === 'string' && /UNIQUE constraint failed/i.test(message))
  );
}
