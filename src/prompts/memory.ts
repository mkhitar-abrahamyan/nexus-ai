import type { PromptHistoryEntry, PromptLabel, PromptStore, PromptVersion } from '../types/prompts.js';

/** Options for the in-memory prompt store. */
export interface MemoryPromptStoreOptions {
  /** History entries kept per prompt before the oldest are dropped. Defaults to 1,000. */
  maxHistory?: number;
}

/**
 * Prompt versions, labels, and history in process memory.
 *
 * The registry's default, and enough for tests and for a single process that defines its prompts in
 * code. Every read returns a copy, so a caller cannot change a stored version by mutating what it got.
 */
export class MemoryPromptStore implements PromptStore {
  private readonly versions = new Map<string, PromptVersion[]>();
  private readonly labels = new Map<string, Map<string, PromptLabel>>();
  private readonly history = new Map<string, PromptHistoryEntry[]>();
  private readonly maxHistory: number;

  constructor(options: MemoryPromptStoreOptions = {}) {
    this.maxHistory = options.maxHistory ?? 1_000;
  }

  /** Stores a version, unless one with the same content version exists. */
  saveVersion(version: PromptVersion): void {
    const list = this.versions.get(version.name) ?? [];
    if (list.some((item) => item.version === version.version)) return;
    list.unshift(structuredClone(version));
    this.versions.set(version.name, list);
  }

  /** Reads a version. */
  getVersion(name: string, version: string): PromptVersion | undefined {
    const found = this.versions.get(name)?.find((item) => item.version === version);
    return found ? structuredClone(found) : undefined;
  }

  /** Versions of a prompt, newest first. Defaults to 50. */
  listVersions(name: string, options: { limit?: number } = {}): PromptVersion[] {
    return (this.versions.get(name) ?? []).slice(0, options.limit ?? 50).map((item) => structuredClone(item));
  }

  /** Reads a label. */
  getLabel(name: string, label: string): PromptLabel | undefined {
    const found = this.labels.get(name)?.get(label);
    return found ? structuredClone(found) : undefined;
  }

  /** Every label of a prompt, sorted by name. */
  listLabels(name: string): PromptLabel[] {
    return [...(this.labels.get(name)?.values() ?? [])]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((item) => structuredClone(item));
  }

  /** Writes a label when it still points at `expected`. */
  setLabel(label: PromptLabel, expected?: string | null): boolean {
    const labels = this.labels.get(label.name) ?? new Map<string, PromptLabel>();
    const current = labels.get(label.label);
    if (expected === null && current) return false;
    if (typeof expected === 'string' && current?.version !== expected) return false;
    labels.set(label.label, structuredClone(label));
    this.labels.set(label.name, labels);
    return true;
  }

  /** Removes a label. Returns true when it existed. */
  deleteLabel(name: string, label: string): boolean {
    return this.labels.get(name)?.delete(label) ?? false;
  }

  /** Records a change. */
  appendHistory(entry: PromptHistoryEntry): void {
    const list = this.history.get(entry.name) ?? [];
    list.unshift(structuredClone(entry));
    if (list.length > this.maxHistory) list.length = this.maxHistory;
    this.history.set(entry.name, list);
  }

  /** A prompt's history, newest first, optionally for one label. Defaults to 100. */
  listHistory(name: string, options: { label?: string; limit?: number } = {}): PromptHistoryEntry[] {
    return (this.history.get(name) ?? [])
      .filter((entry) => options.label === undefined || entry.label === options.label)
      .slice(0, options.limit ?? 100)
      .map((item) => structuredClone(item));
  }

  /** Every prompt name, sorted. */
  listNames(): string[] {
    return [...this.versions.keys()].sort();
  }
}
