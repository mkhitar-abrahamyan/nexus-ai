/**
 * Canaries that stay fair: `hash-v2` places sequential thread ids as evenly as random ones, while
 * every deployment recorded before it keeps `fnv1a-v1`, so no thread moves through an upgrade. And a
 * guard over rollups judges a canary on every run routed under the deployment's version, counted by
 * each replica, instead of the latest 2,000 run records.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { functionAssistant } from '../src/server/assistant.js';
import { bucket, Deployments, type DeploymentRollup, watchCanaries } from '../src/server/deployments.js';
import { createAgentServer } from '../src/server/server.js';
import { MemoryServerStore, RUNS_NAMESPACE } from '../src/server/state.js';
import type { RunRecord, ServerStateStore } from '../src/types/server.js';

const revisions = () => ({
  stable: functionAssistant(() => ({ answer: 'stable' })),
  canary: functionAssistant(() => ({ answer: 'canary' })),
});

/** How far a canary's share of these ids is from its weight, in binomial standard deviations. */
function deviation(ids: readonly string[], weight: number, strategy: 'fnv1a-v1' | 'hash-v2'): number {
  const share = ids.filter((id) => bucket(id, strategy) < weight).length / ids.length;
  return Math.abs(share - weight) / Math.sqrt((weight * (1 - weight)) / ids.length);
}

test('hash-v2 spreads sequential ids as evenly as random ones; fnv1a-v1 clusters them', () => {
  let worst = { 'fnv1a-v1': 0, 'hash-v2': 0 };
  for (const assistant of ['support', 'billing', 'triage']) {
    for (const shape of ['user-', 'thread-', 'order-', '']) {
      const ids = Array.from({ length: 500 }, (_, index) => `${assistant}:${shape}${index + 1}`);
      for (const weight of [0.05, 0.1, 0.25, 0.5]) {
        worst = {
          'fnv1a-v1': Math.max(worst['fnv1a-v1'], deviation(ids, weight, 'fnv1a-v1')),
          'hash-v2': Math.max(worst['hash-v2'], deviation(ids, weight, 'hash-v2')),
        };
      }
    }
  }
  // Over 48 sets of 500 sequential ids, random placement stays within about 3 deviations.
  assert.ok(worst['hash-v2'] < 3, `hash-v2 behaves like random placement: ${worst['hash-v2'].toFixed(2)}`);
  assert.ok(worst['fnv1a-v1'] > 6, `fnv1a-v1 clusters sequential ids: ${worst['fnv1a-v1'].toFixed(2)}`);

  const many = Array.from({ length: 10_000 }, (_, index) => `support:user-${index + 1}`);
  for (const weight of [0.01, 0.05, 0.1, 0.25, 0.5]) {
    const share = many.filter((id) => bucket(id, 'hash-v2') < weight).length / many.length;
    assert.ok(Math.abs(share - weight) < 0.005, `10,000 sequential ids within half a point of ${weight}: ${share}`);
  }

  // The default is fnv1a-v1, and its positions are the ones every earlier release gave.
  assert.equal(bucket('support:thread-1'), bucket('support:thread-1', 'fnv1a-v1'));
  assert.equal(bucket('support:thread-1'), 0x3f31e814 / 0x1_0000_0000);
  assert.notEqual(bucket('support:thread-1', 'hash-v2'), bucket('support:thread-1'));
});

test('a deployment records its bucket strategy, routes by it, and a thread stays put when it changes', async () => {
  const state = new MemoryServerStore();
  const deployments = new Deployments({ state, cacheMs: 0 });
  deployments.assistant('support', revisions(), { live: 'stable', bucketStrategy: 'hash-v2' });
  deployments.assistant('billing', revisions(), { live: 'stable' });

  assert.equal((await deployments.get('support'))?.bucketStrategy, 'hash-v2');
  assert.equal((await deployments.get('billing'))?.bucketStrategy, undefined, 'fnv1a-v1, as before 2.5');
  await deployments.canary('support', 'canary', 0.25);
  assert.equal((await deployments.get('support'))?.bucketStrategy, 'hash-v2', 'a change keeps the strategy');

  const placed = async (assistant: string) => {
    let onCanary = 0;
    for (let index = 1; index <= 2_000; index += 1) {
      const choice = await deployments.route(assistant, { runId: `run-${index}`, threadId: `user-${index}` });
      if (choice?.id === 'canary') onCanary += 1;
    }
    return onCanary / 2_000;
  };
  const supportShare = await placed('support');
  assert.ok(Math.abs(supportShare - 0.25) < 0.03, `hash-v2 keeps the canary near its weight: ${supportShare}`);
  // Each choice matches the strategy's own position.
  const choice = await deployments.route('support', { runId: 'r', threadId: 'user-7' });
  assert.equal(choice?.id, bucket('support:user-7', 'hash-v2') < 0.25 ? 'canary' : 'stable');

  // Switching a recorded deployment changes where new threads go, and is in the history.
  await deployments.canary('billing', 'canary', 0.25);
  const switched = await deployments.bucketing('billing', 'hash-v2', { by: 'ada', reason: 'even split' });
  assert.equal(switched.bucketStrategy, 'hash-v2');
  assert.deepEqual(switched.traffic, { canary: 0.25, stable: 0.75 }, 'the split itself is unchanged');
  assert.equal(switched.history[0]?.action, 'bucketing');
  assert.equal(switched.history[0]?.bucketStrategy, 'hash-v2');
  assert.equal(switched.history[0]?.by, 'ada');
  // A thread already on a revision that takes traffic stays there, whatever the new position says.
  const moved = Array.from({ length: 200 }, (_, index) => `user-${index}`).find(
    (thread) => bucket(`billing:${thread}`) < 0.25 !== bucket(`billing:${thread}`, 'hash-v2') < 0.25,
  ) as string;
  const before = bucket(`billing:${moved}`) < 0.25 ? 'canary' : 'stable';
  const kept = await deployments.route('billing', { runId: 'r2', threadId: moved, threadRevision: before });
  assert.equal(kept?.id, before);
  assert.equal(kept?.reason, 'thread');
  assert.notEqual((await deployments.route('billing', { runId: 'r3', threadId: moved }))?.id, before);

  await assert.rejects(
    deployments.change('billing', { action: 'bucketing', strategy: 'md5' as never }),
    /Unknown bucket strategy/,
  );
  assert.throws(
    () => deployments.assistant('other', revisions(), { bucketStrategy: 'md5' as never }),
    /Unknown bucket strategy/,
  );
});

/** A finished run, as the server records it. */
function finished(index: number, revision: string, deployment: number, failed: boolean, durationMs = 100): RunRecord {
  return {
    id: `run-${revision}-${index}`,
    assistant: 'support',
    status: failed ? 'failed' : 'succeeded',
    createdAt: new Date().toISOString(),
    durationMs,
    cost: 0.002,
    revision: { id: revision, weight: 0.5, deployment, reason: 'split' },
  } as RunRecord;
}

/** The state store, counting how many times each namespace is listed. */
function counting(state: MemoryServerStore): ServerStateStore & { lists: Map<string, number> } {
  const lists = new Map<string, number>();
  return {
    lists,
    get: (namespace, key) => state.get(namespace, key),
    put: (namespace, key, value) => state.put(namespace, key, value),
    delete: (namespace, key) => state.delete(namespace, key),
    list: (namespace, options) => {
      const name = namespace.slice(0, 3).join('/');
      lists.set(name, (lists.get(name) ?? 0) + 1);
      return state.list(namespace, options);
    },
    putIfVersion: (namespace, key, value, expected) => state.putIfVersion(namespace, key, value, expected),
  };
}

test('a guard over rollups judges a canary on all of its 100,000 runs, in one read', async () => {
  const memory = new MemoryServerStore();
  const state = counting(memory);
  const replicas = Array.from({ length: 3 }, () => {
    const deployments = new Deployments({ state, cacheMs: 0 });
    deployments.assistant('support', revisions(), { live: 'stable' });
    return deployments;
  });
  const version = (await replicas[0]?.canary('support', 'canary', 0.5))?.version as number;

  // 50,000 runs a side, shared among three replicas. The canary fails 0.8% of the time and the live
  // revision 0.5%: too small a rise to see in the latest 2,000 runs, but certain over all of them.
  for (let index = 0; index < 50_000; index += 1) {
    for (const [revision, every] of [
      ['stable', 200],
      ['canary', 125],
    ] as const) {
      const run = finished(index, revision, version, index % every === 0);
      replicas[index % 3]?.recordRun(run);
      memory.put(RUNS_NAMESPACE, run.id, run);
    }
  }

  const fromRuns = watchCanaries({ deployments: replicas[0] as Deployments, everyMs: 3_600_000 });
  const [held] = await fromRuns.check();
  fromRuns.stop();
  assert.equal(held?.action, 'hold', 'the latest 2,000 run records show no regression');
  assert.ok((held?.samples.canary ?? 0) >= 900 && (held?.samples.canary ?? 0) <= 1_100, 'about half of 2,000');

  // Each replica writes what it counted every `rollupMs`; here, at once.
  await Promise.all(replicas.map((replica) => replica.flushRollups()));
  state.lists.clear();
  const fromRollups = watchCanaries({ deployments: replicas[1] as Deployments, from: 'rollups', everyMs: 3_600_000 });
  const [decision] = await fromRollups.check();
  fromRollups.stop();
  assert.equal(decision?.action, 'rollback');
  assert.deepEqual(decision?.samples, { live: 50_000, canary: 50_000 }, 'every run, counted by every replica');
  assert.equal(decision?.regressions[0]?.metric, 'error-rate');
  assert.equal(decision?.regressions[0]?.baseline, 0.005);
  assert.equal(decision?.regressions[0]?.current, 0.008);
  assert.equal(state.lists.get('nexus/server/rollups'), 1, 'one read of the replicas’ rollups');
  assert.equal(state.lists.get('nexus/server/runs'), undefined, 'no run records read');
  const stored = memory.list<DeploymentRollup>(['nexus', 'server', 'rollups', 'support', String(version)], {
    limit: 10,
  });
  assert.equal(stored.length, 3, 'one record per replica');
  assert.equal(
    stored.reduce((sum, rollup) => sum + (rollup.revisions.stable?.runs ?? 0), 0),
    50_000,
    'the replicas’ counts add up to every run',
  );

  const history = (await replicas[0]?.get('support'))?.history ?? [];
  assert.match(history[0]?.reason ?? '', /error rate rose from 0\.5% to 0\.8%/);
});

test('rollups keep latency within 2.5%, cost exactly, and stats() reads them by deployment version', async () => {
  const state = new MemoryServerStore();
  const deployments = new Deployments({ state, cacheMs: 0 });
  deployments.assistant('support', revisions(), { live: 'stable' });
  const version = (await deployments.canary('support', 'canary', 0.5)).version;
  const durations = Array.from({ length: 1_000 }, (_, index) => 50 + index * 3);
  for (const [index, ms] of durations.entries()) {
    deployments.recordRun(finished(index, 'stable', version, false, ms));
    deployments.recordRun(finished(index, 'canary', version, index % 10 === 0, ms * 1.4));
  }
  // Cancelled runs count apart; one cancelled while awaiting input was counted when it paused.
  deployments.recordRun({ ...finished(9_000, 'stable', version, false), status: 'cancelled' } as RunRecord);
  deployments.recordRun({
    ...finished(9_001, 'stable', version, false),
    status: 'cancelled',
    interrupt: { value: 'approve?' },
  } as unknown as RunRecord);
  deployments.recordRun({ ...finished(9_002, 'stable', version, false), revision: undefined } as RunRecord);

  const stats = await deployments.stats('support', { deployment: version });
  const stable = stats.find((item) => item.revision === 'stable');
  const canary = stats.find((item) => item.revision === 'canary');
  assert.equal(stable?.runs, 1_001);
  assert.equal(stable?.cancelled, 1);
  assert.equal(stable?.succeeded, 1_000);
  assert.equal(canary?.failed, 100);
  assert.equal(canary?.errorRate, 0.1);
  assert.ok(Math.abs((stable?.meanCost ?? 0) - 0.002) < 1e-12);
  const exact = durations[Math.ceil(0.95 * durations.length) - 1] as number;
  assert.ok(Math.abs((stable?.p95Ms ?? 0) / exact - 1) <= 0.025, `p95 ${stable?.p95Ms} against ${exact}`);

  const guard = watchCanaries({ deployments, from: 'rollups', metrics: ['latency', 'cost'], everyMs: 3_600_000 });
  const [decision] = await guard.check();
  guard.stop();
  assert.equal(decision?.action, 'rollback');
  assert.deepEqual(
    decision?.regressions.map((regression) => regression.metric),
    ['latency-p95'],
  );

  // A version no replica counted falls back to run records.
  state.put(RUNS_NAMESPACE, 'old', finished(1, 'stable', 0, false));
  assert.equal((await deployments.stats('support', { deployment: 0 }))[0]?.runs, 1);
  assert.throws(
    () => watchCanaries({ deployments, from: 'rollups', feedback: ['quality'] }),
    /neither samples nor feedback/,
  );
});

test('a server with deployments counts every finished run in its rollups, and its route reports them', async () => {
  const state = new MemoryServerStore();
  const deployments = new Deployments({ state, cacheMs: 0, rollupMs: 5 });
  const app = createAgentServer({
    assistants: { support: deployments.assistant('support', revisions(), { live: 'stable' }) },
    state,
    deployments,
  });
  await app.start();
  const deployment = await deployments.canary('support', 'canary', 0.5);
  for (let index = 0; index < 40; index += 1) {
    await app.handle(
      new Request('http://server.test/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assistant: 'support', input: { index } }),
      }),
    );
  }
  const deadline = Date.now() + 10_000;
  while (state.list<RunRecord>(RUNS_NAMESPACE, { limit: 100 }).some((run) => run.status !== 'succeeded')) {
    if (Date.now() > deadline) throw new Error('runs did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await app.stop();
  const stored = state.list<DeploymentRollup>(['nexus', 'server', 'rollups', 'support', String(deployment.version)]);
  assert.equal(stored.length, 1);
  const counted = Object.values(stored[0]?.revisions ?? {}).reduce((sum, rollup) => sum + rollup.succeeded, 0);
  assert.equal(counted, 40);

  const response = await app.handle(new Request('http://server.test/deployments/support'));
  const body = (await response.json()) as { stats: Array<{ runs: number }> };
  assert.equal(
    body.stats.reduce((sum, item) => sum + item.runs, 0),
    40,
  );
});
