import { canonicalJson } from '../prompts/version.js';
import type { DatasetExample } from '../types/evaluate.js';

/** A target's output kept for reuse, with what producing it took. */
export interface CachedOutput {
  /** What the target returned. */
  output: unknown;
  /** How long producing it took, in milliseconds. */
  latencyMs: number;
  /** What it cost, when known. */
  cost?: number;
  /** ISO-8601 time it was produced. */
  cachedAt: string;
}

/**
 * Where `evaluate()` keeps target outputs between experiments. Keys are opaque hex strings; a cache
 * only stores and returns values by them.
 */
export interface EvaluationCache {
  /** The output stored under a key. */
  get(key: string): Promise<CachedOutput | undefined> | CachedOutput | undefined;
  /** Stores an output under a key, replacing any there. */
  set(key: string, value: CachedOutput): Promise<void> | void;
}

/** Options for a `MemoryEvaluationCache`. */
export interface MemoryEvaluationCacheOptions {
  /** Outputs kept; the least recently used is dropped first. Defaults to 10,000. */
  maxEntries?: number;
}

/**
 * Target outputs in process memory, least recently used dropped first. Outputs are copied in and
 * out, so an evaluator that mutates an output cannot change what a later experiment reuses.
 */
export class MemoryEvaluationCache implements EvaluationCache {
  private readonly entries = new Map<string, CachedOutput>();
  private readonly maxEntries: number;

  constructor(options: MemoryEvaluationCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
  }

  /** The output under a key, marking it recently used. */
  get(key: string): CachedOutput | undefined {
    const value = this.entries.get(key);
    if (!value) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return structuredClone(value);
  }

  /** Stores an output, dropping the least recently used when full. */
  set(key: string, value: CachedOutput): void {
    this.entries.delete(key);
    this.entries.set(key, structuredClone(value));
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  /** Outputs held. */
  size(): number {
    return this.entries.size;
  }

  /** Drops every output. */
  clear(): void {
    this.entries.clear();
  }
}

/**
 * A fingerprint for whatever decides a target's output — a model name, a prompt version, a
 * temperature, a context bundle version — as `f` and 16 hex digits of a SHA-256 over its canonical
 * JSON, so the same settings always give the same fingerprint, whatever the key order.
 */
export async function fingerprintOf(value: unknown): Promise<string> {
  return `f${(await sha256(canonicalJson(value))).slice(0, 16)}`;
}

/**
 * The cache key of one example run: a SHA-256 over the target's fingerprint, the example's id and
 * inputs, and the repetition. The expected output is left out, so correcting a label re-scores the
 * cached output instead of producing it again.
 */
export async function evaluationCacheKey(fingerprint: string, example: DatasetExample, run: number): Promise<string> {
  return sha256(canonicalJson({ fingerprint, id: example.id, inputs: example.inputs, run }));
}

async function sha256(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
