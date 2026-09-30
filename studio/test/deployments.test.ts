import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryOperationStore } from 'nexus-ai-pro/operations';
import { createAgentServer, functionAssistant, MemoryServerStore } from 'nexus-ai-pro/server';
import { Deployments } from 'nexus-ai-pro/server/deployments';
import { tenantLimits } from 'nexus-ai-pro/server/tenancy';
import { createStudio } from '../src/api.js';
import { personalTokens } from '../src/auth.js';
import { MemoryStudioJournal } from '../src/journal.js';

const ORIGIN = 'http://127.0.0.1:4747';
const users = personalTokens([
  { id: 'ana@example.com', role: 'admin', token: 'ana-token-0123456789abcdef' },
  { id: 'vic@example.com', role: 'viewer', token: 'vic-token-0123456789abcdef' },
]);

async function signIn(studio: ReturnType<typeof createStudio>, token: string) {
  const entry = await studio.handle(new Request(`${ORIGIN}/?token=${token}`));
  const cookie = (entry.headers.get('set-cookie') ?? '').split(';')[0] as string;
  const session = (await (
    await studio.handle(new Request(`${ORIGIN}/api/session`, { headers: { cookie } }))
  ).json()) as {
    token: string;
  };
  return (route: string, body?: unknown) =>
    studio.handle(
      new Request(`${ORIGIN}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          cookie,
          'x-studio-token': session.token,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
}

test('the deployments view shows revisions, replicas, the queue, and tenants, and an admin moves traffic', async () => {
  // The agent server and the studio share the server's state store, as they would share Redis.
  const state = new MemoryServerStore();
  const operations = new MemoryOperationStore<unknown>();
  const tenants = tenantLimits({ tenants: { acme: { maxActiveRuns: 5, budget: { usd: 10, period: 'day' } } } });
  const serving = new Deployments({ state, cacheMs: 0 });
  const server = createAgentServer({
    assistants: {
      support: serving.assistant(
        'support',
        {
          v1: functionAssistant(() => ({ answer: 'v1' })),
          v2: functionAssistant(() => {
            throw new Error('v2 is broken');
          }),
        },
        { live: 'v1' },
      ),
    },
    state,
    operations: { store: operations },
    deployments: serving,
    tenants,
    authenticate: () => ({ tenantId: 'acme', scopes: ['admin'] }),
  });
  await server.start();

  const journal = new MemoryStudioJournal();
  const studio = createStudio(
    { deployments: new Deployments({ state }), operations, tenants },
    { auth: users, audit: journal, comments: journal },
  );
  const ana = await signIn(studio, 'ana-token-0123456789abcdef');
  const vic = await signIn(studio, 'vic-token-0123456789abcdef');

  try {
    const overview = (await (await vic('/api/overview')).json()) as { sources: { deployments: boolean } };
    assert.equal(overview.sources.deployments, true);

    const refused = await vic('/api/deployments/support', { action: 'canary', revision: 'v2', weight: 0.5 });
    assert.equal(refused.status, 403, 'a viewer cannot move traffic');
    const moved = await ana('/api/deployments/support', {
      action: 'canary',
      revision: 'v2',
      weight: 0.5,
      reason: 'try v2',
      expectedVersion: 0,
    });
    assert.equal(moved.status, 200);

    for (let index = 0; index < 40; index += 1) {
      await server.handle(
        new Request(`${ORIGIN}/runs`, { method: 'POST', body: JSON.stringify({ assistant: 'support' }) }),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const view = (await (await vic('/api/deployments')).json()) as {
      deployments: Array<{
        assistant: string;
        version: number;
        traffic: Record<string, number>;
        history: Array<{ by?: string; reason?: string }>;
        stats: Array<{ revision: string; runs: number; errorRate: number }>;
      }>;
      replicas: Array<{ assistants: Record<string, string[]> }>;
      queue: { byStatus: Record<string, number> } | null;
      tenants: Array<{ tenantId: string; spend: { usd: number } }> | null;
    };
    const [deployment] = view.deployments;
    assert.equal(deployment?.version, 1);
    assert.deepEqual(deployment?.traffic, { v2: 0.5, v1: 0.5 });
    assert.equal(deployment?.history[0]?.by, 'ana@example.com', 'the change is recorded as the person who made it');
    assert.equal(deployment?.history[0]?.reason, 'try v2');
    const byRevision = Object.fromEntries((deployment?.stats ?? []).map((item) => [item.revision, item]));
    assert.equal(byRevision.v2?.errorRate, 1, 'the view shows the canary failing');
    assert.equal(byRevision.v1?.errorRate, 0);
    assert.equal((byRevision.v1?.runs ?? 0) + (byRevision.v2?.runs ?? 0), 40);
    assert.deepEqual(view.replicas[0]?.assistants.support, ['v1', 'v2'], 'the serving replica reports itself');
    assert.ok(view.queue, 'the queue numbers come from the operation store');
    assert.equal(view.tenants?.[0]?.tenantId, 'acme');

    const stale = await ana('/api/deployments/support', { action: 'rollback', expectedVersion: 0 });
    assert.equal(stale.status, 409, 'a change decided on an old version is refused');
    const rolledBack = await ana('/api/deployments/support', { action: 'rollback', expectedVersion: 1 });
    assert.equal(rolledBack.status, 200);
    const unknown = await ana('/api/deployments/support', { action: 'promote', revision: 'v9' });
    assert.equal(unknown.status, 400);

    const audit = (await journal.list()).filter((entry) => entry.action === 'deployment.change');
    assert.deepEqual(
      audit.map((entry) => entry.outcome).sort(),
      ['denied', 'failed', 'failed', 'ok', 'ok'],
      'every attempt is audited, refused ones included',
    );
  } finally {
    await server.stop();
  }
});
