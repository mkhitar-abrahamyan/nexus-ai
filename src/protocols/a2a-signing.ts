/**
 * Agent card signatures, as protocol 1.0 defines them: a JSON Web Signature, flattened, over the card
 * in its canonical form, the card as its schema has it with the `signatures` field left out, empty
 * values dropped, and serialized by RFC 8785's rules. The A2A project's SDK signs and checks them the
 * same way, so a card signed by either is checked by both. With the Web Crypto API alone: ES256, ES384,
 * ES512, RS256, RS384, RS512, PS256, PS384, PS512, and Ed25519, by that name or `EdDSA`.
 */
import { decodeBase64, encodeBase64 } from '../utils/base64.js';
import type { A2aAgentCard, A2aCardSignature } from './a2a.js';
import { decodeA2a, encodeA2a } from './a2a-proto.js';

/** An algorithm a card is signed with, as JWS names it. */
export type A2aSignatureAlgorithm =
  | 'ES256'
  | 'ES384'
  | 'ES512'
  | 'RS256'
  | 'RS384'
  | 'RS512'
  | 'PS256'
  | 'PS384'
  | 'PS512'
  | 'EdDSA'
  | 'Ed25519';

/** A JSON Web Key, as Web Crypto imports and exports one. */
export interface A2aJsonWebKey {
  /** The key type: `EC`, `RSA`, or `OKP`. */
  kty: string;
  /** The algorithm it is for, when it says. */
  alg?: string;
  /** Anything else the key holds: its curve, its public and private parts. */
  [field: string]: unknown;
}

/** A Web Crypto key, as `crypto.subtle` returns one. Any runtime's `CryptoKey` is one. */
export interface A2aCryptoKey {
  /** Its algorithm. */
  readonly algorithm: unknown;
  /** What it may do. */
  readonly usages: readonly string[];
}

/** A key that signs cards: the private key, its algorithm, and the id a verifier finds its public key by. */
export interface A2aCardSigner {
  /** The private key: a Web Crypto key, or a JWK. */
  key: A2aCryptoKey | A2aJsonWebKey;
  /** Its algorithm. */
  alg: A2aSignatureAlgorithm;
  /** The key's id, which a verifier looks its public key up by. */
  kid: string;
  /** A URL of the JWK Set that holds the public key, for a verifier that fetches it. */
  jku?: string;
  /** Unprotected header values, written beside the signature and not covered by it. */
  header?: Record<string, unknown>;
}

/**
 * Finds the public key a signature names: by its key id, the JWK Set URL its header gives, if any,
 * and the algorithm it was made with. `undefined` for a key it does not trust.
 */
export type A2aCardKeyResolver = (
  kid: string,
  jku: string | undefined,
  alg: A2aSignatureAlgorithm,
) => A2aCryptoKey | A2aJsonWebKey | undefined | Promise<A2aCryptoKey | A2aJsonWebKey | undefined>;

/** Raised for a card that carries no signature its verifier can check, or none that holds. */
export class A2aCardSignatureError extends Error {
  constructor(
    message: string,
    /** Why each signature the card carries did not hold, in its order. */
    readonly reasons: readonly string[] = [],
  ) {
    super(message);
    this.name = 'A2aCardSignatureError';
  }
}

/** The part of Web Crypto signing uses, typed here so no runtime's own declarations are needed. */
interface Subtle {
  importKey(
    format: 'jwk',
    key: A2aJsonWebKey,
    algorithm: Record<string, unknown>,
    extractable: boolean,
    usages: string[],
  ): Promise<A2aCryptoKey>;
  sign(algorithm: Record<string, unknown>, key: A2aCryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  verify(
    algorithm: Record<string, unknown>,
    key: A2aCryptoKey,
    signature: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean>;
}

/** Each algorithm, as the Web Crypto API names its key and its signature. */
const ALGORITHMS: Record<A2aSignatureAlgorithm, { key: Record<string, unknown>; sign: Record<string, unknown> }> = {
  ES256: { key: { name: 'ECDSA', namedCurve: 'P-256' }, sign: { name: 'ECDSA', hash: 'SHA-256' } },
  ES384: { key: { name: 'ECDSA', namedCurve: 'P-384' }, sign: { name: 'ECDSA', hash: 'SHA-384' } },
  ES512: { key: { name: 'ECDSA', namedCurve: 'P-521' }, sign: { name: 'ECDSA', hash: 'SHA-512' } },
  RS256: { key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, sign: { name: 'RSASSA-PKCS1-v1_5' } },
  RS384: { key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' }, sign: { name: 'RSASSA-PKCS1-v1_5' } },
  RS512: { key: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, sign: { name: 'RSASSA-PKCS1-v1_5' } },
  PS256: { key: { name: 'RSA-PSS', hash: 'SHA-256' }, sign: { name: 'RSA-PSS', saltLength: 32 } },
  PS384: { key: { name: 'RSA-PSS', hash: 'SHA-384' }, sign: { name: 'RSA-PSS', saltLength: 48 } },
  PS512: { key: { name: 'RSA-PSS', hash: 'SHA-512' }, sign: { name: 'RSA-PSS', saltLength: 64 } },
  EdDSA: { key: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
  Ed25519: { key: { name: 'Ed25519' }, sign: { name: 'Ed25519' } },
};

/** Two names for one algorithm: `EdDSA`, and `Ed25519`, which RFC 9864 names it and Web Crypto labels its keys. */
const sameAlgorithm = (a: string, b: string) =>
  a === b || ((a === 'EdDSA' || a === 'Ed25519') && (b === 'EdDSA' || b === 'Ed25519'));

/**
 * A card in the form its signatures cover: as its schema has it, fields the schema does not name and
 * fields at their default left out, then the `signatures` field and every empty value, and serialized
 * with each object's keys in order, as RFC 8785 serializes JSON.
 */
export function canonicalA2aCard(card: A2aAgentCard | Omit<A2aAgentCard, 'signatures'>): string {
  const normalized = decodeA2a('AgentCard', encodeA2a('AgentCard', card));
  delete normalized.signatures;
  const cleaned = withoutEmpty(normalized);
  return cleaned === undefined ? '{}' : canonicalJson(cleaned);
}

/**
 * The card with one more signature, by `signer`, over its canonical form: a flattened JWS whose
 * protected header names the algorithm, the key id, `typ: JOSE`, and the key set's URL when given.
 */
export async function signA2aCard(card: A2aAgentCard, signer: A2aCardSigner): Promise<A2aAgentCard> {
  if (!Object.hasOwn(ALGORITHMS, signer.alg)) {
    throw new A2aCardSignatureError(`A card is not signed with ${String(signer.alg)}`);
  }
  const protectedHeader = base64url(
    new TextEncoder().encode(
      JSON.stringify({ alg: signer.alg, kid: signer.kid, typ: 'JOSE', ...(signer.jku ? { jku: signer.jku } : {}) }),
    ),
  );
  const key = await keyOf(signer.key, signer.alg, 'sign');
  const signed = await subtle().sign(
    ALGORITHMS[signer.alg].sign,
    key,
    signingInput(protectedHeader, canonicalA2aCard(card)),
  );
  const signature: A2aCardSignature = {
    protected: protectedHeader,
    signature: base64url(new Uint8Array(signed)),
    ...(signer.header ? { header: signer.header } : {}),
  };
  return { ...card, signatures: [...(card.signatures ?? []), signature] };
}

/**
 * Checks a card's signatures over its canonical form, each against the public key `resolveKey` gives
 * for its key id, and returns the first that holds. Throws `A2aCardSignatureError` for a card with no
 * signature, or none that holds, saying why each did not.
 */
export async function verifyA2aCard(
  card: A2aAgentCard,
  resolveKey: A2aCardKeyResolver,
): Promise<{ kid: string; alg: A2aSignatureAlgorithm }> {
  const signatures = card.signatures ?? [];
  if (signatures.length === 0) throw new A2aCardSignatureError('The agent card carries no signature');
  const payload = canonicalA2aCard(card);
  const reasons: string[] = [];
  for (const [index, entry] of signatures.entries()) {
    try {
      const header = JSON.parse(new TextDecoder().decode(fromBase64url(entry.protected))) as {
        alg?: unknown;
        kid?: unknown;
        jku?: unknown;
      };
      const alg = header.alg as A2aSignatureAlgorithm;
      if (typeof alg !== 'string' || !Object.hasOwn(ALGORITHMS, alg)) {
        throw new Error(`its algorithm, ${JSON.stringify(header.alg)}, is not one a card is signed with`);
      }
      if (typeof header.kid !== 'string' || !header.kid) throw new Error('its header names no key id');
      const jku = typeof header.jku === 'string' ? header.jku : undefined;
      const found = await resolveKey(header.kid, jku, alg);
      if (!found) throw new Error(`no key is trusted as ${header.kid}`);
      const key = await keyOf(found, alg, 'verify');
      const held = await subtle().verify(
        ALGORITHMS[alg].sign,
        key,
        fromBase64url(entry.signature),
        signingInput(entry.protected, payload),
      );
      if (held) return { kid: header.kid, alg };
      reasons.push(`signature ${index + 1}, by ${header.kid}: it does not match the card`);
    } catch (error) {
      reasons.push(`signature ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new A2aCardSignatureError(`No signature on the agent card holds: ${reasons.join('; ')}`, reasons);
}

/** A key for the algorithm: a Web Crypto key as it is, or a JWK imported for it, refused if it names another. */
async function keyOf(
  key: A2aCryptoKey | A2aJsonWebKey,
  alg: A2aSignatureAlgorithm,
  use: 'sign' | 'verify',
): Promise<A2aCryptoKey> {
  if (!isJwk(key)) return key;
  if (key.alg !== undefined && !sameAlgorithm(key.alg, alg)) throw new Error(`the key is for ${key.alg}, not ${alg}`);
  // A private JWK given to verify is read as its public half, which is all verifying needs.
  const { d: _d, dp: _dp, dq: _dq, p: _p, q: _q, qi: _qi, oth: _oth, key_ops: _ops, ...publicPart } = key;
  return subtle().importKey('jwk', use === 'verify' ? publicPart : key, ALGORITHMS[alg].key, false, [use]);
}

function isJwk(key: A2aCryptoKey | A2aJsonWebKey): key is A2aJsonWebKey {
  return typeof (key as A2aJsonWebKey).kty === 'string';
}

function subtle(): Subtle {
  const crypto = (globalThis as unknown as { crypto?: { subtle?: Subtle } }).crypto;
  if (!crypto?.subtle) throw new A2aCardSignatureError('Signing a card needs the Web Crypto API');
  return crypto.subtle;
}

/** What a JWS signs: its protected header and its payload, each base64url-encoded, joined by a dot. */
function signingInput(protectedHeader: string, payload: string): Uint8Array {
  return new TextEncoder().encode(`${protectedHeader}.${base64url(new TextEncoder().encode(payload))}`);
}

function base64url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(text: string): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('it is not base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return decodeBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}

/** A value without empty strings, nulls, empty lists, or empty objects, at any depth; `undefined` when nothing is left. */
function withoutEmpty(value: unknown): unknown {
  if (value === '' || value === null || value === undefined) return undefined;
  if (Array.isArray(value)) {
    const kept = value.map(withoutEmpty).filter((item) => item !== undefined);
    return kept.length ? kept : undefined;
  }
  if (typeof value === 'object') {
    const kept: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const cleaned = withoutEmpty(item);
      if (cleaned !== undefined) kept[key] = cleaned;
    }
    return Object.keys(kept).length ? kept : undefined;
  }
  return value;
}

/** JSON with every object's keys in order, as RFC 8785 serializes it. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
