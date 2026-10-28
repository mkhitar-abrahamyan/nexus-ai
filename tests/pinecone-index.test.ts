/**
 * A Pinecone index the store creates itself: a serverless index with the cosine metric and the store's
 * width, waited on until it is ready, then used through its own host; one that exists used when it
 * fits and refused when it does not; and one another process creates at the same moment read as found.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensurePineconeIndex, PineconeError, PineconeVectorStore } from '../src/rag/pinecone.js';
import { pineconeStub } from './vector-stubs.js';

type Index = {
  name: string;
  dimension: number;
  metric: string;
  host: string;
  status: { ready: boolean; state: string };
};

/** Pinecone's control plane: indexes that turn ready after `pollsUntilReady` reads, and their data planes. */
function controlPlane(options: { pollsUntilReady?: number; raceOnCreate?: Index; state?: string } = {}) {
  const indexes = new Map<string, Index>();
  const reads = new Map<string, number>();
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown>; headers: Record<string, string> }> =
    [];
  const data = pineconeStub();
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({
      method: init.method ?? 'GET',
      url: url.href,
      ...(body ? { body } : {}),
      headers: init.headers as Record<string, string>,
    });
    if (url.host !== 'api.pinecone.test') return data.fetch(input, init);
    const answer = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    if (init.method === 'POST' && url.pathname === '/indexes') {
      const name = String(body?.name);
      if (options.raceOnCreate) {
        indexes.set(name, options.raceOnCreate);
        return answer(409, { error: { code: 'ALREADY_EXISTS', message: `Resource ${name} already exists` } });
      }
      const index: Index = {
        name,
        dimension: Number(body?.dimension),
        metric: String(body?.metric),
        host: `${name}-abc123.svc.pinecone.test`,
        status: { ready: false, state: options.state ?? 'Initializing' },
      };
      indexes.set(name, index);
      return answer(201, index);
    }
    const name = url.pathname.match(/^\/indexes\/([^/]+)$/)?.[1];
    const index = name ? indexes.get(name) : undefined;
    if (!index || !name) return answer(404, { error: { code: 'NOT_FOUND' } });
    const read = (reads.get(name) ?? 0) + 1;
    reads.set(name, read);
    if (read > (options.pollsUntilReady ?? 1) && !options.state) index.status = { ready: true, state: 'Ready' };
    return answer(200, index);
  }) as typeof globalThis.fetch;
  return { fetch, calls, indexes, data };
}

test('a store creates its index, waits until it is ready, and keeps its chunks there', async () => {
  const pinecone = controlPlane({ pollsUntilReady: 2 });
  const store = await PineconeVectorStore.create({
    apiKey: 'pc-key',
    name: 'docs-2',
    dimensions: 8,
    region: 'eu-west-1',
    cloud: 'gcp',
    deletionProtection: true,
    tags: { team: 'search' },
    controlUrl: 'https://api.pinecone.test/',
    pollMs: 0,
    readyTimeoutMs: 1_000,
    fetch: pinecone.fetch,
    namespace: 'acme',
  });
  const [lookup, create, ...polls] = pinecone.calls;
  assert.deepEqual([lookup?.method, lookup?.url], ['GET', 'https://api.pinecone.test/indexes/docs-2']);
  assert.deepEqual(create?.body, {
    name: 'docs-2',
    dimension: 8,
    metric: 'cosine',
    spec: { serverless: { cloud: 'gcp', region: 'eu-west-1' } },
    deletion_protection: 'enabled',
    tags: { team: 'search' },
  });
  assert.equal(create?.headers['Api-Key'], 'pc-key');
  assert.equal(create?.headers['X-Pinecone-API-Version'], '2025-04');
  assert.equal(polls.length, 3, 'asked until it was ready: twice not yet, then ready');

  await store.add([{ id: 'a', content: 'alpha', embedding: [1, 0, 0, 0, 0, 0, 0, 0] }]);
  const upsert = pinecone.calls.at(-1);
  assert.equal(upsert?.url, 'https://docs-2-abc123.svc.pinecone.test/vectors/upsert', 'its own host');
  assert.equal(upsert?.body?.namespace, 'acme', 'with the store’s options');
  assert.deepEqual(
    (await store.searchVector([1, 0, 0, 0, 0, 0, 0, 0])).map((result) => result.id),
    ['a'],
  );

  // Asked again, the index is found and used as it is.
  const before = pinecone.calls.length;
  const again = await ensurePineconeIndex({
    apiKey: 'pc-key',
    name: 'docs-2',
    dimensions: 8,
    controlUrl: 'https://api.pinecone.test',
    fetch: pinecone.fetch,
  });
  assert.deepEqual(again, { name: 'docs-2', host: 'https://docs-2-abc123.svc.pinecone.test', created: false });
  assert.equal(pinecone.calls.length, before + 1, 'one read, no create');
});

test('a new index is serverless on AWS in us-east-1, unprotected and untagged, by default', async () => {
  const pinecone = controlPlane();
  const index = await ensurePineconeIndex({
    apiKey: 'k',
    name: 'a',
    dimensions: 4,
    controlUrl: 'https://api.pinecone.test',
    pollMs: 0,
    apiVersion: '2025-10',
    headers: { 'x-trace': 't1' },
    fetch: pinecone.fetch,
  });
  assert.equal(index.created, true);
  const create = pinecone.calls[1];
  assert.deepEqual(create?.body, {
    name: 'a',
    dimension: 4,
    metric: 'cosine',
    spec: { serverless: { cloud: 'aws', region: 'us-east-1' } },
    deletion_protection: 'disabled',
  });
  assert.equal(create?.headers['X-Pinecone-API-Version'], '2025-10');
  assert.equal(create?.headers['x-trace'], 't1');
});

test('an index that does not fit, fails, or is not ready in time is refused; one created meanwhile is used', async () => {
  const refused = (status: number, message: RegExp) => (error: unknown) =>
    error instanceof PineconeError && error.status === status && message.test(error.message);
  const base = { apiKey: 'k', controlUrl: 'https://api.pinecone.test', pollMs: 0 };

  const wide = controlPlane();
  await ensurePineconeIndex({ ...base, name: 'wide', dimensions: 16, fetch: wide.fetch });
  await assert.rejects(
    ensurePineconeIndex({ ...base, name: 'wide', dimensions: 8, fetch: wide.fetch }),
    refused(409, /"wide" is 16 wide with the cosine metric; the store needs 8 and cosine/),
  );
  (wide.indexes.get('wide') as Index).metric = 'dotproduct';
  await assert.rejects(
    ensurePineconeIndex({ ...base, name: 'wide', dimensions: 16, fetch: wide.fetch }),
    refused(409, /with the dotproduct metric/),
  );

  const raced = controlPlane({
    raceOnCreate: {
      name: 'raced',
      dimension: 8,
      metric: 'cosine',
      host: 'raced-x.svc.pinecone.test',
      status: { ready: true, state: 'Ready' },
    },
  });
  assert.deepEqual(await ensurePineconeIndex({ ...base, name: 'raced', dimensions: 8, fetch: raced.fetch }), {
    name: 'raced',
    host: 'https://raced-x.svc.pinecone.test',
    created: false,
  });
  const racedWrong = controlPlane({
    raceOnCreate: {
      name: 'r',
      dimension: 4,
      metric: 'cosine',
      host: 'r.svc.pinecone.test',
      status: { ready: true, state: 'Ready' },
    },
  });
  await assert.rejects(
    ensurePineconeIndex({ ...base, name: 'r', dimensions: 8, fetch: racedWrong.fetch }),
    refused(409, /is 4 wide/),
    'one created meanwhile is checked as one found',
  );

  const failed = controlPlane({ state: 'InitializationFailed' });
  await assert.rejects(
    ensurePineconeIndex({ ...base, name: 'broken', dimensions: 8, fetch: failed.fetch }),
    refused(409, /"broken" is InitializationFailed/),
  );
  const ending = controlPlane({ state: 'Terminating' });
  await assert.rejects(
    ensurePineconeIndex({ ...base, name: 'ending', dimensions: 8, fetch: ending.fetch }),
    refused(409, /is Terminating/),
  );
  const slow = controlPlane({ pollsUntilReady: 1_000_000 });
  await assert.rejects(
    ensurePineconeIndex({ ...base, name: 'slow', dimensions: 8, readyTimeoutMs: 20, pollMs: 5, fetch: slow.fetch }),
    refused(504, /"slow" was not ready within 20 ms/),
  );
  await assert.rejects(
    PineconeVectorStore.create({
      ...base,
      name: 'slower',
      dimensions: 8,
      readyTimeoutMs: 20,
      pollMs: 5,
      fetch: slow.fetch,
    }),
    refused(504, /"slower" was not ready within 20 ms/),
    'and so does a store creating one',
  );

  const denied = (async () =>
    new Response(JSON.stringify({ error: { code: 'FORBIDDEN' } }), { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(
    ensurePineconeIndex({ ...base, name: 'x', dimensions: 8, fetch: denied }),
    refused(403, /GET \/indexes\/x failed with 403/),
  );
  let posted = 0;
  const quota = (async (_input: string | URL | Request, init: RequestInit = {}) => {
    if (init.method === 'POST') posted += 1;
    return init.method === 'POST'
      ? new Response(JSON.stringify({ error: { code: 'FORBIDDEN', message: 'quota' } }), { status: 403 })
      : new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  await assert.rejects(
    ensurePineconeIndex({ ...base, name: 'x', dimensions: 8, fetch: quota }),
    refused(403, /POST \/indexes failed with 403/),
  );
  assert.equal(posted, 1, 'a refusal other than a conflict is not retried as one');
  const hostless = (async () =>
    new Response(JSON.stringify({ dimension: 8, metric: 'cosine', status: { ready: true } }), {
      status: 200,
    })) as unknown as typeof fetch;
  await assert.rejects(
    ensurePineconeIndex({ ...base, name: 'x', dimensions: 8, fetch: hostless }),
    refused(502, /names no host/),
  );

  for (const name of ['', 'Docs', '-docs', 'docs-', 'a'.repeat(46), 'do_cs']) {
    await assert.rejects(
      ensurePineconeIndex({ ...base, name, dimensions: 8, fetch: denied }),
      /is not an index name/,
      name,
    );
  }
  assert.equal(
    (await ensurePineconeIndex({ ...base, name: 'a'.repeat(45), dimensions: 8, fetch: controlPlane().fetch })).created,
    true,
  );
  await assert.rejects(ensurePineconeIndex({ ...base, name: 'ok', dimensions: 0, fetch: denied }), /dimensions/i);
});
