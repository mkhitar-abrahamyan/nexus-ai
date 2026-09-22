import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Run, RunFeedback, RunQuery, RunTree, TraceStore } from '../types/tracing.js';
import { applyQuery, assembleTree } from './query.js';

export { applyQuery, assembleTree };

/** Options for the in-memory trace store. */
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

  /**
   * Stores a run, replacing an earlier version with the same id. Drops the oldest runs beyond
   * `maxRuns`.
   */
  save(run: Run): void {
    this.runs.delete(run.id);
    this.runs.set(run.id, run);
    while (this.runs.size > this.maxRuns) {
      const oldest = this.runs.keys().next().value as string;
      this.runs.delete(oldest);
    }
  }

  /** Reads a run. */
  get(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  /** Runs matching a query. */
  query(query: RunQuery = {}): Run[] {
    return applyQuery([...this.runs.values()], query);
  }

  /** A trace's runs, assembled into a tree. */
  tree(traceId: string): RunTree | undefined {
    return assembleTree([...this.runs.values()].filter((run) => run.traceId === traceId));
  }

  /** Attaches feedback to a run. */
  addFeedback(runId: string, feedback: RunFeedback): void {
    const run = this.runs.get(runId);
    if (run) this.runs.set(runId, { ...run, feedback: [...(run.feedback ?? []), feedback] });
  }

  /** Deletes runs started before an ISO-8601 time, returning how many went. */
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

  /** Runs held. */
  size(): number {
    return this.runs.size;
  }
}

/** Options for the JSONL trace store. */
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

  /** Appends a run. Rewrites the file, keeping the newer half, once it passes `maxBytes`. */
  async save(run: Run): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const line = `${JSON.stringify(run)}\n`;
    await appendFile(this.file, line, 'utf8');
    await this.rotate();
  }

  /** Reads a run. */
  async get(runId: string): Promise<Run | undefined> {
    const runs = await this.load();
    return runs.get(runId);
  }

  /** Runs matching a query. */
  async query(query: RunQuery = {}): Promise<Run[]> {
    return applyQuery([...(await this.load()).values()], query);
  }

  /** A trace's runs, assembled into a tree. */
  async tree(traceId: string): Promise<RunTree | undefined> {
    const runs = [...(await this.load()).values()].filter((run) => run.traceId === traceId);
    return assembleTree(runs);
  }

  /** Attaches feedback to a run by appending its updated version. */
  async addFeedback(runId: string, feedback: RunFeedback): Promise<void> {
    const run = await this.get(runId);
    if (!run) return;
    // Appending the updated run is enough: a later line for the same id wins when the file is read.
    await this.save({ ...run, feedback: [...(run.feedback ?? []), feedback] });
  }

  /**
   * Deletes runs started before an ISO-8601 time by rewriting the file, returning how many went.
   */
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
