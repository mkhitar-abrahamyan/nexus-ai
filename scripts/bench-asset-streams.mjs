#!/usr/bin/env node
/**
 * A gigabyte through each streaming asset store and back, while memory stays flat: the evidence that
 * `putStream()` and `getStream()` never hold an asset whole. Run on its own, after the unit tests, so
 * moving a gigabyte never slows a timing-sensitive test running beside it.
 *
 *   node scripts/bench-asset-streams.mjs              # 1 GiB, fails when memory grows by 128 MB or more
 *   node scripts/bench-asset-streams.mjs --bytes 268435456
 *
 * Runs against the built package in `dist/`; run `npm run build` first.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const { FilesystemAssetStore, S3AssetStore } = await import('../dist/images/asset-stores.js');
const { putAssetStream, readAssetStream } = await import('../dist/images/assets.js');

const args = process.argv.slice(2);
const flag = args.indexOf('--bytes');
const size = flag >= 0 ? Number(args[flag + 1]) : 1024 * 1024 * 1024;
const BUDGET_MB = 128;
const owner = { tenantId: 'bench', provenance: { provider: 'bench', requestId: 'r', operation: 'generate' } };

/** An S3 client over a directory, streaming both ways, as a multipart upload and a ranged GET do. */
function directoryS3(root) {
  const file = (key) => path.join(root, encodeURIComponent(key));
  return {
    async putObject({ key, body }) {
      await pipeline(Readable.from([Buffer.from(body)]), createWriteStream(file(key)));
    },
    async getObject({ key }) {
      const parts = [];
      for await (const part of createReadStream(file(key))) parts.push(part);
      return { body: new Uint8Array(Buffer.concat(parts)) };
    },
    async deleteObject({ key }) {
      rmSync(file(key), { force: true });
    },
    async listObjects() {
      return [];
    },
    async putObjectStream({ key, body }) {
      await pipeline(Readable.fromWeb(body), createWriteStream(file(key)));
    },
    async getObjectStream({ key, range }) {
      return { body: Readable.toWeb(createReadStream(file(key), range ?? {})) };
    },
  };
}

async function* chunks(hash) {
  for (let offset = 0; offset < size; offset += 1024 * 1024) {
    const bytes = new Uint8Array(Math.min(1024 * 1024, size - offset));
    for (let index = 0; index < bytes.length; index += 4096) bytes[index] = (offset + index) % 251;
    hash.update(bytes);
    yield bytes;
  }
}

const directories = [];
const temporary = () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'nexus-bench-streams-'));
  directories.push(directory);
  return directory;
};

let failed = false;
try {
  for (const [name, store] of [
    ['filesystem', new FilesystemAssetStore({ directory: temporary() })],
    ['s3', new S3AssetStore({ client: directoryS3(temporary()), bucket: 'bench' })],
  ]) {
    const memory = () => process.memoryUsage().arrayBuffers + process.memoryUsage().heapUsed;
    const before = memory();
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, memory());
    }, 25);
    const started = performance.now();
    const written = createHash('sha256');
    const stat = await putAssetStream(store, { stream: chunks(written), mimeType: 'video/mp4' }, owner);
    const read = await readAssetStream(store, stat.assetId, 'bench');
    const back = createHash('sha256');
    let length = 0;
    await read.stream.pipeTo(
      Writable.toWeb(
        new Writable({
          write(chunk, _encoding, done) {
            back.update(chunk);
            length += chunk.length;
            done();
          },
        }),
      ),
    );
    clearInterval(sampler);
    const seconds = (performance.now() - started) / 1000;
    const grewMb = (peak - before) / 1024 / 1024;
    const digest = written.digest('hex');
    const whole = length === size && back.digest('hex') === digest && stat.descriptor.checksum?.value === digest;
    const within = grewMb < BUDGET_MB;
    if (!whole || !within) failed = true;
    console.log(
      `${whole && within ? 'ok' : 'not ok'} - ${name}: ${(size / 1024 / 1024).toFixed(0)} MB in and out in ${seconds.toFixed(1)} s; memory grew ${grewMb.toFixed(0)} MB (budget ${BUDGET_MB} MB)${whole ? '' : '; the bytes did not come back whole'}`,
    );
  }
} finally {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
