// The SQLite vector store over an in-memory database, verified as any adapter is.
import { DatabaseSync } from 'node:sqlite';
import { defineVectorStoreAdapter } from 'nexus-ai-pro/adapter-kit';
import { SqliteVectorStore } from 'nexus-ai-pro/sqlite/vectors';
import { embed } from './embed.mjs';

const databases = [];
export const adapter = defineVectorStoreAdapter({
  name: 'nexus-ai-pro/sqlite/vectors SqliteVectorStore',
  version: '3.x',
  nexus: '>=2.4.0 <4',
  capabilities: { filters: 'typed' },
  create: async () => {
    const database = new DatabaseSync(':memory:');
    databases.push(database);
    const store = new SqliteVectorStore(database, { dimensions: 256, embed, search: 'scan' });
    await store.migrate();
    return store;
  },
  budgets: { search: 250 },
});
export const options = { embed };
export const record = { repository: 'https://github.com/mkhitar-abrahamyan/nexus-ai/blob/main/src/sqlite/vectors.ts' };
export function close() {
  for (const database of databases.splice(0)) database.close();
}
