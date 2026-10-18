/**
 * Workspaces: where an agent's files live, apart from where its code runs.
 *
 * A `Workspace` reads, writes, and lists files, and optionally searches them, removes them, and
 * holds bytes. The package ships five: in memory, on disk, in a long-term `Store` (memory, Redis,
 * Postgres, or SQLite), read-only over another, and a composite that mounts several at paths of its
 * own. A `Sandbox` is a workspace that can also run commands, and says how it is isolated, so one
 * can be given wherever a workspace goes, or mounted in a composite beside the others.
 */
import type { Store, StoreNamespace } from '../types/store.js';
import type { ContentPart, ToolDefinition, ToolOutput } from '../types/messages.js';
import { decodeBase64, encodeBase64 } from '../utils/base64.js';
import { directoryFiles } from './files.js';
import { GREP_FILE_BYTES, GREP_TOTAL_BYTES, globMatcher, MEDIA_TYPES, matchingLines, WALK_LIMIT } from './glob.js';

/** Options for `Workspace.glob()`. */
export interface WorkspaceGlobOptions {
  /** The directory to search, inside the workspace. Defaults to its root. */
  cwd?: string;
  /** The most paths returned. Defaults to 1,000. */
  limit?: number;
}

/** Options for `Workspace.grep()`. */
export interface WorkspaceGrepOptions {
  /** The directory to search, inside the workspace. Defaults to its root. */
  cwd?: string;
  /** Searches only the files whose paths, relative to `cwd`, match this glob. */
  glob?: string;
  /** Matches without regard to case. */
  ignoreCase?: boolean;
  /** The most matching lines returned. Defaults to 200. */
  limit?: number;
}

/** One line `Workspace.grep()` matched. */
export interface WorkspaceMatch {
  /** The file, relative to the workspace's root. */
  file: string;
  /** The line's number, counting from 1. */
  line: number;
  /** The line, cut to 300 characters. */
  text: string;
}

/**
 * Where an agent's files live. Paths are relative to the workspace's root, with `/` between
 * segments; a leading `/` names the root, and a path that would leave it is refused with a
 * `WorkspacePathError`. Reading a file that does not exist rejects with an error whose `code` is
 * `ENOENT`. Every method reports a failure by rejecting, never by throwing.
 */
export interface Workspace {
  /** Names the workspace in reports. */
  readonly name: string;
  /** Reads a text file. */
  readFile(file: string): Promise<string>;
  /** Writes a text file, creating its directory. */
  writeFile(file: string, content: string): Promise<void>;
  /** Lists a directory's entries, files and directories, by name, sorted. */
  listFiles?(directory?: string): Promise<string[]>;
  /** Removes a file, or a directory and everything in it. */
  removeFile?(file: string): Promise<void>;
  /**
   * The files under a directory whose paths match a glob, such as `src/**\/*.ts`, sorted. The glob
   * matches paths relative to `cwd`; the paths returned are relative to the root, as `readFile`
   * takes them. Returns at most `limit`.
   */
  glob?(pattern: string, options?: WorkspaceGlobOptions): Promise<string[]>;
  /**
   * The lines matching a regular expression in the files under a directory, at most `limit`. Files
   * over 1 MB and binary files are skipped.
   */
  grep?(pattern: string, options?: WorkspaceGrepOptions): Promise<WorkspaceMatch[]>;
  /** Reads a file's bytes, for an image, audio, or a document. */
  readBytes?(file: string): Promise<Uint8Array>;
  /** Writes a file's bytes, creating its directory. */
  writeBytes?(file: string, bytes: Uint8Array): Promise<void>;
}

/** Raised when a path would leave the workspace, or lies under no mount of a composite. */
export class WorkspacePathError extends Error {
  /** `WORKSPACE_PATH`, or `SANDBOX_PATH` from a sandbox. */
  readonly code: string = 'WORKSPACE_PATH';

  constructor(
    /** The path that was refused. */
    readonly path: string,
    message = `"${path}" is outside the workspace`,
  ) {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

/** Raised when a read-only workspace, or a read-only mount of a composite, is written to. */
export class WorkspaceReadOnlyError extends Error {
  /** Always `WORKSPACE_READ_ONLY`. */
  readonly code = 'WORKSPACE_READ_ONLY';

  constructor(
    /** The path that was written to. */
    readonly path: string,
  ) {
    super(`"${path}" is read-only`);
    this.name = 'WorkspaceReadOnlyError';
  }
}

/**
 * A path as a workspace holds it: relative to the root, `/` between segments, without `.` or `..`.
 * The root is `''`. A path that would leave the root is refused with a `WorkspacePathError`. For a
 * workspace of your own, so its paths mean what every other's do.
 */
export function resolveWorkspacePath(path: string): string {
  const parts: string[] = [];
  for (const segment of String(path ?? '')
    .replace(/\\/g, '/')
    .split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) throw new WorkspacePathError(path);
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join('/');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A missing file, as Node's file system reports one. */
function missing(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory in the workspace, "${path}"`), {
    code: 'ENOENT',
    path,
  });
}

function conflict(code: 'EISDIR' | 'ENOTDIR', path: string): Error {
  const what = code === 'EISDIR' ? 'is a directory' : 'is under a file, not a directory';
  return Object.assign(new Error(`${code}: "${path}" ${what}`), { code, path });
}

/** A file's path, which cannot be the root. */
function filePath(path: string): string {
  const resolved = resolveWorkspacePath(path);
  if (!resolved) throw conflict('EISDIR', path);
  return resolved;
}

const within = (path: string, directory: string) =>
  !directory || path === directory || path.startsWith(`${directory}/`);
const relativeTo = (path: string, directory: string) => (directory ? path.slice(directory.length + 1) : path);
const parentsOf = (path: string) => {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
};
const sorted = (paths: Iterable<string>) => [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** Grep over files read one at a time, with the limits every workspace keeps. */
async function grepFiles(
  files: readonly string[],
  pattern: string,
  options: WorkspaceGrepOptions,
  read: (file: string) => Promise<Uint8Array | undefined>,
): Promise<WorkspaceMatch[]> {
  const expression = new RegExp(pattern, options.ignoreCase ? 'i' : '');
  const limit = options.limit ?? 200;
  const found: WorkspaceMatch[] = [];
  let scanned = 0;
  for (const file of files) {
    const bytes = await read(file);
    if (!bytes || bytes.byteLength > GREP_FILE_BYTES) continue;
    scanned += bytes.byteLength;
    if (scanned > GREP_TOTAL_BYTES) break;
    for (const match of matchingLines(bytes, expression, limit - found.length)) found.push({ file, ...match });
    if (found.length >= limit) break;
  }
  return found;
}

/** The files under `cwd` matching a glob relative to it, sorted, at most `limit`. */
function globbed(files: Iterable<string>, pattern: string, cwd: string, limit = 1_000): string[] {
  const matches = globMatcher(pattern);
  const found: string[] = [];
  for (const file of sorted(files)) {
    if (!within(file, cwd) || file === cwd || !matches(relativeTo(file, cwd))) continue;
    found.push(file);
    if (found.length >= limit) break;
  }
  return found;
}

// ── In memory ─────────────────────────────────────────────────────

/** Options for `memoryWorkspace()`. */
export interface MemoryWorkspaceOptions {
  /** Names it in reports. Defaults to `memory`. */
  name?: string;
  /** Files it starts with, by path: text, or bytes. */
  files?: Record<string, string | Uint8Array>;
}

/**
 * A workspace in this process's memory: for tests, for scratch work, and for a run whose files need
 * not outlive it. Every method, search included; directories exist while a file is under them.
 */
export function memoryWorkspace(options: MemoryWorkspaceOptions = {}): Workspace {
  const files = new Map<string, Uint8Array>();
  // How many files each directory holds, at any depth, so a directory is found in one lookup.
  const directories = new Map<string, number>();
  const put = (path: string, bytes: Uint8Array) => {
    if (directories.has(path)) throw conflict('EISDIR', path);
    const parents = parentsOf(path);
    for (const parent of parents) if (files.has(parent)) throw conflict('ENOTDIR', path);
    if (!files.has(path)) for (const parent of parents) directories.set(parent, (directories.get(parent) ?? 0) + 1);
    files.set(path, bytes.slice());
  };
  const drop = (path: string) => {
    if (!files.delete(path)) return;
    for (const parent of parentsOf(path)) {
      const left = (directories.get(parent) ?? 1) - 1;
      if (left > 0) directories.set(parent, left);
      else directories.delete(parent);
    }
  };
  for (const [path, content] of Object.entries(options.files ?? {})) {
    put(filePath(path), typeof content === 'string' ? encoder.encode(content) : content);
  }
  const bytesOf = (path: string) => {
    const resolved = filePath(path);
    const bytes = files.get(resolved);
    if (!bytes) throw missing(path);
    return bytes;
  };
  return {
    name: options.name ?? 'memory',
    async readFile(file) {
      return decoder.decode(bytesOf(file));
    },
    async writeFile(file, content) {
      put(filePath(file), encoder.encode(content));
    },
    async listFiles(directory = '') {
      const dir = resolveWorkspacePath(directory);
      if (dir && !directories.has(dir)) throw missing(directory);
      const prefix = dir ? `${dir}/` : '';
      const names = new Set<string>();
      for (const path of files.keys()) {
        if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split('/')[0] as string);
      }
      return sorted(names);
    },
    async removeFile(file) {
      const path = resolveWorkspacePath(file);
      if (!path) throw new WorkspacePathError(file, 'The workspace root cannot be removed');
      if (files.has(path)) drop(path);
      else for (const each of [...files.keys()]) if (each.startsWith(`${path}/`)) drop(each);
    },
    async glob(pattern, globOptions = {}) {
      return globbed(files.keys(), pattern, resolveWorkspacePath(globOptions.cwd ?? ''), globOptions.limit);
    },
    async grep(pattern, grepOptions = {}) {
      const cwd = resolveWorkspacePath(grepOptions.cwd ?? '');
      const candidates = globbed(files.keys(), grepOptions.glob ?? '**', cwd, WALK_LIMIT);
      return grepFiles(candidates, pattern, grepOptions, async (path) => files.get(path));
    },
    async readBytes(file) {
      return bytesOf(file).slice();
    },
    async writeBytes(file, bytes) {
      put(filePath(file), bytes);
    },
  };
}

// ── On disk ───────────────────────────────────────────────────────

/** Options for `fileWorkspace()`. */
export interface FileWorkspaceOptions {
  /** The directory the files live under. Created when missing. */
  root: string;
  /** Names it in reports. Defaults to `files`. */
  name?: string;
}

/**
 * A directory on disk as a workspace, on Node. Every path stays under `root`, and its search skips
 * `.git` and `node_modules`, walks at most 20,000 entries, and follows no links. It runs nothing: a
 * workspace holds files, a sandbox runs code.
 */
export function fileWorkspace(options: FileWorkspaceOptions): Workspace {
  const files = directoryFiles(options.root, (path) => new WorkspacePathError(path));
  // Every path means what it means in every other workspace: a leading `/` names the root.
  const at = (path: string | undefined) => resolveWorkspacePath(path ?? '') || '.';
  return {
    name: options.name ?? 'files',
    readFile: async (file) => files.readFile(at(file)),
    writeFile: async (file, content) => files.writeFile(filePath(file), content),
    listFiles: async (directory) => files.listFiles(at(directory)),
    async removeFile(file) {
      if (!resolveWorkspacePath(file)) throw new WorkspacePathError(file, 'The workspace root cannot be removed');
      await files.removeFile(at(file));
    },
    glob: async (pattern, globOptions = {}) => files.glob(pattern, { ...globOptions, cwd: at(globOptions.cwd) }),
    grep: async (pattern, grepOptions = {}) => files.grep(pattern, { ...grepOptions, cwd: at(grepOptions.cwd) }),
    readBytes: async (file) => files.readBytes(at(file)),
    writeBytes: async (file, bytes) => files.writeBytes(filePath(file), bytes),
  };
}

// ── In a store ────────────────────────────────────────────────────

/** Options for `storeWorkspace()`. */
export interface StoreWorkspaceOptions {
  /** Where its files are kept in the store. Defaults to `['nexus', 'workspace']`. */
  namespace?: StoreNamespace;
  /** Names it in reports. Defaults to `store`. */
  name?: string;
}

/** A file or directory's entry in a store workspace's tree: small, so a listing reads no contents. */
interface TreeEntry {
  path: string;
  /** The directory it is in, `''` for the root, so a listing is one filtered search. */
  dir: string;
  kind: 'file' | 'directory';
  size?: number;
}

/** A file's contents in a store workspace: text as written, or bytes in base64. */
interface Blob {
  text?: string;
  base64?: string;
}

/**
 * A workspace in a long-term `Store`: the memory, Redis, Postgres, or SQLite store, so an agent's
 * files outlive its process and every replica sees the same ones. Each file is two items: its
 * contents, and a small entry in a tree, so listing and searching read entries, not contents. Files
 * are never indexed for semantic search.
 *
 * A write stores the contents before the entry, so a process that stops between the two leaves a
 * file that reads but is not listed, until it is written again.
 */
export function storeWorkspace(store: Store, options: StoreWorkspaceOptions = {}): Workspace {
  const base = [...(options.namespace ?? ['nexus', 'workspace'])];
  const tree = [...base, 'tree'];
  const blobs = [...base, 'blobs'];
  const known = new Set<string>();
  const page = 500;

  const entry = async (path: string) => (await store.get<TreeEntry>(tree, path))?.value;
  const all = async (filter: Partial<TreeEntry>): Promise<TreeEntry[]> => {
    const found: TreeEntry[] = [];
    for (let offset = 0; offset < WALK_LIMIT; offset += page) {
      const items = await store.search<TreeEntry>(tree, { filter, limit: page, offset });
      found.push(...items.map((item) => item.value));
      if (items.length < page) break;
    }
    return found;
  };
  const read = async (path: string): Promise<Uint8Array | undefined> => {
    const blob = (await store.get<Blob>(blobs, path))?.value;
    if (!blob) return undefined;
    return blob.base64 !== undefined ? decodeBase64(blob.base64) : encoder.encode(blob.text ?? '');
  };
  const write = async (file: string, blob: Blob, size: number) => {
    const path = filePath(file);
    const existing = await entry(path);
    if (existing?.kind === 'directory') throw conflict('EISDIR', file);
    for (const parent of parentsOf(path)) {
      if (known.has(parent)) continue;
      const found = await entry(parent);
      if (found?.kind === 'file') throw conflict('ENOTDIR', file);
      if (!found) {
        const dir = parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '';
        await store.put<TreeEntry>(tree, parent, { path: parent, dir, kind: 'directory' }, { index: false });
      }
      known.add(parent);
    }
    await store.put(blobs, path, blob, { index: false });
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    await store.put<TreeEntry>(tree, path, { path, dir, kind: 'file', size }, { index: false });
  };
  const filesUnder = async (cwd: string) =>
    (await all({ kind: 'file' })).map((item) => item.path).filter((path) => within(path, cwd));

  return {
    name: options.name ?? 'store',
    async readFile(file) {
      const bytes = await read(filePath(file));
      if (!bytes) throw missing(file);
      return decoder.decode(bytes);
    },
    async writeFile(file, content) {
      await write(file, { text: content }, encoder.encode(content).byteLength);
    },
    async listFiles(directory = '') {
      const dir = resolveWorkspacePath(directory);
      if (dir && (await entry(dir))?.kind !== 'directory') throw missing(directory);
      return sorted((await all({ dir })).map((item) => relativeTo(item.path, dir)));
    },
    async removeFile(file) {
      const path = resolveWorkspacePath(file);
      if (!path) throw new WorkspacePathError(file, 'The workspace root cannot be removed');
      const found = await entry(path);
      if (!found) return;
      const gone =
        found.kind === 'file' ? [found] : [...(await all({})).filter((item) => within(item.path, path)), found];
      for (const item of gone) {
        if (item.kind === 'file') await store.delete(blobs, item.path);
        await store.delete(tree, item.path);
        known.delete(item.path);
      }
    },
    async glob(pattern, globOptions = {}) {
      const cwd = resolveWorkspacePath(globOptions.cwd ?? '');
      return globbed(await filesUnder(cwd), pattern, cwd, globOptions.limit);
    },
    async grep(pattern, grepOptions = {}) {
      const cwd = resolveWorkspacePath(grepOptions.cwd ?? '');
      const candidates = globbed(await filesUnder(cwd), grepOptions.glob ?? '**', cwd, WALK_LIMIT);
      return grepFiles(candidates, pattern, grepOptions, read);
    },
    async readBytes(file) {
      const bytes = await read(filePath(file));
      if (!bytes) throw missing(file);
      return bytes;
    },
    async writeBytes(file, bytes) {
      await write(file, { base64: encodeBase64(bytes) }, bytes.byteLength);
    },
  };
}

// ── Read-only, and composite ──────────────────────────────────────

/** A workspace that reads another and refuses every write with a `WorkspaceReadOnlyError`. */
export function readOnlyWorkspace(workspace: Workspace): Workspace {
  const refuse = async (file: string): Promise<never> => {
    throw new WorkspaceReadOnlyError(file);
  };
  return {
    name: `${workspace.name} (read-only)`,
    readFile: (file) => workspace.readFile(file),
    writeFile: (file) => refuse(file),
    ...(workspace.listFiles ? { listFiles: workspace.listFiles.bind(workspace) } : {}),
    ...(workspace.removeFile ? { removeFile: (file: string) => refuse(file) } : {}),
    ...(workspace.glob ? { glob: workspace.glob.bind(workspace) } : {}),
    ...(workspace.grep ? { grep: workspace.grep.bind(workspace) } : {}),
    ...(workspace.readBytes ? { readBytes: workspace.readBytes.bind(workspace) } : {}),
    ...(workspace.writeBytes ? { writeBytes: (file: string) => refuse(file) } : {}),
  };
}

/** One mount of a composite workspace: a workspace, read-only or not. */
export interface WorkspaceMount {
  /** The workspace mounted. */
  workspace: Workspace;
  /** Refuses writes to it through the composite. */
  readOnly?: boolean;
}

/** Options for `compositeWorkspace()`. */
export interface CompositeWorkspaceOptions {
  /** Names it in reports. Defaults to `composite`. */
  name?: string;
}

/**
 * Several workspaces as one, each mounted at a path: a sandbox at the root for the code, a store at
 * `memories` for what outlives the run, read-only docs at `docs`. A path goes to the deepest mount it
 * is under, as that mount's own path; a listing shows the mounts below a directory as directories;
 * search spans every mount under the directory searched, and a mount without `glob` is left out of
 * it. A path under no mount is refused, so a composite without a root mount has only its mounts.
 *
 * ```ts
 * const workspace = compositeWorkspace({
 *   '/': sandbox,
 *   memories: storeWorkspace(store, { namespace: ['agents', tenantId] }),
 *   docs: { workspace: fileWorkspace({ root: './docs' }), readOnly: true },
 * });
 * ```
 */
export function compositeWorkspace(
  mounts: Record<string, Workspace | WorkspaceMount>,
  options: CompositeWorkspaceOptions = {},
): Workspace {
  const table = Object.entries(mounts)
    .map(([path, value]) => {
      const mount = 'workspace' in value && !('readFile' in value) ? value : { workspace: value as Workspace };
      return { path: resolveWorkspacePath(path), workspace: mount.workspace, readOnly: mount.readOnly === true };
    })
    // Deepest first, so a path goes to the most specific mount.
    .sort((a, b) => b.path.length - a.path.length);
  if (new Set(table.map((mount) => mount.path)).size !== table.length) {
    throw new Error('A composite workspace mounts each path once');
  }
  type Mount = (typeof table)[number];
  const owner = (path: string): Mount | undefined => table.find((mount) => within(path, mount.path));
  const route = (file: string) => {
    const path = resolveWorkspacePath(file);
    const mount = owner(path);
    if (!mount) throw new WorkspacePathError(file, `"${file}" is under no mount of the workspace`);
    return { mount, path, inner: relativeTo(path, mount.path) || '.' };
  };
  const writable = (file: string) => {
    const routed = route(file);
    if (routed.mount.readOnly) throw new WorkspaceReadOnlyError(file);
    return routed;
  };
  const outer = (mount: Mount, inner: string) => (mount.path ? `${mount.path}/${inner}` : inner);
  // The mounts whose files can be under `cwd`, with each one's own directory to search.
  const searched = (cwd: string) =>
    table.flatMap((mount) => {
      if (within(mount.path, cwd)) return [{ mount, cwd: '.' }];
      if (within(cwd, mount.path) && owner(cwd) === mount) return [{ mount, cwd: relativeTo(cwd, mount.path) || '.' }];
      return [];
    });
  // A file a deeper mount shadows belongs to that mount, not to the one it was found in.
  const filesUnder = async (cwd: string) => {
    const found: string[] = [];
    for (const { mount, cwd: inner } of searched(cwd)) {
      if (!mount.workspace.glob) continue;
      for (const path of await mount.workspace.glob('**', { cwd: inner, limit: WALK_LIMIT })) {
        const full = outer(mount, path);
        if (owner(full) === mount) found.push(full);
      }
    }
    return found;
  };
  // One mount holds everything under `cwd`: its own search answers, faster than the composite's.
  const alone = (cwd: string) => {
    const reach = searched(cwd);
    return reach.length === 1 ? reach[0] : undefined;
  };

  return {
    name: options.name ?? `composite (${table.map((mount) => `/${mount.path}: ${mount.workspace.name}`).join(', ')})`,
    async readFile(file) {
      const { mount, inner } = route(file);
      return mount.workspace.readFile(inner);
    },
    async writeFile(file, content) {
      const { mount, inner } = writable(file);
      return mount.workspace.writeFile(inner, content);
    },
    async listFiles(directory = '') {
      const dir = resolveWorkspacePath(directory);
      const names = new Set<string>();
      for (const mount of table) {
        if (mount.path !== dir && within(mount.path, dir))
          names.add(relativeTo(mount.path, dir).split('/')[0] as string);
      }
      const mount = owner(dir);
      if (mount?.workspace.listFiles) {
        try {
          for (const name of await mount.workspace.listFiles(relativeTo(dir, mount.path) || '.')) names.add(name);
        } catch (error) {
          if (names.size === 0) throw error;
        }
      } else if (names.size === 0) {
        throw mount
          ? missing(directory)
          : new WorkspacePathError(directory, `"${directory}" is under no mount of the workspace`);
      }
      return sorted(names);
    },
    async removeFile(file) {
      const { mount, inner, path } = writable(file);
      if (table.some((other) => other.path === path)) {
        throw new WorkspacePathError(file, `"${file}" is a mount of the workspace, and cannot be removed`);
      }
      if (!mount.workspace.removeFile) throw new Error(`${mount.workspace.name} cannot remove files`);
      await mount.workspace.removeFile(inner);
    },
    async glob(pattern, globOptions = {}) {
      const cwd = resolveWorkspacePath(globOptions.cwd ?? '');
      const only = alone(cwd);
      if (only?.mount.workspace.glob) {
        const found = await only.mount.workspace.glob(pattern, { cwd: only.cwd, limit: globOptions.limit ?? 1_000 });
        return found.map((path) => outer(only.mount, path));
      }
      return globbed(await filesUnder(cwd), pattern, cwd, globOptions.limit);
    },
    async grep(pattern, grepOptions = {}) {
      const cwd = resolveWorkspacePath(grepOptions.cwd ?? '');
      const only = alone(cwd);
      if (only?.mount.workspace.grep) {
        const found = await only.mount.workspace.grep(pattern, { ...grepOptions, cwd: only.cwd });
        return found.map((match) => ({ ...match, file: outer(only.mount, match.file) }));
      }
      const candidates = globbed(await filesUnder(cwd), grepOptions.glob ?? '**', cwd, WALK_LIMIT);
      return grepFiles(candidates, pattern, grepOptions, async (file) => {
        const { mount, inner } = route(file);
        if (mount.workspace.readBytes) return mount.workspace.readBytes(inner).catch(() => undefined);
        return mount.workspace.readFile(inner).then(
          (text) => encoder.encode(text),
          () => undefined,
        );
      });
    },
    async readBytes(file) {
      const { mount, inner } = route(file);
      if (mount.workspace.readBytes) return mount.workspace.readBytes(inner);
      return encoder.encode(await mount.workspace.readFile(inner));
    },
    async writeBytes(file, bytes) {
      const { mount, inner } = writable(file);
      if (!mount.workspace.writeBytes) throw new Error(`${mount.workspace.name} cannot hold bytes`);
      await mount.workspace.writeBytes(inner, bytes);
    },
  };
}

// ── Tools ─────────────────────────────────────────────────────────

/** Options for `workspaceTools()`. */
export interface WorkspaceToolsOptions {
  /** The largest file `read_media` sends to the model, in bytes. Defaults to 10 MB. */
  maxMediaBytes?: number;
  /**
   * The path a permission policy sees the workspace's files under. Defaults to `/workspace`, so a
   * policy granting `/workspace/**` grants the workspace.
   */
  mount?: string;
}

/** The most paths `glob_files` lists. */
const GLOB_LIMIT = 500;
/** The most lines `grep_files` lists. */
const GREP_LIMIT = 200;

/**
 * The file tools over a workspace: `read_file` and `write_file`, and, where the workspace can,
 * `list_files`, `glob_files`, `grep_files`, and `read_media`. Each declares `filesystem:read` or
 * `filesystem:write` with the path under `mount`, so a permission policy can grant the workspace,
 * or part of it, and nothing else.
 */
export function workspaceTools(workspace: Workspace, options: WorkspaceToolsOptions = {}): ToolDefinition[] {
  const mount = (options.mount ?? '/workspace').replace(/\/+$/, '');
  // A model may name a file as `notes.txt` or as `/workspace/notes.txt`; both are the same file.
  const local = (file: unknown): string => {
    const unified = String(file ?? '.').replace(/\\/g, '/');
    const relative =
      unified === mount ? '.' : unified.startsWith(`${mount}/`) ? unified.slice(mount.length + 1) : unified;
    return relative.replace(/^\/+/, '') || '.';
  };
  const mounted = (file: unknown) => `${mount}/${local(file)}`;
  const tools: ToolDefinition[] = [
    {
      name: 'read_file',
      description: `Reads a text file in the workspace. Paths are relative to ${mount}.`,
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      capabilities: (args) => [`filesystem:read:${mounted(args.path)}`],
      execute: async (args) => workspace.readFile(local(args.path)),
    },
    {
      name: 'write_file',
      description: `Writes a text file in the workspace, creating its directory. Paths are relative to ${mount}.`,
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      capabilities: (args) => [`filesystem:write:${mounted(args.path)}`],
      execute: async (args) => {
        await workspace.writeFile(local(args.path), String(args.content ?? ''));
        return { written: local(args.path) };
      },
    },
  ];
  if (workspace.listFiles) {
    const list = workspace.listFiles.bind(workspace);
    tools.push({
      name: 'list_files',
      description: 'Lists the entries of a directory in the workspace.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      capabilities: (args) => [`filesystem:read:${mounted(args.path)}`],
      execute: async (args) => list(local(args.path)),
    });
  }
  if (workspace.glob) {
    const glob = workspace.glob.bind(workspace);
    tools.push({
      name: 'glob_files',
      description: `Finds files by a glob, such as **/*.ts or src/*.{js,json}, and lists their paths relative to ${mount}, at most ${GLOB_LIMIT}.`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The glob the paths must match' },
          path: { type: 'string', description: 'The directory to search. Defaults to the whole workspace' },
        },
        required: ['pattern'],
      },
      capabilities: (args) => [`filesystem:read:${mounted(args.path)}`],
      execute: async (args) => {
        const files = await glob(String(args.pattern ?? '**'), { cwd: local(args.path), limit: GLOB_LIMIT + 1 });
        if (files.length === 0) return 'No files match.';
        const shown = files.slice(0, GLOB_LIMIT).join('\n');
        return files.length > GLOB_LIMIT ? `${shown}\n[more files match: narrow the glob]` : shown;
      },
    });
  }
  if (workspace.grep) {
    const grep = workspace.grep.bind(workspace);
    tools.push({
      name: 'grep_files',
      description: `Searches files for lines matching a regular expression and lists each as path:line: text, at most ${GREP_LIMIT}. Large and binary files are skipped.`,
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'The regular expression to find' },
          path: { type: 'string', description: 'The directory to search. Defaults to the whole workspace' },
          glob: { type: 'string', description: 'Searches only files matching this glob, such as **/*.ts' },
          ignore_case: { type: 'boolean', description: 'Matches without regard to case' },
        },
        required: ['pattern'],
      },
      capabilities: (args) => [`filesystem:read:${mounted(args.path)}`],
      execute: async (args) => {
        const found = await grep(String(args.pattern ?? ''), {
          cwd: local(args.path),
          ...(typeof args.glob === 'string' && args.glob ? { glob: args.glob } : {}),
          ignoreCase: args.ignore_case === true,
          limit: GREP_LIMIT + 1,
        });
        if (found.length === 0) return 'No lines match.';
        const shown = found
          .slice(0, GREP_LIMIT)
          .map((match) => `${match.file}:${match.line}: ${match.text}`)
          .join('\n');
        return found.length > GREP_LIMIT ? `${shown}\n[more lines match: narrow the search]` : shown;
      },
    });
  }
  if (workspace.readBytes) {
    const readBytes = workspace.readBytes.bind(workspace);
    const maxBytes = options.maxMediaBytes ?? 10 * 1_048_576;
    tools.push({
      name: 'read_media',
      description: `Shows you an image (PNG, JPEG, GIF, WebP), audio (WAV, MP3, FLAC, OGG, AAC), or a PDF in the workspace as content you see or hear, not as text. Paths are relative to ${mount}.`,
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      capabilities: (args) => [`filesystem:read:${mounted(args.path)}`],
      execute: async (args) => {
        const file = local(args.path);
        const mimeType = MEDIA_TYPES[file.split('.').pop()?.toLowerCase() ?? ''];
        if (!mimeType) throw new Error(`${file} is not an image, audio, or PDF file; read text with read_file`);
        const bytes = await readBytes(file);
        if (bytes.byteLength > maxBytes) {
          throw new Error(`${file} is ${bytes.byteLength} bytes, over the ${maxBytes}-byte limit for media`);
        }
        return mediaOutput(file, mimeType, bytes);
      },
    });
  }
  return tools;
}

/** A media file as content the model sees or hears, after a line naming it. Base64 survives a checkpoint. */
function mediaOutput(file: string, mimeType: string, bytes: Uint8Array): ToolOutput {
  const data = encodeBase64(bytes);
  const part: ContentPart = mimeType.startsWith('image/')
    ? { type: 'image', source: { base64: data, mimeType } }
    : mimeType.startsWith('audio/')
      ? { type: 'audio', source: { base64: data, format: mimeType.slice('audio/'.length) } }
      : { type: 'document', source: { base64: data, mimeType }, filename: file.split('/').pop() ?? file };
  return {
    type: 'tool_output',
    content: [{ type: 'text', text: `${file} (${mimeType}, ${bytes.byteLength} bytes)` }, part],
  };
}

// ── Conformance ───────────────────────────────────────────────────

/** One conformance check's result. */
export interface WorkspaceConformanceCheck {
  /** What was checked. */
  name: string;
  /** Whether it held. */
  ok: boolean;
  /** What went wrong, when it did not. */
  detail?: string;
}

/** What `runWorkspaceConformance()` found. */
export interface WorkspaceConformanceReport {
  /** The workspace's name. */
  workspace: string;
  /** True when every check held. */
  passed: boolean;
  /** Every check, in order. A method the workspace does not have is not checked. */
  checks: WorkspaceConformanceCheck[];
}

/**
 * Checks a workspace against the contract, without a test framework, so any workspace (a bucket, a
 * database, a hosted file service) can prove itself the same way:
 *
 * - text files round-trip, are replaced when written again, and directories are created for them;
 * - a missing file is refused with `ENOENT`, and a path that would leave the workspace is refused;
 * - a listing names a directory's files and directories, sorted;
 * - glob matches paths relative to its directory, sorted, within its limit;
 * - grep finds lines by number, within a glob, without regard to case when asked, within its limit,
 *   skipping binary files;
 * - bytes round-trip, and a text file reads as its bytes;
 * - a file, and a directory with everything in it, are removed.
 *
 * Every check runs on a fresh workspace from `create`.
 */
export async function runWorkspaceConformance(
  create: () => Workspace | Promise<Workspace>,
): Promise<WorkspaceConformanceReport> {
  const checks: WorkspaceConformanceCheck[] = [];
  let name = 'workspace';
  const check = async (label: string, run: (workspace: Workspace) => Promise<string | undefined>) => {
    const workspace = await create();
    name = workspace.name;
    try {
      const problem = await run(workspace);
      checks.push(problem ? { name: label, ok: false, detail: problem } : { name: label, ok: true });
    } catch (error) {
      checks.push({ name: label, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };
  const expect = (actual: unknown, expected: unknown, what: string) =>
    JSON.stringify(actual) === JSON.stringify(expected)
      ? undefined
      : `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  const refuses = async (attempt: Promise<unknown>, code?: string) =>
    attempt.then(
      () => false,
      (error: { code?: string }) => code === undefined || error?.code === code,
    );

  await check('text files round-trip, are replaced, and their directories are made', async (workspace) => {
    await workspace.writeFile('deep/inside/note.txt', 'first ✓');
    const first = await workspace.readFile('deep/inside/note.txt');
    await workspace.writeFile('deep/inside/note.txt', 'second');
    const second = await workspace.readFile('/deep/./inside/note.txt');
    return expect(first, 'first ✓', 'readFile') ?? expect(second, 'second', 'readFile after a rewrite');
  });
  await check('a missing file, and a path out of the workspace, are refused', async (workspace) => {
    if (!(await refuses(workspace.readFile('nowhere.txt'), 'ENOENT')))
      return 'reading a missing file did not reject with ENOENT';
    for (const attempt of ['../outside.txt', 'inside/../../outside.txt']) {
      if (!(await refuses(workspace.writeFile(attempt, 'escaped')))) return `writeFile("${attempt}") was allowed`;
    }
    return undefined;
  });
  await check('a listing names files and directories, sorted', async (workspace) => {
    if (!workspace.listFiles) return undefined;
    await workspace.writeFile('list/b.txt', 'b');
    await workspace.writeFile('list/a.txt', 'a');
    await workspace.writeFile('list/sub/c.txt', 'c');
    return (
      expect(await workspace.listFiles('list'), ['a.txt', 'b.txt', 'sub'], 'listFiles("list")') ??
      expect((await workspace.listFiles()).includes('list'), true, 'the root lists "list"')
    );
  });
  await check('glob matches paths relative to its directory, sorted, within its limit', async (workspace) => {
    if (!workspace.glob) return undefined;
    for (const file of ['src/b.ts', 'src/a.ts', 'src/lib/c.ts', 'src/readme.md', 'other/d.ts']) {
      await workspace.writeFile(file, 'x');
    }
    return (
      expect(
        await workspace.glob('**/*.ts', { cwd: 'src' }),
        ['src/a.ts', 'src/b.ts', 'src/lib/c.ts'],
        'glob in src',
      ) ??
      expect(await workspace.glob('*.ts', { cwd: 'src' }), ['src/a.ts', 'src/b.ts'], 'a glob without **') ??
      expect((await workspace.glob('**/*.ts', { limit: 2 })).length, 2, 'the limit')
    );
  });
  await check('grep finds lines by number, within a glob and a limit, and skips binary files', async (workspace) => {
    if (!workspace.grep) return undefined;
    await workspace.writeFile('g/one.ts', 'alpha\nTODO first\nbeta');
    await workspace.writeFile('g/two.md', 'todo second');
    if (workspace.writeBytes) await workspace.writeBytes('g/bin.dat', new Uint8Array([84, 79, 68, 79, 0, 1, 2]));
    const all = await workspace.grep('todo', { cwd: 'g', ignoreCase: true });
    const onlyTs = await workspace.grep('TODO', { cwd: 'g', glob: '*.ts' });
    const limited = await workspace.grep('o', { cwd: 'g', limit: 1 });
    return (
      expect(
        all.map((match) => `${match.file}:${match.line}:${match.text}`),
        ['g/one.ts:2:TODO first', 'g/two.md:1:todo second'],
        'grep without regard to case',
      ) ??
      expect(
        onlyTs.map((match) => match.file),
        ['g/one.ts'],
        'grep within a glob',
      ) ??
      expect(limited.length, 1, 'the limit')
    );
  });
  await check('bytes round-trip, and a text file reads as its bytes', async (workspace) => {
    if (!workspace.readBytes) return undefined;
    await workspace.writeFile('bytes/text.txt', 'hé');
    const text = Array.from(await workspace.readBytes('bytes/text.txt'));
    if (!workspace.writeBytes) return expect(text, [104, 195, 169], 'readBytes of a text file');
    const bytes = new Uint8Array([0, 255, 128, 7, 10]);
    await workspace.writeBytes('bytes/raw.bin', bytes);
    return (
      expect(text, [104, 195, 169], 'readBytes of a text file') ??
      expect(Array.from(await workspace.readBytes('bytes/raw.bin')), Array.from(bytes), 'bytes')
    );
  });
  await check('a file, and a directory with everything in it, are removed', async (workspace) => {
    if (!workspace.removeFile) return undefined;
    await workspace.writeFile('gone/file.txt', 'x');
    await workspace.writeFile('gone/dir/a.txt', 'a');
    await workspace.writeFile('gone/dir/deeper/b.txt', 'b');
    await workspace.removeFile('gone/file.txt');
    await workspace.removeFile('gone/dir');
    const fileGone = await refuses(workspace.readFile('gone/file.txt'), 'ENOENT');
    const deepGone = await refuses(workspace.readFile('gone/dir/deeper/b.txt'), 'ENOENT');
    if (!fileGone) return 'the file was not removed';
    if (!deepGone) return "the directory's files were not removed";
    if (workspace.glob && (await workspace.glob('**', { cwd: 'gone' })).length) return 'glob still finds removed files';
    return undefined;
  });

  return { workspace: name, passed: checks.every((item) => item.ok), checks };
}
