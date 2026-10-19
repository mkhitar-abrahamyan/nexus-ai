/**
 * Residency: a tenant's requests and data kept in the regions it requires.
 *
 * A provider per region, each a server of the test's own that records who reached it. A tenant
 * pinned to the EU is answered by the EU twin of the provider routing chose, streams and the context
 * summary included, and never reaches the US; one whose provider has no twin there is refused, with
 * the rule that held it back, before anything is sent. An embedding never falls back out of its
 * tenant's regions, and an image provider outside them is refused by the lifecycle. Each tenant's
 * traces and assets are written in its home region and read only from its regions.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { NexusAI } from '../src/core/nexus.js';
import { OpenAIEmbeddingProvider } from '../src/embeddings/adapters.js';
import { MemoryAssetStore } from '../src/images/assets.js';
import { MockImageProvider } from '../src/images/mock.js';
import { regionalAssetStore, regionalTraceStore, ResidencyError, residency } from '../src/residency/index.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer } from '../src/tracing/tracer.js';
import type { AuditLogEvent } from '../src/types/config.js';

/** A provider server per region, recording the tenant header of everything that reaches it. */
const regions = {
  eu: { url: '', seen: [] as Array<{ path: string; tenant: string }>, failEmbeddings: false },
  us: { url: '', seen: [] as Array<{ path: string; tenant: string }>, failEmbeddings: false },
};
const servers: Array<ReturnType<typeof createServer>> = [];

before(async () => {
  for (const [name, region] of Object.entries(regions)) {
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const path = new URL(request.url ?? '/', 'http://x').pathname;
        region.seen.push({ path, tenant: String(request.headers['x-tenant'] ?? '') });
        const asked = JSON.parse(body || '{}') as { stream?: boolean; input?: string[] };
        if (path.endsWith('/embeddings')) {
          if (region.failEmbeddings) {
            response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"message":"down"}}');
            return;
          }
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ data: (asked.input ?? []).map((_, index) => ({ embedding: [1, 0], index })), model: 'e' }),
          );
          return;
        }
        if (asked.stream) {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunk = (delta: Record<string, unknown>, finish: string | null) =>
            `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'gpt-5', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
          response.end(
            `${chunk({ role: 'assistant', content: `streamed in ${name}` }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`,
          );
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'c',
            object: 'chat.completion',
            created: 1,
            model: 'gpt-5',
            choices: [
              { index: 0, message: { role: 'assistant', content: `answered in ${name}` }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    region.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    servers.push(server);
  }
});
after(() => {
  for (const server of servers) server.close();
});

const policy = () =>
  residency({
    regions: {
      'eu-west': { providers: ['openai-eu', 'mistral', 'embed-eu'], twins: { openai: 'openai-eu' } },
      'us-east': { providers: ['openai', 'anthropic', 'embed-us', 'mock'] },
    },
    tenants: { acme: 'eu-west', initech: ['us-east'], globex: 'any', hooli: 'refuse' },
    unassigned: 'refuse',
  });

function client(audit: AuditLogEvent[] = []) {
  const headers = (tenant: string) => ({ 'x-tenant': tenant });
  return new NexusAI({
    providers: {
      openai: { apiKey: 'sk-us', baseUrl: `${regions.us.url}/v1` },
      anthropic: { apiKey: 'sk-us' },
      custom: [{ name: 'openai-eu', format: 'openai', baseUrl: `${regions.eu.url}/v1`, apiKey: 'sk-eu' }],
    },
    routing: { strategy: 'direct', defaultModel: 'gpt-5' },
    security: 'off',
    auditLog: { enabled: true, sink: (event: AuditLogEvent) => void audit.push(event) },
    embeddings: {
      providers: {
        'embed-eu': new OpenAIEmbeddingProvider({
          providerName: 'embed-eu',
          baseUrl: `${regions.eu.url}/v1`,
          apiKey: 'k',
          model: 'e',
        }),
        'embed-us': new OpenAIEmbeddingProvider({
          providerName: 'embed-us',
          baseUrl: `${regions.us.url}/v1`,
          apiKey: 'k',
          model: 'e',
        }),
      },
      fallback: [{ provider: 'embed-us' }],
      defaultProvider: 'embed-us',
    },
    images: { providers: { mock: new MockImageProvider() }, defaultProvider: 'mock' },
    lifecycle: { residency: policy() },
    void: headers,
  } as never);
}

const messages = [{ role: 'user' as const, content: 'hello' }];
const reached = () => ({ eu: regions.eu.seen.length, us: regions.us.seen.length });

test('proof: a tenant pinned to the EU is answered by the EU twin, and never reaches the US', async () => {
  const ai = client();
  const before = reached();
  const acme = await ai.complete({ model: 'gpt-5', messages, tenantId: 'acme' });
  assert.equal(acme.content, 'answered in eu', 'routing chose openai; the call went to its EU twin');
  assert.equal(acme.meta.routingDecision?.provider, 'openai-eu');
  let streamed = '';
  for await (const chunk of ai.stream({ model: 'gpt-5', messages, tenantId: 'acme' })) {
    if (chunk.type === 'text') streamed += chunk.content ?? '';
  }
  assert.equal(streamed, 'streamed in eu');
  assert.deepEqual(reached(), { eu: before.eu + 2, us: before.us }, 'nothing of acme reached the US');

  // A tenant the US holds, and one allowed anywhere, go where routing chose.
  assert.equal((await ai.complete({ model: 'gpt-5', messages, tenantId: 'initech' })).content, 'answered in us');
  assert.equal((await ai.complete({ model: 'gpt-5', messages, tenantId: 'globex' })).content, 'answered in us');
});

test('a provider with no twin in the tenant’s regions is refused, naming the rule, and nothing is sent', async () => {
  const audit: AuditLogEvent[] = [];
  const ai = client(audit);
  const before = reached();
  await assert.rejects(
    ai.complete({ model: 'claude-sonnet-5-5', provider: 'anthropic', messages, tenantId: 'acme' } as never),
    (error: unknown) => {
      assert.ok(error instanceof ResidencyError, `a residency refusal: ${String(error)}`);
      assert.equal(error.code, 'RESIDENCY_DENIED');
      assert.deepEqual(
        [error.target.kind, error.target.name, error.target.region, error.tenantId],
        ['provider', 'anthropic', 'us-east', 'acme'],
      );
      assert.match(
        error.message,
        /provider anthropic runs in us-east, outside the regions tenant acme may reach \(tenant acme: eu-west\)/,
      );
      return true;
    },
  );
  assert.deepEqual(reached(), before);
  assert.equal(audit.at(-1)?.type, 'blocked', 'audited as a refusal');

  // A tenant no rule names, and one that may reach no region, are refused before routing.
  await assert.rejects(
    ai.complete({ model: 'gpt-5', messages, tenantId: 'stranger' }),
    /tenant stranger \(unassigned\): no region/,
  );
  await assert.rejects(ai.complete({ model: 'gpt-5', messages, tenantId: 'hooli' }), /tenant hooli: no region/);
  assert.deepEqual(reached(), before);
});

test('an embedding never falls back out of its tenant’s regions', async () => {
  const ai = client();
  regions.eu.failEmbeddings = true;
  try {
    const before = reached();
    await assert.rejects(ai.embeddings.embed({ input: ['a'], provider: 'embed-eu', model: 'e', tenantId: 'acme' }));
    assert.equal(reached().us, before.us, 'acme’s embedding did not fall back to the US');
    const globex = await ai.embeddings.embed({ input: ['a'], provider: 'embed-eu', model: 'e', tenantId: 'globex' });
    assert.equal(globex.embeddings.length, 1, 'a tenant allowed anywhere does fall back');
    assert.equal(reached().us, before.us + 1);
  } finally {
    regions.eu.failEmbeddings = false;
  }
  // And a routed provider outside the regions is refused, in this family as in every other: named,
  // or chosen by default.
  const before = reached();
  await assert.rejects(
    ai.embeddings.embed({ input: ['a'], provider: 'embed-us', model: 'e', tenantId: 'acme' }),
    ResidencyError,
  );
  await assert.rejects(ai.embeddings.embed({ input: ['a'], model: 'e', tenantId: 'acme' }), ResidencyError);
  assert.deepEqual(reached(), before, 'nothing sent');
});

test('an image provider outside the tenant’s regions is refused by the lifecycle, before it is called', async () => {
  const ai = client();
  const mock = (ai as unknown as { images: { generate: (request: unknown) => Promise<unknown> } }).images;
  await assert.rejects(mock.generate({ prompt: 'a lighthouse', tenantId: 'acme' }), ResidencyError);
  const result = (await mock.generate({ prompt: 'a lighthouse', tenantId: 'initech' })) as { assets: unknown[] };
  assert.equal(result.assets.length, 1, 'a tenant the US holds is served');
});

test('each tenant’s traces are written in its home region, with every run of a trace, and read from its regions', async () => {
  const eu = new MemoryTraceStore();
  const us = new MemoryTraceStore();
  const errors: unknown[] = [];
  // Operations with no tenant are refused here, so a run without one is written only where its trace went.
  const strict = residency({
    regions: { 'eu-west': {}, 'us-east': {} },
    tenants: { acme: 'eu-west', initech: ['us-east'], globex: 'any', hooli: 'refuse' },
    untenanted: 'refuse',
  });
  const store = regionalTraceStore({
    stores: { 'eu-west': eu, 'us-east': us },
    residency: strict,
    defaultRegion: 'us-east',
  });
  for (const incremental of [false, true]) {
    const tracer = new Tracer({ store, incremental, onError: (error) => errors.push(error) });
    for (const tenantId of ['acme', 'initech', 'globex']) {
      await tracer.trace({ name: `${tenantId}-run`, metadata: { tenantId } }, () =>
        tracer.trace({ name: 'tool', kind: 'tool' }, () => 'done'),
      );
    }
    // A tenant that may reach no region is written nowhere.
    await tracer.trace({ name: 'hooli-run', metadata: { tenantId: 'hooli' } }, () => 'nothing');
    await tracer.flush();
  }
  const names = (target: MemoryTraceStore) =>
    target
      .query({ limit: 100 })
      .map((run) => run.name)
      .sort();
  assert.deepEqual(
    names(eu),
    ['acme-run', 'acme-run', 'tool', 'tool'],
    'acme, and its runs without a tenant, in the EU',
  );
  assert.deepEqual(names(us), [
    'globex-run',
    'globex-run',
    'initech-run',
    'initech-run',
    'tool',
    'tool',
    'tool',
    'tool',
  ]);
  assert.ok(
    errors.length >= 2 && errors.every((error) => error instanceof ResidencyError),
    'hooli refused, and reported',
  );

  // Reads: every region, newest first; one tenant's view, its regions only.
  assert.equal((await store.query({ limit: 100 })).length, 12);
  const acme = store.forTenant('acme');
  assert.deepEqual([...new Set((await acme.query({ limit: 100 })).map((run) => run.name))].sort(), [
    'acme-run',
    'tool',
  ]);
  const root = (await acme.query({ name: 'acme-run', limit: 1 }))[0];
  assert.ok(root, 'found');
  assert.equal((await acme.tree(root.traceId))?.children[0]?.name, 'tool');
  assert.equal(store.regionOfTrace(root.traceId), 'eu-west');
  await store.addFeedback?.(root.id, { key: 'helpful', score: 1, createdAt: new Date().toISOString() });
  assert.equal(
    (eu.get(root.id) as { feedback?: unknown[] } | undefined)?.feedback?.length,
    1,
    'feedback lands where the run is',
  );
});

test('each tenant’s assets are stored in its home region, and never served outside its regions', async () => {
  const eu = new MemoryAssetStore();
  const us = new MemoryAssetStore();
  // A policy read from records, so a tenant can be moved.
  const homes: Record<string, string> = { acme: 'eu-west', initech: 'us-east' };
  const moving = residency({
    regions: { 'eu-west': {}, 'us-east': {} },
    tenants: async (tenantId) => homes[tenantId],
    unassigned: 'refuse',
  });
  const assets = regionalAssetStore({ stores: { 'eu-west': eu, 'us-east': us }, residency: moving });
  const provenance = { provider: 'mock', operation: 'upload' as const, requestId: 'r' };
  const stat = await assets.put(
    { location: { kind: 'bytes', data: new Uint8Array([1, 2, 3]) }, mimeType: 'image/png' },
    { tenantId: 'acme', provenance },
  );
  assert.ok(eu.get(stat.assetId, 'acme'), 'stored in the EU');
  assert.equal(us.get(stat.assetId, 'acme'), undefined, 'and not in the US');
  assert.deepEqual([...((await assets.get(stat.assetId, 'acme'))?.location.data ?? [])], [1, 2, 3]);

  // Streamed in, to a store without streams of its own.
  const streamed = await assets.putStream?.(
    {
      stream: (async function* () {
        yield new Uint8Array([4]);
        yield new Uint8Array([5]);
      })(),
      mimeType: 'image/png',
    },
    { tenantId: 'initech', provenance },
  );
  assert.deepEqual([...((await assets.get(streamed?.assetId ?? '', 'initech'))?.location.data ?? [])], [4, 5]);
  assert.ok(us.get(streamed?.assetId ?? '', 'initech'), 'in the US');

  // Moved to the US, acme's EU asset is no longer served: it is never read outside acme's regions.
  homes.acme = 'us-east';
  assert.equal(await assets.get(stat.assetId, 'acme'), undefined);
  assert.equal(await assets.stat(stat.assetId, 'acme'), undefined);
  homes.acme = 'eu-west';
  assert.equal(await assets.delete(stat.assetId, 'acme'), true);

  await assert.rejects(
    Promise.resolve(
      assets.put(
        { location: { kind: 'bytes', data: new Uint8Array([9]) }, mimeType: 'image/png' },
        { tenantId: 'stranger', provenance },
      ),
    ),
    ResidencyError,
  );
  assert.equal(eu.snapshot().entries + us.snapshot().entries, 1, 'nothing stored for a tenant refused');
});

test('a policy is checked as it is built, and places a provider, its twin, or nothing', async () => {
  assert.throws(() => residency({ regions: { eu: {} }, tenants: { acme: 'mars' } }), /names region "mars"/);
  assert.throws(
    () => residency({ regions: { eu: { providers: ['openai'] }, us: { providers: ['openai'] } } }),
    /listed in two regions: eu and us/,
  );
  const built = policy();
  const acme = await built.regionsFor('acme');
  assert.deepEqual([acme.regions, acme.rule], [['eu-west'], 'tenant acme: eu-west']);
  assert.deepEqual(built.place('openai', acme), { provider: 'openai-eu', region: 'eu-west' });
  assert.deepEqual(built.place('mistral', acme), { provider: 'mistral', region: 'eu-west' });
  assert.equal(built.place('anthropic', acme), undefined);
  assert.equal(built.place('unknown', acme), undefined, 'a provider in no region is outside every rule');
  const anywhere = await built.regionsFor(undefined);
  assert.deepEqual([anywhere.regions, anywhere.rule], [undefined, 'no tenant: any region']);
  assert.deepEqual(built.place('unknown', anywhere), { provider: 'unknown' });
  assert.deepEqual(built.regions(), ['eu-west', 'us-east']);
});
