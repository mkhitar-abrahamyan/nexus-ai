import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  MemoryVectorStore,
  createOpenAIEmbeddingProvider,
  ingestDocuments,
  type VectorDocument,
} from '../src/index.js';

const path = './vector-store.json';

const documents = ingestDocuments([
  {
    id: 'readme',
    source: 'README.md',
    text: 'nexus-ai-pro supports RAG, routing, security, workflows, and eval metrics.',
  },
], {
  chunkSize: 500,
  overlap: 50,
});

const embed = process.env.OPENAI_API_KEY
  ? createOpenAIEmbeddingProvider({ apiKey: process.env.OPENAI_API_KEY })
  : undefined;

let vectorDocuments: VectorDocument[];
if (existsSync(path)) {
  vectorDocuments = JSON.parse(readFileSync(path, 'utf8')) as VectorDocument[];
} else {
  const embeddings = embed ? await embed(documents.chunks.map((chunk) => chunk.content)) : undefined;
  vectorDocuments = documents.chunks.map((chunk, index) => ({
    ...chunk,
    embedding: embeddings?.[index],
  }));
  writeFileSync(path, JSON.stringify(vectorDocuments, null, 2));
}

const store = new MemoryVectorStore(embed);
await store.add(vectorDocuments);

const results = await store.search('What does nexus-ai-pro support?', { topK: 3 });
console.log(results);
