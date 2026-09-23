import { ServerError } from './errors.js';

/** A matched route: the handler, and the parameters read out of the path. */
export interface RouteMatch<T> {
  /** What the route does. */
  handler: T;
  /** Path parameters, such as `{ threadId: 'thread-1' }`. */
  params: Record<string, string>;
}

/**
 * A tiny path router: literal segments, and `:name` parameters.
 *
 * Written rather than imported so the server entry point carries no routing dependency; the whole
 * surface is a dozen routes, which is well under the size of any router worth installing.
 */
export class Routes<T> {
  private readonly routes: Array<{ method: string; segments: string[]; handler: T }> = [];

  /** Registers a route, such as `add('POST', '/threads/:threadId/runs', handler)`. */
  add(method: string, pattern: string, handler: T): this {
    this.routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  /** The route for a method and path, or `undefined`. A path that matches another method is reported. */
  match(method: string, pathname: string): RouteMatch<T> | 'method-not-allowed' | undefined {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index] as string;
        const value = parts[index] as string;
        if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(value);
        else if (segment !== value) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      pathMatched = true;
      if (route.method === method) return { handler: route.handler, params };
    }
    return pathMatched ? 'method-not-allowed' : undefined;
  }
}

/** A JSON response with the given status. */
export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** The error response for any thrown value: a `ServerError` keeps its status, anything else is a 500. */
export function errorResponse(error: unknown): Response {
  if (error instanceof ServerError) {
    return json({ error: { code: error.code, message: error.message } }, error.status);
  }
  const message = error instanceof Error ? error.message : String(error);
  return json({ error: { code: 'INTERNAL', message } }, 500);
}

/** Reads a JSON body, treating an empty body as `{}` and bad JSON as a 400. */
export async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ServerError(`Request body is not valid JSON: ${(error as Error).message}`, 'BAD_JSON', 400);
  }
}

/** One server-sent event, with the id a client resumes from. */
export function formatSse(event: { id?: number; event?: string; data: unknown }): string {
  const lines: string[] = [];
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.event) lines.push(`event: ${event.event}`);
  lines.push(`data: ${JSON.stringify(event.data)}`);
  return `${lines.join('\n')}\n\n`;
}

/** The headers an event stream needs, including the ones that stop a proxy buffering it. */
export const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};
