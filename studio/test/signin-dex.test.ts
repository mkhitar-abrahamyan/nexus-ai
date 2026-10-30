/**
 * The studio's sign-in against a real OpenID Connect provider: Dex, run in a container, with a person
 * of its own. The studio reads Dex's configuration, sends the person there, takes the code back,
 * exchanges it with its client secret and PKCE verifier, and verifies Dex's ID token against Dex's keys,
 * so nothing here was written to agree with the studio. Needs a container runtime; with
 * NEXUS_REQUIRE_CONTAINER=1 it fails rather than skips without one.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { type AddressInfo, createServer } from 'node:net';
import { test } from 'node:test';
import { createStudio } from '../src/api.js';
import { oidcSignIn } from '../src/oidc.js';

const binary = process.env.NEXUS_CONTAINER_BINARY ?? 'docker';
const image = process.env.NEXUS_DEX_IMAGE ?? 'ghcr.io/dexidp/dex:v2.46.0';
const required = process.env.NEXUS_REQUIRE_CONTAINER === '1';
const daemon = spawnSync(binary, ['info'], { timeout: 30_000, windowsHide: true, stdio: 'ignore' });
const skip = daemon.status === 0 ? false : `no ${binary} daemon is reachable`;

const ORIGIN = 'http://127.0.0.1:4747';
const CLIENT = { id: 'nexus-studio', secret: 'the-studio-client-secret' };
// Dex's own example person, whose password is "password".
const PERSON = {
  email: 'admin@example.com',
  password: 'password',
  hash: '$2a$10$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W',
};

/** A port free on this machine, for Dex to be published on, since its issuer names it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * A person at Dex, as a browser would be: following its redirects with its cookies, filling in its
 * login form, until Dex sends them back to the studio. The studio's callback, or nothing when Dex kept
 * them, as it does for a wrong password.
 */
async function atDex(start: string, password = PERSON.password): Promise<string | undefined> {
  const jar = new Map<string, string>();
  let url = start;
  let body: string | undefined;
  for (let hop = 0; hop < 20; hop += 1) {
    if (url.startsWith(`${ORIGIN}/auth/callback`)) return url;
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET',
      redirect: 'manual',
      headers: {
        ...(jar.size ? { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } : {}),
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(body ? { body } : {}),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0] as string;
      jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
    }
    const location = response.headers.get('location');
    if (location) {
      url = new URL(location, url).href;
      body = undefined;
      continue;
    }
    const page = await response.text();
    // A second form after the password was sent says it was wrong.
    if (body || !/name="password"/.test(page)) return undefined;
    const action = /<form[^>]*action="([^"]+)"/.exec(page)?.[1];
    assert.ok(action, `Dex's login page has a form:\n${page.slice(0, 500)}`);
    url = new URL(action.replaceAll('&amp;', '&'), url).href;
    body = new URLSearchParams({ login: PERSON.email, password }).toString();
  }
  return undefined;
}

test('a person signs in to the studio through Dex, a real OpenID Connect provider, and acts as themselves', {
  skip: required ? false : skip,
  timeout: 300_000,
}, async () => {
  assert.equal(daemon.status, 0, `NEXUS_REQUIRE_CONTAINER=1, but \`${binary} info\` failed`);
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}/dex`;
  const config = {
    issuer,
    storage: { type: 'memory' },
    web: { http: '0.0.0.0:5556' },
    oauth2: { skipApprovalScreen: true, passwordConnector: 'local' },
    enablePasswordDB: true,
    staticPasswords: [
      { email: PERSON.email, hash: PERSON.hash, username: 'admin', userID: '08a8684b-db88-4b73-90a9-3cd1661f5466' },
    ],
    staticClients: [
      { id: CLIENT.id, secret: CLIENT.secret, name: 'Nexus studio', redirectURIs: [`${ORIGIN}/auth/callback`] },
    ],
  };
  // The configuration travels in the environment, JSON being YAML too, so nothing is mounted.
  const started = spawnSync(
    binary,
    [
      'run',
      '--detach',
      '--publish',
      `127.0.0.1:${port}:5556`,
      '--env',
      `DEX_CONFIG=${JSON.stringify(config)}`,
      '--entrypoint',
      'sh',
      image,
      '-c',
      'printf "%s" "$DEX_CONFIG" > /tmp/config.yaml && exec dex serve /tmp/config.yaml',
    ],
    { encoding: 'utf8', timeout: 240_000, windowsHide: true },
  );
  assert.equal(started.status, 0, started.stderr);
  const container = started.stdout.trim();
  const logs = () => {
    const read = spawnSync(binary, ['logs', container], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    return `${read.stdout}${read.stderr}`;
  };
  try {
    // Dex takes a moment to start; until then its configuration is not served.
    const deadline = Date.now() + 60_000;
    let discovery: { end_session_endpoint?: string } | undefined;
    while (!discovery) {
      try {
        const answer = await fetch(`${issuer}/.well-known/openid-configuration`);
        if (answer.ok) discovery = (await answer.json()) as { end_session_endpoint?: string };
      } catch {
        // Not listening yet.
      }
      if (!discovery) {
        assert.ok(Date.now() < deadline, `Dex never served its configuration:\n${logs()}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const studio = createStudio(
      {},
      {
        signIn: oidcSignIn({
          issuer,
          clientId: CLIENT.id,
          clientSecret: CLIENT.secret,
          role: (claims) => (claims.email === PERSON.email && claims.email_verified === true ? 'admin' : undefined),
          secret: 'the-studio-session-secret-0123456789',
        }),
      },
    );
    const opened = await studio.handle(new Request(`${ORIGIN}/`));
    assert.equal(opened.headers.get('location'), '/auth/login?return=%2F');
    const login = await studio.handle(new Request(`${ORIGIN}/auth/login?return=%2F`));
    assert.equal(login.status, 303, await login.clone().text());
    const toDex = login.headers.get('location') as string;
    assert.ok(toDex.startsWith(`${issuer}/auth?`), `sent to Dex: ${toDex}`);
    const flow = (login.headers.getSetCookie()[0] ?? '').split(';')[0] as string;

    assert.equal(await atDex(toDex, 'not the password'), undefined, 'Dex keeps someone with a wrong password');

    const callback = await atDex(toDex);
    assert.ok(callback, `Dex sent the person back:\n${logs()}`);
    const back = await studio.handle(new Request(callback, { headers: { cookie: flow } }));
    assert.equal(back.status, 303, `the studio took them back: ${await back.clone().text()}\n${logs()}`);
    assert.equal(back.headers.get('location'), '/');
    const session = back.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith('nexus_studio_session='))
      ?.split(';')[0] as string;
    assert.ok(session, 'a session');

    const who = (await (
      await studio.handle(new Request(`${ORIGIN}/api/session`, { headers: { cookie: session } }))
    ).json()) as { token: string; user: { id: string; email?: string; name?: string; role: string } };
    assert.equal(who.user.email, PERSON.email);
    assert.equal(who.user.role, 'admin');
    assert.equal(who.user.name, 'admin', "Dex's name for them");
    assert.ok(who.user.id.length > 10, `Dex's subject for them: ${who.user.id}`);
    const commented = await studio.handle(
      new Request(`${ORIGIN}/api/comments`, {
        method: 'POST',
        headers: { cookie: session, 'x-studio-token': who.token, 'content-type': 'application/json' },
        body: JSON.stringify({ subject: 'prompt:answer', body: 'signed in through Dex' }),
      }),
    );
    assert.equal(commented.status, 200, 'a change, under their own name');

    // A code is used once: the same callback again is refused.
    const again = await studio.handle(new Request(callback, { headers: { cookie: flow } }));
    assert.equal(again.status, 502, 'Dex refuses a code it already exchanged');

    const out = await studio.handle(new Request(`${ORIGIN}/auth/logout`, { headers: { cookie: session } }));
    assert.equal(out.status, discovery.end_session_endpoint ? 303 : 200, 'signed out, at Dex too when it says how');
    assert.match(out.headers.getSetCookie().join('\n'), /nexus_studio_session=;.*Max-Age=0/);
  } finally {
    spawnSync(binary, ['rm', '--force', container], { windowsHide: true, timeout: 60_000 });
  }
});
