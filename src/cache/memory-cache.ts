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
  return stableStringify(value);
}

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  function normalize(input: unknown): unknown {
    if (input === undefined || typeof input === 'function' || typeof input === 'symbol') {
      return undefined;
    }

    if (typeof input === 'bigint') {
      return input.toString();
    }

    if (!input || typeof input !== 'object') {
      return input;
    }

    if (input instanceof Date) {
      return input.toISOString();
    }

    if (Array.isArray(input)) {
      return input.map((item) => {
        const normalized = normalize(item);
        return normalized === undefined ? null : normalized;
      });
    }

    if (seen.has(input)) {
      return '[Circular]';
    }
    seen.add(input);

    const object = input as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const normalized = normalize(object[key]);
      if (normalized !== undefined) {
        sorted[key] = normalized;
      }
    }

    seen.delete(input);
    return sorted;
  }

  return JSON.stringify(normalize(value));
}
