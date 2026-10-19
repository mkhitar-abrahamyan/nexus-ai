/**
 * A browser's realtime session, minted on the server with its tenant's key.
 *
 * The OpenAI realtime server helpers take the resolver the client's lifecycle uses, so the session an
 * SDP exchange makes, and the client secret a browser connects with, are minted with the key of the
 * tenant the route authenticated; a tenant with no key is refused before anything is sent; a key the
 * provider quotes back is found in no error; a call OpenAI carries, such as a SIP call, is controlled
 * with the key of the project that received it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CredentialError, memorySecrets, tenantCredentials } from '../src/credentials/index.js';
import {
  acceptOpenAIRealtimeCall,
  createOpenAIRealtimeCall,
  createOpenAIRealtimeClientSecret,
  createOpenAIRealtimeSessionEndpoint,
  type FormDataLike,
  type OpenAIRealtimeServerFetch,
  type OpenAIRealtimeServerOptions,
} from '../src/realtime/openai-server.js';

function openai(status = 200) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch: OpenAIRealtimeServerFetch = async (input, init) => {
    seen.push({ url: input, headers: { ...(init.headers as Record<string, string>) } });
    if (status !== 200) {
      return { ok: false, status, text: async () => `the key ${init.headers?.Authorization} was revoked` };
    }
    return {
      ok: true,
      status: 200,
      text: async () => (input.endsWith('/client_secrets') ? '{"value":"ek_browser","expires_at":99}' : 'answer-sdp'),
    };
  };
  const form: FormDataLike = { set: () => undefined };
  return { seen, fetch, formDataFactory: () => form };
}

const credentials = () =>
  tenantCredentials({
    secrets: memorySecrets({
      'acme/openai': 'oa-acme',
      'initech/openai': JSON.stringify({ apiKey: 'oa-initech', headers: { 'OpenAI-Project': 'proj_initech' } }),
    }),
  });

test('a session and a client secret are minted with the tenant’s key, and without a tenant with the configured one', async () => {
  const api = openai();
  const options: OpenAIRealtimeServerOptions = {
    apiKey: 'oa-shared',
    model: 'gpt-realtime',
    credentials: credentials(),
    fetch: api.fetch,
    formDataFactory: api.formDataFactory,
    safetyIdentifier: 'hashed-user',
  };
  const secret = await createOpenAIRealtimeClientSecret({ ...options, tenantId: 'acme' });
  assert.equal(secret.value, 'ek_browser');
  assert.equal(await createOpenAIRealtimeCall('offer', { ...options, tenantId: 'initech' }), 'answer-sdp');
  await createOpenAIRealtimeClientSecret(options);

  // The endpoint behind a route: each call names the tenant the route authenticated.
  const endpoint = createOpenAIRealtimeSessionEndpoint(options);
  await endpoint('offer', undefined, { tenantId: 'acme' });
  await endpoint('offer');
  assert.deepEqual(
    api.seen.map((call) => [
      call.url.split('/').at(-1),
      call.headers.Authorization,
      call.headers['OpenAI-Project'] ?? '',
    ]),
    [
      ['client_secrets', 'Bearer oa-acme', ''],
      ['calls', 'Bearer oa-initech', 'proj_initech'],
      ['client_secrets', 'Bearer oa-shared', ''],
      ['calls', 'Bearer oa-acme', ''],
      ['calls', 'Bearer oa-shared', ''],
    ],
  );
  assert.ok(
    api.seen.every((call) => call.headers['OpenAI-Safety-Identifier'] === 'hashed-user'),
    'the safety identifier is kept',
  );
});

test('a tenant with no key is refused before anything is sent, and a key quoted back is cleaned', async () => {
  const api = openai();
  const options = { apiKey: 'oa-shared', model: 'gpt-realtime', credentials: credentials(), fetch: api.fetch };
  await assert.rejects(createOpenAIRealtimeClientSecret({ ...options, tenantId: 'globex' }), CredentialError);
  assert.equal(api.seen.length, 0, 'nothing sent for a tenant with no key');

  const revoked = openai(401);
  await assert.rejects(
    createOpenAIRealtimeClientSecret({ ...options, fetch: revoked.fetch, tenantId: 'acme' }),
    (error: unknown) => {
      const text = `${(error as Error).message} ${(error as Error).stack}`;
      assert.ok(!text.includes('oa-acme'), `the tenant's key is cleaned: ${(error as Error).message}`);
      assert.match((error as Error).message, /HTTP 401: the key Bearer \[redacted\] was revoked/);
      return true;
    },
  );

  // A resolver that says nothing leaves the configured key; with neither, the call is refused.
  await assert.rejects(
    createOpenAIRealtimeClientSecret({ model: 'gpt-realtime', fetch: api.fetch }),
    /A server-side OpenAI API key is required/,
  );
  assert.equal(api.seen.length, 0);
});

test('a call OpenAI carries is controlled with the key of the project that received it', async () => {
  const api = openai();
  const options = { apiKey: 'oa-project', credentials: credentials(), tenantId: 'acme', fetch: api.fetch };
  await acceptOpenAIRealtimeCall('rtc_1', { model: 'gpt-realtime' }, options as never);
  assert.equal(api.seen[0]?.headers.Authorization, 'Bearer oa-project');
  assert.match(api.seen[0]?.url ?? '', /\/realtime\/calls\/rtc_1\/accept$/);
});
