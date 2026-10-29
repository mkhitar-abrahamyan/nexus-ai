/**
 * One studio for many tenants: each person reads their tenant's sources, opened once per tenant, and
 * sees their tenant's comments and audit entries alone; a page token is bound to the tenant.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { tenantScope } from 'nexus-ai-pro/tenancy';
import { MemoryTraceStore } from 'nexus-ai-pro/tracing';
import { createStudio, type Studio } from '../src/api.js';
import { bearerAuth, csrfToken, headerAuth, personalTokens, type StudioRole } from '../src/auth.js';
import { loadUsers } from '../src/cli.js';
import { MemoryStudioJournal, type StudioAuditEntry } from '../src/journal.js';
import type { StudioSources } from '../src/types.js';

const ORIGIN = 'http://127.0.0.1:4747';
const tokenOf = (name: string) => `${name}-token-0123456789abcdef`;
const person = (id: string, role: StudioRole, tenant?: string) => ({
  id,
  role,
  token: tokenOf(`${id}-${tenant ?? 'none'}`),
  ...(tenant === undefined ? {} : { tenant }),
});

const run = (prefix: string, index: number) => ({
  id: `${prefix}-run-${index}`,
  traceId: `${prefix}-trace-${index}`,
  name: `${prefix} agent`,
  kind: 'agent' as const,
  status: 'success' as const,
  startedAt: new Date(Date.UTC(2026, 9, 29, 0, index)).toISOString(),
  endedAt: new Date(Date.UTC(2026, 9, 29, 0, index, 1)).toISOString(),
});

/** A person on the page: their link's cookie, and the page token from their session. */
async function open(studio: Studio, personal: string) {
  const cookie = `nexus_studio=${personal}`;
  const answer = await studio.handle(new Request(`${ORIGIN}/api/session`, { headers: { cookie } }));
  const session =
    answer.status === 200 ? ((await answer.json()) as { token: string; user: { tenant?: string } }) : undefined;
  const call = (route: string, init: { method?: string; body?: unknown; page?: string } = {}) =>
    studio.handle(
      new Request(`${ORIGIN}${route}`, {
        method: init.method ?? 'GET',
        headers: {
          cookie,
          'x-studio-token': init.page ?? session?.token ?? '',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
  return { status: answer.status, session, call };
}

const runIds = async (response: Response) =>
  ((await response.json()) as { runs: Array<{ id: string }> }).runs.map((item) => item.id).sort();

test("each person reads their own tenant's sources, opened once per tenant; someone without a tenant reads the studio's own", async () => {
  const traces = new MemoryTraceStore();
  for (const tenant of ['acme', 'globex']) {
    const scoped = tenantScope(tenant, { traces });
    for (let index = 0; index < 2; index += 1) await scoped.traces.save(run(tenant, index) as never);
  }
  const own = new MemoryTraceStore();
  await own.save(run('ops', 0) as never);

  const opened: string[] = [];
  let failing = true;
  const people = [
    person('ana', 'admin', 'acme'),
    person('gus', 'viewer', 'globex'),
    person('olu', 'admin'),
    person('zed', 'viewer', 'initech'),
    person('kim', 'viewer', 'flaky'),
  ];
  const studio = createStudio(
    { traces: own },
    {
      auth: personalTokens(people),
      tenantSources: async (tenant) => {
        opened.push(tenant);
        if (tenant === 'flaky' && failing) throw new Error('the tenant database is down');
        if (tenant === 'flaky') return tenantScope('acme', { traces });
        return tenant === 'acme' || tenant === 'globex'
          ? (tenantScope(tenant, { traces }) as StudioSources)
          : undefined;
      },
    },
  );
  const [ana, gus, olu, zed, kim] = await Promise.all(people.map((entry) => open(studio, entry.token)));

  assert.deepEqual(await runIds(await ana.call('/api/traces')), ['acme-run-0', 'acme-run-1']);
  assert.deepEqual(await runIds(await ana.call('/api/traces')), ['acme-run-0', 'acme-run-1']);
  assert.equal((await ana.call('/api/traces/globex-trace-0')).status, 404, "another tenant's trace is not found");
  assert.deepEqual(await runIds(await gus.call('/api/traces')), ['globex-run-0', 'globex-run-1']);
  assert.deepEqual(await runIds(await olu.call('/api/traces')), ['ops-run-0'], 'no tenant: the studio’s own sources');
  assert.equal(ana.session?.user.tenant, 'acme', 'the session says whose tenant it is');

  const unknown = await zed.call('/api/traces');
  assert.equal(unknown.status, 403);
  assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, 'FORBIDDEN_TENANT');
  assert.equal((await zed.call('/api/traces')).status, 403);

  assert.equal((await kim.call('/api/traces')).status, 500, 'a tenant that fails to open is an error');
  failing = false;
  assert.equal((await kim.call('/api/traces')).status, 200, 'and is opened again next time');
  assert.deepEqual(
    opened,
    // The page's own session request opens the tenant too, so each known tenant appears once.
    ['acme', 'globex', 'initech', 'flaky', 'initech', 'initech', 'flaky', 'flaky'],
    'acme and globex are opened once each; an unknown tenant and a failed one are asked for each time',
  );

  // A studio given no tenantSources refuses anyone with a tenant, and serves everyone else.
  const plain = createStudio({ traces: own }, { auth: personalTokens(people) });
  const refused = await (await open(plain, people[0]?.token ?? '')).call('/api/traces');
  assert.equal(refused.status, 403);
  assert.match(((await refused.json()) as { error: { message: string } }).error.message, /belongs to a tenant/);
  assert.equal((await (await open(plain, people[2]?.token ?? '')).call('/api/traces')).status, 200);
});

test("a tenant's comments and audit entries are its own, and a page token does not cross tenants", async () => {
  // An audit log that ignores every filter, as a careless one might: the studio still keeps tenants apart.
  const entries: StudioAuditEntry[] = [];
  const careless = {
    append: (entry: StudioAuditEntry) => void entries.push(entry),
    list: () => [...entries].reverse(),
  };
  const comments = new MemoryStudioJournal();
  const people = [
    person('ana', 'admin', 'acme'),
    person('gus', 'reviewer', 'globex'),
    person('olu', 'admin'),
    person('ana', 'admin', 'globex'),
  ];
  const studio = createStudio(
    {},
    {
      auth: personalTokens(people),
      audit: careless,
      comments,
      tenantSources: () => ({}),
      secret: 'a-secret-the-replicas-share-0123456789',
    },
  );
  const [ana, gus, olu, anaElsewhere] = await Promise.all(people.map((entry) => open(studio, entry.token)));

  for (const [who, body] of [
    [ana, 'acme thinks this prompt is fine'],
    [gus, 'globex wants a shorter answer'],
    [olu, 'the operators agree'],
  ] as const) {
    const posted = await who.call('/api/comments', { method: 'POST', body: { subject: 'prompt:answer', body } });
    assert.equal(posted.status, 200);
  }
  const read = async (who: typeof ana) =>
    (
      (await (await who.call('/api/comments?subject=prompt:answer')).json()) as { comments: Array<{ body: string }> }
    ).comments.map((comment) => comment.body);
  assert.deepEqual(await read(ana), ['acme thinks this prompt is fine']);
  assert.deepEqual(await read(gus), ['globex wants a shorter answer']);
  assert.deepEqual(await read(olu), ['the operators agree'], 'someone without a tenant sees the untenanted comments');
  assert.equal((await comments.listComments('prompt:answer'))[0]?.tenant, 'acme', 'a comment records its tenant');

  const audit = async (who: typeof ana, query = '') =>
    ((await (await who.call(`/api/audit${query}`)).json()) as { entries: StudioAuditEntry[] }).entries.map(
      (entry) => `${entry.user} ${entry.tenant ?? '-'}`,
    );
  assert.deepEqual(await audit(ana), ['ana acme'], "a tenant's admin reads their tenant's entries alone");
  assert.deepEqual(await audit(ana, '?tenant=globex'), ['ana acme'], 'and cannot ask for another tenant');
  assert.deepEqual(
    await audit(olu),
    ['olu -', 'gus globex', 'ana acme'],
    'an operator reads every entry, newest first',
  );
  assert.deepEqual(await audit(olu, '?tenant=globex'), ['gus globex'], 'or one tenant’s');

  // The same person and role in another tenant has another page token.
  assert.notEqual(ana.session?.token, anaElsewhere.session?.token);
  const crossed = await anaElsewhere.call('/api/comments', {
    method: 'POST',
    body: { subject: 'prompt:answer', body: 'sent with acme’s page token' },
    page: ana.session?.token,
  });
  assert.equal(crossed.status, 403, "a page token from one tenant does not carry a change in another's");

  // Without a tenant, the page token is the one earlier versions derived, so pages survive an upgrade.
  const secret = 'a-secret-the-replicas-share-0123456789';
  assert.equal(
    csrfToken(secret, { id: 'olu', role: 'admin' }),
    createHmac('sha256', secret).update('olu\u0000admin').digest('base64url'),
  );
  assert.equal(
    csrfToken(secret, { id: 'olu', role: 'admin', tenant: 'acme' }),
    createHmac('sha256', secret).update('olu\u0000admin\u0000acme').digest('base64url'),
  );

  // The journal is asked for the tenant's entries, so a limit counts theirs, however many others are newer.
  const kept = new MemoryStudioJournal();
  const limited = createStudio(
    {},
    { auth: personalTokens(people), audit: kept, comments: kept, tenantSources: () => ({}) },
  );
  const first = await open(limited, people[0]?.token ?? '');
  const second = await open(limited, people[1]?.token ?? '');
  await first.call('/api/comments', { method: 'POST', body: { subject: 'run:1', body: 'first' } });
  await second.call('/api/comments', { method: 'POST', body: { subject: 'run:1', body: 'second' } });
  const latest = (await (await first.call('/api/audit?limit=1')).json()) as { entries: StudioAuditEntry[] };
  assert.deepEqual(
    latest.entries.map((entry) => `${entry.user} ${entry.tenant}`),
    ['ana acme'],
  );

  const journal = new MemoryStudioJournal();
  for (const tenant of ['acme', undefined, 'globex']) {
    journal.append({
      at: '2026-10-29T00:00:00.000Z',
      user: 'ana',
      role: 'admin',
      action: 'comment.add',
      method: 'POST',
      path: '/api/comments',
      ...(tenant === undefined ? {} : { tenant }),
      outcome: 'ok',
      status: 200,
    });
  }
  assert.deepEqual(
    journal.list({ tenant: 'acme' }).map((entry) => entry.tenant),
    ['acme'],
    "the journal lists one tenant's entries",
  );
  assert.equal(journal.list().length, 3);
});

test('authenticators carry the tenant: from a header once it is named, from a claim, and from the users file', async () => {
  const proxy = { header: 'x-proxy-secret', value: 'proxy-secret-0123456789' };
  const fromProxy = headerAuth({ secret: proxy, tenant: 'x-forwarded-tenant' });
  const request = (headers: Record<string, string>) =>
    new Request(`${ORIGIN}/`, { headers: { 'x-proxy-secret': proxy.value, 'x-forwarded-user': 'ana', ...headers } });
  assert.deepEqual(await fromProxy(request({ 'x-forwarded-tenant': ' acme ' }), {}), {
    id: 'ana',
    role: 'viewer',
    tenant: 'acme',
  });
  assert.equal(await fromProxy(request({}), {}), undefined, 'a proxy that lost the tenant does not open every tenant');
  assert.equal(await fromProxy(request({ 'x-forwarded-tenant': ' ' }), {}), undefined);
  assert.deepEqual(
    await headerAuth({ secret: proxy })(request({ 'x-forwarded-tenant': 'acme' }), {}),
    { id: 'ana', role: 'viewer' },
    'a header that was not named is not read',
  );

  const service = (tenant?: (claims: Record<string, unknown>) => string | undefined) =>
    bearerAuth({
      verify: () => ({ sub: 'svc', org: 'acme' }),
      role: () => 'viewer',
      ...(tenant ? { tenant } : {}),
    })(new Request(`${ORIGIN}/api/traces`, { headers: { authorization: 'Bearer token' } }), {});
  assert.deepEqual(await service((claims) => claims.org as string), { id: 'svc', role: 'viewer', tenant: 'acme' });
  assert.deepEqual(await service(() => undefined), { id: 'svc', role: 'viewer' });

  const work = await mkdtemp(path.join(tmpdir(), 'nexus-studio-tenants-'));
  try {
    const file = path.join(work, 'users.json');
    await writeFile(file, JSON.stringify([{ id: 'ana', role: 'admin', token: tokenOf('ana'), tenant: 'acme' }]));
    assert.equal((await loadUsers(file))[0]?.tenant, 'acme');
    await writeFile(file, JSON.stringify([{ id: 'ana', role: 'admin', token: tokenOf('ana'), tenant: 7 }]));
    await assert.rejects(loadUsers(file), /optional "tenant"/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
