import type { DocumentSource } from './index.js';
import type { FileParser } from './text.js';

/** Options for `loadGitRepository()`. */
export interface GitLoaderOptions {
  /** A branch or tag to read. Cloned at that ref; a local repository without it is read as checked out. */
  ref?: string;
  /** File extensions read, lower case with the dot, such as `['.md', '.ts']`. Defaults to every text file. */
  extensions?: readonly string[];
  /** Skips a path, relative to the repository root with `/` separators. */
  ignore?: (path: string) => boolean;
  /** A parser per extension, as for `loadDirectory()`. Other files load as plain text. */
  parsers?: Record<string, FileParser>;
  /** Files larger than this are skipped, in bytes. Defaults to 1 MB. */
  maxFileBytes?: number;
  /** The `git` executable. Defaults to `git` on the path. */
  git?: string;
  /** Time allowed for the clone, in milliseconds. Defaults to 2 minutes. */
  timeoutMs?: number;
  /** Application data added to every document. */
  metadata?: Record<string, unknown>;
}

/** Raised when `git` fails, with what it printed. */
export class GitLoaderError extends Error {
  constructor(
    message: string,
    /** What `git` wrote to stderr. */
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitLoaderError';
  }
}

const REMOTE = /^(?:https?|ssh|git|file):\/\/|^[\w.-]+@[\w.-]+:/;

/**
 * The files a Git repository tracks, one document each. A remote URL — `https://`, `ssh://`,
 * `git://`, `file://`, or `user@host:path` — is shallow-cloned into a temporary directory that is
 * removed afterwards; a local path is read in place. Only tracked files are read, binary files and
 * files over `maxFileBytes` are skipped, and each document carries the repository and commit in its
 * metadata, so a citation can link to the exact revision.
 *
 * Runs the `git` executable, without a shell, with credential prompts and the `ext::` transport
 * disabled. A clone keeps the committed line endings, so a commit loads the same on every platform.
 */
export async function* loadGitRepository(
  repository: string,
  options: GitLoaderOptions = {},
): AsyncGenerator<DocumentSource> {
  if (repository.startsWith('-')) throw new RangeError('A repository must not start with "-"');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const remote = REMOTE.test(repository);
  const clone = remote || options.ref !== undefined;
  const directory = clone ? await mkdtemp(path.join(tmpdir(), 'nexus-git-')) : repository;

  try {
    if (clone) {
      // A local repository is cloned by path, where git ignores the depth and copies what it needs.
      await git(
        [
          'clone',
          ...(remote ? ['--depth', '1'] : []),
          '--no-tags',
          ...(options.ref ? ['--branch', options.ref] : []),
          '--',
          remote ? repository : path.resolve(repository),
          directory,
        ],
        undefined,
        options,
      );
    }
    const commit = (await git(['rev-parse', 'HEAD'], directory, options)).trim();
    const files = (await git(['ls-files', '-z'], directory, options)).split('\0').filter(Boolean).sort();
    const extensions = options.extensions && new Set(options.extensions.map((extension) => extension.toLowerCase()));
    const maxFileBytes = options.maxFileBytes ?? 1_000_000;

    const { lstat, realpath } = await import('node:fs/promises');
    const checkout = await realpath(directory);
    for (const file of files) {
      const extension = path.extname(file).toLowerCase();
      if (extensions && !extensions.has(extension)) continue;
      if (options.ignore?.(file)) continue;
      let bytes: Uint8Array;
      try {
        const full = path.join(directory, file);
        // A tracked symbolic link can point anywhere on this machine, such as a key file, and a
        // repository is untrusted input: a link is never followed, nor a path that leaves the checkout.
        if ((await lstat(full)).isSymbolicLink()) continue;
        if (!(await realpath(full)).startsWith(checkout + path.sep)) continue;
        bytes = new Uint8Array(await readFile(full));
      } catch {
        continue; // Tracked but deleted from the working tree, or a submodule.
      }
      if (bytes.length > maxFileBytes || bytes.subarray(0, 8000).includes(0)) continue;
      const metadata = { ...options.metadata, repository, commit, path: file };
      const parse = options.parsers?.[extension];
      if (parse) {
        for await (const document of parse({ source: file, content: bytes })) {
          yield { ...document, metadata: { ...metadata, ...document.metadata } };
        }
      } else {
        yield { id: file, text: new TextDecoder().decode(bytes), source: file, metadata };
      }
    }
  } finally {
    if (clone) await rm(directory, { recursive: true, force: true });
  }
}

async function git(args: string[], cwd: string | undefined, options: GitLoaderOptions): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(
      options.git ?? 'git',
      ['-c', 'protocol.ext.allow=never', '-c', 'core.quotePath=false', '-c', 'core.autocrlf=false', ...args],
      {
        cwd,
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) reject(new GitLoaderError(`git ${args[0]} failed: ${stderr.trim() || error.message}`, stderr));
        else resolve(stdout);
      },
    );
  });
}
