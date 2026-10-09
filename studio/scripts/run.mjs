// Runs a studio TypeScript file, or the studio's tests, against this repository's sources: the
// studio's tsconfig maps `nexus-ai-pro/*` onto ../src, which tsx reads through TSX_TSCONFIG_PATH.
//
//   node studio/scripts/run.mjs test           runs studio/test/*.test.ts
//   node studio/scripts/run.mjs <file.ts>      runs one file
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const studio = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const [target, ...rest] = process.argv.slice(2);
const args =
  target === 'test'
    ? [
        '--import',
        'tsx',
        '--test',
        ...readdirSync(path.join(studio, 'test'))
          .filter((file) => file.endsWith('.test.ts'))
          .map((file) => path.join(studio, 'test', file)),
      ]
    : ['--import', 'tsx', path.resolve(target ?? ''), ...rest];
// The studio's soak measures the heap after a collection.
const result = spawnSync(process.execPath, ['--expose-gc', ...args], {
  stdio: 'inherit',
  env: { ...process.env, TSX_TSCONFIG_PATH: path.join(studio, 'tsconfig.json') },
});
process.exit(result.status ?? 1);
