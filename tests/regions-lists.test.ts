/**
 * A tenant's threads and runs, listed across all of its regions.
 *
 * Three regions each run an agent server with its own state. A tenant that works in both EU regions
 * lists its threads and its runs through the gateway and gets every one of them, from both regions,
 * newest first, and none of another tenant's; a tenant held to one region gets that region's. When a
 * region is down or fails, the list comes from the others and names the one missing, rather than
 * failing or quietly leaving it out.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { residency } from '../src/residency/index.js';
import { functionAssistant } from '../src/server/assistant.js';
import { regionalGateway } from '../src/server/regions.js';
import { createAgentServer } from '../src/server/server.js';
import { MemoryServerStore } from '../src/server/state.js';
import type { RunRecord, ThreadRecord } from '../src/types/server.js';

const REGIONS = ['eu-west', 'eu-central', 'us-east'] as const;
type Region = (typeof REGIONS)[number];

const policy = residency({
  regions: { 'eu-west': {}, 'eu-central': {}, 'us-east': {} },
  tenants: { acme: ['eu-west', 'eu-central'], umbrella: 'eu-west', initech: 'us-east' },
  unassigned: 'refuse',
});

function servers() {
  const failing = new Set<Region>();
  const regions = Object.fromEntries(
    REGIONS.map((name) => [
      name,
      createAgentServer({
        assistants: { support: functionAssistant(async () => ({ ok: true })) },
        state: new MemoryServerStore(),
        region: name,
        residency: policy,
        // A request needs the tenant and a key: the key is each region's to check.
        authenticate: (request: Request) => {
          const tenantId = request.headers.get('x-tenant');
          return tenantId && request.headers.get('x-key') === 'ok' ? { tenantId } : undefined;
        },
      }),
    ]),
  ) as Record<Region, ReturnType<typeof createAgentServer>>;
  const reach = (name: Region) => async (request: Request) => {
    if (failing.has(name)) throw new Error(`connect ECONNREFUSED ${name}`);
    return regions[name].handle(request);
  };
  return { regions, failing, reach };
}

const headers = (tenant: string, key = 'ok') => ({
  'x-tenant': tenant,
  'x-key': key,
  'content-type': 'application/json',
});
const pause = () => new Promise((resolve) => setTimeout(resolve, 3));

test('proof: a tenant’s threads and runs come from every region it may reach, newest first, with a missing region named', async () => {
  const { regions, failing, reach } = servers();
  const gateway = regionalGateway({
    regions: Object.fromEntries(REGIONS.map((name) => [name, { handle: reach(name) }])),
    residency: policy,
    tenantOf: (request) => request.headers.get('x-tenant') ?? undefined,
  });
  const direct = async (region: Region, tenant: string, method: string, path: string, body?: unknown) =>
    (await regions[region]
      .handle(
        new Request(`http://${region}.test${path}`, {
          method,
          headers: headers(tenant),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
      .then((response) => response.json())) as Record<string, unknown>;
  const list = async (tenant: string, path: string, key = 'ok') => {
    const response = await gateway.handle(new Request(`http://gateway.test${path}`, { headers: headers(tenant, key) }));
    return {
      status: response.status,
      region: response.headers.get('x-nexus-region'),
      body: (await response.json()) as Record<string, unknown>,
    };
  };

  // Acme's threads in both EU regions, written in turn, and others' threads beside them.
  const created: string[] = [];
  for (const region of ['eu-west', 'eu-central', 'eu-west', 'eu-central', 'eu-central'] as const) {
    created.push(String((await direct(region, 'acme', 'POST', '/threads', { assistant: 'support' })).id));
    await pause();
  }
  await direct('eu-west', 'umbrella', 'POST', '/threads', { assistant: 'support' });
  await direct('us-east', 'initech', 'POST', '/threads', { assistant: 'support' });
  await pause();

  const all = await list('acme', '/threads');
  assert.equal(all.status, 200);
  const ids = (all.body.threads as ThreadRecord[]).map((thread) => thread.id);
  assert.deepEqual(ids, [...created].reverse(), 'every thread of both regions, newest first');
  assert.ok(
    ids.every((id) => id.startsWith('eu-')),
    'nothing from the US',
  );
  assert.deepEqual(all.body.regions, ['eu-west', 'eu-central']);
  assert.equal(all.body.incomplete, undefined);
  assert.equal(all.region, 'eu-west,eu-central');

  const newest = await list('acme', '/threads?limit=2');
  assert.deepEqual(
    (newest.body.threads as ThreadRecord[]).map((thread) => thread.id),
    [created[4], created[3]],
    'the limit is of the merged list',
  );

  // Runs too, from both regions.
  const runs: string[] = [];
  for (const region of ['eu-central', 'eu-west'] as const) {
    runs.push(String((await direct(region, 'acme', 'POST', '/runs', { assistant: 'support', input: {} })).id));
    await pause();
  }
  const runList = await list('acme', '/runs');
  assert.deepEqual(
    (runList.body.runs as RunRecord[])
      .map((run) => run.id)
      .filter((id) => runs.includes(id))
      .sort(),
    [...runs].sort(),
    'the runs of both regions',
  );

  // A tenant held to one region lists that region's, and none of acme's.
  const umbrella = await list('umbrella', '/threads');
  assert.equal((umbrella.body.threads as ThreadRecord[]).length, 1);
  assert.deepEqual(umbrella.body.regions, ['eu-west']);
  const initech = await list('initech', '/threads');
  assert.deepEqual(initech.body.regions, ['us-east']);

  // A region down: the list comes from the rest, and says which is missing.
  gateway.markDown('eu-central', 'maintenance');
  const partial = await list('acme', '/threads');
  assert.equal(partial.status, 200);
  assert.deepEqual(
    (partial.body.threads as ThreadRecord[]).map((thread) => thread.id),
    [created[2], created[0]],
  );
  assert.deepEqual(partial.body.incomplete, [{ region: 'eu-central', reason: 'down' }]);
  gateway.markUp('eu-central');

  // A region that fails to answer is named with why, and taken out after its failures.
  failing.add('eu-west');
  const failed = await list('acme', '/threads');
  assert.deepEqual(failed.body.regions, ['eu-central']);
  assert.deepEqual(failed.body.incomplete, [{ region: 'eu-west', reason: 'connect ECONNREFUSED eu-west' }]);
  assert.equal(gateway.status()['eu-west']?.up, false);

  // Every region gone: 503, with when to try again.
  failing.add('eu-central');
  gateway.markUp('eu-west');
  const none = await list('acme', '/threads');
  assert.equal(none.status, 503);
  assert.match(String((none.body.error as { message: string }).message), /No region this list may reach answered/);

  // A refusal every region gives is the answer, as one region's would be.
  failing.clear();
  gateway.markUp('eu-west');
  gateway.markUp('eu-central');
  const unauthorized = await list('acme', '/threads', 'wrong');
  assert.equal(unauthorized.status, 401);
});

test('lists: home asks the home region alone, as before 2.18', async () => {
  const { regions, reach } = servers();
  const gateway = regionalGateway({
    regions: Object.fromEntries(REGIONS.map((name) => [name, { handle: reach(name) }])),
    residency: policy,
    tenantOf: (request) => request.headers.get('x-tenant') ?? undefined,
    lists: 'home',
  });
  for (const region of ['eu-west', 'eu-central'] as const) {
    await regions[region].handle(
      new Request(`http://${region}.test/threads`, {
        method: 'POST',
        headers: headers('acme'),
        body: JSON.stringify({ assistant: 'support' }),
      }),
    );
  }
  const response = await gateway.handle(new Request('http://gateway.test/threads', { headers: headers('acme') }));
  const body = (await response.json()) as { threads: ThreadRecord[]; regions?: string[] };
  assert.equal(response.headers.get('x-nexus-region'), 'eu-west');
  assert.deepEqual(
    body.threads.map((thread) => thread.id.split('~')[0]),
    ['eu-west'],
  );
  assert.equal(body.regions, undefined, 'the home region answers as itself');
});
