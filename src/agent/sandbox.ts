/**
 * The sandbox contract: where an agent's commands and code run, and where its files live.
 *
 * The package ships the contract and a conformance suite, not the isolation: a container, a VM, a
 * remote interpreter, or a hosted sandbox fills the `Sandbox` interface. `processSandbox()` is a
 * reference for development, which runs commands as ordinary processes; it says so in its
 * `isolation`, and is never a security boundary.
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition } from '../types/messages.js';

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
 */
export function processSandbox(options: ProcessSandboxOptions): Sandbox {
  const root = path.resolve(options.root);
  const inside = (file: string): string => {
    const resolved = path.resolve(root, file);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new SandboxPathError(file);
    return resolved;
  };
  const ready = mkdir(root, { recursive: true });
  const maxOutput = options.maxOutputBytes ?? 1_048_576;

  return {
    name: 'process (development only)',
    isolation: { filesystem: false, network: false, processes: false },
    async exec(command, execOptions = {}) {
      await ready;
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
        const stop = () => killTree(child.pid);
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
      await ready;
      return readFile(inside(file), 'utf8');
    },
    async writeFile(file, content) {
      await ready;
      const target = inside(file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    },
    async listFiles(directory = '.') {
      await ready;
      return (await readdir(inside(directory))).sort();
    },
    async removeFile(file) {
      await ready;
      const target = inside(file);
      if (target === root) throw new SandboxPathError(file);
      await rm(target, { recursive: true, force: true });
    },
  };
}

/** Stops a process and everything it started: the shell a command runs in starts the command itself. */
function killTree(pid: number | undefined): void {
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
  /** Offer `read_file`, `write_file`, and `list_files`. Defaults to true. */
  files?: boolean;
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
  }
  return tools;
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
