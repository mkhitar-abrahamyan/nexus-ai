/**
 * Authentication for the agent server: JSON Web Tokens, API keys, sessions, and a trusted proxy.
 *
 * Each builds the `authenticate` hook of `createAgentServer()`, and each returns the same
 * `Principal`: a subject, a tenant, roles, and scopes. That principal is what scopes threads, runs,
 * budgets, and the store to a tenant, and what reaches every graph node, tool, and middleware of the
 * run. The application issues its own tokens with `createJwtSigner()`, keeps its own keys with
 * `createApiKeyStore()`, and signs browsers in with `createSessions()`. Everything is built on Web
 * Crypto, so there is no dependency and it runs wherever `fetch` does.
 */
import type { webcrypto } from 'node:crypto';
import type { Principal } from '../types/principal.js';
import type { ServerStateStore } from '../types/server.js';
import { assertTenantId } from '../utils/tenant.js';
import { MemoryServerStore } from './state.js';

// Types only: at run time this module uses the global Web Crypto, so it loads on any runtime.
type JsonWebKey = webcrypto.JsonWebKey;
type CryptoKey = webcrypto.CryptoKey;
type SubtleCrypto = webcrypto.SubtleCrypto;
type BufferSource = webcrypto.BufferSource;
type CryptoKeyPair = webcrypto.CryptoKeyPair;

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
  return keyTypeFits(jwk, alg);
}

/** Whether a JWK's key type and curve are an algorithm's. */
function keyTypeFits(jwk: JsonWebKey, alg: JwtAlgorithm): boolean {
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

// ── Issuing tokens ──────────────────────────────────────────────────

/** Options for `createJwtSigner()`. Give it one key: `secret`, `privateKey`, or `keyPair`. */
export interface JwtSignerOptions {
  /** A shared secret, for HS256, HS384, and HS512, which `jwtAuth({ secret })` verifies with. At least 32 bytes. */
  secret?: string | Uint8Array;
  /** A private key: PEM (`-----BEGIN PRIVATE KEY-----`, PKCS #8), or a private JWK, as `generateJwtKey()` makes one. */
  privateKey?: string | JsonWebKey;
  /** A Web Crypto key pair, as `crypto.subtle.generateKey()` makes one, its public key extractable. */
  keyPair?: { privateKey: CryptoKey; publicKey: CryptoKey };
  /**
   * The algorithm. Defaults to HS256 for a secret, and to the key's own for a JWK or a key pair: its
   * `alg`, or RS256 for RSA, ES256, ES384, or ES512 by curve, and EdDSA for Ed25519. A PEM key names it.
   */
  algorithm?: JwtAlgorithm;
  /** The key's id, in each token's header and the key set. Defaults to the public key's RFC 7638 thumbprint; a secret has none. */
  kid?: string;
  /** The issuer every token names. */
  issuer?: string;
  /** The audience every token is for, unless one is issued for another. */
  audience?: string | readonly string[];
  /** How long a token lasts, in seconds, unless one is issued for longer or shorter. Defaults to an hour. */
  expiresInSec?: number;
  /** Replaces the clock, in milliseconds since the epoch, for tests. */
  now?: () => number;
}

/** What one token is issued with, over the signer's own. */
export interface JwtSignOptions {
  /** How long it lasts, in seconds. */
  expiresInSec?: number;
  /** Who it is for. */
  audience?: string | readonly string[];
  /** Seconds from now before which it is not valid. */
  notBeforeSec?: number;
}

/** Issues tokens with one key, which `jwtAuth()`, `createJwtVerifier()`, and any other verifier read. */
export interface JwtSigner {
  /** The algorithm it signs with. */
  readonly algorithm: JwtAlgorithm;
  /**
   * Signs claims into a token: the signer's issuer and audience, `iat`, `exp`, and a `jti` of its own,
   * then the claims given, which win.
   */
  sign(claims?: JwtPayload, options?: JwtSignOptions): Promise<string>;
  /**
   * A token for a principal: its user as `sub`, its tenant, roles, and scopes, under the claim names
   * `jwtAuth()` reads them from, so the same `claims` names read it back.
   */
  issue(principal: Principal, options?: JwtSignOptions & { claims?: JwtClaimNames }): Promise<string>;
  /** The public key, as a JWK with its `kid`, `alg`, and `use`, for a key set; none for a secret. */
  publicKey(): Promise<JsonWebKey | undefined>;
}

/**
 * Builds a signer, to issue tokens of your own: for a service, after a sign-in, or for a test.
 *
 * ```ts
 * const signer = createJwtSigner({ privateKey: JSON.parse(process.env.JWT_KEY ?? ''), issuer: 'https://agents.example.com' });
 * const token = await signer.issue({ userId: 'ana', tenantId: 'acme', scopes: ['read'] }, { audience: 'agents-api' });
 * ```
 */
export function createJwtSigner(options: JwtSignerOptions): JwtSigner {
  const sources = [options.secret, options.privateKey, options.keyPair].filter((source) => source !== undefined);
  if (sources.length !== 1) {
    throw new TypeError('createJwtSigner() needs exactly one of secret, privateKey, or keyPair');
  }
  if (typeof options.privateKey === 'string' && !options.privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new TypeError('The private key is not a PKCS #8 PEM key, beginning -----BEGIN PRIVATE KEY-----');
  }
  const algorithm = options.algorithm ?? signingAlgorithm(options);
  if (HMAC.includes(algorithm) !== (options.secret !== undefined)) {
    throw new TypeError(
      options.secret !== undefined
        ? `A secret signs HS256, HS384, or HS512, not ${algorithm}`
        : `${algorithm} is signed with a secret, not a private key`,
    );
  }
  if (options.secret !== undefined) {
    const raw = typeof options.secret === 'string' ? new TextEncoder().encode(options.secret) : options.secret;
    if (raw.byteLength < 32)
      throw new TypeError('A secret that signs tokens is at least 32 bytes, or it can be guessed');
  }
  if (typeof options.privateKey === 'object' && typeof options.privateKey.d !== 'string') {
    throw new TypeError('The JWK is a public key: a signer needs the private one');
  }
  const named = typeof options.privateKey === 'object' ? (options.privateKey as { alg?: string }).alg : undefined;
  if (named !== undefined && named !== algorithm && !(algorithm === 'EdDSA' && named === 'Ed25519')) {
    throw new TypeError(`The JWK is for ${named}, not ${algorithm}`);
  }
  if (typeof options.privateKey === 'object' && !keyTypeFits(options.privateKey, algorithm)) {
    throw new TypeError(`The JWK cannot sign ${algorithm}`);
  }
  const subtle = globalThis.crypto.subtle;
  const now = options.now ?? Date.now;
  const { importAs, verifyAs } = cryptoParams(algorithm);
  // The key is imported once, when the first token is signed.
  let loaded: Promise<{ key: CryptoKey; jwk?: JsonWebKey; kid?: string }> | undefined;
  const load = () => {
    loaded ??= (async () => {
      if (options.secret !== undefined) {
        const raw = typeof options.secret === 'string' ? new TextEncoder().encode(options.secret) : options.secret;
        const key = await subtle.importKey('raw', raw as BufferSource, importAs, false, ['sign']);
        return { key, ...(options.kid !== undefined ? { kid: options.kid } : {}) };
      }
      let key: CryptoKey;
      let jwk: JsonWebKey;
      if (options.keyPair) {
        key = options.keyPair.privateKey;
        jwk = publicPart(await subtle.exportKey('jwk', options.keyPair.publicKey));
      } else if (typeof options.privateKey === 'string') {
        // Imported once to read its public half, then again as a key that can only sign.
        const der = pemToDer(options.privateKey, 'PRIVATE KEY');
        jwk = publicPart(await subtle.exportKey('jwk', await subtle.importKey('pkcs8', der, importAs, true, ['sign'])));
        key = await subtle.importKey('pkcs8', der, importAs, false, ['sign']);
      } else {
        const { key_ops: _ops, use: _use, ext: _ext, alg: _alg, ...given } = options.privateKey as JsonWebKey;
        key = await subtle.importKey('jwk', given, importAs, false, ['sign']);
        jwk = publicPart(given);
      }
      const kid = options.kid ?? (await thumbprint(jwk));
      return { key, kid, jwk: { ...jwk, kid, alg: algorithm, use: 'sig' } as JsonWebKey };
    })();
    return loaded;
  };
  const signer: JwtSigner = {
    algorithm,
    async sign(claims = {}, signOptions = {}) {
      const { key, kid } = await load();
      const issuedAt = Math.floor(now() / 1000);
      const audience = signOptions.audience ?? options.audience;
      const payload: JwtPayload = {
        ...(options.issuer !== undefined ? { iss: options.issuer } : {}),
        ...(audience !== undefined ? { aud: typeof audience === 'string' ? audience : [...audience] } : {}),
        iat: issuedAt,
        ...(signOptions.notBeforeSec !== undefined ? { nbf: issuedAt + signOptions.notBeforeSec } : {}),
        exp: issuedAt + (signOptions.expiresInSec ?? options.expiresInSec ?? 3_600),
        jti: globalThis.crypto.randomUUID(),
        ...claims,
      };
      const header: JwtHeader = { alg: algorithm, typ: 'JWT', ...(kid !== undefined ? { kid } : {}) };
      const input = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
      const signature = await subtle.sign(verifyAs, key, new TextEncoder().encode(input));
      return `${input}.${base64UrlText(new Uint8Array(signature))}`;
    },
    async issue(principal, issueOptions = {}) {
      const { claims: names, ...signOptions } = issueOptions;
      return signer.sign(claimsFromPrincipal(principal, names), signOptions);
    },
    async publicKey() {
      return (await load()).jwk;
    },
  };
  return signer;
}

/**
 * A new private key for `createJwtSigner()`, as a JWK with its `kid`, `alg`, and `use`: keep it in a
 * secret store, and the signer publishes its public half. Defaults to ES256.
 */
export async function generateJwtKey(
  algorithm: Exclude<JwtAlgorithm, 'HS256' | 'HS384' | 'HS512'> = 'ES256',
): Promise<JsonWebKey & { kid: string; alg: string }> {
  if (!ASYMMETRIC.includes(algorithm)) throw new TypeError(`${algorithm} is not a key pair's algorithm`);
  const { importAs } = cryptoParams(algorithm);
  const rsa = algorithm.startsWith('RS') || algorithm.startsWith('PS');
  const pair = (await globalThis.crypto.subtle.generateKey(
    (rsa
      ? {
          ...(importAs as webcrypto.RsaHashedImportParams),
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
        }
      : importAs) as webcrypto.Algorithm,
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const { key_ops: _ops, ext: _ext, ...jwk } = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);
  return { ...jwk, kid: await thumbprint(publicPart(jwk)), alg: algorithm, use: 'sig' };
}

/**
 * Serves signers' public keys as a JSON Web Key Set, at the URL `jwtAuth({ jwks })` and other services
 * read. Give it the signer in use and those whose tokens may still be live, so a key rotation never
 * refuses a token signed before it.
 *
 * ```ts
 * if (new URL(request.url).pathname === '/.well-known/jwks.json') return jwks(request);
 * ```
 */
export function jwksHandler(...signers: JwtSigner[]): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const keys = (await Promise.all(signers.map((signer) => signer.publicKey()))).filter(
      (key): key is JsonWebKey => key !== undefined,
    );
    return new Response(request.method === 'HEAD' ? null : JSON.stringify({ keys }), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
    });
  };
}

/** The algorithm a key signs with when none is named. */
function signingAlgorithm(options: JwtSignerOptions): JwtAlgorithm {
  if (options.secret !== undefined) return 'HS256';
  if (typeof options.privateKey === 'string') {
    throw new TypeError('A PEM key does not say what it signs: set algorithm');
  }
  if (options.privateKey) {
    const jwk = options.privateKey as JsonWebKey & { alg?: string };
    if (jwk.alg === 'Ed25519') return 'EdDSA';
    if (jwk.alg !== undefined) {
      if (!ASYMMETRIC.includes(jwk.alg as JwtAlgorithm))
        throw new TypeError(`The JWK's algorithm ${jwk.alg} is not one a signer uses`);
      return jwk.alg as JwtAlgorithm;
    }
    return algorithmOfKey(jwk.kty, jwk.crv, 'SHA-256', false);
  }
  const algorithm = options.keyPair?.privateKey.algorithm as {
    name: string;
    namedCurve?: string;
    hash?: { name: string };
  };
  return algorithmOfKey(
    algorithm.name === 'ECDSA' ? 'EC' : algorithm.name === 'Ed25519' ? 'OKP' : 'RSA',
    algorithm.name === 'Ed25519' ? 'Ed25519' : algorithm.namedCurve,
    algorithm.hash?.name ?? 'SHA-256',
    algorithm.name === 'RSA-PSS',
  );
}

function algorithmOfKey(kty: string | undefined, crv: string | undefined, hash: string, pss: boolean): JwtAlgorithm {
  if (kty === 'RSA') return `${pss ? 'PS' : 'RS'}${hash.replace('SHA-', '')}` as JwtAlgorithm;
  if (kty === 'EC' && (crv === 'P-256' || crv === 'P-384')) return `ES${crv.slice(2)}` as JwtAlgorithm;
  if (kty === 'EC' && crv === 'P-521') return 'ES512';
  if (kty === 'OKP' && crv === 'Ed25519') return 'EdDSA';
  throw new TypeError(`A ${kty ?? 'key'}${crv ? ` on ${crv}` : ''} key signs no algorithm a token uses: set algorithm`);
}

/** A JWK's public members alone. */
function publicPart(jwk: JsonWebKey): JsonWebKey {
  if (jwk.kty === 'RSA') return { kty: 'RSA', n: jwk.n, e: jwk.e } as JsonWebKey;
  if (jwk.kty === 'EC') return { kty: 'EC', crv: jwk.crv, x: jwk.x, y: jwk.y } as JsonWebKey;
  return { kty: jwk.kty, crv: jwk.crv, x: jwk.x } as JsonWebKey;
}

/** A public JWK's RFC 7638 thumbprint: the SHA-256 of its required members, in order, as base64url. */
async function thumbprint(jwk: JsonWebKey): Promise<string> {
  const members =
    jwk.kty === 'RSA'
      ? { e: jwk.e, kty: jwk.kty, n: jwk.n }
      : jwk.kty === 'EC'
        ? { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
        : { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(members)));
  return base64UrlText(new Uint8Array(digest));
}

/** The claims a principal is issued as, under the names `jwtAuth()` reads them from. */
function claimsFromPrincipal(principal: Principal, names: JwtClaimNames = {}): JwtPayload {
  const claims: JwtPayload = {};
  const set = (path: string, value: unknown) => {
    const segments = path.split('.');
    if (segments.some((segment) => segment === '__proto__' || segment === 'constructor' || segment === 'prototype')) {
      throw new TypeError(`"${path}" is not a claim name`);
    }
    let target: Record<string, unknown> = claims;
    for (const segment of segments.slice(0, -1)) {
      const next = target[segment];
      const nested = (next && typeof next === 'object' ? next : {}) as Record<string, unknown>;
      target[segment] = nested;
      target = nested;
    }
    target[segments.at(-1) as string] = value;
  };
  if (principal.userId !== undefined) set(names.subject ?? 'sub', principal.userId);
  if (principal.tenantId !== undefined) set(names.tenant ?? 'tenant_id', assertTenantId(principal.tenantId));
  if (principal.roles?.length) set(names.roles ?? 'roles', [...principal.roles]);
  if (principal.scopes?.length) set(names.scopes ?? 'scope', principal.scopes.join(' '));
  return claims;
}

// ── Keeping API keys ────────────────────────────────────────────────

const API_KEYS: readonly string[] = ['nexus', 'server', 'api-keys'];
const API_KEY_HASHES: readonly string[] = ['nexus', 'server', 'api-key-hashes'];
const API_KEY_USES: readonly string[] = ['nexus', 'server', 'api-key-uses'];

/** An API key as it is kept: its hash, never the key, with the principal it stands for. */
export interface ApiKeyRecord {
  /** Its id, which names it in a list and to `revoke()` and `rotate()`. Not a secret. */
  id: string;
  /** The key's SHA-256, as `hashApiKey()` gives it. */
  hash: string;
  /** The key's first characters, its prefix and four more, to recognise it by. */
  start: string;
  /** Who the key stands for. */
  principal: Principal;
  /** What it is for, in words. */
  label?: string;
  /** When it was issued, in milliseconds since the epoch. */
  createdAt: number;
  /** When it stops working, in milliseconds since the epoch. */
  expiresAt?: number;
  /** When it was last used, to the store's `touchEveryMs`. */
  lastUsedAt?: number;
  /** When it was revoked. */
  revokedAt?: number;
  /** The id of the key that replaced it, when it was rotated. */
  replacedBy?: string;
}

/** A key just issued: the key itself, shown this once, and its record. */
export interface IssuedApiKey {
  /** The key, to hand to whoever will use it. It is never stored, so it cannot be shown again. */
  key: string;
  /** Its record. */
  record: ApiKeyRecord;
}

/** What a key is issued with. */
export interface ApiKeyIssueOptions {
  /** What it is for, in words. */
  label?: string;
  /** How long it works, in seconds. Without it, until it is revoked. */
  expiresInSec?: number;
}

/** Options for `createApiKeyStore()`. */
export interface ApiKeyStoreOptions {
  /**
   * Where keys are kept: the server's state store, so every replica reads the same keys. Defaults to
   * a `MemoryServerStore`, which one process alone reads.
   */
  store?: ServerStateStore;
  /** What every key begins with, so it is recognised in a log or by a secret scanner. Defaults to `nxk_`. */
  prefix?: string;
  /** The least time between two writes of a key's `lastUsedAt`, in milliseconds. Defaults to a minute. */
  touchEveryMs?: number;
  /** Replaces the clock, in milliseconds since the epoch, for tests. */
  now?: () => number;
}

/** API keys issued, rotated, and revoked by the application, which `apiKeyAuth()` reads by their hash. */
export interface ApiKeyStore {
  /** Issues a key for a principal. */
  issue(principal: Principal, options?: ApiKeyIssueOptions): Promise<IssuedApiKey>;
  /**
   * Replaces a key with a new one for the same principal and label. The old one works for `graceSec`
   * more, 0 by default, so what uses it can move to the new one first.
   */
  rotate(id: string, options?: ApiKeyIssueOptions & { graceSec?: number }): Promise<IssuedApiKey>;
  /** Revokes a key at once. Resolves whether there was one to revoke. */
  revoke(id: string): Promise<boolean>;
  /** A key's record. */
  get(id: string): Promise<ApiKeyRecord | undefined>;
  /** Records, newest first, a tenant's alone when `tenantId` is given; `limit` read, 1,000 by default. */
  list(options?: { tenantId?: string; limit?: number }): Promise<ApiKeyRecord[]>;
  /** The principal a key stands for, by its hash, while it works: `apiKeyAuth({ lookup })`. */
  lookup(hash: string): Promise<Principal | undefined>;
  /** `apiKeyAuth()` over this store, taking only keys with its prefix. */
  auth(options?: Pick<ApiKeyAuthOptions, 'header'>): AuthHook;
}

/**
 * API keys the application issues and revokes itself, kept as hashes in the server's state store.
 *
 * ```ts
 * const keys = createApiKeyStore({ store: fromStore(redisStore) });
 * const { key } = await keys.issue({ userId: 'ci', tenantId: 'acme', scopes: ['write'] }, { label: 'CI' });
 * createAgentServer({ assistants, state: fromStore(redisStore), authenticate: anyAuth(jwtAuth({ ... }), keys.auth()) });
 * ```
 */
export function createApiKeyStore(options: ApiKeyStoreOptions = {}): ApiKeyStore {
  const store = options.store ?? new MemoryServerStore();
  const prefix = options.prefix ?? 'nxk_';
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(prefix)) throw new TypeError('A key prefix is 1 to 16 letters, digits, _ or -');
  const now = options.now ?? Date.now;
  const touchEveryMs = options.touchEveryMs ?? 60_000;
  const read = async (id: string): Promise<ApiKeyRecord | undefined> => {
    const record = await store.get<ApiKeyRecord>(API_KEYS, id);
    if (!record) return undefined;
    const used = await store.get<number>(API_KEY_USES, id);
    return used === undefined ? record : { ...record, lastUsedAt: used };
  };
  const issue = async (principal: Principal, issueOptions: ApiKeyIssueOptions = {}): Promise<IssuedApiKey> => {
    if (principal.tenantId !== undefined) assertTenantId(principal.tenantId);
    const key = `${prefix}${randomText(32)}`;
    const record: ApiKeyRecord = {
      id: `key_${randomText(12)}`,
      hash: await hashApiKey(key),
      start: key.slice(0, prefix.length + 4),
      principal,
      ...(issueOptions.label !== undefined ? { label: issueOptions.label } : {}),
      createdAt: now(),
      ...(issueOptions.expiresInSec !== undefined ? { expiresAt: now() + issueOptions.expiresInSec * 1_000 } : {}),
    };
    // The record first: a hash that names no record yet is not a key, so a half-written issue lets no one in.
    await store.put(API_KEYS, record.id, record);
    await store.put(API_KEY_HASHES, record.hash, record.id);
    return { key, record };
  };
  const keys: ApiKeyStore = {
    issue,
    async rotate(id, rotateOptions = {}) {
      const old = await store.get<ApiKeyRecord>(API_KEYS, id);
      if (!old) throw new TypeError(`No API key "${id}"`);
      if (old.revokedAt !== undefined) throw new TypeError(`The API key "${id}" is revoked: issue a new one`);
      const { graceSec, ...issueOptions } = rotateOptions;
      const replacement = await issue(old.principal, {
        ...(old.label !== undefined ? { label: old.label } : {}),
        ...issueOptions,
      });
      const until = now() + (graceSec ?? 0) * 1_000;
      await store.put(API_KEYS, id, {
        ...old,
        expiresAt: Math.min(old.expiresAt ?? Number.POSITIVE_INFINITY, until),
        replacedBy: replacement.record.id,
      });
      return replacement;
    },
    async revoke(id) {
      const record = await store.get<ApiKeyRecord>(API_KEYS, id);
      if (!record || record.revokedAt !== undefined) return false;
      await store.put(API_KEYS, id, { ...record, revokedAt: now() });
      return true;
    },
    get: read,
    async list(listOptions = {}) {
      const records = await store.list<ApiKeyRecord>(API_KEYS, { limit: listOptions.limit ?? 1_000 });
      const chosen = records.filter(
        (record) => listOptions.tenantId === undefined || record.principal.tenantId === listOptions.tenantId,
      );
      return Promise.all(chosen.map(async (record) => (await read(record.id)) ?? record));
    },
    async lookup(hash) {
      const id = await store.get<string>(API_KEY_HASHES, hash);
      const record = id === undefined ? undefined : await store.get<ApiKeyRecord>(API_KEYS, id);
      if (!record || record.hash !== hash || record.revokedAt !== undefined) return undefined;
      const at = now();
      if (record.expiresAt !== undefined && at >= record.expiresAt) return undefined;
      // Its use is kept apart from the record, so recording it never undoes a revocation written meanwhile.
      const used = await store.get<number>(API_KEY_USES, record.id);
      if (used === undefined || at - used >= touchEveryMs) await store.put(API_KEY_USES, record.id, at);
      return record.principal;
    },
    auth(authOptions = {}) {
      return apiKeyAuth({ ...authOptions, prefix, lookup: (hash) => keys.lookup(hash) });
    },
  };
  return keys;
}

// ── Sessions ────────────────────────────────────────────────────────

const SESSIONS: readonly string[] = ['nexus', 'server', 'sessions'];
const SESSIONS_SEEN: readonly string[] = ['nexus', 'server', 'sessions-seen'];

/** How the session cookie is written. */
export interface SessionCookieOptions {
  /** Its name. Defaults to `__Host-nexus_session`, which a browser binds to this host alone, or `nexus_session` where that cannot be used. */
  name?: string;
  /** The domain it is sent to, besides this host. Defaults to none: this host alone. */
  domain?: string;
  /** The path it is sent for. Defaults to `/`. */
  path?: string;
  /** Sent over HTTPS alone. Defaults to true; false for plain HTTP on a developer's machine. */
  secure?: boolean;
  /** Whether a browser sends it from another site. Defaults to `Lax`; `None` needs `secure`. */
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** Options for `createSessions()`. */
export interface SessionOptions {
  /** Where sessions are kept: the server's state store, so every replica reads them. Defaults to a `MemoryServerStore`. */
  store?: ServerStateStore;
  /** How the cookie is written. */
  cookie?: SessionCookieOptions;
  /** The longest a session lasts from its start, in seconds. Defaults to 8 hours. */
  maxAgeSec?: number;
  /** How long a session lasts unused, in seconds. Defaults to the longest it lasts. */
  idleSec?: number;
  /**
   * Origins a request that changes something may come from, besides the request URL's own: the
   * application's public origin, when a proxy in front makes the server see another.
   */
  origins?: readonly string[];
  /** Replaces the clock, in milliseconds since the epoch, for tests. */
  now?: () => number;
}

/** A session as it is kept: the hash of its secret, never the secret, with whom it is for. */
export interface SessionRecord {
  /** Its id, which names it to `revoke()`. Not a secret. */
  id: string;
  /** The SHA-256 of the secret the cookie carries. */
  hash: string;
  /** Who signed in. */
  principal: Principal;
  /** When it started, in milliseconds since the epoch. */
  createdAt: number;
  /** When it ends, however much it is used. */
  expiresAt: number;
  /** When it was last used, to the minute. */
  lastSeenAt?: number;
}

/** A session just started. */
export interface StartedSession {
  /** The value of a `Set-Cookie` header, for the response to the sign-in. */
  cookie: string;
  /** Its record. */
  record: SessionRecord;
}

/** Browser sessions: a cookie after a sign-in of the application's own, and the hook that reads it. */
export interface Sessions {
  /** Starts a session for a principal: set the cookie it returns on the sign-in's response. */
  start(principal: Principal): Promise<StartedSession>;
  /** Ends the request's session, and returns the `Set-Cookie` value that clears its cookie. */
  end(request: Request): Promise<string>;
  /** Ends a session by its id, wherever its cookie is. Resolves whether there was one. */
  revoke(id: string): Promise<boolean>;
  /** Live sessions, newest first, a user's or a tenant's alone when one is given; `limit` read, 1,000 by default. */
  list(options?: { userId?: string; tenantId?: string; limit?: number }): Promise<SessionRecord[]>;
  /** Removes sessions that have ended, up to 10,000 at a time, and resolves how many. Call it now and then, from a cron job. */
  sweep(): Promise<number>;
  /**
   * The `authenticate` hook. A request with no cookie is passed over; an ended or forged one answers
   * 401 and clears the cookie; a request that changes something, from a page of another origin,
   * answers 403. The principal carries `method: 'session'` and its id as the `sid` claim.
   */
  readonly auth: AuthHook;
}

/**
 * Browser sessions after a sign-in of the application's own: a password, a magic link, or an identity
 * provider's redirect. The cookie carries a random secret, the store its hash, so a copy of the store
 * signs no one in; it is `HttpOnly`, `Secure`, and `SameSite=Lax` by default, and a request that
 * changes something must come from the application's own origin.
 *
 * ```ts
 * const sessions = createSessions({ store: fromStore(redisStore), origins: ['https://agents.example.com'] });
 * // In the sign-in route, once the user is known:
 * const { cookie } = await sessions.start({ userId: user.id, tenantId: user.orgId, scopes: ['read', 'write'] });
 * return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': cookie } });
 * ```
 */
export function createSessions(options: SessionOptions = {}): Sessions {
  const store = options.store ?? new MemoryServerStore();
  const now = options.now ?? Date.now;
  const maxAgeSec = options.maxAgeSec ?? 8 * 3_600;
  const idleMs = (options.idleSec ?? maxAgeSec) * 1_000;
  const path = options.cookie?.path ?? '/';
  const domain = options.cookie?.domain;
  const secure = options.cookie?.secure ?? true;
  const sameSite = options.cookie?.sameSite ?? 'Lax';
  if (sameSite === 'None' && !secure)
    throw new TypeError('A cookie sent from other sites, SameSite=None, must be secure');
  const name =
    options.cookie?.name ?? (secure && domain === undefined && path === '/' ? '__Host-nexus_session' : 'nexus_session');
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new TypeError(`"${name}" is not a cookie name`);
  const attributes = [
    `Path=${path}`,
    ...(domain !== undefined ? [`Domain=${domain}`] : []),
    'HttpOnly',
    ...(secure ? ['Secure'] : []),
    `SameSite=${sameSite}`,
  ].join('; ');
  const cleared = `${name}=; ${attributes}; Max-Age=0`;
  const origins = new Set(options.origins ?? []);

  /** The request's session, by its cookie, or why it has none. */
  const find = async (request: Request): Promise<SessionRecord | 'none' | 'ended'> => {
    const value = cookieOf(request, name);
    if (value === undefined) return 'none';
    const match = /^([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{43})$/.exec(value);
    if (!match) return 'ended';
    const [, id, secret] = match as unknown as [string, string, string];
    const record = await store.get<SessionRecord>(SESSIONS, id);
    if (!record || !sameText(record.hash, await hashApiKey(secret))) return 'ended';
    const at = now();
    const seen = (await store.get<number>(SESSIONS_SEEN, id)) ?? record.createdAt;
    if (at >= record.expiresAt || at - seen >= idleMs) {
      await revoke(id);
      return 'ended';
    }
    // Written at most once a minute, and apart from the record, so a revocation meanwhile stays one.
    if (at - seen >= Math.min(60_000, idleMs / 2)) await store.put(SESSIONS_SEEN, id, at);
    return record;
  };
  const revoke = async (id: string): Promise<boolean> => {
    const found = (await store.get<SessionRecord>(SESSIONS, id)) !== undefined;
    await store.delete(SESSIONS, id);
    await store.delete(SESSIONS_SEEN, id);
    return found;
  };
  const live = async (limit: number): Promise<{ live: SessionRecord[]; ended: string[] }> => {
    const at = now();
    const records = await store.list<SessionRecord>(SESSIONS, { limit });
    const found: { live: SessionRecord[]; ended: string[] } = { live: [], ended: [] };
    for (const record of records) {
      const seen = await store.get<number>(SESSIONS_SEEN, record.id);
      if (at >= record.expiresAt || at - (seen ?? record.createdAt) >= idleMs) found.ended.push(record.id);
      else found.live.push(seen === undefined ? record : { ...record, lastSeenAt: seen });
    }
    return found;
  };

  return {
    async start(principal) {
      if (principal.tenantId !== undefined) assertTenantId(principal.tenantId);
      const id = randomText(12);
      const secret = randomText(32);
      const record: SessionRecord = {
        id,
        hash: await hashApiKey(secret),
        principal,
        createdAt: now(),
        expiresAt: now() + maxAgeSec * 1_000,
      };
      await store.put(SESSIONS, id, record);
      return { cookie: `${name}=${id}.${secret}; ${attributes}; Max-Age=${maxAgeSec}`, record };
    },
    async end(request) {
      const value = cookieOf(request, name);
      const id = value?.split('.')[0];
      if (id) await revoke(id);
      return cleared;
    },
    revoke,
    async list(listOptions = {}) {
      return (await live(listOptions.limit ?? 1_000)).live.filter(
        (record) =>
          (listOptions.userId === undefined || record.principal.userId === listOptions.userId) &&
          (listOptions.tenantId === undefined || record.principal.tenantId === listOptions.tenantId),
      );
    },
    async sweep() {
      const { ended } = await live(10_000);
      for (const id of ended) await revoke(id);
      return ended.length;
    },
    async auth(request) {
      const found = await find(request);
      if (found === 'none') return undefined;
      if (found === 'ended')
        return refuse(401, 'The session has ended: sign in again', undefined, { 'set-cookie': cleared });
      if (!SAFE_METHODS.has(request.method) && !fromOwnOrigin(request, origins)) {
        return refuse(403, 'A request from another site cannot use this session');
      }
      return {
        ...found.principal,
        method: 'session',
        claims: { ...(found.principal.claims ?? {}), sid: found.id },
      };
    },
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a request came from the application's own pages: its `Origin` the request's own or one
 * allowed, or, without one, the browser's `Sec-Fetch-Site` saying so. A request with neither is
 * refused, since a browser sends one of them on every request that changes something.
 */
function fromOwnOrigin(request: Request, origins: ReadonlySet<string>): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === new URL(request.url).origin || origins.has(origin);
  const site = request.headers.get('sec-fetch-site');
  return site === 'same-origin' || site === 'none';
}

/** A cookie's value from a request, by its name. */
function cookieOf(request: Request, name: string): string | undefined {
  for (const pair of (request.headers.get('cookie') ?? '').split(';')) {
    const at = pair.indexOf('=');
    if (at > 0 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return undefined;
}

/** Random bytes as base64url text. */
function randomText(bytes: number): string {
  return base64UrlText(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
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
function refuse(
  status: 401 | 403,
  message: string,
  challenge?: string,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify({ error: { code: status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message } }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(challenge ? { 'www-authenticate': challenge } : {}),
      ...headers,
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

function base64UrlText(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlJson(value: unknown): string {
  return base64UrlText(new TextEncoder().encode(JSON.stringify(value)));
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

function pemToDer(pem: string, label: 'PUBLIC KEY' | 'PRIVATE KEY' = 'PUBLIC KEY'): ArrayBuffer {
  const body = pem.replace(new RegExp(`-----(?:BEGIN|END) ${label}-----`, 'g'), '').replace(/\s+/g, '');
  if (!body || (label === 'PUBLIC KEY' && pem.includes('PRIVATE KEY'))) {
    throw new JwtError('JWT_KEY', `The ${label.toLowerCase()} is not a PEM ${label.toLowerCase()}`);
  }
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
