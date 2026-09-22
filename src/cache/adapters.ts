import type { CacheEntry } from './memory-cache.js';

/** Where cached values live. `get` and `set` may be synchronous or asynchronous. */
export interface CacheAdapter<T = unknown> {
  /** Returns the cached value, or `undefined` for a miss or an expired entry. */
  get(key: string): Promise<T | undefined> | T | undefined;
  /** Stores a value, for `ttlSeconds` when given. */
  set(key: string, value: T, ttlSeconds?: number): Promise<void> | void;
  /** Removes a value. Returns true when one was removed. */
  delete?(key: string): Promise<boolean> | boolean;
  /** Removes every value. */
  clear?(): Promise<void> | void;
}

/** Cache values in process memory. Expired entries are dropped when read. */
export class MemoryCacheAdapter<T = unknown> implements CacheAdapter<T> {
  private entries = new Map<string, CacheEntry<T>>();

  /** Returns the cached value, or `undefined` for a miss or an expired entry. */
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Stores a value. Defaults to 5 minutes. */
  set(key: string, value: T, ttlSeconds = 300): void {
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  /** Removes a value. */
  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  /** Removes every value. */
  clear(): void {
    this.entries.clear();
  }
}

/** The Redis commands the cache adapter needs, in `ioredis` argument order. */
export interface RedisLikeClient {
  /** Reads a key. */
  get(key: string): Promise<string | null> | string | null;
  /** Writes a key, with `EX` and a TTL in seconds. */
  set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<unknown> | unknown;
  /** Deletes a key. */
  del?(key: string): Promise<number> | number;
}

/** Cache values in Redis, shared across processes. Values are stored as JSON under a key prefix. */
export class RedisCacheAdapter<T = unknown> implements CacheAdapter<T> {
  constructor(
    private client: RedisLikeClient,
    private prefix = 'nexus-ai-pro:cache:',
  ) {}

  /** Returns the cached value, or `undefined` for a miss. */
  async get(key: string): Promise<T | undefined> {
    const raw = await this.client.get(this.prefix + key);
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  }

  /** Stores a value. Defaults to 5 minutes. */
  async set(key: string, value: T, ttlSeconds = 300): Promise<void> {
    await this.client.set(this.prefix + key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  /** Removes a value. Returns false when the client has no `del`. */
  async delete(key: string): Promise<boolean> {
    if (!this.client.del) return false;
    return (await this.client.del(this.prefix + key)) > 0;
  }
}

/**
 * The part of a SQLite database handle the cache adapter needs, as `better-sqlite3` provides it.
 */
export interface SQLiteLikeDatabase {
  /** Prepares a statement. */
  prepare(sql: string): {
    get?: (...args: unknown[]) => unknown;
    run?: (...args: unknown[]) => unknown;
  };
  /** Runs SQL without results, used to create the table. */
  exec?(sql: string): unknown;
}

/** Cache values in a SQLite table, for a single-machine cache that survives restarts. */
export class SQLiteCacheAdapter<T = unknown> implements CacheAdapter<T> {
  constructor(
    private db: SQLiteLikeDatabase,
    private table = 'nexus_cache',
  ) {
    this.db.exec?.(
      `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
    );
  }

  /** Returns the cached value, or `undefined` for a miss or an expired entry. */
  get(key: string): T | undefined {
    const row = this.db.prepare(`SELECT value, expires_at FROM ${this.table} WHERE key = ?`).get?.(key) as
      | { value: string; expires_at: number }
      | undefined;
    if (!row) return undefined;
    if (row.expires_at < Date.now()) {
      this.delete(key);
      return undefined;
    }
    return JSON.parse(row.value) as T;
  }

  /** Stores a value. Defaults to 5 minutes. */
  set(key: string, value: T, ttlSeconds = 300): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO ${this.table} (key, value, expires_at) VALUES (?, ?, ?)`)
      .run?.(key, JSON.stringify(value), Date.now() + ttlSeconds * 1000);
  }

  /**
   * Removes a value. Always returns true, since SQLite does not report whether the row existed
   * here.
   */
  delete(key: string): boolean {
    this.db.prepare(`DELETE FROM ${this.table} WHERE key = ?`).run?.(key);
    return true;
  }

  /** Removes every value. */
  clear(): void {
    this.db.prepare(`DELETE FROM ${this.table}`).run?.();
  }
}
