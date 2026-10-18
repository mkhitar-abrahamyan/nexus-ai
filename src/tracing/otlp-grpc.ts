/**
 * OTLP over gRPC, with no SDK and no gRPC library: the trace service's one call, `Export`, framed
 * by hand over Node's own HTTP/2 client.
 */
import http2 from 'node:http2';
import { gunzipSync, gzipSync } from 'node:zlib';
import { type OtlpSpan, OtlpTraceExporter, type OtlpTraceExporterOptions } from './otlp.js';
import { decodeOtlpTraceResponse, encodeOtlpTraceRequest } from './otlp-proto.js';

const EXPORT_PATH = '/opentelemetry.proto.collector.trace.v1.TraceService/Export';

/** gRPC's status codes, by number, as a failed export reports them. */
const GRPC_CODES: Record<number, string> = {
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  16: 'UNAUTHENTICATED',
};

/** Options for `OtlpGrpcTraceExporter`. */
export interface OtlpGrpcTraceExporterOptions extends Omit<OtlpTraceExporterOptions, 'fetch' | 'protocol'> {
  /**
   * The collector's OTLP gRPC address, such as `http://localhost:4317` for a connection without TLS
   * or `https://collector.example.com:4317` for one with it.
   */
  endpoint: string;
  /** gRPC metadata on every call, such as an API key a hosted backend wants. Names are lowercased. */
  headers?: Record<string, string>;
  /** Compresses each batch with gzip. Defaults to true, as collectors accept it. */
  gzip?: boolean;
  /** How long one export may take, sent as the call's deadline. Defaults to 10 seconds. */
  timeoutMs?: number;
  /**
   * Options for the HTTP/2 connection, such as a `ca`, a client `cert` and `key`, or `servername`,
   * passed to `http2.connect()`.
   */
  connect?: http2.SecureClientSessionOptions;
}

/** Thrown when the collector answers an export with a gRPC status other than OK. */
export class OtlpGrpcError extends Error {
  constructor(
    /** The gRPC status code, such as 14 for `UNAVAILABLE`. */
    public readonly code: number,
    /** What the collector said. */
    public readonly details: string,
  ) {
    super(`The collector answered gRPC ${GRPC_CODES[code] ?? code}${details ? `: ${details}` : ''}`);
    this.name = 'OtlpGrpcError';
  }
}

/**
 * Sends finished runs to any OpenTelemetry collector as OTLP over gRPC, port 4317, in OTLP's
 * protobuf encoding: the same spans, batching, and GenAI attributes as `OtlpTraceExporter`, for a
 * collector or backend that takes gRPC only. Node.js only, since it speaks HTTP/2 through
 * `node:http2`.
 *
 * One connection is kept and reused, opened again when it drops; it never keeps the process alive
 * while no export is in flight. A call the collector refuses rejects `send()` with an
 * `OtlpGrpcError`, so `spoolingExporter()` keeps the batch; on its own, the batch goes to `onError`.
 * `close()` sends what is waiting and closes the connection.
 */
export class OtlpGrpcTraceExporter extends OtlpTraceExporter {
  private session: http2.ClientHttp2Session | undefined;
  private inFlight = 0;

  constructor(private readonly grpc: OtlpGrpcTraceExporterOptions) {
    super(grpc);
  }

  /** Sends what is waiting, then closes the connection. */
  async close(): Promise<void> {
    await this.flush();
    const session = this.session;
    this.session = undefined;
    if (!session || session.closed || session.destroyed) return;
    // Held open while it closes, and destroyed when the collector never acknowledges.
    session.ref();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        session.destroy();
        resolve();
      }, 2_000);
      session.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  protected override async post(spans: OtlpSpan[]): Promise<void> {
    const message = encodeOtlpTraceRequest(this.request(spans));
    const gzip = this.grpc.gzip !== false;
    const payload = gzip ? gzipSync(message) : message;
    const frame = new Uint8Array(5 + payload.length);
    frame[0] = gzip ? 1 : 0;
    new DataView(frame.buffer).setUint32(1, payload.length);
    frame.set(payload, 5);

    const reused = this.session !== undefined && !this.session.closed && !this.session.destroyed;
    let reply: Uint8Array;
    try {
      reply = await this.attempt(this.connection(), frame, gzip);
    } catch (error) {
      if (!(error instanceof Unanswered)) throw error;
      // A connection that dropped without a word fails the first call made on it, before anything
      // reaches a collector: that call is made once more, on a new connection, as gRPC clients do.
      if (!reused) throw error.cause;
      this.session?.destroy();
      this.session = undefined;
      try {
        reply = await this.attempt(this.connection(), frame, gzip);
      } catch (again) {
        throw again instanceof Unanswered ? again.cause : again;
      }
    }
    this.partial(reply.length ? decodeOtlpTraceResponse(reply) : undefined);
  }

  /** One call, holding the connection open while it is in flight. */
  private async attempt(session: http2.ClientHttp2Session, frame: Uint8Array, gzip: boolean): Promise<Uint8Array> {
    this.inFlight += 1;
    session.ref();
    try {
      return await this.call(session, frame, gzip);
    } finally {
      this.inFlight -= 1;
      // Idle, the connection must not keep the process alive on its own.
      if (this.inFlight === 0 && !session.closed && !session.destroyed) session.unref();
    }
  }

  private connection(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const url = new URL(this.grpc.endpoint);
    const session = http2.connect(url.origin, this.grpc.connect);
    // A dropped or refused connection fails the call in flight, which hears the error; the next call
    // finds it closed and opens another. One told to go away takes no new calls, so it is let go now.
    session.on('error', () => undefined);
    session.on('goaway', () => {
      if (this.session === session) this.session = undefined;
    });
    session.unref();
    this.session = session;
    return session;
  }

  private call(session: http2.ClientHttp2Session, frame: Uint8Array, gzip: boolean): Promise<Uint8Array> {
    const timeoutMs = this.grpc.timeoutMs ?? 10_000;
    const headers: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': EXPORT_PATH,
      'content-type': 'application/grpc',
      te: 'trailers',
      'grpc-timeout': `${Math.max(1, Math.ceil(timeoutMs))}m`,
      'grpc-accept-encoding': 'gzip,identity',
      ...(gzip ? { 'grpc-encoding': 'gzip' } : {}),
    };
    for (const [name, value] of Object.entries(this.grpc.headers ?? {})) headers[name.toLowerCase()] = value;

    return new Promise<Uint8Array>((resolve, reject) => {
      let status: number | undefined;
      let settled = false;
      const finish = (error?: Error, body?: Uint8Array): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Failed before any answer: the connection, not the collector, failed it.
        if (error instanceof Unanswered) reject(error);
        else if (error && status === undefined && !(error instanceof OtlpGrpcError)) reject(new Unanswered(error));
        else if (error) reject(error);
        else resolve(body ?? new Uint8Array(0));
      };
      const onSessionError = (error: Error): void => finish(error);
      session.once('error', onSessionError);
      const stream = session.request(headers);
      const timer = setTimeout(() => {
        stream.close(http2.constants.NGHTTP2_CANCEL);
        finish(new OtlpGrpcError(4, `no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();

      let encoding = 'identity';
      let grpcStatus: number | undefined;
      let grpcMessage = '';
      const chunks: Buffer[] = [];
      const readStatus = (fields: http2.IncomingHttpHeaders): void => {
        if (fields['grpc-status'] !== undefined) grpcStatus = Number(fields['grpc-status']);
        if (typeof fields['grpc-message'] === 'string') grpcMessage = decodeURIComponent(fields['grpc-message']);
      };
      stream.on('response', (fields) => {
        status = Number(fields[':status']);
        if (typeof fields['grpc-encoding'] === 'string') encoding = fields['grpc-encoding'];
        // A trailers-only answer carries its status with the headers.
        readStatus(fields);
      });
      stream.on('trailers', readStatus);
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', (error) => finish(error));
      stream.on('close', () => {
        session.off('error', onSessionError);
        if (settled) return;
        if (status === undefined) {
          // Closed before the collector answered, as a connection that dropped without a word is on
          // some systems, where on others it is an error: either way, the call was never answered.
          finish(new Unanswered(new OtlpGrpcError(14, 'the connection closed before the collector answered')));
          return;
        }
        if (status !== 200) {
          finish(new OtlpGrpcError(statusToGrpc(status), `HTTP ${status}`));
          return;
        }
        if (grpcStatus === undefined) {
          finish(new OtlpGrpcError(stream.rstCode ? 14 : 2, 'the call ended without a status'));
          return;
        }
        if (grpcStatus !== 0) {
          finish(new OtlpGrpcError(grpcStatus, grpcMessage));
          return;
        }
        try {
          finish(undefined, unframe(Buffer.concat(chunks), encoding));
        } catch (error) {
          finish(error as Error);
        }
      });
      stream.end(frame);
    });
  }
}

/** A call that failed before any answer came, carrying why. */
class Unanswered extends Error {
  constructor(public override readonly cause: Error) {
    super(cause.message);
  }
}

/** The message inside a gRPC reply's frames. */
function unframe(body: Buffer, encoding: string): Uint8Array {
  if (body.length < 5) return new Uint8Array(0);
  const compressed = body[0] === 1;
  const length = body.readUInt32BE(1);
  const message = body.subarray(5, 5 + length);
  if (!compressed) return message;
  if (encoding !== 'gzip') throw new OtlpGrpcError(13, `the reply was compressed with ${encoding}`);
  return gunzipSync(message);
}

/** What a gRPC client reads into an HTTP status that is not 200, as gRPC's own mapping has it. */
function statusToGrpc(status: number): number {
  if (status === 400) return 13;
  if (status === 401) return 16;
  if (status === 403) return 7;
  if (status === 404) return 12;
  if (status === 429 || status === 502 || status === 503 || status === 504) return 14;
  return 2;
}
