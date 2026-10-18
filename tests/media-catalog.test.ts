/**
 * A media catalog over every stored asset, proved on every long-term store: memory, SQLite,
 * Postgres, and Redis.
 *
 * Every asset stored through a catalogued asset store is recorded, and only those: a deleted one is
 * forgotten, an expired one is never read and is purged with its asset. Entries are found by kind,
 * type, provider, model, run, tag, time, and score, a page at a time with none read twice. Scores
 * given at once by many evaluators are all kept. An asset deleted around the catalog is reconciled
 * away, and an asset the catalog could not record is not left stored.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { AssetStat, AssetStore } from '../src/images/asset-support.js';
import { FilesystemAssetStore } from '../src/images/asset-stores.js';
import { MemoryAssetStore } from '../src/images/assets.js';
import { catalogedAssetStore, type MediaCatalog, type MediaCatalogEntry, mediaCatalog } from '../src/media/catalog.js';
import type { PostgresLikeClient } from '../src/postgres/client.js';
import { PostgresStore } from '../src/postgres/store.js';
import { SqliteStore } from '../src/sqlite/store.js';
import { MemoryStore } from '../src/store/memory.js';
import { RedisStore } from '../src/store/redis.js';
import type { Store } from '../src/types/store.js';
import { FakeRedis } from './redis-fake.js';

let pg: PGlite;
let redis: FakeRedis;
let sqlite: SqliteStore;
const scratch = mkdtempSync(path.join(tmpdir(), 'nexus-catalog-'));
let tables = 0;

before(async () => {
  pg = new PGlite();
  await pg.waitReady;
  redis = await FakeRedis.create();
  sqlite = new SqliteStore(new DatabaseSync(':memory:'));
  await sqlite.migrate();
});
after(async () => {
  await pg.close();
  redis.close();
  rmSync(scratch, { recursive: true, force: true });
});

async function stores(): Promise<Array<[string, Store]>> {
  tables += 1;
  const postgres = new PostgresStore(pg as unknown as PostgresLikeClient, { table: `catalog_${tables}` });
  await postgres.migrate();
  return [
    ['memory', new MemoryStore()],
    ['sqlite', sqlite],
    ['postgres', postgres],
    ['redis', new RedisStore(redis as never, { prefix: `catalog-${tables}` })],
  ];
}

const png = (width: number, height: number) => {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};

/** What a test stores: a medium of some kind, from some provider, for some run. */
interface Planned {
  tenantId: string;
  mimeType: string;
  provider: string;
  model: string;
  runId: string;
  ttlSeconds?: number;
  width?: number;
}
function plan(n: number): Planned {
  const kinds = ['image/png', 'image/webp', 'audio/wav', 'video/mp4', 'application/pdf'];
  return {
    tenantId: n % 4 === 3 ? 'globex' : 'acme',
    mimeType: kinds[n % kinds.length] as string,
    provider: n % 2 === 0 ? 'openai' : 'google',
    model: n % 2 === 0 ? 'gpt-image-1' : 'imagen-4',
    runId: `run-${Math.floor(n / 3)}`,
    ...(n % 6 === 5 ? { ttlSeconds: 60 } : {}),
    ...(n % kinds.length === 0 ? { width: 1000 + n } : {}),
  };
}

async function put(assets: AssetStore, item: Planned, n: number): Promise<AssetStat> {
  return assets.put(
    {
      location: {
        kind: 'bytes',
        data: item.mimeType === 'image/png' ? png(item.width ?? 1, 1) : new Uint8Array(10 + n),
      },
      mimeType: item.mimeType,
    },
    {
      tenantId: item.tenantId,
      provenance: {
        provider: item.provider,
        model: item.model,
        operation: 'generate',
        requestId: `request-${n}`,
        metadata: { runId: item.runId },
      },
      ...(item.width ? { width: item.width, height: 1 } : {}),
      ...(item.ttlSeconds ? { ttlSeconds: item.ttlSeconds } : {}),
    },
  ) as Promise<AssetStat>;
}

async function everything(
  catalog: MediaCatalog,
  query: Parameters<MediaCatalog['list']>[0],
): Promise<MediaCatalogEntry[]> {
  const all: MediaCatalogEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await catalog.list({ ...query, ...(cursor ? { cursor } : {}) });
    all.push(...page.entries);
    cursor = page.next;
  } while (cursor);
  return all;
}

test('proof: the catalog holds every stored asset, and only those, on every long-term store', async () => {
  for (const [name, store] of await stores()) {
    let clock = Date.parse('2026-10-18T12:00:00.000Z');
    const now = () => new Date(clock);
    const catalog = mediaCatalog({ store, namespace: ['media', name], now });
    const assets = catalogedAssetStore(new MemoryAssetStore({ now, maxEntries: 1_000 }), catalog, {
      name: 'memory',
      tags: (stat) => (stat.descriptor.mimeType.startsWith('image/') ? ['visual'] : undefined),
    });
    const stored = new Map<string, Planned & { assetId: string }>();
    for (let n = 0; n < 40; n += 1) {
      clock += 1_000;
      const item = plan(n);
      const stat = await put(assets, item, n);
      stored.set(stat.assetId, { ...item, assetId: stat.assetId });
    }
    // Some are deleted again.
    for (const [assetId, item] of [...stored].filter((_, index) => index % 7 === 0)) {
      assert.equal(await assets.delete(assetId, item.tenantId), true);
      stored.delete(assetId);
    }

    const acme = [...stored.values()].filter((item) => item.tenantId === 'acme');
    const listed = await everything(catalog, { tenantId: 'acme', limit: 7 });
    assert.deepEqual(
      listed.map((entry) => entry.assetId).sort(),
      acme.map((item) => item.assetId).sort(),
      `${name}: acme's assets, each once, across pages`,
    );
    assert.equal(new Set(listed.map((entry) => entry.assetId)).size, listed.length, `${name}: no entry on two pages`);
    assert.equal((await everything(catalog, {})).length, stored.size, `${name}: every tenant's`);

    // Found by what they are, who made them, and when.
    const images = await everything(catalog, { tenantId: 'acme', kind: 'image' });
    assert.deepEqual(
      images.map((entry) => entry.assetId).sort(),
      acme
        .filter((item) => item.mimeType.startsWith('image/'))
        .map((item) => item.assetId)
        .sort(),
      `${name}: by kind`,
    );
    assert.ok(
      images.every((entry) => entry.tags.includes('visual')),
      `${name}: tagged as stored`,
    );
    const tagged = await everything(catalog, { tenantId: 'acme', tag: 'visual' });
    assert.equal(tagged.length, images.length, `${name}: by tag`);
    const google = await everything(catalog, { tenantId: 'acme', provider: 'google', model: 'imagen-4' });
    assert.equal(google.length, acme.filter((item) => item.provider === 'google').length, `${name}: by provider`);
    const run = await everything(catalog, { runId: 'run-4' });
    assert.deepEqual(
      run.map((entry) => entry.assetId).sort(),
      [...stored.values()]
        .filter((item) => item.runId === 'run-4')
        .map((item) => item.assetId)
        .sort(),
      `${name}: by run`,
    );
    assert.ok(
      run.every((entry) => entry.runId === 'run-4' && entry.operation === 'generate'),
      `${name}: each from that run`,
    );
    const pdfs = await everything(catalog, { mimeType: 'application/pdf', since: '2026-10-18T12:00:20.000Z' });
    assert.ok(
      pdfs.length > 0 &&
        pdfs.every((entry) => entry.kind === 'document' && entry.createdAt >= '2026-10-18T12:00:20.000Z'),
      `${name}: by type and time`,
    );
    const first = images.find((entry) => entry.width !== undefined);
    assert.ok(first?.bytes && first.sha256?.length === 64 && first.uri.length > 0, `${name}: what the store knows`);

    const stats = await catalog.stats({ tenantId: 'acme' });
    assert.equal(stats.assets, acme.length, `${name}: stats count`);
    assert.equal(stats.byKind.image?.assets, images.length, `${name}: stats by kind`);

    // An hour on, the assets kept for a minute are gone, and so are their entries.
    clock += 3_600_000;
    const expiring = [...stored.values()].filter((item) => item.ttlSeconds);
    assert.ok(expiring.length > 0, 'some assets expire');
    for (const item of expiring) {
      assert.equal(
        await catalog.get(item.assetId, item.tenantId),
        undefined,
        `${name}: an expired entry is never read`,
      );
    }
    assert.equal((await everything(catalog, {})).length, stored.size - expiring.length, `${name}: nor listed`);
    await assets.purgeExpired();
    const left = await store.search(['media', name], { limit: 1_000 });
    assert.equal(left.length, stored.size - expiring.length, `${name}: purged with the assets`);
  }
});

test('scores: the latest per key, kept when many evaluators score one asset at once, and searchable', async () => {
  for (const [name, store] of await stores()) {
    const catalog = mediaCatalog({ store, namespace: ['scores', name] });
    const assets = catalogedAssetStore(new MemoryAssetStore(), catalog);
    const stats = await Promise.all(
      Array.from({ length: 6 }, (_, n) => put(assets, { ...plan(0), width: 100 * (n + 1) }, n)),
    );
    const [target] = stats as [AssetStat];
    // Ten evaluators score the same asset at the same moment: no score is lost.
    await Promise.all(
      Array.from({ length: 10 }, (_, n) =>
        catalog.score(target.assetId, 'acme', { key: `check-${n}`, score: n / 10, source: 'online' }),
      ),
    );
    const entry = await catalog.get(target.assetId, 'acme');
    assert.equal(Object.keys(entry?.scores ?? {}).length, 10, `${name}: every score kept`);
    assert.equal(entry?.scores['check-3']?.source, 'online');

    // Scores reach assets through what an output refers to, as an online evaluation's hook does.
    const output = { images: stats.slice(1).map((stat) => stat.descriptor), note: 'drawn' };
    const attached = await Promise.all(
      [0.2, 0.9].map((value, index) =>
        catalog.attach(
          index === 0 ? { images: output.images.slice(0, 2) } : { images: output.images.slice(2) },
          [{ key: 'sharpness', score: value, passed: value > 0.5 }],
          { tenantId: 'acme', source: 'judge' },
        ),
      ),
    );
    assert.deepEqual(attached, [2, 3], `${name}: scored through the output`);
    const blurry = await everything(catalog, { tenantId: 'acme', scoreBelow: { key: 'sharpness', below: 0.5 } });
    assert.deepEqual(
      blurry.map((item) => item.assetId).sort(),
      stats
        .slice(1, 3)
        .map((stat) => stat.assetId)
        .sort(),
      `${name}: found by a low score`,
    );
    assert.equal(
      (await everything(catalog, { tenantId: 'acme', scoreAtLeast: { key: 'sharpness', atLeast: 0.5 } })).length,
      3,
    );
    assert.equal(
      (await everything(catalog, { tenantId: 'acme', unscored: 'sharpness' })).length,
      1,
      `${name}: unscored`,
    );

    // Tags change too, and a score for an asset the catalog does not hold changes nothing.
    await catalog.tag(target.assetId, 'acme', { add: ['hero', 'q4'], remove: ['q4'] });
    assert.deepEqual(
      (await everything(catalog, { tenantId: 'acme', tag: 'hero' })).map((item) => item.assetId),
      [target.assetId],
    );
    assert.deepEqual(await everything(catalog, { tenantId: 'acme', tag: 'q4' }), [], `${name}: a tag removed`);
    assert.equal(await catalog.score('missing', 'acme', { key: 'x', score: 1 }), undefined);
  }
});

test('an asset deleted around the catalog is reconciled away, on the filesystem store too', async () => {
  const catalog = mediaCatalog({ store: new MemoryStore() });
  const files = new FilesystemAssetStore({ directory: path.join(scratch, 'files') });
  const assets = catalogedAssetStore(files, catalog, { name: 'files' });
  const kept = await put(assets, plan(0), 0);
  const gone = await put(assets, plan(4), 4);
  // Deleted on the store itself, which the catalog never hears of.
  await files.delete(gone.assetId, gone.tenantId);
  assert.ok(await catalog.get(gone.assetId, gone.tenantId), 'still catalogued');
  assert.deepEqual(await catalog.reconcile(files, { store: 'files' }), { checked: 2, removed: 1 });
  assert.equal(await catalog.get(gone.assetId, gone.tenantId), undefined);
  assert.equal((await catalog.get(kept.assetId, kept.tenantId))?.store, 'files');
});

test('an asset the catalog cannot record is not left stored, unless failures are only to be reported', async () => {
  const failing: Store = Object.assign(new MemoryStore(), {
    putIfVersion: () => {
      throw new Error('the catalog database is down');
    },
  });
  const memory = new MemoryAssetStore();
  const strict = catalogedAssetStore(memory, mediaCatalog({ store: failing }));
  await assert.rejects(put(strict, plan(0), 0), /the catalog database is down/);
  assert.equal(memory.snapshot().entries, 0, 'the asset was deleted again');

  const reported: unknown[] = [];
  const lenient = catalogedAssetStore(memory, mediaCatalog({ store: failing }), {
    onError: (error) => reported.push(error),
  });
  const stat = await put(lenient, plan(0), 0);
  assert.ok(memory.get(stat.assetId, stat.tenantId), 'kept');
  assert.equal(reported.length, 1);
});

test('an asset id stored again after its entry expired is recorded afresh', async () => {
  for (const [name, store] of await stores()) {
    let clock = Date.parse('2026-10-18T12:00:00.000Z');
    const now = () => new Date(clock);
    const catalog = mediaCatalog({ store, namespace: ['again', name], now });
    const assets = catalogedAssetStore(new MemoryAssetStore({ now, createAssetId: () => 'banner-1' }), catalog);
    await put(assets, { ...plan(0), ttlSeconds: 30 }, 0);
    await catalog.score('banner-1', 'acme', { key: 'sharpness', score: 0.1 });
    clock += 31_000;
    assert.equal(await catalog.get('banner-1', 'acme'), undefined, `${name}: expired`);
    // The same id, stored again before anything purged the old entry.
    await put(assets, plan(1), 1);
    const entry = await catalog.get('banner-1', 'acme');
    assert.ok(entry, `${name}: recorded again`);
    assert.deepEqual([entry.requestId, entry.scores, entry.expiresAt], ['request-1', {}, undefined], `${name}: afresh`);
  }
});

test('a store without compare-and-set expires entries itself, with the asset', async () => {
  let clock = Date.parse('2026-10-18T12:00:00.000Z');
  const now = () => new Date(clock);
  const plain = new MemoryStore({ now });
  // As a store of your own might be: no putIfVersion.
  const store: Store = {
    put: plain.put.bind(plain),
    get: plain.get.bind(plain),
    delete: plain.delete.bind(plain),
    search: plain.search.bind(plain),
    listNamespaces: plain.listNamespaces.bind(plain),
  };
  const catalog = mediaCatalog({ store, now });
  const assets = catalogedAssetStore(new MemoryAssetStore({ now }), catalog);
  const stat = await put(assets, { ...plan(0), ttlSeconds: 30 }, 0);
  assert.ok(await catalog.get(stat.assetId, 'acme'));
  clock += 31_000;
  assert.equal(await plain.get(['nexus', 'media', 'acme'], stat.assetId), undefined, 'the store expired it');
});
