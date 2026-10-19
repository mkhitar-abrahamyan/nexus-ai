#!/usr/bin/env node
/**
 * The compatibility page: the records in `compatibility/records`, each adapter verified again against
 * this build, and listed in `COMPATIBILITY.md`, through the published `nexus adapters` command.
 *
 *   node scripts/compatibility.mjs            verify every listed adapter again; fail when one that passed
 *                                             does not, or when the page does not list the records as they are
 *   node scripts/compatibility.mjs --update   record each adapter in `compatibility/adapters` again, and write the page
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = path.join(root, 'dist', 'cli.js');
const page = [
  '--title',
  'Adapter compatibility',
  '--intro',
  'Every adapter recorded with `nexus adapters verify`: the contract it passed, against which release of nexus-ai-pro, how fast, and on what runtime. The adapters this repository ships are verified again against every build, so a contract change that would break one fails the build before it ships. To list an adapter of your own, add its record to `compatibility/records`, with the module that verifies it published in its package, as the [adapter kit guide](docs/adapter-kit.md#compatibility-records) describes.',
];

function nexus(...args) {
  const result = spawnSync(process.execPath, [cli, 'adapters', ...args], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv.includes('--update')) {
  for (const file of readdirSync(path.join(root, 'compatibility', 'adapters')).sort()) {
    if (!file.endsWith('.mjs') || file === 'embed.mjs') continue;
    const name = file.replace(/\.mjs$/, '');
    nexus('verify', `compatibility/adapters/${file}`, '--out', `compatibility/records/${name}.json`);
  }
  nexus('page', 'compatibility/records', '--out', 'COMPATIBILITY.md', ...page);
} else {
  nexus('recheck', 'compatibility/records');
  nexus('page', 'compatibility/records', '--expect', 'COMPATIBILITY.md', '--check', ...page);
}
