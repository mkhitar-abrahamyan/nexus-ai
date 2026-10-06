/**
 * Authentication for the agent server: JSON Web Tokens, API keys, and a trusted proxy.
 *
 * Each builds the `authenticate` hook of `createAgentServer()`, and each returns the same
 * `Principal`: a subject, a tenant, roles, and scopes. That principal is what scopes threads, runs,
 * budgets, and the store to a tenant, and what reaches every graph node, tool, and middleware of the
 * run. Everything is built on Web Crypto, so there is no dependency and it runs wherever `fetch` does.
 */
import type { webcrypto } from 'node:crypto';
import type { Principal } from '../types/principal.js';
import { assertTenantId } from '../utils/tenant.js';

// Types only: at run time this module uses the global Web Crypto, so it loads on any runtime.
type JsonWebKey = webcrypto.JsonWebKey;
type CryptoKey = webcrypto.CryptoKey;
type SubtleCrypto = webcrypto.SubtleCrypto;
type BufferSource = webcrypto.BufferSource;

/** The `authenticate` hook of `createAgentServer()`. */
export type AuthHook = (
  request: Request,
) => Promise<Principal | Response | undefined> | Principal | Response | undefined;

// ── JSON Web Tokens ─────────────────────────────────────────────────

/** The signature algorithms a token may use. `none` is never accepted. */
export type JwtAlgorithm =
  | 'HS256'
  | 'HS384'
  | 'HS512'
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'PS256'
  | 'PS384'
  | 'PS512'
  | 'ES256'
  | 'ES384'
  | 'ES512'
  | 'EdDSA';

/** A token's claims, the registered ones typed. */
export interface JwtPayload {
  /** The issuer. */
  iss?: string;
  /** The subject: who the token is about. */
  sub?: string;
  /** The audience: who the token is for. */
  aud?: string | string[];
  /** Expiry, in seconds since the epoch. */
  exp?: number;
  /** Not valid before, in seconds since the epoch. */
  nbf?: number;
  /** Issued at, in seconds since the epoch. */
  iat?: number;
  /** The token's id. */
  jti?: string;
  /** Every other claim. */
  [claim: string]: unknown;
}

/** A token's header. */
export interface JwtHeader {
  /** The signature algorithm. */
  alg: string;
  /** The id of the key that signed it, for choosing one from a key set. */
  kid?: string;
  /** The token type, usually `JWT`. */
  typ?: string;
  /** Any other header field. */
  [field: string]: unknown;
}

/** A verified token. */
export interface VerifiedJwt {
  /** Its header. */
  header: JwtHeader;
  /** Its claims, each checked. */
  payload: JwtPayload;
}

/** Why a token was refused. */
export type JwtErrorCode =
  | 'JWT_MALFORMED'
  | 'JWT_ALGORITHM'
  | 'JWT_KEY'
  | 'JWT_SIGNATURE'
  | 'JWT_EXPIRED'
  | 'JWT_NOT_YET_VALID'
  | 'JWT_TOO_OLD'
  | 'JWT_ISSUER'
  | 'JWT_AUDIENCE'
  | 'JWT_CLAIM';

/** Thrown when a token is refused: malformed, signed wrongly, expired, or for someone else. */
export class JwtError extends Error {
  constructor(
    /** Why. */
    readonly code: JwtErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JwtError';
  }
}

/** Options for `createJwtVerifier()`. Give it one key source: `secret`, `publicKey`, or `jwks`. */
export interface JwtVerifyOptions {
  /** A shared secret, for HS256, HS384, and HS512. */
  secret?: string | Uint8Array;
  /** One public key: PEM (`-----BEGIN PUBLIC KEY-----`), a JWK, or a `CryptoKey`. */
  publicKey?: string | JsonWebKey | CryptoKey;
  /**
   * The identity provider's key set: its URL, or the keys themselves. Fetched keys are cached, and
   * a token naming a key not yet seen fetches the set again, so a provider's key rotation needs no
   * restart.
   */
  jwks?: string | URL | { keys: JsonWebKey[] };
  /**
   * The algorithms accepted. Defaults to HS256, HS384, and HS512 for a secret and to every
   * asymmetric algorithm for a public key or a key set. A shared secret is never accepted for an
   * asymmetric algorithm, nor a public key for HMAC, so one cannot be passed off as the other.
   */
  algorithms?: readonly JwtAlgorithm[];
  /** The issuer a token must name: one, or any of several. */
  issuer?: string | readonly string[];
  /**
   * The audience a token must be for: one, or any of several. Required with `jwks`, where a
   * provider signs tokens for every application it serves; `false` accepts any audience,
   * deliberately.
   */
  audience?: string | readonly string[] | false;
  /** Seconds of clock difference tolerated on `exp`, `nbf`, and `iat`. Defaults to 60. */
  clockToleranceSec?: number;
  /** The oldest a token may be, from its `iat`, in seconds. */
  maxAgeSec?: number;
  /** Requires an `exp` claim. Defaults to true: a token that never expires is refused. */
  requireExpiry?: boolean;
  /** Claims a token must carry, besides `exp`. */
  requiredClaims?: readonly string[];
  /** How long a fetched key set is kept, in milliseconds. Defaults to 10 minutes. */
  jwksCacheMs?: number;
  /**
   * The least time between two fetches for keys not yet seen, in milliseconds, so tokens naming keys
   * that do not exist cannot make the server hammer the provider. Defaults to 30 seconds.
   */
  jwksCooldownMs?: number;
  /** Fetches the key set. Defaults to the global `fetch`. */
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** Replaces the clock, in milliseconds since the epoch, for tests. */
  now?: () => number;
}

/** A reusable verifier: it keeps imported keys and the fetched key set between tokens. */
export interface JwtVerifier {
  /** Verifies a token: its form, its signature, and its claims. Throws `JwtError` when it is refused. */
  verify(token: string): Promise<VerifiedJwt>;
}

const HMAC: readonly JwtAlgorithm[] = ['HS256', 'HS384', 'HS512'];
const ASYMMETRIC: readonly JwtAlgorithm[] = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
];

/** How Web Crypto imports a key for an algorithm, and how it verifies with it. */
type ImportParams = Parameters<SubtleCrypto['importKey']>[2];
type VerifyParams = Parameters<SubtleCrypto['verify']>[0];

function cryptoParams(alg: JwtAlgorithm): { importAs: ImportParams; verifyAs: VerifyParams } {
  const bits = alg.slice(2);
  const hash = `SHA-${bits === 'DSA' ? '512' : bits}`;
  switch (alg.slice(0, 2)) {
    case 'HS':
      return { importAs: { name: 'HMAC', hash }, verifyAs: { name: 'HMAC' } };
    case 'RS':
      return { importAs: { name: 'RSASSA-PKCS1-v1_5', hash }, verifyAs: { name: 'RSASSA-PKCS1-v1_5' } };
    case 'PS':
      return { importAs: { name: 'RSA-PSS', hash }, verifyAs: { name: 'RSA-PSS', saltLength: Number(bits) / 8 } };
    case 'ES': {
      const namedCurve = bits === '512' ? 'P-521' : `P-${bits}`;
      return { importAs: { name: 'ECDSA', namedCurve }, verifyAs: { name: 'ECDSA', hash } };
    }
    default:
      return { importAs: { name: 'Ed25519' }, verifyAs: { name: 'Ed25519' } };
  }
}

/** Whether a JWK can verify a token of this algorithm, by its key type and curve. */
function jwkFits(jwk: JsonWebKey & { kid?: string; alg?: string; use?: string }, alg: JwtAlgorithm): boolean {
  // `Ed25519` is the newer, fully specified name for EdDSA over that curve.
  if (jwk.alg && jwk.alg !== alg && !(alg === 'EdDSA' && jwk.alg === 'Ed25519')) return false;
  if (jwk.use && jwk.use !== 'sig') return false;
  if (jwk.key_ops && !jwk.key_ops.includes('verify')) return false;
  if (alg.startsWith('RS') || alg.startsWith('PS')) return jwk.kty === 'RSA';
  if (alg.startsWith('ES')) {
    const curve = alg === 'ES512' ? 'P-521' : `P-${alg.slice(2)}`;
    return jwk.kty === 'EC' && jwk.crv === curve;
  }
  if (alg === 'EdDSA') return jwk.kty === 'OKP' && jwk.crv === 'Ed25519';
  return false;
}

/**
 * Builds a verifier for tokens from one issuer.
 *
 * ```ts
 * const verifier = createJwtVerifier({
 *   jwks: 'https://login.example.com/.well-known/jwks.json',
 *   issuer: 'https://login.example.com/',
 *   audience: 'agents-api',
 * });
 * const { payload } = await verifier.verify(token);
 * ```
 */
export function createJwtVerifier(options: JwtVerifyOptions): JwtVerifier {
  const sources = [options.secret, options.publicKey, options.jwks].filter((source) => source !== undefined);
  if (sources.length !== 1) {
    throw new TypeError('createJwtVerifier() needs exactly one of secret, publicKey, or jwks');
  }
  if (options.jwks !== undefined && options.audience === undefined) {
    throw new TypeError(
      'A key set signs tokens for every application its provider serves: set audience, or audience: false to accept any',
    );
  }
  const allowed = new Set<JwtAlgorithm>(
    (options.algorithms ?? (options.secret !== undefined ? HMAC : ASYMMETRIC)).filter((alg) =>
      options.secret !== undefined ? HMAC.includes(alg) : ASYMMETRIC.includes(alg),
    ),
  );
  if (allowed.size === 0) throw new TypeError('None of the algorithms given can be used with this kind of key');

  const now = options.now ?? Date.now;
  const tolerance = options.clockToleranceSec ?? 60;
  const subtle = globalThis.crypto.subtle;
  const imported = new Map<string, Promise<CryptoKey>>();
  const importOnce = (cacheKey: string, load: () => Promise<CryptoKey>): Promise<CryptoKey> => {
    let key = imported.get(cacheKey);
    if (!key) {
      key = load();
      key.catch(() => imported.delete(cacheKey));
      imported.set(cacheKey, key);
    }
    return key;
  };

  // The key set, fetched lazily, refetched once the cache expires or when a token names a new key.
  let keySet: { keys: Array<JsonWebKey & { kid?: string }>; fetchedAt: number } | undefined =
    options.jwks !== undefined && typeof options.jwks === 'object' && !(options.jwks instanceof URL)
      ? { keys: options.jwks.keys, fetchedAt: Number.POSITIVE_INFINITY }
      : undefined;
  // Only a fetch for a key not yet seen is rate limited: a token naming a new key fetches at once, and
  // a stream of tokens naming keys that do not exist fetches at most once per cooldown.
  let lastUnknownFetch = Number.NEGATIVE_INFINITY;
  let inFlight: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    const fetcher = options.fetch ?? globalThis.fetch;
    inFlight = (async () => {
      const response = await fetcher(String(options.jwks), { headers: { accept: 'application/json' } });
      if (!response.ok) throw new JwtError('JWT_KEY', `The key set answered ${response.status}`);
      const body = (await response.json()) as { keys?: JsonWebKey[] };
      if (!Array.isArray(body.keys)) throw new JwtError('JWT_KEY', 'The key set has no keys');
      keySet = { keys: body.keys, fetchedAt: now() };
      imported.clear();
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };

  const keyFor = async (header: JwtHeader, alg: JwtAlgorithm): Promise<CryptoKey> => {
    const { importAs } = cryptoParams(alg);
    if (options.secret !== undefined) {
      const raw = typeof options.secret === 'string' ? new TextEncoder().encode(options.secret) : options.secret;
      return importOnce(`secret:${alg}`, () =>
        subtle.importKey('raw', raw as BufferSource, importAs, false, ['verify']),
      );
    }
    if (options.publicKey !== undefined) {
      const key = options.publicKey;
      if (typeof key === 'object' && 'type' in key && 'algorithm' in key) return key as CryptoKey;
      if (typeof key === 'string') {
        return importOnce(`pem:${alg}`, () => subtle.importKey('spki', pemToDer(key), importAs, false, ['verify']));
      }
      if (!jwkFits(key, alg)) throw new JwtError('JWT_KEY', `The key cannot verify ${alg}`);
      return importOnce(`jwk:${alg}`, () => subtle.importKey('jwk', key, importAs, false, ['verify']));
    }

    const remote = typeof options.jwks === 'string' || options.jwks instanceof URL;
    const cacheMs = options.jwksCacheMs ?? 10 * 60_000;
    if (remote && (!keySet || now() - keySet.fetchedAt > cacheMs)) await refresh();
    const find = () =>
      keySet?.keys.filter(
        (jwk) => (header.kid === undefined || (jwk as { kid?: string }).kid === header.kid) && jwkFits(jwk, alg),
      ) ?? [];
    let matches = find();
    if (matches.length === 0 && remote && now() - lastUnknownFetch >= (options.jwksCooldownMs ?? 30_000)) {
      lastUnknownFetch = now();
      await refresh();
      matches = find();
    }
    const [jwk] = matches;
    if (!jwk || (header.kid === undefined && matches.length > 1)) {
      throw new JwtError('JWT_KEY', header.kid ? `No key "${header.kid}" for ${alg}` : `No single key for ${alg}`);
    }
    return importOnce(`jwks:${(jwk as { kid?: string }).kid ?? ''}:${alg}`, () =>
      subtle.importKey('jwk', jwk, importAs, false, ['verify']),
    );
  };

  return {
    async verify(token: string): Promise<VerifiedJwt> {
      const parts = token.split('.');
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part)) || !parts[2]) {
        throw new JwtError('JWT_MALFORMED', 'The token is not a signed JWT');
      }
      const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
      const header = decodeJson<JwtHeader>(encodedHeader, 'header');
      const payload = decodeJson<JwtPayload>(encodedPayload, 'payload');
      if (typeof header.alg !== 'string' || !allowed.has(header.alg as JwtAlgorithm)) {
        throw new JwtError('JWT_ALGORITHM', `The algorithm "${String(header.alg)}" is not accepted`);
      }
      if (header.crit !== undefined)
        throw new JwtError('JWT_MALFORMED', 'The token has critical headers this verifier does not understand');
      const alg = header.alg as JwtAlgorithm;

      // A key that cannot be fetched or imported refuses the token; it is never a server error.
      const key = await keyFor(header, alg).catch((error: unknown) => {
        throw error instanceof JwtError ? error : new JwtError('JWT_KEY', `No usable key for ${alg}`);
      });
      const valid = await subtle
        .verify(
          cryptoParams(alg).verifyAs,
          key,
          base64UrlBytes(encodedSignature) as BufferSource,
          new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
        )
        .catch(() => false);
      if (!valid) throw new JwtError('JWT_SIGNATURE', 'The signature does not match');

      checkClaims(payload, options, now() / 1000, tolerance);
      return { header, payload };
    },
  };
}

function checkClaims(payload: JwtPayload, options: JwtVerifyOptions, seconds: number, tolerance: number): void {
  const numeric = (name: 'exp' | 'nbf' | 'iat') => {
    const value = payload[name];
    if (value !== undefined && typeof value !== 'number') throw new JwtError('JWT_CLAIM', `"${name}" is not a number`);
    return value;
  };
  const exp = numeric('exp');
  const nbf = numeric('nbf');
  const iat = numeric('iat');
  if (exp === undefined && options.requireExpiry !== false) throw new JwtError('JWT_CLAIM', 'The token has no expiry');
  if (exp !== undefined && seconds >= exp + tolerance) throw new JwtError('JWT_EXPIRED', 'The token has expired');
  if (nbf !== undefined && seconds + tolerance < nbf)
    throw new JwtError('JWT_NOT_YET_VALID', 'The token is not valid yet');
  if (options.maxAgeSec !== undefined) {
    if (iat === undefined) throw new JwtError('JWT_CLAIM', 'The token has no issue time');
    if (seconds - iat > options.maxAgeSec + tolerance) throw new JwtError('JWT_TOO_OLD', 'The token is too old');
  }
  if (options.issuer !== undefined) {
    const issuers = typeof options.issuer === 'string' ? [options.issuer] : options.issuer;
    if (typeof payload.iss !== 'string' || !issuers.includes(payload.iss)) {
      throw new JwtError('JWT_ISSUER', 'The token is from another issuer');
    }
  }
  if (options.audience !== undefined && options.audience !== false) {
    const wanted = typeof options.audience === 'string' ? [options.audience] : options.audience;
    const audiences = typeof payload.aud === 'string' ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud : [];
    if (!audiences.some((audience) => wanted.includes(audience))) {
      throw new JwtError('JWT_AUDIENCE', 'The token is for another audience');
    }
  }
  for (const claim of options.requiredClaims ?? []) {
    if (payload[claim] === undefined) throw new JwtError('JWT_CLAIM', `The token has no "${claim}" claim`);
  }
}

/** Which claims a principal is read from. A dot reaches into a nested claim: `realm_access.roles`. */
export interface JwtClaimNames {
  /** The subject. Defaults to `sub`. */
  subject?: string;
  /** The tenant. Defaults to `tenant_id`. */
  tenant?: string;
  /** The roles, as a list or a space-separated string. Defaults to `roles`. */
  roles?: string;
  /** The scopes, as a space-separated string or a list. Defaults to `scope`, then `scp`. */
  scopes?: string;
}

/** Options for `jwtAuth()`. */
export interface JwtAuthOptions extends JwtVerifyOptions {
  /** Reads the token from a request. Defaults to `Authorization: Bearer <token>`; a cookie works too. */
  token?: (request: Request) => string | undefined;
  /** Which claims the principal is read from. */
  claims?: JwtClaimNames;
  /**
   * Builds the principal from the verified claims instead, for a mapping of your own. Returning
   * nothing refuses the request with 403: the token is valid, but not for this server.
   */
  principal?: (payload: JwtPayload, request: Request) => Principal | undefined | Promise<Principal | undefined>;
}

/**
 * Authenticates requests by a JSON Web Token: an identity provider's, through its key set, or your
 * own, signed with a shared secret.
 *
 * A request with no token is passed over, so another hook in `anyAuth()` can try. A token that is
 * refused answers 401 with a `WWW-Authenticate` challenge naming why, and a valid one becomes a
 * `Principal`: its subject, tenant, roles, and scopes, with `method: 'jwt'` and the verified claims.
 *
 * ```ts
 * createAgentServer({
 *   assistants,
 *   authenticate: jwtAuth({
 *     jwks: 'https://login.example.com/.well-known/jwks.json',
 *     issuer: 'https://login.example.com/',
 *     audience: 'agents-api',
 *     claims: { tenant: 'org_id', roles: 'realm_access.roles' },
 *   }),
 * });
 * ```
 */
export function jwtAuth(options: JwtAuthOptions): AuthHook {
  const verifier = createJwtVerifier(options);
  const read = options.token ?? bearerToken;
  return async (request) => {
    const token = read(request);
    if (token?.split('.').length !== 3) return undefined;
    let payload: JwtPayload;
    try {
      payload = (await verifier.verify(token)).payload;
    } catch (error) {
      if (!(error instanceof JwtError)) throw error;
      const description = error.message.replace(/["\\]/g, "'");
      return refuse(401, error.message, `Bearer error="invalid_token", error_description="${description}"`);
    }
    try {
      const principal = options.principal
        ? await options.principal(payload, request)
        : principalFromClaims(payload, options.claims);
      if (!principal) return refuse(403, 'The token is valid, but not for this server');
      return { method: 'jwt', claims: payload, ...principal };
    } catch (error) {
      return refuse(403, error instanceof Error ? error.message : String(error));
    }
  };
}

/** The principal a token's claims describe, read from the claims `names` gives. */
function principalFromClaims(payload: JwtPayload, names: JwtClaimNames = {}): Principal {
  const subject = claimAt(payload, names.subject ?? 'sub');
  const tenant = claimAt(payload, names.tenant ?? 'tenant_id');
  const roles = listOf(claimAt(payload, names.roles ?? 'roles'));
  const scopes = listOf(names.scopes ? claimAt(payload, names.scopes) : (payload.scope ?? payload.scp));
  return {
    ...(typeof subject === 'string' ? { userId: subject } : {}),
    // A tenant id is a scope boundary, so one the tenant rule refuses fails the request.
    ...(typeof tenant === 'string' ? { tenantId: assertTenantId(tenant) } : {}),
    ...(roles ? { roles } : {}),
    ...(scopes ? { scopes } : {}),
  };
}

// ── API keys ────────────────────────────────────────────────────────

/** Options for `apiKeyAuth()`. Give it `keys`, `lookup`, or both. */
export interface ApiKeyAuthOptions {
  /**
   * Keys by their SHA-256 hash, from `hashApiKey()`, each with the principal it stands for. The keys
   * themselves are never written into configuration.
   */
  keys?: Readonly<Record<string, Principal>>;
  /** Looks a key up by its hash, in a database or a secret store, when `keys` does not have it. */
  lookup?: (hash: string, request: Request) => Principal | undefined | Promise<Principal | undefined>;
  /** The header the key is read from. Defaults to `x-api-key`, then `Authorization: Bearer`. */
  header?: string;
  /**
   * Only a credential with this prefix is taken for a key, such as `nxk_`, so a token in the same
   * header is left to another hook. Without it, anything shaped like a JWT is left alone.
   */
  prefix?: string;
}

/** The SHA-256 of an API key, as hex: what `apiKeyAuth({ keys })` is configured with. */
export async function hashApiKey(key: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Authenticates requests by an API key, for services and scripts rather than people.
 *
 * Keys are compared by their hash, so configuration and the database hold hashes only. A request
 * with no key is passed over; an unknown key answers 401. The principal is the one the key maps to,
 * with `method: 'api-key'`.
 *
 * ```ts
 * apiKeyAuth({ keys: { [await hashApiKey(process.env.CI_KEY)]: { userId: 'ci', tenantId: 'acme', scopes: ['write'] } } })
 * ```
 */
export function apiKeyAuth(options: ApiKeyAuthOptions): AuthHook {
  if (!options.keys && !options.lookup) throw new TypeError('apiKeyAuth() needs keys, a lookup, or both');
  const header = options.header?.toLowerCase();
  return async (request) => {
    const key = header
      ? (request.headers.get(header) ?? undefined)
      : (request.headers.get('x-api-key') ?? bearerToken(request));
    if (!key) return undefined;
    if (options.prefix ? !key.startsWith(options.prefix) : /^[\w-]+\.[\w-]+\.[\w-]+$/.test(key)) return undefined;
    const hash = await hashApiKey(key);
    const known = Object.hasOwn(options.keys ?? {}, hash) ? options.keys?.[hash] : undefined;
    const principal = known ?? (await options.lookup?.(hash, request));
    if (!principal) return refuse(401, 'The API key is not valid', 'Bearer error="invalid_token"');
    if (principal.tenantId !== undefined) assertTenantId(principal.tenantId);
    return { method: 'api-key', ...principal };
  };
}

// ── A trusted proxy ─────────────────────────────────────────────────

/** The headers a proxy names the caller in. */
export interface TrustedProxyHeaders {
  /** The user. Defaults to `x-forwarded-user`. */
  user?: string;
  /** The tenant. Defaults to `x-forwarded-tenant`. */
  tenant?: string;
  /** The roles. Defaults to `x-forwarded-roles`. */
  roles?: string;
  /** The scopes. Defaults to `x-forwarded-scopes`. */
  scopes?: string;
}

/** Options for `trustedProxyAuth()`. Give it `secret`, `trust`, or both. */
export interface TrustedProxyAuthOptions {
  /** A header the proxy sets to a shared secret, which proves the request came through it. */
  secret?: { header: string; value: string };
  /** Decides whether a request came through the proxy, by a check of your own. */
  trust?: (request: Request) => boolean | Promise<boolean>;
  /** The headers the caller is named in. */
  headers?: TrustedProxyHeaders;
  /** What separates several roles or scopes in one header. Defaults to a comma; spaces are trimmed. */
  separator?: string;
}

/**
 * Takes the caller from headers an authenticating proxy sets: an identity-aware proxy, an API
 * gateway, a service mesh.
 *
 * Headers are only as trustworthy as the path a request took, so this refuses to exist without a
 * proof that the proxy sent the request: a shared secret it adds, a check of your own, or both. A
 * request without that proof, or without a user, is passed over. The principal carries
 * `method: 'proxy'`.
 */
export function trustedProxyAuth(options: TrustedProxyAuthOptions): AuthHook {
  if (!options.secret && !options.trust) {
    throw new TypeError(
      'trustedProxyAuth() needs a secret or a trust check: otherwise anyone who sets the headers is trusted',
    );
  }
  const names = {
    user: 'x-forwarded-user',
    tenant: 'x-forwarded-tenant',
    roles: 'x-forwarded-roles',
    scopes: 'x-forwarded-scopes',
    ...options.headers,
  };
  const separator = options.separator ?? ',';
  const list = (value: string | null) =>
    value
      ?.split(separator)
      .map((item) => item.trim())
      .filter(Boolean);
  return async (request) => {
    if (options.secret && !sameText(request.headers.get(options.secret.header) ?? '', options.secret.value)) {
      return undefined;
    }
    if (options.trust && !(await options.trust(request))) return undefined;
    const user = request.headers.get(names.user);
    if (!user) return undefined;
    const tenant = request.headers.get(names.tenant);
    if (tenant && !/^[A-Za-z0-9_-]{1,128}$/.test(tenant)) return refuse(403, `"${tenant}" is not a valid tenant id`);
    const roles = list(request.headers.get(names.roles));
    const scopes = list(request.headers.get(names.scopes));
    return {
      method: 'proxy',
      userId: user,
      ...(tenant ? { tenantId: tenant } : {}),
      ...(roles?.length ? { roles } : {}),
      ...(scopes?.length ? { scopes } : {}),
    };
  };
}

// ── Several at once ─────────────────────────────────────────────────

/**
 * Tries hooks in order and takes the first principal: tokens for people and keys for services on
 * one server. When none accepts the request, the first refusal any of them gave is the answer, so a
 * caller learns why their credential was refused.
 *
 * ```ts
 * authenticate: anyAuth(jwtAuth({ ... }), apiKeyAuth({ ... }))
 * ```
 */
export function anyAuth(...hooks: AuthHook[]): AuthHook {
  return async (request) => {
    let refusal: Response | undefined;
    for (const hook of hooks) {
      const result = await hook(request);
      if (result instanceof Response) refusal ??= result;
      else if (result) return result;
    }
    return refusal;
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

/** The token of an `Authorization: Bearer` header. */
function bearerToken(request: Request): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get('authorization') ?? '');
  return match?.[1];
}

/** A refusal shaped as the server's own errors are, with a challenge when there is one. */
function refuse(status: 401 | 403, message: string, challenge?: string): Response {
  return new Response(JSON.stringify({ error: { code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message } }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(challenge ? { 'www-authenticate': challenge } : {}),
    },
  });
}

/** Compares two texts in time that depends only on their lengths, never on where they differ. */
function sameText(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function base64UrlBytes(text: string): Uint8Array {
  const base64 = text
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJson<T>(part: string, what: string): T {
  try {
    const value = JSON.parse(new TextDecoder().decode(base64UrlBytes(part)));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as T;
  } catch {
    // Reported below.
  }
  throw new JwtError('JWT_MALFORMED', `The token's ${what} is not a JSON object`);
}

function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----(?:BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
  if (!body || pem.includes('PRIVATE KEY')) throw new JwtError('JWT_KEY', 'The public key is not a PEM public key');
  return base64UrlBytes(body.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')).buffer as ArrayBuffer;
}

function claimAt(payload: JwtPayload, path: string): unknown {
  if (path in payload) return payload[path];
  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function listOf(value: unknown): string[] | undefined {
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return undefined;
}
