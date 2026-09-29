import { randomBytes, timingSafeEqual } from 'node:crypto';

/** The cookie the studio sets once a valid token has been presented, so the token leaves the URL. */
export const SESSION_COOKIE = 'nexus_studio';
/** The header scripts send the token in. Required for every change, which is what defeats CSRF. */
export const TOKEN_HEADER = 'x-studio-token';

/** A random access token: 32 bytes, URL-safe. */
export function createToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Compares two tokens in constant time, so a wrong guess reveals nothing about the right one. */
export function tokensMatch(expected: string, provided: string | null | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The token a request carries: in the studio header or an `Authorization: Bearer` header, the session
 * cookie, or the `token` query parameter.
 */
export function tokenOf(
  request: Request,
  url: URL,
): { token: string | undefined; via: 'header' | 'cookie' | 'query' | undefined } {
  return tokensOf(request, url)[0] ?? { token: undefined, via: undefined };
}

/**
 * Every token a request carries, in the order `tokenOf()` prefers them. With accounts, a page sends its
 * page token in the header and its personal token in the cookie, so both are looked at.
 */
export function tokensOf(request: Request, url: URL): Array<{ token: string; via: 'header' | 'cookie' | 'query' }> {
  const found: Array<{ token: string; via: 'header' | 'cookie' | 'query' }> = [];
  const header = request.headers.get(TOKEN_HEADER);
  if (header) found.push({ token: header, via: 'header' });
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '');
  if (bearer) found.push({ token: bearer[1] as string, via: 'header' });
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (cookie) found.push({ token: decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1)), via: 'cookie' });
  const query = url.searchParams.get('token');
  if (query) found.push({ token: query, via: 'query' });
  return found;
}

/**
 * Whether a request's Host is one the studio answers to.
 *
 * A page on another site can make the browser send requests to `127.0.0.1` by pointing its own
 * domain at it — DNS rebinding — and the request then carries that domain in its Host header. Refusing
 * every host but the loopback names closes that door, whatever the token check does.
 */
export function hostAllowed(host: string | null, allowed: readonly string[] = []): boolean {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return ['localhost', '127.0.0.1', '[::1]', ...allowed].includes(name ?? '');
}

/**
 * The session cookie for a token: HTTP-only and same-site, so neither a script nor another site reads
 * it, and `Secure` when the studio is reached over HTTPS, so it never travels in the clear.
 */
export function sessionCookie(token: string, secure = false): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`;
}
