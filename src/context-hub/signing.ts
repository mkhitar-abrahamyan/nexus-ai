import { canonicalJson } from '../prompts/version.js';
import type { PromptDefinition } from '../types/prompts.js';
import { decodeBase64, encodeBase64 } from '../utils/base64.js';

/** A JSON Web Key, as Web Crypto exports one. */
export interface ContextJsonWebKey {
  /** The key type: `OKP` for Ed25519. */
  kty?: string;
  /** The curve: `Ed25519`. */
  crv?: string;
  /** The public key, in base64url. */
  x?: string;
  /** The private key, in base64url, on a private key only. */
  d?: string;
  /** Anything else the exporter wrote. */
  [field: string]: unknown;
}

/** A Web Crypto key, as `crypto.subtle` returns one. Any runtime's `CryptoKey` is one. */
export interface ContextCryptoKey {
  /** Its algorithm. */
  readonly algorithm: unknown;
  /** What it may do. */
  readonly usages: readonly string[];
}

/** One signature on a bundle version. Stored with it, and carried by its export. */
export interface ContextSignature {
  /** The id of the key that signed, which a keyring looks up. */
  keyId: string;
  /** Always `Ed25519`. */
  algorithm: 'Ed25519';
  /**
   * What was signed: `sha256:` and the full SHA-256, in hex, of the bundle's content and the content
   * of every prompt it pins. A bundle's version is only the first 12 hex digits, enough to name a
   * version but not to stand behind a signature.
   */
  digest: string;
  /** The signature over the digest, in base64url. */
  signature: string;
  /** ISO-8601 time it was signed. */
  signedAt: string;
}

/** Signs bundle digests with a private key, under a key id. */
export interface ContextSigner {
  /** The key's id, recorded on each signature so a keyring finds the public key. */
  keyId: string;
  /** Signs bytes. */
  sign(data: Uint8Array): Promise<Uint8Array> | Uint8Array;
}

/** Verifies signatures by key id. A signature by a key the keyring does not hold never verifies. */
export interface ContextKeyring {
  /** Whether `signature` is `keyId`'s signature over `data`. */
  verify(keyId: string, data: Uint8Array, signature: Uint8Array): Promise<boolean> | boolean;
}

/** A new signing key, with both halves as JSON Web Keys to keep in a secret store. */
export interface ContextSigningKey {
  /** The key's id. */
  keyId: string;
  /** Signs with the new key. */
  signer: ContextSigner;
  /** The public half, for every keyring that should trust it. */
  publicKey: ContextJsonWebKey;
  /** The private half. Keep it where the signer runs, and nowhere else. */
  privateKey: ContextJsonWebKey;
}

/** The part of Web Crypto signing uses, typed here so no runtime's own declarations are needed. */
interface Subtle {
  generateKey(
    algorithm: { name: string },
    extractable: boolean,
    usages: string[],
  ): Promise<{ publicKey: ContextCryptoKey; privateKey: ContextCryptoKey }>;
  exportKey(format: 'jwk', key: ContextCryptoKey): Promise<ContextJsonWebKey>;
  importKey(
    format: 'jwk',
    key: ContextJsonWebKey,
    algorithm: { name: string },
    extractable: boolean,
    usages: string[],
  ): Promise<ContextCryptoKey>;
  sign(algorithm: { name: string }, key: ContextCryptoKey, data: Uint8Array): Promise<ArrayBuffer>;
  verify(algorithm: { name: string }, key: ContextCryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
  digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
}

const subtle = (): Subtle => (globalThis.crypto as unknown as { subtle: Subtle }).subtle;
const ED25519 = { name: 'Ed25519' } as const;

/**
 * Creates an Ed25519 signing key through Web Crypto, so on any runtime. The key id defaults to the
 * first 16 hex digits of the public key's SHA-256, which is stable for the key and names nothing
 * else.
 */
export async function generateContextKey(keyId?: string): Promise<ContextSigningKey> {
  const pair = await subtle().generateKey(ED25519, true, ['sign', 'verify']);
  const publicKey = await subtle().exportKey('jwk', pair.publicKey);
  const privateKey = await subtle().exportKey('jwk', pair.privateKey);
  const id = keyId ?? (await keyIdOf(publicKey));
  return { keyId: id, signer: await ed25519Signer(id, pair.privateKey), publicKey, privateKey };
}

/** A signer from an Ed25519 private key, as a JSON Web Key or a Web Crypto key. */
export async function ed25519Signer(
  keyId: string,
  privateKey: ContextJsonWebKey | ContextCryptoKey,
): Promise<ContextSigner> {
  const key = isCryptoKey(privateKey)
    ? privateKey
    : await subtle().importKey('jwk', privateKey, ED25519, false, ['sign']);
  return { keyId, sign: async (data) => new Uint8Array(await subtle().sign(ED25519, key, data)) };
}

/** A keyring of trusted Ed25519 public keys, by key id. */
export async function ed25519Keyring(
  keys: Record<string, ContextJsonWebKey | ContextCryptoKey>,
): Promise<ContextKeyring> {
  const imported = new Map<string, ContextCryptoKey>();
  for (const [keyId, key] of Object.entries(keys)) {
    imported.set(keyId, isCryptoKey(key) ? key : await subtle().importKey('jwk', key, ED25519, false, ['verify']));
  }
  return {
    async verify(keyId, data, signature) {
      const key = imported.get(keyId);
      if (!key) return false;
      try {
        return await subtle().verify(ED25519, key, signature, data);
      } catch {
        return false;
      }
    },
  };
}

/** What a bundle signature covers: the bundle's versioned content, and its pinned prompts' content. */
export interface ContextSignedContent {
  /** The bundle's name and the content its version covers. */
  bundle: {
    name: string;
    description?: string;
    prompts?: Record<string, { name: string; version: string }>;
    instructions?: Record<string, string>;
    tools?: unknown;
    skills?: unknown;
    config?: Record<string, unknown>;
  };
  /** Each pinned prompt's content, by role: what its own version covers. */
  prompts: Record<string, Pick<PromptDefinition, 'name' | 'messages' | 'partials' | 'config' | 'defaults'>>;
}

/** The digest a signature covers, as `sha256:` and 64 hex digits. */
export async function contextDigest(content: ContextSignedContent): Promise<string> {
  const text = canonicalJson({ format: 'nexus-context-signature', formatVersion: 1, ...content });
  const digest = await subtle().digest('SHA-256', new TextEncoder().encode(text));
  return `sha256:${hexOf(new Uint8Array(digest))}`;
}

/** Signs a digest. */
export async function signDigest(signer: ContextSigner, digest: string, at: Date): Promise<ContextSignature> {
  const signature = await signer.sign(new TextEncoder().encode(digest));
  return {
    keyId: signer.keyId,
    algorithm: 'Ed25519',
    digest,
    signature: toBase64Url(signature),
    signedAt: at.toISOString(),
  };
}

/** The first signature that is a trusted key's signature over exactly this digest, if any. */
export async function verifiedBy(
  keyring: ContextKeyring,
  digest: string,
  signatures: readonly ContextSignature[] = [],
): Promise<ContextSignature | undefined> {
  const data = new TextEncoder().encode(digest);
  for (const signature of signatures) {
    if (signature?.algorithm !== 'Ed25519' || signature.digest !== digest) continue;
    let bytes: Uint8Array;
    try {
      bytes = fromBase64Url(signature.signature);
    } catch {
      continue;
    }
    if (await keyring.verify(signature.keyId, data, bytes)) return signature;
  }
  return undefined;
}

async function keyIdOf(publicKey: ContextJsonWebKey): Promise<string> {
  const digest = await subtle().digest('SHA-256', new TextEncoder().encode(String(publicKey.x)));
  return hexOf(new Uint8Array(digest).subarray(0, 8));
}

function hexOf(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function isCryptoKey(value: ContextJsonWebKey | ContextCryptoKey): value is ContextCryptoKey {
  return typeof (value as ContextCryptoKey).algorithm === 'object' && Array.isArray((value as ContextCryptoKey).usages);
}

function toBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return decodeBase64(padded + '='.repeat((4 - (padded.length % 4)) % 4));
}
