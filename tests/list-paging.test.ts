/**
 * Lists that page: an agent server's threads and runs, newest written first, a page at a time by
 * cursor, and the same through the regional gateway across every region a tenant may reach.
 *
 * Every record is listed once across the pages, in order, however the records fall between regions;
 * a tenant's page is its own, however many newer records another tenant wrote; and a record written
 * while a client pages belongs to a fresh first page, not to the pages after the cursor.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { residency } from '../src/residency/index.js';
import { functionAssistant } from '../src/server/assistant.js';
import { regionalGateway } from '../src/server/regions.js';
import { createAgentServer } from '../src/server/server.js';
import { MemoryServerStore } from '../src/server/state.js';

const policy = residency({
  regions: { 'eu-west': {}, 'eu-central': {} },
  tenants: { acme: ['eu-west', 'eu-central'] },
  unassigned: 'refuse',
});

/** A clock a second further on at each reading, shared by every server that takes it. */
const clock = () => {
  let at = Date.parse('2026-10-22T00:00:00.000Z');
  return () => {
    at += 1_000;
    return new Date(at);
  };
};

const server = (now: () => Date, region?: 'eu-west' | 'eu-central') =>
  createAgentServer({
    assistants: { support: functionAssistant(async () => ({ ok: true })) },
    state: new MemoryServerStore(),
    now,
    ...(region ? { region, residency: policy } : {}),
    authenticate: (request: Request) => {
      const tenantId = request.headers.get('x-tenant');
      return tenantId ? { tenantId } : undefined;
    },
  });

type Handle = (request: Request) => Promise<Response>;

const call = async (handle: Handle, tenant: string, method: string, path: string, body?: unknown) => {
  const response = await handle(
    new Request(`http://test${path}`, {
      method,
      headers: { 'x-tenant': tenant, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

const newThread = async (handle: Handle, tenant: string) =>
  (await call(handle, tenant, 'POST', '/threads', { assistant: 'support' })).body.id as string;

/** Starts a run and waits for it to finish, so nothing writes its record while a test pages. */
const finishedRun = async (handle: Handle, tenant: string, path = '/runs') => {
  const id = (await call(handle, tenant, 'POST', path, { assistant: 'support', input: {} })).body.id as string;
  for (let tries = 0; tries < 400; tries += 1) {
    if ((await call(handle, tenant, 'GET', `/runs/${id}`)).body.status === 'succeeded') return id;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run ${id} did not finish`);
};

const ids = (body: Record<string, unknown>) =>
  ((body.threads ?? body.runs) as Array<{ id: string }>).map((record) => record.id);

/** Every page of a list, following each page's cursor until a page has none. */
async function walk(handle: Handle, tenant: string, path: string, limit: number): Promise<string[][]> {
  const pages: string[][] = [];
  let cursor: string | undefined;
  do {
    const query = `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const { status, body } = await call(handle, tenant, 'GET', `${path}${query}`);
    assert.equal(status, 200, `${path}${query} answered ${status}: ${JSON.stringify(body)}`);
    pages.push(ids(body));
    cursor = body.nextCursor as string | undefined;
    assert.ok(pages.length < 20, 'the walk ends');
  } while (cursor);
  return pages;
}

test('a tenant’s page is its own, however many newer threads and runs another tenant wrote', async () => {
  const { handle } = server(clock());
  const acme = [await newThread(handle, 'acme'), await newThread(handle, 'acme')];
  const run = await finishedRun(handle, 'acme');
  for (let index = 0; index < 60; index += 1) await newThread(handle, 'globex');
  for (let index = 0; index < 51; index += 1) await finishedRun(handle, 'globex');

  const threads = await call(handle, 'acme', 'GET', '/threads');
  assert.deepEqual(ids(threads.body), [...acme].reverse(), 'both of its threads, newest first');
  assert.equal(threads.body.nextCursor, undefined, 'and nothing after them');
  assert.deepEqual(ids((await call(handle, 'acme', 'GET', '/runs')).body), [run]);
  assert.equal(ids((await call(handle, 'globex', 'GET', '/threads')).body).length, 50, 'a full page for the other');
});

test('pages follow each other by cursor, each record once, newest first, and a record written meanwhile waits for a fresh page', async () => {
  const { handle } = server(clock());
  const threads: string[] = [];
  for (let index = 0; index < 7; index += 1) threads.push(await newThread(handle, 'acme'));
  const newest = [...threads].reverse();
  assert.deepEqual(await walk(handle, 'acme', '/threads', 3), [
    newest.slice(0, 3),
    newest.slice(3, 6),
    newest.slice(6),
  ]);
  assert.deepEqual(await walk(handle, 'acme', '/threads', 7), [newest], 'a page that holds them all is the last');

  // A thread created after the first page is on a fresh first page, not on the next.
  const first = await call(handle, 'acme', 'GET', '/threads?limit=3');
  const later = await newThread(handle, 'acme');
  const second = await call(handle, 'acme', 'GET', `/threads?limit=3&cursor=${first.body.nextCursor}`);
  assert.deepEqual(ids(second.body), newest.slice(3, 6));
  assert.deepEqual(ids((await call(handle, 'acme', 'GET', '/threads?limit=1')).body), [later]);

  // Runs page the same way, and a thread's runs only its own.
  const thread = threads[0] as string;
  const own = [await finishedRun(handle, 'acme', `/threads/${thread}/runs`)];
  const stateless = await finishedRun(handle, 'acme');
  own.push(await finishedRun(handle, 'acme', `/threads/${thread}/runs`));
  assert.deepEqual(await walk(handle, 'acme', `/threads/${thread}/runs`, 1), [[own[1]], [own[0]]]);
  assert.deepEqual((await walk(handle, 'acme', '/runs', 2)).flat(), [own[1], stateless, own[0]]);
});

test('a cursor no list gave, or a limit that is not a whole number above 0, is refused', async () => {
  const { handle } = server(clock());
  await newThread(handle, 'acme');
  for (const query of ['cursor=nonsense', `cursor=${btoa('[1,2]')}`, 'limit=0', 'limit=2.5']) {
    const { status, body } = await call(handle, 'acme', 'GET', `/threads?${query}`);
    assert.equal(status, 400, `${query} answered ${status}`);
    assert.equal((body.error as { code?: string }).code, 'BAD_REQUEST');
  }
  assert.equal((await call(handle, 'acme', 'GET', '/threads?cursor=')).status, 200, 'an empty cursor is none');
});

test('proof: a tenant pages through its threads across two regions, newest first, each exactly once', async () => {
  const now = clock();
  const west = server(now, 'eu-west');
  const central = server(now, 'eu-central');
  // Interleaved irregularly, so a page takes some from each region, and some pages all from one.
  const order: Array<[typeof west, number]> = [
    [west, 3],
    [central, 1],
    [west, 1],
    [central, 4],
    [west, 2],
  ];
  const created: string[] = [];
  for (const [region, count] of order) {
    for (let index = 0; index < count; index += 1) created.push(await newThread(region.handle, 'acme'));
  }
  const gateway = regionalGateway({
    regions: { 'eu-west': { handle: west.handle }, 'eu-central': { handle: central.handle } },
    residency: policy,
    tenantOf: (request) => request.headers.get('x-tenant') ?? undefined,
  });
  const newest = [...created].reverse();
  for (const limit of [1, 2, 3, 4, 11, 12]) {
    const pages = await walk(gateway.handle, 'acme', '/threads', limit);
    assert.deepEqual(pages.flat(), newest, `every thread once, newest first, a page of ${limit} at a time`);
    assert.equal(pages.length, Math.max(1, Math.ceil(newest.length / limit)), `no empty last page at ${limit}`);
  }

  // A region that does not page by the cursor, as one before 2.18, gives its first page every time:
  // the gateway keeps only what comes after the cursor, so nothing of it repeats.
  const older = [
    { id: 'eu-central~thread-a', createdAt: '2026-10-22T00:00:05.500Z', updatedAt: '2026-10-22T00:00:05.500Z' },
    { id: 'eu-central~thread-b', createdAt: '2026-10-22T00:00:01.500Z', updatedAt: '2026-10-22T00:00:01.500Z' },
  ];
  const mixed = regionalGateway({
    regions: {
      'eu-west': { handle: west.handle },
      'eu-central': { handle: async () => Response.json({ threads: older }) },
    },
    residency: policy,
    tenantOf: (request) => request.headers.get('x-tenant') ?? undefined,
  });
  const westOnly = newest.filter((id) => id.startsWith('eu-west~'));
  const listed = (await walk(mixed.handle, 'acme', '/threads', 2)).flat();
  assert.equal(new Set(listed).size, listed.length, `nothing listed twice: ${listed.join(', ')}`);
  assert.deepEqual(
    listed.filter((id) => !id.startsWith('eu-west~')),
    ['eu-central~thread-a', 'eu-central~thread-b'],
    'the older region’s threads, once each',
  );
  assert.deepEqual(
    listed.filter((id) => id.startsWith('eu-west~')),
    westOnly,
  );
  // And the gateway refuses a cursor no list gave itself, rather than leaving it to a region that would not.
  const refused = await call(mixed.handle, 'acme', 'GET', '/threads?cursor=nonsense');
  assert.deepEqual([refused.status, (refused.body.error as { code?: string }).code], [400, 'BAD_REQUEST']);
});

test('records written in the same instant are listed by id, and page by it, however many a read leaves unread', async () => {
  const instant = new Date('2026-10-22T00:00:00.000Z');
  const { handle } = server(() => instant);
  // Written a to i, so the newest written, read first, are the last by id: a read of six leaves the
  // first three by id unread.
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((letter) => `thread-${letter}`);
  for (const threadId of names) await call(handle, 'acme', 'POST', '/threads', { assistant: 'support', threadId });
  assert.deepEqual(await walk(handle, 'acme', '/threads', 4), [names.slice(0, 4), names.slice(4, 8), names.slice(8)]);
});
