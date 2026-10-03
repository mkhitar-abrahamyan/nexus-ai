#!/usr/bin/env node
/**
 * Proves two scheduling claims, so neither can quietly stop being true.
 *
 * 1. A fan-out that looks parallel is parallel. The same graph runs with the default scheduler and
 *    pinned to one task at a time, and the parallel run must be meaningfully faster. Before 1.11.0
 *    both took the same time, because a superstep ran its nodes in a loop.
 * 2. `async` durability stops the graph from waiting on its store. A 50-step graph runs against a
 *    checkpointer with a fixed round trip, as a network database has, in `sync` and `async` mode.
 *    `async` must save most of the round trips, and both must end in the same state.
 *
 * Usage: node scripts/bench-graph.mjs [--branches 4] [--ms 300] [--steps 50] [--write-ms 8] [--json]
 */
import { appendList, counter, createGraph, END, MemoryGraphCheckpointer, Send } from '../dist/graph/index.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(args[index + 1]);
};
const branches = option('branches', 4);
const workMs = option('ms', 300);
const steps = option('steps', 50);
const writeMs = option('write-ms', 8);
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

/** A checkpointer that pays a fixed round trip per write, as a network database does. */
function remoteCheckpointer() {
  const inner = new MemoryGraphCheckpointer();
  return {
    put: async (checkpoint) => {
      await sleep(writeMs);
      inner.put(checkpoint);
    },
    get: (threadId, step) => inner.get(threadId, step),
    history: (threadId, limit) => inner.history(threadId, limit),
  };
}

function buildChain(durability) {
  const graph = createGraph({ channels: { log: appendList() } });
  for (let index = 0; index < steps; index += 1) {
    graph.addNode(`s${index}`, async () => {
      await sleep(writeMs);
      return { log: [index] };
    });
  }
  graph.setEntry('s0');
  for (let index = 0; index < steps - 1; index += 1) graph.addEdge(`s${index}`, `s${index + 1}`);
  graph.addEdge(`s${steps - 1}`, END);
  return graph.compile({ checkpointer: remoteCheckpointer(), durability });
}

async function timeChain(durability) {
  const started = performance.now();
  const result = await buildChain(durability).invoke({}, { threadId: 'bench', maxSteps: steps + 1 });
  return { ms: Math.round(performance.now() - started), state: result.state };
}

const parallel = await time(buildFanOut(undefined));
const sequential = await time(buildFanOut(1));
const sends = await time(buildSend(undefined));
const syncChain = await timeChain('sync');
const asyncChain = await timeChain('async');

const serialFloor = branches * workMs;
const report = {
  branches,
  workMs,
  parallelMs: parallel.ms,
  sequentialMs: sequential.ms,
  sendFanOutMs: sends.ms,
  speedup: Number((sequential.ms / Math.max(1, parallel.ms)).toFixed(2)),
  steps,
  writeMs,
  syncDurabilityMs: syncChain.ms,
  asyncDurabilityMs: asyncChain.ms,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`${branches} branches x ${workMs}ms of work`);
  console.log(`  parallel (default)      ${parallel.ms}ms`);
  console.log(`  maxConcurrency: 1       ${sequential.ms}ms`);
  console.log(`  Send fan-out, ${branches} tasks  ${sends.ms}ms`);
  console.log(`  speedup                 ${report.speedup}x`);
  console.log(`${steps} supersteps, ${writeMs}ms per checkpoint write`);
  console.log(`  durability: sync        ${syncChain.ms}ms`);
  console.log(`  durability: async       ${asyncChain.ms}ms`);
}

const failures = [];
// Generous bounds: CI machines are noisy, and the regression this guards against is total, not marginal.
if (parallel.ms > workMs * 2) failures.push(`parallel run took ${parallel.ms}ms, expected well under ${serialFloor}ms`);
if (sends.ms > workMs * 2) failures.push(`Send fan-out took ${sends.ms}ms, expected well under ${serialFloor}ms`);
if (sequential.ms < serialFloor * 0.8)
  failures.push(`maxConcurrency 1 took ${sequential.ms}ms, expected it to serialise`);
if (parallel.count !== branches || sends.count !== branches) failures.push('a branch did not write its result');
// Sync pays each step's work and then its write; async writes while the next step works, so it pays
// roughly the larger of the two. With equal work and writes that is about half; 0.75 allows for noise.
if (asyncChain.ms > syncChain.ms * 0.75)
  failures.push(`async durability took ${asyncChain.ms}ms, expected well under sync's ${syncChain.ms}ms`);
if (JSON.stringify(asyncChain.state) !== JSON.stringify(syncChain.state))
  failures.push('async durability ended in a different state from sync');

if (failures.length > 0) {
  console.error(`\nGraph benchmark failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
