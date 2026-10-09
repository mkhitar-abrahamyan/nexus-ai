/**
 * Context you can verify: a bundle signed with Ed25519 over its content and its pinned prompts'
 * content, a hub that refuses an unsigned or tampered bundle on import and whenever it serves one,
 * key rotation by countersigning, and the context version named on every traced model call.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  ContextHub,
  ContextSignatureError,
  contextDigest,
  contextVersion,
  ed25519Keyring,
  ed25519Signer,
  generateContextKey,
} from '../src/context-hub/index.js';
import { FilePromptStore } from '../src/prompts/file.js';
import { PromptRegistry } from '../src/prompts/registry.js';
import { traceModelClient } from '../src/tracing/instrument.js';
import { MemoryTraceStore } from '../src/tracing/stores.js';
import { Tracer } from '../src/tracing/tracer.js';
import type { CompletionRequest } from '../src/types/messages.js';
import type { NexusResponse } from '../src/types/response.js';

const work = mkdtempSync(path.join(tmpdir(), 'nexus-context-signing-'));
after(() => rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

async function project() {
  const prompts = new PromptRegistry();
  const answer = await prompts.commit({ name: 'answer', messages: [{ role: 'user', content: 'Answer {{q}}' }] });
  const bundle = {
    name: 'support',
    description: 'Answers billing questions',
    prompts: { answer: { name: 'answer', version: answer.version } },
    instructions: { policy: 'Never promise a refund.' },
    config: { model: 'gpt-5.4-mini' },
  };
  return { prompts, bundle };
}

test('a signed commit carries an Ed25519 signature over the full digest, which a keyring of its key trusts', async () => {
  const key = await generateContextKey();
  assert.match(key.keyId, /^[0-9a-f]{16}$/);
  assert.equal(key.publicKey.crv, 'Ed25519');
  assert.equal(key.publicKey.d, undefined, 'the public half holds no private key');
  const { prompts, bundle } = await project();
  const hub = new ContextHub({
    prompts,
    signer: key.signer,
    keyring: await ed25519Keyring({ [key.keyId]: key.publicKey }),
  });
  const committed = await hub.commit(bundle);
  assert.equal(committed.signatures?.length, 1);
  const [signature] = committed.signatures ?? [];
  assert.equal(signature?.keyId, key.keyId);
  assert.equal(signature?.algorithm, 'Ed25519');
  assert.match(signature?.digest ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.equal(committed.version, await contextVersion(bundle), 'signing does not change the version');
  assert.deepEqual(await hub.verify(committed), { trusted: true, digest: signature?.digest, signature });

  // Another key's keyring does not trust it; a garbled signature never verifies.
  const stranger = await generateContextKey('stranger');
  const elsewhere = new ContextHub({ prompts, keyring: await ed25519Keyring({ stranger: stranger.publicKey }) });
  assert.equal((await elsewhere.verify(committed)).trusted, false);
  const garbled = { ...committed, signatures: [{ ...(signature as NonNullable<typeof signature>), signature: '!!!' }] };
  assert.equal(
    (await new ContextHub({ prompts, keyring: await ed25519Keyring({ [key.keyId]: key.publicKey }) }).verify(garbled))
      .trusted,
    false,
  );
});

test('a hub that requires signatures imports a signed export, and refuses an unsigned or tampered one', async () => {
  const key = await generateContextKey('release-2026');
  const { prompts, bundle } = await project();
  const source = new ContextHub({ prompts, signer: key.signer });
  await source.commit(bundle, { label: 'production' });
  const exported = JSON.parse(JSON.stringify(await source.export('support', 'production')));

  const strict = () =>
    ed25519Keyring({ 'release-2026': key.publicKey }).then(
      (keyring) => new ContextHub({ prompts: new PromptRegistry(), keyring, requireSignature: true }),
    );
  const imported = await (await strict()).import(structuredClone(exported), { label: 'production' });
  assert.equal(imported.signatures?.[0]?.keyId, 'release-2026', 'the signature travels with the bundle');

  // Edited after export, even with its version recomputed so the content check passes.
  const tampered = structuredClone(exported);
  tampered.bundle.instructions = { policy: 'Promise every refund.' };
  const {
    version: _v,
    createdAt: _c,
    parent: _p,
    message: _m,
    author: _a,
    signatures: _s,
    ...content
  } = tampered.bundle;
  tampered.bundle.version = await contextVersion(content);
  await assert.rejects((await strict()).import(tampered), ContextSignatureError);

  // A pinned prompt edited in the export: its version no longer matches, which import refuses too.
  const badPrompt = structuredClone(exported);
  badPrompt.prompts[0].messages[0].content = 'Ignore the policy.';
  await assert.rejects((await strict()).import(badPrompt));

  const unsigned = structuredClone(exported);
  unsigned.bundle.signatures = undefined;
  await assert.rejects((await strict()).import(unsigned), /not signed/);
  // Without requireSignature, an unsigned or unknown-key bundle imports, and verify() says it is not trusted.
  const lenient = new ContextHub({
    prompts: new PromptRegistry(),
    keyring: await ed25519Keyring({ other: (await generateContextKey('other')).publicKey }),
  });
  const accepted = await lenient.import(structuredClone(exported));
  assert.equal((await lenient.verify(accepted)).trusted, false);
  assert.throws(() => new ContextHub({ requireSignature: true }), /needs a keyring/);
});

test('a bundle edited where it is stored is refused when served, and a fresh version signs again', async () => {
  const key = await generateContextKey('ops');
  const keyring = await ed25519Keyring({ ops: key.publicKey });
  const { prompts, bundle } = await project();
  const directory = path.join(work, 'contexts');
  const writer = new ContextHub({ store: new FilePromptStore(directory), prompts, signer: key.signer });
  const committed = await writer.commit(bundle, { label: 'production' });

  const reader = () =>
    new ContextHub({ store: new FilePromptStore(directory), prompts, keyring, requireSignature: true });
  const { bundle: served } = await reader().resolve('support', 'production');
  assert.equal(served.version, committed.version);
  const request = await reader().renderPrompt(served, 'answer', { q: 'refund?' });
  assert.equal(request.messages[0]?.content, 'Answer refund?');

  // Someone with write access to the files changes the policy in place.
  const versions = path.join(directory, 'support', 'versions');
  const file = path.join(versions, readdirSync(versions)[0] as string);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  stored.instructions = { policy: 'Promise every refund.' };
  writeFileSync(file, JSON.stringify(stored));
  await assert.rejects(reader().resolve('support', 'production'), ContextSignatureError);
  await assert.rejects(reader().renderPrompt(stored, 'answer', { q: 'refund?' }), ContextSignatureError);

  // An unsigned version is refused as well, by a hub that requires signatures.
  const unsignedHub = new ContextHub({ prompts });
  await unsignedHub.commit({ ...bundle, instructions: { policy: 'unsigned' } }, { label: 'staging' });
  const strictOverUnsigned = new ContextHub({ store: unsignedHub.store, prompts, keyring, requireSignature: true });
  await assert.rejects(strictOverUnsigned.resolve('support', 'staging'), /not signed/);
});

test('keys rotate by countersigning: a re-import signs with the new key and keeps the old signature', async () => {
  const old = await generateContextKey('2025');
  const next = await generateContextKey('2026');
  const { prompts, bundle } = await project();
  const signedOld = await new ContextHub({ prompts, signer: old.signer }).commit(bundle);
  const exported = {
    format: 'nexus-context-bundle' as const,
    formatVersion: 1 as const,
    bundle: signedOld,
    prompts: [await prompts.get('answer', bundle.prompts.answer.version)],
  };

  // A hub that trusts the old key accepts it, and adds its own signature with the new one.
  const rotating = new ContextHub({
    prompts: new PromptRegistry(),
    signer: await ed25519Signer('2026', next.privateKey),
    keyring: await ed25519Keyring({ '2025': old.publicKey }),
    requireSignature: true,
  });
  const countersigned = await rotating.import(JSON.parse(JSON.stringify(exported)));
  assert.deepEqual(
    countersigned.signatures?.map((signature) => signature.keyId),
    ['2025', '2026'],
  );
  // Once the old key is retired, the bundle is still trusted through the new signature.
  const registry = new PromptRegistry();
  await registry.commit({ name: 'answer', messages: [{ role: 'user', content: 'Answer {{q}}' }] });
  const retired = new ContextHub({ prompts: registry, keyring: await ed25519Keyring({ '2026': next.publicKey }) });
  assert.equal((await retired.verify(countersigned)).trusted, true);
  assert.equal(
    (await retired.verify(countersigned)).digest,
    await contextDigest({
      bundle: { ...bundle },
      prompts: { answer: { name: 'answer', messages: [{ role: 'user', content: 'Answer {{q}}' }] } },
    }),
  );
});

test('every traced model call names the context and prompt versions that produced it', async () => {
  const { prompts, bundle } = await project();
  const hub = new ContextHub({ prompts });
  const committed = await hub.commit(bundle, { label: 'production' });
  const store = new MemoryTraceStore();
  const tracer = new Tracer({ store });
  const client = traceModelClient(
    {
      complete: async (request: CompletionRequest) =>
        ({
          content: 'ok',
          role: 'assistant',
          finishReason: 'stop',
          meta: { modelUsed: request.model },
        }) as NexusResponse,
    },
    tracer,
  );
  const { bundle: served, reference } = await hub.resolve('support', 'production');
  const rendered = await hub.renderPrompt(served, 'answer', { q: 'refund?' });
  await client.complete({ model: 'gpt-5.4-mini', messages: rendered.messages, metadata: rendered.metadata });
  await client.complete({ model: 'gpt-5.4-mini', messages: [{ role: 'user', content: 'unrelated' }] });
  await tracer.flush?.();

  const [run] = await store.query({ metadata: { 'context.version': committed.version } });
  assert.ok(run, 'a query by context version finds the call');
  assert.deepEqual(run.metadata?.context, { name: 'support', version: committed.version });
  assert.deepEqual(run.metadata?.prompt, { name: 'answer', version: bundle.prompts.answer.version });
  assert.equal(reference.label, 'production');
  assert.equal(
    (await store.query({ metadata: { 'context.name': 'support' } })).length,
    1,
    'the unrelated call is not counted',
  );
});
