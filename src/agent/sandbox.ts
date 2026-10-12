/**
 * The sandbox contract: where an agent's commands and code run, and where its files live.
 *
 * The package ships the contract and a conformance suite, not the isolation: a container, a VM, a
 * remote interpreter, or a hosted sandbox fills the `Sandbox` interface. `processSandbox()` is a
 * reference for development, which runs commands as ordinary processes; it says so in its
 * `isolation`, and is never a security boundary.
 */
import type { ContentPart, ToolDefinition, ToolOutput } from '../types/messages.js';
import { encodeBase64 } from '../utils/base64.js';
import {
  GREP_FILE_BYTES,
  GREP_TOTAL_BYTES,
  globMatcher,
  MEDIA_TYPES,
  matchingLines,
  SKIPPED_DIRECTORIES,
  WALK_LIMIT,
} from './glob.js';

/** Options for one command. */
export interface SandboxExecOptions {
  /** The working directory, inside the sandbox. Defaults to its root. */
  cwd?: string;
  /** Environment variables for the command. The host's own are never passed through. */
  env?: Record<string, string>;
  /** Sent to the command's standard input. */
  stdin?: string;
  /** Stops the command after this many milliseconds. */
  timeoutMs?: number;
  /** Stops the command when aborted. */
  signal?: AbortSignal;
}

/** What a command did. */
export interface SandboxExecResult {
  /** Its exit code, or `null` when it was stopped. */
  exitCode: number | null;
  /** What it wrote to standard output. */
  stdout: string;
  /** What it wrote to standard error. */
  stderr: string;
  /** True when it was stopped by its timeout. */
  timedOut: boolean;
  /** How long it ran, in milliseconds. */
  durationMs: number;
}

/** Options for `Sandbox.glob()`. */
export interface SandboxGlobOptions {
  /** The directory to search, inside the sandbox. Defaults to its root. */
  cwd?: string;
  /** The most paths returned. Defaults to 1,000. */
  limit?: number;
}

/** Options for `Sandbox.grep()`. */
export interface SandboxGrepOptions {
  /** The directory to search, inside the sandbox. Defaults to its root. */
  cwd?: string;
  /** Searches only the files whose paths, relative to `cwd`, match this glob. */
  glob?: string;
  /** Matches without regard to case. */
  ignoreCase?: boolean;
  /** The most matching lines returned. Defaults to 200. */
  limit?: number;
}

/** One line `Sandbox.grep()` matched. */
export interface SandboxMatch {
  /** The file, relative to the sandbox's root. */
  file: string;
  /** The line's number, counting from 1. */
  line: number;
  /** The line, cut to 300 characters. */
  text: string;
}

/** What a sandbox claims to isolate. The conformance suite checks the claims it can observe. */
export interface SandboxIsolation {
  /** Commands cannot read or write the host's files. */
  filesystem: boolean;
  /** Commands cannot reach the network, or only what the sandbox allows. */
  network: boolean;
  /** Commands cannot see or signal the host's processes. */
  processes: boolean;
}

/** Where an agent's commands, code, and files go. The application provides one. */
export interface Sandbox {
  /** Names the sandbox in reports. */
  readonly name: string;
  /** What it isolates. */
  readonly isolation: SandboxIsolation;
  /** Runs a command line in the sandbox. */
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;
  /** Reads a file, by a path inside the sandbox. */
  readFile(file: string): Promise<string>;
  /** Writes a file, creating its directory. */
  writeFile(file: string, content: string): Promise<void>;
  /** Lists a directory's entries. */
  listFiles?(directory?: string): Promise<string[]>;
  /** Removes a file or directory. */
  removeFile?(file: string): Promise<void>;
  /**
   * The files under a directory whose paths match a glob, such as `src/**\/*.ts`, sorted. The glob
   * matches paths relative to `cwd`; the paths returned are relative to the root, as `readFile`
   * takes them. Returns at most `limit`.
   */
  glob?(pattern: string, options?: SandboxGlobOptions): Promise<string[]>;
  /**
   * The lines matching a regular expression in the files under a directory, at most `limit`. Large
   * files and binary files are skipped.
   */
  grep?(pattern: string, options?: SandboxGrepOptions): Promise<SandboxMatch[]>;
  /** Reads a file's bytes, for an image, audio, or a document. */
  readBytes?(file: string): Promise<Uint8Array>;
  /** Releases the sandbox. */
  dispose?(): Promise<void>;
}

/** Raised when a path would leave the sandbox. */
export class SandboxPathError extends Error {
  /** Always `SANDBOX_PATH`. */
  readonly code = 'SANDBOX_PATH';

  constructor(
    /** The path that was refused. */
    readonly path: string,
  ) {
    super(`"${path}" is outside the sandbox`);
    this.name = 'SandboxPathError';
  }
}

/** Options for `processSandbox()`. */
export interface ProcessSandboxOptions {
  /** The directory commands run in and files live under. Created when missing. */
  root: string;
  /** Environment variables every command gets, on top of a minimal `PATH`. */
  env?: Record<string, string>;
  /** Timeout for a command that sets none. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Output kept per stream, in bytes. Defaults to 1 MB. */
  maxOutputBytes?: number;
}

/**
 * A sandbox that runs commands as ordinary processes in a directory, for development and tests only.
 *
 * Its file methods refuse any path outside `root`, and commands get only `PATH` and the variables
 * given, never the host's environment. But a command it runs can read and write anything the user
 * can, and reach any host: `isolation` says so. Use a container or a VM in production.
 *
 * Its search skips `.git` and `node_modules`, walks at most 20,000 entries, and follows no links;
 * `grep()` skips files over 1 MB and binary files, reads at most 64 MB, and searches the first
 * 4,000 characters of each line.
 */
export function processSandbox(options: ProcessSandboxOptions): Sandbox {
  // Node's modules load on first use, so importing this module needs no Node: a deep agent over a
  // container sandbox runs on any runtime, and only a process sandbox needs Node.
  const ready = (async () => {
    const [{ spawn }, fs, { dirname, isAbsolute, join, relative, resolve }] = await Promise.all([
      import('node:child_process'),
      import('node:fs/promises'),
      import('node:path'),
    ]);
    const root = resolve(options.root);
    await fs.mkdir(root, { recursive: true });
    const inside = (file: string): string => {
      const resolved = resolve(root, file);
      const fromRoot = relative(root, resolved);
      if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new SandboxPathError(file);
      return resolved;
    };
    return { spawn, fs, dirname, join, relative, root, inside };
  })();
  // A root that cannot be created fails every call; it is never an unhandled rejection on its own.
  ready.catch(() => undefined);
  const maxOutput = options.maxOutputBytes ?? 1_048_576;

  // Workspace search walks the tree itself, breadth first and bounded, and never follows a link, so
  // it cannot leave the root.
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
    name: 'process (development only)',
    isolation: { filesystem: false, network: false, processes: false },
    async exec(command, execOptions = {}) {
      const { spawn, root, inside } = await ready;
      const started = Date.now();
      const cwd = inside(execOptions.cwd ?? '.');
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: root,
        ...options.env,
        ...execOptions.env,
      };
      return new Promise<SandboxExecResult>((resolve) => {
        const child = spawn(command, {
          cwd,
          env,
          shell: true,
          windowsHide: true,
          detached: process.platform !== 'win32',
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let settled = false;
        const keep = (current: string, chunk: Buffer) =>
          current.length >= maxOutput ? current : (current + chunk.toString('utf8')).slice(0, maxOutput);
        child.stdout?.on('data', (chunk: Buffer) => {
          stdout = keep(stdout, chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr = keep(stderr, chunk);
        });
        const stop = () => killTree(spawn, child.pid);
        const limit = execOptions.timeoutMs ?? options.timeoutMs ?? 30_000;
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, limit);
        const onAbort = () => stop();
        execOptions.signal?.addEventListener('abort', onAbort, { once: true });
        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          execOptions.signal?.removeEventListener('abort', onAbort);
          resolve({ exitCode: timedOut ? null : exitCode, stdout, stderr, timedOut, durationMs: Date.now() - started });
        };
        child.on('error', (error) => {
          stderr += error.message;
          finish(null);
        });
        child.on('close', (code) => finish(code));
        if (execOptions.stdin !== undefined) child.stdin?.end(execOptions.stdin);
        else child.stdin?.end();
      });
    },
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
      if (target === root) throw new SandboxPathError(file);
      await fs.rm(target, { recursive: true, force: true });
    },
    async glob(pattern, globOptions = {}) {
      const matches = globMatcher(pattern);
      return (await walk(globOptions.cwd ?? '.'))
        .filter((file) => matches(file.fromStart))
        .slice(0, globOptions.limit ?? 1_000)
        .map((file) => file.fromRoot);
    },
    async grep(pattern, grepOptions = {}) {
      const { fs } = await ready;
      const expression = new RegExp(pattern, grepOptions.ignoreCase ? 'i' : '');
      const only = grepOptions.glob ? globMatcher(grepOptions.glob) : undefined;
      const limit = grepOptions.limit ?? 200;
      const found: SandboxMatch[] = [];
      let scanned = 0;
      for (const file of await walk(grepOptions.cwd ?? '.')) {
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
      return fs.readFile(inside(file));
    },
  };
}

/** Stops a process and everything it started: the shell a command runs in starts the command itself. */
function killTree(spawn: typeof import('node:child_process').spawn, pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Already gone.
  }
}

/** Options for `sandboxTools()`. */
export interface SandboxToolsOptions {
  /** Offer `run_command`. Defaults to true. */
  shell?: boolean;
  /**
   * Offer the file tools: `read_file`, `write_file`, and, where the sandbox can, `list_files`,
   * `glob_files`, `grep_files`, and `read_media`. Defaults to true.
   */
  files?: boolean;
  /** The largest file `read_media` sends to the model, in bytes. Defaults to 10 MB. */
  maxMediaBytes?: number;
  /**
   * The path a permission policy sees the sandbox's files under. Defaults to `/workspace`, so a
   * policy granting `/workspace/**` grants the sandbox.
   */
  mount?: string;
  /** Timeout for each command. */
  timeoutMs?: number;
}

/**
 * Tools that act through a sandbox, each declaring exactly what one call does: `run_command`
 * declares `shell:<the command>`, and the file tools declare `filesystem:read` or
 * `filesystem:write` with the path under `mount`. A permission policy can therefore grant a
 * workspace, a few commands, and nothing else.
 */
export function sandboxTools(sandbox: Sandbox, options: SandboxToolsOptions = {}): ToolDefinition[] {
  const mount = (options.mount ?? '/workspace').replace(/\/+$/, '');
  // A model may name a file as `notes.txt` or as `/workspace/notes.txt`; both are the same file.
  const local = (file: unknown): string => {
    const unified = String(file ?? '.').replace(/\\/g, '/');
    const relative =
      unified === mount ? '.' : unified.startsWith(`${mount}/`) ? unified.slice(mount.length + 1) : unified;
    return relative.replace(/^\/+/, '') || '.';
  };
  const mounted = (file: unknown) => `${mount}/${local(file)}`;
  const tools: ToolDefinition[] = [];
  if (options.shell !== false) {
    tools.push({
      name: 'run_command',
      description: 'Runs a shell command in the sandbox and returns its exit code and output.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string', description: 'The command line to run' } },
        required: ['command'],
      },
      capabilities: (args) => [`shell:${String(args.command ?? '')}`],
      execute: async (args) => {
        const result = await sandbox.exec(String(args.command ?? ''), {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
      },
    });
  }
  if (options.files !== false) {
    tools.push(
      {
        name: 'read_file',
        description: `Reads a text file in the sandbox. Paths are relative to ${mount}.`,
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        capabilities: (args) => [`filesystem:read:${mounted(args.path)}`],
        execute: async (args) => sandbox.readFile(local(args.path)),
      },
      {
        name: 'write_file',
        description: `Writes a text file in the sandbox, creating its directory. Paths are relative to ${mount}.`,
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
        capabilities: (args) => [`filesystem:write:${mounted(args.path)}`],
        execute: async (args) => {
          await sandbox.writeFile(local(args.path), String(args.content ?? ''));
          return { written: local(args.path) };
        },
      },
    );
    if (sandbox.listFiles) {
      const list = sandbox.listFiles.bind(sandbox);
      tools.push({
        name: 'list_files',
        description: 'Lists the entries of a directory in the sandbox.',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
        capabilities: (args) => [`filesystem:read:${mounted(args.path)}`],
        execute: async (args) => list(local(args.path)),
      });
    }
    if (sandbox.glob) {
      const glob = sandbox.glob.bind(sandbox);
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
    if (sandbox.grep) {
      const grep = sandbox.grep.bind(sandbox);
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
    if (sandbox.readBytes) {
      const readBytes = sandbox.readBytes.bind(sandbox);
      const maxBytes = options.maxMediaBytes ?? 10 * 1_048_576;
      tools.push({
        name: 'read_media',
        description: `Shows you an image (PNG, JPEG, GIF, WebP), audio (WAV, MP3, FLAC, OGG, AAC), or a PDF in the sandbox as content you see or hear, not as text. Paths are relative to ${mount}.`,
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
  }
  return tools;
}

/** The most paths `glob_files` lists. */
const GLOB_LIMIT = 500;
/** The most lines `grep_files` lists. */
const GREP_LIMIT = 200;

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

/** One conformance check's result. */
export interface SandboxConformanceCheck {
  /** What was checked. */
  name: string;
  /** Whether it held. */
  ok: boolean;
  /** What went wrong, when it did not. */
  detail?: string;
}

/** What `runSandboxConformance()` found. */
export interface SandboxConformanceReport {
  /** The sandbox's name. */
  sandbox: string;
  /** True when every check held. */
  passed: boolean;
  /** Every check, in order. */
  checks: SandboxConformanceCheck[];
}

/** Options for `runSandboxConformance()`. */
export interface SandboxConformanceOptions {
  /** The command that runs JavaScript inside the sandbox. Defaults to `node`. */
  node?: string;
  /** The timeout the timeout check sets, in milliseconds. Defaults to 300. */
  timeoutMs?: number;
}

/**
 * Checks a sandbox against the contract, without a test framework, so any sandbox — a container
 * runner, a VM, a hosted service — can prove itself the same way:
 *
 * - commands report their output, errors, and exit code, take standard input and the variables
 *   given, and never see the host's environment;
 * - a command past its timeout is stopped and reported as timed out;
 * - commands run where the files are, and files round-trip;
 * - a path outside the sandbox is refused.
 *
 * Every check runs on a fresh sandbox from `create`, which is disposed afterwards.
 */
export async function runSandboxConformance(
  create: () => Sandbox | Promise<Sandbox>,
  options: SandboxConformanceOptions = {},
): Promise<SandboxConformanceReport> {
  const node = options.node ?? 'node';
  const js = (code: string) => `${node} -e "${code}"`;
  const checks: SandboxConformanceCheck[] = [];
  let name = 'sandbox';
  const check = async (label: string, run: (sandbox: Sandbox) => Promise<string | undefined>) => {
    const sandbox = await create();
    name = sandbox.name;
    try {
      const problem = await run(sandbox);
      checks.push(problem ? { name: label, ok: false, detail: problem } : { name: label, ok: true });
    } catch (error) {
      checks.push({ name: label, ok: false, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      await sandbox.dispose?.();
    }
  };
  const expect = (actual: unknown, expected: unknown, what: string) =>
    actual === expected ? undefined : `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;

  await check('a command reports its output and a zero exit code', async (sandbox) => {
    const result = await sandbox.exec(js("process.stdout.write('ok')"));
    return expect(result.stdout, 'ok', 'stdout') ?? expect(result.exitCode, 0, 'exit code');
  });
  await check('a failing command reports its exit code and its errors', async (sandbox) => {
    const result = await sandbox.exec(js("process.stderr.write('bad'); process.exit(3)"));
    return expect(result.exitCode, 3, 'exit code') ?? expect(result.stderr, 'bad', 'stderr');
  });
  await check('a command reads its standard input', async (sandbox) => {
    const result = await sandbox.exec(js('process.stdin.pipe(process.stdout)'), { stdin: 'piped' });
    return expect(result.stdout, 'piped', 'stdout');
  });
  await check('a command gets the variables it is given, and none of the host', async (sandbox) => {
    process.env.NEXUS_SANDBOX_HOST_SECRET = 'host-only';
    try {
      const result = await sandbox.exec(
        js(
          "process.stdout.write((process.env.NEXUS_SANDBOX_GIVEN || '') + '|' + (process.env.NEXUS_SANDBOX_HOST_SECRET || ''))",
        ),
        { env: { NEXUS_SANDBOX_GIVEN: 'given' } },
      );
      return expect(result.stdout, 'given|', 'environment');
    } finally {
      delete process.env.NEXUS_SANDBOX_HOST_SECRET;
    }
  });
  await check('a command past its timeout is stopped', async (sandbox) => {
    const limit = options.timeoutMs ?? 300;
    const result = await sandbox.exec(js('setTimeout(() => {}, 20000)'), { timeoutMs: limit });
    if (!result.timedOut) return 'the command was not reported as timed out';
    if (result.durationMs > limit + 5_000) return `the command ran ${result.durationMs} ms past a ${limit} ms timeout`;
    return undefined;
  });
  await check('files round-trip, and commands run where they are', async (sandbox) => {
    await sandbox.writeFile('conformance/note.txt', 'here');
    const read = await sandbox.readFile('conformance/note.txt');
    const seen = await sandbox.exec(
      js("process.stdout.write(require('fs').readFileSync('conformance/note.txt', 'utf8'))"),
    );
    const listed = sandbox.listFiles ? await sandbox.listFiles('conformance') : ['note.txt'];
    return (
      expect(read, 'here', 'readFile') ??
      expect(seen.stdout, 'here', 'a command reading the file') ??
      (listed.includes('note.txt') ? undefined : `listFiles did not list note.txt: ${JSON.stringify(listed)}`)
    );
  });
  await check('a path outside the sandbox is refused', async (sandbox) => {
    for (const attempt of ['../outside.txt', 'conformance/../../outside.txt']) {
      const refused = await sandbox.writeFile(attempt, 'escaped').then(
        () => false,
        () => true,
      );
      if (!refused) return `writeFile("${attempt}") was allowed`;
    }
    return undefined;
  });

  return { sandbox: name, passed: checks.every((item) => item.ok), checks };
}
