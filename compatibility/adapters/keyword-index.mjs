// The BM25 keyword index, verified as any retriever adapter is.
import { defineRetrieverAdapter } from 'nexus-ai-pro/adapter-kit';
import { KeywordIndex } from 'nexus-ai-pro/rag/retrievers';

export const adapter = defineRetrieverAdapter({
  name: 'nexus-ai-pro/rag/retrievers KeywordIndex',
  version: '3.x',
  nexus: '>=2.4.0 <4',
  capabilities: { writes: true },
  create: () => new KeywordIndex(),
  budgets: { retrieve: 100 },
});
export const options = {};
export const record = { repository: 'https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/rag/retrievers.ts' };
