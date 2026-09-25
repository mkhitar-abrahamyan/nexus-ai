import { readFile } from 'node:fs/promises';
import { compareExperiments, formatComparison } from 'nexus-ai-pro/evaluate';
import { toMermaid } from 'nexus-ai-pro/graph/visualize';
import { compareTraces, formatTree, type Run, type RunQuery } from 'nexus-ai-pro/tracing';
import { layoutGraph } from './layout.js';
import {
  createToken,
  hostAllowed,
  SESSION_COOKIE,
  sessionCookie,
  TOKEN_HEADER,
  tokenOf,
  tokensMatch,
} from './security.js';
import type {
  StudioCheckpoint,
  StudioCostReport,
  StudioGraphLike,
  StudioGraphSource,
  StudioOptions,
  StudioSources,
} from './types.js';

/** The studio: one request handler, and the token it accepts. */
export interface Studio {
  /** Answers one request: the page, its script and styles, and the JSON API behind them. */
  handle(request: Request): Promise<Response>;
  /** The access token. The URL to open is `http://127.0.0.1:<port>/?token=<token>`. */
  readonly token: string;
}

/** An error with the HTTP status the studio answers with. */
export class StudioError extends Error {
  constructor(
    message: string,
    /** Stable code sent in the error body. */
    public readonly code: string,
    /** HTTP status. */
    public readonly status: number,
    /** Extra detail sent with the error, such as each promotion gate's verdict. */
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'StudioError';
  }
}

type Context = { request: Request; url: URL; params: Record<string, string> };
type Handler = (context: Context) => Promise<unknown>;

const UI_FILES: Record<string, string> = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
};
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};
const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/**
 * Creates the studio's request handler.
 *
 * Every view is a read of a source the application already has, through the adapter it already uses;
 * nothing is copied into a studio database, and nothing leaves the machine. Changes — answering an
 * interrupt, submitting a review, promoting a prompt — go through the same APIs the application
 * calls, so the studio can do nothing the application could not.
 */
export function createStudio(sources: StudioSources, options: StudioOptions = {}): Studio {
  const token = options.token ?? createToken();
  const actor = options.actor ?? 'studio';
  const now = options.now ?? (() => new Date());
  const uiDirectory = new URL('./ui/', import.meta.url);
  const uiCache = new Map<string, string>();
  const routes: Array<{ method: string; parts: string[]; handler: Handler }> = [];
  const route = (method: string, path: string, handler: Handler) =>
    routes.push({ method, parts: path.split('/').filter(Boolean), handler });

  // ── Session ──────────────────────────────────────────────────────
  // The page's own script reads the token here to send it on changes. The session cookie is HTTP-only
  // and same-site, so another site can neither send it nor read this response.
  route('GET', '/api/session', async () => ({ token, actor }));

  // ── Overview ─────────────────────────────────────────────────────
  route('GET', '/api/overview', async () => ({
    actor,
    sources: {
      traces: Boolean(sources.traces),
      graphs: Object.keys(sources.graphs ?? {}),
      reviews: Object.keys(sources.reviews ?? {}),
      datasets: Boolean(sources.datasets),
      experiments: Boolean(sources.experiments),
      prompts: Boolean(sources.prompts),
      playground: Boolean(sources.prompts && sources.client?.complete),
      health: Boolean(
        sources.circuits ||
          sources.client?.getProviderHealth ||
          sources.client?.getCircuitBreakerStatus ||
          sources.client?.getMetricsSnapshot,
      ),
      costs: Boolean(sources.traces),
      operations: typeof sources.operations?.list === 'function',
      assets: Boolean(sources.assets),
    },
  }));

  // ── Traces ───────────────────────────────────────────────────────
  route('GET', '/api/traces', async ({ url }) => {
    const store = need(sources.traces, 'traces');
    const limit = intParam(url, 'limit') ?? 50;
    const all = url.searchParams.get('roots') === 'false';
    const query: RunQuery = { ...queryFrom(url), limit: all ? limit : limit * 10 };
    const runs = await store.query(query);
    const shown = (all ? runs : runs.filter((run) => !run.parentId)).slice(0, limit);
    return { runs: shown.map(summarizeRun) };
  });
  route('GET', '/api/traces/:traceId', async ({ params }) => {
    const tree = await need(sources.traces, 'traces').tree(params.traceId as string);
    if (!tree) throw notFound('Trace', params.traceId as string);
    return { tree, text: formatTree(tree) };
  });
  route('GET', '/api/compare/traces', async ({ url }) => {
    const store = need(sources.traces, 'traces');
    const [left, right] = await Promise.all([store.tree(required(url, 'left')), store.tree(required(url, 'right'))]);
    if (!left) throw notFound('Trace', required(url, 'left'));
    if (!right) throw notFound('Trace', required(url, 'right'));
    return { comparison: compareTraces(left, right) };
  });
  route('POST', '/api/runs/:runId/feedback', async ({ request, params }) => {
    const store = need(sources.traces, 'traces');
    if (!store.addFeedback) throw new StudioError('This trace store cannot record feedback', 'UNSUPPORTED', 409);
    const body = await readJson<{ key?: string; score?: number; comment?: string }>(request);
    if (!body.key || typeof body.score !== 'number') throw badRequest('Feedback needs a "key" and a numeric "score"');
    await store.addFeedback(
      params.runId as string,
      {
        key: body.key,
        score: body.score,
        ...(body.comment ? { comment: body.comment } : {}),
        source: actor,
        createdAt: now().toISOString(),
      } as never,
    );
    return { ok: true };
  });

  // ── Threads ──────────────────────────────────────────────────────
  route('GET', '/api/graphs', async () => ({
    graphs: Object.entries(sources.graphs ?? {}).map(([name, source]) => {
      const { graph } = graphSource(source);
      const description = graph.describe();
      return {
        name,
        description,
        layout: layoutGraph(graph),
        mermaid: toMermaid(description as never),
        supports: {
          fork: typeof graph.fork === 'function',
          edit: typeof graph.updateState === 'function',
          resume: typeof graph.resumeWith === 'function' || typeof graph.resumeInterruptsWith === 'function',
        },
      };
    }),
  }));
  route('GET', '/api/graphs/:graph/threads', async ({ params }) => {
    const source = graphNamed(params.graph as string);
    const ids = await threadIdsOf(source);
    const threads = await Promise.all(
      ids.slice(0, 200).map(async (threadId) => {
        const checkpoint = await source.graph.state(threadId);
        return checkpoint ? summarizeCheckpoint(checkpoint) : { threadId, status: 'unknown' };
      }),
    );
    return { threads, listed: ids.length > 0 || Boolean(source.threads || source.checkpointer?.threadIds) };
  });
  route('GET', '/api/graphs/:graph/threads/:threadId', async ({ params }) => {
    const { graph } = graphNamed(params.graph as string);
    const checkpoint = await graph.state(params.threadId as string);
    if (!checkpoint) throw notFound('Thread', params.threadId as string);
    const history = await graph.history(params.threadId as string, 50);
    return { checkpoint, history: history.map(summarizeCheckpoint), highlight: checkpoint.next };
  });
  route('GET', '/api/graphs/:graph/threads/:threadId/steps/:step', async ({ params }) => {
    const { graph } = graphNamed(params.graph as string);
    const checkpoint = await graph.state(params.threadId as string, Number(params.step));
    if (!checkpoint) throw notFound('Step', `${params.threadId}@${params.step}`);
    return { checkpoint };
  });
  route('POST', '/api/graphs/:graph/threads/:threadId/fork', async ({ request, params }) => {
    const { graph } = graphNamed(params.graph as string);
    if (!graph.fork) throw new StudioError('This graph cannot fork threads', 'UNSUPPORTED', 409);
    const body = await readJson<{ step?: number; threadId?: string }>(request);
    return { threadId: await graph.fork(params.threadId as string, body) };
  });
  route('POST', '/api/graphs/:graph/threads/:threadId/state', async ({ request, params }) => {
    const { graph } = graphNamed(params.graph as string);
    if (!graph.updateState) throw new StudioError('This graph cannot edit state', 'UNSUPPORTED', 409);
    const body = await readJson<{ values?: Record<string, unknown>; asNode?: string }>(request);
    if (!body.values || typeof body.values !== 'object') throw badRequest('An edit needs "values"');
    return {
      checkpoint: await graph.updateState(
        params.threadId as string,
        body.values,
        body.asNode ? { asNode: body.asNode } : {},
      ),
    };
  });
  route('POST', '/api/graphs/:graph/threads/:threadId/resume', async ({ request, params }) => {
    const { graph } = graphNamed(params.graph as string);
    const body = await readJson<{ value?: unknown; answers?: Record<string, unknown> }>(request);
    if (body.answers) {
      if (!graph.resumeInterruptsWith)
        throw new StudioError('This graph cannot answer interrupts by id', 'UNSUPPORTED', 409);
      return { result: await graph.resumeInterruptsWith(params.threadId as string, body.answers) };
    }
    if (!graph.resumeWith) throw new StudioError('This graph cannot be resumed', 'UNSUPPORTED', 409);
    return { result: await graph.resumeWith(params.threadId as string, body.value) };
  });

  // ── Inbox ────────────────────────────────────────────────────────
  route('GET', '/api/inbox', async () => {
    const interrupts: Array<Record<string, unknown>> = [];
    for (const [name, raw] of Object.entries(sources.graphs ?? {})) {
      const source = graphSource(raw);
      for (const threadId of (await threadIdsOf(source)).slice(0, 500)) {
        const checkpoint = await source.graph.state(threadId);
        const pending = checkpoint?.interrupts ?? (checkpoint?.interrupt ? [checkpoint.interrupt] : []);
        if (checkpoint && checkpoint.status === 'awaiting_input' && pending.length > 0) {
          interrupts.push({
            graph: name,
            threadId,
            step: checkpoint.step,
            interrupts: pending,
            createdAt: checkpoint.createdAt,
          });
        }
      }
    }
    const reviews = Object.entries(sources.reviews ?? {}).map(([queue, source]) => ({
      queue,
      items: [...source.list('pending'), ...source.list('claimed')],
    }));
    return { interrupts, reviews };
  });
  route('POST', '/api/reviews/:queue/claim', async ({ request, params }) => {
    const queue = reviewNamed(params.queue as string);
    const body = await readJson<{ reviewer?: string }>(request);
    const item = queue.claim(body.reviewer ?? actor);
    return { item: item ?? null };
  });
  route('POST', '/api/reviews/:queue/items/:itemId', async ({ request, params }) => {
    const queue = reviewNamed(params.queue as string);
    const body = await readJson<{
      reviewer?: string;
      scores?: Array<{ key: string; score: number; comment?: string }>;
      note?: string;
    }>(request);
    if (!Array.isArray(body.scores) || body.scores.length === 0) throw badRequest('A review needs "scores"');
    return {
      item: queue.submit(params.itemId as string, {
        reviewer: body.reviewer ?? actor,
        scores: body.scores,
        ...(body.note ? { note: body.note } : {}),
      }),
    };
  });

  // ── Datasets and experiments ─────────────────────────────────────
  route('GET', '/api/datasets', async () => ({ datasets: await need(sources.datasets, 'datasets').list() }));
  route('GET', '/api/datasets/:name', async ({ params, url }) => {
    const dataset = await need(sources.datasets, 'datasets').get(
      params.name as string,
      url.searchParams.get('version') ?? undefined,
    );
    if (!dataset) throw notFound('Dataset', params.name as string);
    return { dataset };
  });
  route('GET', '/api/experiments', async ({ url }) => {
    const experiments = await need(sources.experiments, 'experiments').list({
      ...(url.searchParams.get('name') ? { name: url.searchParams.get('name') as string } : {}),
      ...(url.searchParams.get('dataset') ? { dataset: url.searchParams.get('dataset') as string } : {}),
      limit: intParam(url, 'limit') ?? 50,
    });
    return {
      experiments: experiments.map((experiment) => ({
        id: experiment.id,
        name: experiment.name,
        dataset: experiment.dataset,
        startedAt: experiment.startedAt,
        finishedAt: experiment.finishedAt,
        errors: experiment.errors,
        examples: new Set(experiment.results.map((result) => result.exampleId)).size,
        metrics: experiment.metrics.map((metric) => ({ key: metric.key, mean: metric.mean, n: metric.n })),
        metadata: experiment.metadata,
      })),
    };
  });
  route('GET', '/api/experiments/:id', async ({ params }) => {
    const experiment = await need(sources.experiments, 'experiments').get(params.id as string);
    if (!experiment) throw notFound('Experiment', params.id as string);
    return { experiment };
  });
  route('GET', '/api/compare/experiments', async ({ url }) => {
    const store = need(sources.experiments, 'experiments');
    const [baseline, candidate] = await Promise.all([
      store.get(required(url, 'baseline')),
      store.get(required(url, 'candidate')),
    ]);
    if (!baseline) throw notFound('Experiment', required(url, 'baseline'));
    if (!candidate) throw notFound('Experiment', required(url, 'candidate'));
    const comparison = compareExperiments(baseline, candidate);
    return { comparison, text: formatComparison(comparison) };
  });

  // ── Prompts ──────────────────────────────────────────────────────
  route('GET', '/api/prompts', async () => {
    const registry = need(sources.prompts, 'prompts');
    const names = await registry.names();
    return { prompts: await Promise.all(names.map(async (name) => ({ name, labels: await registry.labels(name) }))) };
  });
  route('GET', '/api/prompts/:name', async ({ params }) => {
    const registry = need(sources.prompts, 'prompts');
    const name = params.name as string;
    const [versions, labels, history] = await Promise.all([
      registry.versions(name, { limit: 50 }),
      registry.labels(name),
      registry.history(name, { limit: 100 }),
    ]);
    return { name, versions, labels, history };
  });
  route('GET', '/api/prompts/:name/diff', async ({ params, url }) => ({
    diff: await need(sources.prompts, 'prompts').diff(
      params.name as string,
      required(url, 'from'),
      required(url, 'to'),
    ),
  }));
  route('POST', '/api/prompts/:name/promote', async ({ request, params }) => {
    const body = await readJson<{ to?: string; from?: string; version?: string; force?: boolean; note?: string }>(
      request,
    );
    if (!body.to) throw badRequest('A promotion needs "to"');
    return {
      result: await need(sources.prompts, 'prompts').promote(params.name as string, {
        to: body.to,
        ...(body.from ? { from: body.from } : {}),
        ...(body.version ? { version: body.version } : {}),
        ...(body.force ? { force: true } : {}),
        ...(body.note ? { note: body.note } : {}),
        by: actor,
      }),
    };
  });
  route('POST', '/api/prompts/:name/rollback', async ({ request, params }) => {
    const body = await readJson<{ label?: string; note?: string }>(request);
    if (!body.label) throw badRequest('A rollback needs "label"');
    return {
      label: await need(sources.prompts, 'prompts').rollback(params.name as string, body.label, {
        by: actor,
        ...(body.note ? { note: body.note } : {}),
      }),
    };
  });
  route('POST', '/api/prompts/:name/playground', async ({ request, params }) => {
    const registry = need(sources.prompts, 'prompts');
    const body = await readJson<{ ref?: string; variables?: Record<string, unknown>; model?: string; run?: boolean }>(
      request,
    );
    const rendered = await registry.render(params.name as string, body.variables ?? {}, {
      ...(body.ref ? { ref: body.ref } : {}),
      ...(body.model ? { overrides: { model: body.model } } : {}),
    });
    if (body.run === false || !sources.client?.complete) return { request: rendered, response: null };
    const started = Date.now();
    const response = await sources.client.complete(rendered);
    return { request: rendered, response, latencyMs: Date.now() - started };
  });

  // ── Costs ────────────────────────────────────────────────────────
  route('GET', '/api/costs', async ({ url }) => costReport(intParam(url, 'days') ?? 7));

  // ── Health ───────────────────────────────────────────────────────
  route('GET', '/api/health', async () => ({
    providers: sources.client?.getProviderHealth?.() ?? null,
    circuits: sources.client?.getCircuitBreakerStatus?.() ?? null,
    shared: sources.circuits ? await sources.circuits.read() : null,
    metrics: sources.client?.getMetricsSnapshot?.() ?? null,
    cache: sources.client?.getCacheStats?.() ?? null,
  }));

  // ── Operations and assets ────────────────────────────────────────
  route('GET', '/api/operations', async ({ url }) => {
    const store = sources.operations;
    if (!store?.list) throw notConfigured('operations');
    const status = url.searchParams.get('status');
    const all = url.searchParams.get('all') === 'true';
    const records = ((await store.list()) as unknown as Array<Record<string, unknown>>)
      // Graph checkpoints live in the same store when a graph is durable; they are not queue work.
      .filter((record) => all || record.kind !== 'graph.checkpoint')
      .filter((record) => !status || record.status === status)
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
      .slice(0, intParam(url, 'limit') ?? 100);
    const counts: Record<string, number> = {};
    for (const record of records) counts[String(record.status)] = (counts[String(record.status)] ?? 0) + 1;
    return { operations: records.map(({ result: _result, ...rest }) => rest), counts };
  });
  route('GET', '/api/assets', async () => {
    const store = sources.assets;
    if (!store) throw notConfigured('assets');
    return { snapshot: store.snapshot?.() ?? null, assets: store.list ? await store.list() : null };
  });

  // ── Helpers ──────────────────────────────────────────────────────
  function graphSource(raw: StudioGraphSource | StudioGraphLike): StudioGraphSource {
    return 'graph' in raw && typeof (raw as StudioGraphSource).graph?.describe === 'function'
      ? (raw as StudioGraphSource)
      : { graph: raw as StudioGraphLike };
  }
  function graphNamed(name: string): StudioGraphSource {
    const raw = sources.graphs?.[name];
    if (!raw) throw notFound('Graph', name);
    return graphSource(raw);
  }
  function reviewNamed(name: string) {
    const queue = sources.reviews?.[name];
    if (!queue) throw notFound('Review queue', name);
    return queue;
  }
  async function threadIdsOf(source: StudioGraphSource): Promise<string[]> {
    if (source.threads) return [...(await source.threads())];
    if (source.checkpointer?.threadIds) return [...(await source.checkpointer.threadIds())];
    return [];
  }

  async function costReport(days: number): Promise<StudioCostReport> {
    const store = need(sources.traces, 'traces');
    const end = now();
    const since = new Date(end.getTime() - days * 86_400_000).toISOString();
    const runs = counted(await store.query({ since, limit: 100_000 }));

    const byDay = new Map<string, { cost: number; runs: number }>();
    const byModel = new Map<string, { cost: number; runs: number }>();
    for (const run of runs) {
      const day = run.startedAt.slice(0, 10);
      const dayEntry = byDay.get(day) ?? { cost: 0, runs: 0 };
      dayEntry.cost += run.cost ?? 0;
      dayEntry.runs += 1;
      byDay.set(day, dayEntry);
      const model = run.model ?? 'unknown';
      const modelEntry = byModel.get(model) ?? { cost: 0, runs: 0 };
      modelEntry.cost += run.cost ?? 0;
      modelEntry.runs += 1;
      byModel.set(model, modelEntry);
    }

    const budgets = [];
    for (const budget of sources.budgets ?? []) {
      const start = periodStart(end, budget.period).toISOString();
      const matching = counted(await store.query({ ...budget.filter, since: start, limit: 100_000 }));
      const spent = matching.reduce((total, run) => total + (run.cost ?? 0), 0);
      budgets.push({ ...budget, spent, remaining: Math.max(0, budget.limit - spent), exceeded: spent > budget.limit });
    }

    return {
      days,
      total: runs.reduce((total, run) => total + (run.cost ?? 0), 0),
      byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([day, entry]) => ({ day, ...entry })),
      byModel: [...byModel.entries()]
        .sort((a, b) => b[1].cost - a[1].cost)
        .map(([model, entry]) => ({ model, ...entry })),
      top: [...runs]
        .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
        .slice(0, 10)
        .map((run) => ({ id: run.id, traceId: run.traceId, name: run.name, model: run.model, cost: run.cost ?? 0 })),
      budgets,
    };
  }

  async function serveUi(path: string): Promise<Response> {
    const file = UI_FILES[path] as string;
    let body = uiCache.get(file);
    if (body === undefined) {
      body = await readFile(new URL(file, uiDirectory), 'utf8');
      uiCache.set(file, body);
    }
    const extension = file.split('.').pop() as string;
    return new Response(body, { headers: { 'content-type': CONTENT_TYPES[extension] as string, ...SECURITY_HEADERS } });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!hostAllowed(request.headers.get('host') ?? url.host, options.allowedHosts)) {
      return text('This host is not allowed. Open the studio at 127.0.0.1 or localhost.', 403);
    }

    const presented = tokenOf(request, url);
    const valid = tokensMatch(token, presented.token);

    if (url.pathname in UI_FILES) {
      if (!valid) return text('Open the link the studio printed when it started: it carries the access token.', 401);
      // The token arrives once, in the URL; it is moved into a cookie and taken out of the address bar.
      if (presented.via === 'query') {
        return new Response(null, {
          status: 303,
          headers: { location: url.pathname, 'set-cookie': sessionCookie(token), ...SECURITY_HEADERS },
        });
      }
      return serveUi(url.pathname);
    }

    if (!url.pathname.startsWith('/api/')) return json({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404);
    if (!valid) return json({ error: { code: 'UNAUTHORIZED', message: 'A valid studio token is required' } }, 401);
    // A change must carry the token in a header, which a page on another site cannot set.
    if (request.method !== 'GET' && presented.via !== 'header') {
      return json({ error: { code: 'FORBIDDEN', message: `Changes need the ${TOKEN_HEADER} header` } }, 403);
    }

    const parts = url.pathname.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const candidate of routes) {
      if (candidate.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const matched = candidate.parts.every((part, index) => {
        if (part.startsWith(':')) {
          params[part.slice(1)] = decodeURIComponent(parts[index] as string);
          return true;
        }
        return part === parts[index];
      });
      if (!matched) continue;
      if (candidate.method !== request.method) {
        methodMismatch = true;
        continue;
      }
      try {
        return json(await candidate.handler({ request, url, params }));
      } catch (error) {
        return errorResponse(error);
      }
    }
    return methodMismatch
      ? json({ error: { code: 'METHOD_NOT_ALLOWED', message: `${request.method} is not allowed here` } }, 405)
      : json({ error: { code: 'NOT_FOUND', message: `No route for ${url.pathname}` } }, 404);
  }

  return { handle, token };
}

/** Model runs carry cost; counting them alone keeps a parent that sums its children from counting twice. */
function counted(runs: Run[]): Run[] {
  const models = runs.filter((run) => run.kind === 'model' && run.cost !== undefined);
  return models.length > 0 ? models : runs.filter((run) => run.cost !== undefined);
}

function periodStart(at: Date, period: 'day' | 'week' | 'month'): Date {
  if (period === 'day') return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  if (period === 'month') return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  return new Date(at.getTime() - 7 * 86_400_000);
}

function summarizeRun(run: Run) {
  return {
    id: run.id,
    traceId: run.traceId,
    name: run.name,
    kind: run.kind,
    status: run.status,
    startedAt: run.startedAt,
    latencyMs: run.latencyMs,
    cost: run.cost,
    model: run.model,
    provider: run.provider,
    tags: run.tags,
    feedback: run.feedback?.length ?? 0,
    error: run.error?.message,
  };
}

function summarizeCheckpoint(checkpoint: StudioCheckpoint) {
  const pending = checkpoint.interrupts ?? (checkpoint.interrupt ? [checkpoint.interrupt] : []);
  return {
    threadId: checkpoint.threadId,
    step: checkpoint.step,
    status: checkpoint.status,
    next: checkpoint.next,
    interrupts: pending.length,
    createdAt: checkpoint.createdAt,
  };
}

function queryFrom(url: URL): RunQuery {
  const query: RunQuery = {};
  const get = (name: string) => url.searchParams.get(name) || undefined;
  if (get('traceId')) query.traceId = get('traceId');
  if (get('status')) query.status = get('status') as RunQuery['status'];
  if (get('kind')) query.kind = get('kind') as RunQuery['kind'];
  if (get('name')) query.name = get('name');
  if (get('model')) query.model = get('model');
  if (get('provider')) query.provider = get('provider');
  if (get('tag')) query.tags = [get('tag') as string];
  if (get('since')) query.since = get('since');
  if (get('until')) query.until = get('until');
  return query;
}

function need<T>(source: T | undefined, name: string): T {
  if (!source) throw notConfigured(name);
  return source;
}

function notConfigured(name: string): StudioError {
  return new StudioError(`The studio was started without "${name}"`, 'SOURCE_NOT_CONFIGURED', 404);
}

function notFound(what: string, id: string): StudioError {
  return new StudioError(`${what} "${id}" was not found`, 'NOT_FOUND', 404);
}

function badRequest(message: string): StudioError {
  return new StudioError(message, 'BAD_REQUEST', 400);
}

function required(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw badRequest(`"${name}" is required`);
  return value;
}

function intParam(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw badRequest(`"${name}" must be a positive whole number`);
  return parsed;
}

async function readJson<T>(request: Request): Promise<T> {
  const body = await request.text();
  if (!body.trim()) return {} as T;
  try {
    return JSON.parse(body) as T;
  } catch {
    throw badRequest('The request body is not valid JSON');
  }
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS },
  });
}

function text(value: string, status: number): Response {
  return new Response(value, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });
}

/** Errors from the sources keep their meaning: a refused promotion is a conflict, a missing prompt is a 404. */
function errorResponse(error: unknown): Response {
  if (error instanceof StudioError) {
    return json({ error: { code: error.code, message: error.message, detail: error.detail } }, error.status);
  }
  const record = error as { name?: string; code?: string; message?: string; results?: unknown } | undefined;
  const message = record?.message ?? String(error);
  if (record?.code === 'PROMPT_PROMOTION_REFUSED' || record?.name === 'PromptPromotionError') {
    return json({ error: { code: 'PROMOTION_REFUSED', message, detail: record.results } }, 409);
  }
  if (record?.code === 'PROMPT_CONFLICT') return json({ error: { code: 'CONFLICT', message } }, 409);
  if (record?.code === 'PROMPT_NOT_FOUND' || record?.name?.endsWith('NotFoundError')) {
    return json({ error: { code: 'NOT_FOUND', message } }, 404);
  }
  if (record?.name === 'GraphNotInterruptedError') return json({ error: { code: 'NOT_INTERRUPTED', message } }, 409);
  return json({ error: { code: 'INTERNAL', message } }, 500);
}

export { SESSION_COOKIE, TOKEN_HEADER };
