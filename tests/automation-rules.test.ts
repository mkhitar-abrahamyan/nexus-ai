/**
 * Automation rules, and the proof that closes 2.12: a canary rolled back on a media evaluator's
 * score.
 *
 * A designer assistant draws banners into a catalogued asset store; its canary draws them square.
 * Two replicas evaluate the runs through the online-evaluation worker with media checks and a judge
 * shown each banner. A rule on the judge's score, read from the run records every replica shares,
 * marks the canary unhealthy, which rolls it back, opens review items for the worst banners, and
 * sends one signed webhook, once between the replicas. The live revision is never touched, new runs
 * go to it, and the catalog finds the canary's banners by their low scores.
 *
 * Then the rules themselves: minimum samples, scopes, windows, a confidence bound, the pass rate,
 * recovery, repeats, filters, sources, failing actions, and a canary guard that rolls back a canary
 * a rule only marked.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
  type AutomationEvent,
  automationRules,
  deploymentScores,
  markUnhealthy,
  memoryScores,
  openReview,
  type ScoreSample,
  sendWebhook,
  traceScores,
} from '../src/evaluate/automation.js';
import { mediaChecks, mediaJudge } from '../src/evaluate/media.js';
import { AnnotationQueue } from '../src/evaluate/review.js';
import { readImageDimensions } from '../src/images/image-header.js';
import { MemoryAssetStore } from '../src/images/assets.js';
import { catalogedAssetStore, mediaCatalog } from '../src/media/catalog.js';
import { MemoryOperationStore } from '../src/operations/store.js';
import { functionAssistant } from '../src/server/assistant.js';
import { Deployments, watchCanaries } from '../src/server/deployments.js';
import { createAgentServer } from '../src/server/server.js';
import { MemoryServerStore, RUNS_NAMESPACE } from '../src/server/state.js';
import { MemoryStore } from '../src/store/memory.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer } from '../src/tracing/tracer.js';
import type { CompletionRequest, ContentPart } from '../src/types/messages.js';
import type { RunRecord } from '../src/types/server.js';

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};

async function finished(state: MemoryServerStore, count: number): Promise<RunRecord[]> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const runs = state.list<RunRecord>(RUNS_NAMESPACE, { limit: 10_000 });
    if (runs.length >= count && runs.every((run) => run.status === 'succeeded' || run.status === 'failed')) return runs;
    if (Date.now() > deadline) throw new Error('the runs did not finish');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A vision model of the test's: it looks at the banner, and likes one at 16:9. */
const vision = {
  calls: 0,
  async complete(request: CompletionRequest) {
    vision.calls += 1;
    const image = ((request.messages[1]?.content ?? []) as ContentPart[]).find((part) => part.type === 'image') as
      | { source: { base64: string } }
      | undefined;
    const size = image ? readImageDimensions(Buffer.from(image.source.base64, 'base64')) : undefined;
    const wide = size !== undefined && Math.abs(size.width / size.height - 16 / 9) < 0.05;
    return {
      content: JSON.stringify({
        score: wide ? 0.92 : 0.28,
        passed: wide,
        rationale: wide ? 'on brief' : 'not a banner',
      }),
    } as never;
  },
};

test('proof: a canary is rolled back on a media evaluator’s score, once, across two replicas', async () => {
  const state = new MemoryServerStore();
  const traces = new MemoryTraceStore();
  const tracer = new Tracer({ store: traces });
  const catalog = mediaCatalog({ store: new MemoryStore() });
  const assets = catalogedAssetStore(new MemoryAssetStore({ maxEntries: 1_000 }), catalog, { name: 'banners' });
  const draw = (width: number, height: number) =>
    functionAssistant(async (input) => {
      const stat = await assets.put(
        { location: { kind: 'bytes', data: png(width, height) }, mimeType: 'image/png' },
        {
          tenantId: 'acme',
          width,
          height,
          provenance: { provider: 'mock', operation: 'generate', requestId: String((input as { n: number }).n) },
        },
      );
      return { banner: stat.descriptor, brief: (input as { brief: string }).brief };
    });
  const deployments = new Deployments({ state, cacheMs: 0 });
  const app = createAgentServer({
    assistants: {
      designer: deployments.assistant('designer', { v1: draw(1920, 1080), v2: draw(1080, 1080) }, { live: 'v1' }),
    },
    state,
    tracer,
  });
  await deployments.canary('designer', 'v2', 0.5);

  // Shared by both replicas: the run records, the evaluation queue, the rule's firings.
  const operations = new MemoryOperationStore();
  const firings = new MemoryStore();
  const review = new AnnotationQueue({ rubric: [{ key: 'usable', prompt: 'Could this ship?', type: 'boolean' }] });
  const posted: Array<{ body: string; signature: string | null }> = [];
  const events: AutomationEvent[] = [];
  const replica = (name: string) => {
    const mine = new Deployments({ state, cacheMs: 0 });
    const rules = automationRules({
      scores: deploymentScores(mine, 'designer'),
      state: firings,
      onEvent: (event) => events.push(event),
      rules: [
        {
          name: 'banner quality',
          key: 'banner',
          below: 0.6,
          minSamples: 15,
          actions: [
            markUnhealthy({ deployments: mine }),
            openReview(review),
            sendWebhook({
              url: 'https://alerts.test/hooks/media',
              secret: 'shh',
              fetch: (async (_url: string, init: RequestInit) => {
                posted.push({ body: String(init.body), signature: new Headers(init.headers).get('x-nexus-signature') });
                return new Response(null, { status: 204 });
              }) as typeof fetch,
            }),
          ],
        },
      ],
    });
    const worker = mine.evaluationWorker('designer', {
      evaluators: [
        mediaChecks({ key: 'banner-checks', width: { min: 1024 }, aspectRatio: { ratio: 16 / 9 } }),
        mediaJudge({
          client: vision,
          model: 'vision-judge',
          rubric: 'A launch banner: wide, on brand, legible at a glance.',
          key: 'banner',
          assets: { store: assets, tenantId: 'acme' },
        }),
      ],
      operations,
      traces,
      concurrency: 2,
      owner: name,
      onScored: async (scored) => {
        await catalog.attach(scored.run.outputs, scored.scores, { tenantId: 'acme', source: scored.source });
        await rules.observe(scored);
      },
    });
    return { rules, worker };
  };
  const one = replica('replica-1');
  const two = replica('replica-2');

  for (let n = 0; n < 80; n += 1)
    await app.runs.start({ assistant: 'designer', input: { n, brief: `launch banner ${n}` } });
  const runs = await finished(state, 80);
  const served = (revision: string) => runs.filter((run) => run.revision?.id === revision).length;
  assert.ok(served('v2') >= 20 && served('v1') >= 20, `both revisions served: ${served('v1')} and ${served('v2')}`);

  await Promise.all([one.worker.drain(), two.worker.drain()]);
  const reports = [one.worker.report(), two.worker.report()];
  assert.equal(reports[0].scored + reports[1].scored, 80, 'each run scored once between the replicas');

  const deployment = await deployments.get('designer');
  assert.deepEqual(deployment?.traffic, { v1: 1 }, 'the canary was rolled back');
  assert.equal(deployment?.live, 'v1');
  assert.equal(deployment?.unhealthy?.v2?.by, 'rule:banner quality');
  assert.match(
    deployment?.unhealthy?.v2?.reason ?? '',
    /^banner mean 0\.280 is below 0\.6 over \d+ runs of designer@v2$/,
  );
  assert.equal(deployment?.unhealthy?.v1, undefined, 'the live revision is untouched');
  const history = deployment?.history ?? [];
  assert.deepEqual(
    history.slice(0, 2).map((entry) => [entry.action, entry.by, entry.revision]),
    [
      ['rollback', 'rule:banner quality', undefined],
      ['health', 'rule:banner quality', 'v2'],
    ],
    'marked, then rolled back, once',
  );
  assert.equal(history.filter((entry) => entry.action === 'rollback').length, 1);

  const fired = events.filter((event) => event.type === 'fired');
  assert.equal(fired.length, 1, 'fired once between the replicas');
  assert.equal(fired[0]?.scope, 'designer@v2');
  assert.equal(posted.length, 1, 'one webhook');
  const signature = `sha256=${createHmac('sha256', 'shh')
    .update(posted[0]?.body ?? '')
    .digest('hex')}`;
  assert.equal(posted[0]?.signature, signature, 'signed');
  assert.equal(JSON.parse(posted[0]?.body ?? '{}').event.rule, 'banner quality');
  const items = review.list();
  assert.equal(items.length, 5, 'the five worst banners went to people');
  assert.ok(
    items.every((item) => runs.find((run) => run.id === item.subject.runId)?.revision?.id === 'v2'),
    'all from the canary',
  );

  // From here, new runs go to the live revision only.
  for (let n = 80; n < 90; n += 1) await app.runs.start({ assistant: 'designer', input: { n, brief: 'after' } });
  const after = await finished(state, 90);
  assert.equal(after.filter((run) => run.revision?.id === 'v2').length, served('v2'), 'no new run reached the canary');

  // And the catalog finds the canary's banners by the scores the judge gave them.
  const low = await catalog.list({ tenantId: 'acme', scoreBelow: { key: 'banner', below: 0.6 }, limit: 200 });
  assert.equal(low.entries.length, served('v2'));
  assert.ok(
    low.entries.every((entry) => entry.width === 1080 && entry.height === 1080),
    'every low score is a square banner',
  );
  const status = await one.rules.status();
  assert.deepEqual(status.map((item) => [item.scope, item.breached, Boolean(item.firingSince)]).sort(), [
    ['designer@v1', false, false],
    ['designer@v2', true, true],
  ]);
});

test('a canary guard rolls back a canary a rule only marked, and ignores a mark from before it began', async () => {
  let clock = Date.parse('2026-10-18T12:00:00.000Z');
  const now = () => {
    clock += 1_000;
    return new Date(clock);
  };
  const state = new MemoryServerStore();
  const deployments = new Deployments({ state, now });
  deployments.assistant('support', { v1: functionAssistant(() => 1), v2: functionAssistant(() => 2) }, { live: 'v1' });
  // Marked while it took no traffic: a stale mark when it later becomes a canary.
  await deployments.markUnhealthy('support', 'v2', { reason: 'an old failure', by: 'alice' });
  assert.deepEqual((await deployments.get('support'))?.traffic, { v1: 1 }, 'nothing to roll back');
  await deployments.canary('support', 'v2', 0.2);
  const guard = watchCanaries({ deployments, minRuns: 1_000 });
  const [held] = await guard.check();
  assert.equal(held?.action, 'hold', 'a mark older than the canary is ignored');

  // A rule that leaves the rollback to the guard.
  const source = memoryScores();
  for (let n = 0; n < 3; n += 1)
    source.record({
      key: 'q',
      score: 0.1,
      runId: `r${n}`,
      at: now().toISOString(),
      assistant: 'support',
      revision: 'v2',
    });
  await automationRules({
    scores: source,
    rules: [
      {
        name: 'quality',
        key: 'q',
        below: 0.5,
        minSamples: 3,
        actions: [markUnhealthy({ deployments, rollback: false })],
      },
    ],
  }).check();
  assert.deepEqual((await deployments.get('support'))?.traffic, { v1: 0.8, v2: 0.2 }, 'only marked');
  const [decision] = await guard.check();
  guard.stop();
  assert.equal(decision?.action, 'rollback');
  assert.equal(decision?.unhealthy?.by, 'rule:quality');
  assert.deepEqual((await deployments.get('support'))?.traffic, { v1: 1 });
  assert.match(
    (await deployments.get('support'))?.history[0]?.reason ?? '',
    /marked unhealthy by rule:quality: q mean 0\.100/,
  );

  // Marked healthy again, the mark is gone.
  await deployments.markHealthy('support', 'v2', { by: 'alice', reason: 'fixed' });
  assert.equal((await deployments.get('support'))?.unhealthy, undefined);
  await assert.rejects(deployments.markUnhealthy('support', 'v9', { reason: 'x' }), /no revision "v9"/);
});

const sample = (fields: Partial<ScoreSample> & Pick<ScoreSample, 'score'>, n: number): ScoreSample => ({
  key: 'q',
  runId: `run-${n}`,
  at: new Date(Date.parse('2026-10-18T12:00:00.000Z') + n * 1_000).toISOString(),
  assistant: 'a',
  revision: 'v1',
  ...fields,
});

test('a rule fires below its threshold only with enough samples, per scope, within its window', async () => {
  const source = memoryScores();
  const fired: AutomationEvent[] = [];
  const rules = automationRules({
    scores: source,
    rules: [
      { name: 'r', key: 'q', below: 0.5, minSamples: 10, window: 20, actions: [(event) => void fired.push(event)] },
    ],
  });
  for (let n = 0; n < 9; n += 1) source.record(sample({ score: 0.1, revision: 'v2' }, n));
  for (let n = 9; n < 40; n += 1) source.record(sample({ score: 0.9 }, n));
  assert.deepEqual(await rules.check(), [], 'nine samples are not enough');
  source.record(sample({ score: 0.1, revision: 'v2' }, 40));
  const [event] = await rules.check();
  assert.deepEqual([event?.type, event?.scope, event?.samples, event?.revision], ['fired', 'a@v2', 10, 'v2']);
  assert.equal(event?.worst.length, 5);
  assert.equal(fired.length, 1);
  assert.deepEqual(await rules.check(), [], 'not again while it stays below');
  for (let n = 41; n < 61; n += 1) source.record(sample({ score: 0.1, revision: 'v2' }, n));
  assert.deepEqual(await rules.check(), [], 'nor as it falls further');

  // Only the newest twenty runs of v2 are judged: twenty good ones bring it back, though thirty bad
  // ones came before them.
  for (let n = 61; n < 81; n += 1) source.record(sample({ score: 0.95, revision: 'v2' }, n));
  const [recovered] = await rules.check();
  assert.deepEqual([recovered?.type, recovered?.scope], ['recovered', 'a@v2']);
  assert.equal(fired.length, 1, 'recovery runs no action');
  // And a second fall fires again.
  for (let n = 81; n < 101; n += 1) source.record(sample({ score: 0.05, revision: 'v2' }, n));
  assert.equal((await rules.check())[0]?.type, 'fired');
  assert.equal(fired.length, 2);

  // Scores that age out of a window leave too few to judge, which is not a recovery.
  let clock = Date.parse('2026-10-18T12:01:41.000Z');
  const aging = automationRules({
    scores: source,
    now: () => new Date(clock),
    rules: [{ name: 'aging', key: 'q', below: 0.5, minSamples: 10, windowMs: 30_000, by: 'all', actions: [] }],
  });
  assert.equal((await aging.check())[0]?.type, 'fired');
  clock += 25_000;
  assert.deepEqual(await aging.check(), [], 'still below, and too few left to say otherwise');
});

test('a confidence bound, the pass rate, repeats, filters, scopes, and each run counted once', async () => {
  // Noisy and few: the mean is below, but its interval reaches above, so it does not fire.
  const noisy = memoryScores();
  for (const [n, score] of [0.9, 0.1, 0.0, 0.8, 0.1, 0.2].entries()) noisy.record(sample({ score }, n));
  const bounded = automationRules({
    scores: noisy,
    rules: [{ name: 'b', key: 'q', below: 0.5, minSamples: 5, confidence: 0.95, actions: [] }],
  });
  assert.deepEqual(await bounded.check(), []);
  const bare = automationRules({
    scores: noisy,
    rules: [{ name: 'b', key: 'q', below: 0.5, minSamples: 5, actions: [] }],
  });
  const [bareEvent] = await bare.check();
  assert.ok(bareEvent, 'without the bound it fires');
  const steady = memoryScores();
  for (let n = 0; n < 30; n += 1) steady.record(sample({ score: 0.2 + (n % 3) * 0.01 }, n));
  const [sure] = await automationRules({
    scores: steady,
    rules: [{ name: 'b', key: 'q', below: 0.5, minSamples: 5, confidence: 0.99, actions: [] }],
  }).check();
  assert.ok(sure?.interval && sure.interval[1] < 0.5, 'a steady fall clears the bound');

  // The share that passed, from `passed` or a score of at least 0.5.
  const passes = memoryScores();
  for (let n = 0; n < 10; n += 1) passes.record(sample({ score: n < 3 ? 0.9 : 0.6, passed: n < 3 }, n));
  const [rate] = await automationRules({
    scores: passes,
    rules: [{ name: 'p', key: 'q', below: 0.5, minSamples: 10, statistic: 'pass-rate', actions: [] }],
  }).check();
  assert.deepEqual([rate?.statistic, rate?.value], ['pass-rate', 0.3]);

  // A run scored three times counts once, as the mean of its scores.
  const repeated = memoryScores();
  for (let n = 0; n < 3; n += 1) repeated.record(sample({ score: 0.1, runId: 'same' }, n));
  assert.deepEqual(
    await automationRules({
      scores: repeated,
      rules: [{ name: 'x', key: 'q', below: 0.5, minSamples: 2, actions: [] }],
    }).check(),
    [],
  );

  // Filters and scopes.
  const mixed = memoryScores();
  for (let n = 0; n < 20; n += 1) {
    mixed.record(sample({ score: 0.1, source: n % 2 ? 'judge' : 'person', revision: n % 4 < 2 ? 'v1' : 'v2' }, n));
  }
  const scoped = async (rule: Parameters<typeof automationRules>[0]['rules'][number]) =>
    (await automationRules({ scores: mixed, rules: [rule] }).check())
      .map((event) => [event.scope, event.samples])
      .sort();
  assert.deepEqual(await scoped({ name: 's', key: 'q', below: 0.5, minSamples: 5, actions: [] }), [
    ['a@v1', 10],
    ['a@v2', 10],
  ]);
  assert.deepEqual(await scoped({ name: 's', key: 'q', below: 0.5, minSamples: 5, by: 'assistant', actions: [] }), [
    ['a', 20],
  ]);
  assert.deepEqual(
    await scoped({ name: 's', key: 'q', below: 0.5, minSamples: 5, by: 'all', source: 'judge', actions: [] }),
    [['all', 10]],
  );
  assert.deepEqual(
    await scoped({
      name: 's',
      key: 'q',
      below: 0.5,
      minSamples: 5,
      by: (item) => item.source ?? '?',
      where: (item) => item.revision === 'v2',
      actions: [],
    }),
    [
      ['judge', 5],
      ['person', 5],
    ],
  );

  // Fires again after `repeatAfterMs` while it stays below.
  let clock = Date.parse('2026-10-18T13:00:00.000Z');
  const repeating = automationRules({
    scores: mixed,
    now: () => new Date(clock),
    rules: [{ name: 'again', key: 'q', below: 0.5, minSamples: 5, by: 'all', repeatAfterMs: 60_000, actions: [] }],
  });
  assert.equal((await repeating.check()).length, 1);
  clock += 30_000;
  assert.equal((await repeating.check()).length, 0);
  clock += 31_000;
  assert.equal((await repeating.check()).length, 1);
});

test('two replicas judging at once act once; a failing action is reported and the others still run', async () => {
  const source = memoryScores();
  for (let n = 0; n < 20; n += 1) source.record(sample({ score: 0.1 }, n));
  const state = new MemoryStore();
  let acted = 0;
  const errors: unknown[] = [];
  const make = () =>
    automationRules({
      scores: source,
      state,
      onError: (error) => errors.push(error),
      rules: [
        {
          name: 'shared',
          key: 'q',
          below: 0.5,
          minSamples: 5,
          actions: [
            () => {
              throw new Error('the pager is down');
            },
            sendWebhook({
              url: 'https://hooks.test',
              fetch: (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
            }),
            () => {
              acted += 1;
            },
          ],
        },
      ],
    });
  const results = await Promise.all([make().check(), make().check(), make().check()]);
  assert.equal(results.flat().length, 1, 'one replica claimed it');
  assert.equal(acted, 1);
  assert.deepEqual(
    errors.map((error) => (error as Error).message),
    ['the pager is down', 'The webhook at https://hooks.test answered 500'],
  );
  // Without a shared store, each process keeps its own firings.
  const apart = await Promise.all([
    automationRules({
      scores: source,
      rules: [{ name: 'own', key: 'q', below: 0.5, minSamples: 5, actions: [] }],
    }).check(),
    automationRules({
      scores: source,
      rules: [{ name: 'own', key: 'q', below: 0.5, minSamples: 5, actions: [] }],
    }).check(),
  ]);
  assert.equal(apart.flat().length, 2);
});

test('scores read from a trace store, and fed by an online evaluation through observe()', async () => {
  const traces = new MemoryTraceStore();
  for (let n = 0; n < 12; n += 1) {
    traces.save({
      id: `run-${n}`,
      traceId: `t-${n}`,
      name: 'draw',
      kind: 'image',
      status: 'ok',
      startedAt: new Date(Date.parse('2026-10-18T12:00:00.000Z') + n).toISOString(),
      metadata: { nexus: { assistant: 'designer', revision: n % 2 ? 'v2' : 'v1' } },
      feedback: [{ key: 'q', score: n % 2 ? 0.2 : 0.9, source: 'judge', createdAt: '2026-10-18T12:01:00.000Z' }],
    });
  }
  const [event] = await automationRules({
    scores: traceScores(traces, { kind: 'image' }),
    rules: [{ name: 't', key: 'q', below: 0.5, minSamples: 6, actions: [] }],
  }).check();
  assert.deepEqual([event?.scope, event?.samples, Number(event?.value.toFixed(6))], ['designer@v2', 6, 0.2]);

  // With no source given, observe() keeps what it hears and judges at once.
  const heard: AutomationEvent[] = [];
  const rules = automationRules({
    rules: [{ name: 'o', key: 'q', below: 0.5, minSamples: 3, by: 'all', actions: [(item) => void heard.push(item)] }],
  });
  for (let n = 0; n < 3; n += 1) {
    await rules.observe({
      run: { id: `r${n}`, traceId: 't', name: 'x', kind: 'model', status: 'ok', startedAt: '2026-10-18T12:00:00.000Z' },
      scores: [
        { key: 'q', score: 0.1 },
        { key: 'other', score: 1 },
      ],
      source: 'online',
      operationId: `op-${n}`,
    });
  }
  assert.equal(heard.length, 1);
  assert.equal(heard[0]?.samples, 3);
});
