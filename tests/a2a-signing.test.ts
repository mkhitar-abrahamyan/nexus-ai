/**
 * Agent card signatures, as protocol 1.0 defines them: a flattened JWS over the card's canonical
 * form, which is the form the A2A project's SDK computes for the same card. A handler signs every card
 * it serves, each tenant's and the extended card included; a client given `verifyCard` makes no call
 * until a signature on the card holds. The nightly interoperability run checks each against the SDK.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createAgent } from '../src/agent/create-agent.js';
import {
  type A2aAgentCard,
  type A2aCardSigner,
  A2aCardSignatureError,
  type A2aSignatureAlgorithm,
  a2aClient,
  a2aHandler,
  canonicalA2aCard,
  signA2aCard,
  verifyA2aCard,
} from '../src/protocols/a2a.js';
import { a2aGrpcClient, a2aGrpcService } from '../src/protocols/a2a-grpc.js';
import type { ProtocolGraph } from '../src/protocols/shared.js';

const { subtle } = globalThis.crypto;

/** A card with something of everything: interfaces, a provider, capabilities, schemes, a skill, and a field no schema names. */
const CARD = {
  name: 'Mailer',
  description: 'Sends mail',
  version: '1.0.0',
  supportedInterfaces: [
    { url: 'https://a.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0', tenant: '' },
    { url: 'https://a.example/a2a', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0', tenant: 'acme' },
  ],
  provider: { organization: 'Example', url: 'https://example.com' },
  documentationUrl: '',
  capabilities: {
    streaming: true,
    pushNotifications: false,
    extensions: [{ uri: 'urn:x', description: '', required: false, params: { b: [true, null, 'x'], a: 1 } }],
  },
  securitySchemes: { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', bearerFormat: 'JWT', description: '' } } },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: [],
  skills: [
    {
      id: 'send',
      name: 'Send',
      description: 'Sends one email',
      tags: ['mail', 'ünïcode'],
      examples: [],
      outputModes: ['text/plain'],
    },
  ],
  signatures: [{ protected: 'eyJ9', signature: 'abc' }],
  notInTheSchema: { anything: true },
} as unknown as A2aAgentCard;

/** What the A2A project's SDK, `canonicalizeAgentCard()` of @a2a-js/sdk 1.3.0, computes for CARD. */
const SDK_CANONICAL =
  '{"capabilities":{"extensions":[{"params":{"a":1,"b":[true,"x"]},"uri":"urn:x"}],"pushNotifications":false,"streaming":true},"defaultInputModes":["text/plain"],"description":"Sends mail","name":"Mailer","provider":{"organization":"Example","url":"https://example.com"},"securitySchemes":{"bearer":{"httpAuthSecurityScheme":{"bearerFormat":"JWT","scheme":"Bearer"}}},"skills":[{"description":"Sends one email","id":"send","name":"Send","outputModes":["text/plain"],"tags":["mail","ünïcode"]}],"supportedInterfaces":[{"protocolBinding":"JSONRPC","protocolVersion":"1.0","url":"https://a.example/a2a"},{"protocolBinding":"HTTP+JSON","protocolVersion":"1.0","tenant":"acme","url":"https://a.example/a2a"}],"version":"1.0.0"}';

/** A new key pair for the algorithm, both halves as Web Crypto keys and as JWKs. */
async function keysFor(alg: A2aSignatureAlgorithm) {
  const rsa = { modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
  const params: Record<string, Record<string, unknown>> = {
    ES256: { name: 'ECDSA', namedCurve: 'P-256' },
    ES384: { name: 'ECDSA', namedCurve: 'P-384' },
    ES512: { name: 'ECDSA', namedCurve: 'P-521' },
    RS256: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', ...rsa },
    PS384: { name: 'RSA-PSS', hash: 'SHA-384', ...rsa },
    EdDSA: { name: 'Ed25519' },
  };
  const pair = (await subtle.generateKey(params[alg] as never, true, ['sign', 'verify'])) as unknown as {
    privateKey: never;
    publicKey: never;
  };
  return {
    pair,
    privateJwk: (await subtle.exportKey('jwk', pair.privateKey)) as never,
    publicJwk: (await subtle.exportKey('jwk', pair.publicKey)) as never,
  };
}

test('a card’s canonical form is the one the A2A project’s SDK computes for it', () => {
  assert.equal(canonicalA2aCard(CARD), SDK_CANONICAL);
  const reordered = Object.fromEntries(Object.entries(CARD).reverse()) as unknown as A2aAgentCard;
  assert.equal(canonicalA2aCard(reordered), SDK_CANONICAL, 'its keys in any order');
  assert.equal(canonicalA2aCard({ ...CARD, signatures: [] }), SDK_CANONICAL, 'its signatures left out');
  assert.equal(canonicalA2aCard({} as A2aAgentCard), '{}', 'an empty card');
});

test('a card signed with each algorithm verifies, by a Web Crypto key or a JWK, and an edit to it does not', async () => {
  for (const alg of ['ES256', 'ES384', 'ES512', 'RS256', 'PS384', 'EdDSA'] as const) {
    const { pair, privateJwk, publicJwk } = await keysFor(alg);
    for (const [how, signer, publicKey] of [
      ['keys', { key: pair.privateKey as never, alg, kid: 'k1' }, pair.publicKey as never],
      ['JWKs', { key: privateJwk, alg, kid: 'k1', jku: 'https://a.example/jwks.json' }, publicJwk],
    ] as const) {
      const signed = await signA2aCard(CARD, signer as A2aCardSigner);
      assert.equal(signed.signatures?.length, 2, `${alg} ${how}: added after the card’s own`);
      const header = JSON.parse(Buffer.from(signed.signatures?.[1]?.protected ?? '', 'base64url').toString());
      assert.deepEqual(
        header,
        { alg, kid: 'k1', typ: 'JOSE', ...(how === 'JWKs' ? { jku: 'https://a.example/jwks.json' } : {}) },
        `${alg} ${how}: the protected header`,
      );
      const asked: Array<[string, string | undefined, string]> = [];
      const verified = await verifyA2aCard(signed, (kid, jku, used) => {
        asked.push([kid, jku, used]);
        return kid === 'k1' ? publicKey : undefined;
      });
      assert.deepEqual(verified, { kid: 'k1', alg }, `${alg} ${how}: verified`);
      assert.ok(asked.length >= 1, 'the key asked for by its id');
      await assert.rejects(
        verifyA2aCard({ ...signed, description: 'Sends spam' }, () => publicKey),
        (error: unknown) =>
          error instanceof A2aCardSignatureError &&
          /signature 2, by k1: it does not match the card/.test(error.message),
        `${alg} ${how}: an edited card`,
      );
      // What the schema does not name is not covered, as the SDK's verifier says of it too.
      await verifyA2aCard({ ...signed, notInTheSchema: 'changed' } as unknown as A2aAgentCard, () => publicKey);
    }
  }
});

test('a card’s signatures are refused for every reason a JWS should be', async () => {
  const { privateJwk, publicJwk } = await keysFor('ES256');
  const other = await keysFor('ES256');
  const signed = await signA2aCard({ ...CARD, signatures: [] }, { key: privateJwk, alg: 'ES256', kid: 'k1' });
  const refused = async (card: A2aAgentCard, resolve: Parameters<typeof verifyA2aCard>[1], why: RegExp) =>
    assert.rejects(verifyA2aCard(card, resolve), (error: unknown) => {
      assert.ok(error instanceof A2aCardSignatureError, String(error));
      assert.match(error.message, why);
      return true;
    });
  await refused({ ...CARD, signatures: [] }, () => publicJwk, /carries no signature/);
  await refused(signed, () => undefined, /no key is trusted as k1/);
  await refused(signed, () => other.publicJwk, /does not match the card/);
  const header = (fields: unknown) => Buffer.from(JSON.stringify(fields)).toString('base64url');
  const forged = (fields: unknown) => ({
    ...signed,
    signatures: [{ protected: header(fields), signature: signed.signatures?.[0]?.signature ?? '' }],
  });
  await refused(forged({ alg: 'none', kid: 'k1' }), () => publicJwk, /algorithm, "none", is not one/);
  await refused(forged({ alg: 'HS256', kid: 'k1' }), () => publicJwk, /algorithm, "HS256", is not one/);
  await refused(forged({ alg: 'ES256' }), () => publicJwk, /names no key id/);
  await refused(forged({ alg: 'toString', kid: 'k1' }), () => publicJwk, /is not one a card is signed with/);
  await refused(
    { ...signed, signatures: [{ protected: '!!', signature: 'x' }] },
    () => publicJwk,
    /signature 1: it is not base64url/,
  );
  await refused(signed, () => ({ ...(publicJwk as object), alg: 'RS256' }) as never, /the key is for RS256, not ES256/);
  // One signature that holds is enough, after one that does not; a private JWK verifies as its public half.
  const twice = await signA2aCard(
    await signA2aCard({ ...CARD, signatures: [] }, { key: other.privateJwk, alg: 'ES256', kid: 'stranger' }),
    { key: privateJwk, alg: 'ES256', kid: 'k1' },
  );
  assert.deepEqual(await verifyA2aCard(twice, (kid) => (kid === 'k1' ? privateJwk : undefined)), {
    kid: 'k1',
    alg: 'ES256',
  });
  await assert.rejects(
    signA2aCard(CARD, { key: privateJwk, alg: 'HS256' as never, kid: 'k1' }),
    /A card is not signed with HS256/,
  );
});

/** A Web handler over node:http, as an application mounts it. */
async function serve(handler: (request: Request) => Promise<Response>) {
  let origin = '';
  const server: Server = createServer(async (incoming: IncomingMessage, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const response = await handler(
      new Request(`${origin}${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        ...(incoming.method === 'GET' ? {} : { body: Buffer.concat(chunks) }),
      }),
    );
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** An agent that answers every message with "ok". */
const echo = createAgent({
  client: {
    complete: async () => ({ content: 'ok', role: 'assistant', finishReason: 'stop', meta: {} }) as never,
  },
  model: 'mock',
}) as unknown as ProtocolGraph;

test('a handler signs every card it serves, each tenant’s and the extended card, and a client calls only once one holds', async () => {
  const { privateJwk, publicJwk } = await keysFor('EdDSA');
  const trusted = (kid: string) => (kid === 'mail-2026' ? publicJwk : undefined);
  let target: ReturnType<typeof a2aHandler> | undefined;
  const http = await serve((request) => (target as NonNullable<typeof target>)(request));
  const grpc = await a2aGrpcService({
    call: (...args: Parameters<NonNullable<typeof target>['call']>) =>
      (target as NonNullable<typeof target>).call(...args),
    authenticate: (request: Request) => (target as NonNullable<typeof target>).authenticate(request),
  } as never).listen(0);
  target = a2aHandler(echo, {
    card: { name: 'Mailer', description: 'Sends mail', version: '1.0.0', url: `${http.origin}/a2a`, skills: [] },
    sign: { key: privateJwk, alg: 'EdDSA', kid: 'mail-2026' },
    principal: () => ({ userId: 'ana', tenantId: 'acme', roles: [] }),
    extendedCard: () => ({ description: 'Sends mail, and more for Ana' }),
    tenants: { required: false, authorize: () => true },
  });
  try {
    const cardAt = async (path: string) => (await (await fetch(`${http.origin}${path}`)).json()) as A2aAgentCard;
    const plain = await cardAt('/.well-known/agent-card.json');
    assert.deepEqual(await verifyA2aCard(plain, trusted), { kid: 'mail-2026', alg: 'EdDSA' });
    assert.deepEqual(await cardAt('/.well-known/agent-card.json'), plain, 'signed once, served the same');
    const acme = await cardAt('/acme/.well-known/agent-card.json');
    assert.equal(acme.supportedInterfaces[0]?.tenant, 'acme');
    await verifyA2aCard(acme, trusted);
    assert.notDeepEqual(acme.signatures, plain.signatures, 'a tenant’s card signed as it is');

    const client = a2aClient({ url: `${http.origin}/.well-known/agent-card.json`, verifyCard: trusted });
    assert.equal((await client.send('Hello')).status.state, 'TASK_STATE_COMPLETED');
    const extended = await client.extendedCard();
    assert.equal(extended.description, 'Sends mail, and more for Ana');
    await verifyA2aCard(extended, trusted);
    const overGrpc = a2aGrpcClient({
      url: grpc.url,
      cardUrl: `${http.origin}/.well-known/agent-card.json`,
      verifyCard: trusted,
    });
    try {
      await verifyA2aCard(await overGrpc.card(), trusted);
      await verifyA2aCard(await overGrpc.extendedCard(), trusted);
    } finally {
      overGrpc.close();
    }
    const untrustingGrpc = a2aGrpcClient({
      url: grpc.url,
      cardUrl: `${http.origin}/.well-known/agent-card.json`,
      verifyCard: () => undefined,
    });
    try {
      await assert.rejects(untrustingGrpc.card(), /no key is trusted as mail-2026/);
      await assert.rejects(untrustingGrpc.extendedCard(), /no key is trusted as mail-2026/, 'the extended card too');
    } finally {
      untrustingGrpc.close();
    }

    // A card that does not hold stops every call before it is made, and is read again by the next.
    const calls: string[] = [];
    let tamper = true;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      const response = await fetch(input, init);
      if (!url.endsWith('agent-card.json') || !tamper) return response;
      const read = (await response.json()) as A2aAgentCard;
      return Response.json({
        ...read,
        supportedInterfaces: [{ ...read.supportedInterfaces[0], url: 'https://evil.example/a2a' }],
      });
    }) as typeof fetch;
    const wary = a2aClient({ url: `${http.origin}/a2a`, fetch: fetcher, verifyCard: trusted });
    await assert.rejects(wary.send('Hello'), (error: unknown) => {
      assert.ok(error instanceof A2aCardSignatureError, String(error));
      assert.match(error.message, /does not match the card/);
      return true;
    });
    assert.deepEqual(
      calls,
      [`${http.origin}/.well-known/agent-card.json`],
      'only the card was read, given an endpoint',
    );
    tamper = false;
    assert.equal((await wary.send('Hello')).status.state, 'TASK_STATE_COMPLETED', 'the card read again holds');
    const untrusting = a2aClient({ url: `${http.origin}/.well-known/agent-card.json`, verifyCard: () => undefined });
    await assert.rejects(untrusting.send('Hello'), /no key is trusted as mail-2026/);
  } finally {
    await http.close();
    await grpc.close();
  }
});
