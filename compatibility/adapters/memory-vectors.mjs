// The in-memory vector store, verified as any adapter is: `nexus adapters verify` loads this module.
import { defineVectorStoreAdapter } from 'nexus-ai-pro/adapter-kit';
import { MemoryVectorStore } from 'nexus-ai-pro/rag';
import { embed } from './embed.mjs';

export const adapter = defineVectorStoreAdapter({
  name: 'nexus-ai-pro/rag MemoryVectorStore',
  version: '2.x',
  nexus: '>=2.4.0 <3',
  capabilities: { filters: 'typed' },
  create: () => new MemoryVectorStore(embed),
  budgets: { search: 250 },
});
export const options = { embed };
export const record = {
  repository: 'https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/hallucination/retrieval.ts',
};
