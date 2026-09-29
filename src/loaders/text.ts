import type { DocumentLoader, DocumentSource, FileInput } from './index.js';
import { inputsOf, readText } from './input.js';

/** Options shared by the file loaders. */
export interface FileLoaderOptions {
  /** Application data added to every document. */
  metadata?: Record<string, unknown>;
}

/** Plain text files, one document each, whose id and source are the file's path or name. */
export async function* loadText(
  inputs: FileInput | Iterable<FileInput>,
  options: FileLoaderOptions = {},
): AsyncGenerator<DocumentSource> {
  for (const input of inputsOf(inputs)) {
    const { source, text } = await readText(input);
    yield { id: source, text, source, ...(options.metadata ? { metadata: { ...options.metadata } } : {}) };
  }
}

/** Turns one file into documents: a loader such as `loadMarkdown` or `loadHtml`, given a single input. */
export type FileParser = (input: FileInput) => DocumentLoader;

/** Options for `loadDirectory()`. */
export interface DirectoryLoaderOptions extends FileLoaderOptions {
  /**
   * File extensions read, lower case with the dot. Defaults to the extensions `parsers` names, plus
   * `.txt` and `.md`.
   */
  extensions?: readonly string[];
  /** A parser per extension, such as `{ '.html': loadHtml }`. Other files load as plain text. */
  parsers?: Record<string, FileParser>;
  /** Walks subdirectories. On by default. */
  recursive?: boolean;
  /**
   * Skips a path, given relative to the directory with `/` separators. Defaults to skipping
   * `node_modules` and any directory whose name starts with a dot.
   */
  ignore?: (path: string) => boolean;
  /** Stops after this many files, as a guard against pointing at the wrong directory. Defaults to 10,000. */
  maxFiles?: number;
}

const defaultIgnore = (path: string) => path.split('/').some((part) => part === 'node_modules' || part.startsWith('.'));

/**
 * Every matching file under a directory, in sorted order so a load is reproducible. Ids and sources
 * are paths relative to the directory, so the same tree loaded from another checkout produces the
 * same chunk ids.
 */
export async function* loadDirectory(
  directory: string,
  options: DirectoryLoaderOptions = {},
): AsyncGenerator<DocumentSource> {
  const { readdir } = await import('node:fs/promises');
  const path = await import('node:path');
  const parsers = options.parsers ?? {};
  const extensions = new Set(
    (options.extensions ?? ['.txt', '.md', ...Object.keys(parsers)]).map((extension) => extension.toLowerCase()),
  );
  const ignore = options.ignore ?? defaultIgnore;
  const maxFiles = options.maxFiles ?? 10_000;
  const entries = await readdir(directory, { recursive: options.recursive ?? true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter((relative) => extensions.has(path.extname(relative).toLowerCase()) && !ignore(relative))
    .sort();
  if (files.length > maxFiles) {
    throw new RangeError(`${directory} holds ${files.length} matching files, more than maxFiles (${maxFiles})`);
  }

  for (const relative of files) {
    const { readFile } = await import('node:fs/promises');
    const input = { source: relative, content: new Uint8Array(await readFile(path.join(directory, relative))) };
    const parse = parsers[path.extname(relative).toLowerCase()];
    for await (const document of parse ? parse(input) : loadText(input)) {
      yield options.metadata ? { ...document, metadata: { ...options.metadata, ...document.metadata } } : document;
    }
  }
}
