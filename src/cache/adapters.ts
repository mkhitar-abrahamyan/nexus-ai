import type { CacheEntry } from './memory-cache.js';

export interface CacheAdapter<T = unknown> {
  get(key: string): Promise<T | undefined> | T | undefined;
  set(key: string, value: T, ttlSeconds?: number): Promise<void> | void;
  delete?(key: string): Promise<boolean> | boolean;
  clear?(): Promise<void> | void;
}

export class MemoryCacheAdapter<T = unknown> implements CacheAdapter<T> {
  private entries = new Map<string, CacheEntry<T>>();

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlSeconds = 300): void {
    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface RedisLikeClient {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string, mode?: string, ttlSeconds?: number): Promise<unknown> | unknown;
  del?(key: string): Promise<number> | number;
}

export class RedisCacheAdapter<T = unknown> implements CacheAdapter<T> {
  constructor(private client: RedisLikeClient, private prefix = 'nexus-ai-pro:cache:') {}

  async get(key: string): Promise<T | undefined> {
    const raw = await this.client.get(this.prefix + key);
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  }

  async set(key: string, value: T, ttlSeconds = 300): Promise<void> {
    await this.client.set(this.prefix + key, JSON.stringify(value), 'EX', ttlSeconds);
  }

  async delete(key: string): Promise<boolean> {
    if (!this.client.del) return false;
    return (await this.client.del(this.prefix + key)) > 0;
  }
}

export interface SQLiteLikeDatabase {
  prepare(sql: string): {
    get?: (...args: unknown[]) => unknown;
    run?: (...args: unknown[]) => unknown;
  };
  exec?(sql: string): unknown;
}

export class SQLiteCacheAdapter<T = unknown> implements CacheAdapter<T> {
  constructor(private db: SQLiteLikeDatabase, private table = 'nexus_cache') {
    this.db.exec?.(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
  }

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

  set(key: string, value: T, ttlSeconds = 300): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO ${this.table} (key, value, expires_at) VALUES (?, ?, ?)`,
    ).run?.(key, JSON.stringify(value), Date.now() + ttlSeconds * 1000);
  }

  delete(key: string): boolean {
    this.db.prepare(`DELETE FROM ${this.table} WHERE key = ?`).run?.(key);
    return true;
  }

  clear(): void {
    this.db.prepare(`DELETE FROM ${this.table}`).run?.();
  }
}
