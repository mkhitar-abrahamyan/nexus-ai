/**
 * A2A's gRPC binding: the service `lf.a2a.v1.A2AService` of protocol 1.0, served over the same
 * `a2aHandler()` as its JSON-RPC and HTTP+JSON bindings, and so over the same tasks, and a client that
 * calls an agent over it. Over HTTP/2 from `node:http2`, with no dependency.
 *
 * ```ts
 * const handler = a2aHandler(agent, { card, interfaces: [{ url: 'agents.example.com:50051', protocolBinding: 'GRPC' }] });
 * const grpc = a2aGrpcService(handler);
 * await grpc.listen(50051);
 * ```
 */
import http2, {
  type ClientHttp2Session,
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import { gunzipSync, inflateSync } from 'node:zlib';
import {
  A2A_PROTOCOL_VERSION,
  type A2aAgentCard,
  type A2aClient,
  type A2aClientOptions,
  A2aError,
  type A2aHandler,
  type A2aMessage,
  type A2aPushNotificationConfig,
  type A2aSendOptions,
  type A2aStreamEvent,
  type A2aTask,
  type A2aTaskPage,
  a2aErrorCode,
  a2aErrorStatus,
} from './a2a.js';
import {
  A2A_GRPC_METHODS,
  A2A_GRPC_SERVICE,
  a2aStatusReason,
  decodeA2a,
  encodeA2a,
  encodeA2aStatus,
} from './a2a-proto.js';
import { verifyA2aCard } from './a2a-signing.js';
import { protocolId } from './shared.js';

/** gRPC's status codes, by name. */
const GRPC_CODES: Record<string, number> = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
};

/** Options for `a2aGrpcService()`. */
export interface A2aGrpcServiceOptions {
  /** Largest request message taken, in bytes. Defaults to 4 MiB, gRPC's own default. */
  maxMessageBytes?: number;
}

/** The gRPC binding of one A2A handler. */
export interface A2aGrpcService {
  /**
   * Answers one HTTP/2 stream: give it each stream of a server of your own, such as one over TLS,
   * as `server.on('stream', service.handle)`.
   */
  handle(stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void;
  /**
   * Starts a server over plain HTTP/2 on `port`, 0 for any, on `host`: for a server behind a proxy
   * that ends TLS, and for tests. Resolves with the address to list on the card, `host:port`. Its
   * `close()` stops taking calls, tells each connected client to go, and resolves once the calls in
   * flight finish.
   */
  listen(
    port?: number,
    host?: string,
  ): Promise<{ url: string; port: number; server: Http2Server; close(): Promise<void> }>;
}

/**
 * The gRPC binding over an `a2aHandler()`: each method of `lf.a2a.v1.A2AService`, its message read as
 * the JSON the handler takes and its answer written back, a stream as a server-streaming call, and an
 * error as a gRPC status with A2A's `ErrorInfo` in `grpc-status-details-bin`. The caller is read by the
 * handler's own `principal`, from a `Request` with the call's metadata as its headers.
 */
export function a2aGrpcService(handler: A2aHandler, options: A2aGrpcServiceOptions = {}): A2aGrpcService {
  const maxBytes = options.maxMessageBytes ?? 4 * 1024 * 1024;

  const handle = (stream: ServerHttp2Stream, headers: IncomingHttpHeaders): void => {
    const path = String(headers[':path'] ?? '');
    const method = path.startsWith(`/${A2A_GRPC_SERVICE}/`) ? path.slice(A2A_GRPC_SERVICE.length + 2) : '';
    const shape = A2A_GRPC_METHODS[method];
    const contentType = String(headers['content-type'] ?? '');
    if (!contentType.startsWith('application/grpc')) {
      stream.respond({ ':status': 415 }, { endStream: true });
      return;
    }
    if (!shape) {
      fail(stream, GRPC_CODES.UNIMPLEMENTED as number, `Method ${path} is not part of ${A2A_GRPC_SERVICE}`);
      return;
    }
    const version = headers['a2a-version'];
    if (typeof version === 'string' && !version.startsWith('1.')) {
      failA2a(stream, -32009, `This agent speaks A2A ${A2A_PROTOCOL_VERSION}, not ${version}`);
      return;
    }

    const controller = new AbortController();
    const timeout = deadline(headers['grpc-timeout']);
    const timer =
      timeout === undefined ? undefined : setTimeout(() => controller.abort(new Error('deadline exceeded')), timeout);
    stream.on('close', () => {
      if (timer) clearTimeout(timer);
      controller.abort(new Error('The caller went away'));
    });

    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= maxBytes + 5) chunks.push(chunk);
    });
    stream.on('end', () => {
      void (async () => {
        if (size > maxBytes + 5) {
          return fail(stream, GRPC_CODES.RESOURCE_EXHAUSTED as number, `The request is larger than ${maxBytes} bytes`);
        }
        let params: Record<string, unknown>;
        try {
          const [message] = frames(Buffer.concat(chunks), headers['grpc-encoding']);
          params = decodeA2a(shape.request, message ?? new Uint8Array());
        } catch (error) {
          return fail(stream, GRPC_CODES.INVALID_ARGUMENT as number, (error as Error).message);
        }
        const request = new Request(`http://grpc.invalid${path}`, { method: 'POST', headers: metadataOf(headers) });
        const principal = await handler.authenticate(request);
        const outcome = await handler.call(method, params, {
          ...(principal ? { principal } : {}),
          signal: controller.signal,
          binding: 'GRPC',
        });
        if ('error' in outcome) return failA2a(stream, outcome.error.code, outcome.error.message);
        if (stream.destroyed) return;
        stream.respond({ ':status': 200, 'content-type': 'application/grpc+proto' }, { waitForTrailers: true });
        let trailers: Record<string, string> = { 'grpc-status': '0' };
        stream.on('wantTrailers', () => stream.sendTrailers(trailers));
        if ('events' in outcome) {
          const reader = outcome.events.getReader();
          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done || stream.destroyed) break;
              stream.write(frame(encodeA2a(shape.response, value)));
            }
          } catch (error) {
            trailers = errorTrailers(-32603, (error as Error).message);
          } finally {
            if (stream.destroyed) void reader.cancel();
          }
        } else {
          stream.write(frame(encodeA2a(shape.response, outcome.result ?? {})));
        }
        if (!stream.destroyed) stream.end();
      })().catch((error: unknown) => {
        if (!stream.headersSent) fail(stream, GRPC_CODES.INTERNAL as number, (error as Error).message);
        else stream.destroy(error as Error);
      });
    });
  };

  return {
    handle,
    async listen(port = 0, host = '127.0.0.1') {
      const server = http2.createServer();
      server.on('stream', handle);
      // A client keeps its connection open between calls; closing the server waits for each to end.
      const sessions = new Set<http2.ServerHttp2Session>();
      server.on('session', (session) => {
        sessions.add(session);
        session.on('close', () => sessions.delete(session));
      });
      await new Promise<void>((resolve) => server.listen(port, host, resolve));
      const address = server.address() as AddressInfo;
      return {
        url: `${host}:${address.port}`,
        port: address.port,
        server,
        close: () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            for (const session of sessions) session.close();
          }),
      };
    },
  };
}

/** Ends a call with a status and nothing else: a trailers-only answer. */
function fail(stream: ServerHttp2Stream, code: number, message: string, details?: Uint8Array): void {
  if (stream.destroyed || stream.headersSent) return;
  stream.respond(
    {
      ':status': 200,
      'content-type': 'application/grpc+proto',
      'grpc-status': String(code),
      'grpc-message': grpcMessage(message),
      ...(details ? { 'grpc-status-details-bin': Buffer.from(details).toString('base64').replace(/=+$/, '') } : {}),
    },
    { endStream: true },
  );
}

/** Ends a call with an A2A error: its gRPC status, and its `ErrorInfo`. */
function failA2a(stream: ServerHttp2Stream, code: number, message: string): void {
  const status = a2aErrorStatus(code);
  const grpc = GRPC_CODES[status.grpcStatus] ?? (GRPC_CODES.INTERNAL as number);
  fail(stream, grpc, message, encodeA2aStatus(grpc, message, status.reason));
}

function errorTrailers(code: number, message: string): Record<string, string> {
  const status = a2aErrorStatus(code);
  const grpc = GRPC_CODES[status.grpcStatus] ?? (GRPC_CODES.INTERNAL as number);
  return {
    'grpc-status': String(grpc),
    'grpc-message': grpcMessage(message),
    'grpc-status-details-bin': Buffer.from(encodeA2aStatus(grpc, message, status.reason))
      .toString('base64')
      .replace(/=+$/, ''),
  };
}

/** A message as gRPC frames it: a flag for compression, its length, and its bytes. */
function frame(message: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + message.length);
  new DataView(out.buffer).setUint32(1, message.length);
  out.set(message, 5);
  return out;
}

/** Every framed message of a body, decompressed when its flag says so. */
function frames(body: Buffer, encoding: string | string[] | undefined): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  while (offset + 5 <= body.length) {
    const compressed = body[offset] === 1;
    const length = body.readUInt32BE(offset + 1);
    let message: Uint8Array = body.subarray(offset + 5, offset + 5 + length);
    if (message.length < length) throw new Error('A gRPC message ended early');
    if (compressed) {
      const name = String(encoding ?? 'identity');
      if (name === 'gzip') message = gunzipSync(message);
      else if (name === 'deflate') message = inflateSync(message);
      else throw new Error(`A gRPC message compressed with ${name} cannot be read`);
    }
    out.push(message);
    offset += 5 + length;
  }
  return out;
}

/** gRPC's `grpc-timeout`, as milliseconds: `100m`, `5S`, `1M`. */
function deadline(value: string | string[] | undefined): number | undefined {
  const match = typeof value === 'string' ? /^(\d+)([HMSmun])$/.exec(value) : null;
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = { H: 3_600_000, M: 60_000, S: 1_000, m: 1, u: 0.001, n: 0.000001 }[match[2] as 'H'];
  return Math.max(0, amount * unit);
}

/** gRPC's percent-encoding of `grpc-message`: printable ASCII but `%` as it is. */
function grpcMessage(message: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(message)) {
    out +=
      byte >= 0x20 && byte <= 0x7e && byte !== 0x25
        ? String.fromCharCode(byte)
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function decodeGrpcMessage(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** A call's metadata, as a `Request`'s headers: pseudo-headers and gRPC's own left out. */
function metadataOf(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith(':') || value === undefined || name.endsWith('-bin')) continue;
    out.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }
  return out;
}

// ── The client ──

/** Options for `a2aGrpcClient()`. */
export interface A2aGrpcClientOptions extends Omit<A2aClientOptions, 'binding' | 'url'> {
  /** Where the agent's gRPC service is: `host:port`, as its card lists it, or an `http://` or `https://` URL. */
  url: string;
  /** Where its card is, for `card()`. Without it, `card()` reads the extended card. */
  cardUrl?: string;
}

/** A client for an A2A agent over gRPC, with `close()` for its connection. */
export interface A2aGrpcClient extends A2aClient {
  /** Closes the HTTP/2 connection. */
  close(): Promise<void>;
}

/**
 * A client for one A2A agent over its gRPC binding: the same methods as `a2aClient()`, each a call of
 * `lf.a2a.v1.A2AService` over one HTTP/2 connection, a gRPC error raised as an `A2aError` with the
 * protocol's code. Plain HTTP/2 for `host:port` and `http://`; TLS for `https://`.
 */
export function a2aGrpcClient(options: A2aGrpcClientOptions): A2aGrpcClient {
  const authority = /^https?:\/\//.test(options.url) ? options.url : `http://${options.url}`;
  let session: ClientHttp2Session | undefined;
  let active = 0;
  const connect = () => {
    if (!session || session.closed || session.destroyed) {
      session = http2.connect(authority);
      session.on('error', () => undefined);
      session.unref();
    }
    return session;
  };

  /** Runs one call, yielding each answer it streams, and throws its status when it fails. */
  async function* invoke(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>> {
    const shape = A2A_GRPC_METHODS[method] as { request: string; response: string };
    const connection = connect();
    active += 1;
    connection.ref();
    const request = connection.request({
      ':method': 'POST',
      ':path': `/${A2A_GRPC_SERVICE}/${method}`,
      'content-type': 'application/grpc+proto',
      te: 'trailers',
      'a2a-version': A2A_PROTOCOL_VERSION,
      ...Object.fromEntries(Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
    });
    const abort = () => request.close(http2.constants.NGHTTP2_CANCEL);
    signal?.addEventListener('abort', abort, { once: true });
    // Every request names the tenant, when the client has one.
    request.end(
      frame(encodeA2a(shape.request, options.tenant ? { tenant: options.tenant, ...(params as object) } : params)),
    );
    let status: Record<string, unknown> = {};
    request.on('response', (headers) => {
      if (headers['grpc-status'] !== undefined) status = headers as Record<string, unknown>;
    });
    request.on('trailers', (trailers) => {
      status = trailers as Record<string, unknown>;
    });
    let buffer = Buffer.alloc(0);
    try {
      for await (const chunk of request as AsyncIterable<Buffer>) {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 5) {
          const length = buffer.readUInt32BE(1);
          if (buffer.length < 5 + length) break;
          yield decodeA2a(shape.response, buffer.subarray(5, 5 + length));
          buffer = buffer.subarray(5 + length);
        }
      }
      const code = Number(status['grpc-status'] ?? 2);
      if (code !== 0) {
        const details = status['grpc-status-details-bin'];
        const info = typeof details === 'string' ? a2aStatusReason(Buffer.from(details, 'base64')) : {};
        const message = info.message ?? decodeGrpcMessage(String(status['grpc-message'] ?? `gRPC status ${code}`));
        throw new A2aError(a2aErrorCode(info.reason, code === 5 ? -32001 : -32603), message, { grpcStatus: code });
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      active -= 1;
      if (active === 0) connection.unref();
    }
  }
  const unary = async <T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> => {
    let answer: Record<string, unknown> | undefined;
    for await (const message of invoke(method, params, signal)) answer = message;
    return (answer ?? {}) as T;
  };
  const message = (text: string, send: A2aSendOptions): A2aMessage => ({
    messageId: protocolId('message'),
    role: 'ROLE_USER',
    parts: [{ text }, ...(send.data === undefined ? [] : [{ data: send.data }])],
    ...(send.contextId ? { contextId: send.contextId } : {}),
    ...(send.taskId ? { taskId: send.taskId } : {}),
  });
  const configuration = (send: A2aSendOptions) => ({
    returnImmediately: send.returnImmediately === true,
    ...(send.push ? { taskPushNotificationConfig: send.push } : {}),
  });
  const pushConfig = (answer: Record<string, unknown>): A2aPushNotificationConfig => {
    const { taskId: _taskId, tenant: _tenant, ...config } = answer;
    return config as unknown as A2aPushNotificationConfig;
  };
  /** A card as read, checked against `verifyCard` when it is given. */
  const checked = async (read: A2aAgentCard): Promise<A2aAgentCard> => {
    if (options.verifyCard) await verifyA2aCard(read, options.verifyCard);
    return read;
  };
  const extendedCard = async () => checked(await unary<A2aAgentCard>('GetExtendedAgentCard', {}));
  const card = async (): Promise<A2aAgentCard> => {
    if (!options.cardUrl) return extendedCard();
    const response = await (options.fetch ?? globalThis.fetch)(options.cardUrl, {
      headers: { accept: 'application/json', ...options.headers },
    });
    if (!response.ok) throw new A2aError(response.status, `The agent card answered ${response.status}`);
    return checked((await response.json()) as A2aAgentCard);
  };

  return {
    card,
    extendedCard,
    async send(text, send = {}) {
      const result = await unary<{ task?: A2aTask; message?: A2aMessage }>(
        'SendMessage',
        { message: message(text, send), configuration: configuration(send) },
        send.signal,
      );
      if (result.task) return result.task;
      const reply = result.message as A2aMessage;
      return {
        id: reply?.taskId ?? '',
        contextId: reply?.contextId ?? send.contextId ?? '',
        status: { state: 'TASK_STATE_COMPLETED', ...(reply ? { message: reply } : {}) },
        artifacts: [{ artifactId: 'message', parts: reply?.parts ?? [] }],
      };
    },
    async *stream(text, send = {}) {
      for await (const event of invoke(
        'SendStreamingMessage',
        { message: message(text, send), ...(send.push ? { configuration: configuration(send) } : {}) },
        send.signal,
      )) {
        yield event as unknown as A2aStreamEvent;
      }
    },
    getTask: (taskId, historyLength) =>
      unary<A2aTask>('GetTask', { id: taskId, ...(historyLength ? { historyLength } : {}) }),
    listTasks: (list = {}) => unary<A2aTaskPage>('ListTasks', { ...list }),
    async *subscribe(taskId, subscribe = {}) {
      for await (const event of invoke('SubscribeToTask', { id: taskId }, subscribe.signal)) {
        yield event as unknown as A2aStreamEvent;
      }
    },
    cancel: (taskId) => unary<A2aTask>('CancelTask', { id: taskId }),
    async setPushNotification(taskId, config) {
      return pushConfig(
        await unary<Record<string, unknown>>('CreateTaskPushNotificationConfig', { ...config, taskId }),
      );
    },
    async listPushNotifications(taskId) {
      const result = await unary<{ configs?: Array<Record<string, unknown>> }>('ListTaskPushNotificationConfigs', {
        taskId,
      });
      return (result.configs ?? []).map(pushConfig);
    },
    async deletePushNotification(taskId, configId) {
      await unary('DeleteTaskPushNotificationConfig', { taskId, id: configId });
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (!session || session.closed) return resolve();
        session.close(() => resolve());
      }),
  };
}
