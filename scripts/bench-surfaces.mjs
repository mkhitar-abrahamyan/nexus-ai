#!/usr/bin/env node
/**
 * Load and soak budgets for the surfaces that leave experimental status in 2.4. These are the
 * evidence the graduation checklist in `API_STABILITY.md` asks for under "Load" and "Soak".
 *
 * Load: each surface's hot path, timed and divided by a calibration loop on the same machine, as
 * `bench-runtime.mjs` does, so a budget written on a laptop holds on a slower CI runner. A
 * measurement fails when it exceeds its recorded ratio by the tolerance.
 *
 * Soak: each surface's whole lifecycle is run thousands of times. After a collection, the heap must
 * stay within a fixed allowance of where it started, and the process must hold no more handles than
 * before — no timer, socket, or child process left behind.
 *
 *   node --expose-gc scripts/bench-surfaces.mjs            # check against surface-budget.json
 *   node --expose-gc scripts/bench-surfaces.mjs --update   # record the current measurements
 *   node --expose-gc scripts/bench-surfaces.mjs --json     # print every measurement
 *
 * Runs against the built package in `dist/`; run `npm run build` first.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

if (typeof globalThis.gc !== 'function') {
  const result = spawnSync(
    process.execPath,
    ['--expose-gc', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: 'inherit' },
  );
  process.exit(result.status ?? 1);
}

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const budgetFile = path.join(root, 'surface-budget.json');
const args = process.argv.slice(2);
const update = args.includes('--update');
const asJson = args.includes('--json');

const { PGlite } = await import('@electric-sql/pglite');
const { vector } = await import('@electric-sql/pglite-pgvector');
const { createHashEmbeddings } = await import('../dist/hallucination/retrieval.js');
const { SqliteOperationStore, SqliteStore, SqliteVectorStore } = await import('../dist/sqlite/index.js');
const { PostgresVectorStore } = await import('../dist/postgres/vectors.js');
const { OperationRunner } = await import('../dist/operations/index.js');
const { KeywordIndex, hybridRetriever, vectorRetriever } = await import('../dist/rag/retrievers.js');
const { MemoryVectorStore } = await import('../dist/hallucination/retrieval.js');
const { collectDocuments } = await import('../dist/loaders/index.js');
const { loadMarkdown } = await import('../dist/loaders/markdown.js');
const { loadCsv } = await import('../dist/loaders/csv.js');
const { loadHtml } = await import('../dist/loaders/html.js');
const { McpRegistry } = await import('../dist/mcp/registry.js');
const { McpServer } = await import('../dist/mcp/index.js');
const { tool } = await import('../dist/agent/index.js');
const { ContextHub } = await import('../dist/context-hub/index.js');
const { PromptRegistry } = await import('../dist/prompts/registry.js');
const { clusterRuns, findIssues } = await import('../dist/insights/index.js');
const { MemoryTraceStore } = await import('../dist/tracing/index.js');
const { Deployments, bucket, watchCanaries } = await import('../dist/server/deployments.js');
const { tenantLimits } = await import('../dist/server/tenancy.js');
const { MemoryServerStore } = await import('../dist/server/index.js');

/** Tolerance on a recorded ratio before a measurement fails. Generous: this catches cliffs, not noise. */
const TOLERANCE = 3;
/** Heap growth allowed after a soak, in megabytes. */
const SOAK_MB = 8;

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

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

/** The same yardstick as `bench-runtime.mjs`, so the two budgets read alike. */
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

const heapMb = () => {
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed / 1_048_576;
};
/**
 * Timers the code under test started and has not cleared, unref'd ones included: a leaked heartbeat
 * is unref'd by design, so the process's own handle list would never show it.
 */
const liveTimers = new Set();
{
  const {
    setInterval: startInterval,
    clearInterval: stopInterval,
    setTimeout: startTimeout,
    clearTimeout: stopTimeout,
  } = globalThis;
  globalThis.setInterval = (callback, ms, ...rest) => {
    const timer = startInterval(callback, ms, ...rest);
    liveTimers.add(timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => {
    liveTimers.delete(timer);
    stopInterval(timer);
  };
  globalThis.setTimeout = (callback, ms, ...rest) => {
    const timer = startTimeout(() => {
      liveTimers.delete(timer);
      callback(...rest);
    }, ms);
    liveTimers.add(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    liveTimers.delete(timer);
    stopTimeout(timer);
  };
}
/** Handles the process holds, by kind: timers, sockets, child processes, file handles. */
const handles = () => {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
};

const measurements = {};
const soaks = {};
const record = (name, ms) => {
  measurements[name] = Number(ms.toFixed(4));
};
/** Runs `cycle` `times` times after a warm-up, then reports heap growth and any handle left over. */
async function soak(name, times, cycle) {
  for (let index = 0; index < Math.min(200, times / 10); index += 1) await cycle(index);
  await new Promise((resolve) => setImmediate(resolve));
  const before = heapMb();
  const held = handles();
  const timers = liveTimers.size;
  for (let index = 0; index < times; index += 1) await cycle(index);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const grown = Number((heapMb() - before).toFixed(2));
  const after = handles();
  const leaked = Object.entries(after)
    .filter(([kind, count]) => count > (held[kind] ?? 0))
    .map(([kind, count]) => `${count - (held[kind] ?? 0)} ${kind}`);
  if (liveTimers.size > timers) leaked.push(`${liveTimers.size - timers} timers never cleared`);
  soaks[name] = { cycles: times, heapGrowthMb: grown, leakedHandles: leaked };
}

const DIMENSIONS = 64;
const embed = (texts) => createHashEmbeddings(texts, DIMENSIONS);
const words = [
  'refund',
  'invoice',
  'card',
  'declined',
  'shipping',
  'order',
  'account',
  'password',
  'export',
  'billing',
];
const passage = (index) =>
  Array.from({ length: 24 }, (_, offset) => words[(index * 7 + offset * 3) % words.length]).join(' ') +
  ` ticket ${index}`;
const corpus = (size) =>
  Array.from({ length: size }, (_, index) => ({
    id: `doc-${index}`,
    content: passage(index),
    source: `kb/${index % 50}.md`,
    metadata: { tenant: index % 2 ? 'acme' : 'globex', topic: words[index % words.length] },
  }));

// ── SQLite ────────────────────────────────────────────────────────

{
  const store = new SqliteVectorStore(new DatabaseSync(':memory:'), { dimensions: DIMENSIONS, embed });
  await store.migrate();
  await store.add(corpus(2_000));
  record(
    'sqlite.vectors-query-2k',
    await time(async () => {
      for (let index = 0; index < 50; index += 1) {
        await store.search(words[index % words.length], { topK: 5, filter: { tenant: 'acme' } });
      }
    }),
  );
}
{
  const store = new SqliteStore(new DatabaseSync(':memory:'));
  await store.migrate();
  let key = 0;
  record(
    'sqlite.store-put-get-search',
    await time(async () => {
      for (let index = 0; index < 500; index += 1) {
        await store.put(['users', `u${index % 20}`], `k${key++}`, { note: passage(index) });
      }
      for (let index = 0; index < 50; index += 1) await store.search(['users', `u${index % 20}`], { limit: 10 });
    }),
  );
}
await soak('sqlite.queue-lifecycle', 20_000, await sqliteQueueCycle());
async function sqliteQueueCycle() {
  const store = new SqliteOperationStore(new DatabaseSync(':memory:'));
  await store.migrate();
  const runner = new OperationRunner({ store });
  return async () => {
    await runner.enqueue({ kind: 'job' });
    const claimed = await runner.claimQueued(async () => 'ok', 1);
    await Promise.all(claimed.map((handle) => handle.result()));
  };
}
await soak('sqlite.open-migrate-close', 2_000, async () => {
  const db = new DatabaseSync(':memory:');
  const store = new SqliteStore(db);
  await store.migrate();
  await store.put(['n'], 'k', { v: 1 });
  db.close();
});

// ── Postgres vectors (pgvector) ───────────────────────────────────

const pg = new PGlite({ extensions: { vector } });
await pg.waitReady;
{
  const store = new PostgresVectorStore(pg, { dimensions: DIMENSIONS, embed, table: 'bench_vectors' });
  await store.migrate();
  await store.add(corpus(1_000));
  record(
    'postgres.vectors-query-1k',
    await time(
      async () => {
        for (let index = 0; index < 20; index += 1) {
          await store.search(words[index % words.length], { topK: 5, filter: { tenant: 'acme' } });
        }
      },
      { rounds: 5 },
    ),
  );
  await soak('postgres.vectors-write-search-delete', 1_000, async (index) => {
    await store.add([{ id: `soak-${index % 50}`, content: passage(index), metadata: { tenant: 'acme' } }]);
    await store.search('refund', { topK: 3 });
    if (index % 50 === 49) await store.delete(Array.from({ length: 50 }, (_, offset) => `soak-${offset}`));
  });
}
await pg.close();

// ── Retrievers ────────────────────────────────────────────────────

{
  const index = new KeywordIndex();
  index.add(corpus(5_000));
  const dense = new MemoryVectorStore(embed);
  await dense.add(corpus(2_000));
  const hybrid = hybridRetriever([index, vectorRetriever(dense)]);
  record(
    'retrievers.keyword-query-5k',
    await time(async () => {
      for (let query = 0; query < 100; query += 1)
        await index.retrieve(`${words[query % 10]} ${words[(query + 3) % 10]}`, { topK: 5 });
    }),
  );
  record(
    'retrievers.hybrid-query',
    await time(async () => {
      for (let query = 0; query < 20; query += 1) await hybrid.retrieve(words[query % 10], { topK: 5 });
    }),
  );
  await soak('retrievers.keyword-churn', 50_000, (cycle) => {
    index.add([{ id: `churn-${cycle % 100}`, content: passage(cycle) }]);
    if (cycle % 100 === 99) index.delete(Array.from({ length: 100 }, (_, offset) => `churn-${offset}`));
  });
}

// ── Loaders ───────────────────────────────────────────────────────

{
  const markdown = Array.from(
    { length: 400 },
    (_, index) => `## Section ${index}\n\n${passage(index)}\n\n- ${words[index % 10]}\n`,
  ).join('\n');
  const csv = [
    'id,topic,text',
    ...Array.from({ length: 5_000 }, (_, index) => `${index},${words[index % 10]},"${passage(index)}"`),
  ].join('\n');
  const html = `<html><head><title>KB</title><script>track()</script></head><body>${Array.from({ length: 400 }, (_, index) => `<h2>Section ${index}</h2><p>${passage(index)}</p>`).join('')}</body></html>`;
  record(
    'loaders.markdown-csv-html',
    await time(async () => {
      const documents = await collectDocuments(
        loadMarkdown({ source: 'kb.md', content: markdown }),
        loadCsv({ source: 'kb.csv', content: csv }, { idColumn: 'id', contentColumns: ['text'] }),
        loadHtml({ source: 'kb.html', content: html }),
      );
      if (documents.length < 5_002) throw new Error(`loaders: ${documents.length} documents`);
    }),
  );
  await soak('loaders.repeat', 2_000, async (index) => {
    await collectDocuments(
      loadMarkdown({ source: `r${index}.md`, content: `# Title\n\n${passage(index)}` }),
      loadCsv({ source: `r${index}.csv`, content: `id,text\n1,${passage(index)}` }),
    );
  });
}

// ── MCP registry ──────────────────────────────────────────────────

function inProcess(tools) {
  return () => {
    let toClient = () => undefined;
    let toServer = () => undefined;
    const serverSide = {
      send: (message) => toClient(message),
      onMessage: (handler) => {
        toServer = handler;
      },
      close: () => undefined,
    };
    void new McpServer({ name: 'bench', version: '1.0.0', tools }).connect(serverSide);
    return {
      start: async () => undefined,
      send: (message) => toServer(message),
      onMessage: (handler) => {
        toClient = handler;
      },
      close: () => undefined,
    };
  };
}
const echo = (name) =>
  tool({ name, description: `The ${name} tool`, parameters: { type: 'object' }, execute: async () => name });
const registryConfig = {
  servers: Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [`server${index}`, { command: `server-${index}` }]),
  ),
};
const serverTools = Array.from({ length: 20 }, (_, index) => echo(`tool_${index}`));
record(
  'mcp.registry-tools-10-servers',
  await time(async () => {
    const registry = new McpRegistry(registryConfig, { transport: inProcess(serverTools) });
    const tools = await registry.tools();
    if (tools.length !== 200) throw new Error(`mcp: ${tools.length} tools`);
    await tools[0].execute({});
    await registry.close();
  }),
);
await soak('mcp.registry-connect-call-close', 1_000, async () => {
  const registry = new McpRegistry(
    { servers: { one: { command: 'one' } } },
    { transport: inProcess(serverTools.slice(0, 3)) },
  );
  const tools = await registry.tools();
  await tools[0].execute({});
  await registry.close();
});

// ── Context hub ───────────────────────────────────────────────────

{
  const prompts = new PromptRegistry();
  const pinned = {};
  for (let index = 0; index < 20; index += 1) {
    const committed = await prompts.commit({
      name: `prompt-${index}`,
      messages: [{ role: 'user', content: `Answer {{q}} ${index}` }],
    });
    pinned[`p${index}`] = { name: committed.name, version: committed.version };
  }
  const hub = new ContextHub({ prompts });
  const bundle = (index) => ({
    name: `agent-${index % 10}`,
    description: 'Bench bundle',
    prompts: pinned,
    instructions: { policy: passage(index), tone: 'Be brief.' },
    tools: [{ name: 'lookup', description: 'Finds an order', parameters: { type: 'object' } }],
    config: { model: 'gpt-5.4-mini', revision: index },
  });
  let version = 0;
  record(
    'context-hub.commit-resolve',
    await time(async () => {
      for (let index = 0; index < 50; index += 1) {
        await hub.commit(bundle(version++), { label: 'staging' });
        await hub.resolve(`agent-${index % 10}`, 'staging');
      }
    }),
  );
  // Twenty bundles, committed again and again: a version is its content, so nothing new is kept.
  await soak('context-hub.commit-resolve-render', 2_000, async (index) => {
    const committed = await hub.commit(bundle(index % 20));
    await hub.resolve(committed.name, committed.version);
    await hub.renderPrompt(committed, 'p0', { q: `question ${index}` });
  });
}

// ── Insights ──────────────────────────────────────────────────────

{
  const store = new MemoryTraceStore({ maxRuns: 20_000 });
  const startedAt = new Date(Date.now() - 3_600_000).toISOString();
  for (let index = 0; index < 5_000; index += 1) {
    store.save({
      id: `run-${index}`,
      traceId: `run-${index}`,
      name: 'support-agent',
      kind: 'agent',
      startedAt,
      latencyMs: index % 17 === 0 ? 9_000 : 200 + (index % 50),
      status: index % 9 === 0 ? 'error' : 'ok',
      ...(index % 9 === 0 ? { error: { name: 'Error', message: `Order ${index} has no total` } } : {}),
    });
  }
  record(
    'insights.find-issues-5k-runs',
    await time(
      async () => {
        const issues = await findIssues({ store, slowMs: 5_000, limit: 5_000 });
        if (issues.length === 0) throw new Error('insights: no issues found');
      },
      { rounds: 5 },
    ),
  );
  const runs = await store.query({ limit: 2_000 });
  await soak('insights.cluster-repeat', 300, async () => {
    await clusterRuns(runs.slice(0, 500), { by: 'error' });
  });
}

// ── Deployments, tenant limits, and the worker queue ──────────────

{
  const deployments = new Deployments({ state: new MemoryServerStore(), cacheMs: 60_000 });
  deployments.assistant('support', { v1: { run: async () => ({}) }, v2: { run: async () => ({}) } }, { live: 'v1' });
  await deployments.canary('support', 'v2', 0.1);
  let run = 0;
  record(
    'deployments.route-canary',
    await time(async () => {
      for (let index = 0; index < 5_000; index += 1) {
        await deployments.route('support', { runId: `r-${run++}`, threadId: `t-${index % 500}` });
      }
    }),
  );
  record(
    'deployments.bucket',
    await time(() => {
      let total = 0;
      for (let index = 0; index < 50_000; index += 1) total += bucket(`thread-${index}`);
      return total;
    }),
  );
  const limits = tenantLimits({
    default: { maxActiveRuns: 1_000_000, rate: { runs: 1_000_000_000, windowMs: 60_000 } },
  });
  record(
    'tenancy.admit-release',
    await time(async () => {
      for (let index = 0; index < 2_000; index += 1) {
        const principal = { tenantId: `tenant-${index % 50}` };
        await limits.admit({ runId: `a-${run}`, assistant: 'support', principal });
        await limits.release({ runId: `a-${run++}`, tenantId: principal.tenantId });
      }
    }),
  );
  await soak('deployments.route-admit-release', 50_000, async (index) => {
    await deployments.route('support', { runId: `s-${index}`, threadId: `t-${index % 1_000}` });
    const principal = { tenantId: `tenant-${index % 50}` };
    await limits.admit({ runId: `s-${index}`, assistant: 'support', principal });
    await limits.release({ runId: `s-${index}`, tenantId: principal.tenantId });
  });
  // A replica's whole life: it attaches and heartbeats, a canary guard watches it, and both stop.
  const report = (id) => () => ({
    id,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    inFlight: 0,
    claims: true,
    draining: false,
    assistants: { support: ['v1'] },
    queued: 0,
  });
  await soak('deployments.attach-watch-detach', 500, async (index) => {
    const replica = new Deployments({ state: new MemoryServerStore(), heartbeatMs: 5 });
    replica.assistant('support', { v1: { run: async () => ({}) } });
    await replica.attach(report(`replica-${index}`));
    const guard = watchCanaries({ deployments: replica, everyMs: 5 });
    replica.recordRun(finishedRun(index, 'v1', 0));
    await new Promise((resolve) => setTimeout(resolve, 1));
    guard.stop();
    await replica.detach();
  });
  // Counting a canary's runs: each replica records the runs it finishes, writes them every second,
  // and a guard over rollups judges on all of them.
  const counting = new Deployments({ state: new MemoryServerStore(), cacheMs: 60_000, rollupMs: 5 });
  counting.assistant('support', { v1: { run: async () => ({}) }, v2: { run: async () => ({}) } }, { live: 'v1' });
  const version = (await counting.canary('support', 'v2', 0.5)).version;
  const rollupGuard = watchCanaries({ deployments: counting, from: 'rollups', everyMs: 3_600_000 });
  await soak('deployments.rollups-record-judge', 20_000, async (index) => {
    counting.recordRun(finishedRun(index, index % 2 === 0 ? 'v1' : 'v2', version));
    if (index % 1_000 === 999) await rollupGuard.check();
  });
  rollupGuard.stop();
  await counting.detach();
}

/** A run the server finished, as it records one. */
function finishedRun(index, revision, deployment) {
  return {
    id: `run-${index}`,
    assistant: 'support',
    status: 'succeeded',
    createdAt: new Date().toISOString(),
    durationMs: 50 + (index % 200),
    cost: 0.001,
    revision: { id: revision, weight: 0.5, deployment, reason: 'split' },
  };
}

// ── Compare ───────────────────────────────────────────────────────

const calibrationMs = await calibrate();
const ratios = Object.fromEntries(
  Object.entries(measurements).map(([name, ms]) => [name, Number((ms / calibrationMs).toFixed(4))]),
);

if (asJson) {
  console.log(JSON.stringify({ calibrationMs, measurements, ratios, soaks }, null, 2));
}

const failures = [];
for (const [name, result] of Object.entries(soaks)) {
  if (result.heapGrowthMb > SOAK_MB) {
    failures.push(
      `${name}: the heap grew ${result.heapGrowthMb} MB over ${result.cycles} cycles (allowed ${SOAK_MB} MB)`,
    );
  }
  if (result.leakedHandles.length) {
    failures.push(`${name}: ${result.leakedHandles.join(', ')} left open after ${result.cycles} cycles`);
  }
}

if (update) {
  if (failures.length) {
    console.error(`Not recording budgets while soaks fail:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  writeFileSync(
    budgetFile,
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString().slice(0, 10),
        note: 'Load: ratios of each timing to a calibration loop on the same machine. Soak: heap growth allowed after each lifecycle run, with no handle left open. Regenerate with npm run bench:surfaces -- --update.',
        tolerance: TOLERANCE,
        calibrationMs: Number(calibrationMs.toFixed(3)),
        ratios,
        soakMb: SOAK_MB,
        soaks: Object.fromEntries(Object.entries(soaks).map(([name, result]) => [name, result.cycles])),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Wrote surface budgets: ${Object.keys(ratios).length} load measurements and ${Object.keys(soaks).length} soaks.`,
  );
  process.exit(0);
}

const budget = JSON.parse(readFileSync(budgetFile, 'utf8'));
for (const [name, ratio] of Object.entries(ratios)) {
  const recorded = budget.ratios[name];
  if (recorded === undefined) failures.push(`${name}: no budget recorded. Run: npm run bench:surfaces -- --update`);
  else if (ratio > recorded * budget.tolerance) {
    failures.push(
      `${name}: ${ratio}× the calibration loop, over its budget of ${recorded}× by more than ${budget.tolerance}×`,
    );
  }
}
for (const name of Object.keys(budget.ratios))
  if (!(name in ratios)) failures.push(`${name}: budgeted but no longer measured`);
for (const name of Object.keys(budget.soaks ?? {}))
  if (!(name in soaks)) failures.push(`${name}: a recorded soak no longer runs`);

if (failures.length) {
  console.error(`Surface budgets failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
const worst = Math.max(...Object.values(soaks).map((result) => result.heapGrowthMb));
console.log(
  `Surface budgets held: ${Object.keys(ratios).length} load measurements within ${budget.tolerance}× of budget, ` +
    `${Object.keys(soaks).length} soaks with at most ${worst} MB of heap growth and no handle left open.`,
);
