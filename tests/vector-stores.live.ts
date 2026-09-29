/**
 * The vector store contract against real servers. Opt-in: each store runs only when its environment
 * variables are set, in a collection or namespace of its own that is removed afterwards.
 *
 *   NEXUS_LIVE_QDRANT_URL      [NEXUS_LIVE_QDRANT_API_KEY]
 *   NEXUS_LIVE_PINECONE_HOST   NEXUS_LIVE_PINECONE_API_KEY   (an index of 64 dimensions, cosine metric)
 *   NEXUS_LIVE_WEAVIATE_URL    [NEXUS_LIVE_WEAVIATE_API_KEY]
 *   NEXUS_LIVE_CHROMA_URL      [NEXUS_LIVE_CHROMA_API_KEY]
 *   NEXUS_LIVE_REDIS_URL       (Redis with RediSearch; needs `ioredis` installed)
 *   NEXUS_LIVE_SETTLE_MS       time to wait for writes to become searchable; Pinecone defaults to 10 s
 *
 * Run with `npm run test:vectors:live`.
 */
import { createHashEmbeddings, type VectorStore } from '../src/hallucination/retrieval.js';
import { ChromaVectorStore } from '../src/rag/chroma.js';
import { PineconeVectorStore } from '../src/rag/pinecone.js';
import { QdrantVectorStore } from '../src/rag/qdrant.js';
import { RedisVectorStore } from '../src/rag/redis.js';
import { WeaviateVectorStore } from '../src/rag/weaviate.js';
import { type Settle, typedFilterContract, vectorStoreContract } from './vector-contract.js';

const DIMENSIONS = 64;
const embed = (texts: string[]) => createHashEmbeddings(texts, DIMENSIONS);
const run = `nexus_live_${Date.now().toString(36)}`;
const env = process.env;
const wait =
  (ms: number): Settle =>
  () =>
    new Promise((resolve) => setTimeout(resolve, ms));
const settleMs = (fallback: number) => (env.NEXUS_LIVE_SETTLE_MS ? Number(env.NEXUS_LIVE_SETTLE_MS) : fallback);

interface LiveStore {
  name: string;
  create: () => Promise<{ store: VectorStore; typedFilters: boolean; settle: Settle; cleanup: () => Promise<void> }>;
}

const stores: LiveStore[] = [];

if (env.NEXUS_LIVE_QDRANT_URL) {
  const url = env.NEXUS_LIVE_QDRANT_URL.replace(/\/+$/, '');
  const headers: Record<string, string> = env.NEXUS_LIVE_QDRANT_API_KEY
    ? { 'api-key': env.NEXUS_LIVE_QDRANT_API_KEY }
    : {};
  stores.push({
    name: 'qdrant',
    create: async () => {
      const store = new QdrantVectorStore({
        url,
        collection: run,
        dimensions: DIMENSIONS,
        embed,
        apiKey: env.NEXUS_LIVE_QDRANT_API_KEY,
      });
      await store.migrate({ filterFields: ['tenant'] });
      return {
        store,
        typedFilters: false,
        settle: wait(settleMs(0)),
        cleanup: async () => {
          await fetch(`${url}/collections/${run}`, { method: 'DELETE', headers });
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
    create: async () => {
      const store = new PineconeVectorStore({ host, apiKey, namespace: run, dimensions: DIMENSIONS, embed });
      return {
        store,
        typedFilters: true,
        settle: wait(settleMs(10_000)),
        cleanup: async () => {
          const base = host.startsWith('http') ? host : `https://${host}`;
          await fetch(`${base.replace(/\/+$/, '')}/vectors/delete`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'Api-Key': apiKey, 'X-Pinecone-API-Version': '2025-04' },
            body: JSON.stringify({ deleteAll: true, namespace: run }),
          });
        },
      };
    },
  });
}

if (env.NEXUS_LIVE_WEAVIATE_URL) {
  const url = env.NEXUS_LIVE_WEAVIATE_URL.replace(/\/+$/, '');
  const apiKey = env.NEXUS_LIVE_WEAVIATE_API_KEY;
  const collection = `Nexus${run.replace(/[^A-Za-z0-9]/g, '')}`;
  stores.push({
    name: 'weaviate',
    create: async () => {
      const store = new WeaviateVectorStore({ url, collection, dimensions: DIMENSIONS, embed, apiKey });
      await store.migrate({ filterFields: { tenant: 'text', page: 'number' } });
      return {
        store,
        typedFilters: true,
        settle: wait(settleMs(0)),
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
  stores.push({
    name: 'chroma',
    create: async () => {
      const store = new ChromaVectorStore({ url, collection: run, dimensions: DIMENSIONS, embed, apiKey });
      await store.migrate();
      return {
        store,
        typedFilters: true,
        settle: wait(settleMs(0)),
        cleanup: async () => {
          await fetch(`${url}/api/v2/tenants/default_tenant/databases/default_database/collections/${run}`, {
            method: 'DELETE',
            headers: apiKey ? { 'x-chroma-token': apiKey } : {},
          });
        },
      };
    },
  });
}

if (env.NEXUS_LIVE_REDIS_URL) {
  const url = env.NEXUS_LIVE_REDIS_URL;
  stores.push({
    name: 'redis',
    create: async () => {
      const specifier = 'ioredis';
      const { default: Redis } = (await import(specifier)) as {
        default: new (url: string) => { call(...args: unknown[]): Promise<unknown>; quit(): Promise<unknown> };
      };
      const client = new Redis(url);
      const index = `${run}:idx`;
      const store = new RedisVectorStore(client as never, {
        dimensions: DIMENSIONS,
        embed,
        index,
        prefix: `${run}:`,
        filterFields: ['tenant', 'page'],
      });
      await store.migrate();
      return {
        store,
        typedFilters: true,
        settle: wait(settleMs(0)),
        cleanup: async () => {
          await client.call('FT.DROPINDEX', index, 'DD');
          await client.quit();
        },
      };
    },
  });
}

if (stores.length === 0) {
  console.log(
    'No live vector stores configured. Set NEXUS_LIVE_*_URL variables to run the contract against real servers.',
  );
  process.exit(0);
}

let failed = 0;
for (const { name, create } of stores) {
  let created: Awaited<ReturnType<LiveStore['create']>> | undefined;
  try {
    created = await create();
    await vectorStoreContract(name, created.store, embed, created.settle);
    if (created.typedFilters) await typedFilterContract(name, created.store, created.settle);
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}: ${(error as Error)?.message ?? error}`);
  } finally {
    await created?.cleanup().catch((error: unknown) => console.error(`  cleanup of ${name} failed: ${error}`));
  }
}
console.log(`${stores.length - failed} of ${stores.length} live vector stores passed the contract.`);
process.exit(failed ? 1 : 0);
