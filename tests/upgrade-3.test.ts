/**
 * The 3.0 rollout proof: workers and replicas running the published 2.21.0 package, with 2.x's
 * defaults, share their stores with 3.0's while a deployment upgrades. The old release is the real
 * package from npm, installed as a development alias, so nothing here imitates what it does.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { RedisOperationStore as RedisOperationStore221 } from 'nexus-ai-pro-2-21/operations';
import { Deployments as Deployments221 } from 'nexus-ai-pro-2-21/server/deployments';
import { RedisOperationStore } from '../src/operations/adapters.js';
import { functionAssistant } from '../src/server/assistant.js';
import { bucket, Deployments } from '../src/server/deployments.js';
import { MemoryServerStore } from '../src/server/state.js';
import type { OperationRecord } from '../src/types/operations.js';
import { FakeRedis } from './redis-fake.js';

let redis: FakeRedis;
before(async () => {
  redis = await FakeRedis.create();
});
after(() => redis.close());

const base = Date.parse('2026-10-29T00:00:00.000Z');
function queued(index: number): OperationRecord<string> {
  const at = new Date(base + index * 1000).toISOString();
  return {
    id: `op-${index}`,
    status: 'queued',
    attempt: 1,
    maxAttempts: 3,
    sequence: 0,
    createdAt: at,
    updatedAt: at,
    kind: 'job',
  };
}

test('a 2.21 worker and a 3.0 worker share a Redis prefix: what 2.21 queued it claims, and 3.0 finds once reindexed', async () => {
  const old = new RedisOperationStore221<string>(redis as never, { prefix: 'rollout:' });
  const next = new RedisOperationStore<string>(redis, { prefix: 'rollout:' });
  assert.deepEqual([old.indexed, next.indexed], [false, true], "each on its own release's defaults");
  const ids = async (store: { listQueued(limit: number): Promise<Array<{ id: string }>> }) =>
    (await store.listQueued(10)).map((record) => record.id).sort();

  await old.create(queued(1));
  await next.create(queued(2));
  assert.deepEqual(await ids(old), ['op-1', 'op-2'], '2.21 reads every record, so it claims both');
  assert.deepEqual(await ids(next), ['op-2'], '3.0 reads its index, which 2.21 did not write to');

  // A 2.21 worker finishes work 3.0 queued: the index entry it leaves is skipped, then removed.
  assert.equal(await old.update({ ...queued(2), status: 'succeeded', sequence: 1 }, 0), true);
  assert.deepEqual(await ids(next), [], 'nothing finished is offered');

  // The last 2.21 worker stops with its work still queued; one reindex finds it.
  assert.equal(await next.reindex(), 2, 'every record read once');
  assert.deepEqual(await ids(next), ['op-1']);
});

test('2.21 and 3.0 replicas place every thread alike, whichever of them records the deployment first', async () => {
  const answering = functionAssistant(() => ({ answer: 'ok' }));
  for (const first of ['3.0', '2.21'] as const) {
    const state = new MemoryServerStore();
    const next = new Deployments({ state, cacheMs: 0 });
    const old = new Deployments221({ state: state as never, cacheMs: 0 });
    next.assistant('support', { stable: answering, canary: answering }, { live: 'stable' });
    old.assistant('support', { stable: answering, canary: answering } as never, { live: 'stable' });

    await (first === '3.0' ? next : old).canary('support', 'canary', 0.3);
    const strategy = (await next.get('support'))?.bucketStrategy;
    assert.equal(strategy, first === '3.0' ? 'hash-v2' : undefined, `recorded by ${first}`);

    let onCanary = 0;
    for (let index = 1; index <= 300; index += 1) {
      const request = { runId: `run-${index}`, threadId: `user-${index}` };
      const [placed, placedBefore] = await Promise.all([next.route('support', request), old.route('support', request)]);
      assert.equal(placed?.id, placedBefore?.id, `recorded by ${first}, user-${index} lands alike on both`);
      assert.equal(
        placed?.id,
        bucket(`support:user-${index}`, strategy) < 0.3 ? 'canary' : 'stable',
        'where the recorded strategy puts it',
      );
      if (placed?.id === 'canary') onCanary += 1;
    }
    assert.ok(onCanary > 0 && onCanary < 300, `both revisions take traffic: ${onCanary} of 300 on the canary`);
  }
});
