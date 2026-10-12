/**
 * The interpreter contract: a model writes a snippet of code that calls the agent's tools, and the
 * snippet runs in one step, instead of one model round trip per call. A loop over fifty records, a
 * filter on a large result, or three calls at once become one tool call.
 *
 * The package ships the contract, a reference that runs code in a worker thread with time and memory
 * limits, a tool that puts an interpreter in front of a model, and a conformance suite. Like the
 * reference sandbox, the reference interpreter is not a security boundary: code in a worker can do
 * anything the process can. Run untrusted code in an interpreter behind a container or a VM.
 */
import type { ToolContext, ToolDefinition } from '../types/messages.js';
import { capabilitiesOf } from './capabilities.js';
import type { PermissionPolicyLike } from './permissions.js';
import { isToolOutput, ToolExecutor } from './tool.js';

/** A function the code calls as `await tools.<name>(args)`. It runs outside the interpreter. */
export type InterpreterFunction = (args: Record<string, unknown>) => Promise<unknown>;

/** Options for one run. */
export interface InterpreterRunOptions {
  /** The functions the code may call, by name. */
  tools?: Readonly<Record<string, InterpreterFunction>>;
  /** Stops the code after this many milliseconds. */
  timeoutMs?: number;
  /** Stops the code when aborted. */
  signal?: AbortSignal;
}

/** One call the code made. */
export interface InterpreterCall {
  /** The function's name. */
  name: string;
  /** Its arguments. */
  args: unknown;
  /** Whether it succeeded. */
  ok: boolean;
}

/** What a run did. */
export interface InterpreterResult {
  /** True when the code returned; false when it threw, was stopped, or ran out of memory. */
  ok: boolean;
  /** What the code returned, when it returned. */
  value?: unknown;
  /** What it threw, or why it was stopped. */
  error?: string;
  /** What it logged with `console`, one entry per call, cut to the interpreter's limit. */
  logs: string[];
  /** The calls it made, in the order it made them. */
  calls: InterpreterCall[];
  /** True when it was stopped by its timeout. */
  timedOut: boolean;
  /** How long it ran, in milliseconds. */
  durationMs: number;
}

/** Runs code. The application provides one, or uses `workerInterpreter()`. */
export interface Interpreter {
  /** Names the interpreter in reports. */
  readonly name: string;
  /** The language its code is written in, for the model, such as `JavaScript`. */
  readonly language: string;
  /**
   * Runs code: the body of an async function, which can `await tools.<name>(args)` and `return` a
   * value. A run never throws; what went wrong is in the result.
   */
  run(code: string, options?: InterpreterRunOptions): Promise<InterpreterResult>;
  /** Releases the interpreter. */
  dispose?(): Promise<void>;
}

/** Options for `workerInterpreter()`. */
export interface WorkerInterpreterOptions {
  /** The timeout for a run that sets none. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** The heap one run may use, in megabytes. Defaults to 64. */
  memoryMb?: number;
  /** What one run may log, in characters. Defaults to 64,000. */
  maxLogChars?: number;
  /** The most calls one run may make. Defaults to 100. */
  maxCalls?: number;
}

/**
 * A reference interpreter, for JavaScript: each run gets a fresh worker thread with a heap limit,
 * stopped at its timeout, so an endless loop or a runaway allocation ends the run, not the process.
 * Calls to `tools` cross back to the host and run there. It is not a security boundary: the code runs
 * with the process's own access.
 */
export function workerInterpreter(options: WorkerInterpreterOptions = {}): Interpreter {
  const maxLog = options.maxLogChars ?? 64_000;
  const maxCalls = options.maxCalls ?? 100;
  return {
    name: 'worker (not a security boundary)',
    language: 'JavaScript',
    async run(code, runOptions = {}) {
      const { Worker } = await import('node:worker_threads');
      const started = Date.now();
      const tools = runOptions.tools ?? {};
      const logs: string[] = [];
      const calls: InterpreterCall[] = [];
      let logged = 0;
      return new Promise<InterpreterResult>((resolve) => {
        const memory = options.memoryMb ?? 64;
        const worker = new Worker(WORKER_SOURCE, {
          eval: true,
          workerData: { code },
          resourceLimits: {
            maxOldGenerationSizeMb: memory,
            maxYoungGenerationSizeMb: Math.max(4, Math.ceil(memory / 8)),
          },
          stdout: true,
          stderr: true,
        });
        let settled = false;
        const finish = (result: Omit<InterpreterResult, 'logs' | 'calls' | 'durationMs'>) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          runOptions.signal?.removeEventListener('abort', onAbort);
          void worker.terminate();
          resolve({ ...result, logs, calls, durationMs: Date.now() - started });
        };
        const limit = runOptions.timeoutMs ?? options.timeoutMs ?? 10_000;
        const timer = setTimeout(
          () => finish({ ok: false, error: `The code ran past its ${limit} ms timeout`, timedOut: true }),
          limit,
        );
        const onAbort = () => finish({ ok: false, error: 'The run was aborted', timedOut: false });
        if (runOptions.signal?.aborted) onAbort();
        runOptions.signal?.addEventListener('abort', onAbort, { once: true });

        worker.on('message', (message: WorkerMessage) => {
          if (message.type === 'log') {
            if (logged >= maxLog) return;
            const line = message.line.slice(0, maxLog - logged);
            logged += line.length;
            logs.push(line);
          } else if (message.type === 'call') {
            void answer(message);
          } else if (message.type === 'done') {
            finish(
              message.ok
                ? { ok: true, value: message.value, timedOut: false }
                : { ok: false, error: message.error, timedOut: false },
            );
          }
        });
        worker.on('error', (error: Error & { code?: string }) => {
          const outOfMemory = error.code === 'ERR_WORKER_OUT_OF_MEMORY';
          finish({
            ok: false,
            error: outOfMemory ? `The code ran out of memory, past ${memory} MB` : error.message,
            timedOut: false,
          });
        });
        // The host ends the worker once it has the result; a worker that exits first was stopped.
        worker.on('exit', () => finish({ ok: false, error: 'The interpreter stopped', timedOut: false }));

        const answer = async (message: Extract<WorkerMessage, { type: 'call' }>) => {
          const reply = (body: { ok: true; value: unknown } | { ok: false; error: string }) => {
            if (settled) return;
            try {
              worker.postMessage({ type: 'result', id: message.id, ...body });
            } catch {
              // A value the worker cannot receive as it is goes as JSON.
              worker.postMessage({ type: 'result', id: message.id, ...body, value: toJson(body) });
            }
          };
          const fn = Object.hasOwn(tools, message.name) ? tools[message.name] : undefined;
          if (calls.length >= maxCalls) {
            calls.push({ name: message.name, args: message.args, ok: false });
            reply({ ok: false, error: `The code made more than ${maxCalls} calls` });
            return;
          }
          const call: InterpreterCall = { name: message.name, args: message.args, ok: false };
          calls.push(call);
          if (!fn) {
            reply({ ok: false, error: `There is no tool named ${message.name}; the tools are ${namesOf(tools)}` });
            return;
          }
          try {
            const value = await fn((message.args ?? {}) as Record<string, unknown>);
            call.ok = true;
            reply({ ok: true, value });
          } catch (error) {
            reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        };
      });
    },
  };
}

type WorkerMessage =
  | { type: 'log'; line: string }
  | { type: 'call'; id: number; name: string; args: unknown }
  | { type: 'done'; ok: true; value: unknown }
  | { type: 'done'; ok: false; error: string };

const namesOf = (tools: Readonly<Record<string, unknown>>) => Object.keys(tools).join(', ') || 'none';

function toJson(body: { ok: boolean; value?: unknown }): unknown {
  try {
    return JSON.parse(JSON.stringify(body.value ?? null));
  } catch {
    return String(body.value);
  }
}

/**
 * The worker's own code. The snippet becomes the body of an async function that gets `tools`, whose
 * every property is a function that asks the host to run a call, and a `console` that reports to it.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const pending = new Map();
let next = 0;
const show = (value) => {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};
const say = (...values) => parentPort.postMessage({ type: 'log', line: values.map(show).join(' ') });
const console = { log: say, info: say, warn: say, error: say, debug: say };
const tools = new Proxy({}, {
  get(_target, name) {
    if (typeof name !== 'string' || name === 'then') return undefined;
    return (args = {}) => new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      parentPort.postMessage({ type: 'call', id, name, args });
    });
  },
});
parentPort.on('message', (message) => {
  if (message.type !== 'result') return;
  const waiting = pending.get(message.id);
  pending.delete(message.id);
  if (!waiting) return;
  if (message.ok) waiting.resolve(message.value);
  else waiting.reject(new Error(message.error));
});
const AsyncFunction = (async () => {}).constructor;
(async () => {
  try {
    const value = await new AsyncFunction('tools', 'console', workerData.code)(tools, console);
    try {
      parentPort.postMessage({ type: 'done', ok: true, value });
    } catch {
      parentPort.postMessage({ type: 'done', ok: true, value: show(value) });
    }
  } catch (error) {
    parentPort.postMessage({ type: 'done', ok: false, error: error instanceof Error ? error.message : String(error) });
  }
})();
`;

/** Options for `codeTool()`. */
export interface CodeToolOptions {
  /** The tools the code may call. A tool the agent should not call from code stays out of this list. */
  tools: readonly ToolDefinition[];
  /**
   * Decides each call the code makes, as an agent's policy decides a model's. A call it would ask a
   * person about is refused instead, since code cannot pause for one; the model can make that call
   * directly. Without one, every call runs.
   */
  permissions?: PermissionPolicyLike;
  /** The tool's name. Defaults to `run_code`. */
  name?: string;
  /** The timeout for one run. Defaults to the interpreter's. */
  timeoutMs?: number;
}

/**
 * A tool that runs a model's code in an interpreter, with `tools` callable from it, and returns what
 * the code returned and logged, and the calls it made. It declares `code`, so a permission policy must
 * grant code before it runs at all; each call the code makes is then decided on its own.
 */
export function codeTool(interpreter: Interpreter, options: CodeToolOptions): ToolDefinition {
  const executor = new ToolExecutor([...options.tools]);
  const listed = options.tools
    .map((tool) => `- ${tool.name}(${JSON.stringify(tool.parameters)}): ${tool.description}`)
    .join('\n');
  return {
    name: options.name ?? 'run_code',
    description: `Runs ${interpreter.language} code in one step: the body of an async function. Call the tools below with \`await tools.<name>(args)\`, \`return\` the value you need, and use console.log for notes. Use it to call tools many times, at once, or to filter what they return before you read it.\nTools:\n${listed || '- none'}`,
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: `The ${interpreter.language} to run` } },
      required: ['code'],
    },
    capabilities: ['code'],
    execute: async (args, context?: ToolContext) => {
      const tools: Record<string, InterpreterFunction> = {};
      for (const definition of options.tools) {
        tools[definition.name] = async (callArgs) => {
          if (options.permissions) {
            const verdict = await options.permissions.decide({
              tool: definition.name,
              args: callArgs,
              capabilities: capabilitiesOf(definition, callArgs),
              ...(context?.principal ? { principal: context.principal } : {}),
            });
            if (verdict.decision === 'deny') throw new Error(`Permission denied: ${verdict.reason}`);
            if (verdict.decision === 'ask') {
              throw new Error(`${definition.name} needs a person's approval, so call it directly: ${verdict.reason}`);
            }
          }
          const result = await executor.execute(definition.name, callArgs, context);
          if (!result.ok) throw new Error(result.error);
          // Content parts are for the model; the code gets their text.
          return isToolOutput(result.result)
            ? result.result.content.map((part) => (part.type === 'text' ? part.text : `[${part.type}]`)).join('\n')
            : result.result;
        };
      }
      const outcome = await interpreter.run(String(args.code ?? ''), {
        tools,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(context?.signal ? { signal: context.signal } : {}),
      });
      return {
        ok: outcome.ok,
        ...(outcome.ok ? { value: outcome.value ?? null } : { error: outcome.error }),
        ...(outcome.logs.length ? { logs: outcome.logs } : {}),
        calls: outcome.calls.map((call) => `${call.name}${call.ok ? '' : ' (failed)'}`),
      };
    },
  };
}

/** What `runInterpreterConformance()` found. */
export interface InterpreterConformanceReport {
  /** The interpreter's name. */
  interpreter: string;
  /** True when every check held. */
  passed: boolean;
  /** Every check, in order. */
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

/**
 * Checks a JavaScript interpreter against the contract, without a test framework:
 *
 * - code returns a value, logs, and calls tools, in order and at once;
 * - a tool's failure reaches the code as a rejection it can catch, and an unknown tool fails;
 * - code that throws is reported, and never throws out of `run()`;
 * - an endless loop is stopped at the timeout, and the interpreter runs again afterwards;
 * - a runaway allocation is stopped, and the interpreter runs again afterwards.
 */
export async function runInterpreterConformance(interpreter: Interpreter): Promise<InterpreterConformanceReport> {
  const checks: InterpreterConformanceReport['checks'] = [];
  const check = async (name: string, run: () => Promise<string | undefined>) => {
    try {
      const problem = await run();
      checks.push(problem ? { name, ok: false, detail: problem } : { name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };
  const same = (actual: unknown, expected: unknown, what: string) =>
    JSON.stringify(actual) === JSON.stringify(expected)
      ? undefined
      : `${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
  const double: InterpreterFunction = async (args) => Number(args.n) * 2;

  await check('code returns a value, logs, and calls tools in order and at once', async () => {
    const result = await interpreter.run(
      `const one = await tools.double({ n: 1 });
       const many = await Promise.all([2, 3].map((n) => tools.double({ n })));
       console.log('doubled', one, many);
       return { one, many };`,
      { tools: { double } },
    );
    return (
      same(result.ok, true, `ok (${result.error})`) ??
      same(result.value, { one: 2, many: [4, 6] }, 'value') ??
      same(result.logs, ['doubled 2 [4,6]'], 'logs') ??
      same(
        result.calls.map((call) => call.name),
        ['double', 'double', 'double'],
        'calls',
      )
    );
  });
  await check('a failing tool rejects in the code, and an unknown tool fails', async () => {
    const fail: InterpreterFunction = async () => {
      throw new Error('no such order');
    };
    const result = await interpreter.run(
      `let caught = '';
       try { await tools.lookup({ id: 1 }); } catch (error) { caught = error.message; }
       let unknown = '';
       try { await tools.missing({}); } catch (error) { unknown = error.message; }
       return { caught, unknown: unknown.length > 0 };`,
      { tools: { lookup: fail } },
    );
    return same(result.value, { caught: 'no such order', unknown: true }, 'value');
  });
  await check('code that throws is reported', async () => {
    const result = await interpreter.run(`throw new Error('broken on purpose');`);
    return (
      same(result.ok, false, 'ok') ??
      (result.error?.includes('broken on purpose') ? undefined : `error: ${result.error}`)
    );
  });
  await check('an endless loop is stopped at the timeout', async () => {
    const result = await interpreter.run('while (true) {}', { timeoutMs: 300 });
    if (!result.timedOut || result.ok) return `the loop was not reported as timed out: ${JSON.stringify(result)}`;
    const after = await interpreter.run('return 1 + 1;');
    return same(after.value, 2, 'a run after the timeout');
  });
  await check('a runaway allocation is stopped', async () => {
    const result = await interpreter.run('const kept = []; for (;;) kept.push(new Array(1e6).fill(Math.random()));', {
      timeoutMs: 30_000,
    });
    if (result.ok) return 'the allocation finished';
    if (result.timedOut) return 'the allocation ran to the timeout instead of meeting a memory limit';
    const after = await interpreter.run('return 1 + 1;');
    return same(after.value, 2, 'a run after the allocation');
  });
  return { interpreter: interpreter.name, passed: checks.every((item) => item.ok), checks };
}
