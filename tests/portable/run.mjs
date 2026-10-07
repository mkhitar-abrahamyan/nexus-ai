/**
 * Runs the kernel's tests on whichever runtime executes this file:
 *
 *   node tests/portable/run.mjs
 *   deno run --allow-read tests/portable/run.mjs
 *   bun tests/portable/run.mjs
 *
 * The first argument, when given, names the runtime the tests must detect.
 */
import { run } from './kernel.mjs';

const host = globalThis;
const args = host.Deno?.args ?? host.process?.argv?.slice(2) ?? [];
if (args[0]) host.__NEXUS_EXPECTED_RUNTIME__ = args[0];
const { failed } = await run();
if (failed.length) throw new Error(`${failed.length} kernel check(s) failed: ${failed.join('; ')}`);
