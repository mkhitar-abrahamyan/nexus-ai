#!/usr/bin/env node
/**
 * The community compatibility page: the records adapters' own CI publishes, gathered with the published
 * `nexus adapters gather`, listed beside the adapters this repository ships, as Markdown and HTML. The
 * scheduled workflow runs it into the `compatibility` branch's tree, which keeps the last records it
 * gathered, so a source that is down keeps its adapter listed. Nothing an adapter publishes is run.
 *
 *   node scripts/community-compatibility.mjs --out <dir> [--registry url] [--no-keyword]
 *
 * writes <dir>/records/*.json, <dir>/README.md, and <dir>/index.html.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = path.join(root, 'dist', 'cli.js');
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const out = flag('out');
if (!out) {
  console.error('Usage: node scripts/community-compatibility.mjs --out <dir> [--registry url] [--no-keyword]');
  process.exit(2);
}
const site = path.resolve(out);
const records = path.join(site, 'records');
const registry = flag('registry');

function nexus(...command) {
  const result = spawnSync(process.execPath, [cli, 'adapters', ...command], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

nexus(
  'gather',
  '--out',
  records,
  '--sources',
  path.join(root, 'compatibility', 'sources.json'),
  ...(registry ? ['--registry', registry] : []),
  ...(args.includes('--no-keyword') ? ['--no-keyword'] : []),
);
const page = [
  '--title',
  'Adapter compatibility, with the community',
  '--intro',
  'Every adapter recorded with `nexus adapters verify`: those nexus-ai-pro ships, verified again against every build, and community adapters, as their own CI last recorded them, gathered daily from the URL each package names. A community record is checked as it was sealed and must name its package; it is listed, never run. To be listed, publish your record from your CI as the adapter kit guide describes.',
];
nexus('page', path.join(root, 'compatibility', 'records'), records, '--out', path.join(site, 'README.md'), ...page);
nexus(
  'page',
  path.join(root, 'compatibility', 'records'),
  records,
  '--html',
  '--out',
  path.join(site, 'index.html'),
  ...page,
);
