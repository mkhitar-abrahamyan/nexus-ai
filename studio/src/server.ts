import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createStudio, type Studio } from './api.js';
import type { StudioOptions, StudioSources } from './types.js';

/** Options for `startStudio()`. */
export interface StartStudioOptions extends StudioOptions {
  /** Port to listen on. Defaults to 4747; `0` picks a free one. */
  port?: number;
  /**
   * Interface to bind. Defaults to `127.0.0.1`, so nothing else on the network can reach it. Binding
   * anything wider leaves the token as the only protection, and the host must also be listed in
   * `allowedHosts`.
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
  const server = createServer((request, response) => {
    void serve(studio, request, response);
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

async function serve(studio: Studio, request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
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
    );
    const out: Record<string, string> = {};
    result.headers.forEach((value, key) => {
      out[key] = value;
    });
    response.writeHead(result.status, out);
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(error instanceof Error ? error.message : String(error));
  }
}
