/**
 * Runs the kernel's tests in an edge runtime: Vercel's, which gives code the web platform's globals
 * and nothing of Node's — no `process`, no `Buffer`, no `require`.
 *
 * Edge code ships bundled, so the tests are bundled first, as a platform's build would bundle them.
 * Optional SDKs stay external; the kernel never loads them unless asked.
 *
 *   node tests/portable/edge.mjs
 */
import { fileURLToPath } from 'node:url';
import { EdgeVM } from '@edge-runtime/vm';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: [fileURLToPath(new URL('./kernel.mjs', import.meta.url))],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'kernel',
  platform: 'browser',
  target: 'es2022',
  external: ['openai', '@anthropic-ai/sdk', 'ollama', 'ajv', 'ajv-formats', 'zod'],
  logLevel: 'error',
});

const vm = new EdgeVM();
const nodeGlobals = vm.evaluate(
  `[typeof process, typeof Buffer, typeof require, typeof setImmediate].filter((type) => type !== 'undefined').length`,
);
if (nodeGlobals !== 0) throw new Error('The edge runtime exposes Node globals, so it would prove nothing');

const lines = [];
vm.context.__report = (line) => lines.push(line);
vm.evaluate(`globalThis.__NEXUS_EXPECTED_RUNTIME__ = 'edge-light';`);
vm.evaluate(bundled.outputFiles[0].text);
const result = await vm.evaluate('kernel.run(__report)');
for (const line of lines) console.log(line);
if (result.failed.length) throw new Error(`${result.failed.length} kernel check(s) failed on the edge runtime`);
