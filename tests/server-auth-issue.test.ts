/**
 * Authentication the server ships, not only checks: tokens it issues with each kind of key, which its
 * own verifier and key set read back; API keys it issues, rotates, and revokes, kept as hashes in the
 * state store every replica shares; and browser sessions, a cookie of a random secret whose hash alone
 * is kept, that end, idle out, and refuse a request from another site.
 */
import assert from 'node:assert/strict';
import { createHash, type webcrypto } from 'node:crypto';
import { test } from 'node:test';
import { functionAssistant } from '../src/server/assistant.js';
import {
  anyAuth,
  createApiKeyStore,
  createJwtSigner,
  createJwtVerifier,
  createSessions,
  generateJwtKey,
  hashApiKey,
  type JwtAlgorithm,
  JwtError,
  jwksHandler,
  jwtAuth,
} from '../src/server/auth.js';
import { createAgentServer } from '../src/server/server.js';
import { MemoryServerStore } from '../src/server/state.js';
import type { Principal } from '../src/types/principal.js';

type CryptoKeyPair = webcrypto.CryptoKeyPair;
const subtle = globalThis.crypto.subtle;
const SECRET = 'a-secret-of-at-least-thirty-two-bytes!';
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;
const partsOf = (token: string) => {
  const [header = '', payload = ''] = token.split('.');
  return { header: decode(header), payload: decode(payload) };
};
const keySetFrom = (handler: (request: Request) => Promise<Response>) =>
  (async () => handler(new Request('https://agents.test/.well-known/jwks.json'))) as unknown as typeof fetch;

test('tokens issued with a secret, a JWK, a PEM key, or a key pair are read back by the verifier and the key set', async () => {
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const hmac = createJwtSigner({ secret: SECRET, issuer: 'https://agents.test', audience: 'agents-api', now });
  assert.equal(hmac.algorithm, 'HS256');
  assert.equal(await hmac.publicKey(), undefined, 'a secret publishes nothing');
  const token = await hmac.sign({ role: 'admin' });
  const { header, payload } = partsOf(token);
  assert.deepEqual(header, { alg: 'HS256', typ: 'JWT' });
  assert.equal(payload.iss, 'https://agents.test');
  assert.equal(payload.aud, 'agents-api');
  assert.equal(payload.iat, 1_700_000_000);
  assert.equal(payload.exp, 1_700_003_600, 'an hour, by default');
  assert.match(String(payload.jti), /^[0-9a-f-]{36}$/);
  assert.notEqual(partsOf(await hmac.sign()).payload.jti, payload.jti, 'each token its own id');
  assert.equal(payload.role, 'admin');
  const verified = await createJwtVerifier({ secret: SECRET, audience: 'agents-api', now }).verify(token);
  assert.equal(verified.payload.role, 'admin');
  const shaped = partsOf(
    await hmac.sign({ exp: 1_700_000_100, aud: 'mine' }, { expiresInSec: 60, audience: 'other', notBeforeSec: 30 }),
  ).payload;
  assert.deepEqual([shaped.exp, shaped.aud, shaped.nbf], [1_700_000_100, 'mine', 1_700_000_030], 'claims given win');
  const listed = partsOf(await hmac.sign({}, { audience: ['a', 'b'], expiresInSec: 60 })).payload;
  assert.deepEqual([listed.aud, listed.exp], [['a', 'b'], 1_700_000_060]);
  const kept = createJwtSigner({ secret: new TextEncoder().encode(SECRET), kid: 'shared-1', algorithm: 'HS512' });
  assert.deepEqual(partsOf(await kept.sign()).header, { alg: 'HS512', typ: 'JWT', kid: 'shared-1' });

  // Every asymmetric family, each published in one key set and verified through it.
  const es = createJwtSigner({ privateKey: await generateJwtKey(), audience: 'agents-api' });
  const ps = createJwtSigner({ privateKey: await generateJwtKey('PS384'), audience: 'agents-api' });
  const edPair = (await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const ed = createJwtSigner({ keyPair: edPair, audience: 'agents-api' });
  const rsaPair = (await subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-512' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await subtle.exportKey('pkcs8', rsaPair.privateKey))
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')}\n-----END PRIVATE KEY-----\n`;
  const rs = createJwtSigner({ privateKey: pem, algorithm: 'RS512', audience: 'agents-api' });
  const ecPair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const es384 = createJwtSigner({ keyPair: ecPair, audience: 'agents-api' });
  const psPair = (await subtle.generateKey(
    { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-512' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const ps512 = createJwtSigner({ keyPair: psPair, audience: 'agents-api' });
  const p521 = await subtle.exportKey(
    'jwk',
    ((await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-521' }, true, ['sign'])) as CryptoKeyPair).privateKey,
  );
  const es512 = createJwtSigner({ privateKey: { ...p521, key_ops: ['sign'] }, audience: 'agents-api' });
  const rsaJwk = await subtle.exportKey('jwk', rsaPair.privateKey);
  const rs256 = createJwtSigner({
    privateKey: { ...rsaJwk, alg: undefined } as webcrypto.JsonWebKey,
    audience: 'agents-api',
  });
  const signers = [es, ps, ed, rs, es384, ps512, es512, rs256];
  assert.deepEqual(
    signers.map((signer) => signer.algorithm),
    ['ES256', 'PS384', 'EdDSA', 'RS512', 'ES384', 'PS512', 'ES512', 'RS256'] satisfies JwtAlgorithm[],
    'each key’s own algorithm',
  );
  const jwks = jwksHandler(hmac, ...signers);
  const served = await jwks(new Request('https://agents.test/.well-known/jwks.json'));
  assert.equal(served.headers.get('cache-control'), 'public, max-age=300');
  const set = (await served.json()) as { keys: Array<Record<string, unknown>> };
  assert.equal(set.keys.length, signers.length, 'the secret left out');
  for (const key of set.keys) {
    assert.equal(key.use, 'sig');
    for (const member of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k', 'ext', 'key_ops']) {
      assert.equal(key[member], undefined, `no ${member}`);
    }
  }
  const ecKey = set.keys[0] as { crv: string; kty: string; x: string; y: string; kid: string };
  const expected = createHash('sha256')
    .update(JSON.stringify({ crv: ecKey.crv, kty: ecKey.kty, x: ecKey.x, y: ecKey.y }))
    .digest('base64url');
  assert.equal(ecKey.kid, expected, 'the RFC 7638 thumbprint');
  const rsaKey = set.keys[3] as { e: string; kty: string; n: string; kid: string };
  assert.equal(
    rsaKey.kid,
    createHash('sha256')
      .update(JSON.stringify({ e: rsaKey.e, kty: rsaKey.kty, n: rsaKey.n }))
      .digest('base64url'),
  );
  const edKey = set.keys[2] as { crv: string; kty: string; x: string; kid: string };
  assert.equal(
    edKey.kid,
    createHash('sha256')
      .update(JSON.stringify({ crv: edKey.crv, kty: edKey.kty, x: edKey.x }))
      .digest('base64url'),
  );
  const verifier = createJwtVerifier({
    jwks: 'https://agents.test/.well-known/jwks.json',
    audience: 'agents-api',
    fetch: keySetFrom(jwks),
  });
  for (const signer of signers) {
    const issued = await signer.sign({ sub: signer.algorithm });
    assert.equal(partsOf(issued).header.kid, ((await signer.publicKey()) as { kid?: string } | undefined)?.kid);
    assert.equal((await verifier.verify(issued)).payload.sub, signer.algorithm, `${signer.algorithm} verifies`);
  }
  assert.equal((await jwks(new Request('https://agents.test/jwks', { method: 'POST' }))).status, 405);
  const head = await jwks(new Request('https://agents.test/jwks', { method: 'HEAD' }));
  assert.deepEqual([head.status, await head.text()], [200, '']);

  // A key rotated out of the set no longer verifies.
  const rotated = createJwtVerifier({
    jwks: 'https://agents.test/.well-known/jwks.json',
    audience: 'agents-api',
    fetch: keySetFrom(jwksHandler(es)),
  });
  await assert.rejects(
    rotated.verify(await ps.sign()),
    (error: unknown) => error instanceof JwtError && error.code === 'JWT_KEY',
  );
  clock += 0;
});

test('a signer refuses a key that cannot sign what it is asked, or a secret short enough to guess', async () => {
  const refused = (make: () => unknown, message: RegExp) =>
    assert.throws(make, (error: unknown) => error instanceof TypeError && message.test(error.message));
  const es = await generateJwtKey();
  refused(() => createJwtSigner({}), /exactly one of secret, privateKey, or keyPair/);
  refused(() => createJwtSigner({ secret: SECRET, privateKey: es }), /exactly one/);
  refused(() => createJwtSigner({ secret: 'short' }), /at least 32 bytes/);
  refused(
    () => createJwtSigner({ secret: SECRET, algorithm: 'RS256' }),
    /A secret signs HS256, HS384, or HS512, not RS256/,
  );
  refused(() => createJwtSigner({ privateKey: es, algorithm: 'HS256' }), /HS256 is signed with a secret/);
  const { d: _d, ...publicOnly } = es;
  refused(() => createJwtSigner({ privateKey: publicOnly }), /a signer needs the private one/);
  refused(() => createJwtSigner({ privateKey: es, algorithm: 'ES384' }), /The JWK is for ES256, not ES384/);
  refused(
    () => createJwtSigner({ privateKey: { ...es, alg: undefined } as unknown as typeof es, algorithm: 'RS256' }),
    /cannot sign RS256/,
  );
  refused(() => createJwtSigner({ privateKey: { ...es, alg: 'HS256' } }), /HS256 is not one a signer uses/);
  refused(
    () => createJwtSigner({ privateKey: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----' }),
    /not a PKCS #8 PEM key/,
  );
  refused(
    () => createJwtSigner({ privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' }),
    /set algorithm/,
  );
  const ed = await generateJwtKey('EdDSA');
  assert.equal(
    createJwtSigner({ privateKey: { ...ed, alg: 'Ed25519' } }).algorithm,
    'EdDSA',
    'Ed25519 is EdDSA’s newer name',
  );
  refused(
    () => createJwtSigner({ privateKey: { ...ed, alg: undefined, crv: 'X25519' } as unknown as typeof ed }),
    /OKP on X25519 key signs no algorithm/,
  );
  await assert.rejects(generateJwtKey('HS256' as never), /not a key pair's algorithm/);
});

test('a token issued for a principal is read back as it, by the same claim names', async () => {
  const signer = createJwtSigner({ secret: SECRET, audience: 'agents-api' });
  const ana: Principal = { userId: 'ana', tenantId: 'acme', roles: ['support', 'admin'], scopes: ['read', 'write'] };
  const read = (names?: Parameters<typeof jwtAuth>[0]['claims']) =>
    jwtAuth({ secret: SECRET, audience: 'agents-api', ...(names ? { claims: names } : {}) });
  const request = (token: string) =>
    new Request('https://agents.test/threads', { headers: { authorization: `Bearer ${token}` } });
  const plain = await signer.issue(ana);
  assert.deepEqual(
    Object.fromEntries(['sub', 'tenant_id', 'roles', 'scope'].map((name) => [name, partsOf(plain).payload[name]])),
    { sub: 'ana', tenant_id: 'acme', roles: ['support', 'admin'], scope: 'read write' },
  );
  assert.deepEqual(await read()(request(plain)), { method: 'jwt', claims: partsOf(plain).payload, ...ana });
  const names = { subject: 'uid', tenant: 'org.id', roles: 'realm_access.roles', scopes: 'scp' };
  const nested = await signer.issue(ana, { claims: names, expiresInSec: 60 });
  assert.deepEqual(partsOf(nested).payload.org, { id: 'acme' });
  assert.deepEqual(partsOf(nested).payload.realm_access, { roles: ['support', 'admin'] });
  const back = (await read(names)(request(nested))) as Principal;
  assert.deepEqual(
    [back.userId, back.tenantId, back.roles, back.scopes],
    ['ana', 'acme', ['support', 'admin'], ['read', 'write']],
  );
  const both = await signer.issue(
    { userId: 'bo', tenantId: 'acme' },
    { claims: { subject: 'who.name', tenant: 'who.org' } },
  );
  assert.deepEqual(partsOf(both).payload.who, { name: 'bo', org: 'acme' }, 'one nested claim holds both');
  const lean = partsOf(await signer.issue({ userId: 'cy', roles: [], scopes: [] })).payload;
  assert.deepEqual(
    [lean.roles, lean.scope, lean.tenant_id],
    [undefined, undefined, undefined],
    'nothing empty is issued',
  );
  await assert.rejects(signer.issue({ tenantId: 'not a tenant!' }), /tenant/i);
  await assert.rejects(signer.issue(ana, { claims: { subject: 'a.__proto__.b' } }), /not a claim name/);
});

test('API keys issued, rotated, and revoked are kept as hashes that every replica reads', async () => {
  let clock = 1_000_000;
  const shared = new MemoryServerStore();
  const keys = createApiKeyStore({ store: shared, now: () => clock });
  const replica = createApiKeyStore({ store: shared, now: () => clock });
  const ci: Principal = { userId: 'ci', tenantId: 'acme', scopes: ['write'] };
  const { key, record } = await keys.issue(ci, { label: 'CI', expiresInSec: 3_600 });
  assert.match(key, /^nxk_[A-Za-z0-9_-]{43}$/);
  assert.match(record.id, /^key_[A-Za-z0-9_-]{16}$/);
  assert.equal(record.hash, await hashApiKey(key));
  assert.equal(record.start, key.slice(0, 8));
  assert.deepEqual([record.label, record.createdAt, record.expiresAt], ['CI', 1_000_000, 4_600_000]);
  assert.ok(
    !JSON.stringify(shared.list(['nexus', 'server', 'api-keys'])).includes(key.slice(4)),
    'the key is never kept',
  );

  const call = (credential: string, headers: Record<string, string> = {}) =>
    new Request('https://agents.test/threads', { headers: { 'x-api-key': credential, ...headers } });
  const auth = replica.auth();
  assert.deepEqual(await auth(call(key)), { method: 'api-key', ...ci }, 'another replica reads it');
  assert.equal(await auth(call('sk_other_service_key')), undefined, 'a key of another prefix is passed over');
  assert.equal(((await auth(call('nxk_unknown'))) as Response).status, 401);
  const byHeader = replica.auth({ header: 'x-service-key' });
  assert.deepEqual(await byHeader(new Request('https://agents.test/', { headers: { 'x-service-key': key } })), {
    method: 'api-key',
    ...ci,
  });

  // Its use is recorded, at most once a touch interval.
  assert.equal((await keys.get(record.id))?.lastUsedAt, 1_000_000);
  clock += 30_000;
  await auth(call(key));
  assert.equal((await keys.get(record.id))?.lastUsedAt, 1_000_000);
  clock += 30_000;
  await auth(call(key));
  assert.equal((await keys.get(record.id))?.lastUsedAt, 1_060_000);

  const other = await keys.issue({ userId: 'ops', tenantId: 'globex' });
  assert.deepEqual(
    (await keys.list({ tenantId: 'acme' })).map((item) => [item.id, item.lastUsedAt]),
    [[record.id, 1_060_000]],
  );
  assert.equal((await keys.list()).length, 2);
  assert.equal(other.record.expiresAt, undefined, 'without a lifetime, until revoked');

  // Rotation: the old key works for the grace period, the new one at once.
  const rotated = await keys.rotate(record.id, { graceSec: 60 });
  assert.equal(rotated.record.label, 'CI', 'the label carried over');
  assert.deepEqual(rotated.record.principal, ci);
  assert.equal(rotated.record.expiresAt, undefined, 'the new key’s own lifetime');
  assert.equal((await keys.get(record.id))?.replacedBy, rotated.record.id);
  assert.equal((await keys.get(record.id))?.expiresAt, clock + 60_000);
  assert.deepEqual(await auth(call(key)), { method: 'api-key', ...ci }, 'still, within the grace');
  clock += 60_000;
  assert.equal(((await auth(call(key))) as Response).status, 401, 'and not after it');
  assert.deepEqual(await auth(call(rotated.key)), { method: 'api-key', ...ci });
  const relabelled = await keys.rotate(rotated.record.id, { label: 'CI, again', expiresInSec: 10 });
  assert.deepEqual([relabelled.record.label, relabelled.record.expiresAt], ['CI, again', clock + 10_000]);
  assert.equal(((await auth(call(rotated.key))) as Response).status, 401, 'no grace, by default');
  const expiring = await keys.issue(ci, { expiresInSec: 100 });
  await keys.rotate(expiring.record.id, { graceSec: 1_000 });
  assert.equal((await keys.get(expiring.record.id))?.expiresAt, clock + 100_000, 'a grace never outlives the key');

  assert.equal(await keys.revoke(other.record.id), true);
  assert.equal(await keys.revoke(other.record.id), false, 'once');
  assert.equal(await keys.revoke('key_nothing'), false);
  assert.equal(((await auth(call(other.key))) as Response).status, 401);
  assert.equal(await keys.lookup(await hashApiKey(other.key)), undefined);
  await assert.rejects(keys.rotate(other.record.id), /revoked: issue a new one/);
  await assert.rejects(keys.rotate('key_nothing'), /No API key "key_nothing"/);
  // A use recorded meanwhile never undoes a revocation.
  const raced = await keys.issue(ci);
  clock += 120_000;
  const [, revoked] = await Promise.all([keys.lookup(raced.record.hash), keys.revoke(raced.record.id)]);
  assert.equal(revoked, true);
  assert.equal(await keys.lookup(raced.record.hash), undefined);
  // A hash pointing at another key's record lets no one in.
  const live = await keys.issue(ci);
  assert.deepEqual(await keys.lookup(live.record.hash), ci);
  await shared.put(['nexus', 'server', 'api-key-hashes'], 'f'.repeat(64), live.record.id);
  assert.equal(await keys.lookup('f'.repeat(64)), undefined);

  assert.match((await createApiKeyStore({ prefix: 'acme_' }).issue({})).key, /^acme_/);
  assert.throws(() => createApiKeyStore({ prefix: 'no spaces' }), /A key prefix is 1 to 16/);
  await assert.rejects(keys.issue({ tenantId: 'not a tenant!' }), /tenant/i);
  // Without a store, keys live in this process alone.
  const local = createApiKeyStore();
  const issued = await local.issue({ userId: 'solo' });
  assert.deepEqual(await local.lookup(issued.record.hash), { userId: 'solo' });
});

test('a session is a cookie of a random secret, read back on every replica, that ends, idles out, and refuses other sites', async () => {
  let clock = 5_000_000;
  const shared = new MemoryServerStore();
  const sessions = createSessions({ store: shared, idleSec: 600, now: () => clock, origins: ['https://app.example'] });
  const replica = createSessions({ store: shared, idleSec: 600, now: () => clock });
  const ana: Principal = { userId: 'ana', tenantId: 'acme', scopes: ['read', 'write'], claims: { amr: ['pwd'] } };
  const { cookie, record } = await sessions.start(ana);
  const [pair = '', ...attributes] = cookie.split('; ');
  assert.deepEqual(attributes, ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=28800']);
  const [name, value = ''] = pair.split('=');
  assert.equal(name, '__Host-nexus_session');
  const [id, secret = ''] = value.split('.');
  assert.equal(id, record.id);
  assert.equal(record.hash, await hashApiKey(secret), 'the secret’s hash alone is kept');
  assert.ok(!JSON.stringify(shared.list(['nexus', 'server', 'sessions'])).includes(secret));
  assert.deepEqual([record.createdAt, record.expiresAt], [5_000_000, 5_000_000 + 28_800_000]);

  const request = (method = 'GET', headers: Record<string, string> = {}, sent = pair) =>
    new Request('https://agents.internal/threads', { method, headers: { cookie: `theme=dark; ${sent}`, ...headers } });
  const expected = { ...ana, method: 'session', claims: { amr: ['pwd'], sid: record.id } };
  assert.deepEqual(await replica.auth(request()), expected, 'another replica reads it');
  assert.deepEqual(
    await sessions.auth(request('GET', {}, `evil__Host-nexus_session=garbage; ${pair}`)),
    expected,
    'a cookie of another name that ends the same is not it',
  );
  assert.equal(
    await sessions.auth(new Request('https://agents.internal/threads')),
    undefined,
    'no cookie, passed over',
  );

  // Something changed from another site is refused; from its own origin, or one allowed, it is not.
  const forbidden = async (made: Request, auth = sessions.auth) => ((await auth(made)) as Response).status === 403;
  assert.ok(await forbidden(request('POST', { origin: 'https://evil.example' })), 'another origin');
  assert.ok(await forbidden(request('POST', { origin: 'null' })), 'an opaque origin');
  assert.ok(await forbidden(request('DELETE')), 'neither header');
  assert.ok(await forbidden(request('POST', { 'sec-fetch-site': 'cross-site' })));
  assert.deepEqual(await sessions.auth(request('POST', { origin: 'https://agents.internal' })), expected);
  assert.deepEqual(await sessions.auth(request('POST', { origin: 'https://app.example' })), expected, 'one allowed');
  assert.ok(
    await forbidden(request('POST', { origin: 'https://app.example' }), replica.auth),
    'allowed per replica’s options',
  );
  assert.deepEqual(await sessions.auth(request('PUT', { 'sec-fetch-site': 'same-origin' })), expected);
  assert.deepEqual(await sessions.auth(request('PATCH', { 'sec-fetch-site': 'none' })), expected);
  assert.deepEqual(await sessions.auth(request('options')), expected, 'a safe method needs neither');

  // A forged, malformed, or unknown cookie answers 401 and clears it.
  const cleared = '__Host-nexus_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
  for (const sent of [
    `__Host-nexus_session=${id}.${'A'.repeat(43)}`,
    '__Host-nexus_session=garbage',
    `__Host-nexus_session=${'B'.repeat(16)}.${secret}`,
  ]) {
    const refused = (await sessions.auth(request('GET', {}, sent))) as Response;
    assert.equal(refused.status, 401, sent);
    assert.equal(refused.headers.get('set-cookie'), cleared);
  }

  // Use keeps it alive to the idle limit, recorded at most once a minute.
  clock += 30_000;
  await sessions.auth(request());
  assert.equal((await sessions.list())[0]?.lastSeenAt, undefined, 'not yet a minute');
  clock += 30_000;
  await sessions.auth(request());
  assert.equal((await sessions.list())[0]?.lastSeenAt, 5_060_000);
  clock += 599_999;
  assert.deepEqual(await sessions.auth(request()), expected, 'within the idle limit');
  clock += 600_000;
  assert.equal(((await sessions.auth(request())) as Response).status, 401, 'idle too long');
  assert.equal(await shared.get(['nexus', 'server', 'sessions'], record.id), undefined, 'and removed');
  assert.equal(await shared.get(['nexus', 'server', 'sessions-seen'], record.id), undefined, 'its last use too');

  // However much it is used, it ends at its maximum age.
  const long = createSessions({ store: shared, maxAgeSec: 120, now: () => clock });
  const started = await long.start({ userId: 'bo' });
  const bo = started.cookie.split('; ')[0] as string;
  clock += 60_000;
  assert.equal(((await long.auth(request('GET', {}, bo))) as Principal).userId, 'bo');
  clock += 60_000;
  assert.equal(((await long.auth(request('GET', {}, bo))) as Response).status, 401);

  // Ended by sign-out, by id, or swept once it lapses.
  const out = await sessions.start({ userId: 'cy', tenantId: 'acme' });
  const cy = out.cookie.split('; ')[0] as string;
  assert.equal(await sessions.end(request('POST', {}, cy)), cleared);
  assert.equal(((await sessions.auth(request('GET', {}, cy))) as Response).status, 401);
  assert.equal(await sessions.end(new Request('https://agents.internal/')), cleared, 'no session, still cleared');
  const dee = await sessions.start({ userId: 'dee', tenantId: 'acme' });
  const eve = await sessions.start({ userId: 'eve', tenantId: 'globex' });
  assert.deepEqual(
    (await sessions.list({ tenantId: 'acme' })).map((item) => item.principal.userId),
    ['dee'],
  );
  assert.deepEqual(
    (await sessions.list({ userId: 'eve' })).map((item) => item.id),
    [eve.record.id],
  );
  assert.equal(await sessions.revoke(dee.record.id), true);
  assert.equal(await sessions.revoke(dee.record.id), false);
  assert.equal(((await sessions.auth(request('GET', {}, dee.cookie.split('; ')[0]))) as Response).status, 401);
  const lapsing = await long.start({ userId: 'flo' });
  clock += 121_000;
  assert.deepEqual(
    (await sessions.list()).map((item) => item.principal.userId),
    ['eve'],
    'flo lapsed, so only eve is live',
  );
  assert.equal(await sessions.sweep(), 1);
  assert.equal(await shared.get(['nexus', 'server', 'sessions'], lapsing.record.id), undefined);
  clock += 600_000;
  assert.equal(await sessions.sweep(), 1, 'eve idled out');
  assert.deepEqual(await sessions.list(), []);
  assert.equal(await shared.get(['nexus', 'server', 'sessions'], lapsing.record.id), undefined);

  // The cookie as configured.
  const local = createSessions({
    cookie: { secure: false, name: 'sid', sameSite: 'Strict', path: '/app' },
    maxAgeSec: 60,
  });
  assert.match(
    (await local.start({})).cookie,
    /^sid=[\w-]{16}\.[\w-]{43}; Path=\/app; HttpOnly; SameSite=Strict; Max-Age=60$/,
  );
  const shared2 = createSessions({ cookie: { domain: 'example.com' } });
  assert.match(
    (await shared2.start({})).cookie,
    /^nexus_session=.*; Path=\/; Domain=example\.com; HttpOnly; Secure; SameSite=Lax; Max-Age=28800$/,
  );
  assert.match((await createSessions({ cookie: { secure: false } }).start({})).cookie, /^nexus_session=/);
  assert.throws(() => createSessions({ cookie: { sameSite: 'None', secure: false } }), /SameSite=None, must be secure/);
  assert.throws(() => createSessions({ cookie: { name: 'bad name' } }), /not a cookie name/);
  await assert.rejects(sessions.start({ tenantId: 'not a tenant!' }), /tenant/i);
});

test('a server takes a session, a kept key, or an issued token, and refuses each once it is ended', async () => {
  const store = new MemoryServerStore();
  const signer = createJwtSigner({
    privateKey: await generateJwtKey(),
    issuer: 'https://agents.test',
    audience: 'agents-api',
  });
  const keys = createApiKeyStore({ store });
  const sessions = createSessions({ store });
  const server = createAgentServer({
    assistants: { echo: functionAssistant(async () => ({ ok: true })) },
    state: store,
    authenticate: anyAuth(
      sessions.auth,
      keys.auth(),
      jwtAuth({
        jwks: 'https://agents.test/.well-known/jwks.json',
        issuer: 'https://agents.test',
        audience: 'agents-api',
        fetch: keySetFrom(jwksHandler(signer)),
      }),
    ),
  });
  const threads = (headers: Record<string, string>) =>
    server.handle(new Request('https://agents.test/threads', { headers }));
  const { cookie, record } = await sessions.start({ userId: 'ana', tenantId: 'acme', scopes: ['read', 'write'] });
  const { key, record: keyRecord } = await keys.issue({ userId: 'ci', tenantId: 'acme', scopes: ['read'] });
  const token = await signer.issue({ userId: 'svc', tenantId: 'acme', scopes: ['read'] });
  for (const headers of [
    { cookie: cookie.split('; ')[0] as string },
    { 'x-api-key': key },
    { authorization: `Bearer ${token}` },
  ] as Array<Record<string, string>>) {
    assert.equal((await threads(headers)).status, 200, Object.keys(headers)[0]);
  }
  await sessions.revoke(record.id);
  await keys.revoke(keyRecord.id);
  assert.equal((await threads({ cookie: cookie.split('; ')[0] as string })).status, 401);
  assert.equal((await threads({ 'x-api-key': key })).status, 401);
  assert.equal((await threads({})).status, 401);
});
