import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AssetStoreCapacityError,
  AssetStoreSigningError,
  AssetStoreValidationError,
  MemoryAssetStore,
  type ByteAssetInput,
} from '../src/images/assets.js';

const PROVENANCE = {
  provider: 'mock',
  model: 'mock-image-v1',
  operation: 'generate' as const,
  requestId: 'request-assets',
};

function byteInput(bytes: Uint8Array): ByteAssetInput {
  return {
    location: { kind: 'bytes', data: bytes },
    mimeType: 'image/png',
    filename: 'asset.png',
  };
}

test('MemoryAssetStore isolates tenants, computes checksums, and returns defensive copies', () => {
  const source = new Uint8Array([1, 2, 3, 4]);
  const store = new MemoryAssetStore({ createAssetId: () => 'asset-1' });
  const stored = store.put(byteInput(source), {
    tenantId: 'tenant-a',
    provenance: PROVENANCE,
    width: 1,
    height: 1,
  });

  source[0] = 99;
  assert.equal(stored.assetId, 'asset-1');
  assert.deepEqual(stored.descriptor.location, {
    kind: 'stored',
    assetId: 'asset-1',
    uri: 'memory://asset/asset-1',
  });
  assert.deepEqual(stored.descriptor.checksum, {
    algorithm: 'sha256',
    value: '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
  });
  assert.equal(store.get('asset-1', 'tenant-b'), undefined);
  assert.equal(store.stat('asset-1', 'tenant-b'), undefined);
  assert.equal(store.delete('asset-1', 'tenant-b'), undefined);

  const firstRead = store.get('asset-1', 'tenant-a');
  assert.ok(firstRead?.location.kind === 'bytes');
  assert.deepEqual([...firstRead.location.data], [1, 2, 3, 4]);
  firstRead.location.data[1] = 88;
  firstRead.provenance.provider = 'mutated';

  const secondRead = store.get('asset-1', 'tenant-a');
  assert.ok(secondRead?.location.kind === 'bytes');
  assert.deepEqual([...secondRead.location.data], [1, 2, 3, 4]);
  assert.equal(secondRead.provenance.provider, 'mock');
});

test('MemoryAssetStore rejects capacity overflow without evicting live assets and reclaims expired space', () => {
  let now = new Date('2030-01-01T00:00:00.000Z');
  let nextId = 0;
  const store = new MemoryAssetStore({
    maxEntries: 1,
    maxTotalBytes: 4,
    maxAssetBytes: 4,
    now: () => now,
    createAssetId: () => `asset-${++nextId}`,
  });
  store.put(byteInput(new Uint8Array([1, 2, 3, 4])), {
    tenantId: 'tenant',
    provenance: PROVENANCE,
    ttlSeconds: 10,
  });

  assert.throws(
    () =>
      store.put(byteInput(new Uint8Array([5])), {
        tenantId: 'tenant',
        provenance: PROVENANCE,
      }),
    (error: unknown) => {
      assert.ok(error instanceof AssetStoreCapacityError);
      assert.equal(error.constraint, 'maxEntries');
      return true;
    },
  );
  assert.ok(store.get('asset-1', 'tenant'));

  now = new Date('2030-01-01T00:00:11.000Z');
  const replacement = store.put(byteInput(new Uint8Array([5])), {
    tenantId: 'tenant',
    provenance: PROVENANCE,
  });
  assert.equal(replacement.assetId, 'asset-2');
  assert.deepEqual(store.snapshot(), {
    entries: 1,
    totalBytes: 1,
    maxEntries: 1,
    maxTotalBytes: 4,
    maxAssetBytes: 4,
  });
});

test('MemoryAssetStore validates checksums and signer output', async () => {
  const signerContexts: string[] = [];
  const store = new MemoryAssetStore({
    createAssetId: () => 'signed-asset',
    signer: (context) => {
      signerContexts.push(`${context.tenantId}:${context.expiresInSeconds}`);
      return `https://assets.example.test/${context.assetId}`;
    },
  });
  store.put(byteInput(new Uint8Array([7, 8, 9])), {
    tenantId: 'tenant-a',
    provenance: PROVENANCE,
  });

  assert.equal(await store.sign('signed-asset', 'tenant-b'), undefined);
  assert.equal(
    await store.sign('signed-asset', 'tenant-a', { expiresInSeconds: 60 }),
    'https://assets.example.test/signed-asset',
  );
  assert.deepEqual(signerContexts, ['tenant-a:60']);

  const unsigned = new MemoryAssetStore({ createAssetId: () => 'unsigned' });
  unsigned.put(byteInput(new Uint8Array([1])), { tenantId: 'tenant', provenance: PROVENANCE });
  await assert.rejects(unsigned.sign('unsigned', 'tenant'), AssetStoreSigningError);

  const mismatch = byteInput(new Uint8Array([1, 2]));
  mismatch.checksum = { algorithm: 'sha256', value: 'incorrect' };
  assert.throws(
    () =>
      new MemoryAssetStore().put(mismatch, {
        tenantId: 'tenant',
        provenance: PROVENANCE,
      }),
    AssetStoreValidationError,
  );
});
