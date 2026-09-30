import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareRuns } from '../src/insights/regressions.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import type { Principal, RunRecord, ScalingSnapshot, ServerAssistant, ThreadRecord } from '../src/types/server.js';
import { functionAssistant } from '../src/server/assistant.js';
import { bucket, Deployments, watchCanaries } from '../src/server/deployments.js';
import { MemoryRunEventLog } from '../src/server/events.js';
import { type AgentServer, type AgentServerOptions, createAgentServer } from '../src/server/server.js';
import { MemoryServerStore, RUNS_NAMESPACE } from '../src/server/state.js';
import {
  MemoryTenantUsage,
  RedisTenantUsage,
  type RedisTenantUsageLikeClient,
  tenantLimits,
} from '../src/server/tenancy.js';

const BASE = 'http://server.test';

function call(server: AgentServer, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return server.handle(
    new Request(`${BASE}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Waits until every run in the store has finished, so a test never depends on timing. */
async function allSettled(state: MemoryServerStore, count: number, timeoutMs = 10_000): Promise<RunRecord[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = state.list<RunRecord>(RUNS_NAMESPACE, { limit: 100_000 });
    const done = runs.filter((run) => ['succeeded', 'failed', 'cancelled', 'awaiting_input'].includes(run.status));
    if (runs.length >= count && done.length === runs.length) return runs;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('runs did not settle');
}

/** An assistant that answers at once, or fails when `fails` says so. */
function answering(name: string, fails: (input: { index: number }) => boolean = () => false): ServerAssistant {
  return functionAssistant((input) => {
    const value = input as { index: number };
    if (fails(value)) throw new Error(`${name} could not answer ${value.index}`);
    return { answer: `${name}:${value.index}` };
  });
}

// ── Revisions and traffic splits ───────────────────────────────────

test('a canary takes a tenth of new traffic, and every run records the revision and the split', async () => {
  const state = new MemoryServerStore();
  const deployments = new Deployments({ state });
  const app = createAgentServer({
    assistants: {
      support: deployments.assistant(
        'support',
        { stable: answering('stable'), canary: answering('canary') },
        { live: 'stable' },
      ),
    },
    state,
  });
  const before = await deployments.get('support');
  assert.deepEqual(before?.traffic, { stable: 1 }, 'the live revision takes everything until told otherwise');

  const deployment = await deployments.canary('support', 'canary', 0.1, { by: 'ada', reason: 'first canary' });
  assert.equal(deployment.version, 1);
  assert.deepEqual(deployment.traffic, { canary: 0.1, stable: 0.9 });
  assert.equal(deployment.history[0]?.by, 'ada');

  for (let index = 0; index < 1_000; index += 1) {
    await call(app, 'POST', '/runs', { assistant: 'support', input: { index } });
  }
  const runs = await allSettled(state, 1_000);
  const onCanary = runs.filter((run) => run.revision?.id === 'canary');
  assert.ok(onCanary.length > 70 && onCanary.length < 130, `about a tenth: ${onCanary.length}`);
  for (const run of runs) {
    assert.equal(run.revision?.deployment, 1);
    assert.equal(run.revision?.reason, 'split');
    assert.equal(run.revision?.weight, run.revision?.id === 'canary' ? 0.1 : 0.9);
    assert.equal(
      (run.output as { answer: string }).answer.split(':')[0],
      run.revision?.id,
      'the revision chosen is the one that ran',
    );
  }
});

test('raising a canary only adds threads to it, a thread keeps its revision, and a rollback moves it home', async () => {
  const state = new MemoryServerStore();
  const deployments = new Deployments({ state });
  const app = createAgentServer({
    assistants: {
      support: deployments.assistant('support', { v1: answering('v1'), v2: answering('v2') }, { live: 'v1' }),
    },
    state,
  });
  // The split is a stable hash, so the same key always lands in the same place.
  assert.equal(bucket('support:thread-1'), bucket('support:thread-1'));

  await deployments.canary('support', 'v2', 0.2);
  const threads: ThreadRecord[] = [];
  for (let index = 0; index < 60; index += 1) {
    threads.push(await jsonOf<ThreadRecord>(await call(app, 'POST', '/threads', { assistant: 'support' })));
  }
  const revisionOn = async (thread: ThreadRecord, index: number) => {
    const run = await jsonOf<RunRecord>(await call(app, 'POST', `/threads/${thread.id}/runs`, { input: { index } }));
    await allSettled(state, 0);
    return (await jsonOf<RunRecord>(await call(app, 'GET', `/runs/${run.id}`))).revision;
  };

  const first = await Promise.all(threads.map((thread, index) => revisionOn(thread, index)));
  const onCanary = new Set(threads.filter((_, index) => first[index]?.id === 'v2').map((thread) => thread.id));
  assert.ok(onCanary.size > 0 && onCanary.size < 30);

  await deployments.canary('support', 'v2', 0.5);
  const second = await Promise.all(threads.map((thread, index) => revisionOn(thread, index)));
  threads.forEach((_thread, index) => {
    assert.equal(
      second[index]?.id,
      first[index]?.id,
      'a thread stays where it started while that revision takes traffic',
    );
    assert.equal(second[index]?.reason, 'thread');
    assert.equal(second[index]?.deployment, 2);
  });
  const fresh = await Promise.all(
    Array.from({ length: 40 }, async (_, index) => {
      const thread = await jsonOf<ThreadRecord>(await call(app, 'POST', '/threads', { assistant: 'support' }));
      return revisionOn(thread, index);
    }),
  );
  assert.ok(fresh.filter((revision) => revision?.id === 'v2').length > 8, 'new threads see the larger share');

  const rolledBack = await deployments.rollback('support', { reason: 'enough' });
  assert.deepEqual(rolledBack.traffic, { v1: 1 });
  const home = await Promise.all(threads.map((thread, index) => revisionOn(thread, index)));
  assert.ok(
    home.every((revision) => revision?.id === 'v1'),
    'a rolled-back canary sends its threads home',
  );
  assert.equal((await jsonOf<ThreadRecord>(await call(app, 'GET', `/threads/${[...onCanary][0]}`))).revision, 'v1');

  // A request can name a revision, which is how a canary is tried before it takes any traffic.
  const pinned = await jsonOf<RunRecord>(
    await call(app, 'POST', '/runs', { assistant: 'support', revision: 'v2', input: { index: 0 } }),
  );
  assert.equal(pinned.revision?.id, 'v2');
  assert.equal(pinned.revision?.reason, 'requested');
  const unknown = await call(app, 'POST', '/runs', { assistant: 'support', revision: 'v9' });
  assert.equal(unknown.status, 400);
  assert.equal((await jsonOf<{ error: { code: string } }>(unknown)).error.code, 'UNKNOWN_REVISION');
});

test('promote and rollback move the live revision, keep a history, and refuse a stale version', async () => {
  const deployments = new Deployments();
  deployments.assistant('support', { v1: answering('v1'), v2: answering('v2'), v3: answering('v3') }, { live: 'v1' });

  await deployments.promote('support', 'v2', { by: 'ada' });
  await deployments.promote('support', 'v3', { by: 'ada' });
  let deployment = await deployments.rollback('support', { by: 'bob', reason: 'v3 is slow' });
  assert.equal(deployment.live, 'v2', 'with no canary, a rollback undoes the last promotion');
  deployment = await deployments.rollback('support', { to: 'v1' });
  assert.equal(deployment.live, 'v1');
  assert.deepEqual(
    deployment.history.map((entry) => `${entry.action}:${entry.live}`),
    ['rollback:v1', 'rollback:v2', 'promote:v3', 'promote:v2'],
  );
  assert.equal(deployment.history[1]?.reason, 'v3 is slow');

  await assert.rejects(
    deployments.change('support', { action: 'promote', revision: 'v2', expectedVersion: 1 }),
    (error: Error & { code?: string }) => error.code === 'DEPLOYMENT_CONFLICT',
  );
  await assert.rejects(
    deployments.promote('support', 'v9'),
    (error: Error & { code?: string }) => error.code === 'UNKNOWN_REVISION',
  );
  await assert.rejects(deployments.split('support', { v2: 0.7, v3: 0.6 }), (error: Error) =>
    /more than 1/.test(error.message),
  );
  assert.deepEqual((await deployments.split('support', { v2: 0.25, v3: 0.25 })).traffic, {
    v2: 0.25,
    v3: 0.25,
    v1: 0.5,
  });
});

test('a canary that regresses is rolled back by the guard, with the regression as the reason', async () => {
  const state = new MemoryServerStore();
  const deployments = new Deployments({ state });
  const app = createAgentServer({
    assistants: {
      support: deployments.assistant(
        'support',
        // The canary fails two runs in five; the live revision never does.
        { stable: answering('stable'), canary: answering('canary', (input) => input.index % 5 < 2) },
        { live: 'stable' },
      ),
    },
    state,
  });
  await deployments.canary('support', 'canary', 0.1);
  const decisions: string[] = [];
  const guard = watchCanaries({ deployments, minRuns: 20, onDecision: (decision) => decisions.push(decision.action) });

  for (let index = 0; index < 60; index += 1)
    await call(app, 'POST', '/runs', { assistant: 'support', input: { index } });
  await allSettled(state, 60);
  const early = await guard.check();
  assert.equal(early[0]?.action, 'hold', 'too few canary runs to judge yet');

  for (let index = 60; index < 500; index += 1)
    await call(app, 'POST', '/runs', { assistant: 'support', input: { index } });
  await allSettled(state, 500);
  const [decision] = await guard.check();
  guard.stop();
  assert.equal(decision?.action, 'rollback');
  assert.equal(decision?.regressions[0]?.metric, 'error-rate');
  assert.ok((decision?.samples.canary ?? 0) >= 20);

  const deployment = await deployments.get('support');
  assert.deepEqual(deployment?.traffic, { stable: 1 });
  assert.equal(deployment?.history[0]?.action, 'rollback');
  assert.equal(deployment?.history[0]?.by, 'guard');
  assert.match(deployment?.history[0]?.reason ?? '', /canary rolled back: .*error rate rose/);

  const stats = await deployments.stats('support');
  const canaryStats = stats.find((item) => item.revision === 'canary');
  const canaryRuns = state
    .list<RunRecord>(RUNS_NAMESPACE, { limit: 10_000 })
    .filter((run) => run.revision?.id === 'canary');
  const canaryFailed = canaryRuns.filter((run) => run.status === 'failed').length;
  assert.equal(canaryStats?.failed, canaryFailed, 'the stats show why');
  assert.equal(canaryStats?.errorRate, canaryFailed / canaryRuns.length);
  assert.ok(canaryFailed > 0);
  assert.equal(stats.find((item) => item.revision === 'stable')?.errorRate, 0);

  for (let index = 500; index < 520; index += 1)
    await call(app, 'POST', '/runs', { assistant: 'support', input: { index } });
  const after = (await allSettled(state, 520)).filter((run) => run.revision?.deployment === deployment?.version);
  assert.equal(after.length, 20);
  assert.ok(
    after.every((run) => run.revision?.id === 'stable'),
    'nothing reaches the canary after the rollback',
  );
  assert.deepEqual(decisions, ['hold', 'rollback']);
  assert.deepEqual(await guard.check(), [], 'a second guard finds nothing left to judge');
});

test('a canary that holds up moves through its steps and is promoted', async () => {
  const state = new MemoryServerStore();
  const deployments = new Deployments({ state });
  const app = createAgentServer({
    assistants: {
      support: deployments.assistant('support', { v1: answering('v1'), v2: answering('v2') }, { live: 'v1' }),
    },
    state,
  });
  await deployments.canary('support', 'v2', 0.1);
  const guard = watchCanaries({ deployments, minRuns: 10, steps: [0.1, 0.5] });
  const actions: string[] = [];
  let index = 0;
  for (let round = 0; round < 3; round += 1) {
    for (let count = 0; count < 400; count += 1) {
      await call(app, 'POST', '/runs', { assistant: 'support', input: { index: index++ } });
    }
    await allSettled(state, index);
    actions.push(...(await guard.check()).map((decision) => `${decision.action}@${decision.weight}`));
  }
  guard.stop();
  assert.deepEqual(actions, ['advance@0.5', 'promote@1']);
  const deployment = await deployments.get('support');
  assert.equal(deployment?.live, 'v2');
  assert.deepEqual(deployment?.traffic, { v2: 1 });
});

test('the deployment routes need the admin scope, and changes made there reach the router', async () => {
  const state = new MemoryServerStore();
  const deployments = new Deployments({ state });
  const principals: Record<string, Principal> = {
    tenant: { tenantId: 'acme', scopes: ['runs'] },
    operator: { userId: 'ada', scopes: ['runs', 'deploy'] },
  };
  const app = createAgentServer({
    assistants: {
      support: deployments.assistant('support', { v1: answering('v1'), v2: answering('v2') }, { live: 'v1' }),
    },
    state,
    deployments,
    authenticate: (request) => principals[request.headers.get('authorization') ?? ''],
    scopes: { admin: 'deploy' },
  });
  await app.start();
  try {
    assert.equal((await call(app, 'GET', '/deployments', undefined, { authorization: 'tenant' })).status, 403);
    const changed = await call(
      app,
      'POST',
      '/deployments/support',
      { action: 'canary', revision: 'v2', weight: 0.5, reason: 'try it' },
      { authorization: 'operator' },
    );
    assert.equal(changed.status, 200);
    assert.equal((await jsonOf<{ updatedBy: string }>(changed)).updatedBy, 'ada');
    const listed = await jsonOf<{ deployments: Array<{ assistant: string; traffic: Record<string, number> }> }>(
      await call(app, 'GET', '/deployments', undefined, { authorization: 'operator' }),
    );
    assert.deepEqual(listed.deployments[0]?.traffic, { v2: 0.5, v1: 0.5 });

    const replicas = await jsonOf<{ replicas: Array<{ id: string; assistants: Record<string, string[]> }> }>(
      await call(app, 'GET', '/replicas', undefined, { authorization: 'operator' }),
    );
    assert.equal(replicas.replicas.length, 1);
    assert.deepEqual(replicas.replicas[0]?.assistants.support, ['v1', 'v2']);

    const assistants = await jsonOf<{ assistants: Array<{ revisions?: string[] }> }>(
      await call(app, 'GET', '/assistants', undefined, { authorization: 'tenant' }),
    );
    assert.deepEqual(assistants.assistants[0]?.revisions, ['v1', 'v2']);
  } finally {
    await app.stop();
  }
  assert.deepEqual(await deployments.replicas(), [], 'a stopped replica removes its heartbeat');
});

// ── Tenancy ────────────────────────────────────────────────────────

/** An assistant that waits until released, so a test controls how many runs are in flight. */
function gated(): { assistant: ServerAssistant; release: () => void } {
  const waiting: Array<() => void> = [];
  return {
    assistant: {
      async *stream(_input, context) {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        yield { type: 'done', state: 'ok' };
      },
    },
    release: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

test('a tenant is held to its active runs and its rate, and other tenants are not affected', async () => {
  const state = new MemoryServerStore();
  const { assistant, release } = gated();
  const app = createAgentServer({
    assistants: { work: assistant },
    state,
    authenticate: (request) => ({ tenantId: request.headers.get('x-tenant') ?? undefined }),
    tenants: tenantLimits({
      default: { maxActiveRuns: 2 },
      tenants: { burst: { rate: { runs: 3, windowMs: 60_000 } } },
    }),
  });
  const as = (tenant: string) => ({ 'x-tenant': tenant });

  assert.equal((await call(app, 'POST', '/runs', { assistant: 'work' }, as('acme'))).status, 202);
  assert.equal((await call(app, 'POST', '/runs', { assistant: 'work' }, as('acme'))).status, 202);
  const refused = await call(app, 'POST', '/runs', { assistant: 'work' }, as('acme'));
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '1');
  assert.equal((await jsonOf<{ error: { code: string } }>(refused)).error.code, 'TENANT_CONCURRENCY');
  assert.equal(
    (await call(app, 'POST', '/runs', { assistant: 'work' }, as('globex'))).status,
    202,
    'another tenant has its own slots',
  );

  const usage = await jsonOf<{ activeRuns: number }>(await call(app, 'GET', '/usage', undefined, as('acme')));
  assert.equal(usage.activeRuns, 2);
  release();
  await allSettled(state, 3);
  assert.equal(
    (await call(app, 'POST', '/runs', { assistant: 'work' }, as('acme'))).status,
    202,
    'finished runs free their slots',
  );
  release();

  for (let index = 0; index < 3; index += 1) {
    assert.equal((await call(app, 'POST', '/runs', { assistant: 'work' }, as('burst'))).status, 202);
    release();
  }
  const limited = await call(app, 'POST', '/runs', { assistant: 'work' }, as('burst'));
  assert.equal(limited.status, 429);
  assert.equal((await jsonOf<{ error: { code: string } }>(limited)).error.code, 'TENANT_RATE_LIMITED');
  assert.ok(Number(limited.headers.get('retry-after')) > 50);

  const metrics = await (await call(app, 'GET', '/metrics', undefined, as('acme'))).text();
  assert.match(metrics, /nexus_server_tenant_refusals_total\{limit="concurrency"\} 1/);
  assert.match(metrics, /nexus_server_tenant_refusals_total\{limit="rate"\} 1/);
});

test('a tenant budget refuses new runs once spent, and can stop the run that spends it', async () => {
  const state = new MemoryServerStore();
  const at = new Date('2026-09-30T15:00:00.000Z');
  const spender: ServerAssistant = {
    async *stream(input, context) {
      const { usd, twice } = input as { usd: number; twice?: boolean };
      await context.recordCost(usd);
      if (twice) {
        // A budget that stops runs cancels this one here, before it spends again.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (context.signal.aborted) return;
        await context.recordCost(usd);
      }
      yield { type: 'done', state: { spent: usd } };
    },
  };
  const app = createAgentServer({
    assistants: { spend: spender },
    state,
    authenticate: (request) => ({ tenantId: request.headers.get('x-tenant') ?? undefined }),
    tenants: tenantLimits({
      tenants: {
        acme: { budget: { usd: 1, period: 'day' } },
        strict: { budget: { usd: 1, period: 'day', stopRuns: true } },
      },
      now: () => at,
    }),
  });
  const as = (tenant: string) => ({ 'x-tenant': tenant });

  await call(app, 'POST', '/runs', { assistant: 'spend', input: { usd: 0.6 } }, as('acme'));
  await allSettled(state, 1);
  await call(app, 'POST', '/runs', { assistant: 'spend', input: { usd: 0.6 } }, as('acme'));
  const runs = await allSettled(state, 2);
  assert.ok(
    runs.every((run) => run.cost === 0.6),
    'each run records what it spent',
  );

  const refused = await call(app, 'POST', '/runs', { assistant: 'spend', input: { usd: 0.6 } }, as('acme'));
  assert.equal(refused.status, 429);
  assert.equal((await jsonOf<{ error: { code: string } }>(refused)).error.code, 'TENANT_BUDGET');
  assert.equal(refused.headers.get('retry-after'), String(9 * 3600), 'the budget resets at midnight UTC');
  const usage = await jsonOf<{ spend: { usd: number; resetsAt: string } }>(
    await call(app, 'GET', '/usage', undefined, as('acme')),
  );
  assert.equal(usage.spend.usd, 1.2);
  assert.equal(usage.spend.resetsAt, '2026-10-01T00:00:00.000Z');

  const stopped = await jsonOf<RunRecord>(
    await call(app, 'POST', '/runs', { assistant: 'spend', input: { usd: 1.5, twice: true } }, as('strict')),
  );
  const [run] = (await allSettled(state, 3)).filter((item) => item.id === stopped.id);
  assert.equal(run?.status, 'cancelled');
  assert.match(run?.error?.message ?? '', /budget/);
});

/** A Redis stand-in that runs the tenant usage scripts, told apart by their first line. */
function fakeTenantRedis(): RedisTenantUsageLikeClient {
  const sets = new Map<string, Map<string, number>>();
  const strings = new Map<string, number>();
  const prune = (key: string, now: number) => {
    const set = sets.get(key) ?? new Map<string, number>();
    for (const [member, score] of set) if (score <= now) set.delete(member);
    sets.set(key, set);
    return set;
  };
  return {
    async eval(script, _keys, key, ...args) {
      const name = script.split('\n')[0];
      if (name === '-- nexus:acquire') {
        const [now, max, member, expiresAt] = args;
        const set = prune(key as string, Number(now));
        if (set.has(member as string)) return 1;
        if (set.size >= Number(max)) return 0;
        set.set(member as string, Number(expiresAt));
        return 1;
      }
      if (name === '-- nexus:release') return sets.get(key as string)?.delete(args[0] as string) ? 1 : 0;
      if (name === '-- nexus:count') return prune(key as string, Number(args[0])).size;
      if (name === '-- nexus:add') {
        const total = (strings.get(key as string) ?? 0) + Number(args[0]);
        strings.set(key as string, total);
        return String(total);
      }
      if (name === '-- nexus:total') return String(strings.get(key as string) ?? 0);
      throw new Error(`unexpected script ${name}`);
    },
  };
}

test('tenant usage in Redis is shared, so two replicas enforce one limit', async () => {
  const redis = fakeTenantRedis();
  for (const [name, first, second] of [
    ['memory', new MemoryTenantUsage(), undefined],
    ['redis', new RedisTenantUsage(redis), new RedisTenantUsage(redis)],
  ] as const) {
    const one = tenantLimits({ default: { maxActiveRuns: 1 }, usage: first });
    const two = tenantLimits({ default: { maxActiveRuns: 1 }, usage: second ?? first });
    await one.admit({ runId: 'r1', assistant: 'a', principal: { tenantId: 't' } });
    await assert.rejects(
      Promise.resolve(two.admit({ runId: 'r2', assistant: 'a', principal: { tenantId: 't' } })),
      (error: Error & { code?: string }) => error.code === 'TENANT_CONCURRENCY',
      name,
    );
    await two.release({ runId: 'r1', tenantId: 't' });
    await two.admit({ runId: 'r2', assistant: 'a', principal: { tenantId: 't' } });
    assert.equal((await one.usage('t')).activeRuns, 1, name);
    assert.equal(await one.spend({ runId: 'r2', tenantId: 't' }, 0.25), true, name);
    assert.equal((await two.usage('t')).spend.usd, 0.25, name);
  }
});

// ── Queues, scaling, and draining ──────────────────────────────────

/** Replicas that share one set of stores, as replicas pointed at one Redis do. */
function cluster() {
  const shared = {
    state: new MemoryServerStore(),
    events: new MemoryRunEventLog(),
    store: new MemoryOperationStore<unknown>({ maxRecords: 100_000 }),
  };
  const executions = new Map<string, number>();
  const assistant: ServerAssistant = {
    async *stream(input, context) {
      executions.set(context.runId, (executions.get(context.runId) ?? 0) + 1);
      const { ms } = input as { ms: number };
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        context.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(context.signal.reason);
          },
          { once: true },
        );
      });
      yield { type: 'done', state: { worker: context.attempt } };
    },
  };
  const replica = (options: Partial<AgentServerOptions> = {}) =>
    createAgentServer({
      assistants: { work: assistant },
      state: shared.state,
      events: shared.events,
      operations: { store: shared.store, leaseMs: 5_000 },
      queue: { concurrency: 2, pollMs: 10 },
      ...options,
    });
  return { shared, executions, replica };
}

test('a load test scales workers up on the queue and back down, and no run is lost or run twice', async () => {
  const { shared, executions, replica } = cluster();
  const api = replica({ queue: { claim: false }, metrics: { public: true } });
  await api.start();
  const workers: AgentServer[] = [];
  const addWorker = async () => {
    const worker = replica();
    await worker.start();
    workers.push(worker);
  };
  await addWorker();

  // What an autoscaler does with GET /scaling: size the pool for the load, one worker per two runs.
  const timeline: number[] = [];
  let peakQueue = 0;
  const autoscale = async () => {
    const snapshot = await jsonOf<ScalingSnapshot>(await call(api, 'GET', '/scaling'));
    peakQueue = Math.max(peakQueue, snapshot.queued);
    const desired = Math.min(6, Math.max(1, Math.ceil(snapshot.load / 2)));
    while (workers.length < desired) await addWorker();
    while (workers.length > desired) {
      const worker = workers.pop() as AgentServer;
      await worker.drain({ timeoutMs: 1_000 });
      await worker.stop();
    }
    timeline.push(workers.length);
  };
  const scaler = setInterval(() => void autoscale(), 15);

  try {
    for (let index = 0; index < 60; index += 1) {
      assert.equal((await call(api, 'POST', '/runs', { assistant: 'work', input: { ms: 30 } })).status, 202);
    }
    const metrics = await (await call(api, 'GET', '/metrics')).text();
    assert.match(metrics, /nexus_server_runs_queued \d+/);
    assert.match(metrics, /nexus_server_queue_load \d+/);

    const runs = await allSettled(shared.state, 60, 20_000);
    const deadline = Date.now() + 5_000;
    while (workers.length > 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));

    assert.ok(peakQueue > 0, 'work queued up while the pool was small');
    assert.ok(Math.max(...timeline) >= 4, `the pool grew with the queue: ${Math.max(...timeline)}`);
    assert.equal(workers.length, 1, 'and shrank back once it drained');
    assert.ok(
      runs.every((run) => run.status === 'succeeded'),
      'every run finished',
    );
    assert.equal(executions.size, 60);
    assert.ok(
      [...executions.values()].every((count) => count === 1),
      'none ran twice',
    );
    assert.ok(new Set(runs.map((run) => run.worker)).size >= 4, 'the work spread across the pool');
    assert.ok(runs.every((run) => run.startedAt && run.durationMs !== undefined));
    const final = await jsonOf<ScalingSnapshot>(await call(api, 'GET', '/scaling'));
    assert.equal(final.load, 0);
  } finally {
    clearInterval(scaler);
    for (const worker of workers) await worker.stop();
    await api.stop();
  }
});

test('a draining worker answers 503, hands a long run to another worker, and the run finishes there', async () => {
  const { shared, executions, replica } = cluster();
  const first = replica();
  await first.start();
  const accepted = await jsonOf<RunRecord>(
    await call(first, 'POST', '/runs', { assistant: 'work', input: { ms: 300 } }),
  );
  await new Promise((resolve) => setTimeout(resolve, 30));

  const draining = first.drain({ timeoutMs: 20 });
  assert.equal((await call(first, 'GET', '/health')).status, 503);
  const result = await draining;
  assert.deepEqual(result.released, [accepted.id]);
  const handedOff = await jsonOf<RunRecord>(await call(first, 'GET', `/runs/${accepted.id}`));
  assert.equal(handedOff.status, 'queued');

  const second = replica();
  await second.start();
  try {
    const [run] = await allSettled(shared.state, 1);
    assert.equal(run?.status, 'succeeded');
    assert.equal(run?.attempt, 2, 'the next worker ran it as a later attempt');
    assert.equal(run?.worker, second.runs.workerId);
    assert.equal(executions.get(accepted.id), 2);
    const text = await (await call(first, 'GET', '/metrics')).text();
    assert.match(text, /nexus_server_runs_handed_off_total 1/);
    assert.match(text, /nexus_server_worker_draining 1/);
  } finally {
    await first.stop();
    await second.stop();
  }
});

test('metrics are public only when asked, and can be turned off', async () => {
  const guarded = createAgentServer({ assistants: { work: answering('w') }, authenticate: () => undefined });
  assert.equal((await call(guarded, 'GET', '/metrics')).status, 401);
  assert.equal((await call(guarded, 'GET', '/health')).status, 200);
  const open = createAgentServer({
    assistants: { work: answering('w') },
    authenticate: () => undefined,
    metrics: { public: true },
  });
  const response = await call(open, 'GET', '/metrics');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/plain/);
  assert.equal((await call(open, 'GET', '/scaling')).status, 200);
  const off = createAgentServer({ assistants: { work: answering('w') }, metrics: false });
  assert.equal((await call(off, 'GET', '/metrics')).status, 404);
});

test('a latency rise of a few milliseconds is noise to the guard, not a regression', () => {
  const runs = (latencyMs: number) => Array.from({ length: 30 }, () => ({ status: 'success', latencyMs }));
  assert.equal(compareRuns(runs(1), runs(3), { metrics: ['latency'] }).length, 1, 'relatively, it tripled');
  assert.deepEqual(compareRuns(runs(1), runs(3), { metrics: ['latency'], minLatencyChangeMs: 50 }), []);
  assert.equal(compareRuns(runs(100), runs(400), { metrics: ['latency'], minLatencyChangeMs: 50 }).length, 1);
});
