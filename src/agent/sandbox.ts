/**
 * The sandbox contract: where an agent's commands and code run. A sandbox is a `Workspace` that can
 * also run commands, and says how it is isolated, so its files are the files its commands see.
 *
 * The package ships the contract and a conformance suite, not the isolation: a container, a VM, a
 * remote interpreter, or a hosted sandbox fills the `Sandbox` interface. `processSandbox()` is a
 * reference for development, which runs commands as ordinary processes; it says so in its
 * `isolation`, and is never a security boundary.
 */
import type { ToolDefinition } from '../types/messages.js';
import { directoryFiles } from './files.js';
import {
  type Workspace,
  type WorkspaceGlobOptions,
  type WorkspaceGrepOptions,
  type WorkspaceMatch,
  WorkspacePathError,
  workspaceTools,
} from './workspace.js';

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

/** Options for `Sandbox.glob()`: a workspace's. */
export type SandboxGlobOptions = WorkspaceGlobOptions;

/** Options for `Sandbox.grep()`: a workspace's. */
export type SandboxGrepOptions = WorkspaceGrepOptions;

/** One line `Sandbox.grep()` matched: a workspace's match. */
export type SandboxMatch = WorkspaceMatch;

/** What a sandbox claims to isolate. The conformance suite checks the claims it can observe. */
export interface SandboxIsolation {
  /** Commands cannot read or write the host's files. */
  filesystem: boolean;
  /** Commands cannot reach the network, or only what the sandbox allows. */
  network: boolean;
  /** Commands cannot see or signal the host's processes. */
  processes: boolean;
}

/**
 * Where an agent's commands and code run: a workspace that can also run commands, and says what it
 * isolates. The application provides one.
 */
export interface Sandbox extends Workspace {
  /** What it isolates. */
  readonly isolation: SandboxIsolation;
  /** Runs a command line in the sandbox, where its files are. */
  exec(command: string, options?: SandboxExecOptions): Promise<SandboxExecResult>;
  /** Releases the sandbox. */
  dispose?(): Promise<void>;
}

/** Raised when a path would leave the sandbox: a `WorkspacePathError` whose code is `SANDBOX_PATH`. */
export class SandboxPathError extends WorkspacePathError {
  /** Always `SANDBOX_PATH`. */
  override readonly code = 'SANDBOX_PATH';

  constructor(
    /** The path that was refused. */
    path: string,
  ) {
    super(path, `"${path}" is outside the sandbox`);
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
  const files = directoryFiles(options.root, (path) => new SandboxPathError(path));
  const ready = (async () => {
    const [{ spawn }, handle] = await Promise.all([import('node:child_process'), files.ready]);
    return { spawn, root: handle.root, inside: handle.inside };
  })();
  ready.catch(() => undefined);
  const maxOutput = options.maxOutputBytes ?? 1_048_576;

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
    readFile: files.readFile,
    writeFile: files.writeFile,
    listFiles: files.listFiles,
    removeFile: files.removeFile,
    glob: files.glob,
    grep: files.grep,
    readBytes: files.readBytes,
    writeBytes: files.writeBytes,
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
      ...workspaceTools(sandbox, {
        mount,
        ...(options.maxMediaBytes === undefined ? {} : { maxMediaBytes: options.maxMediaBytes }),
      }),
    );
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
