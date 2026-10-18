/**
 * A directory on disk as an agent's files: what `fileWorkspace()` and `processSandbox()` share. Every
 * path stays under the root; Node's modules load on first use, so importing this needs no Node.
 */
import {
  GREP_FILE_BYTES,
  GREP_TOTAL_BYTES,
  globMatcher,
  matchingLines,
  SKIPPED_DIRECTORIES,
  WALK_LIMIT,
} from './glob.js';

/** The file methods of a directory on disk. */
export interface DirectoryFiles {
  readFile(file: string): Promise<string>;
  writeFile(file: string, content: string): Promise<void>;
  listFiles(directory?: string): Promise<string[]>;
  removeFile(file: string): Promise<void>;
  glob(pattern: string, options?: { cwd?: string; limit?: number }): Promise<string[]>;
  grep(
    pattern: string,
    options?: { cwd?: string; glob?: string; ignoreCase?: boolean; limit?: number },
  ): Promise<Array<{ file: string; line: number; text: string }>>;
  readBytes(file: string): Promise<Uint8Array>;
  writeBytes(file: string, bytes: Uint8Array): Promise<void>;
}

/** The files under `root`, refusing a path outside it with the error `refuse` makes. */
export function directoryFiles(
  rootDirectory: string,
  refuse: (path: string) => Error,
): DirectoryFiles & { ready: Promise<DirectoryHandle> } {
  const ready = (async (): Promise<DirectoryHandle> => {
    const [fs, { dirname, isAbsolute, join, relative, resolve }] = await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
    ]);
    const root = resolve(rootDirectory);
    await fs.mkdir(root, { recursive: true });
    const outside = (fromRoot: string) => fromRoot.startsWith('..') || isAbsolute(fromRoot);
    const inside = (file: string): string => {
      let resolved = resolve(root, file);
      // An absolute path already under the root is taken as it is; any other leading slash names
      // the root, as it does in every workspace.
      if (outside(relative(root, resolved)) && /^[\\/]/.test(file))
        resolved = resolve(root, file.replace(/^[\\/]+/, ''));
      if (outside(relative(root, resolved))) throw refuse(file);
      return resolved;
    };
    return { fs, dirname, join, relative, root, inside };
  })();
  // A root that cannot be created fails every call; it is never an unhandled rejection on its own.
  ready.catch(() => undefined);

  // Search walks the tree itself, breadth first and bounded, and never follows a link, so it cannot
  // leave the root.
  const walk = async (directory: string) => {
    const { fs, join, relative, root, inside } = await ready;
    const start = inside(directory);
    const slash = (path: string) => path.replace(/\\/g, '/');
    const files: Array<{ full: string; fromRoot: string; fromStart: string }> = [];
    const queue = [start];
    let walked = 0;
    while (queue.length > 0 && walked < WALK_LIMIT) {
      const current = queue.shift() as string;
      const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        walked += 1;
        if (walked > WALK_LIMIT) break;
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(full);
        } else if (entry.isFile()) {
          files.push({ full, fromRoot: slash(relative(root, full)), fromStart: slash(relative(start, full)) });
        }
      }
    }
    return files.sort((a, b) => (a.fromRoot < b.fromRoot ? -1 : a.fromRoot > b.fromRoot ? 1 : 0));
  };

  return {
    ready,
    async readFile(file) {
      const { fs, inside } = await ready;
      return fs.readFile(inside(file), 'utf8');
    },
    async writeFile(file, content) {
      const { fs, dirname, inside } = await ready;
      const target = inside(file);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
    },
    async listFiles(directory = '.') {
      const { fs, inside } = await ready;
      return (await fs.readdir(inside(directory))).sort();
    },
    async removeFile(file) {
      const { fs, root, inside } = await ready;
      const target = inside(file);
      if (target === root) throw refuse(file);
      await fs.rm(target, { recursive: true, force: true });
    },
    async glob(pattern, options = {}) {
      const matches = globMatcher(pattern);
      return (await walk(options.cwd ?? '.'))
        .filter((file) => matches(file.fromStart))
        .slice(0, options.limit ?? 1_000)
        .map((file) => file.fromRoot);
    },
    async grep(pattern, options = {}) {
      const { fs } = await ready;
      const expression = new RegExp(pattern, options.ignoreCase ? 'i' : '');
      const only = options.glob ? globMatcher(options.glob) : undefined;
      const limit = options.limit ?? 200;
      const found: Array<{ file: string; line: number; text: string }> = [];
      let scanned = 0;
      for (const file of await walk(options.cwd ?? '.')) {
        if (only && !only(file.fromStart)) continue;
        const size = (await fs.stat(file.full).catch(() => undefined))?.size;
        if (size === undefined || size > GREP_FILE_BYTES) continue;
        scanned += size;
        if (scanned > GREP_TOTAL_BYTES) break;
        const lines = matchingLines(await fs.readFile(file.full), expression, limit - found.length);
        found.push(...lines.map((match) => ({ file: file.fromRoot, ...match })));
        if (found.length >= limit) break;
      }
      return found;
    },
    async readBytes(file) {
      const { fs, inside } = await ready;
      return new Uint8Array(await fs.readFile(inside(file)));
    },
    async writeBytes(file, bytes) {
      const { fs, dirname, inside } = await ready;
      const target = inside(file);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.writeFile(target, bytes);
    },
  };
}

/** What a directory's file methods hold once Node's modules have loaded. */
export interface DirectoryHandle {
  fs: typeof import('node:fs/promises');
  dirname: typeof import('node:path').dirname;
  join: typeof import('node:path').join;
  relative: typeof import('node:path').relative;
  root: string;
  inside: (file: string) => string;
}
