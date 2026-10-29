import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { JwtVerifier } from 'nexus-ai-pro/server/auth';
import type { StudioRole, StudioSignIn, StudioUser } from './auth.js';

/** The cookie a signed-in person's session travels in. */
export const SIGN_IN_COOKIE = 'nexus_studio_session';
/** The cookie that carries one sign-in's state, nonce, and PKCE verifier to the callback. */
const FLOW_COOKIE = 'nexus_studio_signin';
/** How long someone has to finish signing in at the provider, in seconds. */
const FLOW_SECONDS = 600;

/** Options for `oidcSignIn()`. */
export interface OidcSignInOptions {
  /**
   * The identity provider's issuer, such as `https://login.example.com`. Its
   * `/.well-known/openid-configuration` says where to send people and where its keys are.
   */
  issuer: string;
  /** The studio's client id at the provider. */
  clientId: string;
  /**
   * The client secret, for a confidential client, sent as the provider asks: in a Basic header, or in
   * the body when it takes only that. Without one the studio signs in as a public client, by PKCE alone.
   */
  clientSecret?: string;
  /**
   * Where the provider sends people back: the studio's `/auth/callback`, exactly as registered with the
   * provider. Defaults to that path on the address the request came to; set it behind a proxy.
   */
  redirectUri?: string;
  /** The scopes asked for. Defaults to `openid profile email`; `openid` is always asked for. */
  scopes?: readonly string[];
  /** A person's role from their ID token's claims. Returning `undefined` refuses them. */
  role: (claims: Record<string, unknown>) => StudioRole | undefined;
  /** A person's tenant from their claims, or `undefined` for someone who belongs to none. */
  tenant?: (claims: Record<string, unknown>) => string | undefined;
  /** A person's id from their claims. Defaults to `sub`. */
  id?: (claims: Record<string, unknown>) => string | undefined;
  /**
   * Signs the session and sign-in cookies: at least 32 characters, and the same on every replica.
   * Changing it signs everyone out.
   */
  secret: string;
  /** How long a session lasts, in seconds. Defaults to 8 hours. A new role applies at the next sign-in. */
  maxAgeSec?: number;
  /** Fetches the provider's configuration, keys, and tokens. Defaults to the global `fetch`. */
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** Replaces the clock, for tests. */
  now?: () => Date;
}

/** What the provider's discovery document says, as far as signing in needs. */
interface ProviderConfiguration {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
}

/** One sign-in in progress, carried in a signed cookie from `/auth/login` to `/auth/callback`. */
interface Flow {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  back: string;
  exp: number;
}

/**
 * Signs people in with an OpenID Connect provider, with no proxy in front: the authorization code
 * flow with PKCE, a state and a nonce, and the ID token verified against the provider's keys.
 *
 * Give it to the studio as `signIn`. Someone who opens the studio without a session goes to
 * `/auth/login`, which sends them to the provider; `/auth/callback` takes them back, and
 * `/auth/logout` signs them out, and out of the provider too when it says how. The session is a signed
 * cookie, so replicas that share the `secret` share sessions, with no store.
 *
 * ```ts
 * const signIn = oidcSignIn({
 *   issuer: 'https://login.example.com',
 *   clientId: 'nexus-studio',
 *   clientSecret: process.env.STUDIO_CLIENT_SECRET,
 *   redirectUri: 'https://studio.example.com/auth/callback',
 *   role: (claims) => ((claims.groups as string[] | undefined)?.includes('ml-admins') ? 'admin' : 'viewer'),
 *   secret: process.env.STUDIO_SECRET ?? '',
 * });
 * ```
 */
export function oidcSignIn(options: OidcSignInOptions): StudioSignIn {
  if (!options.issuer || !options.clientId) throw new TypeError('oidcSignIn() needs an issuer and a clientId');
  if ((options.secret?.length ?? 0) < 32) {
    throw new RangeError('oidcSignIn() needs a secret of at least 32 characters, the same on every replica');
  }
  const fetchFrom = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = options.now ?? (() => new Date());
  const maxAgeSec = options.maxAgeSec ?? 28_800;
  const scopes = ['openid', ...(options.scopes ?? ['profile', 'email']).filter((scope) => scope !== 'openid')];
  const secret = options.secret;
  let provider: Promise<{ configuration: ProviderConfiguration; verifier: JwtVerifier }> | undefined;

  /** The provider's configuration and a verifier for its keys, read once; a failed read is tried again. */
  function discover() {
    if (!provider) {
      const reading = (async () => {
        const response = await fetchFrom(`${options.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
        if (!response.ok) throw new Error(`its configuration answered HTTP ${response.status}`);
        const configuration = (await response.json()) as ProviderConfiguration & { issuer?: unknown };
        // A document naming another issuer describes another provider, whose tokens this one must not take.
        if (configuration.issuer !== options.issuer) {
          throw new Error(`its configuration names the issuer ${String(configuration.issuer)}, not ${options.issuer}`);
        }
        for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
          if (typeof configuration[field] !== 'string') throw new Error(`its configuration has no ${field}`);
        }
        const { createJwtVerifier } = await import('nexus-ai-pro/server/auth');
        const verifier = createJwtVerifier({
          jwks: configuration.jwks_uri,
          issuer: options.issuer,
          audience: options.clientId,
          fetch: fetchFrom,
          now: () => now().getTime(),
        });
        return { configuration, verifier };
      })();
      provider = reading;
      reading.catch(() => {
        provider = undefined;
      });
    }
    return provider;
  }

  const sign = (purpose: string, payload: string) =>
    createHmac('sha256', secret).update(`${purpose}\u0000${payload}`).digest('base64url');
  const seal = (purpose: string, value: unknown) => {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${payload}.${sign(purpose, payload)}`;
  };
  /** A sealed value, when its signature is this purpose's; a flow cookie is never a session. */
  const unseal = <T>(purpose: string, sealed: string | undefined): T | undefined => {
    if (!sealed?.includes('.')) return undefined;
    const dot = sealed.indexOf('.');
    const payload = sealed.slice(0, dot);
    if (!same(sign(purpose, payload), sealed.slice(dot + 1))) return undefined;
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
  };
  const seconds = () => now().getTime() / 1000;

  async function login(request: Request, url: URL): Promise<Response> {
    const { configuration } = await discover();
    const flow: Flow = {
      state: randomBytes(32).toString('base64url'),
      nonce: randomBytes(32).toString('base64url'),
      verifier: randomBytes(32).toString('base64url'),
      redirectUri: options.redirectUri ?? new URL('/auth/callback', url).href,
      back: returnPath(url),
      exp: seconds() + FLOW_SECONDS,
    };
    const target = new URL(configuration.authorization_endpoint);
    for (const [name, value] of Object.entries({
      response_type: 'code',
      client_id: options.clientId,
      redirect_uri: flow.redirectUri,
      scope: scopes.join(' '),
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'),
      code_challenge_method: 'S256',
    })) {
      target.searchParams.set(name, value);
    }
    return redirect(target.href, [
      cookie(FLOW_COOKIE, seal('flow', flow), '/auth/', FLOW_SECONDS, secure(request, url)),
    ]);
  }

  async function callback(request: Request, url: URL): Promise<Response> {
    const ended = [cookie(FLOW_COOKIE, '', '/auth/', 0, secure(request, url))];
    const error = url.searchParams.get('error');
    if (error) {
      const description = url.searchParams.get('error_description');
      return page(
        401,
        `The identity provider did not sign you in: ${error}${description ? ` (${description})` : ''}.`,
        ended,
      );
    }
    const flow = unseal<Flow>('flow', cookieOf(request, FLOW_COOKIE));
    if (!flow || flow.exp <= seconds() || !same(flow.state, url.searchParams.get('state'))) {
      return page(
        400,
        'This sign-in expired, or was started in another browser. Open the studio to sign in again.',
        ended,
      );
    }
    const code = url.searchParams.get('code');
    if (!code) return page(400, 'The identity provider sent no code.', ended);

    const { configuration, verifier } = await discover();
    const idToken = await exchange(configuration, code, flow);
    let claims: Record<string, unknown>;
    try {
      claims = (await verifier.verify(idToken)).payload as Record<string, unknown>;
    } catch (refused) {
      return page(401, `The identity provider's ID token was refused: ${(refused as Error).message}.`, ended);
    }
    // The nonce ties the token to this sign-in, and a token for several clients must name this one.
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!same(flow.nonce, claims.nonce) || (audiences.length > 1 && claims.azp !== options.clientId)) {
      return page(401, 'The ID token is not for this sign-in.', ended);
    }

    const id = options.id ? options.id(claims) : typeof claims.sub === 'string' ? claims.sub : undefined;
    const role = options.role(claims);
    if (!id || !role) return page(403, 'You signed in, and this studio does not let you in. Ask for a role.', ended);
    const tenant = options.tenant?.(claims);
    const user: StudioUser = {
      id,
      role,
      ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
      ...(tenant === undefined ? {} : { tenant }),
    };
    const session = seal('session', { user, exp: seconds() + maxAgeSec });
    return redirect(flow.back, [...ended, cookie(SIGN_IN_COOKIE, session, '/', maxAgeSec, secure(request, url))]);
  }

  /** The code exchanged for tokens, with the PKCE verifier, and the client authenticated as the provider takes it. */
  async function exchange(configuration: ProviderConfiguration, code: string, flow: Flow): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: flow.redirectUri,
      code_verifier: flow.verifier,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    const methods = configuration.token_endpoint_auth_methods_supported;
    if (options.clientSecret === undefined) {
      body.set('client_id', options.clientId);
    } else if (methods?.includes('client_secret_post') && !methods.includes('client_secret_basic')) {
      body.set('client_id', options.clientId);
      body.set('client_secret', options.clientSecret);
    } else {
      // Basic, the default the specification names: each part form-encoded first.
      const credentials = `${formEncoded(options.clientId)}:${formEncoded(options.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(credentials).toString('base64')}`;
    }
    const response = await fetchFrom(configuration.token_endpoint, { method: 'POST', headers, body });
    const answer = (await response.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown };
    if (typeof answer.id_token !== 'string') {
      throw new Error(`it did not exchange the code: ${String(answer.error ?? `HTTP ${response.status}`)}`);
    }
    return answer.id_token;
  }

  async function logout(request: Request, url: URL): Promise<Response> {
    const ended = [cookie(SIGN_IN_COOKIE, '', '/', 0, secure(request, url))];
    let end: string | undefined;
    try {
      end = (await discover()).configuration.end_session_endpoint;
    } catch {
      // Signed out of the studio all the same.
    }
    if (!end) return page(200, 'You are signed out of the studio.', ended);
    const target = new URL(end);
    target.searchParams.set('client_id', options.clientId);
    return redirect(target.href, ended);
  }

  return {
    authenticate(request) {
      const session = unseal<{ user: StudioUser; exp: number }>('session', cookieOf(request, SIGN_IN_COOKIE));
      return session && session.exp > seconds() ? session.user : undefined;
    },
    async handle(request) {
      const url = new URL(request.url);
      const route = { '/auth/login': login, '/auth/callback': callback, '/auth/logout': logout }[url.pathname];
      if (!route) return undefined;
      try {
        return await route(request, url);
      } catch (error) {
        return page(502, `Signing in through the identity provider failed: ${(error as Error).message}.`, []);
      }
    },
  };
}

/** The page to come back to: a path on this studio, never another site. */
function returnPath(url: URL): string {
  let target: URL;
  try {
    target = new URL(url.searchParams.get('return') ?? '/', url);
  } catch {
    return '/';
  }
  if (target.origin !== url.origin) return '/';
  // A path that begins `//` would be read as another host.
  return `/${target.pathname.replace(/^\/+/, '')}${target.search}${target.hash}`;
}

function secure(request: Request, url: URL): boolean {
  return url.protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
}

/**
 * An HTTP-only cookie that travels on a link from another site, as the provider's redirect back is.
 * The studio adds its security headers, `cache-control: no-store` among them, to every response.
 */
function cookie(name: string, value: string, path: string, maxAge: number, isSecure: boolean): string {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAge}${isSecure ? '; Secure' : ''}`;
}

function cookieOf(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, value] = part.trim().split('=');
    if (key === name) return value;
  }
  return undefined;
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 303, headers });
}

function page(status: number, message: string, cookies: string[]): Response {
  const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8' });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(message, { status, headers });
}

/** Compares in constant time; anything but a string is no match. */
function same(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

function formEncoded(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}
