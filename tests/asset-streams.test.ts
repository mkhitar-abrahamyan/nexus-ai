/**
 * Streaming asset stores: an asset's bytes flow in and out a chunk at a time, with its size limit and
 * checksum checked as they flow, byte ranges read back, and memory flat however large the asset.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { after, test } from 'node:test';
import { FilesystemAssetStore, S3AssetStore, type S3LikeClient } from '../src/images/asset-stores.js';
import {
  AssetStoreCapacityError,
  AssetStoreValidationError,
  type AssetStore,
  MemoryAssetStore,
  putAssetStream,
  readAssetStream,
} from '../src/images/assets.js';

const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nexus-asset-streams-'));
  directories.push(directory);
  return directory;
};
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const owner = { tenantId: 'acme', provenance: { provider: 'test', requestId: 'r1', operation: 'generate' as const } };

/** A deterministic byte source of `size` bytes in 64 KiB chunks, and the SHA-256 it will hash to. */
function source(size: number, chunk = 65_536) {
  const hash = createHash('sha256');
  async function* chunks() {
    for (let offset = 0; offset < size; offset += chunk) {
      const bytes = new Uint8Array(Math.min(chunk, size - offset));
      for (let index = 0; index < bytes.length; index += 4096) bytes[index] = (offset + index) % 251;
      hash.update(bytes);
      yield bytes;
    }
  }
  let digest: string | undefined;
  return { stream: chunks(), digest: () => (digest ??= hash.digest('hex')) };
}

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of stream as unknown as AsyncIterable<Uint8Array>) parts.push(part);
  return new Uint8Array(Buffer.concat(parts));
}

/** An S3 client over a directory, streaming both ways, as a multipart upload and a ranged GET do. */
function directoryS3(root: string, streaming = true): S3LikeClient & { objects: () => string[] } {
  const file = (key: string) => path.join(root, encodeURIComponent(key));
  const client: S3LikeClient & { objects: () => string[] } = {
    objects: () => readdirSync(root).map(decodeURIComponent),
    async putObject({ key, body }) {
      await pipeline(Readable.from([Buffer.from(body)]), createWriteStream(file(key)));
    },
    async getObject({ key }) {
      const parts: Buffer[] = [];
      for await (const part of createReadStream(file(key))) parts.push(part as Buffer);
      return { body: new Uint8Array(Buffer.concat(parts)) };
    },
    async deleteObject({ key }) {
      rmSync(file(key), { force: true });
    },
    async listObjects({ prefix }) {
      return client
        .objects()
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key }));
    },
  };
  if (streaming) {
    client.putObjectStream = async ({ key, body }) => {
      await pipeline(Readable.fromWeb(body as never), createWriteStream(file(key)));
    };
    client.getObjectStream = async ({ key, range }) => ({
      body: Readable.toWeb(createReadStream(file(key), range ?? {})) as ReadableStream<Uint8Array>,
    });
  }
  return client;
}

/** A store with only the six required methods: the helpers carry streams through `put()` and `get()`. */
function plainStore(): AssetStore {
  const inner = new MemoryAssetStore({ maxAssetBytes: 8 * 1024 * 1024 });
  return {
    put: (input, options) => inner.put(input, options),
    get: (assetId, tenantId) => inner.get(assetId, tenantId),
    stat: (assetId, tenantId) => inner.stat(assetId, tenantId),
    delete: (assetId, tenantId) => inner.delete(assetId, tenantId),
    sign: (assetId, tenantId, options) => inner.sign(assetId, tenantId, options),
    purgeExpired: () => inner.purgeExpired(),
  };
}

test('every store takes a stream in and gives it back, whole or by range', async () => {
  const stores: Array<[string, AssetStore]> = [
    ['memory', new MemoryAssetStore({ maxAssetBytes: 8 * 1024 * 1024 })],
    ['filesystem', new FilesystemAssetStore({ directory: temporary() })],
    ['s3 (streaming client)', new S3AssetStore({ client: directoryS3(temporary()), bucket: 'b' })],
    ['s3 (plain client)', new S3AssetStore({ client: directoryS3(temporary(), false), bucket: 'b' })],
    ['a store without streams', plainStore()],
  ];
  const size = 3 * 1024 * 1024 + 17;
  for (const [name, store] of stores) {
    const { stream, digest } = source(size);
    const stat = await putAssetStream(store, { stream, mimeType: 'video/mp4', filename: 'clip.mp4' }, owner);
    assert.equal(stat.descriptor.byteLength, size, name);
    assert.equal(stat.descriptor.checksum?.value, digest(), `${name}: hashed as it flowed`);
    assert.equal(stat.descriptor.filename, 'clip.mp4');

    const whole = await readAssetStream(store, stat.assetId, 'acme');
    assert.ok(whole, name);
    const bytes = await bytesOf(whole.stream);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), digest(), `${name}: the same bytes come back`);
    assert.deepEqual(whole.range, { start: 0, end: size - 1 });
    assert.equal(whole.descriptor.location.kind, 'stored', `${name}: the descriptor points back at the store`);

    const middle = await readAssetStream(store, stat.assetId, 'acme', { range: { start: 100_000, end: 100_099 } });
    assert.deepEqual(
      await bytesOf(middle?.stream as ReadableStream<Uint8Array>),
      bytes.subarray(100_000, 100_100),
      name,
    );
    const tail = await readAssetStream(store, stat.assetId, 'acme', { range: { start: size - 10, end: size + 1_000 } });
    assert.deepEqual(tail?.range, { start: size - 10, end: size - 1 }, `${name}: an end past the asset is cut`);
    assert.equal((await bytesOf(tail?.stream as ReadableStream<Uint8Array>)).length, 10);
    await assert.rejects(
      readAssetStream(store, stat.assetId, 'acme', { range: { start: size } }),
      AssetStoreValidationError,
    );
    await assert.rejects(
      readAssetStream(store, stat.assetId, 'acme', { range: { start: 5, end: 2 } }),
      AssetStoreValidationError,
    );

    assert.equal(
      await readAssetStream(store, stat.assetId, 'globex'),
      undefined,
      `${name}: another tenant sees nothing`,
    );
    const held = await store.get(stat.assetId, 'acme');
    assert.equal(held?.location.data.byteLength, size, `${name}: get() reads what putStream() wrote`);
  }
});

test('a stream that breaks its limit or its checksum leaves nothing behind', async () => {
  const directory = temporary();
  const files = new FilesystemAssetStore({ directory, maxAssetBytes: 1024 * 1024 });
  const bucket = directoryS3(temporary());
  const s3 = new S3AssetStore({ client: bucket, bucket: 'b', maxAssetBytes: 1024 * 1024 });
  for (const [name, store] of [
    ['filesystem', files],
    ['s3', s3],
  ] as const) {
    await assert.rejects(
      putAssetStream(store, { stream: source(2 * 1024 * 1024).stream, mimeType: 'video/mp4' }, owner),
      (error: unknown) => {
        assert.ok(error instanceof AssetStoreCapacityError, name);
        assert.equal(error.constraint, 'maxAssetBytes');
        return true;
      },
    );
    await assert.rejects(
      putAssetStream(
        store,
        {
          stream: source(4096).stream,
          mimeType: 'image/png',
          checksum: { algorithm: 'sha256', value: '0'.repeat(64) },
        },
        owner,
      ),
      /checksum does not match/,
      name,
    );
  }
  assert.deepEqual(readdirSync(directory), [], 'no file left on disk');
  assert.deepEqual(bucket.objects(), [], 'no object left in the bucket');
  await assert.rejects(
    putAssetStream(files, { stream: 'not bytes' as never, mimeType: 'image/png' }, owner),
    /ReadableStream or an async iterable/,
  );
});

test('a store that cannot stream buffers within its limit, and no further', async () => {
  const store = plainStore();
  await assert.rejects(
    putAssetStream(
      store,
      { stream: source(2 * 1024 * 1024).stream, mimeType: 'video/mp4' },
      {
        ...owner,
        maxBufferedBytes: 1024 * 1024,
      },
    ),
    AssetStoreCapacityError,
  );
  const web = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
      controller.close();
    },
  });
  const stat = await putAssetStream(store, { stream: web, mimeType: 'application/octet-stream' }, owner);
  assert.equal(stat.descriptor.byteLength, 3, 'a web stream works as well as an async iterable');
});

test('proof: a gigabyte through each streaming store with flat memory', async () => {
  const size = Number(process.env.NEXUS_ASSET_STREAM_BYTES ?? 1024 * 1024 * 1024);
  const stores: Array<[string, AssetStore]> = [
    ['filesystem', new FilesystemAssetStore({ directory: temporary() })],
    ['s3', new S3AssetStore({ client: directoryS3(temporary()), bucket: 'b' })],
  ];
  for (const [name, store] of stores) {
    const memory = () => process.memoryUsage().arrayBuffers + process.memoryUsage().heapUsed;
    const before = memory();
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, memory());
    }, 25);
    try {
      const { stream, digest } = source(size, 1024 * 1024);
      const stat = await putAssetStream(store, { stream, mimeType: 'video/mp4' }, owner);
      assert.equal(stat.descriptor.byteLength, size);
      assert.equal(stat.descriptor.checksum?.value, digest(), name);
      const read = await readAssetStream(store, stat.assetId, 'acme');
      const hash = createHash('sha256');
      let length = 0;
      assert.ok(read);
      await read.stream.pipeTo(
        Writable.toWeb(
          new Writable({
            write(chunk: Uint8Array, _encoding, done) {
              hash.update(chunk);
              length += chunk.length;
              done();
            },
          }),
        ),
      );
      assert.equal(length, size);
      assert.equal(hash.digest('hex'), stat.descriptor.checksum?.value, `${name}: read back whole`);
    } finally {
      clearInterval(sampler);
    }
    const grewMb = (peak - before) / 1024 / 1024;
    assert.ok(grewMb < 128, `${name}: memory grew ${grewMb.toFixed(0)} MB to move ${size / 1024 / 1024} MB`);
  }
});
