/**
 * The studio's threat review, as tests: every route is called by every role and refuses the roles
 * below its own, hostile paths, queries, and bodies never make a route fail with a server error, a
 * change needs proof it came from the studio's page, a body past the limit is refused before anyone
 * is signed in, and the server soaks with flat memory and no handle left open.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ContextHub } from 'nexus-ai-pro/context-hub';
import { MemoryProposalStore, ProposalInbox } from 'nexus-ai-pro/insights';
import { Deployments } from 'nexus-ai-pro/server/deployments';
import { tenantScope } from 'nexus-ai-pro/tenancy';
import { MemoryTraceStore } from 'nexus-ai-pro/tracing';
import { createDemoSources } from '../example/demo.js';
import { createStudio, type Studio } from '../src/api.js';
import { csrfToken, headerAuth, personalTokens, STUDIO_ROLES, type StudioRole } from '../src/auth.js';
import { FileStudioJournal, MemoryStudioJournal } from '../src/journal.js';
import { startStudio } from '../src/server.js';

const ORIGIN = 'http://127.0.0.1:4747';
const SECRET = 'a-fixed-secret-for-these-tests';
const TOKENS: Record<StudioRole, string> = {
  viewer: 'viewer-token-0123456789',
  reviewer: 'reviewer-token-0123456789',
  editor: 'editor-token-0123456789',
  admin: 'admin-token-0123456789',
};
const userOf = (role: StudioRole) => ({ id: `${role}@example.com`, role });
const rank = (role: StudioRole) => STUDIO_ROLES.indexOf(role);

let studio: Studio;
let journal: MemoryStudioJournal;
let work: string;

before(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'nexus-studio-security-'));
  const demo = await createDemoSources();
  journal = new MemoryStudioJournal();
  studio = createStudio(
    {
      ...demo,
      contexts: new ContextHub({ prompts: demo.prompts as never }),
      proposals: new ProposalInbox({ store: new MemoryProposalStore() }),
      deployments: new Deployments(),
    },
    {
      auth: personalTokens(STUDIO_ROLES.map((role) => ({ ...userOf(role), token: TOKENS[role] }))),
      audit: journal,
      comments: journal,
      secret: SECRET,
    },
  );
});
after(async () => {
  await rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** A request from a signed-in person's page: their cookie, and their page token on a change. */
function call(
  role: StudioRole,
  method: string,
  route: string,
  init: { body?: string; headers?: Record<string, string>; page?: boolean } = {},
) {
  const change = method !== 'GET';
  return studio.handle(
    new Request(`${ORIGIN}${route}`, {
      method,
      headers: {
        cookie: `nexus_studio=${TOKENS[role]}`,
        ...(change && init.page !== false ? { 'x-studio-token': csrfToken(SECRET, userOf(role)) } : {}),
        ...(change && init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
      ...(change && init.body !== undefined ? { body: init.body } : {}),
    }),
  );
}

const fill = (route: string, value: string) => route.replace(/:[A-Za-z]+/g, value);

test('every route refuses every role below its own, and records each refusal', async () => {
  assert.ok(studio.routes.length >= 40, `the studio has ${studio.routes.length} routes`);
  let refused = 0;
  for (const route of studio.routes) {
    for (const role of STUDIO_ROLES) {
      const response = await call(role, route.method, fill(route.path, 'x'), {
        ...(route.method === 'GET' ? {} : { body: '{}' }),
      });
      const label = `${role} ${route.method} ${route.path}`;
      if (rank(role) < rank(route.role)) {
        assert.equal(response.status, 403, label);
        assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'FORBIDDEN_ROLE', label);
        const [entry] = journal.list({ user: `${role}@example.com`, limit: 1 });
        assert.deepEqual(
          [entry?.action, entry?.outcome, entry?.status],
          [route.action, 'denied', 403],
          `${label}: the refusal is recorded`,
        );
        refused += 1;
      } else {
        assert.notEqual(response.status, 403, label);
        assert.ok(response.status < 500, `${label} answered ${response.status}`);
      }
    }
  }
  assert.ok(refused >= 30, `${refused} refusals checked`);
});

test('hostile paths, queries, and bodies never make a route fail with a server error', async () => {
  const values = [
    '%',
    '%E0%A4%A',
    '..%2F..%2Fetc%2Fpasswd',
    encodeURIComponent('x'.repeat(4_096)),
    encodeURIComponent('<script>alert(1)</script>'),
    '%00',
    encodeURIComponent('😀'),
    'constructor',
    '__proto__',
  ];
  const bodies = [
    '',
    'not json',
    '[]',
    '"text"',
    '42',
    'null',
    '{"__proto__":{"role":"admin"},"constructor":{"prototype":{"polluted":true}}}',
    '{"to":{"$gt":""},"from":["a"],"version":{},"traffic":"all","action":"promote","revision":1}',
    `${'['.repeat(2_000)}${']'.repeat(2_000)}`,
    JSON.stringify({ body: 'x'.repeat(20_000), subject: 'run:a', score: 'high', key: null }),
  ];
  const queries = ['?limit=0', '?limit=-1', '?limit=abc', '?limit=1e9', '?hours=999999', '?days=100000', '?step=x'];
  let calls = 0;
  for (const route of studio.routes) {
    for (const value of values) {
      const target = fill(route.path, value);
      if (route.method === 'GET') {
        for (const query of ['', ...queries]) {
          const response = await call('admin', 'GET', `${target}${query}`);
          assert.ok(response.status < 500, `GET ${target}${query} answered ${response.status}`);
          calls += 1;
        }
      } else {
        for (const body of bodies) {
          const response = await call('admin', route.method, target, { body });
          assert.ok(
            response.status < 500,
            `${route.method} ${target} with ${body.slice(0, 40)} answered ${response.status}`,
          );
          calls += 1;
        }
      }
    }
  }
  assert.equal(({} as { polluted?: boolean; role?: string }).polluted, undefined, 'no prototype was polluted');
  assert.equal(({} as { role?: string }).role, undefined);
  assert.ok(calls > 2_000, `${calls} hostile requests`);

  const malformed = await call('admin', 'GET', '/api/prompts/%E0%A4%A');
  assert.equal(malformed.status, 400);
  const tooMany = await call('admin', 'GET', '/api/traces?limit=1000000');
  assert.equal(tooMany.status, 400);
  assert.match(((await tooMany.json()) as { error: { message: string } }).error.message, /at most 1,000/);
});

test('a change needs proof it came from the studio page, and a browser cannot supply it from elsewhere', async () => {
  const route = '/api/comments';
  const body = JSON.stringify({ subject: 'run:abc', body: 'hello' });
  // A page on another site can send the cookie at most, never the header.
  const forged = await call('reviewer', 'POST', route, { body, page: false });
  assert.equal(forged.status, 403);
  assert.deepEqual(
    (({ action, outcome, status }) => ({ action, outcome, status }))(journal.list({ limit: 1 })[0] ?? ({} as never)),
    { action: 'comment.add', outcome: 'denied', status: 403 },
    'the forged change is recorded',
  );
  // A browser adds Basic credentials to another site's request by itself; they prove nothing.
  const basic = await call('reviewer', 'POST', route, {
    body,
    page: false,
    headers: { authorization: `Basic ${Buffer.from('rui:secret').toString('base64')}` },
  });
  assert.equal(basic.status, 403);
  // A form can send text/plain without a preflight; a change must be JSON.
  const plain = await call('reviewer', 'POST', route, { body, headers: { 'content-type': 'text/plain' } });
  assert.equal(plain.status, 415);
  assert.equal((await call('reviewer', 'POST', route, { body })).status, 200, 'the page itself is allowed');
  // A script with a bearer token is not a browser on another site.
  const script = await studio.handle(
    new Request(`${ORIGIN}${route}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKENS.reviewer}`, 'content-type': 'application/json' },
      body,
    }),
  );
  assert.equal(script.status, 200);

  // Behind a sign-in proxy that uses Basic authentication, the proxy's identity headers arrive with
  // Basic credentials the browser attached. Before 2.5, that alone let a change through.
  const proxied = createStudio({ comments: journal } as never, {
    auth: headerAuth({ trustedProxies: ['10.0.0.1'], defaultRole: 'admin' }),
    secret: SECRET,
    comments: journal,
  });
  const viaProxy = await proxied.handle(
    new Request(`${ORIGIN}${route}`, {
      method: 'POST',
      headers: {
        'x-forwarded-user': 'ana@example.com',
        authorization: `Basic ${Buffer.from('ana:secret').toString('base64')}`,
        'content-type': 'application/json',
      },
      body,
    }),
    { remoteAddress: '10.0.0.1' },
  );
  assert.equal(viaProxy.status, 403, 'a cross-site form through a Basic-auth proxy is refused');
});

test('a body past the limit is refused before anyone is signed in, by the handler and the server', async () => {
  const large = 'x'.repeat(1_048_577);
  const refused = await studio.handle(
    new Request(`${ORIGIN}/api/comments`, {
      method: 'POST',
      body: large,
      headers: { 'content-type': 'application/json' },
    }),
  );
  assert.equal(refused.status, 413, 'refused before the missing identity is noticed');
  const small = createStudio({}, { token: 'small-token', maxBodyBytes: 10 });
  const tooLong = await small.handle(
    new Request(`${ORIGIN}/api/comments`, {
      method: 'POST',
      body: '{"body":"hello there"}',
      headers: { 'x-studio-token': 'small-token', 'content-type': 'application/json' },
    }),
  );
  assert.equal(tooLong.status, 413);

  const running = await startStudio({}, { port: 0, token: 'server-token-0123456789', maxBodyBytes: 1_024 });
  try {
    const response = await fetch(`http://127.0.0.1:${running.port}/api/comments`, {
      method: 'POST',
      body: 'x'.repeat(64 * 1_024),
      headers: { 'content-type': 'application/json' },
    }).catch((error: unknown) => error);
    // The server answers 413 and closes; a client may see the answer or the closed connection.
    if (response instanceof Response) assert.equal(response.status, 413);
    const next = await fetch(`http://127.0.0.1:${running.port}/api/overview`, {
      headers: { 'x-studio-token': 'server-token-0123456789' },
    });
    assert.equal(next.status, 200, 'the server keeps serving');
  } finally {
    await running.close();
  }
});

test('another host, no identity, and every response carry the studio’s protections', async () => {
  for (const route of studio.routes) {
    const target = fill(route.path, 'x');
    const evil = await studio.handle(
      new Request(`http://evil.example${target}`, {
        method: route.method,
        headers: { cookie: `nexus_studio=${TOKENS.admin}` },
      }),
    );
    assert.equal(evil.status, 403, `${route.method} ${target} from another host`);
    const anonymous = await studio.handle(new Request(`${ORIGIN}${target}`, { method: route.method }));
    assert.equal(anonymous.status, 401, `${route.method} ${target} without an identity`);
    for (const response of [evil, anonymous]) {
      assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
  }
  const entry = await studio.handle(
    new Request(`${ORIGIN}/?token=${TOKENS.viewer}`, { headers: { 'x-forwarded-proto': 'https' } }),
  );
  assert.equal(entry.status, 303);
  assert.equal(entry.headers.get('location'), '/', 'the token leaves the address bar');
  assert.match(entry.headers.get('set-cookie') ?? '', /HttpOnly; SameSite=Strict; Path=\/; Secure$/);
});

test("a studio over one tenant's scoped stores shows that tenant's runs, and never another's", async () => {
  const traces = new MemoryTraceStore();
  const run = (tenant: string, index: number) => ({
    id: `${tenant}-run-${index}`,
    traceId: `${tenant}-trace-${index}`,
    name: `${tenant} agent`,
    kind: 'agent' as const,
    status: 'success' as const,
    startedAt: new Date(Date.UTC(2026, 9, 9, 0, index)).toISOString(),
    endedAt: new Date(Date.UTC(2026, 9, 9, 0, index, 1)).toISOString(),
  });
  for (const tenant of ['acme', 'globex']) {
    const scoped = tenantScope(tenant, { traces });
    for (let index = 0; index < 5; index += 1) await scoped.traces.save(run(tenant, index) as never);
  }
  const acme = createStudio(tenantScope('acme', { traces }), { token: 'acme-token-0123456789' });
  const read = (route: string) =>
    acme.handle(new Request(`${ORIGIN}${route}`, { headers: { 'x-studio-token': 'acme-token-0123456789' } }));
  const listed = (await (await read('/api/traces')).json()) as { runs: Array<{ id: string }> };
  assert.equal(listed.runs.length, 5);
  assert.ok(
    listed.runs.every((item) => item.id.startsWith('acme-')),
    'only acme runs are listed',
  );
  assert.equal((await read('/api/traces/globex-trace-0')).status, 404, "another tenant's trace is not found");
  assert.equal((await read('/api/traces/acme-trace-0')).status, 200);
  const issues = (await (await read('/api/issues?hours=2160')).json()) as unknown;
  assert.ok(!JSON.stringify(issues).includes('globex'), 'nothing of globex reaches the issues view');
});

test('the journal reads what 2.4 wrote, skips a line a crash cut short, and bounds what it keeps', async () => {
  const directory = path.join(work, 'journal');
  const file = new FileStudioJournal(directory);
  await file.append({
    at: '2026-10-01T00:00:00.000Z',
    user: 'ana@example.com',
    role: 'admin',
    action: 'prompt.promote',
    method: 'POST',
    path: '/api/prompts/answer/promote',
    outcome: 'ok',
    status: 200,
  });
  await writeFile(path.join(directory, 'audit.jsonl'), '{"at":"2026-10-02', { flag: 'a' });
  const entries = await file.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.action, 'prompt.promote');

  const bounded = new MemoryStudioJournal({ maxEntries: 3, maxComments: 2 });
  for (let index = 0; index < 5; index += 1) {
    bounded.append({ ...(entries[0] as NonNullable<(typeof entries)[0]>), action: `a${index}` });
    bounded.addComment({ id: `c${index}`, subject: 'run:a', body: `${index}`, author: 'ana', at: '' });
  }
  assert.deepEqual(
    bounded.list().map((entry) => entry.action),
    ['a4', 'a3', 'a2'],
  );
  assert.deepEqual(
    bounded.listComments('run:a').map((comment) => comment.body),
    ['3', '4'],
  );
});

/** The yardstick the surface budgets use, so a budget written on a laptop holds on a slower runner. */
async function calibrate(): Promise<number> {
  const record = {
    id: 'r',
    items: Array.from({ length: 200 }, (_, index) => ({ index, label: `item-${index}`, tags: ['a', 'b'] })),
  };
  const samples: number[] = [];
  for (let round = 0; round < 9; round += 1) {
    const started = performance.now();
    let sum = 0;
    for (let inner = 0; inner < 200; inner += 1) sum += JSON.parse(JSON.stringify(record)).items.length;
    const numbers = Array.from({ length: 20_000 }, (_, index) => (index * 7919) % 10_007);
    numbers.sort((a, b) => a - b);
    samples.push(performance.now() - started + (sum + (numbers[0] as number)) * 0);
  }
  return samples.sort((a, b) => a - b)[4] as number;
}

/** Measured on 2026-10-09: 500 signed-in reads take 0.84 calibration loops. A cliff fails, not noise. */
const LOAD_RATIO = 0.85;
const TOLERANCE = 3;

test('load: 500 signed-in reads of the overview and traces stay within their budget', async () => {
  const read = async () => {
    for (let index = 0; index < 250; index += 1) {
      await call('viewer', 'GET', '/api/overview');
      await call('viewer', 'GET', '/api/traces');
    }
  };
  await read();
  const started = performance.now();
  await read();
  const elapsed = performance.now() - started;
  const ratio = elapsed / (await calibrate());
  assert.ok(ratio <= LOAD_RATIO * TOLERANCE, `500 reads took ${ratio.toFixed(2)} calibration loops`);
});

test('soak: 2,000 sign-in, read, and change cycles leave memory flat, and 200 servers leave no handle', async () => {
  const gc = (globalThis as { gc?: () => void }).gc;
  assert.ok(gc, 'the studio tests run with --expose-gc');
  const cycle = async (index: number) => {
    const entry = await studio.handle(new Request(`${ORIGIN}/?token=${TOKENS.reviewer}`));
    assert.equal(entry.status, 303);
    await call('reviewer', 'GET', '/api/overview');
    await call('reviewer', 'POST', '/api/comments', {
      body: JSON.stringify({ subject: `run:soak-${index % 100}`, body: `note ${index}` }),
    });
    await call('reviewer', 'GET', `/api/comments?subject=run:soak-${index % 100}`);
    await call('viewer', 'POST', '/api/comments', { body: '{}' });
  };
  for (let index = 0; index < 200; index += 1) await cycle(index);
  gc();
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let index = 0; index < 2_000; index += 1) await cycle(index);
  gc();
  gc();
  const grownMb = (process.memoryUsage().heapUsed - before) / 1_048_576;
  // The journal keeps up to 10,000 comments and 10,000 audit entries by design; these fit well within.
  assert.ok(grownMb < 8, `the heap grew ${grownMb.toFixed(2)} MB over 2,000 cycles`);

  const handles = () => {
    const counts: Record<string, number> = {};
    for (const kind of process.getActiveResourcesInfo()) counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  };
  const held = handles();
  for (let index = 0; index < 200; index += 1) {
    const running = await startStudio({}, { port: 0, token: 'soak-token-0123456789' });
    const response = await fetch(`http://127.0.0.1:${running.port}/api/overview`, {
      headers: { 'x-studio-token': 'soak-token-0123456789' },
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    await running.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  const left = Object.entries(handles()).filter(([kind, count]) => count > (held[kind] ?? 0));
  assert.deepEqual(left, [], 'no server, socket, or timer left open');
});
