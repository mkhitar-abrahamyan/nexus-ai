import { writeFileSync } from 'node:fs';

// The root package.json declares "type": "module", so every .js file in the published tree is treated
// as ESM by default. This marker scopes dist-cjs back to CommonJS so `require()` can load it.
writeFileSync(
  new URL('../dist-cjs/package.json', import.meta.url),
  `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`,
);
