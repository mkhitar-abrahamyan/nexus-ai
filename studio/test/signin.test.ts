/**
 * The studio's own sign-in, against an OpenID provider in this process that signs real ID tokens:
 * the code flow with PKCE, a state and a nonce, every way a callback can be wrong, the session, and
 * signing out.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createJwtSigner, generateJwtKey, jwksHandler } from 'nexus-ai-pro/server/auth';
import { createStudio, type Studio } from '../src/api.js';
import { bearerAuth } from '../src/auth.js';
import { MemoryStudioJournal, type StudioAuditEntry } from '../src/journal.js';
import { type OidcSignInOptions, oidcSignIn } from '../src/oidc.js';
import { startStudio } from '../src/server.js';

const ORIGIN = 'http://127.0.0.1:4747';
const ISSUER = 'https://login.example.com';
const SECRET = 'the-studio-session-secret-0123456789';
// Long past, so a verifier that read the real clock instead of the studio's would refuse every token.
const START = Date.UTC(2025, 0, 15, 9);

/** An OpenID provider: its configuration, keys, and token endpoint, and a person signing in at it. */
async function provider(
  configured: { issuer?: string; methods?: string[]; endSession?: boolean; drop?: string; status?: number } = {},
) {
  let at = START;
  const signer = createJwtSigner({
    privateKey: await generateJwtKey('ES256'),
    issuer: configured.issuer ?? ISSUER,
    audience: 'nexus-studio',
    now: () => at,
  });
  const keys = jwksHandler(signer);
  const codes = new Map<string, { claims: Record<string, unknown>; challenge: string; redirectUri: string }>();
  const exchanges: Array<{ body: URLSearchParams; authorization: string | null }> = [];
  const state = { discoveries: 0, status: configured.status ?? 200, at };
  const issuer = configured.issuer ?? ISSUER;
  const base = issuer.replace(/\/+$/, '');
  const fetch = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/.well-known/openid-configuration') {
      state.discoveries += 1;
      if (state.status !== 200) return new Response('unavailable', { status: state.status });
      const configuration: Record<string, unknown> = {
        issuer,
        authorization_endpoint: `${base}/authorize?prompt=login`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/keys`,
        ...(configured.endSession ? { end_session_endpoint: `${base}/logout` } : {}),
        ...(configured.methods ? { token_endpoint_auth_methods_supported: configured.methods } : {}),
      };
      if (configured.drop) delete configuration[configured.drop];
      return Response.json(configuration);
    }
    if (url.pathname === '/keys') return keys(new Request(url));
    if (url.pathname === '/token') {
      const body = new URLSearchParams(String(init.body));
      exchanges.push({ body, authorization: new Headers(init.headers).get('authorization') });
      if (body.get('code') === 'answered-with-a-page') return new Response('<html>busy</html>', { status: 502 });
      const grant = codes.get(body.get('code') ?? '');
      const challenge = createHash('sha256')
        .update(body.get('code_verifier') ?? '')
        .digest('base64url');
      if (!grant || grant.challenge !== challenge || grant.redirectUri !== body.get('redirect_uri')) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      codes.delete(body.get('code') ?? '');
      return Response.json({ id_token: await signer.sign(grant.claims), token_type: 'Bearer', access_token: 'at' });
    }
    return new Response('not found', { status: 404 });
  };
  /** Someone signs in at the provider, which sends them back to the callback with a code. */
  const authorize = (location: string, claims: Record<string, unknown>) => {
    const asked = new URL(location);
    const code = randomUUID();
    const redirectUri = asked.searchParams.get('redirect_uri') as string;
    codes.set(code, {
      claims: { nonce: asked.searchParams.get('nonce'), ...claims },
      challenge: asked.searchParams.get('code_challenge') as string,
      redirectUri,
    });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', asked.searchParams.get('state') as string);
    return back.href;
  };
  return {
    fetch,
    authorize,
    exchanges,
    state,
    /** Moves the clock the provider and the studio share. */
    advance: (seconds: number) => {
      at += seconds * 1000;
    },
    now: () => new Date(at),
  };
}

type Provider = Awaited<ReturnType<typeof provider>>;

const sign = (idp: Provider, options: Partial<OidcSignInOptions> = {}) =>
  oidcSignIn({
    issuer: ISSUER,
    clientId: 'nexus-studio',
    clientSecret: 'sécret/+ x',
    role: (claims) => ((claims.groups as string[] | undefined)?.includes('ml-admins') ? 'admin' : undefined),
    secret: SECRET,
    fetch: idp.fetch,
    now: idp.now,
    ...options,
  });

const cookieNamed = (response: Response, name: string) =>
  response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${name}=`));
const pair = (cookie: string | undefined) => (cookie ?? '').split(';')[0] as string;

/** Through `/auth/login` to the provider: the address it sends the person to, and the flow's cookie. */
async function startSignIn(studio: Studio, path = '/auth/login', headers: Record<string, string> = {}) {
  const login = await studio.handle(new Request(`${ORIGIN}${path}`, { headers }));
  assert.equal(login.status, 303, `login answered ${login.status}: ${await login.clone().text()}`);
  return { login, location: login.headers.get('location') as string, flow: cookieNamed(login, 'nexus_studio_signin') };
}

const ANA = { sub: 'u-ana', name: 'Ana', email: 'ana@example.com', groups: ['ml-admins'], org: 'acme' };

test('someone who opens the studio signs in with the provider, and comes back to the page, as themselves', async () => {
  const idp = await provider();
  const journal = new MemoryStudioJournal();
  const studio = createStudio(
    {},
    {
      signIn: sign(idp, { tenant: (claims) => claims.org as string | undefined }),
      tenantSources: (tenant) => (tenant === 'acme' ? {} : undefined),
      audit: journal,
      comments: journal,
    },
  );

  const page = await studio.handle(new Request(`${ORIGIN}/`));
  assert.equal(page.status, 303);
  assert.equal(page.headers.get('location'), '/auth/login?return=%2F', 'no session: sent to sign in');
  assert.equal(page.headers.get('cache-control'), 'no-store');

  const { login, location, flow } = await startSignIn(studio, '/auth/login?return=%2F');
  const asked = new URL(location);
  assert.equal(`${asked.origin}${asked.pathname}`, `${ISSUER}/authorize`);
  assert.equal(asked.searchParams.get('prompt'), 'login', "the endpoint's own parameters are kept");
  assert.equal(asked.searchParams.get('response_type'), 'code');
  assert.equal(asked.searchParams.get('client_id'), 'nexus-studio');
  assert.equal(asked.searchParams.get('redirect_uri'), `${ORIGIN}/auth/callback`);
  assert.equal(asked.searchParams.get('scope'), 'openid profile email');
  assert.equal(asked.searchParams.get('code_challenge_method'), 'S256');
  assert.match(asked.searchParams.get('state') ?? '', /^[\w-]{43}$/);
  assert.match(asked.searchParams.get('nonce') ?? '', /^[\w-]{43}$/);
  assert.notEqual(asked.searchParams.get('state'), asked.searchParams.get('nonce'));
  assert.match(flow ?? '', /^nexus_studio_signin=[\w-]+\.[\w-]+; HttpOnly; SameSite=Lax; Path=\/auth\/; Max-Age=600$/);
  assert.equal(login.headers.get('referrer-policy'), 'no-referrer', 'the studio adds its security headers');

  const back = await studio.handle(new Request(idp.authorize(location, ANA), { headers: { cookie: pair(flow) } }));
  assert.equal(back.status, 303, await back.clone().text());
  assert.equal(back.headers.get('location'), '/');
  assert.match(cookieNamed(back, 'nexus_studio_signin') ?? '', /^nexus_studio_signin=; .*Max-Age=0$/, 'the flow ends');
  const session = cookieNamed(back, 'nexus_studio_session');
  assert.match(session ?? '', /^nexus_studio_session=[\w-]+\.[\w-]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=28800$/);

  // The code was exchanged with the PKCE verifier, the client authenticated in a Basic header.
  const [exchange] = idp.exchanges;
  assert.equal(exchange?.body.get('grant_type'), 'authorization_code');
  assert.equal(exchange?.body.get('redirect_uri'), `${ORIGIN}/auth/callback`);
  assert.equal(exchange?.body.get('client_secret'), null);
  assert.equal(exchange?.body.get('client_id'), null);
  assert.equal(
    exchange?.authorization,
    `Basic ${Buffer.from('nexus-studio:s%C3%A9cret%2F%2B+x').toString('base64')}`,
    'each part form-encoded, then joined',
  );

  const cookie = pair(session);
  const who = (await (await studio.handle(new Request(`${ORIGIN}/api/session`, { headers: { cookie } }))).json()) as {
    token: string;
    user: unknown;
  };
  assert.deepEqual(who.user, { id: 'u-ana', role: 'admin', name: 'Ana', email: 'ana@example.com', tenant: 'acme' });
  const overview = (await (
    await studio.handle(new Request(`${ORIGIN}/api/overview`, { headers: { cookie } }))
  ).json()) as { accounts: boolean; signOut: boolean };
  assert.equal(overview.accounts, true);
  assert.equal(overview.signOut, true, 'the page offers to sign out');
  assert.equal((await studio.handle(new Request(`${ORIGIN}/`, { headers: { cookie } }))).status, 200);

  const comment = (headers: Record<string, string>) =>
    studio.handle(
      new Request(`${ORIGIN}/api/comments`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ subject: 'prompt:answer', body: 'signed in' }),
      }),
    );
  assert.equal((await comment({})).status, 403, 'a change still needs the page token');
  assert.equal((await comment({ 'x-studio-token': who.token })).status, 200);
  assert.deepEqual(
    ((await journal.list()) as StudioAuditEntry[]).map((entry) => `${entry.user} ${entry.tenant} ${entry.outcome}`),
    ['u-ana acme ok', 'u-ana acme denied'],
  );

  // A second sign-in reads the provider's configuration from before.
  const again = await startSignIn(studio);
  await studio.handle(new Request(idp.authorize(again.location, ANA), { headers: { cookie: pair(again.flow) } }));
  assert.equal(idp.state.discoveries, 1);
  assert.equal(idp.exchanges.length, 2);
});

test('a callback that is not this sign-in is refused: its state, its flow, its nonce, its audience, its role', async () => {
  const idp = await provider();
  const studio = createStudio({}, { signIn: sign(idp) });
  const callback = async (claims: Record<string, unknown>, change: (url: URL) => void = () => {}, flow?: string) => {
    const started = await startSignIn(studio);
    const url = new URL(idp.authorize(started.location, claims));
    change(url);
    const answer = await studio.handle(new Request(url, { headers: { cookie: flow ?? pair(started.flow) } }));
    if (answer.status !== 303) {
      assert.equal(cookieNamed(answer, 'nexus_studio_session'), undefined, 'no session after a refusal');
    }
    return { status: answer.status, text: await answer.text(), started };
  };

  assert.equal((await callback(ANA)).status, 303, 'the sign-in as it should be');
  assert.equal((await callback(ANA, (url) => url.searchParams.set('state', 'another'))).status, 400);
  assert.equal((await callback(ANA, () => {}, 'nexus_studio_other=1')).status, 400, 'no flow cookie');
  const started = await startSignIn(studio);
  const [payload, signature] = pair(started.flow).slice('nexus_studio_signin='.length).split('.') as [string, string];
  const forged = { ...JSON.parse(Buffer.from(payload, 'base64url').toString()), state: 'mine' };
  const resealed = `nexus_studio_signin=${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signature}`;
  assert.equal(
    (await callback(ANA, (url) => url.searchParams.set('state', 'mine'), resealed)).status,
    400,
    'a flow changed without the secret',
  );
  assert.equal((await callback(ANA, (url) => url.searchParams.delete('code'))).status, 400, 'no code');

  const nonce = await callback({ ...ANA, nonce: 'another sign-in' });
  assert.deepEqual([nonce.status, nonce.text], [401, 'The ID token is not for this sign-in.']);
  const audience = await callback({ ...ANA, aud: 'another-app' });
  assert.equal(audience.status, 401);
  assert.match(audience.text, /ID token was refused/);
  assert.equal((await callback({ ...ANA, aud: ['nexus-studio', 'another-app'] })).status, 401, 'several, no azp');
  assert.equal(
    (await callback({ ...ANA, aud: ['nexus-studio', 'another-app'], azp: 'another-app' })).status,
    401,
    'an azp of another client',
  );
  assert.equal((await callback({ ...ANA, aud: ['nexus-studio', 'another-app'], azp: 'nexus-studio' })).status, 303);
  assert.equal((await callback({ ...ANA, aud: ['nexus-studio'] })).status, 303, 'one audience in a list');

  const outsider = await callback({ ...ANA, groups: [] });
  assert.equal(outsider.status, 403, 'signed in at the provider, given no role here');
  assert.match(outsider.text, /does not let you in/);
  const { sub: _sub, ...nobody } = ANA;
  assert.equal((await callback(nobody)).status, 403, 'no subject, no id');

  const reused = await callback(ANA, (url) => url.searchParams.set('code', 'a code the provider never gave'));
  assert.equal(reused.status, 502);
  assert.match(reused.text, /invalid_grant/);
  const busy = await callback(ANA, (url) => url.searchParams.set('code', 'answered-with-a-page'));
  assert.deepEqual(
    [busy.status, busy.text],
    [502, 'Signing in through the identity provider failed: it did not exchange the code: HTTP 502.'],
  );
  const foreign = await callback({ ...ANA, iss: 'https://elsewhere.example.com' });
  assert.equal(foreign.status, 401, 'a token another issuer signed');

  const cancelled = await studio.handle(
    new Request(`${ORIGIN}/auth/callback?error=access_denied&error_description=Cancelled%20by%20the%20user`),
  );
  assert.equal(cancelled.status, 401);
  assert.equal(cancelled.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(
    await cancelled.text(),
    'The identity provider did not sign you in: access_denied (Cancelled by the user).',
  );
  assert.match(cookieNamed(cancelled, 'nexus_studio_signin') ?? '', /Max-Age=0/);
  assert.equal(
    await (await studio.handle(new Request(`${ORIGIN}/auth/callback?error=access_denied`))).text(),
    'The identity provider did not sign you in: access_denied.',
  );

  // Ten minutes to finish at the provider, and not a second more.
  const slow = await startSignIn(studio);
  const url = idp.authorize(slow.location, ANA);
  idp.advance(600);
  assert.equal((await studio.handle(new Request(url, { headers: { cookie: pair(slow.flow) } }))).status, 400);
  const quick = await startSignIn(studio);
  const quickUrl = idp.authorize(quick.location, ANA);
  idp.advance(599);
  assert.equal((await studio.handle(new Request(quickUrl, { headers: { cookie: pair(quick.flow) } }))).status, 303);
});

test('a session lasts its age, is nobody once changed, and signing out ends it at the provider too', async () => {
  const idp = await provider({ endSession: true });
  const studio = createStudio({}, { signIn: sign(idp, { maxAgeSec: 3600 }) });
  const started = await startSignIn(studio, '/auth/login', { 'x-forwarded-proto': 'https' });
  assert.match(started.flow ?? '', /; Secure$/, 'behind an HTTPS proxy, the cookies are Secure');
  const back = await studio.handle(
    new Request(idp.authorize(started.location, ANA), {
      headers: { cookie: pair(started.flow), 'x-forwarded-proto': 'https' },
    }),
  );
  const session = cookieNamed(back, 'nexus_studio_session') ?? '';
  assert.match(session, /Max-Age=3600; Secure$/);
  const cookie = pair(session);
  const sessionStatus = (value: string) =>
    studio.handle(new Request(`${ORIGIN}/api/session`, { headers: { cookie: value } })).then((answer) => answer.status);

  assert.equal(await sessionStatus(cookie), 200);
  const value = cookie.slice('nexus_studio_session='.length);
  const flipped = `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(await sessionStatus(`nexus_studio_session=${flipped}`), 401, 'a changed signature');
  assert.equal(await sessionStatus('nexus_studio_session=no-signature'), 401);
  assert.equal(
    await sessionStatus(`nexus_studio_session=${pair(started.flow).slice('nexus_studio_signin='.length)}`),
    401,
    'a flow cookie is never a session',
  );
  const elsewhere = createStudio({}, { signIn: sign(idp, { secret: 'another-studio-secret-0123456789abcdef' }) });
  assert.equal(
    (await elsewhere.handle(new Request(`${ORIGIN}/api/session`, { headers: { cookie } }))).status,
    401,
    "another secret's studio does not take it",
  );

  idp.advance(3599);
  assert.equal(await sessionStatus(cookie), 200);
  idp.advance(1);
  assert.equal(await sessionStatus(cookie), 401, 'an hour on, the session has ended');
  const page = await studio.handle(new Request(`${ORIGIN}/?view=traces`, { headers: { cookie } }));
  assert.equal(page.headers.get('location'), '/auth/login?return=%2F%3Fview%3Dtraces', 'and the page signs in again');

  const out = await studio.handle(new Request(`${ORIGIN}/auth/logout`, { headers: { cookie } }));
  assert.equal(out.status, 303);
  assert.equal(out.headers.get('location'), `${ISSUER}/logout?client_id=nexus-studio`);
  assert.match(
    cookieNamed(out, 'nexus_studio_session') ?? '',
    /^nexus_studio_session=; HttpOnly; SameSite=Lax; Path=\/; Max-Age=0$/,
  );

  const plain = await provider();
  const quiet = await createStudio({}, { signIn: sign(plain) }).handle(new Request(`${ORIGIN}/auth/logout`));
  assert.deepEqual([quiet.status, await quiet.text()], [200, 'You are signed out of the studio.']);
  const down = await provider({ status: 503 });
  const offline = await createStudio({}, { signIn: sign(down) }).handle(new Request(`${ORIGIN}/auth/logout`));
  assert.equal(offline.status, 200, 'signed out of the studio while the provider is down');
  assert.match(cookieNamed(offline, 'nexus_studio_session') ?? '', /Max-Age=0/);
});

test('the page to come back to is always on the studio', async () => {
  const idp = await provider();
  const studio = createStudio({}, { signIn: sign(idp) });
  const returnTo = async (value: string | undefined) => {
    const path = value === undefined ? '/auth/login' : `/auth/login?return=${encodeURIComponent(value)}`;
    const started = await startSignIn(studio, path);
    const back = await studio.handle(
      new Request(idp.authorize(started.location, ANA), { headers: { cookie: pair(started.flow) } }),
    );
    return back.headers.get('location');
  };
  assert.equal(await returnTo('/?view=traces#run-1'), '/?view=traces#run-1');
  assert.equal(await returnTo(undefined), '/');
  for (const away of [
    '//evil.example/x',
    'https://evil.example/',
    '/\\evil.example',
    'javascript:alert(1)',
    'http://[',
  ]) {
    assert.equal(await returnTo(away), '/', `${away} stays on the studio`);
  }
  assert.equal(await returnTo('/.//evil.example'), '/evil.example', 'a path that would read as a host is a path');
});

test('the provider is what its configuration says: another issuer is refused, a failed read is tried again, and the client authenticates as it asks', async () => {
  const exchange = async (idp: Provider, options: Partial<OidcSignInOptions> = {}) => {
    const studio = createStudio({}, { signIn: sign(idp, options) });
    const started = await startSignIn(studio);
    const back = await studio.handle(
      new Request(idp.authorize(started.location, ANA), { headers: { cookie: pair(started.flow) } }),
    );
    assert.equal(back.status, 303, await back.clone().text());
    return { started, sent: idp.exchanges.at(-1) };
  };

  const pub = await exchange(await provider(), { clientSecret: undefined });
  assert.equal(pub.sent?.authorization, null, 'a public client sends no secret');
  assert.equal(pub.sent?.body.get('client_id'), 'nexus-studio');
  const post = await exchange(await provider({ methods: ['client_secret_post'] }));
  assert.equal(post.sent?.authorization, null);
  assert.equal(post.sent?.body.get('client_id'), 'nexus-studio');
  assert.equal(post.sent?.body.get('client_secret'), 'sécret/+ x', 'in the body, when the provider takes only that');
  const both = await exchange(await provider({ methods: ['client_secret_post', 'client_secret_basic'] }));
  assert.match(both.sent?.authorization ?? '', /^Basic /);
  assert.equal(both.sent?.body.get('client_secret'), null);

  const scoped = await exchange(await provider(), {
    scopes: ['groups', 'openid'],
    redirectUri: 'http://127.0.0.1:4747/auth/callback?from=studio',
  });
  const asked = new URL(scoped.started.location);
  assert.equal(asked.searchParams.get('scope'), 'openid groups', 'openid once, and first');
  assert.equal(asked.searchParams.get('redirect_uri'), 'http://127.0.0.1:4747/auth/callback?from=studio');
  assert.equal(scoped.sent?.body.get('redirect_uri'), 'http://127.0.0.1:4747/auth/callback?from=studio');
  const picked = await provider();
  const named = createStudio({}, { signIn: sign(picked, { id: (claims) => claims.email as string }) });
  const naming = await startSignIn(named, '/auth/login', { 'x-forwarded-proto': 'http' });
  const signedIn = await named.handle(
    new Request(picked.authorize(naming.location, ANA), { headers: { cookie: pair(naming.flow) } }),
  );
  const own = (await (
    await named.handle(
      new Request(`${ORIGIN}/api/session`, {
        headers: { cookie: pair(cookieNamed(signedIn, 'nexus_studio_session')) },
      }),
    )
  ).json()) as { user: { id: string } };
  assert.equal(own.user.id, 'ana@example.com', 'signed in under the id the application picks');
  assert.doesNotMatch(naming.flow ?? '', /Secure/, 'plain HTTP, and not Secure');
  const tls = await createStudio({}, { signIn: sign(picked) }).handle(new Request('https://127.0.0.1:4747/auth/login'));
  assert.match(cookieNamed(tls, 'nexus_studio_signin') ?? '', /; Secure$/, 'reached over HTTPS, Secure');

  const slash = await provider({ issuer: `${ISSUER}/` });
  await exchange(slash, { issuer: `${ISSUER}/` });
  assert.equal(slash.state.discoveries, 1, 'an issuer with a trailing slash is read at one well-known path');

  const impostor = await provider({ issuer: 'https://impostor.example.com' });
  const refused = await createStudio({}, { signIn: sign(impostor) }).handle(new Request(`${ORIGIN}/auth/login`));
  assert.equal(refused.status, 502);
  assert.match(
    await refused.text(),
    /names the issuer https:\/\/impostor\.example\.com, not https:\/\/login\.example\.com/,
  );
  for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    const missing = await createStudio({}, { signIn: sign(await provider({ drop: field })) }).handle(
      new Request(`${ORIGIN}/auth/login`),
    );
    assert.equal(missing.status, 502);
    assert.match(await missing.text(), new RegExp(`has no ${field}`));
  }

  const flaky = await provider({ status: 503 });
  const studio = createStudio({}, { signIn: sign(flaky) });
  const down = await studio.handle(new Request(`${ORIGIN}/auth/login`));
  assert.equal(down.status, 502);
  assert.match(await down.text(), /HTTP 503/);
  flaky.state.status = 200;
  assert.equal((await studio.handle(new Request(`${ORIGIN}/auth/login`))).status, 303, 'read again once it is back');
  await studio.handle(new Request(`${ORIGIN}/auth/login`));
  assert.equal(flaky.state.discoveries, 2, 'and kept');

  assert.equal((await studio.handle(new Request(`${ORIGIN}/auth/elsewhere`))).status, 404);
  assert.throws(() => sign(flaky, { secret: 'x'.repeat(31) }), /at least 32 characters/);
  assert.throws(() => sign(flaky, { secret: undefined as unknown as string }), /at least 32 characters/);
  assert.ok(sign(flaky, { secret: 'x'.repeat(32) }), 'thirty-two characters will do');
  assert.throws(() => sign(flaky, { clientId: '' }), /an issuer and a clientId/);
  assert.throws(() => sign(flaky, { issuer: '' }), /an issuer and a clientId/);
});

test('an authenticator is asked first, so scripts send bearer tokens to a studio people sign in to', async () => {
  const idp = await provider();
  const studio = createStudio(
    {},
    {
      auth: bearerAuth({
        verify: (token) => (token === 'script-token' ? { sub: 'ci' } : undefined),
        role: () => 'viewer',
      }),
      signIn: sign(idp),
    },
  );
  const script = await studio.handle(
    new Request(`${ORIGIN}/api/session`, { headers: { authorization: 'Bearer script-token' } }),
  );
  assert.equal(((await script.json()) as { user: { id: string } }).user.id, 'ci');

  const started = await startSignIn(studio);
  const back = await studio.handle(
    new Request(idp.authorize(started.location, ANA), { headers: { cookie: pair(started.flow) } }),
  );
  const session = pair(cookieNamed(back, 'nexus_studio_session'));
  const both = await studio.handle(
    new Request(`${ORIGIN}/api/session`, { headers: { cookie: session, authorization: 'Bearer script-token' } }),
  );
  assert.equal(((await both.json()) as { user: { id: string } }).user.id, 'ci', 'the authenticator before the session');
  const person = await studio.handle(new Request(`${ORIGIN}/api/session`, { headers: { cookie: session } }));
  assert.equal(((await person.json()) as { user: { id: string } }).user.id, 'u-ana');
  const nobody = await studio.handle(new Request(`${ORIGIN}/api/session`));
  assert.equal(nobody.status, 401);
  assert.equal(((await nobody.json()) as { error: { message: string } }).error.message, 'Sign in first');
});

test('a studio beyond the loopback address warns of its one shared token, and not once people sign in', async () => {
  const warnings: string[] = [];
  const listen = (warning: Error & { code?: string }) => warnings.push(warning.code ?? warning.message);
  process.on('warning', listen);
  try {
    for (const options of [
      {},
      { signIn: sign(await provider()) },
      { auth: bearerAuth({ verify: () => undefined, role: () => 'viewer' }) },
    ]) {
      const running = await startStudio({}, { port: 0, host: '127.0.0.2', ...options });
      await running.close();
    }
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', listen);
  }
  assert.deepEqual(warnings, ['NEXUS_STUDIO_SHARED_TOKEN'], 'the single token alone is warned of');
});
