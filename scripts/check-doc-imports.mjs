#!/usr/bin/env node
/**
 * Imports in the guides' examples.
 *
 * Every `import { … } from 'nexus-ai-pro/…'` in `docs/` and the READMEs must name an entry point in
 * `package.json` `exports`, and every name it imports must be exported from that entry point — at
 * runtime, or as a type in its declarations. An example that imports from the wrong subpath fails for
 * whoever copies it, and guide coverage cannot catch it: the name is still explained, just imported
 * from somewhere it does not live.
 *
 * Reads the built package, so run it after `npm run build`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
const files = [
  ...readdirSync(path.join(repo, 'docs'))
    .filter((file) => file.endsWith('.md'))
    .map((file) => `docs/${file}`),
  'README.md',
  'studio/README.md',
];

const entries = new Map();
async function entry(specifier) {
  if (entries.has(specifier)) return entries.get(specifier);
  const key = specifier === 'nexus-ai-pro' ? '.' : `./${specifier.slice('nexus-ai-pro/'.length)}`;
  const target = pkg.exports[key];
  let result = null;
  if (target) {
    const js = target.import?.default ?? target.import ?? target.default ?? target;
    const types = target.import?.types ?? target.types;
    const runtime = new Set(Object.keys(await import(pathToFileURL(path.join(repo, js)).href)));
    const declarations =
      types && existsSync(path.join(repo, types)) ? readFileSync(path.join(repo, types), 'utf8') : '';
    result = { runtime, declarations };
  }
  entries.set(specifier, result);
  return result;
}

const problems = [];
for (const file of files) {
  const text = readFileSync(path.join(repo, file), 'utf8');
  for (const match of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(nexus-ai-pro(?:\/[^']*)?)'/g)) {
    const [, names, specifier] = match;
    const found = await entry(specifier);
    if (!found) {
      problems.push(`${file}: '${specifier}' is not an entry point`);
      continue;
    }
    for (const raw of names.split(',')) {
      const name = raw
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0];
      if (!name || found.runtime.has(name) || new RegExp(`\\b${name}\\b`).test(found.declarations)) continue;
      problems.push(`${file}: ${name} is not exported from '${specifier}'`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Doc examples import ${problems.length} name(s) from the wrong place:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`Doc imports: every example import resolves, across ${files.length} files.`);
