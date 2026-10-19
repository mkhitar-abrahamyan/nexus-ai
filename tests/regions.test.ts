/**
 * Agent servers across regions, and the proof that closes 2.13: a tenant pinned to its regions never
 * reaches anything outside them across a regional failover, and a key rotated in the middle of a run
 * is the one the next call uses.
 *
 * Three regions, each an agent server with its own state, its own trace store, and a provider of its
 * own, behind a regional gateway; every tenant's provider key comes from one secret manager. A run of
 * four model calls in the EU has its key rotated, and revoked, after the second: the third is answered
 * on the new key, and so is every call after. Then the home region goes down: the tenant's new work
 * goes to the other EU region, its existing thread waits for its own region rather than moving, a
 * tenant held to the region that is down waits too, and nothing of either reaches the US: no request,
 * no record, no trace, no provider call.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { NexusAI } from '../src/core/nexus.js';
import { memorySecrets, tenantCredentials } from '../src/credentials/index.js';
import { residency } from '../src/residency/index.js';
import { functionAssistant } from '../src/server/assistant.js';
import { regionalGateway } from '../src/server/regions.js';
import { createAgentServer } from '../src/server/server.js';
import { MemoryServerStore, RUNS_NAMESPACE } from '../src/server/state.js';
import { traceModelClient } from '../src/tracing/instrument.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer } from '../src/tracing/tracer.js';
import type { RunRecord, ThreadRecord } from '../src/types/server.js';

const REGIONS = ['eu-west', 'eu-central', 'us-east'] as const;
type Region = (typeof REGIONS)[number];

/** Keys the providers take, and which tenant each belongs to. */
const live = new Set(['sk-acme-1', 'sk-initech-1', 'sk-umbrella-1']);
const owner = (key: string) => /^sk-([a-z]+)-/.exec(key)?.[1] ?? 'shared';

/** A provider per region, recording each key that reaches it. */
const providers = Object.fromEntries(REGIONS.map((region) => [region, { url: '', seen: [] as string[] }])) as Record<
  Region,
  { url: string; seen: string[] }
>;
const listeners: Array<ReturnType<typeof createServer>> = [];

before(async () => {
  for (const region of REGIONS) {
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        const key = (request.headers.authorization ?? '').replace(/^Bearer /, '');
        providers[region].seen.push(key);
        if (!live.has(key)) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${key}.` } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'c',
            object: 'chat.completion',
            created: 1,
            model: 'gpt-5',
            choices: [{ index: 0, message: { role: 'assistant', content: `${region}:${key}` }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    providers[region].url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    listeners.push(server);
  }
});
after(() => {
  for (const server of listeners) server.close();
});

const policy = residency({
  regions: { 'eu-west': {}, 'eu-central': {}, 'us-east': {} },
  tenants: { acme: ['eu-west', 'eu-central'], umbrella: 'eu-west', initech: 'us-east' },
  unassigned: 'refuse',
});

/** Steps of a run that wait for the test, so a key can be rotated between two of its calls. */
const gates = new Map<number, Promise<void>>();

function region(name: Region, secrets: ReturnType<typeof memorySecrets>) {
  const state = new MemoryServerStore();
  const traces = new MemoryTraceStore();
  const tracer = new Tracer({ store: traces });
  const ai = traceModelClient(
    new NexusAI({
      providers: { openai: { apiKey: `sk-shared-${name}`, baseUrl: providers[name].url } },
      routing: { strategy: 'direct', defaultModel: 'gpt-5' },
      security: 'off',
      lifecycle: { credentials: tenantCredentials({ secrets }) },
    } as never),
    tracer,
  );
  const assistant = functionAssistant(async (input, context) => {
    const answers: string[] = [];
    for (let step = 0; step < ((input as { steps?: number }).steps ?? 1); step += 1) {
      await gates.get(step);
      const response = await ai.complete({
        model: 'gpt-5',
        messages: [{ role: 'user', content: `step ${step}` }],
        tenantId: context.principal?.tenantId,
      });
      answers.push(response.content);
    }
    return { answers };
  });
  const server = createAgentServer({
    assistants: { support: assistant },
    state,
    tracer,
    region: name,
    residency: policy,
    authenticate: (request: Request) => {
      const tenantId = request.headers.get('x-tenant');
      return tenantId ? { tenantId } : undefined;
    },
  });
  return { name, server, state, traces, down: false };
}

test('proof: a tenant never leaves its regions across a regional failover, and a rotated key is used by the next call', async () => {
  const secrets = memorySecrets({
    'acme/openai': 'sk-acme-1',
    'initech/openai': 'sk-initech-1',
    'umbrella/openai': 'sk-umbrella-1',
  });
  const regions = Object.fromEntries(REGIONS.map((name) => [name, region(name, secrets)])) as Record<
    Region,
    ReturnType<typeof region>
  >;
  // A region that is down refuses connections, to the gateway's checks and its requests alike.
  const reach = (name: Region) => async (request: Request) => {
    if (regions[name].down) throw new Error(`connect ECONNREFUSED ${name}`);
    return regions[name].server.handle(request);
  };
  const gateway = regionalGateway({
    regions: Object.fromEntries(REGIONS.map((name) => [name, { handle: reach(name) }])),
    residency: policy,
    tenantOf: (request) => request.headers.get('x-tenant') ?? undefined,
  });
  const call = (tenant: string, method: string, path: string, body?: unknown) =>
    gateway.handle(
      new Request(`http://gateway.test${path}`, {
        method,
        headers: { 'x-tenant': tenant, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const finished = async (tenant: string, runId: string): Promise<RunRecord> => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const run = (await (await call(tenant, 'GET', `/runs/${encodeURIComponent(runId)}`)).json()) as RunRecord;
      if (run.status === 'succeeded' || run.status === 'failed') return run;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`run ${runId} did not finish`);
  };

  // acme's home region is eu-west: its thread, and every id under it, says so.
  const created = await call('acme', 'POST', '/threads', { assistant: 'support' });
  assert.equal(created.headers.get('x-nexus-region'), 'eu-west');
  const thread = (await created.json()) as ThreadRecord;
  assert.match(thread.id, /^eu-west~thread-/);
  assert.equal(thread.region, 'eu-west');

  // A run of four model calls. After the second, acme's key is rotated in the secret manager and
  // revoked by the provider.
  let release: () => void = () => undefined;
  gates.set(2, new Promise<void>((resolve) => (release = resolve)));
  const started = await call('acme', 'POST', `/threads/${encodeURIComponent(thread.id)}/runs`, { input: { steps: 4 } });
  const runId = ((await started.json()) as RunRecord).id;
  while (providers['eu-west'].seen.filter((key) => owner(key) === 'acme').length < 2) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  secrets.set('acme/openai', 'sk-acme-2');
  live.add('sk-acme-2');
  live.delete('sk-acme-1');
  release();
  const run = await finished('acme', runId);
  gates.clear();
  assert.equal(run.status, 'succeeded');
  assert.equal(run.region, 'eu-west');
  assert.deepEqual(
    (run.output as { answers: string[] }).answers,
    ['eu-west:sk-acme-1', 'eu-west:sk-acme-1', 'eu-west:sk-acme-2', 'eu-west:sk-acme-2'],
    'the call after the rotation, and every call after it, on the new key',
  );
  assert.deepEqual(
    providers['eu-west'].seen.filter((key) => owner(key) === 'acme'),
    ['sk-acme-1', 'sk-acme-1', 'sk-acme-1', 'sk-acme-2', 'sk-acme-2'],
    'the old key refused once, and the call made once more on the new one',
  );

  // umbrella, held to eu-west, works there too while it is up.
  const umbrellaThread = (await (
    await call('umbrella', 'POST', '/threads', { assistant: 'support' })
  ).json()) as ThreadRecord;
  assert.match(umbrellaThread.id, /^eu-west~/);

  // eu-west goes down.
  regions['eu-west'].down = true;
  const health = await gateway.check();
  assert.equal(health['eu-west']?.up, false);

  // acme's new work fails over to the other EU region, never to the US.
  const moved = await call('acme', 'POST', '/threads', { assistant: 'support' });
  assert.equal(moved.headers.get('x-nexus-region'), 'eu-central');
  const movedThread = (await moved.json()) as ThreadRecord;
  const movedRun = (await (
    await call('acme', 'POST', `/threads/${encodeURIComponent(movedThread.id)}/runs`, { input: { steps: 1 } })
  ).json()) as RunRecord;
  assert.deepEqual(((await finished('acme', movedRun.id)).output as { answers: string[] }).answers, [
    'eu-central:sk-acme-2',
  ]);
  // A stateless run fails over the same way.
  const stateless = await call('acme', 'POST', '/runs', { assistant: 'support', input: { steps: 1 } });
  assert.equal(stateless.headers.get('x-nexus-region'), 'eu-central');

  // Its thread in eu-west waits for eu-west: its data is there and nowhere else.
  const waiting = await call('acme', 'GET', `/threads/${encodeURIComponent(thread.id)}`);
  assert.equal(waiting.status, 503);
  assert.equal(((await waiting.json()) as { error: { code: string } }).error.code, 'REGION_DOWN');
  assert.ok(waiting.headers.get('retry-after'), 'with when to try again');

  // umbrella may reach eu-west alone: it waits too, rather than going anywhere else.
  const held = await call('umbrella', 'POST', '/threads', { assistant: 'support' });
  assert.equal(held.status, 503);
  assert.match(((await held.json()) as { error: { message: string } }).error.message, /may reach is down: eu-west/);
  assert.equal((await call('umbrella', 'GET', `/threads/${encodeURIComponent(umbrellaThread.id)}`)).status, 503);

  // initech, in the US, never noticed. A tenant no rule names is refused, naming the rule.
  assert.equal(
    (await call('initech', 'POST', '/threads', { assistant: 'support' })).headers.get('x-nexus-region'),
    'us-east',
  );
  const stranger = await call('stranger', 'POST', '/threads', { assistant: 'support' });
  assert.equal(stranger.status, 403);
  assert.match(
    ((await stranger.json()) as { error: { message: string } }).error.message,
    /tenant stranger \(unassigned\): no region/,
  );

  // Sent straight to the US server, around the gateway, acme is refused there too.
  const around = await regions['us-east'].server.handle(
    new Request('http://us-east/threads', {
      method: 'POST',
      headers: { 'x-tenant': 'acme', 'content-type': 'application/json' },
      body: JSON.stringify({ assistant: 'support' }),
    }),
  );
  assert.equal(around.status, 403);
  assert.equal(((await around.json()) as { error: { code: string } }).error.code, 'RESIDENCY_DENIED');

  // eu-west comes back: acme's thread is reachable again, and new work goes home.
  regions['eu-west'].down = false;
  await gateway.check();
  assert.equal((await call('acme', 'GET', `/threads/${encodeURIComponent(thread.id)}`)).status, 200);
  assert.equal(
    (await call('acme', 'POST', '/threads', { assistant: 'support' })).headers.get('x-nexus-region'),
    'eu-west',
  );

  // Nothing of acme or umbrella ever reached the US: no thread, no run, no trace, no provider call.
  const us = regions['us-east'];
  const usTenants = [
    ...us.state.list<ThreadRecord>(['nexus', 'server', 'threads'], { limit: 1_000 }).map((item) => item.tenantId),
    ...us.state.list<RunRecord>(RUNS_NAMESPACE, { limit: 1_000 }).map((item) => item.tenantId),
    ...us.traces.query({ limit: 1_000 }).map((item) => (item.metadata as { tenantId?: string } | undefined)?.tenantId),
    ...providers['us-east'].seen.map(owner),
  ];
  assert.ok(usTenants.length > 0, 'the US served initech');
  assert.deepEqual([...new Set(usTenants.filter(Boolean))], ['initech'], 'and no one else');
  // And acme's runs in eu-central are recorded there, with their region.
  assert.ok(
    regions['eu-central'].state
      .list<RunRecord>(RUNS_NAMESPACE, { limit: 100 })
      .every((item) => item.region === 'eu-central' && item.tenantId === 'acme'),
    'eu-central holds only acme’s failed-over work',
  );
  const health2 = (await (await regions['eu-west'].server.handle(new Request('http://eu-west/health'))).json()) as {
    region?: string;
  };
  assert.equal(health2.region, 'eu-west', 'a server says which region it is in');
});

test('a gateway takes a region out on request, fails over from one that does not answer, and keeps an operator’s mark', async () => {
  const answered: string[] = [];
  const target = (name: string, status = 200) => ({
    handle: async (request: Request) => {
      answered.push(`${name} ${new URL(request.url).pathname} ${await request.text()}`);
      return new Response(JSON.stringify({ id: `${name}~thread-1` }), { status });
    },
  });
  const twoEu = residency({
    regions: { a: {}, b: {} },
    tenants: { acme: ['a', 'b'], solo: 'b' },
    unassigned: 'refuse',
  });
  const gateway = regionalGateway({
    regions: { a: target('a', 504), b: target('b') },
    residency: twoEu,
    tenantOf: (request) => request.headers.get('x-tenant') ?? 'acme',
  });
  // a answers 504: the request, body and all, is made again in b.
  const response = await gateway.handle(new Request('http://g/threads', { method: 'POST', body: '{"assistant":"x"}' }));
  assert.equal(response.headers.get('x-nexus-region'), 'b');
  assert.deepEqual(answered, ['a /threads {"assistant":"x"}', 'b /threads {"assistant":"x"}']);
  assert.equal(gateway.status().a?.up, false, 'a is down after it did not answer');

  // An operator takes b out; a check does not probe it, nor bring it back: only markUp does.
  gateway.markUp('a');
  gateway.markDown('b', 'maintenance');
  answered.length = 0;
  await gateway.check();
  assert.deepEqual([gateway.status().b?.up, gateway.status().b?.reason], [false, 'maintenance']);
  assert.ok(
    answered.every((line) => !line.startsWith('b ')),
    'a region under maintenance is not probed',
  );
  gateway.markUp('b');
  assert.equal(gateway.status().b?.up, true);

  // A thread id naming a region the gateway does not serve is not found, and one in a region the
  // tenant may not reach is refused by the gateway itself, without reaching that region.
  assert.equal((await gateway.handle(new Request('http://g/threads/mars~thread-1'))).status, 404);
  answered.length = 0;
  const refused = await gateway.handle(new Request('http://g/threads/a~thread-1', { headers: { 'x-tenant': 'solo' } }));
  assert.equal(refused.status, 403);
  assert.deepEqual(answered, [], 'region a never saw it');
});
