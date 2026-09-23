import type { AgentServer } from './server.js';

/** The part of Node's `IncomingMessage` the adapter reads. */
export interface NodeRequestLike {
  /** HTTP method. */
  method?: string;
  /** Request path, with its query string. */
  url?: string;
  /** Request headers, as Node reports them. */
  headers: Record<string, string | string[] | undefined>;
  /** Subscribes to `data`, `end`, `error`, and `close`. */
  on(event: string, listener: (chunk?: unknown) => void): unknown;
  /** Stops reading the body. */
  destroy?(error?: Error): unknown;
}

/** The part of Node's `ServerResponse` the adapter writes. */
export interface NodeResponseLike {
  /** Writes the status line and headers. */
  writeHead(status: number, headers?: Record<string, string | string[]>): unknown;
  /** Writes a chunk of the body. */
  write(chunk: Uint8Array | string): unknown;
  /** Ends the response. */
  end(chunk?: Uint8Array | string): unknown;
  /** Subscribes to `close`, so a disconnected client aborts the handler. */
  on(event: string, listener: () => void): unknown;
  /** Flushes headers on platforms that buffer them, so an event stream starts immediately. */
  flushHeaders?(): unknown;
}

/** Options for the Node adapter. */
export interface NodeListenerOptions {
  /** Origin used to build the request URL, for routes that read the query string. Defaults to the Host header. */
  origin?: string;
  /** Receives errors the adapter itself could not answer, such as a write to a closed socket. */
  onError?: (error: unknown) => void;
}

/**
 * Adapts the server to Node's `http`, and to anything that speaks its request and response objects.
 *
 * `http.createServer(toNodeListener(server))` serves it directly; Express and Fastify take the same
 * function as middleware (`app.use(...)`, or `fastify.use(...)` with `@fastify/middie`), and a Nest
 * controller can call it from a route handler. Streaming responses are piped through unbuffered, so
 * an event stream reaches the client as it is produced.
 */
export function toNodeListener(
  server: AgentServer,
  options: NodeListenerOptions = {},
): (request: NodeRequestLike, response: NodeResponseLike) => void {
  return (request, response) => {
    void (async () => {
      const controller = new AbortController();
      response.on('close', () => controller.abort());

      try {
        const host = header(request.headers.host) ?? 'localhost';
        const origin = options.origin ?? `http://${host}`;
        const body = await readBody(request);
        const webRequest = new Request(new URL(request.url ?? '/', origin), {
          method: request.method ?? 'GET',
          headers: toHeaders(request.headers),
          ...(body ? { body, duplex: 'half' } : {}),
          signal: controller.signal,
        } as RequestInit);

        const result = await server.handle(webRequest);
        const headers: Record<string, string> = {};
        result.headers.forEach((value, key) => {
          headers[key] = value;
        });
        response.writeHead(result.status, headers);
        if (!result.body) {
          response.end();
          return;
        }
        response.flushHeaders?.();
        const reader = result.body.getReader();
        while (!controller.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) response.write(value);
        }
        await reader.cancel().catch(() => undefined);
        response.end();
      } catch (error) {
        options.onError?.(error);
        try {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'The request could not be handled' } }));
        } catch {
          // The socket is already gone; there is nothing left to answer with.
        }
      }
    })();
  };
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toHeaders(source: Record<string, string | string[] | undefined>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
  }
  return headers;
}

function readBody(request: NodeRequestLike): Promise<Uint8Array | undefined> {
  const method = (request.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Uint8Array));
    request.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      resolve(body);
    });
    request.on('error', (error) => reject(error as Error));
  });
}
