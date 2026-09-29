import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { tokensOf } from './security.js';

/**
 * What a person may do, each role including the ones before it: a `viewer` reads; a `reviewer` also
 * answers interrupts, submits reviews, leaves feedback, and comments; an `editor` also edits and forks
 * threads, runs the playground, and rejects proposals; an `admin` also promotes and rolls back prompts,
 * bundles, and proposals, and reads the audit log.
 */
export type StudioRole = 'viewer' | 'reviewer' | 'editor' | 'admin';

/** The roles, least to most. */
export const STUDIO_ROLES: readonly StudioRole[] = ['viewer', 'reviewer', 'editor', 'admin'];

/** Who is using the studio. Actions are recorded under `id`. */
export interface StudioUser {
  /** A stable id, such as an email address or an identity provider's subject. */
  id: string;
  /** A display name. */
  name?: string;
  /** An email address. */
  email?: string;
  /** What they may do. */
  role: StudioRole;
}

/** What the server knows about a request beyond the request itself. */
export interface StudioRequestInfo {
  /** The address the connection came from, for trusting a reverse proxy by address. */
  remoteAddress?: string;
}

/**
 * Decides who a request is from: a `StudioUser`, or `undefined` when it carries no identity the
 * studio accepts. `personalTokens()`, `headerAuth()`, `bearerAuth()`, and `anyOf()` build one; any
 * function of the same shape works.
 */
export type StudioAuthenticator = (
  request: Request,
  info: StudioRequestInfo,
) => Promise<StudioUser | undefined> | StudioUser | undefined;

/** Whether a user's role includes another. */
export function hasRole(user: StudioUser | undefined, role: StudioRole): boolean {
  return user !== undefined && STUDIO_ROLES.indexOf(user.role) >= STUDIO_ROLES.indexOf(role);
}

/**
 * One access token per person, for a small team without an identity provider. Each person opens the
 * studio with their own link, `?token=…`, which is moved into a cookie as the single token is, and
 * everything they do is recorded under their id. Tokens are compared in constant time.
 */
export function personalTokens(users: ReadonlyArray<StudioUser & { token: string }>): StudioAuthenticator {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const known = users.map((user) => {
    if (!user.token || user.token.length < 16)
      throw new RangeError(`The token for "${user.id}" must be at least 16 characters`);
    if (!STUDIO_ROLES.includes(user.role)) throw new RangeError(`"${user.role}" is not a studio role`);
    const { token, ...identity } = user;
    return { digest: digest(token), identity };
  });
  return (request) => {
    let found: StudioUser | undefined;
    for (const { token } of tokensOf(request, new URL(request.url))) {
      const presented = digest(token);
      for (const entry of known) if (timingSafeEqual(entry.digest, presented)) found ??= entry.identity;
    }
    return found;
  };
}

/** Options for `headerAuth()`. */
export interface HeaderAuthOptions {
  /** The header holding the user's id. Defaults to `x-forwarded-user`. */
  user?: string;
  /** The header holding the email address. Defaults to `x-forwarded-email`. */
  email?: string;
  /** The header holding a display name. */
  name?: string;
  /** The header holding groups, comma-separated. Defaults to `x-forwarded-groups`. */
  groups?: string;
  /** A user's role from their identity, such as by group. Returning `undefined` refuses the user. */
  role?: (identity: { user: string; email?: string; groups: string[] }) => StudioRole | undefined;
  /** The role of a user `role` does not decide, when it is not given. Defaults to `viewer`. */
  defaultRole?: StudioRole;
  /**
   * A header only your proxy sets, and the value it sets, so a request that bypassed the proxy cannot
   * claim an identity. Give this or `trustedProxies`.
   */
  secret?: { header: string; value: string };
  /** The addresses your proxy connects from. Give this or `secret`. */
  trustedProxies?: readonly string[];
}

/**
 * Identity from a reverse proxy that signs people in — an OIDC proxy, an identity-aware proxy, or an
 * access gateway — through the headers it sets. Headers are trusted only from the proxy: a request
 * must carry the proxy's secret header, or come from a trusted address.
 */
export function headerAuth(options: HeaderAuthOptions): StudioAuthenticator {
  if (!options.secret && !options.trustedProxies?.length) {
    throw new RangeError('headerAuth() needs a secret header or trusted proxy addresses, or anyone could claim a name');
  }
  const userHeader = options.user ?? 'x-forwarded-user';
  const emailHeader = options.email ?? 'x-forwarded-email';
  const groupsHeader = options.groups ?? 'x-forwarded-groups';
  const secret = options.secret && createHash('sha256').update(options.secret.value).digest();
  return (request, info) => {
    if (secret && options.secret) {
      const presented = request.headers.get(options.secret.header);
      if (!presented || !timingSafeEqual(createHash('sha256').update(presented).digest(), secret)) return undefined;
    }
    if (options.trustedProxies?.length && !options.trustedProxies.includes(normalizeAddress(info.remoteAddress))) {
      return undefined;
    }
    const user = request.headers.get(userHeader)?.trim();
    if (!user) return undefined;
    const email = request.headers.get(emailHeader)?.trim() || undefined;
    const groups = (request.headers.get(groupsHeader) ?? '')
      .split(',')
      .map((group) => group.trim())
      .filter(Boolean);
    const role = options.role
      ? options.role({ user, ...(email ? { email } : {}), groups })
      : (options.defaultRole ?? 'viewer');
    if (!role) return undefined;
    const name = options.name ? request.headers.get(options.name)?.trim() : undefined;
    return { id: user, role, ...(email ? { email } : {}), ...(name ? { name } : {}) };
  };
}

/** Options for `bearerAuth()`. */
export interface BearerAuthOptions {
  /**
   * Checks a bearer token and returns its claims, or `undefined` when it is not valid — for an OIDC
   * token, a JWT verification against the issuer's keys, such as `jose`'s `jwtVerify()`.
   */
  verify: (token: string) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;
  /** A user's role from the token's claims. Returning `undefined` refuses the token. */
  role: (claims: Record<string, unknown>) => StudioRole | undefined;
  /** The user's id from the claims. Defaults to `sub`. */
  id?: (claims: Record<string, unknown>) => string | undefined;
}

/**
 * Identity from an `Authorization: Bearer` token, verified by the function you pass: an OIDC access or
 * ID token, or your own. For scripts and services calling the studio's API; people in a browser come
 * through `headerAuth()` behind a proxy, or `personalTokens()`.
 */
export function bearerAuth(options: BearerAuthOptions): StudioAuthenticator {
  return async (request) => {
    const header = request.headers.get('authorization');
    const match = header && /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return undefined;
    let claims: Record<string, unknown> | undefined;
    try {
      claims = await options.verify(match[1] as string);
    } catch {
      return undefined;
    }
    if (!claims) return undefined;
    const id = options.id ? options.id(claims) : typeof claims.sub === 'string' ? claims.sub : undefined;
    const role = options.role(claims);
    if (!id || !role) return undefined;
    return {
      id,
      role,
      ...(typeof claims.email === 'string' ? { email: claims.email } : {}),
      ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
    };
  };
}

/** The first identity any of several authenticators finds, such as bearer tokens for scripts and a proxy for people. */
export function anyOf(...authenticators: StudioAuthenticator[]): StudioAuthenticator {
  return async (request, info) => {
    for (const authenticate of authenticators) {
      const user = await authenticate(request, info);
      if (user) return user;
    }
    return undefined;
  };
}

/**
 * The token a user's page sends with every change, derived from a server secret and the user's id. A
 * page on another site can neither read it nor set the header it travels in, which is what stops a
 * signed-in person's browser from being used against the studio.
 */
export function csrfToken(secret: string, user: StudioUser): string {
  return createHmac('sha256', secret).update(`${user.id}\u0000${user.role}`).digest('base64url');
}

function normalizeAddress(address: string | undefined): string {
  if (!address) return '';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}
