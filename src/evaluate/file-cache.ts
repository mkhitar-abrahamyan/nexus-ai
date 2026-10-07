import type { CachedOutput, EvaluationCache } from './cache.js';

/**
 * Target outputs as JSON files in a directory, one per key, so a CI job keeps them between runs by
 * caching the directory. Writes go through a temporary file and a rename, so a reader never sees half
 * an entry. Outputs must survive `JSON.stringify()`.
 */
export class FileEvaluationCache implements EvaluationCache {
  constructor(private readonly directory: string) {}

  /** The output under a key, or `undefined` when there is none or its file cannot be read. */
  async get(key: string): Promise<CachedOutput | undefined> {
    const { readFile } = await import('node:fs/promises');
    try {
      return JSON.parse(await readFile(await this.fileOf(key), 'utf8')) as CachedOutput;
    } catch {
      return undefined;
    }
  }

  /** Writes an output under a key. */
  async set(key: string, value: CachedOutput): Promise<void> {
    const { mkdir, rename, writeFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const file = await this.fileOf(key);
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), 'utf8');
    await rename(temporary, file);
  }

  private async fileOf(key: string): Promise<string> {
    if (!/^[0-9a-f]{16,}$/.test(key)) throw new RangeError('An evaluation cache key is a hex string');
    const path = await import('node:path');
    return path.join(this.directory, key.slice(0, 2), `${key}.json`);
  }
}
