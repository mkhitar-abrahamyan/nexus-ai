/**
 * Server authentication, proved end to end: a token from a test identity provider, verified against
 * its key set, becomes a Principal that reaches an agent's tool call scoped to its tenant. Also the
 * refusals that matter — an expired token, another audience, `alg: none`, a forged signature, another
 * tenant's thread — key rotation without a restart, API keys by hash, a trusted proxy that refuses to
 * exist without proof, and the principal on graph and workflow runs.
 */
import assert from 'node:assert/strict';
import type { webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { agentInput, createAgent } from '../src/agent/create-agent.js';
import { tool } from '../src/agent/tool.js';
import { MemoryGraphCheckpointer } from '../src/graph/checkpointer.js';
import { workflow } from '../src/graph/functional.js';
import { createGraph } from '../src/graph/graph.js';
import { lastValue } from '../src/graph/channels.js';
import { graphAssistant } from '../src/server/assistant.js';
import {
  anyAuth,
  apiKeyAuth,
  createJwtVerifier,
  hashApiKey,
  JwtError,
  jwtAuth,
  trustedProxyAuth,
} from '../src/server/auth.js';
import { type AgentServer, createAgentServer } from '../src/server/server.js';
import { MemoryStore } from '../src/store/memory.js';
import { tenantStore } from '../src/store/tenant.js';
import { END } from '../src/types/graph.js';
import type { CompletionRequest, ToolContext } from '../src/types/messages.js';
import type { Principal } from '../src/types/principal.js';
import type { NexusResponse } from '../src/types/response.js';
import type { RunRecord, ThreadRecord } from '../src/types/server.js';

type CryptoKeyPair = webcrypto.CryptoKeyPair;
const subtle = globalThis.crypto.subtle;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const seconds = () => Math.floor(Date.now() / 1000);

/** A test identity provider: RSA keys it can rotate, a key set, and tokens it signs. */
async function identityProvider() {
  const keys = new Map<string, CryptoKeyPair>();
  let fetches = 0;
  const rotate = async (kid: string) => {
    keys.set(
      kid,
      (await subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair,
    );
  };
  await rotate('k1');
  return {
    rotate,
    get fetches() {
      return fetches;
    },
    fetch: async () => {
      fetches += 1;
      const published = await Promise.all(
        [...keys].map(async ([kid, pair]) => ({
          ...(await subtle.exportKey('jwk', pair.publicKey)),
          kid,
          alg: 'RS256',
          use: 'sig',
        })),
      );
      return new Response(JSON.stringify({ keys: published }), { headers: { 'content-type': 'application/json' } });
    },
    sign: async (claims: Record<string, unknown>, kid = 'k1', header: Record<string, unknown> = {}) => {
      const pair = keys.get(kid) as CryptoKeyPair;
      const signing = `${encode({ alg: 'RS256', typ: 'JWT', kid, ...header })}.${encode(claims)}`;
      const signature = await subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signing));
      return `${signing}.${Buffer.from(signature).toString('base64url')}`;
    },
  };
}

const ISSUER = 'https://idp.test/';
const claimsFor = (subject: string, tenant: string, extra: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: 'agents-api',
  sub: subject,
  tenant_id: tenant,
  realm_access: { roles: ['support'] },
  scope: 'read write',
  iat: seconds(),
  exp: seconds() + 300,
  ...extra,
});

function call(server: AgentServer, method: string, path: string, token: string | undefined, body?: unknown) {
  return server.handle(
    new Request(`http://server.test${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function settled(server: AgentServer, runId: string, token: string): Promise<RunRecord> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const run = (await (await call(server, 'GET', `/runs/${runId}`, token)).json()) as RunRecord;
    if (['succeeded', 'failed', 'cancelled', 'expired', 'awaiting_input'].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Run ${runId} did not settle`);
}

test('a JWT from an identity provider reaches a tool call as a Principal, scoped to its tenant', async () => {
  const idp = await identityProvider();
  const store = new MemoryStore();
  const checkpointer = new MemoryGraphCheckpointer();
  const seen: ToolContext[] = [];
  const whoami = tool({
    name: 'whoami',
    description: 'Says who the caller is',
    parameters: { type: 'object' },
    capabilities: [],
    execute: async (_args, context) => {
      seen.push(context);
      await context.store?.put(['notes'], 'last-caller', context.principal?.userId);
      return { user: context.principal?.userId, tenant: context.tenantId };
    },
  });
  const client = {
    complete: async (request: CompletionRequest): Promise<NexusResponse> =>
      ({
        content: request.messages.some((message) => message.role === 'tool') ? 'You are alice.' : '',
        role: 'assistant',
        finishReason: 'stop',
        meta: {} as never,
        ...(request.messages.some((message) => message.role === 'tool')
          ? {}
          : { toolCalls: [{ id: 'c1', type: 'function', function: { name: 'whoami', arguments: '{}' } }] }),
      }) as NexusResponse,
  };
  const agent = createAgent({ client, tools: [whoami], store, checkpointer, name: 'support' });
  const server = createAgentServer({
    assistants: { support: graphAssistant(agent) },
    authenticate: jwtAuth({
      jwks: 'https://idp.test/.well-known/jwks.json',
      issuer: ISSUER,
      audience: 'agents-api',
      claims: { roles: 'realm_access.roles' },
      fetch: idp.fetch,
    }),
  });

  const alice = await idp.sign(claimsFor('alice', 'acme'));
  const thread = (await (
    await call(server, 'POST', '/threads', alice, { assistant: 'support' })
  ).json()) as ThreadRecord;
  assert.equal(thread.tenantId, 'acme');
  const started = await call(server, 'POST', `/threads/${thread.id}/runs`, alice, { input: agentInput('Who am I?') });
  assert.equal(started.status, 202);
  const run = await settled(server, ((await started.json()) as RunRecord).id, alice);
  assert.equal(run.status, 'succeeded');

  // The tool saw the caller, with their tenant, roles, and scopes, and how they were authenticated.
  const context = seen[0] as ToolContext;
  const principal = context.principal as Principal;
  assert.equal(principal.userId, 'alice');
  assert.equal(principal.tenantId, 'acme');
  assert.deepEqual(principal.roles, ['support']);
  assert.deepEqual(principal.scopes, ['read', 'write']);
  assert.equal(principal.method, 'jwt');
  assert.equal(context.tenantId, 'acme');
  assert.equal(context.toolCallId, 'c1');
  assert.ok(context.signal instanceof AbortSignal);
  // What the tool stored went into the tenant's view of the store, not anyone else's.
  assert.equal((await tenantStore(store, 'acme').get(['notes'], 'last-caller'))?.value, 'alice');
  assert.equal(await store.get(['notes'], 'last-caller'), undefined);
  // The checkpoint records who ran the step.
  assert.equal((await agent.state(thread.id))?.metadata?.userId, 'alice');

  // Another tenant's token cannot see the thread, its runs, or its state.
  const bob = await idp.sign(claimsFor('bob', 'globex'));
  assert.equal((await call(server, 'GET', `/threads/${thread.id}`, bob)).status, 404);
  assert.equal((await call(server, 'GET', `/runs/${run.id}`, bob)).status, 404);

  // Refusals: none, expired, another audience, another issuer, alg none, a forged payload.
  assert.equal((await call(server, 'GET', '/threads', undefined)).status, 401);
  const expired = await call(
    server,
    'GET',
    '/threads',
    await idp.sign(claimsFor('alice', 'acme', { exp: seconds() - 3_600 })),
  );
  assert.equal(expired.status, 401);
  assert.match(String(expired.headers.get('www-authenticate')), /invalid_token.*expired/);
  const elsewhere = await idp.sign(claimsFor('alice', 'acme', { aud: 'another-app' }));
  assert.equal((await call(server, 'GET', '/threads', elsewhere)).status, 401);
  const foreign = await idp.sign(claimsFor('alice', 'acme', { iss: 'https://evil.test/' }));
  assert.equal((await call(server, 'GET', '/threads', foreign)).status, 401);
  const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claimsFor('alice', 'acme'))}.`;
  assert.equal((await call(server, 'GET', '/threads', unsigned)).status, 401);
  const [head, , signature] = alice.split('.');
  const forged = `${head}.${encode(claimsFor('alice', 'globex'))}.${signature}`;
  const forgedResponse = await call(server, 'GET', '/threads', forged);
  assert.equal(forgedResponse.status, 401);
  assert.match(((await forgedResponse.json()) as { error: { message: string } }).error.message, /signature/);

  // The provider rotates its key: a token naming the new key fetches the key set once more.
  const before = idp.fetches;
  await idp.rotate('k2');
  const rotated = await idp.sign(claimsFor('alice', 'acme'), 'k2');
  assert.equal((await call(server, 'GET', '/threads', rotated)).status, 200);
  assert.equal(idp.fetches, before + 1);
  assert.equal((await call(server, 'GET', '/threads', await idp.sign(claimsFor('carol', 'acme'), 'k2'))).status, 200);
  assert.equal(idp.fetches, before + 1, 'the new key is cached');
  // An unknown key fetches at most once per cooldown, so garbage tokens cannot hammer the provider.
  await call(server, 'GET', '/threads', await idp.sign(claimsFor('alice', 'acme'), 'k2', { kid: 'nope' }));
  await call(server, 'GET', '/threads', await idp.sign(claimsFor('alice', 'acme'), 'k2', { kid: 'nope' }));
  assert.equal(idp.fetches, before + 1);
});

test('the verifier checks algorithms, keys, and claims, and refuses to confuse one key kind for another', async () => {
  const hs = createJwtVerifier({
    secret: 'a-long-shared-secret',
    issuer: ['a', 'b'],
    audience: ['x', 'y'],
    maxAgeSec: 60,
  });
  const hmac = await subtle.importKey(
    'raw',
    new TextEncoder().encode('a-long-shared-secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signHs = async (claims: Record<string, unknown>, alg = 'HS256') => {
    const signing = `${encode({ alg, typ: 'JWT' })}.${encode(claims)}`;
    const signature = await subtle.sign('HMAC', hmac, new TextEncoder().encode(signing));
    return `${signing}.${Buffer.from(signature).toString('base64url')}`;
  };
  const good = { iss: 'b', aud: ['z', 'y'], sub: 's', iat: seconds(), exp: seconds() + 60 };
  assert.equal((await hs.verify(await signHs(good))).payload.sub, 's');
  const refused = async (token: Promise<string> | string, code: string) =>
    assert.rejects(hs.verify(await token), (error: unknown) => error instanceof JwtError && error.code === code);
  await refused(signHs({ ...good, exp: undefined }), 'JWT_CLAIM');
  await refused(signHs({ ...good, iat: seconds() - 3_600 }), 'JWT_TOO_OLD');
  await refused(signHs({ ...good, nbf: seconds() + 3_600 }), 'JWT_NOT_YET_VALID');
  await refused(signHs({ ...good, iss: 'c' }), 'JWT_ISSUER');
  await refused(signHs({ ...good, aud: 'z' }), 'JWT_AUDIENCE');
  await refused(signHs(good, 'RS256'), 'JWT_ALGORITHM');
  await refused('not-a-token', 'JWT_MALFORMED');
  await refused(`${encode({ alg: 'HS256' })}.bm90IGpzb24.c2ln`, 'JWT_MALFORMED');
  await refused(
    // The first character of the signature: the last one carries padding bits that may change nothing.
    signHs(good, 'HS256').then((token) => {
      const at = token.lastIndexOf('.') + 1;
      return `${token.slice(0, at)}${token[at] === 'A' ? 'B' : 'A'}${token.slice(at + 1)}`;
    }),
    'JWT_SIGNATURE',
  );

  // ES256 and EdDSA through a JWK.
  for (const [alg, params, signParams] of [
    ['ES256', { name: 'ECDSA', namedCurve: 'P-256' }, { name: 'ECDSA', hash: 'SHA-256' }],
    ['EdDSA', { name: 'Ed25519' }, { name: 'Ed25519' }],
  ] as Array<[string, Parameters<typeof subtle.generateKey>[0], Parameters<typeof subtle.sign>[0]]>) {
    const pair = (await subtle.generateKey(
      params as Parameters<typeof subtle.generateKey>[0] & { name: 'ECDSA' },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair;
    const verifier = createJwtVerifier({ publicKey: await subtle.exportKey('jwk', pair.publicKey) });
    const signing = `${encode({ alg })}.${encode({ sub: alg, exp: seconds() + 60 })}`;
    const signature = await subtle.sign(signParams, pair.privateKey, new TextEncoder().encode(signing));
    assert.equal(
      (await verifier.verify(`${signing}.${Buffer.from(signature).toString('base64url')}`)).payload.sub,
      alg,
    );
  }

  // Algorithm confusion: an HS256 token "signed" with an RSA public key is refused by a public-key verifier.
  const rsa = (await subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const spki = Buffer.from(await subtle.exportKey('spki', rsa.publicKey)).toString('base64');
  const pem = `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g)?.join('\n')}\n-----END PUBLIC KEY-----`;
  const pemVerifier = createJwtVerifier({ publicKey: pem });
  const confused = await subtle.importKey(
    'raw',
    new TextEncoder().encode(pem),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const confusedSigning = `${encode({ alg: 'HS256' })}.${encode({ sub: 'attacker', exp: seconds() + 60 })}`;
  const confusedToken = `${confusedSigning}.${Buffer.from(await subtle.sign('HMAC', confused, new TextEncoder().encode(confusedSigning))).toString('base64url')}`;
  await assert.rejects(
    pemVerifier.verify(confusedToken),
    (error: unknown) => (error as JwtError).code === 'JWT_ALGORITHM',
  );
  const rsSigning = `${encode({ alg: 'RS256' })}.${encode({ sub: 'pem', exp: seconds() + 60 })}`;
  const rsToken = `${rsSigning}.${Buffer.from(await subtle.sign('RSASSA-PKCS1-v1_5', rsa.privateKey, new TextEncoder().encode(rsSigning))).toString('base64url')}`;
  assert.equal((await pemVerifier.verify(rsToken)).payload.sub, 'pem');

  assert.throws(() => createJwtVerifier({ jwks: 'https://idp.test/jwks' }), /audience/);
  assert.throws(() => createJwtVerifier({}), TypeError);
  assert.throws(() => createJwtVerifier({ secret: 's', algorithms: ['RS256'] }), TypeError);
});

test('API keys are compared by hash, and a trusted proxy needs proof it sent the request', async () => {
  const keys = { [await hashApiKey('nxk_live_123')]: { userId: 'ci', tenantId: 'acme', scopes: ['write'] } };
  const byKey = apiKeyAuth({ keys, prefix: 'nxk_' });
  const request = (headers: Record<string, string>) => new Request('http://server.test/threads', { headers });
  assert.deepEqual(await byKey(request({ 'x-api-key': 'nxk_live_123' })), {
    method: 'api-key',
    userId: 'ci',
    tenantId: 'acme',
    scopes: ['write'],
  });
  assert.equal(((await byKey(request({ 'x-api-key': 'nxk_wrong' }))) as Response).status, 401);
  assert.equal(await byKey(request({ authorization: 'Bearer eyJ.a.b' })), undefined, 'not a key: left to another hook');
  assert.equal(await byKey(request({})), undefined);
  let looked = '';
  const lookup = apiKeyAuth({
    lookup: (hash) => {
      looked = hash;
      return { userId: 'from-db' };
    },
  });
  assert.equal(((await lookup(request({ authorization: 'Bearer plain-key' }))) as Principal).userId, 'from-db');
  assert.equal(looked, await hashApiKey('plain-key'), 'the lookup sees the hash, never the key');
  assert.throws(() => apiKeyAuth({}), TypeError);

  assert.throws(() => trustedProxyAuth({}), /anyone who sets the headers/);
  const proxy = trustedProxyAuth({ secret: { header: 'x-proxy-secret', value: 's3cret' } });
  const proxied = {
    'x-proxy-secret': 's3cret',
    'x-forwarded-user': 'dana',
    'x-forwarded-tenant': 'acme',
    'x-forwarded-roles': 'admin, support',
  };
  assert.deepEqual(await proxy(request(proxied)), {
    method: 'proxy',
    userId: 'dana',
    tenantId: 'acme',
    roles: ['admin', 'support'],
  });
  assert.equal(await proxy(request({ ...proxied, 'x-proxy-secret': 's3cre' })), undefined);
  assert.equal(await proxy(request({ 'x-forwarded-user': 'dana' })), undefined, 'headers alone prove nothing');
  assert.equal(((await proxy(request({ ...proxied, 'x-forwarded-tenant': '../acme' }))) as Response).status, 403);

  // Tokens for people and keys for services on one server; the first refusal explains a failure.
  const both = anyAuth(jwtAuth({ secret: 'shared-secret-for-tests' }), byKey);
  assert.equal(((await both(request({ 'x-api-key': 'nxk_live_123' }))) as Principal).userId, 'ci');
  const badJwt = (await both(request({ authorization: 'Bearer aaa.bbb.ccc' }))) as Response;
  assert.equal(badJwt.status, 401);
  assert.equal(await both(request({})), undefined);
});

test('graph and workflow runs carry the principal, its tenant, and its subject', async () => {
  const seen: Array<Principal | undefined> = [];
  const graph = createGraph({ channels: { who: lastValue<string>('') } })
    .addNode('look', (context) => {
      seen.push(context.principal);
      return { who: `${context.principal?.userId}@${context.tenantId}` };
    })
    .addEdge('look', END)
    .setEntry('look')
    .compile({ checkpointer: new MemoryGraphCheckpointer() });
  const principal: Principal = { userId: 'erin', tenantId: 'acme', roles: ['analyst'] };
  const result = await graph.invoke({}, { threadId: 'g', principal });
  assert.equal(result.state.who, 'erin@acme');
  assert.deepEqual(seen[0]?.roles, ['analyst']);
  assert.equal((await graph.state('g'))?.metadata?.userId, 'erin');
  assert.equal((await graph.state('g'))?.metadata?.tenantId, 'acme');
  await assert.rejects(graph.invoke({}, { principal, tenantId: 'globex' }), /differ/);
  // The principal's tenant is the run's, so it cannot start a run on another tenant's thread.
  await assert.rejects(
    graph.invoke({}, { threadId: 'g', principal: { tenantId: 'globex' } }),
    /cannot be used by this tenant/,
  );

  const flow = workflow(async (_input: unknown, context) => `${context.principal?.userId}@${context.tenantId}`, {
    checkpointer: new MemoryGraphCheckpointer(),
  });
  assert.equal((await flow.invoke(undefined, { threadId: 'w', principal })).output, 'erin@acme');
});
