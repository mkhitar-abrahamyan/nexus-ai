// The in-memory long-term store, verified as any store adapter is.
import { defineStoreAdapter } from 'nexus-ai-pro/adapter-kit';
import { MemoryStore } from 'nexus-ai-pro/store';

export const adapter = defineStoreAdapter({
  name: 'nexus-ai-pro/store MemoryStore',
  version: '3.x',
  nexus: '>=2.4.0 <4',
  capabilities: {},
  create: () => new MemoryStore(),
  budgets: { search: 100 },
});
export const options = {};
export const record = { repository: 'https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/store/memory.ts' };
