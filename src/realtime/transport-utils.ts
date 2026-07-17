export type TransportCleanup = () => void;

export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface TimerPlatform {
  setTimeout(handler: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface EventTargetLike {
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
  on?(type: string, listener: (event: unknown) => void): void;
  off?(type: string, listener: (event: unknown) => void): void;
  removeListener?(type: string, listener: (event: unknown) => void): void;
}

export interface Utf8Codec {
  encode(value: string): Uint8Array;
  decode(value: ArrayBuffer | Uint8Array): string;
}

class PortableAbortSignal implements AbortSignalLike {
  aborted = false;
  reason?: unknown;
  private readonly listeners = new Set<() => void>();

  addEventListener(type: 'abort', listener: () => void): void {
    if (type === 'abort' && !this.aborted) this.listeners.add(listener);
  }

  removeEventListener(type: 'abort', listener: () => void): void {
    if (type === 'abort') this.listeners.delete(listener);
  }

  abort(reason?: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    for (const listener of [...this.listeners]) listener();
    this.listeners.clear();
  }
}

export class PortableAbortController {
  readonly signal: AbortSignalLike = new PortableAbortSignal();

  abort(reason?: unknown): void {
    (this.signal as PortableAbortSignal).abort(reason);
  }
}

export interface TransportOperationOptions {
  signal?: AbortSignalLike;
  timers?: TimerPlatform;
  timeoutMs?: number;
  abortError: (reason?: unknown) => unknown;
  timeoutError?: () => unknown;
}

export class CleanupStack {
  private cleanups: TransportCleanup[] = [];

  add(cleanup: TransportCleanup | undefined): TransportCleanup {
    if (!cleanup) return () => undefined;
    this.cleanups.push(cleanup);
    return cleanup;
  }

  flush(): void {
    const pending = this.cleanups.splice(0).reverse();
    for (const cleanup of pending) {
      try {
        cleanup();
      } catch {
        // Cleanup is best effort; transport errors are emitted at their source.
      }
    }
  }
}

export function listen(target: EventTargetLike, type: string, listener: (event: unknown) => void): TransportCleanup {
  if (target.addEventListener && target.removeEventListener) {
    target.addEventListener(type, listener);
    return () => target.removeEventListener?.(type, listener);
  }

  if (target.on) {
    target.on(type, listener);
    return () => {
      if (target.off) target.off(type, listener);
      else target.removeListener?.(type, listener);
    };
  }

  throw new Error(`Platform object does not support event listener "${type}"`);
}

export function canListen(target: EventTargetLike): boolean {
  return Boolean(
    (target.addEventListener && target.removeEventListener) || (target.on && (target.off || target.removeListener)),
  );
}

export function waitForTransportOperation<T>(
  operation: PromiseLike<T>,
  options: TransportOperationOptions,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: unknown;
    let removeAbort: TransportCleanup = () => undefined;
    const finish = (result: { value: T } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      removeAbort();
      if (timeout !== undefined) options.timers?.clearTimeout(timeout);
      if ('error' in result) reject(result.error);
      else resolve(result.value);
    };

    removeAbort = onAbort(options.signal, () => finish({ error: options.abortError(options.signal?.reason) }));
    Promise.resolve(operation).then(
      (value) => finish({ value }),
      (error) => finish({ error }),
    );

    if (!settled && options.timers && options.timeoutMs !== undefined) {
      const handle = options.timers.setTimeout(
        () => finish({ error: options.timeoutError?.() ?? new Error('Transport operation timed out') }),
        options.timeoutMs,
      );
      if (settled) options.timers.clearTimeout(handle);
      else timeout = handle;
    }
  });
}

export function defaultTimerPlatform(): TimerPlatform {
  const runtime = globalThis as unknown as {
    setTimeout?: (handler: () => void, delayMs: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
    performance?: { now(): number };
  };

  if (!runtime.setTimeout || !runtime.clearTimeout) {
    throw new Error('This environment does not provide timers');
  }

  return {
    setTimeout: runtime.setTimeout.bind(runtime),
    clearTimeout: runtime.clearTimeout.bind(runtime),
    now: () => runtime.performance?.now() ?? Date.now(),
  };
}

export function copyArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value.slice(0);
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export function encodeBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';

  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1] ?? 0;
    const third = bytes[index + 2] ?? 0;
    const triple = (first << 16) | (second << 8) | third;
    output += alphabet[(triple >> 18) & 63];
    output += alphabet[(triple >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : '=';
    output += index + 2 < bytes.length ? alphabet[triple & 63] : '=';
  }

  return output;
}

export function decodeBase64(value: string): ArrayBuffer {
  const normalized = value.replace(/\s/g, '');
  if (normalized === '') return new ArrayBuffer(0);
  const valid = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized);
  if (!valid) {
    throw new Error('Invalid base64 audio payload');
  }

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  const output = new Uint8Array((normalized.length / 4) * 3 - padding);
  let offset = 0;

  for (let index = 0; index < normalized.length; index += 4) {
    const a = alphabet.indexOf(normalized[index]);
    const b = alphabet.indexOf(normalized[index + 1]);
    const c = normalized[index + 2] === '=' ? 0 : alphabet.indexOf(normalized[index + 2]);
    const d = normalized[index + 3] === '=' ? 0 : alphabet.indexOf(normalized[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('Invalid base64 audio payload');
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < output.length) output[offset++] = (triple >> 16) & 255;
    if (offset < output.length) output[offset++] = (triple >> 8) & 255;
    if (offset < output.length) output[offset++] = triple & 255;
  }

  return output.buffer;
}

export function defaultUtf8Codec(): Utf8Codec {
  return {
    encode(value) {
      const bytes: number[] = [];
      for (const symbol of value) {
        const codePoint = symbol.codePointAt(0) ?? 0;
        if (codePoint <= 0x7f) bytes.push(codePoint);
        else if (codePoint <= 0x7ff) {
          bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
        } else if (codePoint <= 0xffff) {
          bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
        } else {
          bytes.push(
            0xf0 | (codePoint >> 18),
            0x80 | ((codePoint >> 12) & 0x3f),
            0x80 | ((codePoint >> 6) & 0x3f),
            0x80 | (codePoint & 0x3f),
          );
        }
      }
      return Uint8Array.from(bytes);
    },
    decode(value) {
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      let output = '';
      for (let index = 0; index < bytes.length; ) {
        const first = bytes[index++];
        if (first < 0x80) {
          output += String.fromCodePoint(first);
          continue;
        }

        const continuationCount = first < 0xe0 ? 1 : first < 0xf0 ? 2 : 3;
        let codePoint = first & (0x7f >> continuationCount);
        let valid = index + continuationCount <= bytes.length;
        for (let offset = 0; offset < continuationCount && valid; offset += 1) {
          const next = bytes[index++];
          if ((next & 0xc0) !== 0x80) {
            valid = false;
            index -= 1;
          } else {
            codePoint = (codePoint << 6) | (next & 0x3f);
          }
        }
        output += valid ? String.fromCodePoint(codePoint) : '\ufffd';
      }
      return output;
    },
  };
}

export function eventPayload(event: unknown): unknown {
  if (event && typeof event === 'object' && 'data' in event) {
    return (event as { data?: unknown }).data;
  }
  return event;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function safeJsonParse(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error('Realtime event must be a JSON object');
  return parsed;
}

export function safeJsonStringify(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Realtime event is not JSON serializable');
  return serialized;
}

export function abortReason(signal: AbortSignalLike | undefined): unknown {
  return signal?.aborted ? signal.reason : undefined;
}

export function onAbort(signal: AbortSignalLike | undefined, listener: () => void): TransportCleanup {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    listener();
    return () => undefined;
  }
  signal.addEventListener('abort', listener, { once: true });
  return () => signal.removeEventListener('abort', listener);
}
