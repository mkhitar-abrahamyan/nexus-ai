#!/usr/bin/env node
/**
 * The unit tests with coverage, held to its thresholds.
 *
 * Every test file runs in a process of its own, which writes its coverage to a file when it exits,
 * and the report reads them all once the last has finished. Now and then the report finds one file
 * empty, written by a process still exiting as it was read, and fails the whole run although every
 * test passed: Node 24 did so once on a release commit whose identical run passed on Node 22 and in
 * the publish workflow. That failure alone, with no test failing, is run again once. A failing test,
 * a missed threshold, or the same failure twice still fails.
 *
 *   node scripts/test-coverage.mjs
 */
import { spawn } from 'node:child_process';

const args = [
  '--import',
  'tsx',
  '--test',
  '--experimental-test-coverage',
  '--test-coverage-include=src/**/*.ts',
  '--test-coverage-lines=82',
  '--test-coverage-branches=67',
  '--test-coverage-functions=73',
  'tests/unit.ts',
  'tests/*.test.ts',
];

/** Runs the tests, streaming their output, and resolves to the exit code and the output's tail. */
function run() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (chunk, stream) => {
      stream.write(chunk);
      tail = (tail + chunk.toString()).slice(-64 * 1024);
    };
    child.stdout.on('data', (chunk) => keep(chunk, process.stdout));
    child.stderr.on('data', (chunk) => keep(chunk, process.stderr));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), tail }));
  });
}

/** Whether a run failed only because one process's coverage file was empty: every test passed. */
function onlyAnEmptyCoverageFile({ code, tail }) {
  if (code === 0) return false;
  const emptyFile = /Could not report code coverage[^\n]*coverage file is empty/.test(tail);
  const noTestFailed = /(?:ℹ|#) fail 0\b/.test(tail) && !/(?:ℹ|#) fail [1-9]/.test(tail);
  const thresholdMissed = /coverage[^\n]*does not meet threshold/i.test(tail);
  return emptyFile && noTestFailed && !thresholdMissed;
}

let result = await run();
if (onlyAnEmptyCoverageFile(result)) {
  console.error(
    '\nEvery test passed, but one process left an empty coverage file, so the report could not be read. Running once more.\n',
  );
  result = await run();
}
process.exitCode = result.code;
