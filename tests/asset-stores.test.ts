import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readdirSync } from 'node:fs';
import { FilesystemAssetStore, S3AssetStore, type S3LikeClient } from '../src/images/asset-stores.js';
import { AssetStoreCapacityError, AssetStoreSigningError, AssetStoreValidationError } from '../src/images/assets.js';
import type { AssetPutOptions, AssetStore, ByteAssetInput } from '../src/images/assets.js';

const BYTES = new Uint8Array([1, 2, 3, 4, 5]);

function input(data: Uint8Array = BYTES): ByteAssetInput {
  return { location: { kind: 'bytes', data }, mimeType: 'image/png', filename: 'square.png' };
}

function putOptions(overrides: Partial<AssetPutOptions> = {}): AssetPutOptions {
  return {
    tenantId: 'tenant-a',
    provenance: { provider: 'mock', operation: 'generate', requestId: 'req-1' },
    ...overrides,
  };
}

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'nexus-assets-'));
  test.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** In-memory S3 double: the smallest thing that satisfies the structural client. */
function fakeS3(): { client: S3LikeClient; objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const metadata = new Map<string, Record<string, string>>();
  return {
    objects,
    client: {
      async putObject({ bucket, key, body, metadata: meta }) {
        objects.set(`${bucket}/${key}`, body);
        if (meta) metadata.set(`${bucket}/${key}`, meta);
      },
      async getObject({ bucket, key }) {
        const body = objects.get(`${bucket}/${key}`);
        if (!body) throw new Error('NoSuchKey');
        return { body, metadata: metadata.get(`${bucket}/${key}`) };
      },
      async deleteObject({ bucket, key }) {
        objects.delete(`${bucket}/${key}`);
        metadata.delete(`${bucket}/${key}`);
      },
      async listObjects({ bucket, prefix }) {
        return [...objects.keys()]
          .filter((key) => key.startsWith(`${bucket}/${prefix}`))
          .map((key) => ({ key: key.slice(bucket.length + 1) }));
      },
    },
  };
}

/**
 * The behaviors every store must share.
 *
 * Run against both backends, because the whole point of extracting the shared helpers was that two
 * stores must not drift on what a valid asset is or who may read it.
 */
function sharedContract(name: string, create: () => AssetStore): void {
  test(`${name}: stores and returns the bytes with a checksum`, async () => {
    const store = create();
    const stat = await store.put(input(), putOptions());

    assert.ok(stat.assetId);
    assert.equal(stat.tenantId, 'tenant-a');
    assert.equal(stat.descriptor.byteLength, 5);
    assert.equal(stat.descriptor.checksum?.algorithm, 'sha256');
    assert.equal(stat.descriptor.location.kind, 'stored');

    const fetched = await store.get(stat.assetId, 'tenant-a');
    assert.deepEqual(fetched?.location.data, BYTES);
    assert.equal(fetched?.mimeType, 'image/png');
  });

  test(`${name}: another tenant sees nothing rather than a permission error`, async () => {
    // A distinguishable error would leak the existence of another tenant's asset.
    const store = create();
    const stat = await store.put(input(), putOptions());

    assert.equal(await store.get(stat.assetId, 'tenant-b'), undefined);
    assert.equal(await store.stat(stat.assetId, 'tenant-b'), undefined);
    assert.equal(await store.delete(stat.assetId, 'tenant-b'), undefined);
    assert.ok(await store.get(stat.assetId, 'tenant-a'), 'the owner still reads it');
  });

  test(`${name}: an unknown asset returns undefined`, async () => {
    const store = create();
    assert.equal(await store.get('missing-id', 'tenant-a'), undefined);
    assert.equal(await store.stat('missing-id', 'tenant-a'), undefined);
    assert.equal(await store.delete('missing-id', 'tenant-a'), undefined);
  });

  test(`${name}: delete removes the asset`, async () => {
    const store = create();
    const stat = await store.put(input(), putOptions());

    assert.equal(await store.delete(stat.assetId, 'tenant-a'), true);
    assert.equal(await store.get(stat.assetId, 'tenant-a'), undefined);
  });

  test(`${name}: an expired asset is invisible`, async () => {
    // The factory uses the default clock, so expiry is driven by a genuinely short TTL rather than
    // an injected one. Each backend's purge behavior is covered separately with a fake clock.
    const store = create();
    const stat = await store.put(input(), putOptions({ ttlSeconds: 1 }));
    assert.ok(await store.get(stat.assetId, 'tenant-a'));

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(await store.get(stat.assetId, 'tenant-a'), undefined, 'a lapsed asset is not readable');
  });

  test(`${name}: rejects a bad tenant, mime type, or provenance`, async () => {
    const store = create();
    await assert.rejects(
      () => Promise.resolve(store.put(input(), putOptions({ tenantId: '' }))),
      AssetStoreValidationError,
    );
    await assert.rejects(
      () => Promise.resolve(store.put({ ...input(), mimeType: '' }, putOptions())),
      AssetStoreValidationError,
    );
    await assert.rejects(
      () =>
        Promise.resolve(
          store.put(input(), {
            tenantId: 'tenant-a',
            provenance: { provider: '', operation: 'generate', requestId: 'r' },
          }),
        ),
      AssetStoreValidationError,
    );
  });

  test(`${name}: rejects a mismatched supplied checksum`, async () => {
    const store = create();
    await assert.rejects(
      () =>
        Promise.resolve(
          store.put({ ...input(), checksum: { algorithm: 'sha256', value: 'a'.repeat(64) } }, putOptions()),
        ),
      AssetStoreValidationError,
    );
  });

  test(`${name}: ttlSeconds and expiresAt cannot both be set`, async () => {
    const store = create();
    await assert.rejects(
      () =>
        Promise.resolve(store.put(input(), putOptions({ ttlSeconds: 60, expiresAt: new Date(Date.now() + 60_000) }))),
      AssetStoreValidationError,
    );
  });
}

sharedContract('filesystem', () => new FilesystemAssetStore({ directory: tempDirectory() }));
sharedContract('s3', () => new S3AssetStore({ client: fakeS3().client, bucket: 'assets' }));

// ── Filesystem specifics ───────────────────────────────────────────

test('filesystem: writes a payload and a sidecar per asset', async () => {
  const directory = tempDirectory();
  const store = new FilesystemAssetStore({ directory });
  const stat = await store.put(input(), putOptions());

  const files = readdirSync(directory).sort();
  assert.deepEqual(files, [`${stat.assetId}.bin`, `${stat.assetId}.json`]);
});

test('filesystem: purgeExpired removes lapsed assets and reports the count', async () => {
  const directory = tempDirectory();
  let now = new Date('2026-01-01T00:00:00.000Z');
  const store = new FilesystemAssetStore({ directory, now: () => now });

  await store.put(input(), putOptions({ ttlSeconds: 60 }));
  await store.put(input(), putOptions({ ttlSeconds: 3_600 }));
  assert.equal(await store.purgeExpired(), 0);

  now = new Date('2026-01-01T00:10:00.000Z');
  assert.equal(await store.purgeExpired(), 1);
  assert.equal(readdirSync(directory).length, 2, 'only the surviving asset and its sidecar remain');
});

test('filesystem: enforces a per-asset size cap', async () => {
  const store = new FilesystemAssetStore({ directory: tempDirectory(), maxAssetBytes: 4 });
  await assert.rejects(() => store.put(input(), putOptions()), AssetStoreCapacityError);
});

test('filesystem: refuses an asset id that escapes the directory', async () => {
  const store = new FilesystemAssetStore({
    directory: tempDirectory(),
    createAssetId: () => '../../escape',
  });
  await assert.rejects(() => store.put(input(), putOptions()), AssetStoreValidationError);
});

test('filesystem: signing requires a signer', async () => {
  const directory = tempDirectory();
  const unsigned = new FilesystemAssetStore({ directory });
  const stat = await unsigned.put(input(), putOptions());
  await assert.rejects(() => unsigned.sign(stat.assetId, 'tenant-a'), AssetStoreSigningError);

  const signed = new FilesystemAssetStore({
    directory,
    signer: (ctx) => `https://cdn.example/${ctx.assetId}`,
  });
  assert.equal(await signed.sign(stat.assetId, 'tenant-a'), `https://cdn.example/${stat.assetId}`);
  assert.equal(await signed.sign('missing', 'tenant-a'), undefined);
});

// ── S3 specifics ───────────────────────────────────────────────────

test('s3: writes the payload and sidecar under the configured prefix', async () => {
  const { client, objects } = fakeS3();
  const store = new S3AssetStore({ client, bucket: 'assets', prefix: 'tenant-media/' });
  const stat = await store.put(input(), putOptions());

  assert.ok(objects.has(`assets/tenant-media/objects/${stat.assetId}`));
  assert.ok(objects.has(`assets/tenant-media/records/${stat.assetId}.json`));
  assert.equal(stat.descriptor.location.kind, 'stored');
});

test('s3: purgeExpired deletes only lapsed records', async () => {
  const { client, objects } = fakeS3();
  let now = new Date('2026-01-01T00:00:00.000Z');
  const store = new S3AssetStore({ client, bucket: 'assets', now: () => now });

  await store.put(input(), putOptions({ ttlSeconds: 60 }));
  await store.put(input(), putOptions({ ttlSeconds: 7_200 }));
  assert.equal(await store.purgeExpired(), 0);

  now = new Date('2026-01-01T00:30:00.000Z');
  assert.equal(await store.purgeExpired(), 1);
  assert.equal(objects.size, 2);
});

test('s3: presigns through the client when no signer is configured', async () => {
  const { client } = fakeS3();
  let signedKey: string | undefined;
  const store = new S3AssetStore({
    client: {
      ...client,
      getSignedUrl: async ({ key, expiresInSeconds }) => {
        signedKey = key;
        return `https://s3.example/${key}?expires=${expiresInSeconds ?? 0}`;
      },
    },
    bucket: 'assets',
  });

  const stat = await store.put(input(), putOptions());
  const url = await store.sign(stat.assetId, 'tenant-a', { expiresInSeconds: 300 });

  assert.match(String(url), /expires=300$/);
  assert.ok(signedKey?.endsWith(stat.assetId));
});

test('s3: a configured signer takes precedence over the client', async () => {
  const { client } = fakeS3();
  const store = new S3AssetStore({
    client: { ...client, getSignedUrl: async () => 'https://from-client' },
    bucket: 'assets',
    signer: () => 'https://from-signer',
  });

  const stat = await store.put(input(), putOptions());
  assert.equal(await store.sign(stat.assetId, 'tenant-a'), 'https://from-signer');
});

test('s3: signing fails clearly when nothing can presign', async () => {
  const { client } = fakeS3();
  const store = new S3AssetStore({ client, bucket: 'assets' });
  const stat = await store.put(input(), putOptions());

  await assert.rejects(() => store.sign(stat.assetId, 'tenant-a'), AssetStoreSigningError);
});

test('s3: requires a client and a bucket', () => {
  assert.throws(() => new S3AssetStore({ client: undefined as never, bucket: 'b' }), AssetStoreValidationError);
  assert.throws(() => new S3AssetStore({ client: fakeS3().client, bucket: '' }), AssetStoreValidationError);
});

test('s3: tenant is copied onto object metadata for lifecycle rules', async () => {
  const seen: Array<Record<string, string> | undefined> = [];
  const { client } = fakeS3();
  const store = new S3AssetStore({
    client: {
      ...client,
      putObject: async (params) => {
        seen.push(params.metadata);
        await client.putObject(params);
      },
    },
    bucket: 'assets',
  });

  await store.put(input(), putOptions());
  assert.equal(seen[0]?.tenant, 'tenant-a');
  assert.ok(seen[0]?.checksum);
});
