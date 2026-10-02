#!/usr/bin/env node
/**
 * Generates `llms.txt` and `llms-full.txt`, the documentation index and bundle that AI assistants
 * and coding agents read (https://llmstxt.org).
 *
 *   node scripts/generate-llms-txt.mjs           # write both files
 *   node scripts/generate-llms-txt.mjs --check   # fail if either is out of date
 *
 * Everything comes from files that already exist: the summary and the guide list from the README,
 * the facts from package.json, and the bundle from the guides themselves. `--check` runs in CI, so
 * the two files cannot drift from the documentation they describe.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (file) => readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

const packageJson = JSON.parse(read('package.json'));
const repository = packageJson.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
const slug = new URL(repository).pathname.slice(1);
const blobBase = `${repository}/blob/main/`;
const rawBase = `https://raw.githubusercontent.com/${slug}/main/`;

/** Links to GitHub pages become links to the raw Markdown, which an assistant reads without HTML. */
const toRaw = (text) => text.replaceAll(blobBase, rawBase);

const readme = read('README.md');
const paragraphs = readme
  .split(/\n## /)[0]
  .split(/\n\n+/)
  .map((block) => block.trim())
  .filter((block) => block && !block.startsWith('#') && !block.startsWith('-'));
const [summary, detail] = paragraphs.map((block) => block.replace(/\s*\n\s*/g, ' '));
if (!summary || !detail) throw new Error('README.md has no summary paragraphs before its first section');

/** The README's guide table, in its order: each guide's title, file, and what it covers. */
const guideSection = readme.split('\n## Guides\n')[1]?.split('\n## ')[0] ?? '';
const guides = [...guideSection.matchAll(/^\| \[([^\]]+)\]\(([^)]+)\) \| (.+) \|$/gm)].map(
  ([, title, url, covers]) => ({
    title,
    file: url.startsWith(blobBase) ? url.slice(blobBase.length) : url,
    covers: covers.trim(),
  }),
);
if (guides.length === 0) throw new Error('README.md has no guide table under "## Guides"');

const peers = Object.keys(packageJson.peerDependencies ?? {}).sort();
const entryPoints = Object.keys(packageJson.exports).filter((key) => !key.endsWith('package.json'));

const project = [
  ['README.md', 'README', 'Install, a first request, and the full feature list'],
  ['MIGRATING.md', 'Migrating to 2.0', 'What 2.0 changed, and the codemod that rewrites imports'],
  ['API_STABILITY.md', 'API stability', 'Which entry points are stable and which are experimental'],
  ['CHANGELOG.md', 'Changelog', 'Every release, newest first'],
  ['SECURITY.md', 'Security', 'Reporting a vulnerability, and the security model'],
];
const optional = [
  ['llms-full.txt', 'Full documentation', 'The README and every guide in one file, for a tool that takes one document'],
  ['ROADMAP.md', 'Roadmap', 'Delivered work and what is planned next'],
  ['CONTRIBUTING.md', 'Contributing', 'Testing and the release procedure'],
];

const item = (file, title, text) => `- [${title}](${rawBase}${file}): ${text}`;

const index = `# ${packageJson.name}

> ${toRaw(summary)}

${toRaw(detail)}

- Install with \`npm install ${packageJson.name}\`. It needs Node.js ${packageJson.engines.node.replace('>=', '').replace(/\.0\.0$/, '')} or newer, and ships ESM and CommonJS builds with shared types. License: ${packageJson.license}.
- It has ${entryPoints.length} entry points. \`${packageJson.name}\` itself is the client, and every other capability has its own subpath, such as \`${packageJson.name}/graph\`.
- Nothing is a required dependency. Install only the optional peers you use: ${peers.map((name) => `\`${name}\``).join(', ')}.
- Each guide explains every export of its entry points, then lists them in a reference generated from the doc comments.

## Guides

${guides.map((guide) => item(guide.file, guide.title, guide.covers)).join('\n')}

## Project

${project.map(([file, title, text]) => item(file, title, text)).join('\n')}

## Optional

${optional.map(([file, title, text]) => item(file, title, text)).join('\n')}
`;

/**
 * One guide for the bundle: the prose without the generated reference, which repeats the doc
 * comments in the published type declarations, and with relative links made absolute.
 */
function bundled(file) {
  const text = read(file)
    .split('<!-- reference:start -->')[0]
    .replace(/^<!--.*-->\n/gm, '')
    .replace(/\]\((?!https?:|#|mailto:)([^)\s]+)\)/g, (_, target) => {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      return `](${blobBase}${resolved})`;
    })
    .trimEnd();
  return `Source: ${blobBase}${file}\n\n${text}\n`;
}

const full = `# ${packageJson.name}: the full documentation

> ${toRaw(summary)}

The README and every guide, in the order the README lists them, each after a line naming its source.
The guides' generated API references are left out: the published type declarations carry the same
doc comments. The index is at ${rawBase}llms.txt.

${['README.md', ...guides.map((guide) => guide.file)].map((file) => `---\n\n${bundled(file)}`).join('\n')}`;

const outputs = [
  ['llms.txt', index],
  ['llms-full.txt', full],
];

if (process.argv.includes('--check')) {
  const stale = outputs.filter(([file, text]) => {
    try {
      return read(file) !== text;
    } catch {
      return true;
    }
  });
  if (stale.length > 0) {
    console.error(`${stale.map(([file]) => file).join(' and ')} out of date. Run: npm run llms:generate`);
    process.exit(1);
  }
  console.log(`llms.txt is current: ${guides.length} guides indexed, ${Math.round(full.length / 1024)} KB bundled.`);
} else {
  for (const [file, text] of outputs) writeFileSync(path.join(root, file), text, 'utf8');
  console.log(`Wrote llms.txt (${guides.length} guides) and llms-full.txt (${Math.round(full.length / 1024)} KB).`);
}
