// Builds the studio: compiles the TypeScript, then copies the browser files beside it, where the
// server reads them from.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const studio = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const repo = path.resolve(studio, '..');
const tsc = path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc');

rmSync(path.join(studio, 'dist'), { recursive: true, force: true });
execFileSync(process.execPath, [tsc, '-p', path.join(studio, 'tsconfig.build.json')], { stdio: 'inherit' });
mkdirSync(path.join(studio, 'dist', 'ui'), { recursive: true });
cpSync(path.join(studio, 'src', 'ui'), path.join(studio, 'dist', 'ui'), { recursive: true });
// The command must be executable when npm links it.
chmodSync(path.join(studio, 'dist', 'cli.js'), 0o755);
console.log('Built studio/dist');
