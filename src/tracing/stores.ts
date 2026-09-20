import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Run, RunFeedback, RunQuery, RunTree, TraceStore } from '../types/tracing.js';

export interface MemoryTraceStoreOptions {
  /** Runs kept before the oldest is dropped. Defaults to 10,000. */
  maxRuns?: number;
}

/**
 * Traces in process memory.
 *
 * Enough for development, tests, and a single-process service that only needs the last few thousand
 * runs. Bounded, like every other in-memory store here.
 */
export class MemoryTraceStore implements TraceStore {
  private readonly runs = new Map<string, Run>();
  private readonly maxRuns: number;

  constructor(options: MemoryTraceStoreOptions = {}) {
    this.maxRuns = options.maxRuns ?? 10_000;
  }

  save(run: Run): void {
    this.runs.delete(run.id);
    this.runs.set(run.id, run);
    while (this.runs.size > this.maxRuns) {
      const oldest = this.runs.keys().next().value as string;
      this.runs.delete(oldest);
    }
  }

  get(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  query(query: RunQuery = {}): Run[] {
    return applyQuery([...this.runs.values()], query);
  }

  tree(traceId: string): RunTree | undefined {
    return assembleTree([...this.runs.values()].filter((run) => run.traceId === traceId));
  }

  addFeedback(runId: string, feedback: RunFeedback): void {
    const run = this.runs.get(runId);
    if (run) this.runs.set(runId, { ...run, feedback: [...(run.feedback ?? []), feedback] });
  }

  prune(before: string): number {
    let removed = 0;
    for (const [id, run] of this.runs) {
      if (run.startedAt < before) {
        this.runs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.runs.size;
  }
}

export interface JsonlTraceStoreOptions {
  /** File runs are appended to, one JSON object per line. */
  file: string;
  /** Rewrites the file when it grows past this, keeping the newest runs. Defaults to 64 MB. */
  maxBytes?: number;
}

/**
 * Traces appended to a JSONL file.
 *
 * Durable without a database, greppable with ordinary tools, and directly loadable as an evaluation
 * dataset. Reads load the file, so this suits a service that writes far more than it queries; a
 * database-backed store is the answer above that.
 */
export class JsonlTraceStore implements TraceStore {
  private readonly file: string;
  private readonly maxBytes: number;

  constructor(options: JsonlTraceStoreOptions) {
    this.file = options.file;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  }

  async save(run: Run): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const line = `${JSON.stringify(run)}\n`;
    await appendFile(this.file, line, 'utf8');
    await this.rotate();
  }

  async get(runId: string): Promise<Run | undefined> {
    const runs = await this.load();
    return runs.get(runId);
  }

  async query(query: RunQuery = {}): Promise<Run[]> {
    return applyQuery([...(await this.load()).values()], query);
  }

  async tree(traceId: string): Promise<RunTree | undefined> {
    const runs = [...(await this.load()).values()].filter((run) => run.traceId === traceId);
    return assembleTree(runs);
  }

  async addFeedback(runId: string, feedback: RunFeedback): Promise<void> {
    const run = await this.get(runId);
    if (!run) return;
    // Appending the updated run is enough: a later line for the same id wins when the file is read.
    await this.save({ ...run, feedback: [...(run.feedback ?? []), feedback] });
  }

  async prune(before: string): Promise<number> {
    const runs = [...(await this.load()).values()];
    const kept = runs.filter((run) => run.startedAt >= before);
    await writeFile(this.file, kept.map((run) => `${JSON.stringify(run)}\n`).join(''), 'utf8');
    return runs.length - kept.length;
  }

  /** A later line for the same run replaces an earlier one, which is what makes appends safe. */
  private async load(): Promise<Map<string, Run>> {
    const runs = new Map<string, Run>();
    let content: string;
    try {
      content = await readFile(this.file, 'utf8');
    } catch {
      return runs;
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const run = JSON.parse(line) as Run;
        runs.set(run.id, run);
      } catch {
        // A truncated last line from a crash is skipped rather than failing every read after it.
      }
    }
    return runs;
  }

  private async rotate(): Promise<void> {
    let content: string;
    try {
      content = await readFile(this.file, 'utf8');
    } catch {
      return;
    }
    if (Buffer.byteLength(content, 'utf8') <= this.maxBytes) return;
    const lines = content.split('\n').filter(Boolean);
    await writeFile(this.file, `${lines.slice(Math.floor(lines.length / 2)).join('\n')}\n`, 'utf8');
  }
}

/** Filters and orders runs. Shared by every store, so a query means the same thing everywhere. */
export function applyQuery(runs: Run[], query: RunQuery = {}): Run[] {
  const kinds = query.kind === undefined ? undefined : Array.isArray(query.kind) ? query.kind : [query.kind];
  const matched = runs.filter((run) => {
    if (query.traceId && run.traceId !== query.traceId) return false;
    if (kinds && !kinds.includes(run.kind)) return false;
    if (query.status && run.status !== query.status) return false;
    if (query.name && run.name !== query.name) return false;
    if (query.model && run.model !== query.model) return false;
    if (query.provider && run.provider !== query.provider) return false;
    if (query.tags?.length && !query.tags.every((tag) => run.tags?.includes(tag))) return false;
    if (query.minLatencyMs !== undefined && (run.latencyMs ?? 0) < query.minLatencyMs) return false;
    if (query.minCost !== undefined && (run.cost ?? 0) < query.minCost) return false;
    if (query.since && run.startedAt < query.since) return false;
    if (query.until && run.startedAt > query.until) return false;
    if (query.feedbackKey && !run.feedback?.some((item) => item.key === query.feedbackKey)) return false;
    if (query.metadata) {
      for (const [field, expected] of Object.entries(query.metadata)) {
        if (readPath(run.metadata, field) !== expected) return false;
      }
    }
    return true;
  });

  const ordered = matched.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const offset = query.offset ?? 0;
  return ordered.slice(offset, offset + (query.limit ?? 50));
}

export function assembleTree(runs: Run[]): RunTree | undefined {
  const nodes = new Map<string, RunTree>(runs.map((run) => [run.id, { ...run, children: [] }]));
  let root: RunTree | undefined;
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else root ??= node;
  }
  for (const node of nodes.values()) node.children.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  return root;
}

function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}
