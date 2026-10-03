import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createGraph, END, lastValue } from 'nexus-ai-pro/graph';
import { createStudio, type Studio } from '../src/api.js';
import { loadSources, parseArgs } from '../src/cli.js';
import { layoutGraph } from '../src/layout.js';
import { createToken, hostAllowed, tokensMatch } from '../src/security.js';
import { startStudio } from '../src/server.js';
import { createDemoSources } from '../example/demo.js';

const ORIGIN = 'http://127.0.0.1:4747';
let demo: Awaited<ReturnType<typeof createDemoSources>>;
let studio: Studio;

before(async () => {
  demo = await createDemoSources();
  studio = createStudio(demo, { token: 'test-token', actor: 'tester' });
});

function get(path: string, headers: Record<string, string> = {}) {
  return studio.handle(new Request(`${ORIGIN}${path}`, { headers: { 'x-studio-token': 'test-token', ...headers } }));
}

function post(path: string, body: unknown) {
  return studio.handle(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'x-studio-token': 'test-token', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function json<T = Record<string, unknown>>(response: Response | Promise<Response>): Promise<T> {
  const resolved = await response;
  const body = (await resolved.json()) as T;
  if (!resolved.ok) throw new Error(`${resolved.status}: ${JSON.stringify(body)}`);
  return body;
}

// ── Access ─────────────────────────────────────────────────────────

test('the studio refuses other hosts, missing tokens, and changes without the header', async () => {
  const anonymous = (path: string, init: RequestInit = {}) => studio.handle(new Request(`${ORIGIN}${path}`, init));

  const rebound = await studio.handle(
    new Request('http://evil.example/api/overview', { headers: { 'x-studio-token': 'test-token' } }),
  );
  assert.equal(rebound.status, 403, 'a DNS-rebound host is refused even with the token');
  assert.equal((await anonymous('/api/overview')).status, 401);
  assert.equal((await anonymous('/')).status, 401);
  assert.equal((await anonymous('/api/overview', { headers: { 'x-studio-token': 'wrong' } })).status, 401);

  const entry = await anonymous('/?token=test-token');
  assert.equal(entry.status, 303, 'the token in the URL is exchanged for a cookie');
  assert.equal(entry.headers.get('location'), '/');
  const cookie = entry.headers.get('set-cookie') ?? '';
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const page = await anonymous('/', { headers: { cookie: cookie.split(';')[0] as string } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Nexus studio/);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);

  const script = await anonymous('/app.js', { headers: { cookie: cookie.split(';')[0] as string } });
  assert.match(script.headers.get('content-type') ?? '', /javascript/);

  const forged = await anonymous('/api/prompts/support-reply/rollback', {
    method: 'POST',
    headers: { cookie: cookie.split(';')[0] as string, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'production' }),
  });
  assert.equal(forged.status, 403, 'a change carried only by the cookie is refused, which is what stops CSRF');

  const session = await json<{ token: string; actor: string }>(
    anonymous('/api/session', { headers: { cookie: cookie.split(';')[0] as string } }),
  );
  assert.equal(session.token, 'test-token');
  assert.equal(session.actor, 'tester');
});

test('tokens and hosts are checked strictly', () => {
  assert.equal(createToken().length, 43);
  assert.notEqual(createToken(), createToken());
  assert.equal(tokensMatch('abc', 'abc'), true);
  assert.equal(tokensMatch('abc', 'abd'), false);
  assert.equal(tokensMatch('abc', 'ab'), false);
  assert.equal(tokensMatch('abc', undefined), false);
  assert.equal(hostAllowed('127.0.0.1:4747'), true);
  assert.equal(hostAllowed('localhost'), true);
  assert.equal(hostAllowed('[::1]:4747'), true);
  assert.equal(hostAllowed('studio.internal:4747'), false);
  assert.equal(hostAllowed('studio.internal:4747', ['studio.internal']), true);
  assert.equal(hostAllowed(null), false);
});

test('the overview reports which views have a source', async () => {
  const overview = await json<{ sources: Record<string, unknown> }>(get('/api/overview'));
  assert.equal(overview.sources.traces, true);
  assert.deepEqual(overview.sources.graphs, ['support']);
  assert.deepEqual(overview.sources.reviews, ['answers']);
  assert.equal(overview.sources.playground, true);
  assert.equal(overview.sources.operations, true);
  assert.equal(overview.sources.assets, false);

  const empty = createStudio({}, { token: 't' });
  const missing = await empty.handle(new Request(`${ORIGIN}/api/traces`, { headers: { 'x-studio-token': 't' } }));
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'SOURCE_NOT_CONFIGURED');
});

// ── The three proofs ───────────────────────────────────────────────

test('proof: a traced agent run appears with its model calls and their cost', async () => {
  const { runs } = await json<{ runs: Array<{ name: string; kind: string; traceId: string }> }>(get('/api/traces'));
  const agent = runs.find((run) => run.name === 'support-agent');
  assert.ok(agent, 'the agent run is listed');
  assert.equal(agent.kind, 'agent');

  const { tree, text } = await json<{ tree: { children: Array<{ kind: string; cost?: number }> }; text: string }>(
    get(`/api/traces/${agent.traceId}`),
  );
  assert.equal(tree.children.length, 2);
  assert.ok(tree.children.every((child) => child.kind === 'model' && child.cost === 0.00042));
  assert.match(text, /agent:support-agent/);
});

test('proof: an approval waits in the inbox, and answering it resumes the thread', async () => {
  const { interrupts } = await json<{
    interrupts: Array<{ graph: string; threadId: string; interrupts: Array<{ reason: string }> }>;
  }>(get('/api/inbox'));
  const waiting = interrupts.find((entry) => entry.threadId === demo.threadId);
  assert.ok(waiting, 'the paused thread is in the inbox');
  assert.equal(waiting.graph, 'support');
  assert.equal(waiting.interrupts[0]?.reason, 'Approve this refund?');

  const forked = await json<{ threadId: string }>(post(`/api/graphs/support/threads/${demo.threadId}/fork`, {}));
  await json(post(`/api/graphs/support/threads/${forked.threadId}/resume`, { value: true }));
  const after = await json<{ checkpoint: { status: string; state: { messages: string[]; approved: boolean } } }>(
    get(`/api/graphs/support/threads/${forked.threadId}`),
  );
  assert.equal(after.checkpoint.status, 'completed');
  assert.equal(after.checkpoint.state.approved, true);
  assert.equal(after.checkpoint.state.messages.at(-1), 'Refund sent');

  const still = await json<{ interrupts: Array<{ threadId: string }> }>(get('/api/inbox'));
  assert.ok(
    still.interrupts.some((entry) => entry.threadId === demo.threadId),
    'the original thread still waits: the fork was answered',
  );
  assert.ok(!still.interrupts.some((entry) => entry.threadId === forked.threadId));
});

test('proof: two experiments compare with a verdict', async () => {
  const [baseline, candidate] = demo.experimentIds;
  const { comparison, text } = await json<{
    comparison: { regressed: boolean; metrics: Array<{ key: string; verdict: string }> };
    text: string;
  }>(get(`/api/compare/experiments?baseline=${baseline}&candidate=${candidate}`));
  assert.equal(comparison.regressed, true);
  assert.equal(comparison.metrics.find((metric) => metric.key === 'exact-match')?.verdict, 'worse');
  assert.match(text, /candidate vs baseline/);

  const { experiments } = await json<{ experiments: Array<{ name: string; examples: number }> }>(
    get('/api/experiments'),
  );
  assert.deepEqual(experiments.map((experiment) => experiment.name).sort(), ['baseline', 'candidate']);
  assert.equal(experiments[0]?.examples, 3);
  const { datasets } = await json<{ datasets: Array<{ name: string }> }>(get('/api/datasets'));
  assert.deepEqual(
    datasets.map((dataset) => dataset.name),
    ['support-answers'],
  );
});

// ── Threads ────────────────────────────────────────────────────────

test('a graph is laid out, listed, and its threads can be read, forked, and edited', async () => {
  const { graphs } = await json<{
    graphs: Array<{
      name: string;
      mermaid: string;
      layout: { nodes: Array<{ id: string }> };
      supports: Record<string, boolean>;
    }>;
  }>(get('/api/graphs'));
  const support = graphs[0];
  assert.equal(support?.name, 'support');
  assert.match(support?.mermaid ?? '', /flowchart/);
  assert.deepEqual(
    support?.layout.nodes.map((node) => node.id),
    ['__start__', 'draft', 'approve', 'send', '__end__'],
  );
  assert.deepEqual(support?.supports, { fork: true, edit: true, resume: true });

  const { threads } = await json<{ threads: Array<{ threadId: string; status: string; interrupts: number }> }>(
    get('/api/graphs/support/threads'),
  );
  const refund = threads.find((thread) => thread.threadId === demo.threadId);
  assert.equal(refund?.status, 'awaiting_input');
  assert.equal(refund?.interrupts, 1);

  const detail = await json<{ history: Array<{ step: number }>; highlight: string[] }>(
    get(`/api/graphs/support/threads/${demo.threadId}`),
  );
  assert.ok(detail.history.length >= 2);
  assert.deepEqual(detail.highlight, ['approve']);
  const step = detail.history.at(-1)?.step as number;
  assert.ok(
    (await json<{ checkpoint: unknown }>(get(`/api/graphs/support/threads/${demo.threadId}/steps/${step}`))).checkpoint,
  );

  const copy = await json<{ threadId: string }>(post(`/api/graphs/support/threads/${demo.threadId}/fork`, {}));
  await json(post(`/api/graphs/support/threads/${copy.threadId}/state`, { values: { messages: ['edited by hand'] } }));
  const edited = await json<{ checkpoint: { state: { messages: string[] } } }>(
    get(`/api/graphs/support/threads/${copy.threadId}`),
  );
  assert.equal(edited.checkpoint.state.messages.at(-1), 'edited by hand');

  assert.equal((await get('/api/graphs/missing/threads')).status, 404);
  assert.equal((await get('/api/graphs/support/threads/no-such-thread')).status, 404);
});

test('a cycle is drawn as a back edge, and nothing disappears from the layout', () => {
  const graph = createGraph({ channels: { turns: lastValue<number>() } })
    .addNode('think', (context) => ({ turns: (context.state.turns ?? 0) + 1 }))
    .setEntry('think')
    .addConditionalEdges('think', (state) => ((state.turns ?? 0) >= 3 ? END : 'think'), { think: 'think', [END]: END })
    .compile();
  const layout = layoutGraph(graph);
  const ids = layout.nodes.map((node) => node.id);
  assert.equal(ids.at(-1), '__end__');

  // A compiled graph refuses unreachable nodes, but a description from elsewhere may have one.
  const loose = layoutGraph({
    describe: () => ({
      nodes: [{ id: 'a' }, { id: 'orphan' }],
      edges: [
        { from: '__start__', to: 'a' },
        { from: 'a', to: '__end__' },
      ],
      dynamic: [],
    }),
  });
  assert.ok(
    loose.nodes.some((node) => node.id === 'orphan'),
    'an unreachable node is still drawn',
  );
  assert.equal(loose.nodes.at(-1)?.id, '__end__');
  assert.ok(layout.edges.some((edge) => edge.from === 'think' && edge.to === 'think' && edge.back));
  const end = layout.nodes.find((node) => node.kind === 'end');
  assert.ok(
    layout.nodes.every((node) => node.y <= (end?.y ?? 0)),
    'the exit is at the bottom',
  );
});

// ── Reviews and feedback ───────────────────────────────────────────

test('a review is claimed and submitted, and feedback lands on a run', async () => {
  const { reviews } = await json<{ reviews: Array<{ queue: string; items: Array<{ id: string }> }> }>(
    get('/api/inbox'),
  );
  const item = reviews[0]?.items[0];
  assert.ok(item);
  const claimed = await json<{ item: { id: string; status: string } }>(
    post('/api/reviews/answers/claim', { reviewer: 'ada' }),
  );
  assert.equal(claimed.item.status, 'claimed');
  const submitted = await json<{ item: { status: string } }>(
    post(`/api/reviews/answers/items/${item.id}`, {
      reviewer: 'ada',
      scores: [
        { key: 'correct', score: 1 },
        { key: 'tone', score: 0.8 },
      ],
    }),
  );
  assert.equal(submitted.item.status, 'reviewed');
  assert.equal((await post(`/api/reviews/answers/items/${item.id}`, { scores: [] })).status, 400);

  const { runs } = await json<{ runs: Array<{ id: string; name: string }> }>(get('/api/traces'));
  const agent = runs.find((run) => run.name === 'support-agent') as { id: string };
  await json(post(`/api/runs/${agent.id}/feedback`, { key: 'helpful', score: 1, comment: 'good' }));
  const after = await json<{ runs: Array<{ id: string; feedback: number }> }>(get('/api/traces'));
  assert.equal(after.runs.find((run) => run.id === agent.id)?.feedback, 1);
});

// ── Prompts ────────────────────────────────────────────────────────

test('prompts are listed, diffed, promoted, rolled back, and run in the playground', async () => {
  const { prompts } = await json<{ prompts: Array<{ name: string; labels: Array<{ label: string }> }> }>(
    get('/api/prompts'),
  );
  assert.deepEqual(
    prompts[0]?.labels.map((label) => label.label),
    ['production', 'staging'],
  );

  const detail = await json<{ versions: Array<{ version: string }>; history: unknown[] }>(
    get('/api/prompts/support-reply'),
  );
  assert.equal(detail.versions.length, 2);
  const [newest, oldest] = detail.versions.map((version) => version.version) as [string, string];
  const { diff } = await json<{ diff: { changed: boolean; config: Array<{ key: string }> } }>(
    get(`/api/prompts/support-reply/diff?from=${oldest}&to=${newest}`),
  );
  assert.equal(diff.changed, true);
  assert.deepEqual(
    diff.config.map((change) => change.key),
    ['temperature'],
  );

  const promoted = await json<{ result: { label: { version: string; by: string } } }>(
    post('/api/prompts/support-reply/promote', { from: 'staging', to: 'production' }),
  );
  assert.equal(promoted.result.label.version, newest);
  assert.equal(promoted.result.label.by, 'tester', 'the studio records who acted');
  const rolled = await json<{ label: { version: string } }>(
    post('/api/prompts/support-reply/rollback', { label: 'production' }),
  );
  assert.equal(rolled.label.version, oldest);

  const played = await json<{ request: { messages: Array<{ content: string }> }; response: { content: string } }>(
    post('/api/prompts/support-reply/playground', { ref: 'staging', variables: { question: 'Where is my refund?' } }),
  );
  assert.equal(played.request.messages.at(-1)?.content, 'Answer: Where is my refund?');
  assert.equal(played.response.content, 'A refund of $40 is due.');
  const renderedOnly = await json<{ response: null }>(
    post('/api/prompts/support-reply/playground', { ref: 'staging', variables: { question: 'x' }, run: false }),
  );
  assert.equal(renderedOnly.response, null);
  assert.equal((await post('/api/prompts/support-reply/promote', {})).status, 400);
});

// ── Costs, health, operations ──────────────────────────────────────

test('costs count model runs once, by day and by model, against budgets', async () => {
  const report = await json<{
    total: number;
    byModel: Array<{ model: string; runs: number }>;
    budgets: Array<{ name: string; spent: number; exceeded: boolean }>;
  }>(get('/api/costs?days=7'));
  assert.ok(report.total >= 0.00084 - 1e-12, 'both model calls are counted');
  assert.equal(report.byModel[0]?.model, 'gpt-5.4-mini');
  assert.equal(report.budgets[0]?.name, 'support');
  assert.equal(report.budgets[0]?.exceeded, false);
  assert.equal((await get('/api/costs?days=0')).status, 400);
});

test('with rollups, the costs view answers over a million runs without reading them', async () => {
  // A month of hourly rows for three models, a million runs in all.
  const models = ['gpt-6-luna', 'claude-sonnet-5-5', 'gemini-3.8-flash'];
  const start = Date.parse('2026-09-04T00:00:00.000Z');
  const rows = Array.from({ length: 720 * 3 }, (_, index) => ({
    hour: new Date(start + Math.floor(index / 3) * 3_600_000).toISOString(),
    kind: 'model',
    name: '',
    model: models[index % 3] as string,
    provider: '',
    tenant: '',
    runs: index < 1_000_000 % 2_160 ? Math.ceil(1_000_000 / 2_160) : Math.floor(1_000_000 / 2_160),
    errors: 0,
    cost: 0.5,
  }));
  let traceReads = 0;
  const studio = createStudio(
    {
      rollups: {
        query: ({ since, until }) =>
          rows.filter((row) => (!since || row.hour >= since.slice(0, 13)) && (!until || row.hour <= until)),
      },
      traces: {
        save() {},
        get: () => undefined,
        tree: () => undefined,
        query: () => {
          traceReads += 1;
          return [];
        },
      },
      budgets: [{ name: 'monthly', limit: 2_000, period: 'month', filter: { model: 'gpt-6-luna' } }],
    },
    { token: 'test-token', now: () => new Date('2026-10-04T00:00:00.000Z') },
  );
  const started = performance.now();
  const response = await studio.handle(
    new Request(`${ORIGIN}/api/costs?days=30`, { headers: { 'x-studio-token': 'test-token' } }),
  );
  const elapsed = performance.now() - started;
  const report = await json<{
    total: number;
    byDay: Array<{ runs: number }>;
    byModel: Array<{ model: string; runs: number }>;
    budgets: Array<{ spent: number }>;
  }>(response);

  assert.equal(
    report.byDay.reduce((sum, day) => sum + day.runs, 0),
    1_000_000,
    'every one of the million runs is counted',
  );
  assert.equal(report.byModel.length, 3);
  assert.ok(Math.abs(report.total - 0.5 * 2_160) < 1e-6);
  assert.ok((report.budgets[0]?.spent ?? 0) > 0, 'a budget on a model reads the rows too');
  assert.equal(traceReads, 1, 'the traces are read once, for the costliest recent runs, not scanned');
  assert.ok(elapsed < 200, `answered in ${Math.round(elapsed)} ms`);
});

test('health and the operation queue report what the sources know', async () => {
  const health = await json<{ providers: Array<{ providerName: string }>; circuits: Array<{ state: string }> }>(
    get('/api/health'),
  );
  assert.equal(health.providers[0]?.providerName, 'openai');
  assert.equal(health.circuits[0]?.state, 'closed');

  const { operations, counts } = await json<{
    operations: Array<{ kind: string; result?: unknown }>;
    counts: Record<string, number>;
  }>(get('/api/operations'));
  assert.equal(counts.succeeded, 1);
  assert.equal(counts.failed, 1);
  assert.ok(
    operations.every((operation) => operation.result === undefined),
    'results are left out of the list',
  );
  const failed = await json<{ operations: Array<{ kind: string }> }>(get('/api/operations?status=failed'));
  assert.deepEqual(
    failed.operations.map((operation) => operation.kind),
    ['report.weekly'],
  );
});

// ── Serving and configuration ──────────────────────────────────────

test('the studio serves over HTTP, and the command loads a config module', async () => {
  const running = await startStudio({ traces: demo.traces }, { port: 0, token: 'http-token' });
  try {
    assert.match(running.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=http-token$/);
    const entry = await fetch(running.url, { redirect: 'manual' });
    assert.equal(entry.status, 303);
    const api = await fetch(`http://127.0.0.1:${running.port}/api/traces`, {
      headers: { 'x-studio-token': 'http-token' },
    });
    assert.equal(api.status, 200);
    assert.ok(((await api.json()) as { runs: unknown[] }).runs.length > 0);
  } finally {
    await running.close();
  }

  assert.deepEqual(
    parseArgs(['--config', 'a.mjs', '--port=5000', '--allow-host', 'a', '--allow-host', 'b', '--open']),
    {
      config: ['a.mjs'],
      port: ['5000'],
      'allow-host': ['a', 'b'],
      open: ['true'],
    },
  );

  const directory = await mkdtemp(path.join(tmpdir(), 'nexus-studio-'));
  try {
    const file = path.join(directory, 'studio.config.mjs');
    await writeFile(file, 'export default async () => ({ budgets: [{ name: "b", limit: 1, period: "day" }] });\n');
    const sources = await loadSources(file);
    assert.equal(sources.budgets?.[0]?.name, 'b');
    await writeFile(path.join(directory, 'empty.mjs'), 'export const x = 1;\n');
    await assert.rejects(loadSources(path.join(directory, 'empty.mjs')), /no default export/);
    assert.ok(pathToFileURL(file).href.startsWith('file:'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
