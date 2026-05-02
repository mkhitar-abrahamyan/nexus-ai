export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class MemoryCache<T> {
  private entries = new Map<string, CacheEntry<T>>();

  constructor(private maxEntries = 500) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;

    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlSeconds = 300): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest) this.entries.delete(oldest);
    }

    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  clear(): void {
    this.entries.clear();
  }

  delete(key: string): boolean {
    return this.entries.delete(key);
  }

  clearExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt < now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  stats(): { size: number; maxEntries: number; expiredEntries: number } {
    const now = Date.now();
    let expiredEntries = 0;
    for (const entry of this.entries.values()) {
      if (entry.expiresAt < now) expiredEntries += 1;
    }

    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      expiredEntries,
    };
  }
}

export function createCacheKey(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}
