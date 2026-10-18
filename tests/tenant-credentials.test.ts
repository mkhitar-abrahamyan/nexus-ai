/**
 * Credentials per tenant, proved against a provider of the test's own that checks every key.
 *
 * Each tenant's calls carry its own key, through completions, streams, and embeddings, and a call
 * with no tenant carries the configured one. A key rotated in the secret manager in the middle of a
 * run is the one the next call uses: at once when the provider has revoked the old one, and within
 * the cache's time when it has not. A tenant with no key is refused before anything is sent; a
 * secret manager that is down is covered by the last key for a while; concurrent calls share one
 * read. And no key reaches an error, an audit event, a log, a trace, or the provider health report.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { NexusAI } from '../src/core/nexus.js';
import {
  awsSecrets,
  azureSecrets,
  CredentialError,
  envSecrets,
  gcpSecrets,
  memorySecrets,
  parseSecret,
  type SecretSource,
  tenantCredentials,
  vaultSecrets,
} from '../src/credentials/index.js';
import { traceModelClient } from '../src/tracing/instrument.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer } from '../src/tracing/tracer.js';
import type { AuditLogEvent } from '../src/types/config.js';

/** An OpenAI-compatible provider that takes only the keys it is told are live, and says which one it refused. */
const provider = {
  live: new Set(['sk-shared', 'sk-acme-1', 'sk-globex-1']),
  seen: [] as Array<{ path: string; key: string; status: number; organization?: string }>,
  url: '',
};
let server: ReturnType<typeof createServer>;

const keyOf = (request: IncomingMessage) => {
  const header = request.headers.authorization ?? '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return new URL(request.url ?? '/', 'http://x').searchParams.get('key') ?? '';
};

before(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const key = keyOf(request);
      const path = new URL(request.url ?? '/', 'http://x').pathname;
      const ok = provider.live.has(key);
      const organization = request.headers['openai-organization'];
      provider.seen.push({
        path,
        key,
        status: ok ? 200 : 401,
        ...(typeof organization === 'string' ? { organization } : {}),
      });
      if (!ok) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ error: { message: `Incorrect API key provided: ${key}.`, code: 'invalid_api_key' } }),
        );
        return;
      }
      const asked = JSON.parse(body || '{}') as { stream?: boolean; input?: string[] };
      if (path.endsWith('/embeddings')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            data: (asked.input ?? []).map((_, index) => ({ embedding: [0.1, 0.2, 0.3], index })),
            model: 'text-embedding-3-small',
            usage: { prompt_tokens: 3, total_tokens: 3 },
          }),
        );
        return;
      }
      if (path.includes(':generateContent')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: 'gemini ok' }] }, finishReason: 'STOP' }] }),
        );
        return;
      }
      if (asked.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: Record<string, unknown>, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt-5', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        response.end(`${chunk({ role: 'assistant', content: 'streamed' }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-5',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: `answered with ${key.slice(0, 7)}` },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  provider.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const messages = [{ role: 'user' as const, content: 'hello' }];

function client(options: {
  secrets: SecretSource;
  now?: () => number;
  cacheMs?: number;
  staleMs?: number;
  missing?: 'refuse' | 'config';
}) {
  const audit: AuditLogEvent[] = [];
  const logs: unknown[] = [];
  const credentials = tenantCredentials({
    secrets: options.secrets,
    ...(options.now ? { now: options.now } : {}),
    ...(options.cacheMs !== undefined ? { cacheMs: options.cacheMs } : {}),
    ...(options.staleMs !== undefined ? { staleMs: options.staleMs } : {}),
    ...(options.missing ? { missing: options.missing } : {}),
  });
  const ai = new NexusAI({
    providers: {
      openai: { apiKey: 'sk-shared', baseUrl: `${provider.url}/v1` },
      google: { apiKey: 'sk-shared', baseUrl: `${provider.url}/v1beta` },
    },
    routing: { strategy: 'direct', defaultModel: 'gpt-5' },
    security: 'off',
    auditLog: { enabled: true, sink: (event: AuditLogEvent) => void audit.push(event) },
    health: { enabled: true },
    logger: { sink: (event: unknown) => void logs.push(event) },
    lifecycle: { credentials },
  } as never);
  return { ai, credentials, audit, logs };
}

const keysSince = (from: number) => provider.seen.slice(from).map((item) => item.key);

test('proof: each tenant’s calls carry its own key, and a key rotated mid-run is the one the next call uses', async () => {
  const secrets = memorySecrets({ 'acme/openai': 'sk-acme-1', 'globex/openai': 'sk-globex-1' });
  let clock = 1_000_000;
  const { ai, credentials } = client({ secrets, now: () => clock, cacheMs: 60_000 });
  const start = provider.seen.length;

  await ai.complete({ model: 'gpt-5', messages, tenantId: 'acme' });
  await ai.complete({ model: 'gpt-5', messages, tenantId: 'globex' });
  await ai.complete({ model: 'gpt-5', messages });
  assert.deepEqual(keysSince(start), ['sk-acme-1', 'sk-globex-1', 'sk-shared'], 'each tenant its own; none the shared');

  // A run of five calls for acme. After the second, the key is rotated in the secret manager and
  // the provider revokes the old one.
  const run: string[] = [];
  for (let step = 0; step < 5; step += 1) {
    if (step === 2) {
      secrets.set('acme/openai', 'sk-acme-2');
      provider.live.add('sk-acme-2');
      provider.live.delete('sk-acme-1');
    }
    const from = provider.seen.length;
    const response = await ai.complete({ model: 'gpt-5', messages, tenantId: 'acme' });
    run.push(`${keysSince(from).join('>')} ${response.content}`);
  }
  assert.deepEqual(
    run,
    [
      'sk-acme-1 answered with sk-acme',
      'sk-acme-1 answered with sk-acme',
      'sk-acme-1>sk-acme-2 answered with sk-acme',
      'sk-acme-2 answered with sk-acme',
      'sk-acme-2 answered with sk-acme',
    ],
    'the refused key is resolved again, and the call made once more on the new one; every call after uses it',
  );

  // Rotated without the provider revoking the old key: the new one takes over once the cache's time is up.
  secrets.set('globex/openai', 'sk-globex-2');
  provider.live.add('sk-globex-2');
  let from = provider.seen.length;
  await ai.complete({ model: 'gpt-5', messages, tenantId: 'globex' });
  clock += 61_000;
  await ai.complete({ model: 'gpt-5', messages, tenantId: 'globex' });
  assert.deepEqual(keysSince(from), ['sk-globex-1', 'sk-globex-2'], 'within the cache time, then the new key');

  // At once after `clear()`, as an application does when it rotates a key itself.
  secrets.set('globex/openai', 'sk-globex-1');
  credentials.clear('globex');
  from = provider.seen.length;
  await ai.complete({ model: 'gpt-5', messages, tenantId: 'globex' });
  assert.deepEqual(keysSince(from), ['sk-globex-1']);

  // Streams and embeddings resolve the same way.
  from = provider.seen.length;
  let streamed = '';
  for await (const chunk of ai.stream({ model: 'gpt-5', messages, tenantId: 'acme' })) {
    if (chunk.type === 'text') streamed += chunk.content ?? '';
  }
  assert.equal(streamed, 'streamed');
  await ai.embeddings.embed({
    input: ['a', 'b'],
    provider: 'openai',
    model: 'text-embedding-3-small',
    tenantId: 'acme',
  });
  assert.deepEqual(
    provider.seen.slice(from).map((item) => [item.path, item.key]),
    [
      ['/v1/chat/completions', 'sk-acme-2'],
      ['/v1/embeddings', 'sk-acme-2'],
    ],
  );
});

test('a tenant with no key is refused before anything is sent, unless told to fall back', async () => {
  const { ai } = client({ secrets: memorySecrets({}) });
  const from = provider.seen.length;
  await assert.rejects(ai.complete({ model: 'gpt-5', messages, tenantId: 'initech' }), (error: unknown) => {
    const found =
      [error, (error as { cause?: unknown }).cause].find((item) => item instanceof CredentialError) ??
      (error instanceof Error && /Tenant initech has no credential for openai/.test(error.message) ? error : undefined);
    assert.ok(found, `refused for want of a credential: ${String(error)}`);
    return true;
  });
  assert.equal(provider.seen.length, from, 'nothing was sent, with the shared key or any other');

  const fallback = client({ secrets: memorySecrets({}), missing: 'config' });
  await fallback.ai.complete({ model: 'gpt-5', messages, tenantId: 'initech' });
  assert.deepEqual(keysSince(from), ['sk-shared'], 'told to, it falls back to the configured key');
});

test('a key never reaches an error, an audit event, a log, a trace, or the health report', async () => {
  // A tenant whose key the provider does not take, and says so, key and all.
  provider.live.delete('sk-revoked-0123456789');
  const secrets = memorySecrets({ 'umbrella/openai': 'sk-revoked-0123456789' });
  const { ai, audit, logs } = client({ secrets });
  const store = new MemoryTraceStore();
  const traced = traceModelClient(ai, new Tracer({ store }));
  let caught: unknown;
  try {
    await traced.complete({ model: 'gpt-5', messages, tenantId: 'umbrella' });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, 'the call failed');
  // Errors keep their message and stack as properties JSON does not list, so they are read by name too.
  const text = (value: unknown) =>
    typeof value === 'string'
      ? value
      : `${JSON.stringify(value) ?? ''}${value && typeof value === 'object' ? JSON.stringify(value, Object.getOwnPropertyNames(value)) : ''}`;
  const leaked = (where: string, value: unknown) =>
    assert.ok(!text(value).includes('sk-revoked-0123456789'), `the key is not in ${where}`);
  assert.match(caught.message, /\[redacted\]/, 'the provider’s own words are kept, with the key taken out');
  leaked('the error', caught);
  leaked('the error’s stack', caught.stack);
  leaked('the error’s cause', (caught as { cause?: unknown }).cause);
  leaked('the audit log', audit);
  leaked('the logs', logs);
  leaked('the trace', store.query({ limit: 100 }));
  leaked('the provider health report', ai.getProviderHealth());
  assert.equal(
    provider.seen.filter((item) => item.key === 'sk-revoked-0123456789').length,
    2,
    'refused, resolved again, and refused again: once more, not forever',
  );

  // An embedding, which does not go through failover, is cleaned of the key the same way.
  const embedding = await ai.embeddings
    .embed({ input: ['a'], provider: 'openai', model: 'text-embedding-3-small', tenantId: 'umbrella' })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.ok(embedding instanceof Error, 'the embedding failed');
  leaked('the embedding’s error', embedding);
  leaked('the embedding’s error stack', embedding.stack);
});

test('a key a provider refused is read again by the next call, in a family that does not retry it', async () => {
  provider.live.add('sk-acme-3');
  const secrets = memorySecrets({ 'acme/openai': 'sk-acme-3' });
  const { ai } = client({ secrets, cacheMs: 60 * 60_000 });
  const embed = () =>
    ai.embeddings.embed({ input: ['a'], provider: 'openai', model: 'text-embedding-3-small', tenantId: 'acme' });
  const from = provider.seen.length;
  await embed();
  secrets.set('acme/openai', 'sk-acme-4');
  provider.live.add('sk-acme-4');
  provider.live.delete('sk-acme-3');
  await assert.rejects(embed(), 'the cached key is refused');
  await embed();
  assert.deepEqual(keysSince(from), ['sk-acme-3', 'sk-acme-3', 'sk-acme-4'], 'and the next call reads the new one');
});

test('a secret manager that is down is covered by the last key for a while, and concurrent calls share one read', async () => {
  let down = false;
  let reads = 0;
  const source: SecretSource = {
    async get(name) {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (down) throw new Error('the secret manager is unreachable');
      return name === 'acme/openai' ? 'sk-acme-2' : undefined;
    },
  };
  provider.live.add('sk-acme-2');
  let clock = 5_000_000;
  const { ai, credentials } = client({ secrets: source, now: () => clock, cacheMs: 1_000, staleMs: 10_000 });
  await Promise.all(Array.from({ length: 20 }, () => ai.complete({ model: 'gpt-5', messages, tenantId: 'acme' })));
  assert.equal(reads, 1, 'twenty calls at once, one read');

  down = true;
  clock += 2_000;
  await ai.complete({ model: 'gpt-5', messages, tenantId: 'acme' });
  assert.equal(credentials.stats().stale, 1, 'the last key carried the call while the manager was down');
  clock += 20_000;
  await assert.rejects(ai.complete({ model: 'gpt-5', messages, tenantId: 'acme' }), /could not be read/);
});

test('a tenant’s key reaches a provider that takes it in the URL, and a secret can carry headers', async () => {
  provider.live.add('sk-acme-gemini');
  provider.live.add('sk-acme-org');
  const secrets = memorySecrets({
    'acme/google': 'sk-acme-gemini',
    'acme/openai': JSON.stringify({ apiKey: 'sk-acme-org', headers: { 'OpenAI-Organization': 'org-acme' } }),
  });
  const { ai } = client({ secrets });
  const from = provider.seen.length;
  const gemini = await ai.complete({
    model: 'gemini-2.5-flash',
    provider: 'google',
    messages,
    tenantId: 'acme',
  } as never);
  assert.equal(gemini.content, 'gemini ok');
  await ai.complete({ model: 'gpt-5', messages, tenantId: 'acme' });
  assert.deepEqual(
    provider.seen.slice(from).map((item) => [item.key, item.organization]),
    [
      ['sk-acme-gemini', undefined],
      ['sk-acme-org', 'org-acme'],
    ],
  );
  assert.deepEqual(parseSecret('  sk-plain  '), { apiKey: 'sk-plain' });
  assert.deepEqual(parseSecret('{not json'), { apiKey: '{not json' });
});

test('secret sources: AWS, Google, Azure, Vault, and the environment, each reading a missing secret as none', async () => {
  const aws = awsSecrets(
    {
      async getSecretValue({ SecretId }) {
        if (SecretId === 'prod/acme/openai') return { SecretString: 'sk-aws' };
        throw Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
      },
    },
    { prefix: 'prod/' },
  );
  assert.equal(await aws.get('acme/openai'), 'sk-aws');
  assert.equal(await aws.get('acme/anthropic'), undefined);

  const gcp = gcpSecrets(
    {
      async accessSecretVersion({ name }) {
        if (name === 'projects/p1/secrets/acme-openai/versions/latest') {
          return [{ payload: { data: new TextEncoder().encode('sk-gcp') } }];
        }
        throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
      },
    },
    { project: 'p1' },
  );
  assert.equal(await gcp.get('acme/openai'), 'sk-gcp');
  assert.equal(await gcp.get('acme/missing'), undefined);

  const azure = azureSecrets({
    async getSecret(name) {
      if (name === 'acme-openai') return { value: 'sk-azure' };
      throw Object.assign(new Error('missing'), { statusCode: 404 });
    },
  });
  assert.equal(await azure.get('acme/openai'), 'sk-azure');
  assert.equal(await azure.get('acme/x'), undefined);

  const asked: Array<[string, string | null]> = [];
  const vault = vaultSecrets({
    address: 'https://vault.test:8200/',
    token: async () => 'hvs.token',
    namespace: 'team',
    fetch: (async (url: string, init: RequestInit) => {
      asked.push([url, new Headers(init.headers).get('x-vault-token')]);
      if (url.endsWith('/v1/secret/data/acme/openai')) {
        return new Response(JSON.stringify({ data: { data: { value: 'sk-vault' } } }));
      }
      if (url.endsWith('/v1/secret/data/acme/both')) {
        return new Response(JSON.stringify({ data: { data: { apiKey: 'sk-json', headers: { 'x-a': 'b' } } } }));
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch,
  });
  assert.equal(await vault.get('acme/openai'), 'sk-vault');
  assert.deepEqual(parseSecret((await vault.get('acme/both')) as string), {
    apiKey: 'sk-json',
    headers: { 'x-a': 'b' },
  });
  assert.equal(await vault.get('acme/none'), undefined);
  assert.deepEqual(asked[0], ['https://vault.test:8200/v1/secret/data/acme/openai', 'hvs.token']);

  const env = envSecrets({ prefix: 'NEXUS_', env: { NEXUS_ACME_OPENAI: 'sk-env' } });
  assert.equal(await env.get('acme/openai'), 'sk-env');
  assert.equal(await env.get('acme/google'), undefined);
});
