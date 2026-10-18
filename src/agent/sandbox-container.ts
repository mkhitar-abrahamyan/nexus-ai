/**
 * A container sandbox for production: an agent's commands, code, and files in a container that the
 * `docker` or `podman` binary runs, driven as the git loader drives `git`, with no dependency.
 *
 * Each sandbox is one container, started on first use and removed by `dispose()`. By default it has
 * no network, drops every capability, cannot gain privileges, and runs under memory, CPU, and process
 * limits. Its files live only inside the container: nothing of the host is mounted. It is held to
 * the same conformance suite as any sandbox, `runSandboxConformance()`.
 */
import { GREP_FILE_BYTES, GREP_TOTAL_BYTES, globMatcher, matchingLines, WALK_LIMIT } from './glob.js';
import {
  type Sandbox,
  type SandboxExecResult,
  type SandboxGlobOptions,
  type SandboxGrepOptions,
  type SandboxMatch,
  SandboxPathError,
} from './sandbox.js';

/** Options for `containerSandbox()`. */
export interface ContainerSandboxOptions {
  /**
   * The image, such as `node:22-alpine`. It needs a POSIX shell, `cat`, `find`, `tar`, and the
   * commands the agent is to run.
   */
  image: string;
  /** The binary that runs containers: `docker`, `podman`, or a path to either. Defaults to `docker`. */
  binary?: string;
  /** Where the files live inside the container, and where commands run. Defaults to `/workspace`. */
  workdir?: string;
  /**
   * The network. `false`, the default, gives the container none at all; `true` gives it the
   * runtime's default network; a string names a network to join.
   */
  network?: boolean | string;
  /** The memory limit, as the runtime takes it. Swap is held to the same limit. Defaults to `512m`. */
  memory?: string;
  /** How many CPUs it may use. Defaults to 1. */
  cpus?: number;
  /** The most processes it may run at once. Defaults to 256. */
  pids?: number;
  /** Environment variables every command gets, on top of the image's own. */
  env?: Record<string, string>;
  /** The timeout for a command that sets none. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Output kept per stream, in bytes. Defaults to 1 MB. */
  maxOutputBytes?: number;
  /**
   * More arguments for `run`, before the image, for what these options do not cover, such as
   * `--user` with a volume that user can write.
   */
  runArgs?: readonly string[];
}

/** What one call of the binary did. */
interface Invocation {
  code: number | null;
  stdout: Uint8Array;
  stderr: string;
  timedOut: boolean;
}

/** How one call of the binary runs. */
interface InvokeOptions {
  stdin?: string;
  /** Standard output kept, in bytes; the rest is dropped. */
  keep?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Runs when the call is stopped by its timeout or its signal. */
  onStop?: () => void;
}

/**
 * A sandbox in a container, for production. Every command runs through `exec` in one container per
 * sandbox, and a command past its timeout is killed inside the container with everything it
 * started. `isolation` reports the network as isolated only when the container has none.
 *
 * ```ts
 * const sandbox = containerSandbox({ image: 'node:22-alpine' });
 * const agent = createDeepAgent({ client: ai, sandbox, commands: ['node', 'npm test'] });
 * // …
 * await sandbox.dispose?.();
 * ```
 */
export function containerSandbox(options: ContainerSandboxOptions): Sandbox {
  const binary = options.binary ?? 'docker';
  const workdir = `/${(options.workdir ?? '/workspace').replace(/^\/+|\/+$/g, '')}`;
  const maxOutput = options.maxOutputBytes ?? 1_048_576;
  const network = options.network ?? false;
  const label = `nexus-sandbox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let marks = 0;

  // A path inside the workspace, as an absolute path in the container. A path that would leave the
  // workspace is refused before any command runs.
  const inside = (file: string): string => {
    const unified = file.replace(/\\/g, '/');
    if (unified.includes('\0')) throw new SandboxPathError(file);
    const parts: string[] = [];
    // An absolute path under the workdir is taken as it is; any other leading slash names the
    // workdir, as it does in every workspace.
    const rooted = unified === workdir || unified.startsWith(`${workdir}/`);
    for (const segment of (rooted ? unified : `${workdir}/${unified.replace(/^\/+/, '')}`).split('/')) {
      if (segment === '' || segment === '.') continue;
      if (segment !== '..') parts.push(segment);
      else if (parts.pop() === undefined) throw new SandboxPathError(file);
    }
    const resolved = `/${parts.join('/')}`;
    if (resolved !== workdir && !resolved.startsWith(`${workdir}/`)) throw new SandboxPathError(file);
    return resolved;
  };
  const fromRoot = (path: string) => (path === workdir ? '.' : path.slice(workdir.length + 1));

  const invoke = async (args: readonly string[], call: InvokeOptions = {}): Promise<Invocation> => {
    const { spawn } = await import('node:child_process');
    return new Promise<Invocation>((resolve) => {
      const child = spawn(binary, args, { windowsHide: true });
      const out: Uint8Array[] = [];
      let kept = 0;
      let stderr = '';
      let timedOut = false;
      let settled = false;
      child.stdout.on('data', (chunk: Uint8Array) => {
        const room = (call.keep ?? Number.POSITIVE_INFINITY) - kept;
        if (room <= 0) return;
        const part = chunk.byteLength > room ? chunk.subarray(0, room) : chunk;
        out.push(part);
        kept += part.byteLength;
      });
      child.stderr.on('data', (chunk: Uint8Array) => {
        if (stderr.length < maxOutput) stderr = (stderr + new TextDecoder().decode(chunk)).slice(0, maxOutput);
      });
      const stop = () => {
        call.onStop?.();
        child.kill('SIGKILL');
      };
      const timer =
        call.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              stop();
            }, call.timeoutMs);
      call.signal?.addEventListener('abort', stop, { once: true });
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        call.signal?.removeEventListener('abort', stop);
        resolve({ code: timedOut ? null : code, stdout: concat(out), stderr, timedOut });
      };
      child.on('error', (error) => {
        stderr += error.message;
        finish(null);
      });
      child.on('close', (code) => finish(code));
      child.stdin.on('error', () => undefined);
      child.stdin.end(call.stdin ?? '');
    });
  };

  const failed = (what: string, result: Invocation) =>
    new Error(`${what} failed in the container: ${result.stderr.trim() || `exit code ${result.code}`}`);

  // The container starts on first use, and a start that fails is tried again by the next call.
  // `--init` reaps what commands leave behind; `tail` keeps the container up.
  let started: Promise<string> | undefined;
  const container = (): Promise<string> => {
    if (started) return started;
    const starting = (async () => {
      const result = await invoke([
        'run',
        '--detach',
        '--rm',
        '--init',
        '--name',
        label,
        '--label',
        'nexus-ai-pro.sandbox=1',
        '--workdir',
        workdir,
        ...(network === true ? [] : ['--network', network === false ? 'none' : network]),
        '--memory',
        options.memory ?? '512m',
        '--memory-swap',
        options.memory ?? '512m',
        '--cpus',
        String(options.cpus ?? 1),
        '--pids-limit',
        String(options.pids ?? 256),
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        ...envArgs(options.env),
        ...(options.runArgs ?? []),
        '--entrypoint',
        'tail',
        options.image,
        '-f',
        '/dev/null',
      ]);
      if (result.code !== 0) throw failed(`Starting ${options.image}`, result);
      return new TextDecoder().decode(result.stdout).trim();
    })();
    started = starting;
    starting.catch(() => {
      if (started === starting) started = undefined;
    });
    return starting;
  };

  const shell = async (script: string, args: readonly string[], stdin?: string, keep?: number) => {
    const id = await container();
    return invoke(['exec', ...(stdin === undefined ? [] : ['--interactive']), id, 'sh', '-c', script, 'sh', ...args], {
      ...(stdin === undefined ? {} : { stdin }),
      ...(keep === undefined ? {} : { keep }),
    });
  };

  // Every file under a directory, never entering .git or node_modules and never following a link.
  const walk = async (directory: string, filter = '') => {
    const start = inside(directory);
    const result = await shell(
      `find "$1" \\( -name .git -o -name node_modules \\) -prune -o -type f ${filter} -print`,
      [start],
    );
    if (result.code !== 0 && result.stdout.byteLength === 0) throw failed('Listing files', result);
    return new TextDecoder()
      .decode(result.stdout)
      .split('\n')
      .filter(Boolean)
      .slice(0, WALK_LIMIT)
      .map((path) => ({ fromRoot: fromRoot(path), fromStart: path.slice(start.length).replace(/^\//, '') }))
      .sort((a, b) => (a.fromRoot < b.fromRoot ? -1 : a.fromRoot > b.fromRoot ? 1 : 0));
  };

  const readBytes = async (file: string): Promise<Uint8Array> => {
    const result = await shell('cat "$1"', [inside(file)]);
    if (result.code !== 0) throw failed(`Reading ${file}`, result);
    return result.stdout;
  };

  return {
    name: `container (${binary} ${options.image})`,
    isolation: { filesystem: true, network: network === false, processes: true },
    async exec(command, execOptions = {}) {
      const id = await container();
      const startedAt = Date.now();
      // Every process the command starts inherits this mark, so a timeout can find and kill them all.
      const mark = `${label}-${++marks}`;
      const result = await invoke(
        [
          'exec',
          '--interactive',
          '--workdir',
          inside(execOptions.cwd ?? '.'),
          ...envArgs({ ...options.env, ...execOptions.env, NEXUS_SANDBOX_EXEC: mark }),
          id,
          'sh',
          '-c',
          command,
        ],
        {
          stdin: execOptions.stdin ?? '',
          keep: maxOutput,
          timeoutMs: execOptions.timeoutMs ?? options.timeoutMs ?? 30_000,
          ...(execOptions.signal ? { signal: execOptions.signal } : {}),
          onStop: () => {
            void invoke(['exec', id, 'sh', '-c', KILL_MARKED, 'sh', mark]);
          },
        },
      );
      return {
        exitCode: result.code,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: result.stderr,
        timedOut: result.timedOut,
        durationMs: Date.now() - startedAt,
      } satisfies SandboxExecResult;
    },
    async readFile(file) {
      return new TextDecoder().decode(await readBytes(file));
    },
    readBytes,
    async writeFile(file, content) {
      const result = await shell('mkdir -p "$(dirname "$1")" && cat > "$1"', [inside(file)], content);
      if (result.code !== 0) throw failed(`Writing ${file}`, result);
    },
    async listFiles(directory = '.') {
      const result = await shell('ls -1A "$1"', [inside(directory)]);
      if (result.code !== 0) throw failed(`Listing ${directory}`, result);
      return new TextDecoder().decode(result.stdout).split('\n').filter(Boolean).sort();
    },
    async removeFile(file) {
      const target = inside(file);
      if (target === workdir) throw new SandboxPathError(file);
      const result = await shell('rm -rf "$1"', [target]);
      if (result.code !== 0) throw failed(`Removing ${file}`, result);
    },
    async glob(pattern, globOptions: SandboxGlobOptions = {}) {
      const matches = globMatcher(pattern);
      return (await walk(globOptions.cwd ?? '.'))
        .filter((file) => matches(file.fromStart))
        .slice(0, globOptions.limit ?? 1_000)
        .map((file) => file.fromRoot);
    },
    async grep(pattern, grepOptions: SandboxGrepOptions = {}) {
      const expression = new RegExp(pattern, grepOptions.ignoreCase ? 'i' : '');
      const only = grepOptions.glob ? globMatcher(grepOptions.glob) : undefined;
      const limit = grepOptions.limit ?? 200;
      // Large files stay in the container; the rest come out in batches, one tar stream each, and the
      // lines are matched here, exactly as every other sandbox matches them.
      const candidates = (await walk(grepOptions.cwd ?? '.', `-size -${GREP_FILE_BYTES / 1024 + 1}k`)).filter(
        (file) => !only || only(file.fromStart),
      );
      const found: SandboxMatch[] = [];
      let read = 0;
      for (let index = 0; index < candidates.length && found.length < limit && read < GREP_TOTAL_BYTES; index += 200) {
        const batch = candidates.slice(index, index + 200).map((file) => `./${file.fromRoot}`);
        const result = await shell(
          'cd "$1" && shift && tar -cf - "$@"',
          [workdir, ...batch],
          undefined,
          GREP_TOTAL_BYTES - read,
        );
        for (const entry of untar(result.stdout)) {
          read += entry.data.byteLength;
          const file = entry.name.replace(/^\.\//, '');
          found.push(
            ...matchingLines(entry.data, expression, limit - found.length).map((match) => ({ file, ...match })),
          );
          if (found.length >= limit) break;
        }
      }
      return found;
    },
    async dispose() {
      const current = started;
      started = undefined;
      const id = await current?.catch(() => undefined);
      if (id) await invoke(['rm', '--force', id]);
    },
  };
}

/** Kills every process whose environment carries a command's mark: the command and all it started. */
const KILL_MARKED =
  'for p in /proc/[0-9]*; do if tr "\\000" "\\n" < "$p/environ" 2>/dev/null | grep -qx "NEXUS_SANDBOX_EXEC=$1"; then kill -9 "$(basename "$p")" 2>/dev/null; fi; done; true';

function envArgs(env: Record<string, string> | undefined): string[] {
  return Object.entries(env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The regular files of a tar stream: ustar names with their prefix, GNU long names, and pax paths,
 * which together cover what GNU, BSD, and BusyBox `tar` write. A stream cut short ends at the last
 * whole header.
 */
function untar(tar: Uint8Array): Array<{ name: string; data: Uint8Array }> {
  const decoder = new TextDecoder();
  const field = (from: number, length: number) => {
    const bytes = tar.subarray(from, from + length);
    const end = bytes.indexOf(0);
    return decoder.decode(end < 0 ? bytes : bytes.subarray(0, end));
  };
  const files: Array<{ name: string; data: Uint8Array }> = [];
  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= tar.byteLength) {
    if (tar.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(offset + 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(tar[offset + 156] ?? 0);
    const prefix = field(offset + 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(offset, 100)}` : field(offset, 100));
    const data = tar.subarray(offset + 512, offset + 512 + size);
    longName = undefined;
    if (type === 'L') {
      longName = decoder.decode(data).replace(/\0+$/, '');
    } else if (type === 'x') {
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(decoder.decode(data))?.[1];
    } else if (type === '0' || type === '\0') {
      files.push({ name, data });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
