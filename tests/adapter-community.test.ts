/**
 * Compatibility records from community CI: an adapter's own CI publishes its sealed record where its
 * package says, and `nexus adapters gather` collects every such record onto the page, without a pull
 * request and without running anything an adapter publishes. A record is listed only as it was sealed,
 * from HTTPS, and naming its own package; one that cannot be read now keeps the last one read; and the
 * page writes a record as text, colouring a failing adapter red.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  ADAPTER_KEYWORD,
  type CompatibilityRecord,
  compatibilityPage,
  gatherRecords,
  readCompatibilityRecord,
  recordDigest,
} from '../src/adapter-kit/index.js';
import { adapterSource, nexusAsync } from './community-adapter.js';

/** A record this repository ships, sealed, as the base of the records these tests publish. */
const BASE = readCompatibilityRecord(readFileSync('compatibility/records/memory-vectors.json', 'utf8'));

/** A record of the package, sealed as `nexus adapters verify` seals it. */
function sealed(pkg: string | undefined, change: Partial<CompatibilityRecord> = {}): CompatibilityRecord {
  const { digest: _digest, ...rest } = BASE;
  const adapter = { ...BASE.adapter, name: pkg ? pkg.replace(/@[^@/]*$/, '') : 'unnamed', ...change.adapter };
  if (pkg) adapter.package = pkg;
  else delete adapter.package;
  const unsealed = { ...rest, ...change, adapter };
  return { ...unsealed, digest: recordDigest(unsealed) } as CompatibilityRecord;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' }, ...init });

/** npm and the places records are published, as a fetch: each URL answered as `routes` says. */
function web(routes: Record<string, () => Response | Promise<Response>>) {
  const asked: string[] = [];
  const fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const route = routes[url];
    if (!route) return new Response('Not Found', { status: 404 });
    return route();
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const REGISTRY = 'https://registry.test';
const search = (from: number) => `${REGISTRY}/-/v1/search?text=keywords:${ADAPTER_KEYWORD}&size=250&from=${from}`;
const manifest = (name: string) => `${REGISTRY}/${name.replace('/', '%2f')}/latest`;

test('gather: adapter packages are found on npm by keyword, and each record is read from where its package says', async () => {
  const vectors = sealed('@acme/vectors@1.2.0');
  const store = sealed('plain-store@0.3.0');
  const listed = sealed('listed-only@2.0.0');
  const { fetch, asked } = web({
    // Two to a page, as npm pages a long list.
    [search(0)]: () =>
      json({ objects: [{ package: { name: '@acme/vectors' } }, { package: { name: 'plain-store' } }], total: 3 }),
    [search(2)]: () => json({ objects: [{ package: { name: 'no-record' } }], total: 3 }),
    [manifest('@acme/vectors')]: () =>
      json({ name: '@acme/vectors', nexus: { compatibility: 'https://records.test/acme.json' } }),
    [manifest('plain-store')]: () =>
      json({ name: 'plain-store', nexus: { compatibility: ' https://records.test/plain.json ' } }),
    [manifest('no-record')]: () => json({ name: 'no-record', version: '1.0.0' }),
    'https://records.test/acme.json': () => json(vectors),
    'https://records.test/plain.json': () => json(store),
    'https://other.test/listed.json': () => json(listed),
  });
  const report = await gatherRecords({
    registry: REGISTRY,
    fetch,
    sources: [{ package: 'listed-only', url: 'https://other.test/listed.json' }],
  });
  assert.deepEqual(
    report.sources.map((source) => [source.package, source.outcome]),
    [
      ['@acme/vectors', 'gathered'],
      ['listed-only', 'gathered'],
      ['no-record', 'undeclared'],
      ['plain-store', 'gathered'],
    ],
  );
  assert.deepEqual(
    report.records.map((record) => record.adapter.package),
    ['@acme/vectors@1.2.0', 'listed-only@2.0.0', 'plain-store@0.3.0'],
  );
  assert.equal(report.sources[2]?.detail, 'its package.json names no nexus.compatibility record');
  assert.ok(asked.includes(manifest('@acme/vectors')), 'a scoped name, its slash encoded');
  assert.deepEqual(report.records[0], vectors, 'the record as it was published');

  const none = web({});
  const listedOnly = await gatherRecords({
    keyword: false,
    fetch: none.fetch,
    sources: [{ package: 'listed-only', url: 'https://other.test/listed.json' }],
  });
  assert.deepEqual(none.asked, ['https://other.test/listed.json'], 'without a keyword, npm is not searched');
  assert.equal(listedOnly.sources[0]?.outcome, 'unreachable');

  const down = web({ [search(0)]: () => new Response('busy', { status: 503 }) });
  await assert.rejects(
    gatherRecords({ registry: REGISTRY, fetch: down.fetch }),
    /npm could not be searched for "nexus-ai-pro-adapter": it answered 503/,
    'npm down is a failure, not every adapter gone',
  );
});

test('gather: a record is listed only as it was sealed, from HTTPS, and naming its package; one that cannot be read keeps the last', async () => {
  const good = sealed('@acme/vectors@1.2.0');
  const tampered = { ...sealed('@acme/vectors@1.2.0'), runtime: 'node 99' };
  const cases: Array<[string, () => Response | Promise<Response>, RegExp, string?]> = [
    ['tampered', () => json(tampered), /the digest does not match: the record was changed after it was sealed/],
    ['another package', () => json(sealed('@other/x@1.0.0')), /the record names @other\/x@1\.0\.0, not @acme\/vectors/],
    ['no package', () => json(sealed(undefined)), /the record names no package/],
    ['not JSON', () => new Response('<html>'), /Not a valid compatibility record|JSON/],
    [
      'declared too large',
      () => new Response(JSON.stringify(good), { headers: { 'content-length': String(2 * 1024 * 1024) } }),
      /the record is 2097152 bytes, over the 1048576-byte limit/,
    ],
    [
      'redirected to HTTP',
      () => {
        const response = json(good);
        Object.defineProperty(response, 'url', { value: 'http://records.test/acme.json' });
        return response;
      },
      /redirects to http:\/\/records\.test\/acme\.json, which is not HTTPS/,
    ],
    ['missing', () => new Response('Not Found', { status: 404 }), /answered 404/, 'unreachable'],
    [
      'down',
      () => {
        throw new Error('connect ECONNREFUSED');
      },
      /could not be read: connect ECONNREFUSED/,
      'unreachable',
    ],
  ];
  for (const [name, answer, why, outcome = 'refused'] of cases) {
    const { fetch } = web({ 'https://records.test/acme.json': answer });
    const ask = (previous?: CompatibilityRecord[]) =>
      gatherRecords({
        keyword: false,
        fetch,
        sources: [{ package: '@acme/vectors', url: 'https://records.test/acme.json' }],
        ...(previous ? { previous } : {}),
      });
    const alone = (await ask()).sources[0];
    assert.equal(alone?.outcome, outcome, `${name}: ${alone?.detail}`);
    assert.match(alone?.detail ?? '', why, name);
    assert.equal(alone?.record, undefined, `${name}: nothing listed`);
    const kept = (await ask([good])).sources[0];
    assert.equal(kept?.outcome, 'kept', `${name}: the last record is kept`);
    assert.equal(kept?.record, good);
    assert.ok(kept?.detail?.startsWith(`${outcome}: `), `${name}: and says why: ${kept?.detail}`);
  }

  const small = web({ 'https://records.test/acme.json': () => json(good) });
  const capped = await gatherRecords({
    keyword: false,
    fetch: small.fetch,
    maxBytes: 100,
    sources: [{ package: '@acme/vectors', url: 'https://records.test/acme.json' }],
  });
  assert.match(capped.sources[0]?.detail ?? '', /over the 100-byte limit/, 'a body over the limit without a length');

  for (const [url, allowed] of [
    ['http://records.test/acme.json', false],
    ['ftp://records.test/acme.json', false],
    ['not a url', false],
    ['http://127.0.0.1:8080/acme.json', true],
    ['http://localhost/acme.json', true],
  ] as const) {
    const { fetch, asked } = web({ [url]: () => json(good) });
    const report = await gatherRecords({ keyword: false, fetch, sources: [{ package: '@acme/vectors', url }] });
    assert.equal(report.sources[0]?.outcome, allowed ? 'gathered' : 'refused', url);
    assert.equal(asked.length, allowed ? 1 : 0, `${url}: ${allowed ? 'fetched' : 'never fetched'}`);
  }

  // A package that no longer names a record, or is no longer found, does not keep one.
  const { fetch } = web({
    [search(0)]: () => json({ objects: [{ package: { name: '@acme/vectors' } }], total: 1 }),
    [manifest('@acme/vectors')]: () => json({ name: '@acme/vectors' }),
  });
  const gone = await gatherRecords({ registry: REGISTRY, fetch, previous: [good, sealed('left@1.0.0')] });
  assert.deepEqual(gone.records, []);
  assert.deepEqual(
    gone.sources.map((source) => source.outcome),
    ['undeclared'],
  );
});

test('the page writes a record as text: a link only to http or https, one line a cell, and a failing adapter red', () => {
  const hostile = sealed('@acme/x@1.0.0', {
    adapter: {
      ...BASE.adapter,
      name: '@acme/x [see](javascript:alert(1))\n| injected | row | **loud**',
      repository: 'javascript:alert(1)',
    },
    passed: false,
    checks: BASE.checks.map((check, index) => (index === 1 ? { ...check, ok: false } : check)),
  });
  const failing = sealed('@acme/broken@1.0.0', {
    adapter: { ...BASE.adapter, name: '@acme/broken', repository: 'https://example.com/acme (broken)' },
    passed: false,
    checks: BASE.checks.map((check, index) => (index === 1 ? { ...check, ok: false, detail: 'it\nbroke' } : check)),
  });
  const markdown = compatibilityPage([hostile, failing]);
  assert.doesNotMatch(markdown, /[^\\]\]\(javascript:/, 'no link to javascript:');
  assert.ok(
    markdown.includes('| @acme/x \\[see\\](javascript:alert(1)) \\| injected \\| row \\| \\*\\*loud\\*\\* |'),
    'one line, as text, its brackets and stars escaped',
  );
  assert.ok(
    markdown.includes(
      '\n- **@acme/x \\[see\\](javascript:alert(1)) \\| injected \\| row \\| \\*\\*loud\\*\\***: fails: ',
    ),
    `the note of why it fails, as text too:\n${markdown}`,
  );
  assert.ok(
    markdown.includes('[@acme/broken](https://example.com/acme%20%28broken%29)'),
    'a link’s address, its spaces and brackets encoded',
  );
  const html = compatibilityPage([hostile, failing], { format: 'html' });
  assert.ok(!html.includes('href="javascript'), 'no javascript: link in HTML');
  assert.match(html, /<style>[^<]*tr\[data-state="failing"\] td\{color:#cf222e/, 'a failing row red');
  assert.match(
    html,
    /<tr data-state="failing"><td><a href="https:\/\/example.com\/acme \(broken\)">@acme\/broken<\/a>/,
  );
});

/** A stand-in for npm and for where an adapter's CI publishes, served over HTTP on this machine. */
async function standIn() {
  const state = {
    listed: ['@community/tombstone-vectors'],
    published: undefined as string | undefined,
    searchDown: false,
  };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, body: string) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
    };
    if (url.pathname === '/-/v1/search') {
      if (state.searchDown) return send(503, '{"error":"busy"}');
      const objects = url.searchParams.get('text') === `keywords:${ADAPTER_KEYWORD}` ? state.listed : [];
      return send(
        200,
        JSON.stringify({ objects: objects.map((name) => ({ package: { name } })), total: objects.length }),
      );
    }
    if (
      url.pathname === '/@community%2ftombstone-vectors/latest' ||
      url.pathname === '/@community%2Ftombstone-vectors/latest'
    ) {
      return send(
        200,
        JSON.stringify({
          name: '@community/tombstone-vectors',
          nexus: { compatibility: `${base}/ci/tombstone-vectors.json` },
        }),
      );
    }
    if (url.pathname === '/ci/tombstone-vectors.json' && state.published !== undefined)
      return send(200, state.published);
    return send(404, '{"error":"Not found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { state, base, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('proof: a record an adapter’s CI publishes reaches the page with nothing merged, and a failing one turns it red', async () => {
  const kit = pathToFileURL(path.resolve('src/adapter-kit/index.ts')).href;
  const repository = await mkdtemp(path.join(tmpdir(), 'nexus-community-'));
  const site = await mkdtemp(path.join(tmpdir(), 'nexus-site-'));
  const web = await standIn();
  // What this repository lists, which nothing here may change.
  const ours = async () =>
    Promise.all(
      [
        'COMPATIBILITY.md',
        ...(await readdir('compatibility/records')).map((name) => `compatibility/records/${name}`),
      ].map((file) => readFile(file, 'utf8')),
    );
  const before = await ours();
  const records = path.join(site, 'records');
  const gather = () => nexusAsync(['gather', '--out', records, '--registry', web.base], site);
  const pageOf = async () => {
    const page = await nexusAsync(['page', records, '--html', '--out', path.join(site, 'index.html')], site);
    assert.equal(page.status, 0, page.stdout + page.stderr);
    return readFile(path.join(site, 'index.html'), 'utf8');
  };
  /** The adapter's own CI: verify the version it holds, and publish the record wherever its package says. */
  const ci = async (version: string, forgets: boolean) => {
    await writeFile(path.join(repository, 'verify.mjs'), adapterSource(kit, version, forgets));
    const verified = await nexusAsync(
      ['verify', './verify.mjs', '--out', 'compatibility.json', '--package', `@community/tombstone-vectors@${version}`],
      repository,
    );
    assert.equal(verified.status, forgets ? 1 : 0, verified.stdout + verified.stderr);
    web.state.published = await readFile(path.join(repository, 'compatibility.json'), 'utf8');
  };
  try {
    await writeFile(
      path.join(repository, 'package.json'),
      JSON.stringify({ name: '@community/tombstone-vectors', version: '0.4.1', type: 'module' }),
    );

    // The adapter's CI publishes a passing record; the gatherer lists it, without a pull request.
    await ci('0.4.1', false);
    const first = await gather();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(first.stdout, /@community\/tombstone-vectors\s+gathered\s+passing/);
    const file = path.join(records, 'community-tombstone-vectors.json');
    assert.equal(await readFile(file, 'utf8'), `${JSON.stringify(JSON.parse(web.state.published ?? ''), null, 2)}\n`);
    assert.match(
      await pageOf(),
      /<tr data-state="passing"><td><a href="https:\/\/example.com\/community\/tombstone-vectors">@community\/tombstone-vectors<\/a><\/td><td>vector-store<\/td><td>0\.4\.1<\/td>/,
    );

    // A release of it that breaks the contract: its own CI records the failure, and the page turns it red.
    await ci('0.4.2', true);
    const second = await gather();
    assert.match(second.stdout, /@community\/tombstone-vectors\s+gathered\s+failing/);
    const red = await pageOf();
    assert.match(
      red,
      /<tr data-state="failing"><td><a href="https:\/\/example.com\/community\/tombstone-vectors">@community\/tombstone-vectors<\/a><\/td><td>vector-store<\/td><td>0\.4\.2<\/td>/,
    );
    assert.match(red, /tr\[data-state="failing"\] td\{color:#cf222e/);
    assert.match(
      red,
      /<li><strong>@community\/tombstone-vectors<\/strong>: .*adds a passage again under an id it deleted/,
    );

    // While npm cannot be searched, the gather fails and lists every adapter as it was, rather than none;
    // an adapter listed by hand in a sources file is gathered without searching npm.
    web.state.searchDown = true;
    const unsearched = await gather();
    assert.equal(unsearched.status, 1, unsearched.stdout + unsearched.stderr);
    assert.match(unsearched.stderr, /npm could not be searched for "nexus-ai-pro-adapter": it answered 503/);
    assert.equal((await readdir(records)).length, 1, 'the records as they were');
    const sources = path.join(site, 'sources.json');
    await writeFile(
      sources,
      JSON.stringify([{ package: '@community/tombstone-vectors', url: `${web.base}/ci/tombstone-vectors.json` }]),
    );
    // The same registry, still down: --no-keyword never asks it.
    const byHand = await nexusAsync(
      ['gather', '--out', records, '--no-keyword', '--sources', sources, '--registry', web.base],
      site,
    );
    assert.equal(byHand.status, 0, byHand.stdout + byHand.stderr);
    assert.match(byHand.stdout, /@community\/tombstone-vectors\s+gathered\s+failing/);
    web.state.searchDown = false;

    // A record edited after it was sealed is refused, and the last one read is kept; so is one whose source is down.
    web.state.published = (web.state.published ?? '').replace('"passed": false', '"passed": true');
    const edited = await gather();
    assert.match(
      edited.stdout,
      /@community\/tombstone-vectors\s+kept\s+failing\s+refused: .*the digest does not match/,
    );
    assert.equal(
      readCompatibilityRecord(await readFile(file, 'utf8')).adapter.version,
      '0.4.2',
      'the last record read',
    );
    web.state.published = undefined;
    const down = await gather();
    assert.match(down.stdout, /kept\s+failing\s+unreachable: .*answered 404/);

    // A package npm no longer lists leaves the page.
    web.state.listed = [];
    const left = await gather();
    assert.equal(left.status, 0, left.stdout + left.stderr);
    assert.deepEqual(await readdir(records), []);

    assert.deepEqual(await ours(), before, 'nothing in this repository changed: no record merged, no page edited');
  } finally {
    await web.close();
    await rm(repository, { recursive: true, force: true });
    await rm(site, { recursive: true, force: true });
  }
});
