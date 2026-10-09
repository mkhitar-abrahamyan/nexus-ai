import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createStudio, type Studio } from './api.js';
import type { StudioOptions, StudioSources } from './types.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Options for `startStudio()`. */
export interface StartStudioOptions extends StudioOptions {
  /** Port to listen on. Defaults to 4747; `0` picks a free one. */
  port?: number;
  /**
   * Interface to bind. Defaults to `127.0.0.1`, so nothing else on the network can reach it. Binding
   * anything wider needs the host name in `allowedHosts`, and should come with `auth`: without it the
   * single token is the only protection, and the studio warns at start.
   */
  host?: string;
}

/** A studio that is listening. */
export interface RunningStudio {
  /** The address to open, token included. */
  url: string;
  /** The access token. */
  token: string;
  /** The port it is listening on. */
  port: number;
  /** The handler behind it. */
  studio: Studio;
  /** Stops listening. */
  close(): Promise<void>;
}

/** Starts the studio on a local port and returns the address to open. */
export async function startStudio(sources: StudioSources, options: StartStudioOptions = {}): Promise<RunningStudio> {
  const studio = createStudio(sources, options);
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK.has(host) && !options.auth) {
    process.emitWarning(
      `The studio is listening on ${host} with one shared token. Give it an auth option so each person signs in with a role.`,
      { code: 'NEXUS_STUDIO_SHARED_TOKEN' },
    );
  }
  const server = createServer((request, response) => {
    void serve(studio, request, response, options.maxBodyBytes ?? 1_048_576);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4747, host, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  return {
    url: `http://${shown}:${port}/?token=${encodeURIComponent(studio.token)}`,
    token: studio.token,
    port,
    studio,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function serve(
  studio: Studio,
  request: IncomingMessage,
  response: ServerResponse,
  maxBodyBytes: number,
): Promise<void> {
  try {
    // A body past the limit is refused as it arrives, before it fills memory or anyone is signed in.
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > maxBodyBytes) {
        response.writeHead(413, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
        response.end(`A request body is at most ${maxBodyBytes} bytes`);
        request.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      for (const item of Array.isArray(value) ? value : [value]) headers.append(key, item);
    }
    const result = await studio.handle(
      new Request(new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`), {
        method: request.method ?? 'GET',
        headers,
        ...(body && request.method !== 'GET' && request.method !== 'HEAD' ? { body } : {}),
      }),
      { ...(request.socket.remoteAddress ? { remoteAddress: request.socket.remoteAddress } : {}) },
    );
    const out: Record<string, string> = {};
    result.headers.forEach((value, key) => {
      out[key] = value;
    });
    response.writeHead(result.status, out);
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    // What went wrong stays on the server: a reply could tell anyone who can reach the port about it.
    console.error('The studio could not answer a request:', error);
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('The studio could not answer this request.');
  }
}
