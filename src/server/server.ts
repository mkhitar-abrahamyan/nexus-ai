import type {
  CronRecord,
  Principal,
  RunEvent,
  RunRecord,
  ServerAssistant,
  ServerStateStore,
  ThreadBusyPolicy,
  ThreadRecord,
} from '../types/server.js';
import { CronScheduler, type CronSchedulerOptions } from './cron.js';
import { BadRequestError, ForbiddenError, NotFoundError, ServerError, UnauthorizedError } from './errors.js';
import { errorResponse, formatSse, json, readJson, Routes, SSE_HEADERS } from './http.js';
import { RunManager, type RunManagerOptions } from './runs.js';

/** Options for `createAgentServer()`. */
export interface AgentServerOptions extends Omit<RunManagerOptions, 'assistants'> {
  /** The assistants the server exposes, by id. A compiled graph satisfies the contract as it is. */
  assistants: Record<string, ServerAssistant>;
  /** Path the routes are mounted under, such as `/api`. Defaults to the root. */
  basePath?: string;
  /**
   * Identifies the caller. Returning a `Response` answers the request itself, which is how a custom
   * challenge or redirect is returned; returning nothing refuses the request as unauthenticated.
   */
  authenticate?: (request: Request) => Promise<Principal | Response | undefined> | Principal | Response | undefined;
  /** Serves requests without authentication when no hook is configured. Defaults to true. */
  allowAnonymous?: boolean;
  /** Scopes a principal must carry, by route group. */
  scopes?: { read?: string; write?: string };
  /** Schedules runs. Cron jobs given here exist from startup; the API can add more. */
  cron?: CronSchedulerOptions & { jobs?: ReadonlyArray<Omit<CronRecord, 'id' | 'createdAt'> & { id?: string }> };
  /** How often a live event stream sends a comment to keep the connection open, in milliseconds. Defaults to 15 seconds. */
  heartbeatMs?: number;
}

/** The server: one handler, with the pieces behind it available for tests and custom routes. */
export interface AgentServer {
  /** Answers one request. This is the whole HTTP surface. */
  handle(request: Request): Promise<Response>;
  /** Runs, threads, and the event log. */
  readonly runs: RunManager;
  /** The cron scheduler, when one is configured. */
  readonly cron?: CronScheduler;
  /** Starts the scheduler and re-claims runs abandoned by a crashed worker. */
  start(): Promise<void>;
  /** Stops the scheduler. Runs in flight are left to finish. */
  stop(): Promise<void>;
}

type Handler = (context: {
  request: Request;
  params: Record<string, string>;
  principal?: Principal;
  url: URL;
}) => Promise<Response>;

/**
 * A self-hosted agent server: assistants, threads, runs, cron jobs, and resumable event streams.
 *
 * The handler takes a `Request` and returns a `Response`, so it runs on Node's `http` through
 * `toNodeListener()`, and equally under Express, Fastify, Nest, or any runtime with `fetch` types.
 * Nothing is held in the handler itself: runs are durable operations and threads are records in a
 * store, so a second replica pointed at the same Redis or Postgres serves the same threads, finishes
 * a run whose worker died, and streams events a client started reading somewhere else.
 */
export function createAgentServer(options: AgentServerOptions): AgentServer {
  const runs = new RunManager(options);
  const basePath = (options.basePath ?? '').replace(/\/+$/, '');
  const scheduler = options.cron
    ? new CronScheduler({
        ...options.cron,
        start: (job) =>
          runs.start({
            assistant: job.assistant,
            input: job.input,
            threadId: job.threadId,
            metadata: { cronId: job.id },
            idempotencyKey: `${job.id}:${job.slot}`,
            principal: job.tenantId ? { tenantId: job.tenantId } : undefined,
          }),
        state: options.state,
        now: options.now,
      })
    : undefined;

  const routes = new Routes<{ handler: Handler; scope: 'read' | 'write' }>();
  const read = (method: string, path: string, handler: Handler) => routes.add(method, path, { handler, scope: 'read' });
  const write = (method: string, path: string, handler: Handler) =>
    routes.add(method, path, { handler, scope: 'write' });

  read('GET', '/health', async () => json({ status: 'ok', worker: runs.workerId }));
  read('GET', '/assistants', async () =>
    json({
      assistants: Object.entries(runs.assistants).map(([id, assistant]) => ({
        id,
        description: assistant.description,
        supports: {
          resume: typeof assistant.resume === 'function',
          state: typeof assistant.state === 'function',
          rollback: typeof assistant.restore === 'function',
        },
      })),
    }),
  );
  read('GET', '/assistants/:assistant', async ({ params }) => {
    const assistant = runs.assistant(params.assistant as string);
    return json({ id: params.assistant, description: assistant.description });
  });

  write('POST', '/threads', async ({ request, principal }) => {
    const body = await readJson<{ assistant?: string; threadId?: string; metadata?: Record<string, unknown> }>(request);
    if (!body.assistant) throw new BadRequestError('A thread needs an "assistant"');
    const thread = await runs.createThread({ ...body, assistant: body.assistant, principal });
    return json(thread, 201);
  });
  read('GET', '/threads', async ({ principal, url }) =>
    json({ threads: await runs.threads(principal, numberParam(url, 'limit')) }),
  );
  read('GET', '/threads/:threadId', async ({ params, principal }) =>
    json(await runs.thread(params.threadId as string, principal)),
  );
  read('GET', '/threads/:threadId/state', async ({ params, principal }) =>
    json({ threadId: params.threadId, state: await runs.threadState(params.threadId as string, principal) }),
  );
  read('GET', '/threads/:threadId/runs', async ({ params, principal, url }) =>
    json({
      runs: await runs.runs(principal, { threadId: params.threadId as string, limit: numberParam(url, 'limit') }),
    }),
  );
  write('DELETE', '/threads/:threadId', async ({ params, principal }) => {
    await runs.deleteThread(params.threadId as string, principal);
    return new Response(null, { status: 204 });
  });

  write('POST', '/threads/:threadId/runs', async ({ request, params, principal, url }) => {
    const body = await readJson<RunBody>(request);
    const thread = await runs.thread(params.threadId as string, principal);
    const run = await runs.start({
      assistant: body.assistant ?? thread.assistant,
      input: body.input,
      resume: body.resume,
      threadId: thread.id,
      principal,
      idempotencyKey: body.idempotencyKey,
      metadata: body.metadata,
      onBusy: body.onBusy,
    });
    return body.stream || url.searchParams.get('stream') === 'true' ? streamRun(run.id) : json(run, 202);
  });
  write('POST', '/runs', async ({ request, principal, url }) => {
    const body = await readJson<RunBody>(request);
    if (!body.assistant) throw new BadRequestError('A run needs an "assistant"');
    if (body.resume !== undefined) throw new BadRequestError('A resume needs a thread: post it to /threads/:id/runs');
    const run = await runs.start({
      assistant: body.assistant,
      input: body.input,
      principal,
      idempotencyKey: body.idempotencyKey,
      metadata: body.metadata,
    });
    return body.stream || url.searchParams.get('stream') === 'true' ? streamRun(run.id) : json(run, 202);
  });
  read('GET', '/runs', async ({ principal, url }) =>
    json({ runs: await runs.runs(principal, { limit: numberParam(url, 'limit') }) }),
  );
  read('GET', '/runs/:runId', async ({ params, principal }) => json(await runs.run(params.runId as string, principal)));
  write('POST', '/runs/:runId/cancel', async ({ request, params, principal }) => {
    const body = await readJson<{ reason?: string }>(request);
    return json(await runs.cancel(params.runId as string, principal, body.reason));
  });
  read('GET', '/runs/:runId/events', async ({ request, params, principal, url }) => {
    await runs.run(params.runId as string, principal);
    const header = request.headers.get('last-event-id') ?? url.searchParams.get('lastEventId');
    const after = header ? Number(header) : 0;
    return streamRun(params.runId as string, Number.isFinite(after) ? after : 0, request.signal);
  });

  write('POST', '/crons', async ({ request, principal }) => {
    if (!scheduler) throw new BadRequestError('Cron jobs are not enabled on this server', 'CRON_DISABLED');
    const body = await readJson<Omit<CronRecord, 'id' | 'createdAt'> & { id?: string }>(request);
    if (!body.assistant) throw new BadRequestError('A cron job needs an "assistant"');
    if (!body.schedule) throw new BadRequestError('A cron job needs a "schedule"');
    runs.assistant(body.assistant);
    return json(await scheduler.add({ ...body, tenantId: principal?.tenantId }), 201);
  });
  read('GET', '/crons', async ({ principal }) => {
    if (!scheduler) throw new BadRequestError('Cron jobs are not enabled on this server', 'CRON_DISABLED');
    const jobs = await scheduler.list();
    return json({ crons: jobs.filter((job) => (job.tenantId ?? undefined) === (principal?.tenantId ?? undefined)) });
  });
  write('DELETE', '/crons/:cronId', async ({ params, principal }) => {
    if (!scheduler) throw new BadRequestError('Cron jobs are not enabled on this server', 'CRON_DISABLED');
    const job = await scheduler.get(params.cronId as string);
    if (!job || (job.tenantId ?? undefined) !== (principal?.tenantId ?? undefined)) {
      throw new NotFoundError('Cron job', params.cronId as string);
    }
    await scheduler.remove(job.id);
    return new Response(null, { status: 204 });
  });

  /** An event stream for a run: what it missed, then what happens next, ending when the run does. */
  function streamRun(runId: string, after = 0, signal?: AbortSignal): Response {
    const log = runs.eventLog;
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    const encoder = new TextEncoder();
    let cursor = after;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (text: string): void => {
          if (!closed) controller.enqueue(encoder.encode(text));
        };
        const finish = (): void => {
          if (closed) return;
          closed = true;
          controller.close();
        };
        signal?.addEventListener('abort', finish, { once: true });

        try {
          while (!closed && !signal?.aborted) {
            const events = (await log.read(runId, { after: cursor })) as RunEvent[];
            for (const event of events) {
              cursor = event.id;
              send(formatSse({ id: event.id, event: event.type, data: event }));
              if (isTerminal(event)) {
                finish();
                return;
              }
            }
            if (events.length > 0) continue;
            const run = await runs.run(runId).catch(() => undefined);
            if (run && isFinishedStatus(run.status) && (await log.read(runId, { after: cursor })).length === 0) {
              // The run finished before this reader attached, or its terminal event was trimmed.
              send(formatSse({ event: 'status', data: { runId, status: run.status, output: run.output } }));
              finish();
              return;
            }
            send(': keep-alive\n\n');
            await log.wait?.(runId, cursor, { signal, timeoutMs: heartbeatMs });
            if (!log.wait) await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (error) {
          send(
            formatSse({ event: 'error', data: { message: error instanceof Error ? error.message : String(error) } }),
          );
        } finally {
          finish();
        }
      },
      cancel() {
        closed = true;
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  }

  async function handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const pathname =
        basePath && url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) : url.pathname;
      const match = routes.match(request.method, pathname || '/');
      if (!match) throw new NotFoundError('Route', `${request.method} ${url.pathname}`);
      if (match === 'method-not-allowed') {
        return json({ error: { code: 'METHOD_NOT_ALLOWED', message: `${request.method} is not allowed here` } }, 405);
      }

      let principal: Principal | undefined;
      if (options.authenticate) {
        const result = await options.authenticate(request);
        if (result instanceof Response) return result;
        if (!result) throw new UnauthorizedError();
        principal = result;
      } else if (options.allowAnonymous === false) {
        throw new UnauthorizedError('This server requires an authenticate hook');
      }

      const required = options.scopes?.[match.handler.scope];
      if (required && !principal?.scopes?.includes(required)) throw new ForbiddenError(required);

      return await match.handler.handler({ request, params: match.params, principal, url });
    } catch (error) {
      return errorResponse(error);
    }
  }

  return {
    handle,
    runs,
    cron: scheduler,
    async start() {
      await runs.recover().catch(() => undefined);
      for (const job of options.cron?.jobs ?? []) await scheduler?.add(job);
      scheduler?.start();
    },
    async stop() {
      scheduler?.stop();
    },
  };
}

interface RunBody {
  assistant?: string;
  input?: unknown;
  resume?: unknown;
  stream?: boolean;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  onBusy?: ThreadBusyPolicy;
}

function numberParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new ServerError(`"${name}" must be a number`, 'BAD_REQUEST', 400);
  return parsed;
}

function isFinishedStatus(status: RunRecord['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'expired';
}

/** A status event that reports a finished run is the last event a stream sends. */
function isTerminal(event: RunEvent): boolean {
  if (event.type !== 'status') return false;
  const status = (event.data as { status?: RunRecord['status'] } | undefined)?.status;
  return status !== undefined && (status === 'awaiting_input' || isFinishedStatus(status));
}

export type { ThreadRecord, RunRecord, ServerStateStore };
