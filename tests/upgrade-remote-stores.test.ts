/**
 * The upgrade from 2.7 for the remote vector stores that leave experimental status in 2.8: what the
 * published 2.7.0 package wrote, this release reads, filters, replaces, and deletes. 2.7.0 is the real
 * package from npm, installed as a development alias, writing into the same stand-in this release
 * reads from. The live suite runs the same check against the real servers.
 */
import { test } from 'node:test';
import * as v27chroma from 'nexus-ai-pro-2-7/rag/chroma';
import * as v27pinecone from 'nexus-ai-pro-2-7/rag/pinecone';
import * as v27qdrant from 'nexus-ai-pro-2-7/rag/qdrant';
import * as v27redis from 'nexus-ai-pro-2-7/rag/redis';
import * as v27weaviate from 'nexus-ai-pro-2-7/rag/weaviate';
import { createHashEmbeddings } from '../src/hallucination/retrieval.js';
import { ChromaVectorStore } from '../src/rag/chroma.js';
import { PineconeVectorStore } from '../src/rag/pinecone.js';
import { QdrantVectorStore } from '../src/rag/qdrant.js';
import { RedisVectorStore } from '../src/rag/redis.js';
import { WeaviateVectorStore } from '../src/rag/weaviate.js';
import { upgradeFrom } from './vector-graduation.js';
import { chromaStub, pineconeStub, qdrantStub, redisStub, weaviateStub } from './vector-stubs.js';

const dimensions = 64;
const embed = (texts: string[]) => createHashEmbeddings(texts, dimensions);

test('qdrant: a 2.7 collection is read, filtered, replaced, and deleted by this release', async () => {
  const { fetch } = qdrantStub();
  const options = { url: 'http://q.test', collection: 'chunks', dimensions, embed, fetch };
  const previous = new v27qdrant.QdrantVectorStore(options);
  await previous.migrate({ filterFields: ['tenant'] });
  await upgradeFrom('qdrant', previous, new QdrantVectorStore(options), { typedFilters: false });
});

test('redis: a 2.7 index is read, filtered, replaced, and deleted by this release', async () => {
  // 2.7 reads RESP2 only and chooses `sendCommand` when a client has one, so it gets a `call` client.
  const { client } = redisStub({ reply: 'resp2' });
  if (!client.call) throw new Error('the stand-in is shaped as ioredis');
  const options = { dimensions, embed, filterFields: ['tenant', 'page'] };
  const previous = new v27redis.RedisVectorStore({ call: client.call }, options);
  await previous.migrate();
  await upgradeFrom('redis', previous, new RedisVectorStore(client, options));
});

test('pinecone: a 2.7 namespace is read, filtered, replaced, and deleted by this release', async () => {
  const { fetch } = pineconeStub();
  const options = { host: 'p.pinecone.test', apiKey: 'k', dimensions, embed, fetch };
  await upgradeFrom('pinecone', new v27pinecone.PineconeVectorStore(options), new PineconeVectorStore(options));
});

test('weaviate: a 2.7 collection is read, filtered, replaced, and deleted by this release', async () => {
  const { fetch } = weaviateStub();
  const options = { url: 'http://w.test', collection: 'Chunks', dimensions, embed, fetch };
  const previous = new v27weaviate.WeaviateVectorStore(options);
  await previous.migrate({ filterFields: { tenant: 'text', page: 'number' } });
  await upgradeFrom('weaviate', previous, new WeaviateVectorStore(options));
});

test('chroma: a 2.7 collection is read, filtered, replaced, and deleted by this release', async () => {
  const { fetch } = chromaStub();
  const options = { collection: 'chunks', dimensions, embed, fetch };
  const previous = new v27chroma.ChromaVectorStore(options);
  await previous.migrate();
  await upgradeFrom('chroma', previous, new ChromaVectorStore(options));
});
