/**
 * A community adapter, as an outside repository holds it, and the `nexus` command run from source in
 * that repository: shared by the proofs of compatibility records.
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** tsx by its own location: the adapter's directory has no `node_modules` to find it in. */
export const TSX = pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;

/** The CLI from source, in a directory of its own, as an adapter's repository runs it. */
export function nexus(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, ['--import', TSX, path.resolve('src/cli.ts'), 'adapters', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 120_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The community adapter's source: `forgets` marks a deleted id as gone and never clears the mark. */
export function adapterSource(kit: string, version: string, forgets: boolean) {
  return `import { defineVectorStoreAdapter } from ${JSON.stringify(kit)};

const embed = async (texts) =>
  texts.map((text) => {
    const vector = new Array(256).fill(0);
    for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
      let hash = 0x811c9dc5;
      for (const char of word) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
      vector[hash % 256] += 1;
    }
    const norm = Math.hypot(...vector) || 1;
    return vector.map((value) => value / norm);
  });

class TombstoneStore {
  rows = new Map();
  deleted = new Set();
  async add(documents) {
    const vectors = await embed(documents.map((doc) => doc.content));
    documents.forEach((doc, index) => {
      ${forgets ? '' : 'this.deleted.delete(doc.id);'}
      this.rows.set(doc.id, { ...doc, embedding: vectors[index] });
    });
  }
  async search(query, options) { return this.searchVector((await embed([query]))[0], options); }
  async searchVector(vector, options = {}) {
    return [...this.rows.values()]
      .filter((doc) => !this.deleted.has(doc.id))
      .filter((doc) => Object.entries(options.filter ?? {}).every(([key, value]) => doc.metadata?.[key] === value))
      .map(({ embedding, ...doc }) => ({ ...doc, score: embedding.reduce((sum, value, index) => sum + value * vector[index], 0) }))
      .filter((doc) => doc.score >= (options.minScore ?? 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK ?? 5);
  }
  async delete(ids) { for (const id of ids) this.deleted.add(id); }
}

export const adapter = defineVectorStoreAdapter({
  name: '@community/tombstone-vectors',
  version: ${JSON.stringify(version)},
  nexus: '^2.4.0',
  capabilities: { filters: 'exact' },
  create: () => new TombstoneStore(),
});
export const options = async () => ({ embed });
export const record = { repository: 'https://example.com/community/tombstone-vectors' };
`;
}

/** The command from source, without blocking, so a stand-in server in the same process can answer it. */
export function nexusAsync(
  args: string[],
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', TSX, path.resolve('src/cli.ts'), 'adapters', ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('error', reject);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}
