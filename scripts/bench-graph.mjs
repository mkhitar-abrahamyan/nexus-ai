#!/usr/bin/env node
/**
 * Proves that a fan-out which looks parallel is parallel.
 *
 * Runs the same graph twice — once with the default scheduler, once pinned to one task at a time —
 * and fails when the parallel run is not meaningfully faster. The point is to keep the claim
 * checkable: before 1.11.0 both runs took the same time, because a superstep ran its nodes in a loop.
 *
 * Usage: node scripts/bench-graph.mjs [--branches 4] [--ms 300] [--json]
 */
import { appendList, counter, createGraph, END, Send } from '../dist/graph/index.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(args[index + 1]);
};
const branches = option('branches', 4);
const workMs = option('ms', 300);
const asJson = args.includes('--json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function buildFanOut(maxConcurrency) {
  const graph = createGraph({ channels: { log: appendList(), count: counter() } })
    .addNode('split', () => ({ log: ['split'] }))
    .setEntry('split');

  for (let index = 0; index < branches; index += 1) {
    graph.addNode(`branch-${index}`, async () => {
      await sleep(workMs);
      return { count: 1 };
    });
    graph.addEdge(`branch-${index}`, END);
  }
  graph.addConditionalEdges('split', () => Array.from({ length: branches }, (_, index) => `branch-${index}`));
  return graph.compile({ maxConcurrency, checkpointer: false });
}

function buildSend(maxConcurrency) {
  return createGraph({ channels: { count: counter() } })
    .addNode('plan', () => ({}))
    .addNode(
      'work',
      async () => {
        await sleep(workMs);
        return { count: 1 };
      },
      { ends: [END] },
    )
    .setEntry('plan')
    .addConditionalEdges('plan', () => Array.from({ length: branches }, (_, index) => new Send('work', index)))
    .compile({ maxConcurrency, checkpointer: false });
}

async function time(graph) {
  const started = performance.now();
  const result = await graph.invoke();
  return { ms: Math.round(performance.now() - started), count: result.state.count };
}

const parallel = await time(buildFanOut(undefined));
const sequential = await time(buildFanOut(1));
const sends = await time(buildSend(undefined));

const serialFloor = branches * workMs;
const report = {
  branches,
  workMs,
  parallelMs: parallel.ms,
  sequentialMs: sequential.ms,
  sendFanOutMs: sends.ms,
  speedup: Number((sequential.ms / Math.max(1, parallel.ms)).toFixed(2)),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${branches} branches x ${workMs}ms of work`);
  console.log(`  parallel (default)      ${parallel.ms}ms`);
  console.log(`  maxConcurrency: 1       ${sequential.ms}ms`);
  console.log(`  Send fan-out, ${branches} tasks  ${sends.ms}ms`);
  console.log(`  speedup                 ${report.speedup}x`);
}

const failures = [];
// Generous bounds: CI machines are noisy, and the regression this guards against is total, not marginal.
if (parallel.ms > workMs * 2) failures.push(`parallel run took ${parallel.ms}ms, expected well under ${serialFloor}ms`);
if (sends.ms > workMs * 2) failures.push(`Send fan-out took ${sends.ms}ms, expected well under ${serialFloor}ms`);
if (sequential.ms < serialFloor * 0.8)
  failures.push(`maxConcurrency 1 took ${sequential.ms}ms, expected it to serialise`);
if (parallel.count !== branches || sends.count !== branches) failures.push('a branch did not write its result');

if (failures.length > 0) {
  console.error(`\nGraph benchmark failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
