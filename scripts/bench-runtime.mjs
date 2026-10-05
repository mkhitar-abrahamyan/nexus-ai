#!/usr/bin/env node
/**
 * Runtime and memory budgets, held the way import sizes are.
 *
 * Every timing is divided by a calibration loop run on the same machine, so a budget written on a
 * laptop holds on a slower CI runner: what is compared is how much slower the work got relative to
 * plain JavaScript, not wall-clock time. A measurement fails when it exceeds its recorded ratio by
 * the tolerance. Two claims are absolute and checked as stated: a warm route over 1,000 models takes
 * under 100 µs at p50 and under 1 ms at p99.
 *
 * Memory is checked by retention, not by footprint: 100,000 checkpoints written through one thread
 * and 10,000 threads run one after another must leave the heap, after a collection, within a fixed
 * allowance of where it started. That catches a listener, an AbortController, or a closure kept per
 * step or per run.
 *
 *   node --expose-gc scripts/bench-runtime.mjs            # check against runtime-budget.json
 *   node --expose-gc scripts/bench-runtime.mjs --update   # record the current measurements
 *   node --expose-gc scripts/bench-runtime.mjs --json     # print every measurement
 *
 * Runs against the built package in `dist/`; run `npm run build` first.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

if (typeof globalThis.gc !== 'function') {
  // Memory checks need a collection on demand; run again with it.
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    {
      stdio: 'inherit',
    },
  );
  process.exit(result.status ?? 1);
}

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const budgetFile = path.join(root, 'runtime-budget.json');
const args = process.argv.slice(2);
const update = args.includes('--update');
const asJson = args.includes('--json');

const { appendList, counter, createGraph, END, OperationStoreCheckpointer, Send } = await import(
  '../dist/graph/index.js'
);
const { createAgent, agentInput } = await import('../dist/agent/index.js');
const { Router } = await import('../dist/router/index.js');
const { Tracer, MemoryTraceStore } = await import('../dist/tracing/index.js');
const { MemoryRunEventLog } = await import('../dist/server/index.js');
const { SqliteOperationStore } = await import('../dist/sqlite/index.js');
const { OperationRunner } = await import('../dist/operations/index.js');
const { MemoryCache, createCacheKey } = await import('../dist/cache/memory-cache.js');
const { MemoryGraphCheckpointer } = await import('../dist/graph/index.js');

/** Tolerance on a recorded ratio before a measurement fails. Generous: this catches cliffs, not noise. */
const TOLERANCE = 3;
/** Heap growth allowed after each retention run, in megabytes. */
const RETENTION_MB = { 'memory.100k-checkpoints': 8, 'memory.10k-threads': 8 };

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

/** Times `fn` `rounds` times after `warmup` untimed runs, and returns the median in milliseconds. */
async function time(fn, { rounds = 7, warmup = 2 } = {}) {
  for (let index = 0; index < warmup; index += 1) await fn();
  const samples = [];
  for (let index = 0; index < rounds; index += 1) {
    const started = performance.now();
    await fn();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

/** Plain JavaScript work every machine does at its own speed: the yardstick for every ratio. */
async function calibrate() {
  const record = {
    id: 'r',
    items: Array.from({ length: 200 }, (_, index) => ({ index, label: `item-${index}`, tags: ['a', 'b'] })),
  };
  return time(
    () => {
      let sum = 0;
      for (let round = 0; round < 200; round += 1) sum += JSON.parse(JSON.stringify(record)).items.length;
      const numbers = Array.from({ length: 20_000 }, (_, index) => (index * 7919) % 10_007);
      numbers.sort((a, b) => a - b);
      return sum + numbers[0];
    },
    { rounds: 9, warmup: 3 },
  );
}

const measurements = {};
const record = (name, ms, extra = {}) => {
  measurements[name] = { ms: Number(ms.toFixed(4)), ...extra };
};

// ── Graphs ────────────────────────────────────────────────────────

record(
  'graph.create-and-run',
  await time(async () => {
    for (let index = 0; index < 100; index += 1) {
      const graph = createGraph({ channels: { count: counter() } })
        .addNode('one', () => ({ count: 1 }))
        .addEdge('one', END)
        .setEntry('one')
        .compile({ checkpointer: false });
      await graph.invoke({});
    }
  }),
);

record(
  'graph.compile-1000-nodes',
  await time(
    () => {
      const graph = createGraph({ channels: { count: counter() } });
      for (let index = 0; index < 1_000; index += 1) graph.addNode(`n${index}`, () => ({ count: 1 }));
      for (let index = 0; index < 999; index += 1) graph.addEdge(`n${index}`, `n${index + 1}`);
      graph.addEdge('n999', END).setEntry('n0');
      return graph.compile({ checkpointer: false });
    },
    { rounds: 5 },
  ),
);

record(
  'graph.send-1000',
  await time(async () => {
    const graph = createGraph({ channels: { count: counter() } })
      .addNode('plan', () => ({}))
      .addNode('work', () => ({ count: 1 }), { ends: [END] })
      .setEntry('plan')
      .addConditionalEdges('plan', () => Array.from({ length: 1_000 }, (_, index) => new Send('work', index)))
      .compile({ checkpointer: false, maxConcurrency: 1_000 });
    await graph.invoke({});
  }),
);

const stepsGraph = (checkpointer) =>
  createGraph({ channels: { log: appendList() } })
    .addNode('a', () => ({ log: ['a'] }))
    .addNode('b', () => ({ log: ['b'] }))
    .addNode('c', () => ({ log: ['c'] }))
    .addEdge('a', 'b')
    .addEdge('b', 'c')
    .addEdge('c', END)
    .setEntry('a')
    .compile({ checkpointer });
let thread = 0;
record(
  'checkpoint.memory',
  await time(async () => {
    const graph = stepsGraph(new MemoryGraphCheckpointer());
    for (let index = 0; index < 50; index += 1) await graph.invoke({}, { threadId: `m-${thread++}` });
  }),
);
const sqlite = new SqliteOperationStore(new DatabaseSync(':memory:'));
await sqlite.migrate();
record(
  'checkpoint.sqlite',
  await time(async () => {
    const graph = stepsGraph(new OperationStoreCheckpointer(sqlite));
    for (let index = 0; index < 50; index += 1) await graph.invoke({}, { threadId: `s-${thread++}` });
  }),
);

// ── Routing ───────────────────────────────────────────────────────

function registryOf(size) {
  const providers = ['openai', 'anthropic', 'google', 'groq', 'mistral'];
  const registry = {};
  for (let index = 0; index < size; index += 1) {
    const provider = providers[index % providers.length];
    registry[`${provider}-m${index}`] = {
      provider,
      inputModalities: ['text'],
      outputModalities: ['text'],
      streaming: true,
      toolCalling: index % 3 !== 0,
      maxContextTokens: 32_000 + index,
      costPer1kInput: (index % 17) / 1000,
      costPer1kOutput: (index % 23) / 1000,
    };
  }
  return { registry, providers };
}
const routingClaims = {};
for (const size of [10, 100, 1_000]) {
  const { registry, providers } = registryOf(size);
  const config = {
    providers: {},
    models: { registry, includeDefaults: false },
    routing: { mode: 'auto', strategy: 'quality', requiredCapabilities: { toolCalling: true } },
    health: { enabled: true },
  };
  const providerMap = new Map(providers.map((name) => [name, { info: { isLocal: false } }]));
  const health = providers.map((providerName, index) => ({ providerName, healthy: index !== 2, score: 50 + index }));
  const router = new Router();
  const request = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };
  for (let index = 0; index < 300; index += 1) router.route(request, config, providerMap, health, ['groq']);
  const samples = [];
  for (let index = 0; index < 3_000; index += 1) {
    const started = performance.now();
    router.route(request, config, providerMap, health, ['groq']);
    samples.push(performance.now() - started);
  }
  record(`routing.${size}-models`, median(samples), { p99: Number(percentile(samples, 0.99).toFixed(4)) });
  if (size === 1_000) routingClaims.p50 = median(samples);
  if (size === 1_000) routingClaims.p99 = percentile(samples, 0.99);
}

// ── Agents, traces, events ────────────────────────────────────────

const middleware = Array.from({ length: 20 }, (_, index) => ({
  name: `m${index}`,
  beforeModel: ({ request }) => ({ ...request, metadata: { ...request.metadata, [`m${index}`]: true } }),
  afterModel: ({ response }) => response,
}));
const agent = createAgent({
  client: {
    complete: async () => ({
      content: 'done',
      role: 'assistant',
      finishReason: 'stop',
      meta: { cacheHit: false, guardrailsApplied: [] },
    }),
  },
  middleware,
  checkpointer: false,
});
record(
  'agent.middleware-20',
  await time(async () => {
    for (let index = 0; index < 50; index += 1) await agent.invoke(agentInput('go'));
  }),
);

record(
  'tracing.10k-runs',
  await time(
    async () => {
      const tracer = new Tracer({ store: new MemoryTraceStore({ maxRuns: 20_000 }) });
      for (let index = 0; index < 10_000; index += 1) {
        const run = tracer.startRun({ name: 'model', kind: 'model' });
        await run.finish({ outputs: { content: 'x' } });
      }
      await tracer.flush?.();
    },
    { rounds: 5 },
  ),
);

record(
  'events.10k-chunks',
  await time(
    async () => {
      const graph = createGraph({ channels: { log: appendList() } })
        .addNode('talk', (context) => {
          for (let index = 0; index < 10_000; index += 1) context.message({ text: 'x' });
          return { log: ['done'] };
        })
        .addEdge('talk', END)
        .setEntry('talk')
        .compile({ checkpointer: false });
      let seen = 0;
      for await (const _chunk of graph.events({}, { maxBuffered: 20_000 }).messages()) seen += 1;
      if (seen !== 10_000) throw new Error(`events: saw ${seen} chunks`);
    },
    { rounds: 5 },
  ),
);

record(
  'server.sse-fanout',
  await time(async () => {
    const log = new MemoryRunEventLog();
    const readers = Array.from({ length: 10 }, async () => {
      let after = 0;
      while (after < 1_000) {
        const events = log.read('run', { after });
        if (events.length === 0) {
          await log.wait('run', after, { timeoutMs: 1_000 });
          continue;
        }
        after = events.at(-1).id;
      }
    });
    for (let index = 0; index < 1_000; index += 1) log.append('run', { type: 'message', data: index });
    await Promise.all(readers);
  }),
);

// ── Operations and cache ──────────────────────────────────────────

const queue = new SqliteOperationStore(new DatabaseSync(':memory:'));
await queue.migrate();
const producer = new OperationRunner({ store: queue });
for (let index = 0; index < 10_000; index += 1) await producer.enqueue({ kind: 'job' });
const worker = new OperationRunner({ store: queue });
record(
  'operations.claim-10k-queued',
  await time(async () => {
    const handles = await worker.claimQueued(async () => 'ok', 5);
    await Promise.all(handles.map((handle) => handle.result()));
  }),
);

const cache = new MemoryCache(100_000);
for (let index = 0; index < 100_000; index += 1) cache.set(`key-${index}`, index, 600);
const request = {
  model: 'gpt-5-mini',
  messages: [{ role: 'user', content: 'What is our refund policy?' }],
  temperature: 0.2,
};
record(
  'cache.lookup',
  await time(() => {
    for (let index = 0; index < 10_000; index += 1) {
      cache.get(`key-${index * 7}`);
      createCacheKey({ request });
    }
  }),
);

// ── Memory retention ──────────────────────────────────────────────

const discard = { put() {}, get() {}, history: () => [] };
const heapMb = () => {
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed / 1_048_576;
};
const retention = {};
{
  const loop = createGraph({ channels: { count: counter() } })
    .addNode('tick', () => ({ count: 1 }))
    .addConditionalEdges('tick', (state) => (state.count >= 100_000 ? END : 'tick'))
    .setEntry('tick')
    .compile({ checkpointer: discard, maxSteps: 100_001 });
  await loop.invoke({}, { threadId: 'warm', maxSteps: 1_001 }).catch(() => undefined);
  const before = heapMb();
  const result = await loop.invoke({}, { threadId: 'long', maxSteps: 100_001 });
  if (result.state.count !== 100_000) throw new Error(`retention: counted ${result.state.count}`);
  retention['memory.100k-checkpoints'] = Number((heapMb() - before).toFixed(2));
}
{
  const graph = stepsGraph(discard);
  for (let index = 0; index < 200; index += 1) await graph.invoke({}, { threadId: `warm-${index}` });
  const before = heapMb();
  const signal = new AbortController().signal;
  for (let index = 0; index < 10_000; index += 1) await graph.invoke({}, { threadId: `t-${index}`, signal });
  retention['memory.10k-threads'] = Number((heapMb() - before).toFixed(2));
}

// ── Compare ───────────────────────────────────────────────────────

const calibrationMs = await calibrate();
const ratios = Object.fromEntries(
  Object.entries(measurements).map(([name, value]) => [name, Number((value.ms / calibrationMs).toFixed(4))]),
);

if (update) {
  writeFileSync(
    budgetFile,
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString().slice(0, 10),
        note: 'Ratios of each timing to a calibration loop on the same machine. Regenerate with npm run bench:runtime -- --update.',
        tolerance: TOLERANCE,
        calibrationMs: Number(calibrationMs.toFixed(3)),
        ratios,
        retentionMb: RETENTION_MB,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Wrote runtime budgets for ${Object.keys(ratios).length} measurements to runtime-budget.json.`);
  process.exit(0);
}

const budget = JSON.parse(readFileSync(budgetFile, 'utf8'));
const failures = [];
for (const [name, ratio] of Object.entries(ratios)) {
  const recorded = budget.ratios[name];
  if (recorded === undefined) {
    failures.push(`${name}: no budget recorded. Run: npm run bench:runtime -- --update`);
    continue;
  }
  const limit = recorded * (budget.tolerance ?? TOLERANCE);
  if (ratio > limit) {
    failures.push(
      `${name}: ${ratio.toFixed(3)}× the calibration loop, past its budget of ${limit.toFixed(3)}× (${measurements[name].ms.toFixed(2)} ms)`,
    );
  }
}
if (!(routingClaims.p50 < 0.1))
  failures.push(`routing over 1,000 models: p50 ${(routingClaims.p50 * 1000).toFixed(1)} µs, past 100 µs`);
if (!(routingClaims.p99 < 1))
  failures.push(`routing over 1,000 models: p99 ${(routingClaims.p99 * 1000).toFixed(1)} µs, past 1 ms`);
for (const [name, grown] of Object.entries(retention)) {
  const allowed = (budget.retentionMb ?? RETENTION_MB)[name];
  if (grown > allowed) failures.push(`${name}: the heap kept ${grown} MB, past ${allowed} MB`);
}

if (asJson) {
  console.log(
    JSON.stringify({ calibrationMs, measurements, ratios, routing: routingClaims, retention, failures }, null, 2),
  );
} else {
  for (const [name, value] of Object.entries(measurements)) {
    const p99 = value.p99 === undefined ? '' : `, p99 ${(value.p99 * 1000).toFixed(1)} µs`;
    console.log(
      `${name.padEnd(30)} ${value.ms < 1 ? `${(value.ms * 1000).toFixed(1)} µs` : `${value.ms.toFixed(2)} ms`}${p99}  (${ratios[name].toFixed(3)}×)`,
    );
  }
  for (const [name, grown] of Object.entries(retention)) console.log(`${name.padEnd(30)} kept ${grown} MB`);
}
if (failures.length) {
  console.error(`\nRuntime budget check failed:\n${failures.map((line) => `  - ${line}`).join('\n')}`);
  process.exit(1);
}
console.log(
  `\nRuntime budgets hold: ${Object.keys(ratios).length} timings, the routing claim, and ${Object.keys(retention).length} retention checks.`,
);
