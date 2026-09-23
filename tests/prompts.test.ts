import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createDataset, MemoryExperimentStore } from '../src/evaluate/datasets.js';
import { contains } from '../src/evaluate/evaluators.js';
import { PostgresPromptStore, postgresMigration, type PostgresLikeClient } from '../src/postgres/index.js';
import {
  definePrompt,
  PromptDefinitionError,
  PromptNotFoundError,
  PromptPromotionError,
  PromptRenderError,
  promptVersion,
} from '../src/prompts/index.js';
import { PromptClient } from '../src/prompts/client.js';
import { FilePromptStore } from '../src/prompts/file.js';
import { type RedisPromptLikeClient, RedisPromptStore } from '../src/prompts/redis.js';
import {
  evaluatePrompt,
  experimentGate,
  formatPromptDiff,
  MemoryPromptStore,
  PromptRegistry,
  servedByGate,
  verifyPromptWebhook,
} from '../src/prompts/registry-entry.js';
import { traceModelClient } from '../src/tracing/instrument.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer } from '../src/tracing/tracer.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { PromptLabel, PromptStore, PromptVersion } from '../src/types/prompts.js';
import type { NexusResponse } from '../src/types/response.js';

const summarize = definePrompt({
  name: 'summarize',
  messages: [
    { role: 'system', content: 'Summarize {{kind}} for {{audience}}. {{> tone}}' },
    { placeholder: 'history', optional: true },
    { role: 'user', content: '{{text}} (by {{author.name}})' },
  ],
  partials: { tone: 'Be {{tone}}.' },
  defaults: { audience: 'engineers', tone: 'brief' },
  config: { model: 'gpt-5.4-mini', temperature: 0, metadata: { team: 'docs' } },
});

function respond(content: (request: CompletionRequest) => string) {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    async complete(request: CompletionRequest): Promise<NexusResponse> {
      requests.push(request);
      return { content: content(request), role: 'assistant', finishReason: 'stop', meta: {} as NexusResponse['meta'] };
    },
  };
}

function clock(start = Date.parse('2026-09-23T00:00:00Z')) {
  let now = start;
  return { now: () => new Date(now), ms: () => now, tick: (ms: number) => (now += ms) };
}

// ── Templates ──────────────────────────────────────────────────────

test('a prompt renders variables, dot paths, partials, defaults, placeholders, and configuration', () => {
  const request = summarize.render({
    kind: 'incident reports',
    text: 'The API was down.',
    author: { name: 'Ada' },
    history: [{ role: 'user', content: 'earlier' }],
  });
  assert.deepEqual(request.messages, [
    { role: 'system', content: 'Summarize incident reports for engineers. Be brief.' },
    { role: 'user', content: 'earlier' },
    { role: 'user', content: 'The API was down. (by Ada)' },
  ]);
  assert.equal(request.model, 'gpt-5.4-mini');
  assert.equal(request.temperature, 0);
  assert.deepEqual(request.metadata, { team: 'docs', prompt: { name: 'summarize' } });
  assert.deepEqual(summarize.variables, ['audience', 'author', 'history', 'kind', 'text', 'tone']);
});

test('overrides replace configuration, and objects render as JSON', () => {
  const prompt = definePrompt({ name: 'json', messages: [{ role: 'user', content: 'Data: {{data}}' }] });
  const request = prompt.render({ data: { a: 1 } }, { overrides: { model: 'claude-sonnet-4', maxTokens: 10 } });
  assert.equal(request.messages[0]?.content, 'Data: {"a":1}');
  assert.equal(request.model, 'claude-sonnet-4');
  assert.equal(request.maxTokens, 10);
  assert.equal(prompt.render({ data: 1 }).model, 'auto');
  assert.equal(prompt.render({ data: 1 }, { model: 'm' }).model, 'm');
});

test('missing variables fail by default, or render empty or as written', () => {
  assert.throws(
    () => summarize.render({ kind: 'k' } as never),
    (error: unknown) => error instanceof PromptRenderError && error.missing.join() === 'text,author.name',
  );
  const prompt = definePrompt({ name: 'm', messages: [{ role: 'user', content: 'a {{x}} b' }] });
  assert.equal(prompt.render({} as never, { missing: 'empty' }).messages[0]?.content, 'a  b');
  assert.equal(prompt.render({} as never, { missing: 'keep' }).messages[0]?.content, 'a {{x}} b');
});

test('a required placeholder must be supplied, and must be messages', () => {
  const prompt = definePrompt({ name: 'chat', messages: [{ placeholder: 'history' }] });
  assert.throws(() => prompt.render({}), PromptRenderError);
  assert.throws(() => prompt.render({ history: 'nope' as never }), PromptDefinitionError);
});

test('definitions are checked once, when the prompt is defined', () => {
  assert.throws(
    () => definePrompt({ name: 'x', messages: [{ role: 'user', content: '{{> missing}}' }] }),
    /unknown partial "missing"/,
  );
  assert.throws(
    () =>
      definePrompt({
        name: 'x',
        messages: [{ role: 'user', content: '{{> a}}' }],
        partials: { a: '{{> b}}', b: '{{> a}}' },
      }),
    /partial cycle: a > b > a/,
  );
  assert.throws(
    () => definePrompt({ name: 'x', messages: [{ role: 'user', content: '{{ not valid }}' }] }),
    /invalid tag/,
  );
});

test('the same content is the same version, wherever it is computed', async () => {
  const a = await promptVersion({
    name: 'n',
    messages: [{ role: 'user', content: 'hi' }],
    config: { temperature: 0, model: 'm' },
  });
  const b = await promptVersion({
    name: 'n',
    config: { model: 'm', temperature: 0 },
    messages: [{ content: 'hi', role: 'user' }],
  });
  const described = await promptVersion({
    name: 'n',
    messages: [{ role: 'user', content: 'hi' }],
    config: { temperature: 0, model: 'm' },
    metadata: { owner: 'docs' },
  });
  const changed = await promptVersion({ name: 'n', messages: [{ role: 'user', content: 'hi!' }] });
  assert.match(a, /^p[0-9a-f]{12}$/);
  assert.equal(a, b);
  assert.equal(a, described, 'metadata is not part of the version');
  assert.notEqual(a, changed);
});

// ── Registry ───────────────────────────────────────────────────────

test('committing unchanged content returns the same version and records nothing new', async () => {
  const registry = new PromptRegistry({ now: clock().now });
  const first = await registry.commit(summarize, { message: 'initial', author: 'ada' });
  const again = await registry.commit(summarize.definition);
  assert.equal(first.version, again.version);
  assert.equal(first.version, await summarize.version());
  assert.equal((await registry.history('summarize')).length, 1);

  const edited = definePrompt({
    ...summarize.definition,
    name: 'summarize',
    messages: [{ role: 'user', content: '{{text}}' }],
  });
  const second = await registry.commit(edited, { label: 'staging' });
  assert.equal(second.parent, first.version);
  assert.equal((await registry.get('summarize')).version, second.version);
  assert.equal((await registry.get('summarize', 'staging')).version, second.version);
  assert.equal((await registry.get('summarize', first.version)).version, first.version);
  await assert.rejects(registry.get('summarize', 'production'), PromptNotFoundError);
  assert.deepEqual(await registry.names(), ['summarize']);
});

test('a promotion is refused until an experiment for that exact version passes', async () => {
  const experiments = new MemoryExperimentStore();
  const registry = new PromptRegistry({
    gates: {
      production: [servedByGate('staging'), experimentGate({ store: experiments, thresholds: { contains: 1 } })],
    },
  });
  const v1 = await registry.commit(summarize, { label: 'staging' });

  await assert.rejects(
    registry.promote('summarize', { from: 'staging', to: 'production' }),
    (error: unknown) =>
      error instanceof PromptPromotionError &&
      error.results.some(
        (result) => result.gate === 'experiment' && !result.ok && /no experiment/.test(result.reason ?? ''),
      ),
  );
  await assert.rejects(registry.get('summarize', 'production'), PromptNotFoundError, 'nothing moved');

  const dataset = createDataset({
    name: 'reports',
    examples: [{ inputs: { kind: 'reports', text: 'down', author: { name: 'A' } }, expected: 'summary' }],
  });
  const client = respond(() => 'a summary');
  const experiment = await evaluatePrompt(v1, dataset, [contains(['summary'])], { client, store: experiments });
  assert.deepEqual(experiment.metadata?.prompt, { name: 'summarize', version: v1.version });
  assert.equal(
    client.requests[0]?.metadata?.prompt && (client.requests[0].metadata.prompt as { version: string }).version,
    v1.version,
  );

  const promoted = await registry.promote('summarize', { from: 'staging', to: 'production', by: 'ada' });
  assert.equal(promoted.changed, true);
  assert.equal(promoted.label.version, v1.version);
  assert.ok(promoted.results.every((result) => result.ok));
  assert.equal((await registry.promote('summarize', { from: 'staging', to: 'production' })).changed, false);
});

test('a gate can refuse a regression against the version being replaced', async () => {
  const experiments = new MemoryExperimentStore();
  const registry = new PromptRegistry({
    gates: { production: [experimentGate({ store: experiments, noRegression: true })] },
  });
  const good = await registry.commit(summarize);
  const worse = await registry.commit(
    definePrompt({ name: 'summarize', messages: [{ role: 'user', content: '{{text}}' }] }),
  );
  const dataset = createDataset({
    name: 'reports',
    examples: Array.from({ length: 12 }, (_, index) => ({
      inputs: { kind: 'r', text: `t${index}`, author: { name: 'A' } },
      expected: 'summary',
    })),
  });
  await evaluatePrompt(good, dataset, [contains(['summary'])], {
    client: respond(() => 'summary'),
    store: experiments,
  });
  await registry.promote('summarize', { version: good.version, to: 'production' });
  await evaluatePrompt(worse, dataset, [contains(['summary'])], {
    client: respond(() => 'nothing'),
    store: experiments,
  });

  await assert.rejects(
    registry.promote('summarize', { version: worse.version, to: 'production' }),
    /regressed against/,
  );
  const forced = await registry.promote('summarize', {
    version: worse.version,
    to: 'production',
    force: true,
    note: 'hotfix',
  });
  assert.equal(forced.label.version, worse.version);
  const [entry] = await registry.history('summarize', { label: 'production' });
  assert.match(entry?.note ?? '', /hotfix; forced past experiment/);
});

test('rollback moves a label back, and history records every move', async () => {
  const registry = new PromptRegistry();
  const v1 = await registry.commit(summarize);
  const v2 = await registry.commit(
    definePrompt({ name: 'summarize', messages: [{ role: 'user', content: 'v2 {{text}}' }] }),
  );
  await registry.label('summarize', 'production', v1.version);
  await registry.label('summarize', 'production', v2.version, { by: 'ada' });
  const rolled = await registry.rollback('summarize', 'production', { by: 'bob', note: 'bad output' });
  assert.equal(rolled.version, v1.version);
  const actions = (await registry.history('summarize')).map((entry) => `${entry.action}:${entry.version}`);
  assert.deepEqual(actions, [
    `rollback:${v1.version}`,
    `label:${v2.version}`,
    `label:${v1.version}`,
    `commit:${v2.version}`,
    `commit:${v1.version}`,
  ]);
  await assert.rejects(registry.rollback('summarize', 'missing'), PromptNotFoundError);
});

test('a diff shows changed lines and configuration', async () => {
  const registry = new PromptRegistry();
  const a = await registry.commit(
    definePrompt({ name: 'p', messages: [{ role: 'system', content: 'one\ntwo' }], config: { temperature: 0 } }),
  );
  const b = await registry.commit(
    definePrompt({ name: 'p', messages: [{ role: 'system', content: 'one\nthree' }], config: { temperature: 0.5 } }),
  );
  const diff = await registry.diff('p', a.version, b.version);
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.messages[0]?.lines, [
    { op: '=', text: 'one' },
    { op: '-', text: 'two' },
    { op: '+', text: 'three' },
  ]);
  assert.deepEqual(diff.config, [{ key: 'temperature', before: 0, after: 0.5 }]);
  assert.match(formatPromptDiff(diff), /- two\n\+ three\n@@ config.temperature: 0 → 0.5/);
});

test('a split serves each key the same arm every time, in proportion to the weights', async () => {
  const registry = new PromptRegistry();
  const v1 = await registry.commit(summarize);
  const v2 = await registry.commit(definePrompt({ name: 'summarize', messages: [{ role: 'user', content: 'v2' }] }));
  await registry.split('summarize', 'production', [
    { ref: v1.version, weight: 3 },
    { ref: v2.version, weight: 1 },
  ]);
  const counts = [0, 0];
  for (let user = 0; user < 400; user += 1) {
    const first = await registry.resolve('summarize', 'production', { key: `user-${user}` });
    const second = await registry.resolve('summarize', 'production', { key: `user-${user}` });
    assert.equal(first.version.version, second.version.version);
    counts[first.reference.variant as number] += 1;
  }
  assert.ok((counts[0] as number) > 250 && (counts[0] as number) < 350, `control served ${counts[0]} of 400`);
  assert.equal((await registry.get('summarize', 'production')).version, v1.version, 'get() returns the control');
  const rendered = await registry.render(
    'summarize',
    { text: 'x' },
    { ref: 'production', key: 'user-1', missing: 'empty' },
  );
  assert.equal((rendered.metadata.prompt as { label: string }).label, 'production');
  await assert.rejects(registry.split('summarize', 'production', []), RangeError);
});

test('webhooks are signed, and a failing receiver never fails the change', async () => {
  const deliveries: Array<{ body: string; signature: string }> = [];
  const errors: unknown[] = [];
  const registry = new PromptRegistry({
    webhooks: [
      {
        url: 'https://hooks.test/prompts',
        secret: 'shh',
        fetch: (async (_url: string, init: RequestInit) => {
          deliveries.push({
            body: init.body as string,
            signature: (init.headers as Record<string, string>)['x-nexus-signature'] as string,
          });
          return new Response('ok');
        }) as typeof fetch,
      },
      {
        url: 'https://down.test',
        secret: 's',
        fetch: (async () => new Response('no', { status: 500 })) as typeof fetch,
      },
    ],
    onWebhookError: (error) => errors.push(error),
  });
  const version = await registry.commit(summarize);
  assert.equal(deliveries.length, 0, 'commits are not delivered by default');
  await registry.promote('summarize', { version: version.version, to: 'production' });
  assert.equal(deliveries.length, 1);
  assert.equal(JSON.parse(deliveries[0]?.body as string).type, 'prompt.promote');
  assert.ok(verifyPromptWebhook(deliveries[0]?.body as string, deliveries[0]?.signature, 'shh'));
  assert.equal(verifyPromptWebhook(deliveries[0]?.body as string, deliveries[0]?.signature, 'wrong'), false);
  assert.equal(errors.length, 1);
});

// ── Serving ────────────────────────────────────────────────────────

function countingSource(store: PromptStore) {
  const calls = { labels: 0, versions: 0, fail: false };
  return {
    calls,
    source: {
      getLabel: async (name: string, label: string) => {
        calls.labels += 1;
        if (calls.fail) throw new Error('registry unreachable');
        return store.getLabel(name, label);
      },
      getVersion: async (name: string, version: string) => {
        calls.versions += 1;
        if (calls.fail) throw new Error('registry unreachable');
        return store.getVersion(name, version);
      },
    },
  };
}

test('the client caches, revalidates in the background, and survives an outage', async () => {
  const registry = new PromptRegistry();
  const v1 = await registry.commit(summarize, { label: 'production' });
  const time = clock();
  const errors: unknown[] = [];
  const { calls, source } = countingSource(registry.store);
  const client = new PromptClient({
    source,
    ttlMs: 1_000,
    staleWhileRevalidateMs: 1_000,
    now: time.ms,
    onError: (e) => errors.push(e),
  });

  assert.equal((await client.get('summarize')).from, 'source');
  assert.equal((await client.get('summarize')).from, 'cache');
  assert.equal(calls.labels, 1);

  const v2 = await registry.commit(
    definePrompt({ name: 'summarize', messages: [{ role: 'user', content: 'v2 {{text}}' }] }),
  );
  await registry.label('summarize', 'production', v2.version);
  time.tick(1_500);
  const stale = await client.get('summarize');
  assert.equal(stale.from, 'stale');
  assert.equal(stale.version.version, v1.version, 'answered from cache while refreshing');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await client.get('summarize')).version.version, v2.version, 'the background refresh landed');

  calls.fail = true;
  time.tick(10_000);
  const served = await client.get('summarize');
  assert.equal(served.from, 'stale');
  assert.equal(served.version.version, v2.version, 'the last version seen keeps serving');
  assert.equal(errors.length, 1);
  const request = await client.render('summarize', { text: 'x' });
  assert.equal(request.messages[0]?.content, 'v2 x');
  assert.deepEqual(request.metadata.prompt, { name: 'summarize', version: v2.version, label: 'production' });
});

test('a cold client serves the bundled fallback when the registry is down', async () => {
  const { calls, source } = countingSource(new MemoryPromptStore());
  calls.fail = true;
  const client = new PromptClient({ source, fallbacks: [summarize] });
  const served = await client.get('summarize');
  assert.equal(served.from, 'fallback');
  assert.equal(served.version.version, await summarize.version());
  const strict = new PromptClient({ source });
  await assert.rejects(strict.get('summarize'), /registry unreachable/);
});

test('concurrent cold calls share one refresh', async () => {
  const registry = new PromptRegistry();
  await registry.commit(summarize, { label: 'production' });
  const { calls, source } = countingSource(registry.store);
  const client = new PromptClient({ source });
  await Promise.all(Array.from({ length: 10 }, () => client.get('summarize')));
  assert.equal(calls.labels, 1);
  assert.equal(calls.versions, 1);
});

test('a traced model call records the prompt version it ran', async () => {
  const store = new MemoryTraceStore();
  const tracer = new Tracer({ store });
  const registry = new PromptRegistry();
  const version = await registry.commit(summarize, { label: 'production' });
  const client = traceModelClient(
    respond(() => 'ok'),
    tracer,
  );
  await client.complete(
    await registry.render('summarize', { kind: 'k', text: 't', author: { name: 'A' } }, { ref: 'production' }),
  );
  const [run] = await store.query({});
  assert.deepEqual(run?.metadata?.prompt, { name: 'summarize', version: version.version, label: 'production' });
});

// ── Store contract, every adapter ──────────────────────────────────

let db: PGlite;
let directory: string;
before(async () => {
  db = new PGlite();
  await db.waitReady;
  directory = await mkdtemp(path.join(tmpdir(), 'nexus-prompts-'));
});
after(async () => {
  await db.close();
  await rm(directory, { recursive: true, force: true });
});

function fakeRedis(useEval: boolean): RedisPromptLikeClient {
  const hashes = new Map<string, Map<string, string>>();
  const lists = new Map<string, string[]>();
  const sets = new Map<string, Set<string>>();
  const hash = (key: string) => {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key) as Map<string, string>;
  };
  const list = (key: string) => {
    if (!lists.has(key)) lists.set(key, []);
    return lists.get(key) as string[];
  };
  const set = (key: string) => {
    if (!sets.has(key)) sets.set(key, new Set());
    return sets.get(key) as Set<string>;
  };
  const client: RedisPromptLikeClient = {
    hsetnx: (key, field, value) => {
      if (hash(key).has(field)) return 0;
      hash(key).set(field, value);
      return 1;
    },
    hset: (key, field, value) => void hash(key).set(field, value),
    hget: (key, field) => hash(key).get(field) ?? null,
    hvals: (key) => [...hash(key).values()],
    hdel: (key, field) => (hash(key).delete(field) ? 1 : 0),
    lpush: (key, value) => list(key).unshift(value),
    lrange: (key, start, stop) => list(key).slice(start, stop === -1 ? undefined : stop + 1),
    ltrim: (key, start, stop) => void lists.set(key, list(key).slice(start, stop + 1)),
    sadd: (key, member) => void set(key).add(member),
    smembers: (key) => [...(sets.get(key) ?? [])],
  };
  if (useEval) {
    // Emulates the compare-and-set script.
    client.eval = (_script, _keys, key, field, encoded, mode, expected) => {
      const current = hash(key as string).get(field as string);
      if (mode === '1' && current) return 0;
      if (mode === '2' && (!current || (JSON.parse(current) as PromptLabel).version !== expected)) return 0;
      hash(key as string).set(field as string, encoded as string);
      return 1;
    };
  }
  return client;
}

async function stores(): Promise<Array<[string, PromptStore]>> {
  const postgres = new PostgresPromptStore(db as unknown as PostgresLikeClient, { table: `prompts_${Date.now()}` });
  await postgres.migrate();
  await postgres.migrate();
  return [
    ['memory', new MemoryPromptStore()],
    ['file', new FilePromptStore(path.join(directory, String(Date.now())))],
    ['redis (eval)', new RedisPromptStore(fakeRedis(true))],
    ['redis (fallback)', new RedisPromptStore(fakeRedis(false))],
    ['postgres', postgres],
  ];
}

function version(id: string, createdAt: string): PromptVersion {
  return { name: 'p', version: id, variables: [], createdAt, messages: [{ role: 'user', content: id }] };
}

test('every prompt store keeps versions, compare-and-sets labels, and orders history', async () => {
  for (const [name, store] of await stores()) {
    await store.saveVersion(version('p000000000001', '2026-09-23T00:00:01Z'));
    await store.saveVersion(version('p000000000002', '2026-09-23T00:00:02Z'));
    await store.saveVersion({ ...version('p000000000001', '2026-09-23T00:00:09Z'), message: 'dup' });
    assert.deepEqual(
      (await store.listVersions('p')).map((item) => item.version),
      ['p000000000002', 'p000000000001'],
      name,
    );
    assert.equal((await store.getVersion('p', 'p000000000001'))?.message, undefined, `${name}: first save wins`);
    assert.equal(await store.getVersion('p', 'nope'), undefined, name);

    const label = (v: string): PromptLabel => ({
      name: 'p',
      label: 'production',
      version: v,
      updatedAt: '2026-09-23T00:00:00Z',
    });
    assert.equal(await store.setLabel(label('p000000000001'), null), true, name);
    assert.equal(await store.setLabel(label('p000000000002'), null), false, `${name}: must not exist`);
    assert.equal(await store.setLabel(label('p000000000002'), 'p000000000009'), false, `${name}: stale expectation`);
    assert.equal(await store.setLabel(label('p000000000002'), 'p000000000001'), true, name);
    assert.equal((await store.getLabel('p', 'production'))?.version, 'p000000000002', name);
    await store.setLabel({ ...label('p000000000001'), label: 'canary' });
    assert.deepEqual(
      (await store.listLabels('p')).map((item) => item.label),
      ['canary', 'production'],
      name,
    );
    assert.equal(await store.deleteLabel('p', 'canary'), true, name);
    assert.equal(await store.deleteLabel('p', 'canary'), false, name);

    await store.appendHistory({ name: 'p', action: 'commit', version: 'p000000000001', at: '1' });
    await store.appendHistory({ name: 'p', action: 'label', label: 'production', version: 'p000000000002', at: '2' });
    await store.appendHistory({ name: 'p', action: 'commit', version: 'p000000000002', at: '3' });
    assert.deepEqual(
      (await store.listHistory('p')).map((entry) => entry.at),
      ['3', '2', '1'],
      name,
    );
    assert.deepEqual(
      (await store.listHistory('p', { label: 'production' })).map((entry) => entry.at),
      ['2'],
      name,
    );
    assert.deepEqual(
      (await store.listHistory('p', { limit: 1 })).map((entry) => entry.at),
      ['3'],
      name,
    );
    assert.deepEqual(await store.listNames(), ['p'], name);
  }
});

test('a registry on Postgres promotes and serves across instances', async () => {
  const store = new PostgresPromptStore(db as unknown as PostgresLikeClient, { table: `shared_${Date.now()}` });
  await store.migrate();
  const writer = new PromptRegistry({ store });
  const version = await writer.commit(summarize, { label: 'production' });
  const reader = new PromptClient({
    source: new PostgresPromptStore(db as unknown as PostgresLikeClient, {
      table: (store as unknown as { options: { table: string } }).options.table,
    }),
  });
  assert.equal((await reader.get('summarize')).version.version, version.version);
  assert.match(postgresMigration({ adapters: ['prompts'] }), /nexus_prompt_versions/);
});
