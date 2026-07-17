import { createRealtimeId, type RealtimeIdFactory } from './id.js';
import type {
  AnyRealtimeTool,
  InferRealtimeSchema,
  RealtimeClock,
  RealtimeTool,
  RealtimeToolCall,
  RealtimeToolExecutionOptions,
  RealtimeToolResult,
  RealtimeToolSchema,
} from './types.js';

export interface DefineRealtimeToolOptions<Schema extends RealtimeToolSchema<unknown>, Output>
  extends Omit<RealtimeTool<InferRealtimeSchema<Schema>, Output>, 'schema'> {
  schema: Schema;
}

export function defineTool<Schema extends RealtimeToolSchema<unknown>, Output>(
  definition: DefineRealtimeToolOptions<Schema, Output>,
): RealtimeTool<InferRealtimeSchema<Schema>, Output>;
export function defineTool<Input extends Record<string, unknown>, Output>(
  definition: RealtimeTool<Input, Output>,
): RealtimeTool<Input, Output>;
export function defineTool(definition: RealtimeTool<unknown, unknown>): RealtimeTool<unknown, unknown> {
  if (!definition.name.trim()) throw new Error('Realtime tool name must not be empty');
  if (!definition.description.trim()) throw new Error(`Realtime tool "${definition.name}" requires a description`);
  return { ...definition };
}

export interface RealtimeToolExecutorHooks {
  onStarted?: (call: RealtimeToolCall) => void;
  onConfirmationRequired?: (call: RealtimeToolCall) => void;
  onCompleted?: (result: RealtimeToolResult) => void;
}

export interface RealtimeToolExecutorOptions extends RealtimeToolExecutionOptions, RealtimeToolExecutorHooks {
  sessionId: string;
  signal?: AbortSignal;
  clock?: RealtimeClock;
  idFactory?: RealtimeIdFactory;
}

export class RealtimeToolExecutor {
  private readonly tools = new Map<string, RealtimeTool<unknown, unknown>>();
  private readonly completed = new Map<string, RealtimeToolResult>();
  private readonly inFlight = new Map<string, Promise<RealtimeToolResult>>();
  private readonly queue: Array<{
    resolve: () => void;
    reject: (error: unknown) => void;
    signal?: AbortSignal;
    abort?: () => void;
  }> = [];
  private active = 0;
  private readonly clock: RealtimeClock;
  private readonly idFactory: RealtimeIdFactory;

  constructor(
    tools: AnyRealtimeTool[] = [],
    private readonly options: RealtimeToolExecutorOptions,
  ) {
    this.clock = options.clock || defaultClock;
    this.idFactory = options.idFactory || createRealtimeId;
    for (const tool of tools) this.register(tool);
  }

  register(tool: AnyRealtimeTool): this {
    if (this.tools.has(tool.name)) throw new Error(`Realtime tool "${tool.name}" is already registered`);
    this.tools.set(tool.name, tool as RealtimeTool<unknown, unknown>);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): AnyRealtimeTool[] {
    return [...this.tools.values()] as AnyRealtimeTool[];
  }

  clearCompleted(callId?: string): void {
    if (callId) this.completed.delete(callId);
    else this.completed.clear();
  }

  execute(call: Omit<RealtimeToolCall, 'idempotencyKey'> & { idempotencyKey?: string }): Promise<RealtimeToolResult> {
    const normalized: RealtimeToolCall = {
      ...call,
      idempotencyKey: call.idempotencyKey || this.idFactory('idem'),
    };
    const cached = this.completed.get(normalized.callId);
    if (cached) return Promise.resolve(cached);
    const pending = this.inFlight.get(normalized.callId);
    if (pending) return pending;

    const execution = this.runQueued(normalized).finally(() => this.inFlight.delete(normalized.callId));
    this.inFlight.set(normalized.callId, execution);
    return execution;
  }

  private async runQueued(call: RealtimeToolCall): Promise<RealtimeToolResult> {
    const signal = this.options.signal;
    const startedAt = this.clock.now();
    let attempts = 0;
    let release: (() => void) | undefined;

    try {
      throwIfAborted(signal);
      const tool = this.resolveTool(call.name);
      if (call.argumentError) throw new Error(call.argumentError);
      const input = await validateInput(tool, call.arguments);
      await this.confirmIfRequired(tool, input, call, signal);
      const cacheKey = this.cacheKey(tool, input);
      const cached = await this.readCache(cacheKey);
      if (cached.hit) {
        return this.finish({
          call,
          ok: true,
          result: cached.value,
          durationMs: Math.max(0, this.clock.now() - startedAt),
          attempts: 0,
        });
      }
      release = await this.acquire(signal);
      this.options.onStarted?.(call);

      const maxRetries = tool.safe ? Math.max(0, this.options.maxRetries || 0) : 0;
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        attempts = attempt + 1;
        try {
          const result = await this.executeAttempt(tool, input, call, attempts, signal);
          await this.writeCache(cacheKey, result, tool);
          return this.finish({
            call,
            ok: true,
            result,
            durationMs: Math.max(0, this.clock.now() - startedAt),
            attempts,
          });
        } catch (error) {
          lastError = error;
          if (attempt >= maxRetries || signal?.aborted) break;
          await this.clock.sleep(Math.max(0, this.options.retryDelayMs || 0) * 2 ** attempt, signal);
        }
      }
      throw lastError;
    } catch (error) {
      return this.finish({
        call,
        ok: false,
        error: errorMessage(error),
        durationMs: Math.max(0, this.clock.now() - startedAt),
        attempts,
      });
    } finally {
      release?.();
    }
  }

  private resolveTool(name: string): RealtimeTool<unknown, unknown> {
    const allowed = this.options.allowedTools;
    if (allowed && !allowed.includes(name)) throw new Error(`Realtime tool "${name}" is not allowed`);
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Realtime tool "${name}" is not registered`);
    return tool;
  }

  private cacheKey(tool: RealtimeTool<unknown, unknown>, input: unknown): string | undefined {
    if (!tool.safe || !tool.cache || !this.options.cache) return undefined;
    try {
      if (typeof tool.cache === 'object' && tool.cache.key) return `${tool.name}:${tool.cache.key(input)}`;
      return `${tool.name}:${hashString(stableJson(input))}`;
    } catch (error) {
      if (this.options.cacheFailureMode === 'fail') throw error;
      return undefined;
    }
  }

  private async readCache(key: string | undefined): Promise<{ hit: boolean; value?: unknown }> {
    if (!key || !this.options.cache) return { hit: false };
    try {
      const value = await this.options.cache.get(key);
      return value === undefined ? { hit: false } : { hit: true, value };
    } catch (error) {
      if (this.options.cacheFailureMode === 'fail') throw error;
      return { hit: false };
    }
  }

  private async writeCache(
    key: string | undefined,
    value: unknown,
    tool: RealtimeTool<unknown, unknown>,
  ): Promise<void> {
    if (!key || !this.options.cache || value === undefined) return;
    try {
      const ttlMs = typeof tool.cache === 'object' ? tool.cache.ttlMs : undefined;
      await this.options.cache.set(key, value, ttlMs);
    } catch (error) {
      if (this.options.cacheFailureMode === 'fail') throw error;
    }
  }

  private async confirmIfRequired(
    tool: RealtimeTool<unknown, unknown>,
    input: unknown,
    call: RealtimeToolCall,
    signal?: AbortSignal,
  ): Promise<void> {
    const required =
      typeof tool.requiresConfirmation === 'function'
        ? await tool.requiresConfirmation(input)
        : tool.requiresConfirmation === true;
    if (!required) return;
    if (!this.options.confirm) throw new Error(`Realtime tool "${tool.name}" requires confirmation`);
    const approval = this.options.confirm(call, signal || new AbortController().signal);
    this.options.onConfirmationRequired?.(call);
    const approved = await approval;
    if (!approved) throw new Error(`Realtime tool "${tool.name}" was rejected`);
  }

  private executeAttempt(
    tool: RealtimeTool<unknown, unknown>,
    input: unknown,
    call: RealtimeToolCall,
    attempt: number,
    parentSignal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutMs = Math.max(0, this.options.timeoutMs ?? 8_000);
    const abort = () => controller.abort(parentSignal?.reason);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (parentSignal?.aborted) abort();
    else parentSignal?.addEventListener('abort', abort, { once: true });
    if (!controller.signal.aborted && timeoutMs > 0) {
      timeout = setTimeout(() => controller.abort(new Error(`Tool timed out after ${timeoutMs}ms`)), timeoutMs);
    }

    const result = Promise.resolve(
      tool.execute(input, {
        sessionId: this.options.sessionId,
        callId: call.callId,
        idempotencyKey: call.idempotencyKey,
        attempt,
        signal: controller.signal,
      }),
    );
    return waitForAbort(result, controller.signal).finally(() => {
      if (timeout) clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abort);
    });
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    const maximum = Math.max(1, this.options.maxParallelCalls || 3);
    if (this.active < maximum) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve, reject) => {
      const entry: (typeof this.queue)[number] = {
        resolve: () => {
          this.active += 1;
          resolve(() => this.release());
        },
        reject,
        signal,
      };
      entry.abort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError(signal));
      };
      if (signal?.aborted) entry.abort();
      else {
        signal?.addEventListener('abort', entry.abort, { once: true });
        this.queue.push(entry);
      }
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.queue.length) {
      const next = this.queue.shift();
      if (!next) return;
      next.signal?.removeEventListener('abort', next.abort || (() => {}));
      if (next.signal?.aborted) {
        next.reject(abortError(next.signal));
        continue;
      }
      next.resolve();
      return;
    }
  }

  private finish(result: RealtimeToolResult): RealtimeToolResult {
    this.completed.set(result.call.callId, result);
    this.options.onCompleted?.(result);
    return result;
  }
}

export function toOpenAIRealtimeTools(tools: AnyRealtimeTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters || { type: 'object', additionalProperties: true },
  }));
}

async function validateInput(tool: RealtimeTool<unknown, unknown>, input: unknown): Promise<unknown> {
  const schema = tool.schema;
  if (!schema) return input;
  if (schema.safeParse) {
    const parsed = schema.safeParse(input);
    if (!parsed.success)
      throw new Error(`Invalid arguments for realtime tool "${tool.name}": ${errorMessage(parsed.error)}`);
    return parsed.data;
  }
  if (schema.parse) return schema.parse(input);
  if (schema.validate) return schema.validate(input);
  return input;
}

function waitForAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError(signal)));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error('Realtime tool execution was aborted');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function hashString(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

const defaultClock: RealtimeClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        reject(abortError(signal));
      };
      const timeout = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', abort, { once: true });
    });
  },
};
