/**
 * The vector stores against real servers: the contract, and the graduation checklist. Opt-in: each
 * store runs only when its environment variables are set, every check in a collection or namespace
 * of its own that is removed afterwards.
 *
 *   NEXUS_LIVE_QDRANT_URL      [NEXUS_LIVE_QDRANT_API_KEY]
 *   NEXUS_LIVE_PINECONE_HOST   NEXUS_LIVE_PINECONE_API_KEY   (an index of 64 dimensions, cosine metric)
 *   NEXUS_LIVE_WEAVIATE_URL    [NEXUS_LIVE_WEAVIATE_API_KEY]
 *   NEXUS_LIVE_CHROMA_URL      [NEXUS_LIVE_CHROMA_API_KEY]
 *   NEXUS_LIVE_REDIS_URL       (Redis with RediSearch; needs `ioredis` installed)
 *   NEXUS_LIVE_SETTLE_MS       time to wait for writes to become searchable; Pinecone defaults to 10 s
 *   NEXUS_LIVE_P95_MS          the search latency budget under load. Defaults to 200 ms
 *   NEXUS_LIVE_SOAK_CYCLES     write, search, and delete cycles in the soak. Defaults to 1,000
 *   NEXUS_LIVE_REPORT          a file to write every measurement to, as JSON
 *
 * Each store runs: the contract and typed filters; ten writers racing on the same ids; what 2.7.0
 * wrote, read by this release; tenant isolation; search latency over 2,000 chunks; and a soak whose
 * heap growth must stay under 8 MB. Run with `npm run test:vectors:live`, which exposes the collector.
 */
import { writeFileSync } from 'node:fs';
import * as v27chroma from 'nexus-ai-pro-2-7/rag/chroma';
import * as v27pinecone from 'nexus-ai-pro-2-7/rag/pinecone';
import * as v27qdrant from 'nexus-ai-pro-2-7/rag/qdrant';
import * as v27redis from 'nexus-ai-pro-2-7/rag/redis';
import * as v27weaviate from 'nexus-ai-pro-2-7/rag/weaviate';
import { createHashEmbeddings, type VectorStore } from '../src/hallucination/retrieval.js';
import { ChromaVectorStore } from '../src/rag/chroma.js';
import { PineconeVectorStore } from '../src/rag/pinecone.js';
import { QdrantVectorStore } from '../src/rag/qdrant.js';
import { RedisVectorStore } from '../src/rag/redis.js';
import { WeaviateVectorStore } from '../src/rag/weaviate.js';
import { tenantVectorStore } from '../src/tenancy/index.js';
import { type Settle, typedFilterContract, vectorStoreContract } from './vector-contract.js';
import { concurrentWriters, load, soak, upgradeFrom } from './vector-graduation.js';

const DIMENSIONS = 64;
const SOAK_MB = 8;
const embed = (texts: string[]) => createHashEmbeddings(texts, DIMENSIONS);
const run = `nexus_live_${Date.now().toString(36)}`;
const env = process.env;
const wait =
  (ms: number): Settle =>
  () =>
    new Promise((resolve) => setTimeout(resolve, ms));
const settleMs = (fallback: number) => (env.NEXUS_LIVE_SETTLE_MS ? Number(env.NEXUS_LIVE_SETTLE_MS) : fallback);
const p95Budget = Number(env.NEXUS_LIVE_P95_MS ?? 200);
const soakCycles = Number(env.NEXUS_LIVE_SOAK_CYCLES ?? 1_000);

/** Every field any check filters on, declared wherever a store wants its fields declared. */
const FIELDS = ['tenant', 'page', 'writer', 'tenantId'];

/** A fresh store over a collection of its own, the same collection as 2.7.0 sees it, and its cleanup. */
interface Opened {
  store: VectorStore;
  previous: VectorStore;
  cleanup: () => Promise<void>;
}

interface LiveStore {
  name: string;
  typedFilters: boolean;
  settle: Settle;
  /** Skipped checks, each with why. */
  skip?: Record<string, string>;
  open: (label: string) => Promise<Opened>;
}

const stores: LiveStore[] = [];

if (env.NEXUS_LIVE_QDRANT_URL) {
  const url = env.NEXUS_LIVE_QDRANT_URL.replace(/\/+$/, '');
  const apiKey = env.NEXUS_LIVE_QDRANT_API_KEY;
  const headers: Record<string, string> = apiKey ? { 'api-key': apiKey } : {};
  stores.push({
    name: 'qdrant',
    typedFilters: false,
    settle: wait(settleMs(0)),
    open: async (label) => {
      const options = { url, collection: `${run}_${label}`, dimensions: DIMENSIONS, embed, apiKey };
      const store = new QdrantVectorStore(options);
      await store.migrate({
        filterFields: { tenant: 'keyword', page: 'integer', writer: 'integer', tenantId: 'keyword' },
      });
      return {
        store,
        previous: new v27qdrant.QdrantVectorStore(options),
        cleanup: async () => {
          await fetch(`${url}/collections/${options.collection}`, { method: 'DELETE', headers });
        },
      };
    },
  });
}

if (env.NEXUS_LIVE_PINECONE_HOST && env.NEXUS_LIVE_PINECONE_API_KEY) {
  const host = env.NEXUS_LIVE_PINECONE_HOST;
  const apiKey = env.NEXUS_LIVE_PINECONE_API_KEY;
  stores.push({
    name: 'pinecone',
    typedFilters: true,
    settle: wait(settleMs(10_000)),
    open: async (label) => {
      const options = { host, apiKey, namespace: `${run}_${label}`, dimensions: DIMENSIONS, embed };
      return {
        store: new PineconeVectorStore(options),
        previous: new v27pinecone.PineconeVectorStore(options),
        cleanup: async () => {
          const base = host.startsWith('http') ? host : `https://${host}`;
          await fetch(`${base.replace(/\/+$/, '')}/vectors/delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'Api-Key': apiKey, 'X-Pinecone-API-Version': '2025-04' },
            body: JSON.stringify({ deleteAll: true, namespace: options.namespace }),
          });
        },
      };
    },
  });
}

if (env.NEXUS_LIVE_WEAVIATE_URL) {
  const url = env.NEXUS_LIVE_WEAVIATE_URL.replace(/\/+$/, '');
  const apiKey = env.NEXUS_LIVE_WEAVIATE_API_KEY;
  stores.push({
    name: 'weaviate',
    typedFilters: true,
    settle: wait(settleMs(0)),
    open: async (label) => {
      const collection = `Nexus${`${run}${label}`.replace(/[^A-Za-z0-9]/g, '')}`;
      const options = { url, collection, dimensions: DIMENSIONS, embed, apiKey };
      const store = new WeaviateVectorStore(options);
      await store.migrate({ filterFields: { tenant: 'text', page: 'number', writer: 'number', tenantId: 'text' } });
      return {
        store,
        previous: new v27weaviate.WeaviateVectorStore(options),
        cleanup: async () => {
          await fetch(`${url}/v1/schema/${collection}`, {
            method: 'DELETE',
            headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
          });
        },
      };
    },
  });
}

if (env.NEXUS_LIVE_CHROMA_URL) {
  const url = env.NEXUS_LIVE_CHROMA_URL.replace(/\/+$/, '');
  const apiKey = env.NEXUS_LIVE_CHROMA_API_KEY;
  for (const declared of [false, true]) {
    stores.push({
      name: declared ? 'chroma (declared fields)' : 'chroma',
      typedFilters: true,
      settle: wait(settleMs(0)),
      ...(declared
        ? {}
        : { skip: { race: 'without declared fields, racing writers can leave a stale field; the guide says so' } }),
      open: async (label) => {
        const collection = `${run}_${declared ? 'declared_' : ''}${label}`;
        const options = { url, collection, dimensions: DIMENSIONS, embed, apiKey };
        const store = new ChromaVectorStore({ ...options, ...(declared ? { filterFields: FIELDS } : {}) });
        await store.migrate();
        return {
          store,
          previous: new v27chroma.ChromaVectorStore(options),
          cleanup: async () => {
            await fetch(`${url}/api/v2/tenants/default_tenant/databases/default_database/collections/${collection}`, {
              method: 'DELETE',
              headers: apiKey ? { 'x-chroma-token': apiKey } : {},
            });
          },
        };
      },
    });
  }
}

if (env.NEXUS_LIVE_REDIS_URL) {
  const url = env.NEXUS_LIVE_REDIS_URL;
  type Client = { call(...args: unknown[]): Promise<unknown>; quit(): Promise<unknown> };
  const connect = async (protocol?: number): Promise<Client> => {
    const specifier = 'ioredis';
    const { default: Redis } = (await import(specifier)) as {
      default: new (url: string, options: { protocol?: number }) => Client;
    };
    return new Redis(url, protocol ? { protocol } : {});
  };
  // ioredis 6 speaks RESP3 by default, where a search replies with a map; RESP2 replies with an array.
  for (const [name, protocol] of [
    ['redis', undefined],
    ['redis (RESP2)', 2],
  ] as const) {
    stores.push({
      name,
      typedFilters: true,
      settle: wait(settleMs(0)),
      open: async (label) => {
        const client = await connect(protocol);
        // 2.7.0 reads RESP2 only, and sends through `sendCommand` when a client has one.
        const old = await connect(2);
        const index = `${run}:${protocol ?? 3}:${label}:idx`;
        const options = {
          dimensions: DIMENSIONS,
          embed,
          index,
          prefix: `${run}:${protocol ?? 3}:${label}:`,
          filterFields: FIELDS,
        };
        const store = new RedisVectorStore(client as never, options);
        await store.migrate();
        return {
          store,
          previous: new v27redis.RedisVectorStore(
            { call: (...args: unknown[]) => old.call(...args) } as never,
            options,
          ),
          cleanup: async () => {
            await client.call('FT.DROPINDEX', index, 'DD');
            await Promise.all([client.quit(), old.quit()]);
          },
        };
      },
    });
  }
}

if (stores.length === 0) {
  console.log(
    'No live vector stores configured. Set NEXUS_LIVE_*_URL variables to run the contract against real servers.',
  );
  process.exit(0);
}

const tenantIsolation = async (name: string, store: VectorStore, settle: Settle) => {
  const a = tenantVectorStore(store, 'acme');
  const b = tenantVectorStore(store, 'globex');
  await a.add([{ id: 'refund-policy', content: 'acme refunds within thirty days', metadata: { lang: 'en' } }]);
  await b.add([{ id: 'other', content: 'globex shipping times' }]);
  await settle();
  const own = (await a.search('refunds within thirty days', { topK: 5 })).map((result) => result.id);
  const theirs = (await b.search('refunds within thirty days', { topK: 5 })).map((result) => result.id);
  if (own.join() !== 'refund-policy' || theirs.join() !== 'other') {
    throw new Error(`${name}: a tenant saw another's chunks (acme saw ${own}, globex saw ${theirs})`);
  }
  await b.delete(['refund-policy']);
  await settle();
  if ((await a.search('refunds', { topK: 5 })).length !== 1) throw new Error(`${name}: a delete crossed tenants`);
};

const checks: Array<[string, (live: LiveStore, opened: Opened) => Promise<string | undefined>]> = [
  [
    'contract',
    async ({ name, settle, typedFilters }, { store }) => {
      await vectorStoreContract(name, store, embed, settle);
      if (typedFilters) await typedFilterContract(name, store, settle);
      return undefined;
    },
  ],
  [
    'race',
    async ({ name, settle }, { store }) => {
      await concurrentWriters(name, store, settle);
      return undefined;
    },
  ],
  [
    'upgrade',
    async ({ name, settle, typedFilters }, { store, previous }) => {
      await upgradeFrom(name, previous, store, { settle, typedFilters });
      return 'from 2.7.0';
    },
  ],
  [
    'tenants',
    async ({ name, settle }, { store }) => {
      await tenantIsolation(name, store, settle);
      return undefined;
    },
  ],
  [
    'load',
    async ({ name, settle }, { store }) => {
      const measured = await load(store, settle);
      report[`${name}.load`] = measured;
      if (measured.p95Ms > p95Budget) {
        throw new Error(`${name}: search p95 ${measured.p95Ms.toFixed(1)} ms is over the ${p95Budget} ms budget`);
      }
      return `${measured.chunks} chunks written in ${(measured.writeMs / 1000).toFixed(1)} s; search p50 ${measured.p50Ms.toFixed(1)} ms, p95 ${measured.p95Ms.toFixed(1)} ms`;
    },
  ],
  [
    'soak',
    async ({ name }, { store }) => {
      const measured = await soak(store, soakCycles);
      report[`${name}.soak`] = measured;
      if (measured.heapGrowthMb > SOAK_MB) {
        throw new Error(`${name}: the heap grew ${measured.heapGrowthMb.toFixed(1)} MB over the soak`);
      }
      return `${measured.cycles} cycles in ${(measured.elapsedMs / 1000).toFixed(1)} s; heap ${measured.heapGrowthMb.toFixed(1)} MB`;
    },
  ],
];

const report: Record<string, unknown> = {};
let failed = 0;
let passed = 0;
for (const live of stores) {
  for (const [check, body] of checks) {
    const reason = live.skip?.[check];
    if (reason) {
      console.log(`skip - ${live.name}: ${check} (${reason})`);
      continue;
    }
    let opened: Opened | undefined;
    try {
      opened = await live.open(check);
      const detail = await body(live, opened);
      passed++;
      console.log(`ok - ${live.name}: ${check}${detail ? ` (${detail})` : ''}`);
    } catch (error) {
      failed++;
      console.error(`not ok - ${live.name}: ${check}: ${(error as Error)?.message ?? error}`);
    } finally {
      await opened
        ?.cleanup()
        .catch((error: unknown) => console.error(`  cleanup of ${live.name} ${check} failed: ${error}`));
    }
  }
}
if (env.NEXUS_LIVE_REPORT) writeFileSync(env.NEXUS_LIVE_REPORT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`${passed} of ${passed + failed} live checks passed, on ${stores.length} vector stores.`);
process.exit(failed ? 1 : 0);
