import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PromptHistoryEntry, PromptLabel, PromptStore, PromptVersion } from '../types/prompts.js';

/**
 * Prompts as files in a directory: one reviewable JSON file per version and per label, and one
 * history log per prompt.
 *
 * Meant to live in version control beside the code that uses the prompts, so a prompt change is a
 * diff in a pull request like any other. Writes go through a temporary file and a rename, so a reader
 * never sees half a file. Label compare-and-set is checked before writing, which protects one process
 * against itself; several processes promoting the same label at once need the Redis or Postgres store.
 *
 * Layout: `<directory>/<prompt>/versions/<version>.json`, `<prompt>/labels/<label>.json`, and
 * `<prompt>/history.jsonl`, with names URL-encoded.
 */
export class FilePromptStore implements PromptStore {
  constructor(private readonly directory: string) {}

  /** Writes a version, unless its file exists. */
  async saveVersion(version: PromptVersion): Promise<void> {
    const file = this.versionFile(version.name, version.version);
    if ((await readJson(file)) !== undefined) return;
    await writeJson(file, version);
  }

  /** Reads a version. */
  async getVersion(name: string, version: string): Promise<PromptVersion | undefined> {
    return readJson<PromptVersion>(this.versionFile(name, version));
  }

  /** Versions of a prompt, newest first. Defaults to 50. */
  async listVersions(name: string, options: { limit?: number } = {}): Promise<PromptVersion[]> {
    const directory = path.join(this.promptDir(name), 'versions');
    const versions = await Promise.all(
      (await list(directory))
        .filter((file) => file.endsWith('.json'))
        .map((file) => readJson<PromptVersion>(path.join(directory, file))),
    );
    return versions
      .filter((version): version is PromptVersion => version !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.version.localeCompare(a.version))
      .slice(0, options.limit ?? 50);
  }

  /** Reads a label. */
  async getLabel(name: string, label: string): Promise<PromptLabel | undefined> {
    return readJson<PromptLabel>(this.labelFile(name, label));
  }

  /** Every label of a prompt, sorted by name. */
  async listLabels(name: string): Promise<PromptLabel[]> {
    const directory = path.join(this.promptDir(name), 'labels');
    const labels = await Promise.all(
      (await list(directory))
        .filter((file) => file.endsWith('.json'))
        .map((file) => readJson<PromptLabel>(path.join(directory, file))),
    );
    return labels
      .filter((label): label is PromptLabel => label !== undefined)
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /** Writes a label when it still points at `expected`. */
  async setLabel(label: PromptLabel, expected?: string | null): Promise<boolean> {
    const file = this.labelFile(label.name, label.label);
    if (expected !== undefined) {
      const current = await readJson<PromptLabel>(file);
      if (expected === null ? current !== undefined : current?.version !== expected) return false;
    }
    await writeJson(file, label);
    return true;
  }

  /** Removes a label. Resolves true when it existed. */
  async deleteLabel(name: string, label: string): Promise<boolean> {
    const file = this.labelFile(name, label);
    if ((await readJson(file)) === undefined) return false;
    await rm(file, { force: true });
    return true;
  }

  /** Appends a change to the prompt's history log. */
  async appendHistory(entry: PromptHistoryEntry): Promise<void> {
    await mkdir(this.promptDir(entry.name), { recursive: true });
    await appendFile(path.join(this.promptDir(entry.name), 'history.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  }

  /** A prompt's history, newest first, optionally for one label. Defaults to 100. */
  async listHistory(name: string, options: { label?: string; limit?: number } = {}): Promise<PromptHistoryEntry[]> {
    let text: string;
    try {
      text = await readFile(path.join(this.promptDir(name), 'history.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const entries: PromptHistoryEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as PromptHistoryEntry);
      } catch {
        // A truncated last line from a crash is skipped rather than failing every read after it.
      }
    }
    return entries
      .reverse()
      .filter((entry) => options.label === undefined || entry.label === options.label)
      .slice(0, options.limit ?? 100);
  }

  /** Every prompt name, sorted. */
  async listNames(): Promise<string[]> {
    return (await list(this.directory)).map((entry) => decodeURIComponent(entry)).sort();
  }

  private promptDir(name: string): string {
    return path.join(this.directory, encodeURIComponent(name));
  }

  private versionFile(name: string, version: string): string {
    return path.join(this.promptDir(name), 'versions', `${encodeURIComponent(version)}.json`);
  }

  private labelFile(name: string, label: string): string {
    return path.join(this.promptDir(name), 'labels', `${encodeURIComponent(label)}.json`);
  }
}

async function list(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch {
    return [];
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, file);
}
