import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { ContextHub, contextExperimentGate } from 'nexus-ai-pro/context-hub';
import { createDataset, contains, MemoryExperimentStore } from 'nexus-ai-pro/evaluate';
import { findIssues, MemoryProposalStore, ProposalInbox, proposeFix } from 'nexus-ai-pro/insights';
import { evaluatePrompt, experimentGate, PromptRegistry } from 'nexus-ai-pro/prompts/registry';
import { MemoryTraceStore } from 'nexus-ai-pro/tracing';
import { createStudio } from '../src/api.js';
import { anyOf, bearerAuth, headerAuth, personalTokens } from '../src/auth.js';
import { loadConfig, loadUsers } from '../src/cli.js';
import { FileStudioJournal, MemoryStudioJournal } from '../src/journal.js';
import { startStudio } from '../src/server.js';

const ORIGIN = 'http://127.0.0.1:4747';
const ANA = 'ana-token-0123456789abcdef';
const RUI = 'rui-token-0123456789abcdef';
const VIC = 'vic-token-0123456789abcdef';
const users = personalTokens([
  { id: 'ana@example.com', name: 'Ana', role: 'admin', token: ANA },
  { id: 'rui@example.com', name: 'Rui', role: 'reviewer', token: RUI },
  { id: 'vic@example.com', role: 'viewer', token: VIC },
]);
let work: string;
before(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'nexus-studio-team-'));
});
after(async () => {
  await rm(work, { recursive: true, force: true });
});

/** A person using the studio's page: the cookie from their link, and the page token from the session. */
async function signIn(studio: ReturnType<typeof createStudio>, token: string) {
  const entry = await studio.handle(new Request(`${ORIGIN}/?token=${token}`));
  assert.equal(entry.status, 303);
  const cookie = (entry.headers.get('set-cookie') ?? '').split(';')[0] as string;
  const session = (await (
    await studio.handle(new Request(`${ORIGIN}/api/session`, { headers: { cookie } }))
  ).json()) as {
    token: string;
    user: { id: string; role: string };
  };
  const call = (route: string, init: { method?: string; body?: unknown; page?: boolean } = {}) =>
    studio.handle(
      new Request(`${ORIGIN}${route}`, {
        method: init.method ?? 'GET',
        headers: {
          cookie,
          ...(init.page === false ? {} : { 'x-studio-token': session.token }),
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
  return { session, call, post: (route: string, body: unknown = {}) => call(route, { method: 'POST', body }) };
}

test('roles decide what each person may do, every change is audited, and nobody can act as someone else', async () => {
  const registry = new PromptRegistry();
  await registry.commit({ name: 'answer', messages: [{ role: 'user', content: 'Hi {{name}}' }] }, { label: 'staging' });
  const reviews = {
    list: () => [],
    claim: (reviewer: string) => ({ id: 'item-1', reviewer }),
    submit: (id: string, answer: unknown) => ({ id, answer }),
  };
  const journal = new MemoryStudioJournal();
  const studio = createStudio(
    { prompts: registry, reviews: { triage: reviews as never } },
    { auth: users, audit: journal, comments: journal },
  );

  assert.equal((await studio.handle(new Request(`${ORIGIN}/api/overview`))).status, 401, 'no identity, no access');
  assert.equal((await studio.handle(new Request(`${ORIGIN}/`))).status, 401);
  const ana = await signIn(studio, ANA);
  const rui = await signIn(studio, RUI);
  const vic = await signIn(studio, VIC);
  assert.deepEqual(ana.session.user, { id: 'ana@example.com', name: 'Ana', role: 'admin' });
  assert.notEqual(ana.session.token, ANA, 'the page token is not the personal token');
  assert.notEqual(ana.session.token, rui.session.token);

  const overview = (await (await vic.call('/api/overview')).json()) as {
    user: { role: string };
    accounts: boolean;
    sources: { audit: boolean };
  };
  assert.equal(overview.user.role, 'viewer');
  assert.equal(overview.accounts, true);
  assert.equal(overview.sources.audit, false, 'only an admin sees the audit log');

  const denied = await rui.post('/api/prompts/answer/promote', { from: 'staging', to: 'production' });
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as { error: { code: string } }).error.code, 'FORBIDDEN_ROLE');
  assert.equal((await ana.post('/api/prompts/answer/promote', { from: 'staging', to: 'production' })).status, 200);
  assert.equal((await registry.labels('answer')).find((label) => label.label === 'production')?.by, 'ana@example.com');

  const claimed = (await (await rui.post('/api/reviews/triage/claim', { reviewer: 'ana@example.com' })).json()) as {
    item: { reviewer: string };
  };
  assert.equal(claimed.item.reviewer, 'rui@example.com', 'a person reviews as themselves, whatever the body says');
  assert.equal((await vic.post('/api/reviews/triage/claim')).status, 403, 'a viewer cannot review');

  assert.equal(
    (await ana.call('/api/prompts/answer/promote', { method: 'POST', body: {}, page: false })).status,
    403,
    'a change without the page token is refused',
  );
  assert.equal(
    (
      await studio.handle(
        new Request(`${ORIGIN}/api/prompts/answer/rollback`, {
          method: 'POST',
          headers: { authorization: `Bearer ${ANA}`, 'content-type': 'application/json' },
          body: JSON.stringify({ label: 'production' }),
        }),
      )
    ).status,
    404,
    'a script with a bearer token needs no page token (and the label has no earlier version)',
  );

  assert.equal((await rui.call('/api/audit')).status, 403);
  const { entries } = (await (await ana.call('/api/audit')).json()) as {
    entries: Array<{ user: string; action: string; outcome: string; status: number }>;
  };
  assert.deepEqual(
    entries.map((entry) => `${entry.user} ${entry.action} ${entry.outcome}`),
    [
      'rui@example.com audit.read denied',
      'ana@example.com prompt.rollback failed',
      'vic@example.com review.claim denied',
      'rui@example.com review.claim ok',
      'ana@example.com prompt.promote ok',
      'rui@example.com prompt.promote denied',
    ],
    'every change and every refusal is recorded, newest first; allowed reads are not',
  );
});

test('comments are kept per subject, and only reviewers and above write them', async () => {
  const directory = path.join(work, 'journal');
  const journal = new FileStudioJournal(directory);
  const studio = createStudio({}, { auth: users, audit: journal, comments: journal });
  const rui = await signIn(studio, RUI);
  const vic = await signIn(studio, VIC);
  assert.equal(
    (await rui.post('/api/comments', { subject: 'run:abc', body: '  Looks like a timeout.  ' })).status,
    200,
  );
  assert.equal((await vic.post('/api/comments', { subject: 'run:abc', body: 'me too' })).status, 403);
  assert.equal((await rui.post('/api/comments', { subject: 'nonsense', body: 'x' })).status, 400);
  assert.equal((await rui.post('/api/comments', { subject: 'run:abc', body: '   ' })).status, 400);
  const { comments } = (await (await vic.call('/api/comments?subject=run%3Aabc')).json()) as {
    comments: Array<{ body: string; author: string; authorName: string }>;
  };
  assert.deepEqual(
    comments.map((comment) => [comment.body, comment.author, comment.authorName]),
    [['Looks like a timeout.', 'rui@example.com', 'Rui']],
  );
  const reopened = new FileStudioJournal(directory);
  assert.equal((await reopened.listComments('run:abc')).length, 1, 'comments survive a restart');
  assert.equal((await reopened.list({ user: 'vic@example.com' }))[0]?.outcome, 'denied');
});

test('identity from a proxy is trusted only from the proxy, and bearer tokens are verified by your function', async () => {
  assert.throws(() => headerAuth({}), /secret header or trusted proxy/);
  const proxy = headerAuth({
    secret: { header: 'x-proxy-secret', value: 'proxy-shared-secret' },
    role: ({ groups }) => (groups.includes('ml-admins') ? 'admin' : groups.includes('ml') ? 'editor' : undefined),
  });
  const request = (headers: Record<string, string>) => new Request(`${ORIGIN}/api/session`, { headers });
  assert.deepEqual(
    await proxy(
      request({
        'x-proxy-secret': 'proxy-shared-secret',
        'x-forwarded-user': 'ana',
        'x-forwarded-email': 'ana@example.com',
        'x-forwarded-groups': 'ml, ml-admins',
      }),
      {},
    ),
    { id: 'ana', role: 'admin', email: 'ana@example.com' },
  );
  assert.equal(
    await proxy(request({ 'x-forwarded-user': 'ana', 'x-forwarded-groups': 'ml-admins' }), {}),
    undefined,
    'no proxy secret, no identity',
  );
  assert.equal(
    await proxy(
      request({ 'x-proxy-secret': 'proxy-shared-secret', 'x-forwarded-user': 'eve', 'x-forwarded-groups': 'sales' }),
      {},
    ),
    undefined,
    'no role, no access',
  );

  const byAddress = headerAuth({ trustedProxies: ['10.0.0.5'], defaultRole: 'reviewer' });
  assert.equal(
    (await byAddress(request({ 'x-forwarded-user': 'rui' }), { remoteAddress: '::ffff:10.0.0.5' }))?.role,
    'reviewer',
  );
  assert.equal(await byAddress(request({ 'x-forwarded-user': 'rui' }), { remoteAddress: '10.0.0.9' }), undefined);

  const bearer = bearerAuth({
    verify: (token) => (token === 'valid.jwt' ? { sub: 'ci-bot', name: 'CI', roles: ['editor'] } : undefined),
    role: (claims) => ((claims.roles as string[]).includes('editor') ? 'editor' : undefined),
  });
  const both = anyOf(bearer, proxy);
  assert.deepEqual(await both(request({ authorization: 'Bearer valid.jwt' }), {}), {
    id: 'ci-bot',
    role: 'editor',
    name: 'CI',
  });
  assert.equal(await both(request({ authorization: 'Bearer forged' }), {}), undefined);
  assert.throws(() => personalTokens([{ id: 'x', role: 'admin', token: 'short' }]), /at least 16/);
  assert.throws(
    () => personalTokens([{ id: 'x', role: 'owner' as never, token: 'long-enough-token-123' }]),
    /not a studio role/,
  );
});

test('context bundles are browsed, diffed, and promoted through their gates, by admins only', async () => {
  const experiments = new MemoryExperimentStore();
  const hub = new ContextHub({ gates: { production: [contextExperimentGate({ store: experiments })] } });
  const first = await hub.commit({ name: 'agent', instructions: { policy: 'Be careful.' } }, { label: 'staging' });
  const second = await hub.commit({ name: 'agent', instructions: { policy: 'Be careful.\nCite sources.' } });
  const studio = createStudio({ contexts: hub }, { auth: users });
  const ana = await signIn(studio, ANA);
  const rui = await signIn(studio, RUI);

  const { contexts } = (await (await rui.call('/api/contexts')).json()) as { contexts: Array<{ name: string }> };
  assert.deepEqual(
    contexts.map((context) => context.name),
    ['agent'],
  );
  const { versions } = (await (await rui.call('/api/contexts/agent')).json()) as {
    versions: Array<{ version: string }>;
  };
  assert.deepEqual(
    versions.map((version) => version.version),
    [second.version, first.version],
  );
  const { text } = (await (
    await rui.call(`/api/contexts/agent/diff?from=${first.version}&to=${second.version}`)
  ).json()) as { text: string };
  assert.match(text, /\+ Cite sources\./);

  assert.equal(
    (await rui.post('/api/contexts/agent/promote', { version: second.version, to: 'production' })).status,
    403,
  );
  const refused = await ana.post('/api/contexts/agent/promote', { version: second.version, to: 'production' });
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'PROMOTION_REFUSED');
  assert.equal(
    (await ana.post('/api/contexts/agent/promote', { version: second.version, to: 'production', force: true })).status,
    200,
  );
  assert.equal((await hub.get('agent', 'production')).version, second.version);
});

test('proof: two people share one studio; a seeded regression is found, clustered, and answered with an evaluated fix promoted from the inbox', async () => {
  // ── The application's stores ──
  const traces = new MemoryTraceStore();
  const experiments = new MemoryExperimentStore();
  const registry = new PromptRegistry({
    gates: { production: [experimentGate({ store: experiments, noRegression: true })] },
  });
  const served = await registry.commit(
    { name: 'answer', messages: [{ role: 'user', content: 'Answer: {{input}}' }] },
    { label: 'production' },
  );
  const now = new Date('2026-09-29T12:00:00.000Z');
  let id = 0;
  const save = (at: string, failing: boolean, order: number) =>
    traces.save({
      id: `run-${++id}`,
      traceId: `trace-${id}`,
      name: 'support-agent',
      kind: 'agent',
      status: failing ? 'error' : 'ok',
      startedAt: at,
      latencyMs: 300,
      inputs: { question: `where is order ${order}?` },
      ...(failing
        ? { error: { name: 'AnswerCheckError', message: `The answer to order ${order} does not cite it` } }
        : {}),
    });
  // A healthy week, then a day where one answer in three fails the same way: the seeded regression.
  for (let index = 0; index < 60; index++) save(`2026-09-2${index % 7}T10:00:00.000Z`, index === 0, 1000 + index);
  for (let index = 0; index < 30; index++) save('2026-09-29T09:00:00.000Z', index % 3 === 0, 2000 + index);

  const proposals = new MemoryProposalStore();
  const inbox = new ProposalInbox({ store: proposals, prompts: registry });
  const running = await startStudio(
    { traces, prompts: registry, experiments, proposals: inbox },
    { port: 0, auth: users, now: () => now },
  );
  const origin = `http://127.0.0.1:${running.port}`;
  try {
    const person = async (token: string) => {
      const entry = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' });
      const cookie = (entry.headers.get('set-cookie') ?? '').split(';')[0] as string;
      const session = (await (await fetch(`${origin}/api/session`, { headers: { cookie } })).json()) as {
        token: string;
      };
      const headers = { cookie, 'x-studio-token': session.token, 'content-type': 'application/json' };
      return {
        get: async (route: string) =>
          (await fetch(`${origin}${route}`, { headers })).json() as Promise<Record<string, unknown>>,
        post: (route: string, body: unknown = {}) =>
          fetch(`${origin}${route}`, { method: 'POST', headers, body: JSON.stringify(body) }),
      };
    };
    const ana = await person(ANA);
    const rui = await person(RUI);

    // ── The reviewer finds the problem in the studio ──
    const found = (await rui.get('/api/issues?hours=24')) as {
      issues: Array<{ kind: string; summary: string; cluster: { count: number } }>;
      regressions: Array<{ metric: string; group: string }>;
    };
    assert.equal(found.issues[0]?.kind, 'failing');
    assert.equal(found.issues[0]?.cluster.count, 10, 'the ten failures are one cluster, whatever order they name');
    assert.match(found.issues[0]?.summary ?? '', /AnswerCheckError: The answer to order <n> does not cite it/);
    assert.deepEqual(
      found.regressions.map((regression) => `${regression.group} ${regression.metric}`),
      ['support-agent error-rate'],
    );

    // ── The insights job proposes a fix, and it is evaluated before anyone is asked ──
    const [issue] = await findIssues({ store: traces, now: () => now });
    assert.ok(issue);
    const dataset = createDataset({
      name: 'orders',
      examples: [1, 2, 3, 4, 5, 6, 7, 8].map((order) => ({
        id: `o${order}`,
        inputs: `order ${order}`,
        expected: 'order',
      })),
    });
    const client = {
      complete: async (request: { messages: Array<{ content: unknown }> }) => {
        const text = String(request.messages[0]?.content);
        return { content: text.includes('cite the order') ? `About ${text.split(': ')[1]}` : 'Done.' } as never;
      },
    };
    const proposal = await proposeFix({
      issue,
      subject: { kind: 'prompt', registry, name: 'answer', label: 'production' },
      propose: () => ({
        definition: { name: 'answer', messages: [{ role: 'user', content: 'Answer and cite the order: {{input}}' }] },
        rationale: 'Failing answers never named the order.',
      }),
      evaluate: (version) =>
        evaluatePrompt(version as never, dataset, [contains(['order'])], { client, store: experiments }),
      store: proposals,
    });
    assert.equal(proposal?.verdict, 'improved');

    // ── It waits in the inbox; the reviewer comments, and cannot promote ──
    const waiting = (await rui.get('/api/inbox')) as { proposals: Array<{ id: string; rationale: string }> };
    assert.deepEqual(
      waiting.proposals.map((item) => item.id),
      [proposal?.id],
    );
    assert.equal(
      (
        await rui.post('/api/comments', {
          subject: `proposal:${proposal?.id}`,
          body: 'Checked five answers; looks right.',
        })
      ).status,
      200,
    );
    const refused = await rui.post(`/api/proposals/${proposal?.id}/promote`);
    assert.equal(refused.status, 403);

    // ── The admin promotes it, through the production gate ──
    const promoted = await ana.post(`/api/proposals/${proposal?.id}/promote`, { note: 'Rui checked it' });
    assert.equal(promoted.status, 200);
    assert.equal(
      ((await promoted.json()) as { proposal: { status: string; decidedBy: string } }).proposal.decidedBy,
      'ana@example.com',
    );
    assert.equal((await registry.get('answer', 'production')).version, proposal?.candidate.version);
    assert.notEqual(proposal?.candidate.version, served.version);
    assert.equal(
      (await ana.post(`/api/proposals/${proposal?.id}/promote`)).status,
      409,
      'a decided proposal cannot be decided again',
    );
    assert.deepEqual(((await rui.get('/api/inbox')) as { proposals: unknown[] }).proposals, []);

    const { entries } = (await ana.get('/api/audit')) as {
      entries: Array<{ user: string; action: string; outcome: string }>;
    };
    assert.deepEqual(
      entries.slice(0, 4).map((entry) => `${entry.user} ${entry.action} ${entry.outcome}`),
      [
        'ana@example.com proposal.promote failed',
        'ana@example.com proposal.promote ok',
        'rui@example.com proposal.promote denied',
        'rui@example.com comment.add ok',
      ],
    );
  } finally {
    await running.close();
  }
});

test('a config module can export options, and a users file gives each person a link', async () => {
  const config = path.join(work, 'studio.config.mjs');
  await writeFile(
    config,
    'export default { budgets: [] };\nexport const options = async () => ({ actor: "ops", allowedHosts: ["studio.internal"] });\n',
  );
  const loaded = await loadConfig(config);
  assert.deepEqual(loaded.options, { actor: 'ops', allowedHosts: ['studio.internal'] });
  const file = path.join(work, 'users.json');
  await writeFile(file, JSON.stringify([{ id: 'ana', role: 'admin', token: ANA }]));
  assert.deepEqual(await loadUsers(file), [{ id: 'ana', role: 'admin', token: ANA }]);
  await writeFile(file, JSON.stringify({ id: 'ana' }));
  await assert.rejects(loadUsers(file), /JSON list/);
});
